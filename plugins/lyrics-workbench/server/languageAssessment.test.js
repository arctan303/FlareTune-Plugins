import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { parseLanguageAssessmentResponse: parse, buildLanguageAssessmentPrompt: prompt, LANGUAGE_MATCH_THRESHOLD,
  LYRIC_LANGUAGE_TABLE, dominantLyricTranslationNeed } = await loadTestModule(new URL('./languageAssessment.js', import.meta.url));
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
test('classifier is separate from translation and bounded across the complete song', () => {
  const messages = prompt({ lines: Array.from({ length: 200 }, (_, i) => ({ text: 'Sung verse ' + i })) });
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.totalSungLines, 200);
  assert.equal(payload.units.length, 96);
  assert.ok(payload.units.at(-1).unitId > 190);
  assert.match(messages[0].content, /Do not translate/u);
  assert.match(messages[0].content, /few foreign phrases/u);
});
test('metadata excluded from classification is not authorization to edit original lines', async () => {
  const module = await loadTestModule(new URL('./languageAssessment.js', import.meta.url), { leadingTitleMetadata: true });
  const original = { lines: [{ text: 'Title' }, { text: '这才是演唱正文' }] };
  const messages = module.buildLanguageAssessmentPrompt(original, { title: 'Title' });
  assert.deepEqual(JSON.parse(messages[1].content).units, [{ unitId: 1, text: '这才是演唱正文' }]);
  assert.equal(original.lines.length, 2);
});
test('dominant tags compare spoken Chinese consistently while preserving Cantonese', () => {
  const artifact = { original: { lines: [{ text: '我们一起唱歌' }] } };
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'zh' }, { targetLanguage: 'zh-Hant' }).state, 'not_needed');
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'yue' }, { targetLanguage: 'zh' }).state, 'needed');
});

test('a long opening row cannot consume the sample and erase later language evidence', () => {
  const payload = JSON.parse(prompt({ lines: [{ text: 'a'.repeat(20000) }, { text: '这是后面的中文演唱正文' }] })[1].content);
  assert.equal(payload.units.length, 2);
  assert.equal(payload.units[1].text, '这是后面的中文演唱正文');
  assert.ok(payload.units.reduce((sum, unit) => sum + unit.text.length, 0) <= 10000);
});
