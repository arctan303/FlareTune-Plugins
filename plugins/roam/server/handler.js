import { readBoundedJson, RequestBodyError } from "@flaretune/plugin-sdk/server/http-security";
import { createRoamCatalog } from "./catalog.js";
import { RoamInputError, sampleRoam } from "./sample.js";

export function createRoamHandler(env, session, { executionContext, catalog = createRoamCatalog(env.DB, { executionContext }) } = {}) {
  return async ({ request, path, scope, context, json }) => {
    if (scope !== 'account' || path !== '/sample' || request.method !== 'POST') return null;
    await context.requireRoles(['admin', 'member']);
    let data;
    try { data = await sampleRoam(await readBoundedJson(request, 1024 * 1024), catalog); }
    catch (error) {
      if (error instanceof RequestBodyError || error instanceof RoamInputError) return json({ code: 400, error: 'invalid_input', message: 'Invalid roam parameters' }, 400);
      throw error;
    }
    // A request which completed after logout/uninstall/reinstall cannot return
    // a batch under its earlier installation epoch.
    await context.requireRoles(['admin', 'member']);
    return json({ code: 200, data });
  };
}
