import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

class AdminError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
async function fixture(t, { consumerId = 'assistant', legacy = true } = {}) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE accounts(account_id TEXT PRIMARY KEY,role TEXT,status TEXT);
    INSERT INTO accounts VALUES('admin','admin','active');
    CREATE TABLE instance_settings(key TEXT PRIMARY KEY,value_json TEXT,revision INTEGER,updated_at INTEGER,updated_by TEXT);
    CREATE TABLE ai_model_profiles(id TEXT PRIMARY KEY,name TEXT,provider TEXT,model TEXT,base_url TEXT,encrypted_key TEXT,key_iv TEXT,revision INTEGER,created_at INTEGER,updated_at INTEGER,updated_by TEXT);
    CREATE TABLE ai_profile_protocols(profile_id TEXT PRIMARY KEY,source TEXT,protocol TEXT,options_json TEXT);
    CREATE TABLE ai_feature_assignments(feature TEXT PRIMARY KEY,profile_id TEXT,revision INTEGER,updated_at INTEGER,updated_by TEXT);
    CREATE TABLE ai_feature_models(feature TEXT PRIMARY KEY,provider_id TEXT,model TEXT,supports_images INTEGER,options_json TEXT);
    CREATE TABLE audit_events(id TEXT,actor_account_id TEXT,action TEXT,target_type TEXT,target_id TEXT,result TEXT,created_at INTEGER);`);
  const id = '11111111-1111-1111-1111-111111111111', secondId = '22222222-2222-2222-2222-222222222222';
  const env = { SETUP_SECRET: 'synthetic fixture setup secret long enough' };
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('FlareTune instance secret separation v2'), info: new TextEncoder().encode('ai_model_profiles AES-GCM key v2') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode('synthetic-private-upstream-key'));
  for (const providerId of [id, secondId]) {
    sqlite.prepare('INSERT INTO ai_model_profiles VALUES(?,?,?,?,?,?,?,1,1,1,?)').run(providerId, 'Saved provider', 'deepseek', '__provider_connection__', '', Buffer.from(encrypted).toString('base64url'), Buffer.from(iv).toString('base64url'), 'admin');
    sqlite.prepare('INSERT INTO ai_profile_protocols VALUES(?,?,?,?)').run(providerId, 'deepseek', 'chat_completions', '{}');
  }
  if (legacy) {
    sqlite.prepare('INSERT INTO ai_feature_assignments VALUES(?,?,7,1,?)').run('assistant', id, 'admin');
    sqlite.prepare('INSERT INTO ai_feature_models VALUES(?,?,?,1,?)').run('assistant', id, 'retained-model', '{"maxOutputTokens":2048}');
  }
  const wrap = sql => { const stmt = sqlite.prepare(sql); let values = [];
    const result = { bind(...input) { values = input; return result; }, first: async column => { const row = stmt.get(...values) || null; return column ? row?.[column] ?? null : row; },
      all: async () => ({ results: stmt.all(...values) }), run: async () => ({ meta: { changes: Number(stmt.run(...values).changes) } }) }; return result; };
  const db = { prepare: wrap, async batch(statements) { sqlite.exec('BEGIN'); try { const values = []; for (const statement of statements) values.push(await statement.run()); sqlite.exec('COMMIT'); return values; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  env.DB = db;
  const state = { value: null, revision: 0, role: 'admin', current: true, beforeCommit: null };
  const lease = { identity: { accountId: 'admin', role: 'admin' }, consumer: { id: consumerId, epoch: 'consumer' }, provider: { id: 'ai-gateway', epoch: 'gateway' },
    assertCurrent: async () => { if (!state.current) throw new AdminError('PLUGIN_SERVICE_RETIRED', 409); }, guardedDb: () => db };
  const check = constraints => { for (const constraint of constraints) {
    const where = Object.entries(constraint.where), row = sqlite.prepare(`SELECT * FROM ${constraint.table} WHERE ${where.map(([column]) => `${column} IS ?`).join(' AND ')}`).get(...where.map(([, value]) => value));
    if (constraint.expected === null ? Boolean(row) : !row || Object.entries(constraint.expected).some(([column, value]) => row[column] !== value)) throw new AdminError('PLUGIN_SERVICE_CONFIGURATION_CHANGED', 409);
  } };
  const store = { read: async () => ({ value: state.value === null ? null : structuredClone(state.value), revision: state.revision }),
    prepare: async data => { if (state.role !== 'admin') throw new AdminError('forbidden', 403); return data; } };
  const configSdk = { createServiceConfigStore: async () => store, createServiceConfigGuard: (_request, { constraints }) => ({ constraints }),
    commitServiceConfiguration: async (_request, { mutation, guard, resourceId }) => { state.beforeCommit?.(); check(guard.constraints); if (mutation.expectedRevision !== state.revision) throw new AdminError('PLUGIN_DATA_REVISION_MISMATCH', 409); state.value = structuredClone(mutation.value); state.revision++; state.resourceId = resourceId; },
    bindServiceConfiguration: (_request, { revision, guard }) => ({ guardedDb: () => db, assertCurrent: async () => { await lease.assertCurrent(); check(guard.constraints); if (revision !== state.revision) throw new AdminError('PLUGIN_SERVICE_CONFIGURATION_CHANGED', 409); } }) };
  const modules = {
    '@flaretune/plugin-sdk/server/service-config': configSdk,
    '@flaretune/plugin-sdk/server/service-leases': { createPluginServiceLease: async () => { lease.identity.role = state.role; return lease; }, isPluginServiceLeaseForSession: input => input === lease },
    '@flaretune/plugin-sdk/server/subsonic-principal': { createSubsonicPluginServiceLease: async () => lease },
    '@flaretune/plugin-sdk/server/plugin-common': { pluginFail: (code, status) => { throw new AdminError(code, status); } },
    '@flaretune/plugin-sdk/server/admin-common': { InstanceAdminError: AdminError, requireActiveAdmin: async (_db, actor) => ({ account_id: actor }),
      atomic: (base, statements) => base.batch(statements), statement: (base, sql, ...values) => base.prepare(sql).bind(...values), changed: result => result?.meta?.changes === 1,
      validateRevision: value => { if (!Number.isSafeInteger(value) || value < 1) throw new AdminError('invalid_revision'); }, currentTime() {} },
  };
  const globals = { fetch: (...args) => state.fetch(...args), Response, AbortSignal, TextEncoder, TextDecoder, crypto, btoa, atob, URL, AbortController, DOMException, setTimeout, clearTimeout, setInterval, clearInterval, Date, structuredClone };
  const load = file => createBackgroundModuleHarness({ file: new URL(file, import.meta.url), modules, globals }).exports;
  return { id, secondId, sqlite, db, env, state, lease, load, api: load('./consumer-model.js'),
    request: { env, session: { account: { accountId: 'admin', role: 'admin' } }, consumerId, serviceLease: lease } };
}

test('controlled import preserves model, vision and parameters and never overwrites saved state', async t => {
  const f = await fixture(t);
  const before = f.sqlite.prepare('SELECT * FROM ai_feature_models').get();
  let data = await f.api.initializeConsumerModel(f.request, { expectedRevision: 0, legacyConfig: { provider: 'deepseek', model: 'fallback', temperature: 1.1 } });
  assert.equal(data.value.selection.providerId, f.id); assert.equal(data.value.selection.model, 'retained-model');
  assert.equal(data.value.selection.supportsImages, true); assert.equal(data.value.selection.generationOptions.temperature, 1.1);
  assert.equal(data.value.selection.generationOptions.maxOutputTokens, 2048);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM ai_feature_models').get(), before);
  data = await f.api.initializeConsumerModel(f.request, { expectedRevision: 0, legacyConfig: { provider: 'openai', model: 'different' } });
  assert.equal(data.revision, 1); assert.equal(data.value.selection.model, 'retained-model');
  assert.doesNotMatch(JSON.stringify(data), /synthetic-private-upstream-key|encrypted_key|key_iv|SETUP_SECRET/);
});

test('source CAS aborts an import when an old feature is changed during handoff', async t => {
  const f = await fixture(t);
  f.state.beforeCommit = () => f.sqlite.prepare('UPDATE ai_feature_assignments SET revision=revision+1').run();
  await assert.rejects(f.api.initializeConsumerModel(f.request, { expectedRevision: 0 }), /PLUGIN_SERVICE_CONFIGURATION_CHANGED/);
  assert.equal(f.state.revision, 0); assert.equal(f.state.value, null);
});

test('save is owner-CAS checked and switching providers/models clears vision', async t => {
  const f = await fixture(t);
  await f.api.initializeConsumerModel(f.request, { expectedRevision: 0 });
  const saved = await f.api.saveConsumerModel(f.request, { expectedRevision: 1, providerId: f.secondId, providerRevision: 1, model: 'new-model', supportsImages: true });
  assert.equal(saved.value.selection.supportsImages, false); assert.deepEqual(JSON.parse(JSON.stringify(saved.value.selection.generationOptions)), {});
  await assert.rejects(f.api.saveConsumerModel(f.request, { expectedRevision: 1, providerId: f.id, providerRevision: 1, model: 'stale', supportsImages: false }), /REVISION_MISMATCH/);
  assert.equal(f.state.value.selection.model, 'new-model');
});

test('third-party declarations use the same services without a gateway consumer registry', async t => {
  const f = await fixture(t, { consumerId: 'third-party-ai', legacy: false });
  let saved = await f.api.initializeConsumerModel(f.request, { expectedRevision: 0 });
  assert.equal(saved.value.selection, null); assert.equal(saved.configured, false);
  saved = await f.api.saveConsumerModel(f.request, { expectedRevision: 1, providerId: f.id, providerRevision: 1, model: 'external-model', supportsImages: false });
  assert.equal(saved.value.selection.model, 'external-model'); assert.equal(f.state.resourceId, f.id);
});

test('deployment mode retains its explicit provider and temperature and can edit its model', async t => {
  const f = await fixture(t, { legacy: false });
  await f.api.initializeConsumerModel(f.request, { expectedRevision: 0, legacyConfig: { provider: 'openai', model: 'legacy-model', temperature: 0.8 } });
  const saved = await f.api.saveConsumerModel(f.request, { expectedRevision: 1, providerId: null, model: 'legacy-next', supportsImages: false });
  assert.equal(saved.value.selection.providerId, null); assert.equal(saved.value.selection.model, 'legacy-next');
  assert.match(saved.value.selection.providerBinding, /openai/);
});

test('configuration clients hide credentials and reject late results after owner revision changes', async t => {
  const f = await fixture(t);
  await f.api.initializeConsumerModel(f.request, { expectedRevision: 0 });
  const clientApi = f.load('./client.js'); let privateKey;
  const client = await clientApi.createAiGatewayClient({ ...f.request, configuration: { slot: 'ai-model' } }, { pollIntervalMs: 0,
    ask: async (_messages, _config, env) => { privateKey = env.AI_PROFILE_API_KEY; return 'authorized'; } });
  assert.equal(await client.ask([], {}), 'authorized'); assert.equal(privateKey, undefined);
  assert.doesNotMatch(JSON.stringify(client), /synthetic-private-upstream-key|encrypted_key|key_iv|SETUP_SECRET/);
  f.state.revision++;
  await assert.rejects(client.ask([], {}), /PLUGIN_SERVICE_CONFIGURATION_CHANGED/);
});

test('missing consumer configuration is an update error and members cannot manage models', async t => {
  const f = await fixture(t);
  const clientApi = f.load('./client.js');
  await assert.rejects(clientApi.createAiGatewayClient({ ...f.request, configuration: { slot: 'ai-model' } }), /PLUGIN_UPDATE_REQUIRED/);
  f.state.role = 'member'; f.lease.identity.role = 'member';
  await assert.rejects(f.api.readConsumerModel(f.request), /forbidden/);
});

test('safe legacy compatibility exports never return a decrypted environment', async t => {
  const f = await fixture(t);
  const profiles = f.load('./aiProfiles.js');
  const result = await profiles.resolveAiFeature(f.db, 'assistant', f.env, { provider: 'deepseek', model: 'fallback', apiKey: 'caller-private-value' });
  assert.equal(result.config.model, 'retained-model'); assert.equal(result.env, undefined);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-upstream-key|caller-private-value|apiKey|env|encrypted/);
});

test('supplier delete cleans obsolete references only in a successful CAS batch', async t => {
  const f = await fixture(t), profiles = f.load('./aiProfiles.js');
  await assert.rejects(profiles.deleteAiProfile(f.db, 'admin', f.id, 99, 1, { legacyConsumers: [] }));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_feature_models').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_model_profiles WHERE id=?').get(f.id).n, 1);
  await profiles.deleteAiProfile(f.db, 'admin', f.id, 1, 1, { legacyConsumers: [] });
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_feature_models').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_feature_assignments').get().n, 0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_model_profiles WHERE id=?').get(f.id).n, 0);
});

test('an installed API1 consumer blocks supplier deletion inside the batch', async t => {
  const f = await fixture(t), profiles = f.load('./aiProfiles.js');
  f.sqlite.prepare('INSERT INTO instance_settings VALUES(?,?,1,1,?)').run('plugin.installation.assistant', '{"installed":true}', 'admin');
  await assert.rejects(profiles.deleteAiProfile(f.db, 'admin', f.id, 1, 1, { legacyConsumers: [{ consumerId: 'assistant', feature: 'assistant' }] }));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_feature_models').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM ai_model_profiles WHERE id=?').get(f.id).n, 1);
});

test('connection changes invalidate saved vision and options without rewriting consumer state', async t => {
  const f = await fixture(t);
  await f.api.initializeConsumerModel(f.request, { expectedRevision: 0 });
  f.sqlite.prepare("UPDATE ai_model_profiles SET base_url='https://other.example/v1',revision=revision+1 WHERE id=?").run(f.id);
  const client = await f.load('./client.js').createAiGatewayClient({ ...f.request, configuration: { slot: 'ai-model' } }, { pollIntervalMs: 0 });
  assert.equal(client.config.supportsImages, false);
  assert.deepEqual(JSON.parse(JSON.stringify(client.config.generationOptions)), {});
  assert.equal(f.state.value.selection.supportsImages, true);
});

test('only the gateway transport receives the saved key when making a real adapter request', async t => {
  const f = await fixture(t); let received;
  await f.api.initializeConsumerModel(f.request, { expectedRevision: 0 });
  f.state.fetch = async (url, options) => { received = { url, options }; return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'from adapter' } }] }), { status: 200 }); };
  const client = await f.load('./client.js').createAiGatewayClient({ ...f.request, configuration: { slot: 'ai-model' } }, { pollIntervalMs: 0 });
  assert.equal(await client.ask([{ role: 'user', content: 'hello' }], {}), 'from adapter');
  assert.equal(received.options.headers.Authorization, 'Bearer synthetic-private-upstream-key');
  assert.equal(received.options.redirect, 'manual');
  assert.equal(JSON.parse(received.options.body).model, 'retained-model');
  assert.doesNotMatch(JSON.stringify(client), /synthetic-private-upstream-key/);
});
