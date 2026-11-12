import { YouTubeError } from "./core.js";
import { artistResult, item, searchResult } from "./normalize.js";
const searches = new Map(), artists = new Map();
const MAX_ITEMS = 1000;
export function pageOptions(offset = 0, limit = 20) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || offset + limit > MAX_ITEMS) {
    throw new YouTubeError('YOUTUBE_INVALID_PAGINATION', 400);
  }
  return { offset, limit, end: offset + limit };
}
async function cached(map, key, create) {
  const prior = map.get(key);
  if (prior && prior.at > Date.now() - 300000) return snapshot(prior.value);
  const value = await create();
  remember(map, key, value);
  return snapshot(value);
}
function snapshot(entry) {
  return { ...entry, ...(entry.items ? { items: [...entry.items] } : { songs: [...entry.songs] }), work: null };
}
function remember(map, key, value) {
  // Publish completed cursor/data only. Each invocation advances its own copy,
  // so a canceled owner cannot strand a later request on entry.work.
  const prior = map.get(key);
  const count = entry => entry.items?.length ?? entry.songs.length;
  if (prior && prior.at > Date.now() - 300000 && count(prior.value) > count(value)) return;
  if (!map.has(key) && map.size >= 12) map.delete(map.keys().next().value);
  const at = prior && prior.at > Date.now() - 300000 ? prior.at : Date.now();
  map.set(key, { at, value: snapshot(value) });
}
async function extend(entry, end, count, advance) {
  // Every request may fetch at most three additional upstream pages. Concurrent
  // calls on this invocation serialize around its own cursor. Other requests
  // reuse completed progress but never wait for this invocation's I/O.
  while (entry.work) await entry.work;
  if (count(entry) >= end || !entry.hasMore) return;
  entry.work = (async () => {
    for (let step = 0; step < 3 && count(entry) < end && entry.hasMore; step++) await advance(entry);
  })();
  try { await entry.work; } finally { entry.work = null; }
}
export async function pagedSearch(yt, query, { filter, hl, offset = 0, limit = 20, cacheNamespace = '' }) {
  const options = pageOptions(offset, limit);
  const key = JSON.stringify([cacheNamespace, hl, filter, query]);
  const entry = await cached(searches, key, async () => {
    const page = await yt.music.search(query, { type: filter });
    const value = searchResult(page);
    return { page, sections: value.sections, items: value.items, hasMore: value.hasMore, work: null };
  });
  await extend(entry, options.end, value => value.items.length, async value => {
    value.page = await value.page.getContinuation();
    const next = searchResult(value.page);
    value.items.push(...next.items.slice(0, MAX_ITEMS - value.items.length));
    value.hasMore = next.hasMore && value.items.length < MAX_ITEMS;
  });
  remember(searches, key, entry);
  if (offset >= entry.items.length && entry.hasMore) throw new YouTubeError('YOUTUBE_PAGINATION_RESTART', 409);
  const items = [...entry.items];
  return { sections: entry.sections, items, songs: items.filter(n => n.kind === 'song'),
    artists: items.filter(n => n.kind === 'artist'), albums: items.filter(n => n.kind === 'album'),
    hasMore: entry.hasMore || items.length > options.end };
}
function continuationOf(shelf) {
  return shelf?.continuation || Array.from(shelf?.contents || []).find(n => n.type === 'ContinuationItem')?.endpoint || null;
}
async function nextArtistShelf(yt, cursor) {
  const page = typeof cursor === 'string' ? await yt.actions.execute('/browse', { continuation: cursor, client: 'YTMUSIC', parse: true }) :
    await cursor.call(yt.actions, { client: 'YTMUSIC', parse: true });
  if (page.continuation_contents) return page.continuation_contents;
  const appended = Array.from(page.on_response_received_actions || []).find(n => n.type === 'AppendContinuationItemsAction');
  if (appended) return appended;
  throw new YouTubeError('YOUTUBE_PAGINATION_UNAVAILABLE');
}
export async function pagedArtist(yt, id, { hl, offset = 0, limit = 20, cacheNamespace = '' }) {
  const options = pageOptions(offset, limit);
  const key = JSON.stringify([cacheNamespace, hl, id]);
  const entry = await cached(artists, key, async () => {
    const raw = await yt.music.getArtist(id);
    let first;
    try { first = await raw.getAllSongs?.(); } catch { /* Keep the visible artist sections. */ }
    const data = artistResult(raw, id, first);
    const cursor = continuationOf(first);
    return { data, songs: data.songs, cursor, hasMore: Boolean(cursor), work: null };
  });
  await extend(entry, options.end, value => value.songs.length, async value => {
    const shelf = await nextArtistShelf(yt, value.cursor);
    const songs = Array.from(shelf.contents || []).map(node => item(node)).filter(n => n?.kind === 'song');
    value.songs.push(...songs.slice(0, MAX_ITEMS - value.songs.length));
    value.cursor = continuationOf(shelf);
    value.hasMore = Boolean(value.cursor) && value.songs.length < MAX_ITEMS;
  });
  remember(artists, key, entry);
  if (offset >= entry.songs.length && entry.hasMore) throw new YouTubeError('YOUTUBE_PAGINATION_RESTART', 409);
  return { ...entry.data, songs: [...entry.songs], total: entry.songs.length,
    hasMore: entry.hasMore || entry.songs.length > options.end };
}
