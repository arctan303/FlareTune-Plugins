import { createServiceConfigGuard, commitServiceConfiguration } from '@flaretune/plugin-sdk/server/service-config';
import { listAiProfiles, listAiModels, readPrivateProfile, profileBinding, featureModelsReady } from './_private/profiles.js';
import { serviceRequest, providerSnapshot, providerConstraints, normalizeSelection, deploymentSelection, failure } from './_private/consumer-state.js';

const legacyFeatures = Object.freeze({ assistant: 'assistant', 'lyrics-workbench': 'lyrics' });
async function overview(state) {
  const [saved, data] = await Promise.all([state.store.read(), listAiProfiles(state.db, state.lease.identity.accountId, state.request.env)]);
  await state.lease.assertCurrent();
  const providers = data.profiles.map(profile => ({ id: profile.id, name: profile.name, source: profile.source,
    revision: profile.revision, protocol: profile.protocol, hasKey: profile.hasKey,
    providerBinding: profileBinding({ ...profile, base_url: profile.baseUrl }) }));
  const selection = saved.value?.selection;
  const provider = providers.find(item => item.id === selection?.providerId);
  const changedBinding = selection?.providerId && provider && selection.providerBinding !== provider.providerBinding;
  const value = changedBinding ? { ...saved.value, selection: { ...selection, supportsImages: false, generationOptions: {} } } : saved.value;
  return { ...saved, value, providers, updateRequired: saved.value === null,
    configured: Boolean(selection?.model && (selection.providerId === null || provider)) };
}
export async function readConsumerModel(request) { return overview(await serviceRequest(request, true)); }
export async function listConsumerModels(request, input) {
  const state = await serviceRequest(request, true);
  if (!input || Object.keys(input).some(key => !['providerId', 'expectedRevision'].includes(key))) failure('invalid_ai_provider', 400);
  const profile = await providerSnapshot(state.db, input.providerId);
  if (profile.revision !== input.expectedRevision) failure('revision_conflict');
  const result = await listAiModels(state.db, state.lease.identity.accountId, { profileId: profile.id,
    expectedRevision: profile.revision, source: profile.source, provider: profile.provider, protocol: profile.protocol,
    baseUrl: profile.base_url }, state.request.env);
  // A fresh provider read after upstream I/O prevents a late list from becoming current.
  const current = await providerSnapshot(state.db, input.providerId);
  if (current.revision !== profile.revision || profileBinding(current) !== profileBinding(profile)) failure('revision_conflict');
  await state.lease.assertCurrent(); return result;
}
export async function saveConsumerModel(request, input) {
  const state = await serviceRequest(request, true);
  if (!input || Object.keys(input).some(key => !['expectedRevision', 'providerId', 'providerRevision', 'model', 'supportsImages', 'generationOptions'].includes(key))) failure('invalid_ai_feature_model', 400);
  const previous = await state.store.read();
  if (!previous.value) failure('PLUGIN_UPDATE_REQUIRED');
  let selection = null, constraints = [];
  if (input.providerId !== null) {
    const row = await providerSnapshot(state.db, input.providerId);
    if (row.revision !== input.providerRevision) failure('revision_conflict');
    selection = normalizeSelection(input, row, previous.value.selection);
    constraints = providerConstraints(row);
  } else {
    const prior = previous.value.selection?.providerId === null ? previous.value.selection : previous.value.migration?.deployment;
    if (!prior || prior.providerId !== null) failure('AI_PROVIDER_UNCONFIGURED', 409);
    selection = normalizeSelection({ ...input, providerBinding: prior.providerBinding }, null, prior);
    let source, protocol, baseUrl;
    try { [source, protocol, baseUrl] = JSON.parse(prior.providerBinding); } catch { failure('AI_CONFIG_INVALID', 503); }
    const deployment = await deploymentSelection(state.db, { provider: source === 'custom' ? 'openai' : source, source, protocol, model: input.model });
    if (deployment.selection?.providerBinding !== prior.providerBinding) failure('revision_conflict');
    constraints = deployment.constraints;
  }
  const mutation = await state.store.prepare({ value: { ...previous.value, schemaVersion: 1, selection }, expectedRevision: input.expectedRevision });
  const guard = createServiceConfigGuard(state.request, { constraints });
  await commitServiceConfiguration(state.request, { mutation, guard, resourceId: selection?.providerId || null });
  return overview(state);
}
export async function initializeConsumerModel(request, input = {}) {
  const state = await serviceRequest(request, true);
  const existing = await state.store.read();
  if (existing.revision !== 0) return overview(state);
  if (input.expectedRevision !== 0 || Object.keys(input).some(key => !['expectedRevision', 'legacyConfig', 'legacyConstraints'].includes(key))) failure('invalid_ai_feature_model', 400);
  const feature = legacyFeatures[state.request.consumerId];
  if (input.legacyConstraints !== undefined && !Array.isArray(input.legacyConstraints)) failure('invalid_ai_feature_model', 400);
  let selection, constraints = [...(input.legacyConstraints || [])], sourceRevision = 0;
  if (feature) {
    if (!await featureModelsReady(state.db)) failure('ai_provider_migration_required', 503);
    const assignment = await state.db.prepare('SELECT profile_id,revision FROM ai_feature_assignments WHERE feature=?').bind(feature).first();
    const model = await state.db.prepare('SELECT provider_id,model,supports_images,options_json FROM ai_feature_models WHERE feature=?').bind(feature).first();
    constraints.push({ table: 'ai_feature_assignments', where: { feature }, expected: assignment ? { profile_id: assignment.profile_id, revision: assignment.revision } : null },
      { table: 'ai_feature_models', where: { feature }, expected: model ? { provider_id: model.provider_id, model: model.model, supports_images: model.supports_images, options_json: model.options_json } : null });
    sourceRevision = assignment?.revision || 0;
    if (assignment?.profile_id) {
      const row = await readPrivateProfile(state.db, assignment.profile_id);
      if (!row) failure('AI_PROVIDER_MISSING', 503);
      constraints.push(...providerConstraints(row));
      const useModel = model?.provider_id === row.id ? model : null;
      const vision = useModel ? null : await state.db.prepare('SELECT value_json,revision FROM instance_settings WHERE key=?').bind(`ai.images.${row.id}`).first();
      if (!useModel) constraints.push({ table: 'instance_settings', where: { key: `ai.images.${row.id}` }, expected: vision ? { value_json: vision.value_json, revision: vision.revision } : null });
      let options;
      try { options = JSON.parse(useModel?.options_json || row.options_json || '{}'); } catch { failure('AI_CONFIG_INVALID', 503); }
      selection = normalizeSelection({ providerId: row.id, model: useModel?.model || row.model,
        supportsImages: useModel ? useModel.supports_images === 1 : vision?.value_json === 'true',
        generationOptions: { ...(typeof input.legacyConfig?.temperature === 'number' ? { temperature: input.legacyConfig.temperature } : {}), ...options } }, row, null, { initialize: true });
    }
  }
  const deployment = await deploymentSelection(state.db, input.legacyConfig);
  constraints.push(...deployment.constraints);
  if (!selection) selection = deployment.selection;
  const value = { schemaVersion: 1, selection, migration: { source: feature ? 'legacy-feature' : 'consumer', sourceRevision, deployment: deployment.selection } };
  const mutation = await state.store.prepare({ value, expectedRevision: 0 });
  const guard = createServiceConfigGuard(state.request, { constraints });
  try { await commitServiceConfiguration(state.request, { mutation, guard, resourceId: selection?.providerId || null }); }
  catch (error) {
    // Another initialize/save can win; never overwrite its value on a retry.
    if ((await state.store.read()).revision === 0) throw error;
  }
  return overview(state);
}
