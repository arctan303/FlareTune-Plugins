import { isValidSongLanguage } from "@flaretune/plugin-sdk/server/song-language";
import { DEFAULT_LYRIC_TRANSLATION_RULES } from "./defaultPrompts.js";

export const DEFAULT_LYRIC_AI_CONFIG = Object.freeze({
  provider: 'deepseek',
  model: 'deepseek-chat',
  temperature: 0.2,
  styleRules: DEFAULT_LYRIC_TRANSLATION_RULES,
  targetLanguage: 'zh',
  cleanDirtyLyrics: true,
  translateLyrics: true,
  detectLanguage: true,
  referenceExistingTranslation: false,
  completionEnabled: true,
  automaticCompletionEnabled: true,
});

const CONFIG_FIELDS = Object.keys(DEFAULT_LYRIC_AI_CONFIG);
const LEGACY_CONFIG_FIELDS = CONFIG_FIELDS.filter((key) => !['completionEnabled', 'automaticCompletionEnabled'].includes(key));

export function lyricAiProcessingKey(config) {
  return [config.targetLanguage,
    config.cleanDirtyLyrics, config.translateLyrics, config.detectLanguage,
    config.referenceExistingTranslation, config.completionEnabled ?? true,
    config.automaticCompletionEnabled ?? true].map((value) => typeof value === 'boolean'
    ? Number(value) : value).join('|');
}

export function normalizeLyricAiConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![CONFIG_FIELDS.length, LEGACY_CONFIG_FIELDS.length].includes(Object.keys(value).length)
    || Object.keys(value).some((key) => !CONFIG_FIELDS.includes(key))
    || LEGACY_CONFIG_FIELDS.some((key) => !Object.hasOwn(value, key))
    || (Object.hasOwn(value, 'completionEnabled')
      !== Object.hasOwn(value, 'automaticCompletionEnabled'))) {
    throw new TypeError('INVALID_LYRIC_AI_CONFIG');
  }
  const config = { ...DEFAULT_LYRIC_AI_CONFIG, ...value };
  const provider = String(config.provider || '').trim().toLowerCase();
  const model = String(config.model || '').trim();
  if (!['gemini', 'deepseek', 'openai'].includes(provider)
    || !model || model.length > 160
    || typeof config.temperature !== 'number' || !Number.isFinite(config.temperature)
    || config.temperature < 0 || config.temperature > 2
    || typeof config.styleRules !== 'string' || config.styleRules.length > 8_000
    || !isValidSongLanguage(config.targetLanguage)
    || ['instrumental', 'other'].includes(config.targetLanguage)
    || ['cleanDirtyLyrics', 'translateLyrics', 'detectLanguage', 'referenceExistingTranslation']
      .some((key) => typeof config[key] !== 'boolean')
    || typeof config.completionEnabled !== 'boolean'
    || typeof config.automaticCompletionEnabled !== 'boolean'
    || ![config.cleanDirtyLyrics, config.translateLyrics, config.detectLanguage].some(Boolean)) {
    throw new TypeError('INVALID_LYRIC_AI_CONFIG');
  }
  return { ...config, provider, model };
}
