import { InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement, validateRevision } from "@flaretune/plugin-sdk/server/admin-common";
import { updateDefinedSetting } from "@flaretune/plugin-sdk/server/settings";
const assistantFields = Object.freeze([
  'name', 'description', 'avatar_icon', 'persona', 'welcome_message',
  'system_rules', 'provider', 'model', 'temperature',
]);

function validText(value, max, min = 1) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}


export function validateAssistantConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || Object.keys(config).some((key) => !assistantFields.includes(key))) {
    throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  const lengths = { name: 80, description: 500, avatar_icon: 80, persona: 12000,
    welcome_message: 1000, system_rules: 24000, provider: 80, model: 160 };
  for (const [key, max] of Object.entries(lengths)) {
    if (!validText(config[key], max)) throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  if (typeof config.temperature !== 'number' || !Number.isFinite(config.temperature)
    || config.temperature < 0 || config.temperature > 2) throw new InstanceAdminError('invalid_assistant_setting', 400);
  return config;
}


const imagesDefinition = { defaultValue: false, validate(value) {
  if (typeof value !== 'boolean') throw new InstanceAdminError('invalid_setting', 400);
  return value;
} };
export function updateAdminSetting(db, actor, key, value, revision, now) {
  return updateDefinedSetting(db, actor, key, value, revision, key === 'assistant.images_enabled' ? imagesDefinition : undefined, now);
}
export async function updateAssistantConfig(db, actorAccountId, patch, expectedRevision, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision);
  currentTime(now);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)
    || Object.keys(patch).length === 0 || Object.keys(patch).some((key) => !assistantFields.includes(key))) {
    throw new InstanceAdminError('invalid_assistant_setting', 400);
  }
  const existing = await db.prepare(`SELECT name, description, avatar_icon, persona, welcome_message,
    system_rules, provider, model, temperature, revision FROM music_assistant_configs WHERE id = 'xiaoa'`).first();
  if (!existing) throw new InstanceAdminError('assistant_config_missing', 503);
  const next = validateAssistantConfig(Object.fromEntries(assistantFields.map((field) => [field, patch[field] ?? existing[field]])));
  const [result] = await atomic(db, [
    statement(db, `UPDATE music_assistant_configs SET name = ?, description = ?, avatar_icon = ?, persona = ?,
      welcome_message = ?, system_rules = ?, provider = ?, model = ?, temperature = ?,
      revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = 'xiaoa' AND revision = ?
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    ...assistantFields.map((field) => next[field]), now, actor.account_id, expectedRevision, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'assistant.update', 'assistant', 'xiaoa', 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { ...next, revision: expectedRevision + 1 };
}
