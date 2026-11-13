import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { parseLanguageAwareTranslationResponse: parse } = await loadTestModule(new URL('./translationFormat.js', import.meta.url));
const options = { sourceLanguage: 'zh', targetLanguage: 'zh' };
const units = [{ unitId: 3, text: '我在窗前等候' }, { unitId: 4, text: 'A Ha' },
  { unitId: 5, text: 'Stay here beside me' }, { unitId: 7, text: 'Ha Ha' }];
const response = () => ({ songLanguage: 'zh', unitLanguages: units.map(unit => ({ unitId: unit.unitId,
  language: unit.unitId === 3 ? 'zh' : 'en' })), translations: units.map(unit => ({ unitId: unit.unitId,
    text: unit.unitId === 5 ? '留在我身旁' : '' })) });

test('a Chinese mixed batch permits empty vocalizations while retaining the semantic English translation', () => {
  const result = parse(response(), units, options);
  assert.deepEqual(result.translations, [{ unitId: 3, text: '' }, { unitId: 4, text: '' },
    { unitId: 5, text: '留在我身旁' }, { unitId: 7, text: '' }]);
  assert.equal(result.hasForeignPassages, true);
});

test('retained vocalizations do not become untranslated Latin translation rows', () => {
  const input = response(); input.translations[1].text = 'A Ha'; input.translations[3].text = 'Ha Ha';
  assert.deepEqual(parse(input, units, options).translations.map(row => row.text), ['', '', '留在我身旁', '']);
});

test('a Chinese batch with only optional vocalizations accepts an explicit no-op', () => {
  const selected = units.filter(unit => unit.unitId !== 5);
  const input = response(); delete input.translations; input.notNeeded = true;
  input.unitLanguages = input.unitLanguages.filter(row => row.unitId !== 5);
  const result = parse(input, selected, options);
  assert.equal(result.translations, null); assert.equal(result.hasForeignPassages, false);
});

test('an inline vocalization may remain empty with exact segment coverage', () => {
  const input = { songLanguage: 'zh', unitLanguages: [{ unitId: 41, languages: ['zh', 'en'], segments: [
    { text: '窗外传来 ', language: 'zh' }, { text: 'Ha Ha', language: 'en' },
  ] }], translations: [{ unitId: 41, text: '' }] };
  const result = parse(input, [{ unitId: 41, text: '窗外传来 Ha Ha' }], options);
  assert.equal(result.translations, null); assert.equal(result.hasForeignPassages, false);
});

test('semantic English cannot be omitted, retained unchanged or mislabeled as vocalization', () => {
  for (const text of ['', 'Stay here beside me']) {
    const input = response(); input.translations[2].text = text;
    assert.throws(() => parse(input, units, options), /INVALID_TRANSLATION_TEXT|TARGET_LANGUAGE_MISMATCH|UNCHANGED_TRANSLATION/u);
  }
  for (const text of ['Come on', 'No no', 'Show', 'Ha take my hand']) {
    assert.throws(() => parse({ songLanguage: 'zh', unitLanguages: [{ unitId: 1, language: 'en' }],
      translations: [{ unitId: 1, text: '' }] }, [{ unitId: 1, text }], options), /INVALID_TRANSLATION_TEXT/u);
  }
});

test('unknown language evidence and non-English Latin units stay conservative', () => {
  for (const language of ['other', 'es']) assert.throws(() => parse({ songLanguage: 'zh',
    unitLanguages: [{ unitId: 1, language }], translations: [{ unitId: 1, text: '' }] },
  [{ unitId: 1, text: 'Ha Ha' }], options), /INVALID_UNIT_LANGUAGES|INVALID_TRANSLATION_TEXT/u);
});

test('Chinese text with embedded vocal sounds may remain empty without a fabricated language segment', () => {
  const source = [{ unitId: 41, text: '我听见窗外 Ha Ha 的笑声' }];
  const result = parse({ songLanguage: 'zh', unitLanguages: [{ unitId: 41, language: 'zh' }],
    translations: [{ unitId: 41, text: '' }] }, source, options);
  assert.equal(result.translations, null); assert.equal(source[0].text, '我听见窗外 Ha Ha 的笑声');
});

test('masking vocal sounds never hides a semantic foreign phrase or another script', () => {
  for (const text of ['我说 Stay here', '我听见 Ha Ha そして']) assert.throws(() => parse({ songLanguage: 'zh',
    unitLanguages: [{ unitId: 41, language: 'zh' }], translations: [{ unitId: 41, text: '' }] },
  [{ unitId: 41, text }], options), /SOURCE_LANGUAGE_MISMATCH/u);
});
