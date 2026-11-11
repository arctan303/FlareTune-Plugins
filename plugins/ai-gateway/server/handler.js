import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { createServiceResourceDeletionStore, listServiceResourceUses } from "@flaretune/plugin-sdk/server/service-config";
import { pluginRegistry } from "@flaretune/plugin-sdk/server/plugin-registry";
import { createPluginOperationLease } from "@flaretune/plugin-sdk/server/service-leases";
import { updateAdminSetting } from "./settings.js";
import { listAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, listAiProviderModels, saveAiFeatureModel } from "./aiProviders.js";
import { listAiProfiles, createAiProfile, updateAiProfile, deleteAiProfile, listAiModels, assignAiProfile } from "./aiProfiles.js";

export function createAiGatewayHandler(env, session, { registry = pluginRegistry } = {}) {
  return async function handleAiGateway({ request, path, scope, context, json }) {
    if (scope !== 'admin') return json({ error: 'forbidden' }, 403);
    await context.requireRoles(['admin']);
    const lease = await createPluginOperationLease({ env, session, pluginId: 'ai-gateway', context, registry, admin: true });
    const db = lease.guardedDb(env.DB), actor = session.account.accountId;
    const respond = async (value, status) => { await lease.assertCurrent(); return json(value, status); };
    async function removeProvider(id, revision, remove) {
      const providerRequest = { env, session, context, providerId: 'ai-gateway', resourceId: id, registry };
      const uses = await listServiceResourceUses(providerRequest);
      // Only the compatibility adapter enumerates old built-in consumers. Modern
      // declarations and all third-party usage come exclusively from the host index.
      const legacyMap = { assistant: 'assistant', 'lyrics-workbench': 'lyrics' };
      const legacyConsumers = [];
      for (const manifest of registry.manifests) {
        const feature = legacyMap[manifest.id];
        if (!feature || manifest.serviceConfigurations?.['ai-gateway']?.includes('ai-model')) continue;
        legacyConsumers.push({ feature, consumerId: manifest.id });
        const installed = await registry.readInstallation(env, manifest.id);
        if (!installed.installed) continue;
        if (await db.prepare('SELECT feature FROM ai_feature_assignments WHERE profile_id=? AND feature=?').bind(id, feature).first()) {
          uses.push({ consumerId: manifest.id, name: manifest.name, slot: 'legacy', revision: 0 });
        }
      }
      if (uses.length) return json({ error: 'ai_profile_in_use', uses }, 409);
      const deletion = await createServiceResourceDeletionStore(providerRequest);
      try {
        const result = await remove(deletion, revision, { legacyConsumers });
        await lease.assertCurrent(); return json(result);
      } catch (error) {
        // A configuration can begin using this connection after the preflight.
        // The transactional guard rejects it; re-read names for a useful result.
        const currentUses = await listServiceResourceUses(providerRequest);
        for (const legacy of legacyConsumers) {
          const installed = await registry.readInstallation(env, legacy.consumerId);
          if (installed.installed && await db.prepare('SELECT feature FROM ai_feature_assignments WHERE profile_id=? AND feature=?').bind(id, legacy.feature).first()) {
            currentUses.push({ consumerId: legacy.consumerId, name: registry.manifests.find(item => item.id === legacy.consumerId).name, slot: 'legacy', revision: 0 });
          }
        }
        if (currentUses.length) return json({ error: 'ai_profile_in_use', uses: currentUses }, 409);
        if (/malformed JSON|service_configuration_changed|ai_profile_delete_conflict/i.test(error?.message || '')) return json({ error: 'revision_conflict' }, 409);
        throw error;
      }
    }
    try {
      const body = () => readBoundedJson(request);
      if (path === '/legacy-setting' && request.method === 'PUT') {
        const data = await body();
        if (!data || typeof data !== 'object' || Array.isArray(data)
          || Object.keys(data).some(key => !['key', 'value', 'expectedRevision'].includes(key))
          || (data.key !== undefined && data.key !== 'ai.compatible_api_url')) return json({ error: 'invalid_input' }, 400);
        return respond(await updateAdminSetting(db, actor, 'ai.compatible_api_url', data.value, data.expectedRevision));
      }
      if (path === '/providers') {
        if (request.method === 'GET') return respond(await listAiProviders(db, actor, env));
        if (request.method === 'POST') return respond(await createAiProvider(db, actor, await body(), env), 201);
      }
      if (path === '/provider-models' && request.method === 'POST') return respond(await listAiProviderModels(db, actor, await body(), env));
      if (path === '/feature-models' && request.method === 'PUT') return respond(await saveAiFeatureModel(db, actor, await body(), env));
      const providerId = /^\/providers\/([0-9a-f-]{36})$/.exec(path)?.[1];
      if (providerId && ['PUT', 'DELETE'].includes(request.method)) {
        const data = await body();
        if (request.method === 'DELETE') return await removeProvider(providerId, data.expectedRevision, (store, revision, options) => deleteAiProvider(store, actor, providerId, revision, options));
        return respond(await updateAiProvider(db, actor, providerId, data.provider, data.expectedRevision, env));
      }
      if (path === '/profiles') {
        if (request.method === 'GET') return respond(await listAiProfiles(db, actor, env));
        if (request.method === 'POST') return respond(await createAiProfile(db, actor, await body(), env), 201);
      }
      if (path === '/models' && request.method === 'POST') return respond(await listAiModels(db, actor, await body(), env));
      if (path === '/assignments' && request.method === 'PUT') {
        const data = await body();
        return respond(await assignAiProfile(db, actor, data.feature, data.profileId, data.expectedRevision));
      }
      const profileId = /^\/profiles\/([0-9a-f-]{36})$/.exec(path)?.[1];
      if (profileId && ['PUT', 'DELETE'].includes(request.method)) {
        const data = await body();
        if (request.method === 'DELETE') return await removeProvider(profileId, data.expectedRevision, (store, revision, options) => deleteAiProfile(store, actor, profileId, revision, Date.now(), options));
        return respond(await updateAiProfile(db, actor, profileId, data.profile, data.expectedRevision, env));
      }
      return null;
    } catch (error) {
      if (error instanceof InstanceAdminError) return json({ error: error.code }, error.status);
      throw error;
    }
  };
}
