import { readConsumerModel, listConsumerModels, saveConsumerModel, initializeConsumerModel } from '@flaretune/plugin-service/ai-gateway/server/consumer-model.js';
import { readBoundedJson } from '@flaretune/plugin-sdk/server/http-security';
import { createPluginOperationLease } from '@flaretune/plugin-sdk/server/service-leases';
import { normalizeLyricAiConfig } from './policy.js';

const fields = {
  '/model': ['expectedRevision', 'providerId', 'providerRevision', 'model', 'supportsImages', 'generationOptions'],
  '/model/models': ['providerId', 'expectedRevision'],
  '/model/initialize': ['expectedRevision'],
};
export async function handleLyricsModelRoute({ request, path, env, session, context, registry, json }) {
  if (!Object.hasOwn(fields, path)) return null;
  await context.requireRoles(['admin']);
  const options = { env, session, consumerId: 'lyrics-workbench', context, registry };
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
  const lease = await createPluginOperationLease({ env, session, pluginId: 'lyrics-workbench', context, registry, admin: true });
  const db = lease.guardedDb(env.DB);
  const stored = await db.prepare("SELECT value_json,revision FROM instance_settings WHERE key='lyrics.ai'").first();
  const legacyConstraints = [{ table: 'instance_settings', where: { key: 'lyrics.ai' }, expected: stored || null }];
  let old;
  if (stored) old = normalizeLyricAiConfig(JSON.parse(stored.value_json));
  else {
    old = await db.prepare("SELECT provider,model,temperature FROM AI_Assistants WHERE id='lyric_translator'").first();
    legacyConstraints.push({ table: 'AI_Assistants', where: { id: 'lyric_translator' }, expected: old || null });
  }
  await lease.assertCurrent();
  return json(await initializeConsumerModel(options, { expectedRevision: 0,
    legacyConfig: old ? { provider: old.provider, model: old.model, temperature: old.temperature } : null,
    legacyConstraints }));
}
