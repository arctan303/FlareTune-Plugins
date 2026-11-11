import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { DEFAULT_YOUTUBE_SETTINGS } from '../shared/preferences.js';
const entry = fileURLToPath(new URL('./lyric-source.js', import.meta.url));
const compiled = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{
  name: 'isolated-source-contract',
  setup(plugin) {
    plugin.onResolve({ filter: /^@flaretune\/plugin-sdk\/server\/lyric-document$/ }, () => ({ path: 'document', namespace: 'test-contract' }));
    plugin.onResolve({ filter: /^\.\/(?:integration|settings)\.js$/ }, args => args.importer === entry ? { path: args.path, namespace: 'test-contract' } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: 'test-contract' }, args => ({ contents: args.path === 'document'
      ? 'export const createLyricDocument=value=>({...value,version:2,syncMode:value.format==="lrc"?"line":"none"});'
      : args.path.includes('integration') ? 'export const createYouTubeAccess=()=>{throw Error("access dependency required")};'
        : 'export const loadYouTubeSettings=()=>{throw Error("settings dependency required")};', loader: 'js' }));
  },
}] });
const { createLyricSource } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const song = { id: 'yt:abcdefghijk', title: 'Test', artist: 'Artist', duration: 10, language: 'en' };
const native = () => ({ status: 'available', syncMode: 'line', text: 'first\nsecond',
  lines: [{ text: 'first', time: 0, endTime: 1 }, { text: 'second', time: 1, endTime: 2 }],
  translation: { supported: true, state: 'ready', targetLanguage: 'zh-CN', language: 'zh-CN', source: 'youtube', kind: 'machine', lines: ['甲', '乙'] } });
function harness({ settings = DEFAULT_YOUTUBE_SETTINGS, lyrics = async () => native(), now = () => 0, assertCurrent = async () => {} } = {}) {
  const calls = []; const cache = new Map(), failures = new Map();
  const source = createLyricSource({ dependencies: { cache, failures, now,
    loadSettings: async () => settings, getAccess: async () => ({ epoch: 'binding-a', assertCurrent,
      service: { lyrics: async (...args) => { calls.push(args); return lyrics(...args); } } }) } });
  return { source, calls, cache, failures };
}
test('claim only accepts actual YT IDs and resolve never queries local tracks', async () => {
  const { source, calls } = harness();
  assert.equal(source.claim(song), true); assert.equal(source.claim({ id: 'yt:short' }), false);
  assert.equal(source.claim({ id: 'local' }), false); assert.equal(await source.resolve({ id: 'local' }), null); assert.equal(calls.length, 0);
});
test('disabled lyric setting produces no source result or upstream request', async () => {
  const { source, calls } = harness({ settings: { ...DEFAULT_YOUTUBE_SETTINGS, lyricsEnabled: false } });
  assert.equal(await source.isEnabled(), false);
  assert.equal(await source.resolve(song), null); assert.equal(calls.length, 0);
});
test('returns a paired good result, hashes the exact body and caches safely', async () => {
  const { source, calls } = harness();
  const first = await source.resolve(song); const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('first\nsecond'));
  assert.equal(first.textHash, Buffer.from(hash).toString('hex')); assert.equal(first.quality, 'good');
  assert.deepEqual(first.sourceRef, { videoId: 'abcdefghijk', targetLanguage: 'zh-CN' });
  first.translation.lines[0] = 'caller mutation';
  const again = await source.resolve(song); assert.equal(again.translation.lines[0], '甲'); assert.equal(calls.length, 1);
});
test('known plaintext-only original is weak', async () => {
  const { source } = harness({ lyrics: async () => ({ status: 'available', syncMode: 'none', text: 'first' }) });
  const result = await source.resolve(song); assert.equal(result.quality, 'weak'); assert.equal(result.translation.supported, false);
});
test('translate belongs to its own exact body and honors the original target', async () => {
  const { source } = harness();
  const first = await source.resolve(song);
  const ref = { songId: song.id, sourceRef: first.sourceRef, textHash: first.textHash };
  assert.equal((await source.translate(ref)).textHash, first.textHash);
  await assert.rejects(source.translate({ ...ref, textHash: 'a'.repeat(64) }), { code: 'YOUTUBE_LYRIC_RESULT_CHANGED' });
  await assert.rejects(source.translate({ ...ref, sourceRef: { ...ref.sourceRef, videoId: 'other-id' } }), { code: 'YOUTUBE_LYRIC_RESULT_CHANGED' });
});
test('three consecutive translation failures cool the source without disabling audio', async () => {
  let clock = 0;
  const { source, calls } = harness({ now: () => clock, lyrics: async () => ({ ...native(),
    translation: { supported: true, state: 'failed', lines: [], error: { code: 'YOUTUBE_TRANSLATION_UNAVAILABLE' } } }) });
  for (let i = 0; i < 3; i++) { assert.equal((await source.resolve(song)).translation.state, 'failed'); clock += 16000; }
  assert.equal(await source.resolve(song), null); assert.equal(calls.length, 3);
  clock += 60000; assert.equal((await source.resolve(song)).translation.state, 'failed'); assert.equal(calls.length, 4);
});
test('cached public lyrics still require current binding/session authority', async () => {
  let retired = false;
  const { source, calls } = harness({ assertCurrent: async () => { if (retired) throw Error('retired'); } });
  await source.resolve(song); retired = true;
  await assert.rejects(source.resolve(song), /retired/u); assert.equal(calls.length, 1);
});
test('translation errors are localized safe messages, never raw upstream details', async () => {
  const { source } = harness({ lyrics: async () => ({ ...native(), translation: { supported: true, state: 'failed', lines: [],
    error: { code: 'YOUTUBE_TRANSLATION_ALIGNMENT_FAILED', message: 'private raw upstream response' } } }) });
  const result = await source.resolve(song, { locale: 'zh' });
  assert.equal(result.translation.error.message, 'YouTube 译文无法与歌词逐行对应。');
  assert.equal(JSON.stringify(result).includes('private raw upstream'), false);
});
