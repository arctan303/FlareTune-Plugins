import { imageTarget, safeText } from "./core.js";
const video = value => /^[\w-]{11}$/.test(value || '');
const artist = value => /^UC[\w-]{1,126}$/.test(value || '');
const album = value => /^MPREb_[\w-]{1,122}$/.test(value || '');
export const songId = id => `yt:${id}`;
export const artistId = id => `yt:artist:${id}`;
export const albumId = id => `yt:album:${id}`;
export const COVER_IMAGE_SIZE = 1200;
// Googleusercontent exposes the same resize parameters in YT's own 60/120/
// 226/544 thumbnails. Preserve its crop/format flags and asset identity; do not
// guess i.ytimg filenames (not every video has maxresdefault.jpg).
export function highResolutionImageTarget(value) {
  const original = imageTarget(value);
  const url = new URL(original);
  if (!['lh3.googleusercontent.com', 'yt3.googleusercontent.com'].includes(url.hostname)) return original;
  const match = /=(?:w(\d+)-h(\d+)|s(\d+))(?=-|$)/.exec(url.pathname);
  if (!match) return original;
  const width = Number(match[1] || match[3]), height = Number(match[2] || match[3]);
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || width <= 0 || height <= 0 || longest >= COVER_IMAGE_SIZE) return original;
  const replacement = match[3] ? '=s' + COVER_IMAGE_SIZE :
    '=w' + Math.round(width * COVER_IMAGE_SIZE / longest) + '-h' + Math.round(height * COVER_IMAGE_SIZE / longest);
  url.pathname = url.pathname.replace(match[0], replacement);
  return url.href;
}
function coverImage(images, fallback = null) {
  const original = images.at(-1)?.url || fallback;
  if (!original) return null;
  try {
    const proxy = new URL(original, 'https://youtube-image.internal');
    if (proxy.pathname !== '/media/youtube/image') return original;
    const target = proxy.searchParams.get('url');
    if (highResolutionImageTarget(target) === imageTarget(target)) return original;
    // Keep the original available for a proxy fallback. The changed browser
    // cache key also prevents a previous 120px response serving this request.
    proxy.searchParams.set('size', String(COVER_IMAGE_SIZE));
    return proxy.pathname + proxy.search;
  } catch { return original; }
}
export function thumbnails(value) {
  const list = Array.isArray(value) ? value : value?.contents || [];
  return list.filter(x => typeof x?.url === 'string').map(x => {
    try { return { url: '/media/youtube/image?url=' + encodeURIComponent(imageTarget(x.url)), width: x.width, height: x.height }; }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => (a.width || 0) * (a.height || 0) - (b.width || 0) * (b.height || 0));
}
export function item(node, fallback = {}) {
  if (!node) return null;
  const rawId = node.id || node.video_id || node.endpoint?.payload?.browseId || fallback.sourceId;
  const type = node.item_type || fallback.kind;
  const kind = video(rawId) ? 'song' : artist(rawId) || type === 'artist' || type === 'library_artist' ? 'artist' :
    album(rawId) || type === 'album' ? 'album' : 'unknown';
  if (kind === 'unknown' || (kind === 'artist' && !artist(rawId)) || (kind === 'album' && !album(rawId))) return null;
  const artists = (node.artists || node.authors || (node.author && typeof node.author === 'object' ? [node.author] : []))
    .map(a => ({ id: artist(a.channel_id) ? artistId(a.channel_id) : null,
      sourceId: artist(a.channel_id) ? a.channel_id : null, name: a.name || '' })).filter(a => a.name);
  const images = thumbnails(node.thumbnails || node.thumbnail || fallback.thumbnails);
  const title = safeText(node.title || node.name || fallback.title);
  const author = artists.map(a => a.name).join(' / ') || safeText(node.author) || fallback.artist || '';
  const cover = coverImage(images, fallback.cover_url);
  const base = { id: kind === 'song' ? songId(rawId) : kind === 'artist' ? artistId(rawId) : albumId(rawId),
    source: 'youtube', sourceId: rawId, kind, title, artist: author, artists,
    album: node.album?.name || fallback.album || '',
    albumId: album(node.album?.id) ? albumId(node.album.id) : fallback.albumId || null,
    duration: node.duration?.seconds ?? (typeof node.duration === 'number' ? node.duration : fallback.duration ?? null),
    language: null, audio_url: kind === 'song' ? '/media/youtube/audio/' + rawId : null,
    cover_url: cover, coverUrl: cover, thumbnails: images, subtitle: safeText(node.subtitle), year: node.year || null };
  if (kind === 'artist') return { ...base, name: title, photoUrl: cover, songCount: null };
  return base;
}
export function shelf(section) {
  return { title: safeText(section.title || section.header?.title), type: section.type,
    items: Array.from(section.contents || []).map(node => item(node)).filter(Boolean) };
}
export function searchResult(result) {
  // Initial searches contain shelves; SDK continuations expose one shelf.
  const contents = result.contents;
  const sections = Array.isArray(contents) ? contents.map(shelf) : contents?.contents ? [shelf(contents)] : [];
  const items = sections.flatMap(s => s.items);
  return { sections, items, songs: items.filter(n => n.kind === 'song'), artists: items.filter(n => n.kind === 'artist'),
    albums: items.filter(n => n.kind === 'album'), hasMore: Boolean(result.has_continuation) };
}
export function albumResult(result, id) {
  const header = result.header;
  const images = thumbnails(header?.thumbnails || header?.thumbnail || result.background);
  const cover = coverImage(images);
  const title = safeText(header?.title);
  const author = header?.author?.name || safeText(header?.strapline_text_one);
  const songs = Array.from(result.contents || []).map(node => item(node,
    { album: title, albumId: albumId(id), artist: author, cover_url: cover })).filter(n => n?.kind === 'song');
  return { id: albumId(id), sourceId: id, source: 'youtube', title,
    artist: author || songs[0]?.artist || '', subtitle: safeText(header?.subtitle),
    coverUrl: cover, cover_url: cover, description: safeText(header?.description?.description || header?.description),
    songs, songCount: songs.length, sections: Array.from(result.sections || []).map(shelf) };
}
export function artistResult(result, id, songShelf) {
  const header = result.header;
  const images = thumbnails(header?.thumbnails || header?.thumbnail);
  const sections = Array.from(result.sections || []).map(shelf);
  const all = sections.flatMap(s => s.items);
  const songs = songShelf ? Array.from(songShelf.contents || []).map(node => item(node)).filter(n => n?.kind === 'song') :
    all.filter(n => n.kind === 'song');
  const photo = coverImage(images);
  return { id: artistId(id), sourceId: id, source: 'youtube', name: safeText(header?.title),
    description: safeText(header?.description), photoUrl: photo, coverUrl: photo, cover_url: photo,
    songs, albums: all.filter(n => n.kind === 'album'), sections, total: songs.length,
    hasMore: Boolean(songShelf?.continuation) };
}
