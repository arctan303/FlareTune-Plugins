import { readFileSync } from 'node:fs';
const dictionaries = JSON.parse(readFileSync(new URL('../tests/sdk-i18n.json', import.meta.url), 'utf8'));
// Deliberately small public SDK fixture. Production SDK modules never load here.
let locale = 'zh';
export const getLocale = () => locale;
export const useLocale = () => locale;
export const setUiLanguage = value => { locale = value; };
export const t = (message, values = {}) => {
  let pattern = locale === 'zh' ? message : dictionaries[locale]?.[message] || dictionaries.en[message] || message;
  if (pattern && typeof pattern === 'object') pattern = pattern[new Intl.PluralRules(locale).select(Number(values.count ?? values.p0 ?? 0))] || pattern.other;
  return String(pattern).replace(/\{([^}]+)\}/gu, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
};
export const insertInlineCursorHtml = html => String(html || '') + '<span class="ai-typing-cursor" aria-hidden="true"></span>';
const throughHost = () => { throw new Error('Use the supplied host.player capability in plugin tests'); };
export const applyPlayerQueueEdit = throughHost, applyCurrentSongMetadataAndToggle = throughHost,
  applyPlaySongNow = throughHost, applyReplacePlayerQueue = throughHost, applyPlayerControl = throughHost;
