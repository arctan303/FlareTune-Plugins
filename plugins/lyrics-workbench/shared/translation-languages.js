// Translation targets are separate from catalog song-language classification.
export const TRANSLATION_TARGETS = Object.freeze(['zh', 'zh-Hant', 'en', 'ja', 'ko', 'ru', 'es', 'fr', 'de', 'sv', 'vi', 'yue', 'it', 'th', 'pt']);
export const isTranslationTarget = value => TRANSLATION_TARGETS.includes(value);
export const normalizeTranslationTarget = value => {
  const tag = String(value || '').replaceAll('_', '-').toLowerCase();
  if (/^zh-(?:hant|tw|hk)(?:-|$)/u.test(tag)) return 'zh-Hant';
  if (/^zh(?:-|$)/u.test(tag)) return 'zh';
  return TRANSLATION_TARGETS.find(code => code.toLowerCase() === tag) || null;
};
export function installationTranslationTarget(uiLanguage) {
  const tag = String(uiLanguage || '').replaceAll('_', '-').toLowerCase();
  const target = normalizeTranslationTarget(tag);
  if (target === 'zh' || target === 'zh-Hant') return target;
  const language = tag.split('-')[0];
  return ['en', 'ja', 'ko'].includes(language) ? language : 'en';
}
export const translationLanguageMatches = (actual, target) => {
  const a = normalizeTranslationTarget(actual), b = normalizeTranslationTarget(target);
  return Boolean(a && b && a === b);
};
const ENGLISH_NAMES = ['Simplified Chinese','Traditional Chinese','English','Japanese','Korean','Russian','Spanish','French','German','Swedish','Vietnamese','Cantonese','Italian','Thai','Portuguese'];
const LABELS = Object.freeze({
  en: ENGLISH_NAMES,
  zh: ['简体中文','繁体中文','英语','日语','韩语','俄语','西班牙语','法语','德语','瑞典语','越南语','粤语','意大利语','泰语','葡萄牙语'],
  'zh-Hant': ['簡體中文','繁體中文','英語','日語','韓語','俄語','西班牙語','法語','德語','瑞典語','越南語','粵語','義大利語','泰語','葡萄牙語'],
  ja: ['簡体字中国語','繁体字中国語','英語','日本語','韓国語','ロシア語','スペイン語','フランス語','ドイツ語','スウェーデン語','ベトナム語','広東語','イタリア語','タイ語','ポルトガル語'],
  ko: ['중국어 간체','중국어 번체','영어','일본어','한국어','러시아어','스페인어','프랑스어','독일어','스웨덴어','베트남어','광둥어','이탈리아어','태국어','포르투갈어'],
});
export function translationTargetLabel(target, locale = 'en') {
  const index = TRANSLATION_TARGETS.indexOf(target); if (index < 0) return target;
  const tag = String(locale).replaceAll('_','-').toLowerCase();
  const lang = tag.startsWith('zh') ? (/hant|tw|hk/u.test(tag) ? 'zh-Hant' : 'zh') : tag.split('-')[0];
  return (LABELS[lang] || ENGLISH_NAMES)[index];
}
export const translationTargetEnglishName = code => translationTargetLabel(code, 'en');
const letters = text => [...String(text || '').matchAll(/\p{L}/gu)].map(match => match[0]);
const PATTERNS = { han: /\p{Script=Han}/u, kana: /[\p{Script=Hiragana}\p{Script=Katakana}]/u,
  hangul: /\p{Script=Hangul}/u, cyrillic: /\p{Script=Cyrillic}/u, thai: /\p{Script=Thai}/u, latin: /\p{Script=Latin}/u };
// These distinguish common script errors; they are not an exhaustive converter
// or proof that an arbitrary Han-only phrase is Simplified/Traditional Chinese.
const SIMPLIFIED_DISTINCT = /[爱乐梦这说听见为风会还让们个从与书语龙头关样间过动给广门长亲声体汉简叶点学岛觉当记阳岁旧种变车别发]/gu;
const TRADITIONAL_DISTINCT = /[愛樂夢這說聽見為風會還讓們個從與書語龍頭關樣間過動給廣門長親聲體漢簡葉點學島覺當記陽歲舊種變車別發髮]/gu;
export function targetScriptEvidence(text, target) {
  const canonical = normalizeTranslationTarget(target); if (!canonical) return 'mismatch';
  const chars = letters(text); if (!chars.length) return 'unknown';
  const count = pattern => chars.filter(c => pattern.test(c)).length;
  const expected = canonical === 'ja' ? count(PATTERNS.kana) + count(PATTERNS.han)
    : canonical === 'ko' ? count(PATTERNS.hangul) : canonical === 'ru' ? count(PATTERNS.cyrillic)
      : canonical === 'th' ? count(PATTERNS.thai) : ['zh','zh-Hant','yue'].includes(canonical) ? count(PATTERNS.han) : count(PATTERNS.latin);
  if (!expected) return 'mismatch';
  if (canonical === 'zh' || canonical === 'zh-Hant') {
    if (count(PATTERNS.kana) > 0 || count(PATTERNS.hangul) > 0) return 'mismatch';
    const simplified = [...String(text).matchAll(SIMPLIFIED_DISTINCT)].length;
    const traditional = [...String(text).matchAll(TRADITIONAL_DISTINCT)].length;
    if (canonical === 'zh-Hant' && simplified > 0 && traditional === 0 || canonical === 'zh' && traditional > 0 && simplified === 0) return 'mismatch';
    if (simplified === 0 && traditional === 0) return 'unknown';
  }
  // A Latin alphabet is compatible with several languages. Do not label it
  // English (or any other language) from characters alone.
  return ['en','es','fr','de','sv','vi','it','pt'].includes(canonical) ? 'unknown' : 'match';
}
export const isUnchangedTranslation = (sourceTexts, translatedTexts) => sourceTexts.length === translatedTexts.length
  && sourceTexts.every((text,index) => String(text || '').normalize('NFKC').trim() === String(translatedTexts[index] || '').normalize('NFKC').trim());
