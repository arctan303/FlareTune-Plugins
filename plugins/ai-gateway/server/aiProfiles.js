import { InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement,
  validateRevision } from "@flaretune/plugin-sdk/server/admin-common";
import { AI_PROTOCOLS, AI_SOURCES, effectiveAiBaseUrl, legacyProtocol,
  normalizeGenerationOptions, sourceFromProvider, validateAiBaseUrl } from "../shared/aiProtocols.js";
import { aiHeaders, fetchAi } from "./aiTransport.js";

const providers = new Set(['deepseek', 'openai', 'gemini', 'compatible']);
const features = new Set(['assistant', 'lyrics']);
export const PROVIDER_CONNECTION_MODEL = '__provider_connection__';
export const featureModelsReady = async db => Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_feature_models'").first());
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function credentialSecret(env) {
  const secret = env?.SETUP_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new InstanceAdminError('setup_secret_unavailable', 503);
  }
  return secret;
}

async function encryptionKey(env) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(credentialSecret(env)),
    'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune instance secret separation v2'),
    info: encoder.encode('ai_model_profiles AES-GCM key v2') }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value) {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function encryptCredential(apiKey, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await encryptionKey(env), encoder.encode(apiKey));
  return { encryptedKey: encode(new Uint8Array(ciphertext)), keyIv: encode(iv) };
}

async function decryptCredential(row, env) {
  try {
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(row.key_iv) },
      await encryptionKey(env), decode(row.encrypted_key));
    return decoder.decode(plaintext);
  } catch {
    throw new Error('AI_CREDENTIAL_UNAVAILABLE');
  }
}

function validateProfile(input, { create = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InstanceAdminError('invalid_ai_profile', 400);
  }
  const { name, model, baseUrl = '', apiKey = '' } = input;
  const source = input.source || sourceFromProvider(input.provider);
  const provider = source === 'custom' || source === 'anthropic' ? 'compatible' : source;
  const protocol = input.protocol || (input.source ? AI_SOURCES[source]?.protocol : legacyProtocol(provider));
  if (typeof name !== 'string' || !name.trim() || name.length > 80
    || !providers.has(provider) || !Object.hasOwn(AI_SOURCES, source) || !Object.hasOwn(AI_PROTOCOLS, protocol)
    || typeof model !== 'string' || !model.trim()
    || model.length > 160 || typeof baseUrl !== 'string' || baseUrl.length > 2048
    || typeof apiKey !== 'string' || apiKey.length > 4096
    || (apiKey && (apiKey.trim() !== apiKey || /[\r\n]/.test(apiKey)))
    || (create && !apiKey)) throw new InstanceAdminError('invalid_ai_profile', 400);
  if (input.supportsImages !== undefined && typeof input.supportsImages !== 'boolean') throw new InstanceAdminError('invalid_ai_profile', 400);
  if (!effectiveAiBaseUrl(source, baseUrl, protocol)) throw new InstanceAdminError('invalid_ai_profile', 400);
  let options;
  try {
    if (baseUrl) validateAiBaseUrl(baseUrl);
    options = normalizeGenerationOptions(input.generationOptions, protocol);
  } catch { throw new InstanceAdminError('invalid_ai_profile', 400); }
  return { name: name.trim(), provider, source, protocol, model: model.trim(),
    baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, generationOptions: options, supportsImages: input.supportsImages === true };
}

const publicProfile = (row, hasKey) => ({ id: row.id, name: row.name, provider: row.provider,
  source: row.source || sourceFromProvider(row.provider),
  protocol: row.protocol || legacyProtocol(row.provider),
  supportsImages: row.supports_images_json === 'true' || row.supportsImages === true,
  generationOptions: row.options_json ? normalizeGenerationOptions(JSON.parse(row.options_json)) : {},
  model: row.model, baseUrl: row.base_url, hasKey, revision: row.revision });

// Legacy instances can still use existing profiles before applying migration 0009.
async function profileQuery(db, suffix, values = [], all = false, extra = '') {
  let query = `SELECT p.*, c.source, c.protocol, c.options_json, v.value_json AS supports_images_json ${extra} FROM ai_model_profiles p
    LEFT JOIN ai_profile_protocols c ON c.profile_id = p.id
    LEFT JOIN instance_settings v ON v.key = 'ai.images.' || p.id ${suffix}`;
  const run = (sql) => {
    const prepared = db.prepare(sql).bind(...values);
    return all ? prepared.all() : prepared.first();
  };
  try { return await run(query); }
  catch (error) {
    if (!/no such table: (?:main\.)?ai_profile_protocols/i.test(String(error?.message))) throw error;
    return run(`SELECT p.* ${extra} FROM ai_model_profiles p ${suffix}`);
  }
}

const metadataStatement = (db, id, data) => statement(db, `INSERT INTO ai_profile_protocols
  (profile_id, source, protocol, options_json) SELECT ?, ?, ?, ? WHERE changes() = 1
  ON CONFLICT(profile_id) DO UPDATE SET source = excluded.source, protocol = excluded.protocol,
    options_json = excluded.options_json`, id, data.source, data.protocol, JSON.stringify(data.generationOptions));

const protocolTableReady = async (db) => Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_profile_protocols'").first());
const visionStatement = (db, id, data, actor, now) => statement(db, `INSERT INTO instance_settings
  (key,value_json,revision,updated_at,updated_by) SELECT ?,?,1,?,? WHERE changes() = 1
  ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, revision = instance_settings.revision + 1,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by`, `ai.images.${id}`, JSON.stringify(data.supportsImages), now, actor);

async function isCredentialReadable(row, env) {
  try { return Boolean(await decryptCredential(row, env)); }
  catch { return false; }
}

export async function listAiProfiles(db, actorAccountId, env) {
  await requireActiveAdmin(db, actorAccountId);
  const [profileRows, assignmentRows] = await Promise.all([
    profileQuery(db, 'ORDER BY p.created_at, p.id', [], true),
    db.prepare('SELECT feature, profile_id, revision FROM ai_feature_assignments').all(),
  ]);
  return { profiles: await Promise.all((profileRows.results || []).map(async (row) =>
    publicProfile(row, await isCredentialReadable(row, env)))),
    assignments: Object.fromEntries((assignmentRows.results || []).map((row) => [row.feature,
      { profileId: row.profile_id, revision: row.revision }])),
    credentialReady: Boolean(env?.SETUP_SECRET?.length >= 32), protocolReady: await protocolTableReady(db) };
}

export async function createAiProfile(db, actorAccountId, input, env, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  if (!await protocolTableReady(db)) throw new InstanceAdminError('ai_protocol_migration_required', 503);
  const data = validateProfile(input, { create: true });
  currentTime(now);
  const id = crypto.randomUUID();
  const { encryptedKey, keyIv } = await encryptCredential(data.apiKey, env);
  const [result] = await atomic(db, [
    statement(db, `INSERT INTO ai_model_profiles
      (id, name, provider, model, base_url, encrypted_key, key_iv, revision, created_at, updated_at, updated_by)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    id, data.name, data.provider, data.model, data.baseUrl, encryptedKey, keyIv,
    now, now, actor.account_id, actor.account_id),
    metadataStatement(db, id, data),
    visionStatement(db, id, data, actor.account_id, now),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.create', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('forbidden', 403);
  return publicProfile({ ...data, id, base_url: data.baseUrl,
    options_json: JSON.stringify(data.generationOptions), revision: 1 }, true);
}

export async function updateAiProfile(db, actorAccountId, id, input, expectedRevision, env,
  now = Date.now(), { connectionOnly = false } = {}) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  if (!await protocolTableReady(db)) throw new InstanceAdminError('ai_protocol_migration_required', 503);
  validateRevision(expectedRevision);
  currentTime(now);
  const data = validateProfile(input);
  const existing = await profileQuery(db, 'WHERE p.id = ?', [id]);
  if (!existing) throw new InstanceAdminError('ai_profile_missing', 404);
  const previous = publicProfile(existing, false);
  const hasFeatureModels = await featureModelsReady(db);
  // The table cannot disappear through this application's add-only upgrades.
  // Reject pre-0011 legacy edits so a concurrent migration cannot backfill an
  // old model while an already-started edit reports a different one as saved.
  if (!hasFeatureModels) throw new InstanceAdminError('ai_provider_migration_required', 503);
  const legacyModelChange = !connectionOnly && hasFeatureModels && (data.model !== previous.model
    || data.supportsImages !== previous.supportsImages
    || JSON.stringify(data.generationOptions) !== JSON.stringify(previous.generationOptions));
  if (legacyModelChange
    && await db.prepare(`SELECT m.feature FROM ai_feature_models m JOIN ai_feature_assignments a
      ON a.feature = m.feature AND a.profile_id = m.provider_id WHERE m.provider_id = ? LIMIT 1`).bind(id).first()) {
    // Cached legacy clients must not report that vision/model changed while
    // the actual independent feature configuration remains unchanged.
    throw new InstanceAdminError('ai_feature_configuration_required', 409);
  }
  const connectionChanged = data.source !== previous.source || data.protocol !== previous.protocol
    || effectiveAiBaseUrl(data.source, data.baseUrl, data.protocol) !== effectiveAiBaseUrl(previous.source, previous.baseUrl, previous.protocol);
  if (!data.apiKey && connectionChanged) {
    throw new InstanceAdminError('ai_profile_key_required', 400);
  }
  if (!data.apiKey && !await isCredentialReadable(existing, env)) {
    throw new InstanceAdminError('ai_profile_key_required', 400);
  }
  if (connectionChanged && hasFeatureModels) data.supportsImages = false;
  const key = data.apiKey ? await encryptCredential(data.apiKey, env)
    : { encryptedKey: existing.encrypted_key, keyIv: existing.key_iv };
  const [result] = await atomic(db, [
    statement(db, `UPDATE ai_model_profiles SET name = ?, provider = ?, model = ?, base_url = ?,
      encrypted_key = ?, key_iv = ?, revision = revision + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND revision = ? AND EXISTS
      (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
      ${legacyModelChange ? `AND NOT EXISTS (SELECT 1 FROM ai_feature_models m JOIN ai_feature_assignments a
        ON a.feature = m.feature AND a.profile_id = m.provider_id WHERE m.provider_id = ?)` : ''}`,
    data.name, data.provider, data.model, data.baseUrl, key.encryptedKey, key.keyIv,
    now, actor.account_id, id, expectedRevision, actor.account_id, ...(legacyModelChange ? [id] : [])),
    metadataStatement(db, id, data),
    visionStatement(db, id, data, actor.account_id, now),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.update', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
    ...(connectionChanged && hasFeatureModels ? [
      statement(db, `UPDATE ai_feature_models SET supports_images = 0,options_json = '{}'
        WHERE provider_id = ? AND changes() = 1`, id),
      statement(db, `UPDATE ai_feature_assignments SET revision = revision + 1,updated_at = ?,updated_by = ?
        WHERE profile_id = ? AND changes() > 0`, now, actor.account_id, id),
    ] : []),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return publicProfile({ ...data, id, base_url: data.baseUrl,
    options_json: JSON.stringify(data.generationOptions), revision: expectedRevision + 1 }, true);
}

export async function deleteAiProfile(db, actorAccountId, id, expectedRevision, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision);
  const [result] = await atomic(db, [
    statement(db, `DELETE FROM ai_model_profiles WHERE id = ? AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM ai_feature_assignments WHERE profile_id = ?)
      AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
    id, expectedRevision, id, actor.account_id),
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.delete', 'ai_profile', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, id, now),
  ]);
  if (!changed(result)) throw new InstanceAdminError('ai_profile_in_use_or_conflict', 409);
  return { ok: true };
}

export async function assignAiProfile(db, actorAccountId, feature, profileId, expectedRevision,
  now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorAccountId);
  validateRevision(expectedRevision, { allowZero: true });
  if (!features.has(feature) || (profileId !== null && (typeof profileId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(profileId)))) throw new InstanceAdminError('invalid_ai_assignment', 400);
  currentTime(now);
  if (profileId !== null) {
    const profile = await db.prepare('SELECT id, model FROM ai_model_profiles WHERE id = ?').bind(profileId).first();
    if (!profile) throw new InstanceAdminError('ai_profile_missing', 404);
    if (profile.model === PROVIDER_CONNECTION_MODEL) throw new InstanceAdminError('ai_feature_model_required', 400);
  }
  const modelStatements = await featureModelsReady(db) ? [profileId === null
    ? statement(db, `DELETE FROM ai_feature_models WHERE feature = ? AND changes() = 1`, feature)
    : statement(db, `INSERT INTO ai_feature_models (feature,provider_id,model,supports_images,options_json)
      SELECT ?,p.id,p.model,CASE WHEN v.value_json = 'true' THEN 1 ELSE 0 END,COALESCE(c.options_json,'{}')
      FROM ai_model_profiles p LEFT JOIN ai_profile_protocols c ON c.profile_id = p.id
      LEFT JOIN instance_settings v ON v.key = 'ai.images.' || p.id WHERE p.id = ? AND changes() = 1
      ON CONFLICT(feature) DO UPDATE SET provider_id = excluded.provider_id,model = excluded.model,
        supports_images = excluded.supports_images,options_json = excluded.options_json`, feature, profileId)] : [];
  const [result] = await atomic(db, [
    expectedRevision === 0
      ? statement(db, `INSERT INTO ai_feature_assignments
        (feature, profile_id, revision, updated_at, updated_by)
        SELECT ?, ?, 1, ?, ? WHERE EXISTS
        (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
        ON CONFLICT(feature) DO NOTHING`, feature, profileId, now, actor.account_id,
      actor.account_id)
      : statement(db, `UPDATE ai_feature_assignments SET profile_id = ?, revision = revision + 1,
        updated_at = ?, updated_by = ? WHERE feature = ? AND revision = ? AND EXISTS
        (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')`,
      profileId, now, actor.account_id, feature, expectedRevision, actor.account_id),
    // Audit immediately after CAS; a no-op removal of a missing model row must
    // not suppress an otherwise successful legacy assignment audit.
    statement(db, `INSERT INTO audit_events
      (id, actor_account_id, action, target_type, target_id, result, created_at)
      SELECT ?, ?, 'ai_profile.assign', 'ai_feature', ?, 'success', ? WHERE changes() = 1`,
    crypto.randomUUID(), actor.account_id, feature, now),
    ...modelStatements,
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { feature, profileId, revision: expectedRevision + 1 };
}

export async function resolveAiFeature(db, feature, env, legacyConfig) {
  if (!db?.prepare) return null;
  let row;
  try {
    const hasModels = await featureModelsReady(db);
    row = await profileQuery(db, `JOIN ai_feature_assignments a ON p.id = a.profile_id
      ${hasModels ? 'LEFT JOIN ai_feature_models m ON m.feature = a.feature AND m.provider_id = p.id' : ''}
      WHERE a.feature = ?`, [feature], false, `, a.revision AS feature_revision
      ${hasModels ? ', m.model AS feature_model, m.supports_images AS feature_images, m.options_json AS feature_options' : ''}`);
  } catch (error) {
    // Existing instances keep their deployment-bound credentials until migration 0006 is applied.
    if (/no such table: (?:main\.)?(?:ai_feature_assignments|ai_model_profiles)/i.test(String(error?.message))) {
      const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ai_feature_assignments', 'ai_model_profiles')").all();
      if (!tables.results?.length) return null;
    }
    throw error;
  }
  if (!row) return null;
  if (!row.feature_model && row.model === PROVIDER_CONNECTION_MODEL) throw new Error('AI_FEATURE_MODEL_REQUIRED');
  const apiKey = await decryptCredential(row, env);
  const profile = publicProfile(row, true);
  const provider = profile.source === 'custom' ? 'openai' : profile.source;
  const secretName = { deepseek: 'DEEPSEEK_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' }[provider];
  const urlName = { deepseek: 'DEEPSEEK_BASE_URL', openai: 'OPENAI_BASE_URL', gemini: 'GEMINI_BASE_URL', anthropic: 'ANTHROPIC_BASE_URL' }[provider];
  const baseUrl = effectiveAiBaseUrl(profile.source, row.base_url, profile.protocol);
  return { config: { ...legacyConfig, provider, source: profile.source, protocol: profile.protocol,
    generationOptions: row.feature_model ? normalizeGenerationOptions(JSON.parse(row.feature_options), profile.protocol) : profile.generationOptions,
    supportsImages: row.feature_model ? row.feature_images === 1 : profile.supportsImages,
    profileId: row.id, profileRevision: row.revision, featureRevision: row.feature_revision,
    model: row.feature_model || row.model, exactModel: true },
    env: { ...env, AI_PROFILE_API_KEY: apiKey, AI_PROFILE_BASE_URL: baseUrl, [secretName]: apiKey,
      ...(urlName ? { [urlName]: baseUrl } : {}) } };
}

export async function listAiModels(db, actorAccountId, input, env) {
  await requireActiveAdmin(db, actorAccountId);
  const data = validateProfile({ ...input, name: 'Model list', model: 'list' });
  let apiKey = data.apiKey;
  if (!apiKey && input.profileId) {
    validateRevision(input.expectedRevision);
    const existing = await profileQuery(db, 'WHERE p.id = ?', [input.profileId]);
    if (!existing) throw new InstanceAdminError('ai_profile_missing', 404);
    if (existing.revision !== input.expectedRevision) throw new InstanceAdminError('revision_conflict', 409);
    const profile = publicProfile(existing, false);
    if (data.source !== profile.source || data.protocol !== profile.protocol
      || effectiveAiBaseUrl(data.source, data.baseUrl, data.protocol) !== effectiveAiBaseUrl(profile.source, profile.baseUrl, profile.protocol)) {
      throw new InstanceAdminError('ai_profile_key_required', 400);
    }
    apiKey = await decryptCredential(existing, env);
  }
  if (!apiKey) throw new InstanceAdminError('ai_profile_key_required', 400);
  const baseUrl = effectiveAiBaseUrl(data.source, data.baseUrl, data.protocol);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let stage = 'request';
  try {
    const response = await fetchAi(`${baseUrl}/models`, { method: 'GET',
      headers: aiHeaders(data.protocol, apiKey), signal: controller.signal });
    stage = 'read';
    // Bound the upstream list before JSON parsing; no model request is made.
    if (!response.body) throw new Error('AI_EMPTY_RESPONSE');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1048576) throw new Error('AI_MODEL_LIST_TOO_LARGE');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    stage = 'parse';
    const payload = JSON.parse(new TextDecoder().decode(buffer));
    const entries = data.protocol === 'gemini_native' ? payload.models : payload.data;
    if (!Array.isArray(entries)) throw new Error('AI_MODEL_LIST_INVALID');
    const models = [...new Set(entries.map((item) => data.protocol === 'gemini_native'
      ? item?.name?.replace(/^models\//, '') : item?.id)
      .filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 160 && !/[\r\n\x00]/.test(id)))].slice(0, 500);
    return { models, hasMore: Boolean(payload.nextPageToken || payload.has_more), verifiedCapabilities: false };
  } catch (error) {
    const status = /^AI_UPSTREAM_(\d{3})$/.exec(error?.message || '')?.[1];
    const code = status === '401' || status === '403' ? 'ai_model_list_auth_failed'
      : status === '429' ? 'ai_model_list_rate_limited'
        : status === '404' || status === '405' ? 'ai_model_list_unsupported'
          : controller.signal.aborted ? 'ai_model_list_timeout'
            : status ? `ai_model_list_http_${status}`
              : stage === 'request' ? 'ai_model_list_network_failed' : 'ai_model_list_invalid_response';
    // Never return the upstream body, URL, key or fetch error to the browser.
    throw new InstanceAdminError(code, 502);
  }
  finally { clearTimeout(timer); }
}
