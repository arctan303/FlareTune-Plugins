import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { createPluginOperationLease } from "@flaretune/plugin-sdk/server/service-leases";
import { updateAdminSetting } from "./settings.js";
import { listAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, listAiProviderModels, saveAiFeatureModel } from "./aiProviders.js";
import { listAiProfiles, createAiProfile, updateAiProfile, deleteAiProfile, listAiModels, assignAiProfile } from "./aiProfiles.js";

export function createAiGatewayHandler(env, session, { registry } = {}) {
  return async function handleAiGateway({ request, path, scope, context, json }) {
    if (scope !== 'admin') return json({ error: 'forbidden' }, 403);
    await context.requireRoles(['admin']);
    const lease = await createPluginOperationLease({ env, session, pluginId: 'ai-gateway', context, registry, admin: true });
    const db = lease.guardedDb(env.DB), actor = session.account.accountId;
    const respond = async (value, status) => { await lease.assertCurrent(); return json(value, status); };
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
        return respond(request.method === 'PUT'
          ? await updateAiProvider(db, actor, providerId, data.provider, data.expectedRevision, env)
          : await deleteAiProvider(db, actor, providerId, data.expectedRevision));
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
        return respond(request.method === 'PUT'
          ? await updateAiProfile(db, actor, profileId, data.profile, data.expectedRevision, env)
          : await deleteAiProfile(db, actor, profileId, data.expectedRevision));
      }
      return null;
    } catch (error) {
      if (error instanceof InstanceAdminError) return json({ error: error.code }, error.status);
      throw error;
    }
  };
}
