import { getLocale, t } from "@flaretune/plugin-sdk/client/i18n";

export const ROAM_LANGUAGES = Object.freeze([
  { key: 'zh', label: '中文' }, { key: 'en', label: '英语' }, { key: 'ja', label: '日语' },
  { key: 'ko', label: '韩语' }, { key: 'instrumental', label: '纯音乐' }, { key: 'other', label: '其他语言' },
]);
export { normalizeRoamLanguage } from "./algorithms.js";
export function formatRoamLanguageScope(language = 'all') {
  if (language === 'all') return t('全曲库');
  const selected = new Set(language.split(','));
  const labels = ROAM_LANGUAGES.filter(item => selected.has(item.key)).map(item => t(item.label));
  return labels.length ? new Intl.ListFormat(getLocale(), { style: 'short', type: 'conjunction' }).format(labels) : t('已选语种');
}
export const getMatchingRoamLanguageKey = locale => ['zh', 'en', 'ja', 'ko'].find(key => key === locale?.toLowerCase().split('-')[0]) || null;
export function getRoamShortcutLabel(key) {
  return ({ zh: t('仅中文'), en: t('仅英语'), ja: t('仅日语'), ko: t('仅韩语') })[key] || null;
}
export function getRoamShortcutToast(key) {
  return ({ zh: t('已切换为仅中文漫游'), en: t('已切换为仅英语漫游'), ja: t('已切换为仅日语漫游'), ko: t('已切换为仅韩语漫游') })[key] || t('已更新漫游语种偏好');
}
