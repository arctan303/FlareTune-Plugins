import { YouTubeError, safeText } from './core.js';
export const MUSIC_IOS_PROFILE = Object.freeze({
  clientName: 'IOS_MUSIC', clientVersion: '9.06.4', platform: 'MOBILE',
  osName: 'iOS', osVersion: '26.2.1', deviceMake: 'Apple', deviceModel: 'iPhone18,4',
  userAgent: 'com.google.ios.youtubemusic/9.06.4 iSL/3.4 iPhone/26.2.1 hw/iPhone18_4 (gzip)',
});
const lexical = text => /[\p{L}\p{N}]/u.test(text);
function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, visit);
}
export function nativeLyricPointer(response) {
  let found = null;
  walk(response, value => {
    const endpoint = value.browseEndpoint;
    if (!found && typeof endpoint?.browseId === 'string' && /^MPLYt[\w-]{1,2040}$/u.test(endpoint.browseId)) {
      found = { browseId: endpoint.browseId };
      if (typeof endpoint.params === 'string' && endpoint.params.length <= 8192) found.params = endpoint.params;
    }
  });
  return found;
}
export function nativeLyricsData(response) {
  let found = null;
  walk(response, value => { if (!found && Array.isArray(value.timedLyricsData)) found = value; });
  return found;
}
export function nativePlainLyrics(response) {
  let found = null;
  walk(response, value => {
    if (found || !value.musicDescriptionShelfRenderer) return;
    const shelf = value.musicDescriptionShelfRenderer;
    const text = safeText(shelf.description?.simpleText || shelf.description?.runs?.map(run => run.text || '').join('')).trim();
    if (text.length > 200000) throw new YouTubeError('YOUTUBE_LYRICS_TOO_LARGE', 502);
    if (text) found = { status: 'available', source: 'youtube', syncMode: 'none', text,
      attribution: safeText(shelf.footer?.simpleText || shelf.footer?.runs?.map(run => run.text || '').join('')).slice(0, 2000) };
  });
  return found;
}
// The native translation omits non-lexical instrumental rows. Preserve original
// rows and their times; never blindly drop one row or use fuzzy text alignment.
export function mapNativeTranslations(originalRows, translatedRows) {
  if (!Array.isArray(originalRows) || !Array.isArray(translatedRows)
    || originalRows.length > 2000 || translatedRows.length > 2000) throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
  if (originalRows.some(row => typeof row?.lyricLine !== 'string' || row.lyricLine.length > 4000)
    || translatedRows.some(row => typeof row?.translatedLyricText !== 'string' || row.translatedLyricText.length > 4000)) {
    throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
  }
  const targets = originalRows.flatMap((row, index) => lexical(row.lyricLine) ? [index] : []);
  if (!targets.length) throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
  const output = originalRows.map(() => '');
  if (translatedRows.length === targets.length) {
    targets.forEach((index, translationIndex) => { output[index] = translatedRows[translationIndex].translatedLyricText.trim(); });
  } else if (translatedRows.length === originalRows.length) {
    if (originalRows.some((row, index) => !lexical(row.lyricLine) && translatedRows[index].translatedLyricText.trim())) {
      throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
    }
    targets.forEach(index => { output[index] = translatedRows[index].translatedLyricText.trim(); });
  } else throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
  if (targets.some(index => !output[index])) throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
  if (output.reduce((length, text) => length + text.length, 0) > 200000) throw new YouTubeError('YOUTUBE_LYRICS_TOO_LARGE', 502);
  return output;
}
export function nativeMissingTranslationState(songLanguage, targetLanguage) {
  const original = typeof songLanguage === 'string' ? songLanguage.toLowerCase().split('-')[0] : null;
  const target = targetLanguage.toLowerCase().split('-')[0];
  // Missing continuation alone never establishes the actual lyric language.
  return original && !['other', 'instrumental'].includes(original) && original === target ? 'not_needed' : 'unavailable';
}
export async function fetchNativeLyrics(mobile, id, { includeTranslation = true, targetLanguage = 'zh-CN',
  songLanguage, signal, normalizeTimed, fallbackMobile, fallbackGuest, onTranslationFailure = () => {} } = {}) {
  let calls = 0;
  const execute = async (session, endpoint, body) => {
    signal?.throwIfAborted();
    if (++calls > 3) throw new YouTubeError('YOUTUBE_LYRICS_REQUEST_BUDGET', 503);
    const response = await session.actions.execute(endpoint, { ...body, parse: false });
    signal?.throwIfAborted(); return response.data;
  };
  let next;
  try { next = await execute(mobile, '/next', { videoId: id }); }
  catch (error) {
    if (!fallbackGuest || !fallbackMobile || signal?.aborted) throw error;
    next = await execute(await fallbackGuest(), '/next', { videoId: id, client: 'YTMUSIC' });
    const pointer = nativeLyricPointer(next);
    if (!pointer) return null;
    const response = await execute(await fallbackMobile(), '/browse', pointer);
    const original = normalizeTimed(response) || nativePlainLyrics(response);
    return original ? { ...original, translation: { supported: includeTranslation, state: includeTranslation ? 'failed' : 'unavailable',
      targetLanguage, language: null, source: 'youtube', kind: 'machine', lines: [],
      ...(includeTranslation ? { error: { code: 'YOUTUBE_TRANSLATION_UNAVAILABLE' } } : {}) } } : null;
  }
  const pointer = nativeLyricPointer(next);
  if (!pointer) return null;
  let page, translationPathFailed = false;
  try { page = await execute(mobile, '/browse', pointer); }
  catch (error) {
    if (!fallbackMobile || signal?.aborted) throw error;
    translationPathFailed = true;
    page = await execute(await fallbackMobile(), '/browse', pointer);
  }
  const original = normalizeTimed(page) || nativePlainLyrics(page);
  if (!original) return null;
  const data = nativeLyricsData(page);
  const translation = { supported: false, state: 'unavailable', targetLanguage, language: null,
    source: 'youtube', kind: 'machine', lines: [] };
  if (!includeTranslation) return { ...original, translation };
  if (translationPathFailed) return { ...original, translation: { ...translation, supported: true, state: 'failed',
    error: { code: 'YOUTUBE_TRANSLATION_UNAVAILABLE' } } };
  const token = data?.translationContinuationToken;
  if (typeof token !== 'string' || !token || token.length > 16384) {
    translation.state = nativeMissingTranslationState(songLanguage, targetLanguage);
    return { ...original, translation };
  }
  translation.supported = true;
  try {
    const translated = await execute(mobile, '/browse', { continuation: token });
    const aligned = mapNativeTranslations(data.timedLyricsData,
      translated?.continuationContents?.musicLyricsContinuation?.lyricsTranslations);
    // Canonical normalization may remove empty rows. Project via exact text and
    // time identities instead of assuming the canonical array has raw indices.
    const entries = data.timedLyricsData.map((row, index) => ({ text: row.lyricLine.trim(),
      time: original.syncMode === 'line' ? Number(row.cueRange.startTimeMilliseconds) / 1000 : undefined,
      translated: aligned[index], used: false }));
    translation.lines = original.lines.map(line => {
      const entry = entries.find(item => !item.used && item.text === line.text && item.time === line.time);
      if (!entry) throw new YouTubeError('YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', 502);
      entry.used = true; return entry.translated;
    });
    translation.state = 'ready'; translation.language = targetLanguage;
  } catch (error) {
    if (signal?.aborted) throw error;
    onTranslationFailure(error);
    translation.state = 'failed';
    translation.error = { code: error?.code === 'YOUTUBE_TRANSLATION_ALIGNMENT_FAILED'
      ? error.code : 'YOUTUBE_TRANSLATION_UNAVAILABLE',
      ...(/429/u.test(error?.code || '') ? { retryAfterSeconds: 60 } : {}) };
  }
  return { ...original, translation };
}
