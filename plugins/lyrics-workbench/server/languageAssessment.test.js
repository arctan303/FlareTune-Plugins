import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { parseLanguageAssessmentResponse: parse, languageAssessmentUnits, LANGUAGE_MATCH_THRESHOLD,
  LYRIC_LANGUAGE_TABLE, dominantLyricTranslationNeed, buildLanguageAssessmentPrompt } = await loadTestModule(new URL('./languageAssessment.js', import.meta.url));
test('classification threshold has an explicit boundary and never forces unknown to a language', () => {
  assert.deepEqual(parse({ language: 'ja', match: LANGUAGE_MATCH_THRESHOLD }), { language: 'ja', match: 0.8 });
  assert.equal(parse({ language: 'ja', match: 0.799 }).language, null);
  assert.equal(parse({ language: 'other', match: 1 }).language, null);
  assert.equal(parse('{"language":"zh","match":0.97}').language, 'zh');
});
test('classifier accepts exactly one allowlisted language and finite numeric match', () => {
  for (const value of [{ language: 'zh-Hant', match: 0.99 }, { language: 'instrumental', match: 1 },
    { language: 'en', match: '0.9' }, { language: 'en', match: 2 }, { language: 'en', match: NaN },
    { language: 'en', match: 0.9, translations: [] }, { language: 'en' }, [], null]) {
    assert.throws(() => parse(value), /INVALID_LANGUAGE_ASSESSMENT/u);
  }
  assert.throws(() => parse('not json'), /INVALID_JSON/u);
  for (const language of Object.keys(LYRIC_LANGUAGE_TABLE)) assert.equal(parse({ language, match: 0.9 }).language, language);
});
test('metadata excluded from classification is not authorization to edit original lines', async () => {
  const module = await loadTestModule(new URL('./languageAssessment.js', import.meta.url), { leadingTitleMetadata: true });
  const original = { lines: [{ text: 'Title' }, { text: '这才是演唱正文' }] };
  const units = module.languageAssessmentUnits(original, { title: 'Title' });
  assert.deepEqual(units, [{ unitId: 1, text: '这才是演唱正文' }]);
  assert.equal(original.lines.length, 2);
});
test('dominant tags compare spoken Chinese consistently while preserving Cantonese', () => {
  const artifact = { original: { lines: [{ text: '我们一起唱歌' }] } };
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'zh' }, { targetLanguage: 'zh-Hant' }).state, 'not_needed');
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'yue' }, { targetLanguage: 'zh' }).state, 'needed');
});

test('standalone classification keeps every sung unit and asks only for a short language response', () => {
  const original = { lines: Array.from({ length: 480 }, (_, i) => ({ text: 'We sing verse ' + i })) };
  const messages = buildLanguageAssessmentPrompt(original, { title: 'Fixture', artist: 'Singer' });
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.units.length, 480); assert.equal(payload.units.at(-1).unitId, 479);
  assert.ok(payload.languageTable); assert.equal(Object.hasOwn(payload, 'targetLanguage'), false);
  assert.match(messages[0].content, /language.*match/u);
  assert.equal(Object.hasOwn(payload, 'referenceTranslations'), false);
});
