import { videoOf, YouTubeError } from "./core.js";

const MAX_RESPONSE_BYTES = 16384;
const PUBLIC_TTL_MS = 30000;
// oEmbed is deliberately separate from the authenticated SDK session. A valid
// videoId, a next placeholder, or an OAuth player's success is not evidence that
// another site member should be allowed to use the administrator's account.
export function publicVisibilityTarget(id) {
  videoOf(id);
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('url', 'https://www.youtube.com/watch?v=' + id);
  url.searchParams.set('format', 'json');
  return url.href;
}
async function readBoundedJson(response) {
  if (!/^application\/json(?:;|$)/i.test(response.headers.get('Content-Type') || '') ||
    Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
  const chunks = []; let count = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      count += chunk.value.byteLength;
      if (count > MAX_RESPONSE_BYTES) throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}
function isAnonymousVideo(value, id) {
  if (!value || value.type !== 'video' || value.version !== '1.0' || value.provider_name !== 'YouTube' ||
    value.provider_url !== 'https://www.youtube.com/' || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 2048 ||
    typeof value.author_name !== 'string' || !value.author_name.trim() || value.author_name.length > 512 ||
    typeof value.author_url !== 'string' || typeof value.html !== 'string') return false;
  try {
    const author = new URL(value.author_url);
    if (author.protocol !== 'https:' || author.hostname !== 'www.youtube.com' || author.username || author.password || author.port) return false;
    const embed = value.html.match(/\bsrc=["'](https:\/\/www\.youtube\.com\/embed\/[\w-]{11}(?:\?[^"']*)?)["']/i)?.[1];
    if (!embed) return false;
    return new URL(embed).pathname === '/embed/' + id;
  } catch { return false; }
}
export function createPublicVisibilityGate({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const visible = new Map(), pending = new Map();
  return async function assertPublicVideo(id) {
    const target = publicVisibilityTarget(id);
    if (visible.get(id) > now()) return true;
    visible.delete(id);
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= 64) throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
    const work = (async () => {
      // No browser headers, SDK cookies, Bearer, gateway key, or redirects.
      const response = await fetchImpl(target, { method: 'GET', credentials: 'omit', redirect: 'manual',
        referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new YouTubeError([401, 403, 404, 410].includes(response.status) ? 'YOUTUBE_VIDEO_NOT_PUBLIC' : 'YOUTUBE_VISIBILITY_UNAVAILABLE',
          [401, 403, 404, 410].includes(response.status) ? 404 : 503);
      }
      const data = await readBoundedJson(response);
      if (!isAnonymousVideo(data, id)) throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
      if (visible.size >= 256) visible.delete(visible.keys().next().value);
      visible.set(id, now() + PUBLIC_TTL_MS);
      return true;
    })().catch(error => {
      if (error instanceof YouTubeError) throw error;
      throw new YouTubeError('YOUTUBE_VISIBILITY_UNAVAILABLE', 503);
    }).finally(() => pending.delete(id));
    pending.set(id, work);
    return work;
  };
}
export const assertPublicVideo = createPublicVisibilityGate();
