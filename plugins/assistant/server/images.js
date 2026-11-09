import { UserImageError, imageUrl } from "@flaretune/plugin-sdk/server/image-resources";
const policySchemas = new WeakMap();
export async function assistantImagePolicy(db) {
  let schema = policySchemas.get(db);
  if (!schema) {
    schema = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('user_images','user_image_refs')) AS image_tables,
    EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_feature_models') AS has_models`).first();
    // Schema metadata only, scoped to this request's guarded DB facade. Live
    // account, role, installation and image/model settings are never cached.
    policySchemas.set(db, schema);
  }
  if (schema.image_tables !== 2) return { enabled: false };
  try {
    const hasModels = schema.has_models === 1;
    const row = await db.prepare(`SELECT p.id,p.revision,a.revision AS feature_revision,
      (SELECT value_json FROM instance_settings WHERE key='assistant.images_enabled') AS images_enabled,
      ${hasModels ? 'CASE WHEN m.model IS NOT NULL THEN CASE WHEN m.supports_images = 1 THEN \'true\' ELSE \'false\' END ELSE v.value_json END' : 'v.value_json'} AS value_json FROM ai_feature_assignments a
      JOIN ai_model_profiles p ON p.id = a.profile_id
      ${hasModels ? 'LEFT JOIN ai_feature_models m ON m.feature = a.feature AND m.provider_id = p.id' : ''}
      LEFT JOIN instance_settings v ON v.key = 'ai.images.' || p.id WHERE a.feature = 'assistant'`).first();
    return { enabled: row?.images_enabled === 'true' && row?.value_json === 'true', profileId: row?.id ?? null, profileRevision: row?.revision ?? null,
      featureRevision: row?.feature_revision ?? null };
  } catch (error) {
    if (/no such table: (?:main\.)?(?:ai_model_profiles|ai_feature_assignments)/i.test(String(error?.message))) return { enabled: false };
    throw error;
  }
}
export function validateImageIds(ids) {
  if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) throw new UserImageError('invalid_image_attachments');
  return ids;
}
export async function validateOwnChatImages(db, accountId, ids) {
  validateImageIds(ids);
  for (const id of ids) {
    const image = await db.prepare("SELECT id FROM user_images WHERE id = ? AND account_id = ? AND purpose = 'chat' AND status = 'ready'").bind(id, accountId).first();
    if (!image) throw new UserImageError('image_not_found', 404);
  }
}
export function imageRefStatements(db, accountId, messageId, ids) {
  return ids.map((id, index) => db.prepare(`INSERT INTO user_image_refs (account_id,purpose,target_id,image_id,revision,message_id)
    SELECT ?,'chat',?,?,1,? WHERE EXISTS (SELECT 1 FROM music_chat_thread_messages WHERE id = ? AND account_id = ?)`)
    .bind(accountId, `${messageId}_${index}`, id, messageId, messageId, accountId));
}
function encodeBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}
// Re-check on every tool round. Never carry Base64 in the stored conversation.
export async function prepareAssistantImages(db, bucket, owner, messages, config) {
  const policy = await assistantImagePolicy(db);
  const allowed = policy.enabled && config.supportsImages === true && policy.profileId === config.profileId
    && policy.profileRevision === config.profileRevision && policy.featureRevision === config.featureRevision;
  const newest = messages.flatMap((message, index) => (message.privateImageIds || []).map(id => ({ id, index }))).slice(-4);
  const selected = new Set(newest.map(item => `${item.index}:${item.id}`));
  let omitted = 0; let included = 0;
  const output = [];
  for (const [index, message] of messages.entries()) {
    const { privateImageIds = [], privateMessageId, ...clean } = message;
    const parts = [{ type: 'text', text: clean.content }];
    for (const id of privateImageIds) {
      if (!allowed || !selected.has(`${index}:${id}`)) { omitted += 1; continue; }
      // Ensure that this account's actual stored message, not caller-controlled
      // extra JSON, references the image as a chat attachment.
      const item = await db.prepare(`SELECT image.* FROM user_image_refs ref JOIN user_images image ON image.id=ref.image_id
        AND image.account_id=ref.account_id AND image.status='ready'
        WHERE ref.account_id=? AND ref.purpose='chat' AND ref.message_id=? AND ref.image_id=?`)
        .bind(owner, privateMessageId, id).first();
      if (!item) { omitted += 1; continue; }
      if (item.purpose !== 'chat' || item.byte_size > 5242880) throw new UserImageError('invalid_image');
      const object = await bucket?.get(item.object_key);
      if (!object) throw new UserImageError('image_not_found', 404);
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.length !== item.byte_size) throw new UserImageError('image_unavailable', 503);
      parts.push({ type: 'image_url', image_url: { url: `data:image/webp;base64,${encodeBase64(bytes)}` } }); included += 1;
    }
    output.push({ ...clean, content: parts.length > 1 ? parts : clean.content });
  }
  // Once an older image falls out of the 24-message prompt, its absence must
  // not be interpreted by the model as access to the original pixels.
  if (output[0]?.role === 'system') output[0] = { ...output[0], content: `${output[0].content}\n图片边界：本次实际附带 ${included} 张原图。只可查看本次图片内容块；历史文字或旧回答不能代替未附带原图。需要其他图片时请听众重新附图。${omitted ? '部分历史图片因窗口、数量或管理员/模型设置未附带。' : ''}` };
  const finalPolicy = await assistantImagePolicy(db);
  if (included && (!finalPolicy.enabled || finalPolicy.profileId !== config.profileId || finalPolicy.profileRevision !== config.profileRevision
    || finalPolicy.featureRevision !== config.featureRevision)) {
    return { messages: output.map(message => ({ ...message, content: Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : message.content })),
      included: 0, omitted: omitted + included, disabled: true };
  }
  return { messages: output, included, omitted, disabled: !allowed };
}
export const attachmentDto = ids => ids.map(id => ({ id, url: imageUrl(id) }));
