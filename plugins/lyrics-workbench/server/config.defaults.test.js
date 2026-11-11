import test from 'node:test';
import assert from 'node:assert/strict';
import { installationTranslationTarget, translationLanguageMatches } from '../shared/translation-languages.js';
import { loadLyricPolicySnapshot, loadLyricAiConfig, loadLyricAiProcessingSettings } from './config.js';
const saved = { provider: 'openai', model: 'saved', temperature: 0.2, styleRules: '', targetLanguage: 'ja', cleanDirtyLyrics: false, translateLyrics: true, detectLanguage: true, referenceExistingTranslation: false, completionEnabled: false, automaticCompletionEnabled: false };
function database(uiLanguage, config = null) {
  let queries = 0; return { get queries() { return queries; }, prepare(sql) {
    assert.match(sql, /lyrics\.ai/u); assert.match(sql, /plugin\.installation\.lyrics-workbench/u); queries++;
    return { first: async () => ({ policy_json: config ? JSON.stringify(config) : null, installation_json: uiLanguage === undefined ? null : JSON.stringify({ uiLanguage }) }) };
  } };
}
for (const [ui,target] of [['zh','zh'],['zh-Hant','zh-Hant'],['en','en'],['ja','ja'],['ko','ko'],[undefined,'en'],['unsupported','en']]) {
  test(`installation UI ${String(ui)} sets the initial shared target ${target} with one policy query`, async () => {
    const db = database(ui); const snapshot = await loadLyricPolicySnapshot(db); assert.equal(snapshot.config.targetLanguage,target);
    const full = await loadLyricAiConfig(db,{ snapshot, getLegacy: async () => ({provider:'openai',model:'test'}) }); assert.equal(full.targetLanguage,target); assert.equal(full.automaticCompletionEnabled,true);
    assert.equal(db.queries,1);
  });
}
test('a saved target and explicit disabled mode win over later installation UI', async () => {
  const db = database('zh-Hant',saved); const snapshot = await loadLyricPolicySnapshot(db);
  assert.equal(snapshot.config.targetLanguage,'ja'); assert.equal(snapshot.config.completionEnabled,false); assert.equal(db.queries,1);
});
test('saved processing policy does not consult Gateway or overwrite consumer-owned model selection', async () => {
  const db = database('en',saved);
  const full = await loadLyricAiConfig(db,{ getLegacy: async () => { throw new Error('Unexpected legacy model lookup'); } });
  assert.equal(full.targetLanguage,'ja'); assert.equal(full.automaticCompletionEnabled,false);
  assert.equal(full.model,'saved'); assert.equal(db.queries,1);
});
test('a new policy can load without an installed gateway or legacy assistant row', async () => {
  const db = database('ko');
  const full = await loadLyricAiConfig(db,{ getLegacy: async () => null });
  assert.equal(full.targetLanguage,'ko'); assert.equal(full.automaticCompletionEnabled,true);
  assert.equal(db.queries,1);
});
test('processing-only reads use the same installation snapshot contract', async () => {
  const db = database('ko'); const result = await loadLyricAiProcessingSettings(db); assert.equal(result.targetLanguage,'ko'); assert.equal(db.queries,1);
});
test('script-specific targets stay separate while accepted source aliases match', () => {
  assert.equal(translationLanguageMatches('zh-CN','zh'),true); assert.equal(translationLanguageMatches('zh-TW','zh-Hant'),true);
  assert.equal(translationLanguageMatches('zh-Hant','zh'),false); assert.equal(translationLanguageMatches('zh','zh-Hant'),false);
  assert.equal(installationTranslationTarget('zh_TW'),'zh-Hant');
});
