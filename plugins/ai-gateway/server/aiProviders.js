import { InstanceAdminError, atomic, changed, currentTime, requireActiveAdmin, statement, validateRevision } from "@flaretune/plugin-sdk/server/admin-common";
import { AI_SOURCES, effectiveAiBaseUrl, normalizeGenerationOptions } from "../shared/aiProtocols.js";
import { PROVIDER_CONNECTION_MODEL, featureModelsReady, listAiProfiles, createAiProfile,
  updateAiProfile, deleteAiProfile, listAiModels } from "./aiProfiles.js";

function providerSource(profile) {
  // A historical official profile with a proxy URL must not become a pinned
  // official connection or silently send its retained key somewhere else.
  return profile.source !== 'custom'
    && effectiveAiBaseUrl(profile.source, profile.baseUrl, profile.protocol)
      === effectiveAiBaseUrl(profile.source, '', profile.protocol) ? profile.source : 'custom';
}
const providerDto = profile => ({ id: profile.id, name: profile.name, source: providerSource(profile),
  hasKey: profile.hasKey, revision: profile.revision,
  ...(providerSource(profile) === 'custom' ? { protocol: profile.protocol,
    baseUrl: effectiveAiBaseUrl(profile.source, profile.baseUrl, profile.protocol) } : {}) });
async function requireFeatureModels(db) {
  if (!await featureModelsReady(db)) throw new InstanceAdminError('ai_provider_migration_required', 503);
}
async function savedProfile(db, actor, id, env) {
  const data = await listAiProfiles(db, actor, env);
  const profile = data.profiles.find(item => item.id === id);
  if (!profile) throw new InstanceAdminError('ai_profile_missing', 404);
  return profile;
}
function connectionPayload(input, previous = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Object.hasOwn(AI_SOURCES, input.source)) throw new InstanceAdminError('invalid_ai_provider', 400);
  const custom = input.source === 'custom';
  const allowed = custom ? ['source', 'apiKey', 'name', 'protocol', 'baseUrl'] : ['source', 'apiKey', 'name'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new InstanceAdminError('invalid_ai_provider', 400);
  if (previous && providerSource(previous) !== input.source) throw new InstanceAdminError('invalid_ai_provider', 400);
  const sameCustomBinding = custom && previous && input.protocol === previous.protocol
    && effectiveAiBaseUrl('custom', input.baseUrl, input.protocol)
      === effectiveAiBaseUrl(previous.source, previous.baseUrl, previous.protocol);
  // Official edits change only display name/key; retain historical protocol/defaults.
  // New official connections always use the pinned presets, never client URLs.
  const name = input.name === undefined ? previous?.name || AI_SOURCES[input.source].name : input.name;
  return { name: typeof name === 'string' && !name.trim() ? AI_SOURCES[input.source].name : name,
    source: sameCustomBinding ? previous.source : input.source, apiKey: input.apiKey ?? '',
    protocol: custom ? input.protocol : previous?.protocol || AI_SOURCES[input.source].protocol,
    baseUrl: custom ? input.baseUrl : previous?.baseUrl || '',
    model: previous?.model || PROVIDER_CONNECTION_MODEL,
    generationOptions: !custom || sameCustomBinding ? previous?.generationOptions || {} : {},
    supportsImages: previous?.supportsImages || false };
}

export async function listAiProviders(db, actor, env) {
  const data = await listAiProfiles(db, actor, env);
  const ready = data.protocolReady && await featureModelsReady(db);
  const models = ready ? (await db.prepare('SELECT * FROM ai_feature_models').all()).results || [] : [];
  const features = Object.fromEntries(['assistant', 'lyrics'].map(feature => {
    const assignment = data.assignments[feature];
    const profile = data.profiles.find(item => item.id === assignment?.profileId);
    const model = models.find(item => item.feature === feature && item.provider_id === profile?.id);
    return [feature, { providerId: profile?.id || null, providerRevision: profile?.revision || 0,
      revision: assignment?.revision || 0, model: model?.model || (profile?.model !== PROVIDER_CONNECTION_MODEL ? profile?.model : '') || '',
      supportsImages: model ? model.supports_images === 1 : profile?.supportsImages || false,
      generationOptions: model ? JSON.parse(model.options_json) : profile?.generationOptions || {} }];
  }));
  return { providers: data.profiles.map(providerDto), features, credentialReady: data.credentialReady, ready };
}
export async function createAiProvider(db, actor, input, env) {
  await requireActiveAdmin(db, actor);
  await requireFeatureModels(db);
  return providerDto(await createAiProfile(db, actor, connectionPayload(input), env));
}
export async function updateAiProvider(db, actor, id, input, expectedRevision, env) {
  await requireActiveAdmin(db, actor);
  await requireFeatureModels(db);
  const previous = await savedProfile(db, actor, id, env);
  return providerDto(await updateAiProfile(db, actor, id, connectionPayload(input, previous), expectedRevision, env,
    Date.now(), { connectionOnly: true }));
}
export async function deleteAiProvider(db, actor, id, expectedRevision, options) {
  await requireActiveAdmin(db, actor);
  await requireFeatureModels(db);
  return deleteAiProfile(db, actor, id, expectedRevision, Date.now(), options);
}
export async function listAiProviderModels(db, actor, input, env) {
  await requireActiveAdmin(db, actor);
  await requireFeatureModels(db);
  if (!input || Object.keys(input).some(key => !['providerId', 'expectedRevision'].includes(key))) {
    throw new InstanceAdminError('invalid_ai_provider', 400);
  }
  const profile = await savedProfile(db, actor, input.providerId, env);
  // Use the stored original binding, including any historical source metadata.
  return listAiModels(db, actor, { profileId: profile.id, expectedRevision: input.expectedRevision,
    source: profile.source, protocol: profile.protocol, baseUrl: profile.baseUrl }, env);
}
export async function saveAiFeatureModel(db, actorId, input, env, now = Date.now()) {
  const actor = await requireActiveAdmin(db, actorId);
  await requireFeatureModels(db);
  if (!input || !['assistant', 'lyrics'].includes(input.feature)
    || (input.providerId !== null && (typeof input.providerId !== 'string' || !/^[0-9a-f-]{36}$/.test(input.providerId)))) {
    throw new InstanceAdminError('invalid_ai_assignment', 400);
  }
  const { feature, providerId, expectedRevision } = input;
  validateRevision(expectedRevision, { allowZero: true });
  currentTime(now);
  let model = ''; let supportsImages = false; let options = {};
  if (providerId !== null) {
    validateRevision(input.providerRevision);
    if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160
      || /[\r\n\x00]/.test(input.model) || input.model === PROVIDER_CONNECTION_MODEL
      || typeof input.supportsImages !== 'boolean') throw new InstanceAdminError('invalid_ai_feature_model', 400);
    const profile = await savedProfile(db, actorId, providerId, env);
    if (profile.revision !== input.providerRevision) throw new InstanceAdminError('revision_conflict', 409);
    const previous = await db.prepare('SELECT * FROM ai_feature_models WHERE feature = ?').bind(feature).first();
    model = input.model.trim(); supportsImages = input.supportsImages;
    // Retain options only for the same exact binding/model. No hidden inherited
    // generation options are carried to a new model or protocol.
    try {
      options = input.generationOptions !== undefined ? normalizeGenerationOptions(input.generationOptions, profile.protocol)
        : previous?.provider_id === providerId && previous.model === model ? JSON.parse(previous.options_json) : {};
    } catch { throw new InstanceAdminError('invalid_ai_feature_model', 400); }
  }
  const providerGuard = providerId === null ? '' : 'AND EXISTS (SELECT 1 FROM ai_model_profiles WHERE id = ? AND revision = ?)';
  const providerValues = providerId === null ? [] : [providerId, input.providerRevision];
  const [result] = await atomic(db, [expectedRevision === 0
    ? statement(db, `INSERT INTO ai_feature_assignments (feature,profile_id,revision,updated_at,updated_by)
      SELECT ?,?,1,?,? WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
      ${providerGuard} ON CONFLICT(feature) DO NOTHING`, feature, providerId, now, actor.account_id, actor.account_id, ...providerValues)
    : statement(db, `UPDATE ai_feature_assignments SET profile_id = ?,revision = revision + 1,updated_at = ?,updated_by = ?
      WHERE feature = ? AND revision = ? AND EXISTS (SELECT 1 FROM accounts WHERE account_id = ? AND role = 'admin' AND status = 'active')
      ${providerGuard}`, providerId, now, actor.account_id, feature, expectedRevision, actor.account_id, ...providerValues),
  statement(db, `INSERT INTO audit_events (id,actor_account_id,action,target_type,target_id,result,created_at)
    SELECT ?,?,'ai_feature.configure','ai_feature',?,'success',? WHERE changes() = 1`, crypto.randomUUID(), actor.account_id, feature, now),
  providerId === null ? statement(db, 'DELETE FROM ai_feature_models WHERE feature = ? AND changes() = 1', feature)
    : statement(db, `INSERT INTO ai_feature_models (feature,provider_id,model,supports_images,options_json)
      SELECT ?,?,?,?,? WHERE changes() = 1 ON CONFLICT(feature) DO UPDATE SET provider_id = excluded.provider_id,
        model = excluded.model,supports_images = excluded.supports_images,options_json = excluded.options_json`,
    feature, providerId, model, supportsImages ? 1 : 0, JSON.stringify(options)),
  ]);
  if (!changed(result)) throw new InstanceAdminError('revision_conflict', 409);
  return { feature, providerId, model, supportsImages, revision: expectedRevision + 1 };
}
