import { readConsumerModel, listConsumerModels, saveConsumerModel, initializeConsumerModel } from '@flaretune/plugin-service/ai-gateway/server/consumer-model.js';
import { readBoundedJson } from '@flaretune/plugin-sdk/server/http-security';
import { createPluginOperationLease } from '@flaretune/plugin-sdk/server/service-leases';

const fields = {
  '/model': ['expectedRevision', 'providerId', 'providerRevision', 'model', 'supportsImages', 'generationOptions'],
  '/model/models': ['providerId', 'expectedRevision'],
  '/model/initialize': ['expectedRevision'],
};
export async function handleAssistantModelRoute({ request, path, env, session, context, registry, json }) {
  if (!Object.hasOwn(fields, path)) return null;
  await context.requireRoles(['admin']);
  const options = { env, session, consumerId: 'assistant', context, registry };
  if (path === '/model' && request.method === 'GET') return json(await readConsumerModel(options));
  if (request.method !== (path === '/model' ? 'PUT' : 'POST')) return json({ error: 'method_not_allowed' }, 405);
  const body = await readBoundedJson(request, 16384);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !fields[path].includes(key))) return json({ error: 'invalid_input' }, 400);
  if (path === '/model/models') return json(await listConsumerModels(options, body));
  if (path === '/model') return json(await saveConsumerModel(options, body));
  if (body.expectedRevision !== 0) return json({ error: 'revision_conflict' }, 409);
  const current = await readConsumerModel(options);
  if (current.revision !== 0) return json(current);
  // No initialization on GET or ordinary AI use. Only the administrator can
  // ask the gateway to import this real consumer's safe legacy configuration.
  const lease = await createPluginOperationLease({ env, session, pluginId: 'assistant', context, registry, admin: true });
  const old = await lease.guardedDb(env.DB).prepare("SELECT provider,model,temperature,revision FROM music_assistant_configs WHERE id='xiaoa'").first();
  await lease.assertCurrent();
  return json(await initializeConsumerModel(options, { expectedRevision: 0,
    legacyConfig: old ? { provider: old.provider, model: old.model, temperature: old.temperature } : null,
    legacyConstraints: [{ table: 'music_assistant_configs', where: { id: 'xiaoa' }, expected: old || null }] }));
}
