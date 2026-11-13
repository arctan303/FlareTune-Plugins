// Only stable, public metadata is returned by this provider. Signed media URLs
// and Google credentials stay behind the host's authenticated media routes.
export class YouTubeError extends Error {
  constructor(code, status = 502) { super(code); this.name = 'YouTubeError'; this.code = code; this.status = status; }
}
export function videoOf(value) {
  if (!/^[\w-]{11}$/.test(value || '')) throw new YouTubeError('YOUTUBE_INVALID_VIDEO_ID', 400);
  return value;
}
export function browseOf(value, kind) {
  const pattern = kind === 'artist' ? /^UC[\w-]{1,126}$/ : /^MPREb_[\w-]{1,122}$/;
  if (!pattern.test(value || '')) throw new YouTubeError('YOUTUBE_INVALID_BROWSE_ID', 400);
  return value;
}
export function localeOf(hl = 'en', gl = 'US') {
  if (!/^[a-zA-Z]{2,3}(?:[-_][a-zA-Z]{2,4})?$/.test(hl)) throw new YouTubeError('YOUTUBE_INVALID_LANGUAGE', 400);
  if (typeof gl !== 'string' || !/^[A-Z]{2}$/u.test(gl)) throw new YouTubeError('YOUTUBE_INVALID_REGION', 400);
  return { lang: hl, location: gl };
}
export function imageTarget(value) {
  let url; try { url = new URL(value); } catch { throw new YouTubeError('YOUTUBE_INVALID_IMAGE_URL', 400); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
    !['lh3.googleusercontent.com', 'i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)) {
    throw new YouTubeError('YOUTUBE_INVALID_IMAGE_URL', 400);
  }
  return url.href;
}
export function streamTarget(value) {
  let url; try { url = new URL(value); } catch { throw new YouTubeError('YOUTUBE_INVALID_MEDIA_URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !url.hostname.endsWith('.googlevideo.com')) {
    throw new YouTubeError('YOUTUBE_INVALID_MEDIA_URL');
  }
  return url.href;
}
export function safeText(value) {
  const result = value == null ? '' : typeof value === 'string' ? value : value.toString?.() || '';
  return result === '[object Object]' ? '' : String(result);
}
export function chooseAudio(formats, { itag, codec = 'opus' } = {}) {
  const candidates = formats.filter(f => f.has_audio && !f.has_video && f.url && !f.drm_families?.length &&
    !f.drm_track_type && !f.fair_play_key_uri && !f.signature_cipher && !f.cipher);
  const ranked = candidates.filter(f => itag ? f.itag === Number(itag) :
    codec === 'aac' ? /audio\/mp4/i.test(f.mime_type) : /opus/i.test(f.mime_type));
  ranked.sort((a, b) => (b.average_bitrate || b.bitrate || 0) - (a.average_bitrate || a.bitrate || 0));
  if (!ranked[0]) throw new YouTubeError('YOUTUBE_NO_AUDIO_FORMAT', 422);
  streamTarget(ranked[0].url);
  return ranked[0];
}
export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}
export function publicError(error) {
  // Never serialize SDK errors: they may include complete request bodies/URLs.
  return error instanceof YouTubeError ? { error: error.code } : { error: 'YOUTUBE_UPSTREAM_UNAVAILABLE' };
}
