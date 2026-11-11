import { browseOf, videoOf, safeText, localeOf, YouTubeError } from "./core.js";
import { albumResult, item } from "./normalize.js";
import { createSessionManager } from "./upstream.js";
import { createPlayer } from "./player.js";
import { streamResponse, imageResponse } from "./media.js";
import { pagedSearch, pagedArtist } from "./pagination.js";
import { assertPublicVideo } from "./public-visibility.js";
import { fetchTimedLyrics, normalizeTimedLyrics } from "./timed-lyrics.js";
import { fetchNativeLyrics } from "./native-translation.js";
import { DEFAULT_YOUTUBE_SETTINGS } from "../shared/preferences.js";
const metadata = new Map();
const activeMetadata = new Map();
function remember(song, hl, region = 'US') {
  if (!song?.sourceId || song.kind !== 'song' || !song.title) return song;
  if (metadata.size >= 200) metadata.delete(metadata.keys().next().value);
  metadata.set(region + ':' + hl + ':' + song.sourceId, { at: Date.now(), song });
  return song;
}
const normalizedLyrics = value => {
  const text = safeText(value?.description).trim();
  if (text.length > 200000) throw new YouTubeError('YOUTUBE_LYRICS_TOO_LARGE', 502);
  return { status: text ? 'available' : 'unavailable', source: 'youtube', syncMode: 'none',
    text, attribution: safeText(value?.footer).slice(0, 2000) };
};
export function createYouTubeService({ env, credentials, epoch, ctx, services = {}, settings = DEFAULT_YOUTUBE_SETTINGS }) {
  const manager = services.manager || createSessionManager({ env, credentials, epoch, ctx,
    ...(services.createSession ? { createSession: services.createSession } : {}) });
  const player = services.player || createPlayer({ env, manager, ctx });
  const requirePublicVideo = services.assertPublicVideo || assertPublicVideo;
  const guest = async hl => { localeOf(hl, settings.region); return manager.guest(hl, settings.region); };
  const result = {
    async validateAuth() {
      await manager.tv('en');
      return { connected: true, profile: 'TV_SAMSUNG_QJS' };
    },
    async search(query, { filter = 'all', hl = settings.metadataLanguage, offset = 0, limit = 20 } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.trim().length > 200 || !['all', 'song', 'artist', 'album', 'video'].includes(filter)) {
        throw new YouTubeError('YOUTUBE_INVALID_SEARCH', 400);
      }
      const yt = await guest(hl);
      const data = await pagedSearch(yt, query.trim(), { filter, hl, offset, limit, cacheNamespace: JSON.stringify([services.cacheNamespace || '', settings.region]) });
      data.songs.forEach(song => remember(song, hl, settings.region));
      return data;
    },
    async song(id, { hl = settings.metadataLanguage } = {}) {
      videoOf(id); localeOf(hl);
      const key = settings.region + ':' + hl + ':' + id;
      const cached = metadata.get(key);
      if (cached?.at > Date.now() - 600000) return { ...cached.song };
      if (activeMetadata.has(key)) return activeMetadata.get(key);
      const work = (async () => {
        const yt = await guest(hl);
        // next supplies album/artist IDs even when WEB_REMIX player is blocked.
        let queue;
        try { queue = await yt.music.getUpNext(id, false); } catch { /* Basic info is the fallback. */ }
        const exact = Array.from(queue?.contents || []).find(node => node.video_id === id || node.id === id);
        if (exact) return remember(item(exact), hl, settings.region);
        const info = await yt.music.getInfo(id);
        const basic = info.basic_info || {};
        const song = item({ ...basic, video_id: id,
          artists: basic.channel_id ? [{ channel_id: basic.channel_id, name: basic.author || basic.channel?.name || '' }] : [],
          thumbnail: basic.thumbnail });
        if (!song?.title) throw new YouTubeError('YOUTUBE_METADATA_UNAVAILABLE', 404);
        return remember(song, hl, settings.region);
      })().finally(() => activeMetadata.delete(key));
      activeMetadata.set(key, work); return work;
    },
    async album(id, { hl = settings.metadataLanguage } = {}) {
      browseOf(id, 'album');
      const yt = await guest(hl);
      const data = albumResult(await yt.music.getAlbum(id), id);
      data.songs.forEach(song => remember(song, hl, settings.region));
      return data;
    },
    async artist(id, { hl = settings.metadataLanguage, offset = 0, limit = 20 } = {}) {
      browseOf(id, 'artist');
      const yt = await guest(hl);
      const data = await pagedArtist(yt, id, { hl, offset, limit, cacheNamespace: JSON.stringify([services.cacheNamespace || '', settings.region]) });
      data.songs.forEach(song => remember(song, hl, settings.region));
      return data;
    },
    async lyrics(id, { hl = settings.translationLanguage, includeTranslation = settings.translationEnabled, signal, songLanguage } = {}) {
      videoOf(id);
      if (typeof manager.musicIos === 'function') {
        return await fetchNativeLyrics(await manager.musicIos(hl, settings.region), id, {
          includeTranslation, targetLanguage: hl, songLanguage, signal, normalizeTimed: normalizeTimedLyrics,
          fallbackGuest: () => manager.guest(hl, settings.region),
          fallbackMobile: () => manager.musicMobile(hl, settings.region),
        }) || normalizedLyrics(null);
      }
      const yt = await guest(hl);
      let timingFailed = false;
      if (typeof manager.musicMobile === 'function') {
        try {
          const timed = await fetchTimedLyrics(yt, await manager.musicMobile(hl, settings.region), id);
          if (timed) return timed;
        } catch { timingFailed = true; }
      }
      try {
        const plain = normalizedLyrics(await yt.music.getLyrics(id));
        if (timingFailed && plain.status !== 'available') throw new YouTubeError('YOUTUBE_LYRICS_UNAVAILABLE', 503);
        return plain;
      }
      catch (error) {
        if (/^(?:Could not find target tab\.|Lyrics (?:are )?not available\.?|Lyrics not found\.?)$/iu.test(error?.message || '')) {
          if (timingFailed) throw new YouTubeError('YOUTUBE_LYRICS_UNAVAILABLE', 503);
          return normalizedLyrics(null);
        }
        throw new YouTubeError('YOUTUBE_LYRICS_UNAVAILABLE', 503);
      }
    },
    async next(id, { hl = settings.metadataLanguage } = {}) {
      videoOf(id);
      const yt = await guest(hl);
      const values = await Promise.allSettled([yt.music.getUpNext(id, true), result.lyrics(id, { hl: settings.translationLanguage })]);
      const queue = values[0].status === 'fulfilled' ? Array.from(values[0].value?.contents || []).map(node => item(node))
        .filter(song => song?.kind === 'song').map(song => remember(song, hl, settings.region)) : [];
      return { queue, queueError: values[0].status === 'rejected' ? 'YOUTUBE_QUEUE_UNAVAILABLE' : null,
        lyrics: { ...(values[1].status === 'fulfilled' ? values[1].value : normalizedLyrics(null)),
          error: values[1].status === 'rejected' ? 'YOUTUBE_LYRICS_UNAVAILABLE' : null } };
    },
    async stream(request, id) {
      videoOf(id);
      // The membership account resolves only anonymously visible videos. This
      // check precedes both privileged resolution and any warm stream/KV hit.
      if (await requirePublicVideo(id) !== true) throw new YouTubeError('YOUTUBE_VIDEO_NOT_PUBLIC', 404);
      request.signal.throwIfAborted();
      return streamResponse(request, id, player, services.fetchMedia);
    },
    image: (request, url) => imageResponse(request, url, services.fetchImage),
  };
  return Object.freeze(result);
}
