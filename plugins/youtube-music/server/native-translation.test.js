import test from 'node:test';
import assert from 'node:assert/strict';
import { mapNativeTranslations, nativeLyricPointer, nativeMissingTranslationState, fetchNativeLyrics } from './native-translation.js';
import { normalizeYouTubeSettings, DEFAULT_YOUTUBE_SETTINGS } from '../shared/preferences.js';
import { youtubeMessages, youtubeMessage } from '../shared/messages.js';
const row = (lyricLine, start = 0) => ({ lyricLine, cueRange: { startTimeMilliseconds: String(start), endTimeMilliseconds: String(start + 1000) } });
const translated = (...texts) => texts.map(translatedLyricText => ({ translatedLyricText }));
const page = rows => ({ contents: { renderer: { timedLyricsData: rows, translationContinuationToken: 'opaque-native-continuation' } } });
const pointer = { contents: { browseEndpoint: { browseId: 'MPLYt_native', params: 'opaque-endpoint-params' } } };
const normalizeTimed = response => {
  const raw = response.contents.renderer.timedLyricsData;
  return { status: 'available', source: 'youtube', syncMode: 'line', text: raw.map(x => x.lyricLine).join('\n'),
    lines: raw.filter(x => x.lyricLine.trim()).map(x => ({ text: x.lyricLine.trim(), time: +x.cueRange.startTimeMilliseconds / 1000,
      endTime: +x.cueRange.endTimeMilliseconds / 1000 })) };
};
test('maps instrumental rows wherever they occur without inventing translated timestamps', () => {
  assert.deepEqual(mapNativeTranslations([row('first'), row('♪'), row('second'), row('♫')], translated('甲', '乙')), ['甲', '', '乙', '']);
  assert.deepEqual(mapNativeTranslations([row('♪'), row('first'), row('first')], translated('甲', '甲')), ['', '甲', '甲']);
  assert.deepEqual(mapNativeTranslations([row('first'), row(''), row('second')], translated('甲', '乙')), ['甲', '', '乙']);
});
test('rejects unexplained mismatches, empty lyric translations and full-width instrumental translations', () => {
  for (const [original, values] of [
    [[row('first'), row('second')], translated('甲')], [[row('first')], translated('')],
    [[row('first'), row('♪')], translated('甲', '乙')], [[row('♪')], translated('甲')],
  ]) assert.throws(() => mapNativeTranslations(original, values), { code: 'YOUTUBE_TRANSLATION_ALIGNMENT_FAILED' });
});
test('absence of continuation is not evidence of same-language lyrics', () => {
  assert.equal(nativeMissingTranslationState(undefined, 'zh-CN'), 'unavailable');
  assert.equal(nativeMissingTranslationState('other', 'en'), 'unavailable');
  assert.equal(nativeMissingTranslationState('en', 'en'), 'not_needed');
});
test('only follows a returned native lyric pointer and keeps its parameters', () => {
  assert.deepEqual(nativeLyricPointer(pointer), { browseId: 'MPLYt_native', params: 'opaque-endpoint-params' });
  assert.equal(nativeLyricPointer({ browseEndpoint: { browseId: 'UC_other' } }), null);
});
test('one native result obtains body and translation in three ordered requests', async () => {
  const calls = [];
  const responses = [pointer, page([row('first', 0), row('♪', 1000), row('second', 2000)]),
    { continuationContents: { musicLyricsContinuation: { lyricsTranslations: translated('甲', '乙') } } }];
  const mobile = { actions: { execute: async (endpoint, body) => { calls.push([endpoint, body]); return { data: responses.shift() }; } } };
  const result = await fetchNativeLyrics(mobile, 'abcdefghijk', { normalizeTimed, targetLanguage: 'zh-CN' });
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(x => x[0]), ['/next', '/browse', '/browse']);
  assert.equal(calls[2][1].continuation, 'opaque-native-continuation');
  assert.deepEqual(result.translation.lines, ['甲', '', '乙']);
  assert.equal(result.lines[1].time, 1); assert.equal(result.translation.state, 'ready');
  assert.equal(JSON.stringify(result).includes('opaque-native-continuation'), false);
});
test('empty raw lines are projected to canonical lines rather than shifting translations', async () => {
  const responses = [pointer, page([row('first', 0), row('', 1000), row('second', 2000)]),
    { continuationContents: { musicLyricsContinuation: { lyricsTranslations: translated('甲', '乙') } } }];
  const result = await fetchNativeLyrics({ actions: { execute: async () => ({ data: responses.shift() }) } }, 'abcdefghijk', { normalizeTimed });
  assert.equal(result.lines.length, 2); assert.deepEqual(result.translation.lines, ['甲', '乙']);
});
test('failed or misaligned translations preserve the available original', async () => {
  for (const outcome of ['throw', 'mismatch']) {
    let calls = 0;
    const mobile = { actions: { execute: async () => {
      calls++; if (calls === 1) return { data: pointer };
      if (calls === 2) return { data: page([row('first'), row('second', 1000)]) };
      if (outcome === 'throw') throw Error('private upstream body');
      return { data: { continuationContents: { musicLyricsContinuation: { lyricsTranslations: translated('甲') } } } };
    } } };
    const result = await fetchNativeLyrics(mobile, 'abcdefghijk', { normalizeTimed });
    assert.equal(result.status, 'available'); assert.equal(result.translation.state, 'failed');
    assert.equal(result.translation.supported, true); assert.equal(calls, 3);
    assert.equal(JSON.stringify(result).includes('private upstream'), false);
  }
});
test('disabled translation never requests a continuation', async () => {
  let calls = 0;
  const mobile = { actions: { execute: async () => ({ data: ++calls === 1 ? pointer : page([row('first')]) }) } };
  const result = await fetchNativeLyrics(mobile, 'abcdefghijk', { normalizeTimed, includeTranslation: false });
  assert.equal(calls, 2); assert.equal(result.translation.supported, false);
});
test('native next failure recovers original only within the same three-request budget', async () => {
  let calls = 0;
  const result = await fetchNativeLyrics({ actions: { execute: async () => { calls++; throw Error('native failed'); } } }, 'abcdefghijk',
    { normalizeTimed, fallbackGuest: async () => ({ actions: { execute: async () => { calls++; return { data: pointer }; } } }),
      fallbackMobile: async () => ({ actions: { execute: async () => { calls++; return { data: page([row('first')]) }; } } }) });
  assert.equal(calls, 3); assert.equal(result.translation.state, 'failed'); assert.equal(result.lines[0].text, 'first');
});
test('settings preserve explicit disabled values and independently validate locales', () => {
  assert.equal(DEFAULT_YOUTUBE_SETTINGS.translationEnabled, true);
  const normalized = normalizeYouTubeSettings({ metadataLanguage: 'en', region: 'JP', lyricsEnabled: false, translationEnabled: false, translationLanguage: 'ja' });
  assert.equal(normalized.translationEnabled, false); assert.equal(normalized.metadataLanguage, 'en'); assert.equal(normalized.region, 'JP');
  assert.throws(() => normalizeYouTubeSettings({ translationLanguage: 'fr' }));
  assert.throws(() => normalizeYouTubeSettings({ region: 'https://other' }));
  assert.throws(() => normalizeYouTubeSettings({ access_token: 'unexpected' }));
});
test('all five locales cover the settings and displayable-error messages', () => {
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) assert.deepEqual(Object.keys(youtubeMessages[locale]).sort(), Object.keys(youtubeMessages.en).sort());
  assert.equal(youtubeMessage('alignmentFailed', 'zh-TW'), youtubeMessages['zh-Hant'].alignmentFailed);
});
