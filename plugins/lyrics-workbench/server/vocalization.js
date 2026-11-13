// A model may leave an unambiguous English vocal sound in the original row.
// This is not a general exemption for untranslated words, phrases or languages.
export function isPreservedEnglishVocalization(text, language, translation) {
  if (language !== 'en' || typeof text !== 'string' || text.length > 120) return false;
  const source = text.normalize('NFKC').trim();
  if (!source || /[^A-Za-z\s\p{P}]/u.test(source)) return false;
  const tokens = source.toLowerCase().match(/[a-z]+/gu) || [];
  if (!tokens.length || tokens.length > 16
    || tokens.some(token => !/^(?:a|aha|ah+|ha+|(?:ha){2,}|oh+|o+h|uh+|hm+|mm+)$/u.test(token))) return false;
  if (translation === undefined || translation === '') return true;
  if (typeof translation !== 'string') return false;
  const letters = value => value.normalize('NFKC').toLowerCase().replace(/[^a-z]/gu, '');
  return !translation.trim() || letters(translation) === letters(source)
    && !/[^A-Za-z\s\p{P}]/u.test(translation.normalize('NFKC'));
}

// Analysis only: never change the saved/sung text. Chinese lines containing
// nothing Latin except clear vocal sounds can retain their same-target status.
export function chineseTextWithoutVocalizations(text) {
  if (typeof text !== 'string' || !/\p{Script=Han}/u.test(text)) return null;
  const tokens = text.match(/\p{Script=Latin}+/gu) || [];
  if (isPreservedEnglishVocalization(tokens.join(' '), 'en', '')) return text.replace(/\p{Script=Latin}+/gu, '');
  // In a line such as Chinese + "SHOW HA", remove only the unmistakable
  // laughter for analysis. Keep SHOW (and articles such as "a") so the normal
  // host policy still decides whether the remaining phrase needs translation.
  let changed = false;
  const analyzed = text.replace(/\p{Script=Latin}+/gu, token => {
    if (!/^(?:ha+|hah+|(?:ha){2,})$/iu.test(token)) return token;
    changed = true; return '';
  });
  return changed ? analyzed : null;
}
