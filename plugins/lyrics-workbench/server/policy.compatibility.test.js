import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const built = await build({ entryPoints: [fileURLToPath(new URL('./policy.js', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'language-capability', setup(api) {
  api.onResolve({ filter: /^@flaretune\/plugin-sdk\/server\/song-language$/ }, () => ({ path: 'languages', namespace: 'policy-test' }));
  api.onLoad({ filter: /.*/, namespace: 'policy-test' }, () => ({ contents: "export const isValidSongLanguage = x => ['zh','en','ja','ko'].includes(x);" }));
} }] });
const { DEFAULT_LYRIC_AI_CONFIG, normalizeLyricAiConfig } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

test('no-installation fallback retains automatic mode with English and explicit online/precision defaults', () => {
  const config = normalizeLyricAiConfig({ ...DEFAULT_LYRIC_AI_CONFIG });
  assert.equal(config.targetLanguage, 'en'); assert.equal(config.completionEnabled, true); assert.equal(config.automaticCompletionEnabled, true);
  assert.equal(config.onlineEnabled, true); assert.equal(config.lyricPreference, 'word');
});

test('legacy saved fields remain readable without the new policy properties', () => {
  const previous = { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'ja', completionEnabled: false, automaticCompletionEnabled: false, styleRules: 'Custom rules', model: 'custom-model' };
  delete previous.onlineEnabled; delete previous.lyricPreference;
  const config = normalizeLyricAiConfig(previous);
  assert.equal(config.completionEnabled, false); assert.equal(config.targetLanguage, 'ja'); assert.equal(config.styleRules, 'Custom rules'); assert.equal(config.model, 'custom-model');
});

test('an old explicit translation-off setting cannot be migrated into enabled completion', () => {
  const config = normalizeLyricAiConfig({ ...DEFAULT_LYRIC_AI_CONFIG, translateLyrics: false });
  assert.equal(config.completionEnabled, false);
});

test('manual mode, offline retrieval and line preference survive normalization', () => {
  const config = normalizeLyricAiConfig({ ...DEFAULT_LYRIC_AI_CONFIG, automaticCompletionEnabled: false, onlineEnabled: false, lyricPreference: 'line' });
  assert.equal(config.completionEnabled, true); assert.equal(config.automaticCompletionEnabled, false); assert.equal(config.onlineEnabled, false); assert.equal(config.lyricPreference, 'line');
});

test('unknown fields and invalid new policy values are rejected', () => {
  for (const patch of [{ unexpected: true }, { onlineEnabled: 'false' }, { lyricPreference: 'youtube' }]) {
    assert.throws(() => normalizeLyricAiConfig({ ...DEFAULT_LYRIC_AI_CONFIG, ...patch }), /INVALID_LYRIC_AI_CONFIG/u);
  }
});

test('Traditional Chinese is a translation target without becoming a catalog song language', () => {
  const config = normalizeLyricAiConfig({ ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: 'zh-Hant' });
  assert.equal(config.targetLanguage, 'zh-Hant');
});
