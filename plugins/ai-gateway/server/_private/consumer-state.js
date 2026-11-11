import { createPluginServiceLease } from '@flaretune/plugin-sdk/server/service-leases';
import { createSubsonicPluginServiceLease } from '@flaretune/plugin-sdk/server/subsonic-principal';
import { createServiceConfigStore, createServiceConfigGuard, bindServiceConfiguration } from '@flaretune/plugin-sdk/server/service-config';
import { InstanceAdminError } from '@flaretune/plugin-sdk/server/admin-common';
import { effectiveAiBaseUrl, legacyProtocol, normalizeGenerationOptions, sourceFromProvider, validateAiBaseUrl, AI_PROTOCOLS, AI_SOURCES } from '../../shared/aiProtocols.js';
import { readPrivateProfile, profileBinding, resolveProviderSelection } from './profiles.js';

export const failure = (code, status = 409) => { throw new InstanceAdminError(code, status); };
export async function serviceRequest(input, admin = false) {
  const request = { ...input, context: input.context || input.consumerContext,
    principal: input.principal || input.subsonicPrincipal };
  const serviceLease = request.serviceLease || (request.principal
    ? await createSubsonicPluginServiceLease({ ...request, providerId: 'ai-gateway' })
    : await createPluginServiceLease({ ...request, providerId: 'ai-gateway', consumerContext: request.context, admin }));
  // Store construction authenticates provenance, including supplied Web/Subsonic leases.
  const authorized = { ...request, serviceLease };
  const store = await createServiceConfigStore(authorized);
  if (admin && serviceLease.identity.role !== 'admin') failure('forbidden', 403);
  return { request: authorized, lease: serviceLease, store, db: serviceLease.guardedDb(request.env.DB) };
}
export const providerConstraints = row => [{ table: 'ai_model_profiles', where: { id: row.id }, expected: { revision: row.revision } },
  { table: 'ai_profile_protocols', where: { profile_id: row.id }, expected: row.source == null ? null
    : { source: row.source, protocol: row.protocol, options_json: row.options_json } }];
export async function providerSnapshot(db, id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) failure('invalid_ai_provider', 400);
  const row = await readPrivateProfile(db, id);
  if (!row) failure('AI_PROVIDER_MISSING', 404);
  return row;
}
export function normalizeSelection(input, row, previous, { initialize = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160 || /[\r\n\x00]/.test(input.model)
    || input.model === '__provider_connection__' || typeof input.supportsImages !== 'boolean') failure('invalid_ai_feature_model', 400);
  const model = input.model.trim();
  const binding = row ? profileBinding(row) : input.providerBinding;
  const changed = previous && (previous.providerId !== input.providerId || previous.model !== model || previous.providerBinding !== binding);
  let generationOptions;
  try { generationOptions = normalizeGenerationOptions(input.generationOptions === undefined
    ? !changed ? previous?.generationOptions || {} : {} : input.generationOptions, row?.protocol); }
  catch { failure('invalid_ai_feature_model', 400); }
  return { providerId: input.providerId, model, supportsImages: input.supportsImages && (initialize || !changed),
    generationOptions, providerBinding: binding };
}
export async function deploymentSelection(db, legacy) {
  if (!legacy?.provider || !legacy?.model) return { selection: null, constraints: [] };
  const source = legacy.source || sourceFromProvider(legacy.provider);
  const protocol = legacy.protocol || legacyProtocol(legacy.provider);
  if (!Object.hasOwn(AI_SOURCES, source) || !Object.hasOwn(AI_PROTOCOLS, protocol)) failure('AI_CONFIG_INVALID', 503);
  let baseUrl = '';
  const constraints = [];
  if (legacy.provider === 'openai') {
    const row = await db.prepare("SELECT value_json,revision FROM instance_settings WHERE key='ai.compatible_api_url'").first();
    constraints.push({ table: 'instance_settings', where: { key: 'ai.compatible_api_url' }, expected: row ? { value_json: row.value_json, revision: row.revision } : null });
    if (row) { try { baseUrl = JSON.parse(row.value_json); } catch { failure('AI_CONFIG_INVALID', 503); } }
    if (baseUrl) validateAiBaseUrl(baseUrl);
  }
  const generationOptions = { ...(typeof legacy.temperature === 'number' ? { temperature: legacy.temperature } : {}), ...(legacy.generationOptions || {}) };
  return { selection: normalizeSelection({ providerId: null, model: legacy.model, supportsImages: false,
    generationOptions, providerBinding: JSON.stringify([source, protocol, baseUrl]) }, null, null, { initialize: true }), constraints };
}
export async function resolveSavedConfiguration(input) {
  const state = await serviceRequest(input);
  const saved = await state.store.read(input.configuration?.slot || 'ai-model');
  if (!saved.value) failure('PLUGIN_UPDATE_REQUIRED');
  if (saved.value.schemaVersion !== 1) failure('AI_CONFIG_INVALID', 503);
  const selection = saved.value.selection;
  if (!selection) failure('AI_PROVIDER_UNCONFIGURED', 503);
  let resolved, constraints;
  if (selection.providerId !== null) {
    resolved = await resolveProviderSelection(state.db, selection, input.env);
    constraints = providerConstraints(resolved.row);
  } else {
    let source, protocol, baseUrl;
    try { [source, protocol, baseUrl] = JSON.parse(selection.providerBinding); }
    catch { failure('AI_CONFIG_INVALID', 503); }
    if (!Object.hasOwn(AI_SOURCES, source) || !Object.hasOwn(AI_PROTOCOLS, protocol)) failure('AI_CONFIG_INVALID', 503);
    const provider = source === 'custom' ? 'openai' : source;
    const row = provider === 'openai' ? await state.db.prepare("SELECT value_json,revision FROM instance_settings WHERE key='ai.compatible_api_url'").first() : null;
    let currentBase = '';
    try { if (row) currentBase = JSON.parse(row.value_json); } catch { failure('AI_CONFIG_INVALID', 503); }
    if (currentBase) validateAiBaseUrl(currentBase);
    if (provider === 'openai' && baseUrl !== currentBase) failure('AI_CONFIG_INVALID', 503);
    constraints = provider === 'openai' ? [{ table: 'instance_settings', where: { key: 'ai.compatible_api_url' }, expected: row ? { value_json: row.value_json, revision: row.revision } : null }] : [];
    resolved = { config: { provider, source, protocol, model: selection.model, supportsImages: false,
      generationOptions: normalizeGenerationOptions(selection.generationOptions, protocol), providerBinding: selection.providerBinding, exactModel: true },
      env: baseUrl ? { ...input.env, OPENAI_BASE_URL: baseUrl } : input.env };
  }
  const guard = createServiceConfigGuard(state.request, { constraints });
  const authority = bindServiceConfiguration(state.request, { slot: input.configuration?.slot || 'ai-model', revision: saved.revision, guard });
  // The public client asserts this bound authority immediately after return;
  // avoid a duplicate D1 call with no intervening I/O or user-controlled work.
  return { config: { ...resolved.config, temperature: resolved.config.generationOptions?.temperature ?? 0.2, configurationRevision: saved.revision, featureRevision: saved.revision },
    env: resolved.env, authority };
}
