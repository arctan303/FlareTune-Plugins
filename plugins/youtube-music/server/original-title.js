// Public publisher titles are a display projection. Song metadata, search
// membership and player/lyric inputs remain owned by the normal Music response.
const completedTitles = new Map();
let nextGeneration = 0;
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 500;
const MAX_REQUESTS = 20;
const CONCURRENCY = 4;
const abortReason = () => new DOMException('Original-title enrichment ended', 'AbortError');
const cancel = body => { try { void body?.cancel().catch(() => {}); } catch { /* Already released. */ } };
const videoId = song => song?.source === 'youtube' && song.kind === 'song'
  ? /^yt:([A-Za-z0-9_-]{11})$/u.exec(song.id || '')?.[1] : null;

function requestSlots() {
  let active = 0;
  const waiting = [];
  const pump = () => {
    while (active < CONCURRENCY && waiting.length) {
      const ticket = waiting.shift();
      ticket.signal.removeEventListener('abort', ticket.abort);
      active++;
      let released = false;
      ticket.resolve(() => {
        if (released) return;
        released = true; active--; pump();
      });
    }
  };
  return signal => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortReason()); return; }
    const ticket = { signal, resolve, abort: () => {
      const index = waiting.indexOf(ticket);
      if (index >= 0) waiting.splice(index, 1);
      reject(abortReason());
    } };
    waiting.push(ticket);
    signal.addEventListener('abort', ticket.abort, { once: true });
    pump();
  });
}

function cacheResult(cache, id, generation, title, now) {
  if ((cache.get(id)?.generation || 0) > generation) return;
  if (!cache.has(id) && cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(id, { title, generation, expiresAt: now() + (title ? 600000 : 30000) });
}

async function publisherTitle(id, signal, fetchImpl) {
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', 'https://www.youtube.com/watch?v=' + id);
  url.searchParams.set('format', 'json');
  let reader;
  const stopBody = () => cancel(reader);
  signal.addEventListener('abort', stopBody, { once: true });
  try {
    const response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit',
      headers: { Accept: 'application/json' }, signal });
    if (signal.aborted) { cancel(response.body); throw abortReason(); }
    const declaredLength = Number(response.headers.get('Content-Length'));
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!response.ok || contentType !== 'application/json'
      || Number.isFinite(declaredLength) && declaredLength > MAX_BYTES || !response.body) {
      cancel(response.body); return null;
    }
    reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { cancel(reader); return null; }
      chunks.push(value);
    }
    if (signal.aborted) throw abortReason();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return data?.provider_name === 'YouTube' && data.type === 'video'
      && typeof data.title === 'string' && data.title.trim() && data.title.length <= 1000
      && !/[\u0000-\u001f\u007f]/u.test(data.title) ? data.title.trim() : null;
  } finally {
    signal.removeEventListener('abort', stopBody);
    try { reader?.releaseLock(); } catch { /* A canceled read may still be settling. */ }
  }
}

function titleWork(id, fetchImpl, cache, now, pending, acquire) {
  const controller = new AbortController(), generation = ++nextGeneration;
  const entry = { controller, users: 0, promise: null };
  let abort, release;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(abortReason());
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  const load = async () => {
    release = await acquire(controller.signal);
    if (controller.signal.aborted) throw abortReason();
    return publisherTitle(id, controller.signal, fetchImpl);
  };
  entry.promise = Promise.race([load(), interrupted])
    .catch(() => null)
    .then(title => {
      if (!controller.signal.aborted) cacheResult(cache, id, generation, title, now);
      return title;
    }).finally(() => {
      controller.signal.removeEventListener('abort', abort);
      release?.();
      if (pending.get(id) === entry) pending.delete(id);
    });
  pending.set(id, entry);
  return entry;
}

function subscribe(entry, signal) {
  if (signal.aborted) {
    if (!entry.users) entry.controller.abort();
    return Promise.resolve(null);
  }
  entry.users++;
  return new Promise(resolve => {
    let ended = false;
    const finish = title => {
      if (ended) return;
      ended = true;
      signal.removeEventListener('abort', onAbort);
      entry.users--;
      resolve(title);
    };
    const onAbort = () => {
      finish(null);
      if (!entry.users) entry.controller.abort();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(finish);
  });
}

// Create one resolver for each host request/service. Only completed public
// values cross requests; pending work belongs to this resolver's invocation.
export function createOriginalTitleResolver({ fetchImpl = fetch, now = Date.now,
  timeoutMs = 1200, cache = completedTitles } = {}) {
  const pending = new Map(), acquire = requestSlots();
  const budgetMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 1500) : 1200;
  return async function enrichDisplayTitles(songs, { signal } = {}) {
    const results = [...songs];
    if (!songs.length || signal?.aborted) return results;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, budgetMs);
    let cursor = 0, requests = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, songs.length) }, async () => {
        while (!controller.signal.aborted && cursor < songs.length) {
          const index = cursor++, song = songs[index], id = videoId(song);
          if (!id) continue;
          const cached = cache.get(id);
          let title;
          if (cached && cached.expiresAt > now()) title = cached.title;
          else {
            if (cached) cache.delete(id);
            let entry = pending.get(id);
            if (entry?.controller.signal.aborted) { pending.delete(id); entry = null; }
            if (!entry) {
              if (requests >= MAX_REQUESTS) continue;
              requests++;
              entry = titleWork(id, fetchImpl, cache, now, pending, acquire);
            }
            title = await subscribe(entry, controller.signal);
          }
          if (!controller.signal.aborted && title) results[index] = { ...song, displayTitle: title };
        }
      }));
      return results;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
