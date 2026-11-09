import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { readDefinedSettings, updateDefinedSetting } from "@flaretune/plugin-sdk/server/settings";
import { DEFAULT_LYRIC_AI_CONFIG, normalizeLyricAiConfig } from "./policy.js";
import { DEFAULT_LYRIC_CHANNELS, normalizeLyricChannels } from "@flaretune/plugin-sdk/server/lyric-source-contract";
const validate = normalize => value => { try { return normalize(value); } catch { throw new InstanceAdminError('invalid_setting', 400); } };
const definitions = {
  'lyrics.ai': { defaultValue: DEFAULT_LYRIC_AI_CONFIG, validate: validate(normalizeLyricAiConfig) },
  'lyrics.sources': { defaultValue: DEFAULT_LYRIC_CHANNELS, validate: validate(normalizeLyricChannels),
    read: value => normalizeLyricChannels(value, { migrateLegacy: true }),
    validatePrevious(next, previous) {
      if (next.sources.some(source => previous.sources.some(old => old.id === source.id && old.protocol !== source.protocol))) {
        throw new InstanceAdminError('invalid_setting', 400);
      }
    } },
};
export async function getAdminSettings(db, actor) {
  const settings = await readDefinedSettings(db, actor, definitions);
  if (settings['lyrics.ai'].revision === 0) {
    const legacy = await db.prepare(`SELECT provider, model, temperature, system_prompt
      FROM AI_Assistants WHERE id = 'lyric_translator'`).first();
    if (legacy?.provider && legacy?.model) settings['lyrics.ai'].value = normalizeLyricAiConfig({
      ...DEFAULT_LYRIC_AI_CONFIG, provider: legacy.provider, model: legacy.model,
      temperature: legacy.temperature ?? 0.2, styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules });
  }
  return { settings, defaults: { lyrics: { styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules } } };
}
export const updateAdminSetting = (db, actor, key, value, revision, now) =>
  updateDefinedSetting(db, actor, key, value, revision, definitions[key], now);
