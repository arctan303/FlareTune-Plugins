import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { parseLanguageAwareTranslationResponse: parse, buildTranslationBatches } = await loadTestModule(new URL('./translationFormat.js', import.meta.url));
const units = [{ unitId: 2, text: 'The wind is calling' }, { unitId: 4, text: 'Stay beside me' }];
const good = () => ({ translations: [{ unitId: 2, text: '风正在呼唤' }, { unitId: 4, text: '留在我身旁' }] });
test('translation role accepts only covered ID/text results, independent of language assessment', () => {
  assert.deepEqual(parse(good(), units, { targetLanguage: 'zh' }).translations, good().translations);
  for (const extra of [{ songLanguage: 'en' }, { notNeeded: true }, { unitLanguages: [] }, { segments: [] }, { translationLanguage: 'zh' }]) {
    assert.throws(() => parse({ ...good(), ...extra }, units, { targetLanguage: 'zh' }), /INVALID_RESPONSE_FIELDS/u);
  }
});
test('missing, duplicated and foreign IDs cannot pass coverage validation', () => {
  for (const translations of [[], [good().translations[0]], [good().translations[0], good().translations[0]],
    [{ unitId: 9, text: '风正在呼唤' }, good().translations[1]]]) {
    assert.throws(() => parse({ translations }, units, { targetLanguage: 'zh' }), /INVALID_COVERAGE|INVALID_TRANSLATION_INDEX/u);
  }
});
test('damaged text and clearly wrong target script are rejected', () => {
  for (const text of ['', '风\n在呼唤', '[00:01.00]风在呼唤', String.fromCharCode(96).repeat(3) + '风在呼唤', 'x'.repeat(241)]) {
    const value = good(); value.translations[0].text = text;
    assert.throws(() => parse(value, units, { targetLanguage: 'zh' }), /INVALID_TRANSLATION_TEXT|TARGET_LANGUAGE_MISMATCH/u);
  }
  assert.throws(() => parse({ translations: units.map(unit => ({ unitId: unit.unitId, text: unit.text })) }, units, { targetLanguage: 'zh' }),
    /TARGET_LANGUAGE_MISMATCH|UNCHANGED_TRANSLATION/u);
});
test('explicit cleanup accepts only allowed whole-row indices and never language instructions', () => {
  assert.deepEqual(parse({ ...good(), discardLineIndices: [0, 0] }, units, { targetLanguage: 'zh', allowedCleanupIndices: new Set([0]) }).discardLineIndices, [0]);
  for (const discardLineIndices of [[99], ['0'], null]) {
    assert.throws(() => parse({ ...good(), discardLineIndices }, units, { targetLanguage: 'zh', allowedCleanupIndices: new Set([0]) }), /INVALID_CLEANUP_INDICES/u);
  }
  assert.deepEqual(parse({ discardLineIndices: [0] }, units, { analysisOnly: true, allowedCleanupIndices: new Set([0]) }).translations, null);
  assert.throws(() => parse(good(), units, { analysisOnly: true }), /INVALID_RESPONSE_FIELDS/u);
});
test('batch boundaries retain stable IDs and neighboring context without timing payload', () => {
  const rows = Array.from({ length: 5 }, (_, unitId) => ({ unitId, text: 'Verse ' + unitId }));
  const batches = buildTranslationBatches(rows, 'Song', 'Singer', { targetLanguage: 'zh', maxUnits: 2, contextUnits: 1 });
  assert.deepEqual(batches.map(batch => batch.units.map(unit => unit.unitId)), [[0, 1], [2, 3], [4]]);
  assert.equal(JSON.parse(batches[1].messages[1].content).context.before[0].unitId, 1);
  assert.equal(JSON.parse(batches[1].messages[1].content).context.after[0].unitId, 4);
  assert.throws(() => buildTranslationBatches(rows, '', '', { maxUnits: 0 }), /INVALID_BATCH_LIMIT/u);
});
// Prior unitLanguages/segments/foreign-fragment and same-target batch protocols
// are retired by the accepted 1.0.0 whole-song predominant-language policy.
