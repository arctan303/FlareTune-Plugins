import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { buildWholeSongCompletionPrompt: prompt, parseWholeSongCompletionResponse: parse } =
  await loadTestModule(new URL('./completionFormat.js', import.meta.url));
const units = [{ unitId: 1, text: 'We wait together' }, { unitId: 3, text: 'The wind returns' }];
const translated = () => ({ translations: units.map(unit => ({ unitId: unit.unitId, text: '我们在风中等候' })) });

test('complete-song and legacy combined helpers both carry all 264 units without 40/120-row boundaries', () => {
  for (const sourceLanguage of ['en', null]) {
    const full = Array.from({ length: 264 }, (_, unitId) => ({ unitId, text: 'Verse ' + unitId }));
    const messages = prompt(full, { title: 'Fixture', artist: 'Singer' }, { targetLanguage: 'zh', sourceLanguage });
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.units.length, 264); assert.equal(payload.units.at(-1).unitId, 263);
    assert.equal(payload.units.at(-1).text, 'Verse 263');
    assert.match(messages[0].content, /JSON/u);
    assert.equal(Object.hasOwn(payload, 'languageTable'), !sourceLanguage);
    assert.equal(Object.hasOwn(payload, 'cleanupUnits'), false);
  }
});
test('legacy combined-format helper remains readable although production classifies independently', () => {
  const result = parse({ language: 'en', match: 0.95, ...translated() }, units, { targetLanguage: 'zh' });
  assert.equal(result.sourceLanguage, 'en'); assert.equal(result.needed, true);
  assert.deepEqual(result.translations, translated().translations);
  assert.deepEqual(parse({ language: 'zh', match: 0.95, translations: [] }, units, { targetLanguage: 'zh-Hant' }),
    { sourceLanguage: 'zh', needed: false, translations: null, discardLineIndices: [] });
});
test('unknown or low-confidence output and incomplete same-language contracts remain failures', () => {
  for (const response of [{ language: 'other', match: 1, translations: [] }, { language: 'en', match: 0.79, ...translated() },
    { language: 'zh', match: 0.99 }, { language: 'zh', match: 0.99, ...translated() },
    { language: 'en', match: 0.99, translations: [] }]) {
    assert.throws(() => parse(response, units, { targetLanguage: 'zh' }));
  }
});
test('known catalog language is authoritative and never accepts a model language override', () => {
  assert.deepEqual(parse(translated(), units, { targetLanguage: 'zh', sourceLanguage: 'en' }).translations, translated().translations);
  assert.throws(() => parse({ language: 'zh', match: 1, ...translated() }, units,
    { targetLanguage: 'zh', sourceLanguage: 'en' }), /INVALID_RESPONSE_FIELDS/u);
});
test('complete coverage, target script and unchanged-body validation stay enforced', () => {
  for (const response of [{ translations: translated().translations.slice(0, 1) },
    { translations: [translated().translations[0], translated().translations[0]] },
    { translations: units.map(unit => ({ unitId: unit.unitId, text: unit.text })) },
    { translations: units.map(unit => ({ unitId: unit.unitId, text: '[00:01.00]坏输出' })) }]) {
    assert.throws(() => parse(response, units, { targetLanguage: 'zh', sourceLanguage: 'en' }));
  }
});
test('cleanup indices require explicit consent while cleanup-only keeps the existing compact format', () => {
  assert.throws(() => parse({ ...translated(), discardLineIndices: [0] }, units,
    { targetLanguage: 'zh', sourceLanguage: 'en' }), /INVALID_RESPONSE_FIELDS/u);
  assert.equal(parse({ discardLineIndices: [0] }, units,
    { targetLanguage: 'zh', sourceLanguage: 'en', translateLyrics: false, allowedCleanupIndices: new Set([0]) }).needed, true);
  assert.throws(() => parse({ ...translated(), discardLineIndices: [9] }, units,
    { targetLanguage: 'zh', sourceLanguage: 'en', allowedCleanupIndices: new Set([0]) }), /INVALID_CLEANUP_INDICES/u);
});
