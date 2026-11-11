import { createPluginOperationLease } from "@flaretune/plugin-sdk/server/service-leases";
import { handleLyricsWorkbenchRoute } from "./workspace.js";
import { getAdminSettings, updateAdminSetting } from "./settings.js";
import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { testLyricSource } from "./sourceTest.js";
import { handleLyricsModelRoute } from './modelRoutes.js';

const memberAction = (path, method) => method === 'GET'
  || method === 'POST' && ['/candidates/inspect', '/ai-completion'].some(suffix => path.endsWith(suffix));
export function createLyricsWorkbenchHandler(env, session, { executionContext, dependencies = {}, registry } = {}) {
  return async ({ request, path, scope, context, json }) => {
    if (scope === 'admin' && ['/model', '/model/models', '/model/initialize'].includes(path)) {
      try { return await handleLyricsModelRoute({ request, path, env, session, context, registry, json }); }
      catch (error) { return json({ error: error?.code || error?.message || 'service_unavailable' }, error?.status || 503); }
    }
    if (scope === 'admin' && ['/settings', '/sources-settings', '/source-test'].includes(path)) {
      await context.requireRoles(['admin']);
      const lease = await createPluginOperationLease({ env, session, pluginId: 'lyrics-workbench', context, registry, admin: true });
      const db = lease.guardedDb(env.DB);
      try {
        let result;
        const key = path === '/sources-settings' ? 'lyrics.sources' : 'lyrics.ai';
        if (path === '/source-test') {
          if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
          const fetchImpl = dependencies.sourceTestDeps?.fetchImpl || fetch;
          result = await (dependencies.testSource || testLyricSource)(db, context.identity.accountId,
            await readBoundedJson(request, 32 * 1024), { ...dependencies.sourceTestDeps, signal: request.signal,
              fetchImpl: async (...args) => { await lease.assertCurrent(); const value = await fetchImpl(...args); await lease.assertCurrent(); return value; } });
        } else if (request.method === 'GET') {
          const overview = await getAdminSettings(db, context.identity.accountId);
          result = { setting: overview.settings[key], ...(path === '/settings' ? { defaults: overview.defaults.lyrics } : {}) };
        } else if (request.method === 'PUT') {
          const body = await readBoundedJson(request, 20 * 1024);
          if (!body || Object.keys(body).some(key => !['value', 'expectedRevision'].includes(key))
            || !Object.hasOwn(body, 'value') || !Object.hasOwn(body, 'expectedRevision')) return json({ error: 'invalid_input' }, 400);
          result = { setting: await updateAdminSetting(db, context.identity.accountId, key, body.value, body.expectedRevision) };
        } else return json({ error: 'method_not_allowed' }, 405);
        await lease.assertCurrent();
        return json(result);
      } catch (error) {
        if (error instanceof InstanceAdminError) return json({ error: error.code }, error.status);
        throw error;
      }
    }
    if (scope !== 'account' || !/^\/(?:sources$|workspace\/[^/]+(?:\/.*)?$)/u.test(path)) return null;
    const roles = memberAction(path, request.method) ? ['admin', 'member'] : ['admin'];
    const lease = await createPluginOperationLease({ env, session, pluginId: 'lyrics-workbench', context,
      registry, admin: roles.length === 1 });
    const db = lease.guardedDb(env.DB);
    // The operation lease binds these exact roles in its SQL predicate.
    let assertScope = lease.assertCurrent;
    const current = () => assertScope();
    const guardedContext = Object.freeze({ ...context, assertCurrent: current });
    const url = new URL(request.url);
    url.pathname = path === '/sources' ? '/api/lyrics/sources' : `/api/lyrics${path}`;
    const response = await handleLyricsWorkbenchRoute(request, url, db, {}, session, env, {
      ...dependencies, context: guardedContext, assertCurrent: current, registry,
      useAiLease: service => { assertScope = service.assertCurrent; },
      ctx: executionContext,
      aiDeps: { ...dependencies.aiDeps, session, consumerContext: guardedContext, registry, signal: request.signal, admin: roles.length === 1 },
    });
    await current();
    return response;
  };
}
