import { Platform } from 'youtubei.js/cf-worker';
import { streamTarget, videoOf, YouTubeError } from "./core.js";
import { applySamsungProfile, SAMSUNG_UA } from "./tv-profile.js";
export const PROFILE = 'TV_SAMSUNG_QJS';
const recent = new Map(), pending = new Map(), scripts = new Map();
const sdkCache = { get: async key => scripts.get(key), remove: async key => scripts.delete(key),
  set: async (key, value) => {
    if (value.byteLength > 2097152) return;
    if (scripts.size >= 4) scripts.delete(scripts.keys().next().value);
    scripts.set(key, value);
  } };
// No host eval/new Function: the only interpreter is a bounded QuickJS VM.
Platform.shim.eval = async data => (await import("./worker-evaluator.js")).evaluatePlayer(data);
function plainFormat(raw, resolved) {
  return { itag: raw.itag, url: streamTarget(resolved), mime_type: raw.mime_type, bitrate: raw.bitrate,
    average_bitrate: raw.average_bitrate, content_length: raw.content_length, audio_quality: raw.audio_quality,
    has_audio: true, has_video: false };
}
function validCached(value, id) {
  if (!value || value.id !== id || !Array.isArray(value.formats) || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() + 120000) return false;
  try { return value.formats.length > 0 && value.formats.length <= 4 && value.formats.every(f => streamTarget(f.url)); }
  catch { return false; }
}
export function createPlayer({ env, manager, ctx }) {
  const keyFor = async id => `yt:stream:${await manager.scope()}:${PROFILE}:${videoOf(id)}`;
  const resolve = async (id, { force = false, hl = 'en' } = {}) => {
    const key = await keyFor(id);
    if (!force) {
      const local = recent.get(key);
      if (validCached(local, id)) return local;
      const cached = await env.YTM_KV.get(key, 'json');
      if (validCached(cached, id)) {
        if (recent.size >= 25) recent.delete(recent.keys().next().value);
        recent.set(key, cached); return cached;
      }
    } else { recent.delete(key); await env.YTM_KV.delete(key); }
    const pendingKey = key + ':' + (force ? 'fresh' : 'normal');
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    const work = (async () => {
      const yt = await manager.tv(hl, { cache: sdkCache, retrieve_player: true, client_type: 'TVHTML5', user_agent: SAMSUNG_UA });
      applySamsungProfile(yt.session);
      // Passing an SDK client option here would overwrite the Samsung version.
      const info = await yt.getBasicInfo(id);
      const upstream = [...(info.streaming_data?.adaptive_formats || []), ...(info.streaming_data?.formats || [])];
      const formats = [], nsigCache = new Map();
      for (const itag of [774, 141, 251, 140]) {
        const raw = upstream.find(f => f.itag === itag && f.has_audio && !f.has_video &&
          !f.drm_families?.length && !f.drm_track_type && !f.fair_play_key_uri);
        if (!raw) continue;
        try { formats.push(plainFormat(raw, await yt.session.player.decipher(raw.url, raw.signature_cipher, raw.cipher, nsigCache))); }
        catch { /* Another compatible non-DRM format may still work. */ }
      }
      if (!formats.length) throw new YouTubeError('YOUTUBE_NO_AUDIO_FORMAT', 422);
      const expirations = formats.map(f => Number(new URL(f.url).searchParams.get('expire')) * 1000).filter(v => Number.isFinite(v) && v > Date.now());
      const upstreamExpiry = new Date(info.streaming_data?.expires).getTime();
      if (Number.isFinite(upstreamExpiry) && upstreamExpiry > Date.now()) expirations.push(upstreamExpiry);
      const expiresAt = expirations.length ? Math.min(...expirations) : Date.now() + 60000;
      const value = { id, formats, expiresAt };
      const ttl = Math.min(12600, Math.floor((expiresAt - Date.now()) / 1000) - 120);
      if (ttl >= 60) {
        if (recent.size >= 25) recent.delete(recent.keys().next().value);
        recent.set(key, value);
        const task = env.YTM_KV.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(task); else await task;
      }
      return value;
    })().finally(() => pending.delete(pendingKey));
    pending.set(pendingKey, work); return work;
  };
  return { resolve, keyFor };
}
