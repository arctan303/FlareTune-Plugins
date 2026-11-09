import { chooseAudio, imageTarget, streamTarget, YouTubeError } from "./core.js";
import { mediaFetch } from "./upstream.js";
import { SAMSUNG_UA } from "./tv-profile.js";
import { COVER_IMAGE_SIZE, highResolutionImageTarget } from "./normalize.js";
export async function fetchMedia(input, init = {}, fetcher = mediaFetch) {
  let target = streamTarget(String(input));
  const headers = new Headers({ 'User-Agent': SAMSUNG_UA, Origin: 'https://www.youtube.com', Referer: 'https://www.youtube.com/' });
  for (const name of ['Range', 'If-Range']) {
    const value = new Headers(init.headers).get(name);
    if (value) headers.set(name, value);
  }
  for (let hop = 0; hop < 3; hop++) {
    const response = await fetcher(target, { method: init.method || 'GET', headers, redirect: 'manual', signal: init.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('Location');
    await response.body?.cancel();
    if (!location || hop === 2) throw new YouTubeError('YOUTUBE_MEDIA_REDIRECT_LIMIT');
    target = streamTarget(new URL(location, target).href);
  }
  throw new YouTubeError('YOUTUBE_MEDIA_REDIRECT_LIMIT');
}
export function streamOptions(request) {
  const url = new URL(request.url);
  const userAgent = request.headers.get('User-Agent') || '';
  const safari = /iP(?:hone|ad|od)/i.test(userAgent) || (/Safari/i.test(userAgent) && !/(?:Chrome|Chromium|Edg|OPR|Android)/i.test(userAgent));
  const codec = url.searchParams.get('codec') || (safari ? 'aac' : 'opus');
  const itag = url.searchParams.get('itag');
  if (!['opus', 'aac'].includes(codec) || (itag && !['774', '141', '251', '140'].includes(itag))) {
    throw new YouTubeError('YOUTUBE_INVALID_AUDIO_FORMAT', 400);
  }
  return { codec, itag };
}
export async function streamResponse(request, videoId, player, fetcher = fetchMedia) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new YouTubeError('YOUTUBE_METHOD_NOT_ALLOWED', 405);
  let selected = chooseAudio((await player.resolve(videoId)).formats, streamOptions(request));
  const itag = selected.itag;
  const headers = new Headers();
  for (const name of ['Range', 'If-Range']) {
    const value = request.headers.get(name);
    if (value && value.length > 2048) throw new YouTubeError('YOUTUBE_INVALID_RANGE', 400);
    if (value) headers.set(name, value);
  }
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetcher(streamTarget(selected.url), { method: request.method, headers, signal: request.signal });
    if (response.status !== 403 || attempt === 1) break;
    await response.body?.cancel();
    selected = chooseAudio((await player.resolve(videoId, { force: true })).formats, { itag });
  }
  if (![200, 206, 416].includes(response.status)) {
    await response.body?.cancel();
    throw new YouTubeError('YOUTUBE_MEDIA_UNAVAILABLE');
  }
  if (response.status !== 416 && !/^(?:audio\/|video\/mp4|application\/octet-stream)/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel();
    throw new YouTubeError('YOUTUBE_MEDIA_UNAVAILABLE');
  }
  const outgoing = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    if (response.headers.has(name)) outgoing.set(name, response.headers.get(name));
  }
  if (request.method === 'HEAD') await response.body?.cancel();
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers: outgoing });
}
export async function imageResponse(request, rawUrl, fetcher = mediaFetch) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new YouTubeError('YOUTUBE_METHOD_NOT_ALLOWED', 405);
  const original = imageTarget(rawUrl);
  const sizes = new URL(request.url).searchParams.getAll('size');
  if (sizes.length > 1 || (sizes.length && sizes[0] !== String(COVER_IMAGE_SIZE))) throw new YouTubeError('YOUTUBE_INVALID_IMAGE_SIZE', 400);
  const preferred = sizes.length ? highResolutionImageTarget(original) : original;
  const targets = preferred === original ? [original] : [preferred, original];
  let response;
  for (const target of targets) {
    try { response = await fetcher(target, { method: request.method, redirect: 'manual', signal: request.signal }); }
    catch {
      if (target !== original && !request.signal.aborted) continue;
      throw new YouTubeError('YOUTUBE_IMAGE_UNAVAILABLE');
    }
    if (response.ok && /^image\//i.test(response.headers.get('Content-Type') || '')) break;
    await response.body?.cancel();
    response = null;
  }
  if (!response) throw new YouTubeError('YOUTUBE_IMAGE_UNAVAILABLE');
  if (request.method === 'HEAD') await response.body?.cancel();
  const headers = new Headers({ 'Content-Type': response.headers.get('Content-Type'), 'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer' });
  for (const name of ['ETag', 'Last-Modified', 'Content-Length']) if (response.headers.has(name)) headers.set(name, response.headers.get(name));
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
}
