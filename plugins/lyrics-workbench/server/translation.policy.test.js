import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { parseLanguageAwareTranslationResponse } = await loadTestModule(new URL('./translationFormat.js', import.meta.url));

const units = [{ unitId: 0, text: '风吹过窗前' }];
test('same-target AI paraphrases are no-op decisions rather than translated text', () => {
  const result = parseLanguageAwareTranslationResponse({ songLanguage: 'zh',
    translations: [{ unitId: 0, text: '清风拂过窗边' }] }, units, { targetLanguage: 'zh' });
  assert.equal(result.translations, null);
  assert.equal(result.language, 'zh');
});

test('notNeeded requires reliable target-language evidence and is mutually exclusive with output', () => {
  for (const response of [{ notNeeded: true }, { notNeeded: true, songLanguage: 'other' },
    { notNeeded: true, songLanguage: 'zh', translations: [] },
    { notNeeded: true, songLanguage: 'en' }]) {
    assert.throws(() => parseLanguageAwareTranslationResponse(response, units, { targetLanguage: 'zh' }));
  }
});

test('mixed-language evidence preserves real foreign rows without rewriting target-language rows', () => {
  const mixed = [{ unitId: 0, text: '风吹过窗前' }, { unitId: 1, text: 'I will wait for you' }];
  const result = parseLanguageAwareTranslationResponse({ songLanguage: 'zh',
    unitLanguages: [{ unitId: 0, language: 'zh' }, { unitId: 1, language: 'en' }],
    translations: [{ unitId: 0, text: '清风拂过窗边' }, { unitId: 1, text: '我会等你' }],
  }, mixed, { targetLanguage: 'zh' });
  assert.deepEqual(result.translations, [{ unitId: 0, text: '' }, { unitId: 1, text: '我会等你' }]);
  assert.equal(result.hasForeignPassages, true);
  assert.throws(() => parseLanguageAwareTranslationResponse({ notNeeded: true, songLanguage: 'zh',
    unitLanguages: [{ unitId: 0, language: 'zh' }, { unitId: 1, language: 'en' }] }, mixed, { targetLanguage: 'zh' }));
});

test('an incomplete or duplicated unit-language map cannot authorize a same-language translation', () => {
  for (const unitLanguages of [[], [{ unitId: 0, language: 'en' }, { unitId: 0, language: 'en' }],
    [{ unitId: 0, language: 'other' }], [{ unitId: 12, language: 'en' }]]) {
    assert.throws(() => parseLanguageAwareTranslationResponse({ songLanguage: 'zh', unitLanguages,
      translations: [{ unitId: 0, text: '清风拂过窗边' }] }, units, { targetLanguage: 'zh' }));
  }
});

const inline = [{ unitId: 0, text: '我轻声说 I love you' }];
const inlineEvidence = { unitId: 0, languages: ['zh', 'en'], segments: [
  { text: '我轻声说 ', language: 'zh' }, { text: 'I love you', language: 'en', translation: '我爱你' },
] };
test('inline language segments translate the foreign phrase while preserving the existing Chinese', () => {
  const result = parseLanguageAwareTranslationResponse({ songLanguage: 'zh', unitLanguages: [inlineEvidence],
    translations: [{ unitId: 0, text: '我爱你' }] }, inline, { targetLanguage: 'zh' });
  assert.deepEqual(result.translations, [{ unitId: 0, text: '我爱你' }]);
  assert.equal(result.hasForeignPassages, true);
});
test('inline evidence cannot rewrite target segments or invent foreign material', () => {
  for (const evidence of [
    { ...inlineEvidence, languages: ['zh', 'en', 'en'] },
    { ...inlineEvidence, language: 'zh' },
    { ...inlineEvidence, segments: [{ text: '我轻声说 ', language: 'zh', translation: '我轻轻地说' }, inlineEvidence.segments[1]] },
    { ...inlineEvidence, segments: [{ text: '我轻轻地说 ', language: 'zh' }, inlineEvidence.segments[1]] },
    { ...inlineEvidence, segments: [{ text: '我轻声说 ', language: 'zh' }] },
  ]) assert.throws(() => parseLanguageAwareTranslationResponse({ songLanguage: 'zh', unitLanguages: [evidence],
    translations: [{ unitId: 0, text: '我爱你' }] }, inline, { targetLanguage: 'zh' }));
  assert.throws(() => parseLanguageAwareTranslationResponse({ songLanguage: 'zh', unitLanguages: [{ unitId: 0,
    languages: ['zh', 'en'], segments: [{ text: '风吹', language: 'zh' }, { text: '过窗前', language: 'en', translation: '清风拂过窗边' }] }],
    translations: [{ unitId: 0, text: '清风拂过窗边' }] }, units, { targetLanguage: 'zh' }));
  assert.throws(() => parseLanguageAwareTranslationResponse({ songLanguage: 'zh', unitLanguages: [inlineEvidence],
    translations: [{ unitId: 0, text: '我轻轻地说我爱你' }] }, inline, { targetLanguage: 'zh' }));
});
