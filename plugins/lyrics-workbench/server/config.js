import { getAIAssistantConfig } from "@flaretune/plugin-service/ai-gateway/server/ai.js";
import { DEFAULT_LYRIC_AI_CONFIG, lyricAiProcessingKey, normalizeLyricAiConfig } from "./policy.js";

export async function loadLyricAiConfig(db, { getLegacy = getAIAssistantConfig } = {}) {
  const row = db?.prepare
    ? await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'lyrics.ai'").first()
    : null;
  if (row?.value_json) {
    let stored;
    try { stored = normalizeLyricAiConfig(JSON.parse(row.value_json)); }
    catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
    return { ...stored, systemPrompt: stored.styleRules };
  }
  const legacy = await getLegacy(db, 'lyric_translator');
  return {
    ...DEFAULT_LYRIC_AI_CONFIG,
    provider: legacy.provider,
    model: legacy.model,
    temperature: legacy.temperature ?? 0.2,
    styleRules: DEFAULT_LYRIC_AI_CONFIG.styleRules,
    systemPrompt: DEFAULT_LYRIC_AI_CONFIG.styleRules,
  };
}

export async function loadLyricTargetLanguage(db) {
  if (!db?.prepare) return DEFAULT_LYRIC_AI_CONFIG.targetLanguage;
  let row;
  try { row = await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'lyrics.ai'").first(); }
  catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
  if (!row?.value_json) return DEFAULT_LYRIC_AI_CONFIG.targetLanguage;
  try { return normalizeLyricAiConfig(JSON.parse(row.value_json)).targetLanguage; }
  catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
}

export async function loadLyricAiProcessingSettings(db) {
  if (!db?.prepare) return { targetLanguage: DEFAULT_LYRIC_AI_CONFIG.targetLanguage,
    processingKey: lyricAiProcessingKey(DEFAULT_LYRIC_AI_CONFIG),
    completionEnabled: DEFAULT_LYRIC_AI_CONFIG.completionEnabled,
    automaticCompletionEnabled: DEFAULT_LYRIC_AI_CONFIG.automaticCompletionEnabled };
  let row;
  try { row = await db.prepare("SELECT value_json FROM instance_settings WHERE key = 'lyrics.ai'").first(); }
  catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
  let config = DEFAULT_LYRIC_AI_CONFIG;
  if (row?.value_json) {
    try { config = normalizeLyricAiConfig(JSON.parse(row.value_json)); }
    catch { throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE'); }
  }
  return { targetLanguage: config.targetLanguage, processingKey: lyricAiProcessingKey(config),
    completionEnabled: config.completionEnabled,
    automaticCompletionEnabled: config.automaticCompletionEnabled };
}
