import { createLyricDocument } from '@flaretune/plugin-sdk/server/lyric-document';
import { createYouTubeAccess } from './integration.js';
import { loadYouTubeSettings } from './settings.js';
import { digest, YouTubeError } from './core.js';
import { YOUTUBE_TRANSLATION_LANGUAGES } from '../shared/preferences.js';
import { youtubeMessage } from '../shared/messages.js';

const SONG = /^yt:([A-Za-z0-9_-]{11})$/u;
const cache = new Map(), failures = new Map();
const boundedSet = (map, key, value) => { if (!map.has(key) && map.size >= 200) map.delete(map.keys().next().value); map.set(key, value); };
const snapshot = value => structuredClone(value);
const bodyHash = document => digest(document.lines.map(line => String(line.text || '').trim()).filter(Boolean).join('\n'));
const targetOf = value => value === 'zh' ? 'zh-CN' : value === 'zh-Hant' ? 'zh-TW' : value;
function localizedTranslation(translation, locale) {
  if (!translation?.error) return translation;
  return { ...translation, error: { code: translation.error.code,
    message: youtubeMessage(translation.error.code === 'YOUTUBE_TRANSLATION_ALIGNMENT_FAILED' ? 'alignmentFailed' : 'translationUnavailable', locale) } };
}
export function createLyricSource({ env, db = env?.DB, session, executionContext, context, dependencies = {} } = {}) {
  const settingsFor = dependencies.loadSettings || loadYouTubeSettings;
  const getAccess = dependencies.getAccess || createYouTubeAccess;
  const now = dependencies.now || Date.now;
  const failureMap = dependencies.failures || failures, resultCache = dependencies.cache || cache;
  const source = {
    id: 'youtube-music',
    isEnabled: async () => (await settingsFor(db)).lyricsEnabled,
    claim: song => SONG.test(song?.id || ''),
    async resolve(song, options = {}) {
      const match = SONG.exec(song?.id || '');
      if (!match) return null;
      options.signal?.throwIfAborted();
      const settings = await settingsFor(db);
      if (!settings.lyricsEnabled) return null;
      const targetLanguage = targetOf(options.targetLanguage || settings.translationLanguage);
      if (!YOUTUBE_TRANSLATION_LANGUAGES.includes(targetLanguage)) throw new YouTubeError('YOUTUBE_INVALID_LANGUAGE', 400);
      const access = await getAccess(env, session, executionContext, { settingsFor: async () => settings });
      await access.assertCurrent();
      const locale = options.locale || context?.locale || session?.account?.locale || 'en';
      const key = JSON.stringify([access.epoch, song.id, settings.region, targetLanguage, settings.translationEnabled]);
      const activeFailure = failureMap.get(key);
      const cached = resultCache.get(key);
      if (cached && cached.expires > now() && !(options.retry && cached.result.translation.state === 'failed')) {
        await access.assertCurrent(); options.signal?.throwIfAborted();
        const result = snapshot(cached.result);
        result.translation = localizedTranslation(result.translation, locale);
        return result;
      }
      if (activeFailure?.until > now()) return null;
      const markFailure = error => {
        const count = (failureMap.get(key)?.count || 0) + 1;
        boundedSet(failureMap, key, { count, until: /429/u.test(error?.code || '') || error?.retryAfterSeconds || count >= 3 ? now() + 60000 : 0 });
      };
      let native;
      try {
        native = await access.service.lyrics(match[1], { hl: targetLanguage, includeTranslation: settings.translationEnabled,
          songLanguage: song.language, signal: options.signal });
      } catch (error) {
        options.signal?.throwIfAborted(); markFailure(error); throw error;
      }
      options.signal?.throwIfAborted();
      await access.assertCurrent();
      if (native?.status !== 'available' || !native.text?.trim()) return null;
      const document = createLyricDocument({ source: 'youtube', format: native.syncMode === 'line' ? 'lrc' : 'plain',
        lines: Array.isArray(native.lines) ? native.lines : native.text.split(/\r?\n/u).map(text => ({ text })),
        providerMeta: { providerLyricId: song.id, matchedTitle: song.title, matchedArtist: song.artist, matchedDuration: song.duration } });
      if (!document.lines.length) return null;
      const translation = native.translation || { supported: false, state: 'unavailable', targetLanguage,
        language: null, source: 'youtube', kind: 'machine', lines: [] };
      if (translation.state === 'failed') markFailure(translation.error);
      else failureMap.delete(key);
      const result = { quality: document.syncMode === 'line' || document.syncMode === 'word' ? 'good' : 'weak',
        document, translation, provenance: { providerLyricId: song.id, matchedTitle: song.title,
          matchedArtist: song.artist, matchedDuration: song.duration },
        sourceRef: { videoId: match[1], targetLanguage }, textHash: await bodyHash(document) };
      boundedSet(resultCache, key, { expires: now() + (translation.state === 'failed' ? 15000 : 600000), result: snapshot(result) });
      result.translation = localizedTranslation(result.translation, locale);
      return result;
    },
    async translate(ref, options = {}) {
      const match = SONG.exec(ref?.songId || '');
      if (!match || ref.sourceRef?.videoId !== match[1] || !/^[a-f0-9]{64}$/u.test(ref.textHash || '')
        || !YOUTUBE_TRANSLATION_LANGUAGES.includes(ref.sourceRef?.targetLanguage)) {
        throw new YouTubeError('YOUTUBE_LYRIC_RESULT_CHANGED', 409);
      }
      const song = options.song?.id === ref.songId ? options.song : { id: ref.songId };
      const result = await source.resolve(song, { ...options, retry: true, targetLanguage: ref.sourceRef.targetLanguage });
      if (!result || result.textHash !== ref.textHash) throw new YouTubeError('YOUTUBE_LYRIC_RESULT_CHANGED', 409);
      return result;
    },
  };
  return Object.freeze(source);
}
