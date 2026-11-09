import { resolveAIConfig } from "@flaretune/plugin-service/ai-gateway/server/ai.js";

const XIAOA_ID = 'xiaoa';

const mapAssistantConfig = (row) => ({
  id: XIAOA_ID,
  name: String(row.name || '小A'),
  description: String(row.description || ''),
  avatarIcon: String(row.avatar_icon || 'bot'),
  persona: String(row.persona || ''),
  welcomeMessage: String(row.welcome_message || ''),
  systemRules: String(row.system_rules || ''),
  provider: String(row.provider || ''),
  model: String(row.model || ''),
  temperature: Number(row.temperature),
  revision: Number(row.revision),
  createdAt: Number(row.created_at || 0),
  updatedAt: Number(row.updated_at || 0),
  updatedBy: String(row.updated_by || ''),
});

const assertConfigured = (assistant) => {
  if (!assistant.persona.trim()
    || !assistant.systemRules.trim()
    || !Number.isFinite(assistant.temperature)
    || assistant.temperature < 0
    || assistant.temperature > 2
    || !Number.isInteger(assistant.revision)
    || assistant.revision < 1) {
    throw new Error('assistant_configuration_unavailable');
  }
  try {
    const modelConfig = resolveAIConfig(assistant);
    assistant.provider = modelConfig.provider;
    assistant.model = modelConfig.model;
  } catch {
    throw new Error('assistant_configuration_unavailable');
  }
  return assistant;
};

export async function readMusicAssistantConfig(db) {
  if (!db?.prepare) throw new Error('assistant_configuration_unavailable');
  try {
    const row = await db.prepare(`SELECT id,name,description,avatar_icon,persona,welcome_message,
      system_rules,provider,model,temperature,revision,created_at,updated_at,updated_by
      FROM music_assistant_configs WHERE id = ?`).bind(XIAOA_ID).first();
    if (!row) throw new Error('assistant_configuration_unavailable');
    return assertConfigured(mapAssistantConfig(row));
  } catch (error) {
    if (error?.message === 'assistant_configuration_unavailable') throw error;
    console.error('Failed to read the music assistant configuration:', error);
    throw new Error('assistant_configuration_unavailable');
  }
}

export function exposeAssistantBootstrap(assistant) {
  return {
    id: XIAOA_ID,
    name: assistant.name,
    description: assistant.description,
    avatarIcon: assistant.avatarIcon,
    welcomeMessage: assistant.welcomeMessage,
  };
}

export function toAssistantManagementDto(assistant) {
  return {
    name: assistant.name,
    description: assistant.description,
    welcomeMessage: assistant.welcomeMessage,
    persona: assistant.persona,
    systemRules: assistant.systemRules,
    provider: assistant.provider,
    model: assistant.model,
    revision: assistant.revision,
  };
}

export async function updateMusicAssistantConfig(db, fields, expectedRevision, updatedBy, now = Date.now()) {
  if (!db?.prepare) throw new Error('assistant_configuration_unavailable');
  const row = await db.prepare(`UPDATE music_assistant_configs
    SET description = ?, welcome_message = ?, persona = ?, system_rules = ?,
      revision = revision + 1, updated_at = ?, updated_by = ?
    WHERE id = ? AND revision = ?
    RETURNING id,name,description,avatar_icon,persona,welcome_message,system_rules,
      provider,model,temperature,revision,created_at,updated_at,updated_by`)
    .bind(
      fields.description,
      fields.welcomeMessage,
      fields.persona,
      fields.systemRules,
      now,
      String(updatedBy || '').slice(0, 240),
      XIAOA_ID,
      expectedRevision,
    ).first();
  return row ? assertConfigured(mapAssistantConfig(row)) : null;
}
