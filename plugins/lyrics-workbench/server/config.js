import { installationTranslationTarget } from '../shared/translation-languages.js';
import { DEFAULT_LYRIC_AI_CONFIG, lyricAiProcessingKey, normalizeLyricAiConfig } from './policy.js';

// Old lyric policy still supplies processing preferences, but never resolves a
// provider connection or imports Gateway's former consumer-model adapter.
const readLegacyLyricConfig = async db => db?.prepare
  ? await db.prepare("SELECT provider,model,temperature,system_prompt FROM AI_Assistants WHERE id='lyric_translator'").first() : null;

export async function loadLyricPolicySnapshot(db) {
  // Shared defaults follow the installation administrator, not the listener.
  const row = db?.prepare ? await db.prepare("SELECT (SELECT value_json FROM instance_settings WHERE key = 'lyrics.ai') AS policy_json, (SELECT value_json FROM instance_settings WHERE key = 'plugin.installation.lyrics-workbench') AS installation_json").first() : null;
  const stored = row?.policy_json ?? row?.value_json;
  if (stored) {
    try { return { config: normalizeLyricAiConfig(JSON.parse(stored)), hasStoredValue: true }; }
    catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
  }
  let installation;
  try { installation = row?.installation_json ? JSON.parse(row.installation_json) : null; } catch { installation = null; }
  return { config: { ...DEFAULT_LYRIC_AI_CONFIG, targetLanguage: installationTranslationTarget(installation?.uiLanguage) }, hasStoredValue: false };
}

export async function loadLyricAiConfig(db, { getLegacy = readLegacyLyricConfig, snapshot } = {}) {
  const policy = snapshot || await loadLyricPolicySnapshot(db);
  if (policy.hasStoredValue) return { ...policy.config, systemPrompt: policy.config.styleRules };
  const legacy = await getLegacy(db, 'lyric_translator');
  return { ...policy.config,
    ...(legacy ? { provider: legacy.provider, model: legacy.model, temperature: legacy.temperature ?? 0.2 } : {}),
    styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules, systemPrompt: DEFAULT_LYRIC_AI_CONFIG.styleRules };
}

export async function loadLyricTargetLanguage(db) {
  return (await loadLyricPolicySnapshot(db)).config.targetLanguage;
}

export async function loadLyricAiProcessingSettings(db) {
  const { config } = await loadLyricPolicySnapshot(db);
  return { onlineEnabled: config.onlineEnabled, lyricPreference: config.lyricPreference, targetLanguage: config.targetLanguage,
    processingKey: lyricAiProcessingKey(config), completionEnabled: config.completionEnabled,
    automaticCompletionEnabled: config.automaticCompletionEnabled };
}
