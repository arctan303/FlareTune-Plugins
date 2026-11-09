import { createPluginServiceLease, isPluginServiceLease } from "@flaretune/plugin-sdk/server/service-leases";
import { pluginFail } from "@flaretune/plugin-sdk/server/plugin-common";
import { resolveAiFeature } from "./aiProfiles.js";
import { askAI, chatAI, resolveAIConfig } from "./ai.js";
import { aiConnection } from "./aiTransport.js";
import { effectiveAiBaseUrl, sourceFromProvider, legacyProtocol, validateAiBaseUrl } from "../shared/aiProtocols.js";

const features = Object.freeze({ assistant: 'assistant', 'lyrics-workbench': 'lyrics' });
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const clone = value => JSON.parse(JSON.stringify(value));

async function legacyEnvironment(db, config, env) {
  if (config.provider !== 'openai') return env;
  const row = await db.prepare("SELECT value_json FROM instance_settings WHERE key='ai.compatible_api_url'").first();
  if (!row) return env;
  let baseUrl;
  try { baseUrl = JSON.parse(row.value_json); } catch { throw new Error('AI_CONFIG_INVALID'); }
  if (baseUrl === '') return env;
  if (typeof baseUrl !== 'string' || baseUrl.length > 2048) throw new Error('AI_CONFIG_INVALID');
  validateAiBaseUrl(baseUrl);
  return { ...env, OPENAI_BASE_URL: baseUrl };
}

// No consumer receives the credentials-bearing resolved env. It remains inside
// this capability and is used only by the protocol executor owned by Gateway.
export async function createAiGatewayClient({ env, session, consumerId, feature,
  consumerContext, serviceLease, subsonicPrincipal, registry, signal, legacyConfig = {} }, dependencies = {}) {
  if (features[consumerId] !== feature) pluginFail('PLUGIN_SERVICE_FEATURE_FORBIDDEN', 403);
  if (serviceLease && (!isPluginServiceLease(serviceLease) || serviceLease.consumer.id !== consumerId
    || serviceLease.provider.id !== 'ai-gateway')) pluginFail('PLUGIN_SERVICE_CONTEXT_MISMATCH', 403);
  const lease = serviceLease || (subsonicPrincipal
    ? await (await import("@flaretune/plugin-sdk/server/subsonic-principal")).createSubsonicPluginServiceLease({ env, principal: subsonicPrincipal, consumerId, providerId: 'ai-gateway', registry })
    : await createPluginServiceLease({ env, session, consumerId, providerId: 'ai-gateway', consumerContext, registry }));
  const resolved = await resolveAiFeature(lease.guardedDb(env.DB), feature, env, legacyConfig);
  const privateConfig = resolved?.config || legacyConfig;
  const privateEnv = resolved?.env || await legacyEnvironment(lease.guardedDb(env.DB), privateConfig, env);
  await lease.assertCurrent();
  const validated = resolveAIConfig(privateConfig);
  try { aiConnection(validated, privateEnv); }
  catch (error) {
    if (error?.message === 'AI_MISSING_KEY') throw new Error('AI_PROVIDER_UNCONFIGURED');
    throw error;
  }
  const config = freeze(clone(Object.fromEntries([
    'provider', 'source', 'protocol', 'model', 'temperature', 'generationOptions', 'supportsImages',
    'profileId', 'profileRevision', 'featureRevision', 'exactModel',
  ].filter(key => privateConfig[key] !== undefined).map(key => [key, privateConfig[key]]))));
  const source = config.source || sourceFromProvider(config.provider);
  const protocol = config.protocol || legacyProtocol(config.provider);
  const prefix = { deepseek: 'DEEPSEEK', openai: 'OPENAI', gemini: 'GEMINI', anthropic: 'ANTHROPIC', custom: 'OPENAI' }[source];
  const baseUrl = effectiveAiBaseUrl(source, privateEnv.AI_PROFILE_BASE_URL || privateEnv[`${prefix}_BASE_URL`] || '', protocol);
  const identity = JSON.stringify({ profile: config.profileId || config.provider, revision: config.profileRevision ?? null,
    source, protocol, model: config.model, baseUrl });
  const activeDrains = new Set();

  async function execute(kind, messages, tools, overrides = {}, options = {}) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
      || Object.keys(overrides).some(key => !['temperature', 'enableThinking'].includes(key))) {
      pluginFail('PLUGIN_SERVICE_OVERRIDE_FORBIDDEN', 403);
    }
    const controller = new AbortController();
    let retired = false, checking = false;
    const abort = () => controller.abort();
    const signals = [...new Set([signal, options.signal].filter(Boolean))];
    for (const item of signals) { if (item.aborted) abort(); else item.addEventListener('abort', abort, { once: true }); }
    let callbacks = Promise.resolve();
    const check = async () => {
      if (controller.signal.aborted || retired) throw new DOMException('Plugin service retired', 'AbortError');
      try { await lease.assertCurrent(); }
      catch (error) { retired = true; controller.abort(); throw error; }
    };
    const timer = dependencies.pollIntervalMs === 0 ? null : setInterval(() => {
      if (checking || retired) return;
      checking = true;
      void check().catch(() => {}).finally(() => { checking = false; });
    }, dependencies.pollIntervalMs ?? 1000);
    const forwarded = { ...options, signal: controller.signal };
    const pendingCallbacks = [];
    let flushing = false, batchTimer, startBatch;
    const deliver = async () => {
      const batch = pendingCallbacks.splice(0);
      for (const [key, args] of batch) {
        const value = options[key](...args);
        if (value && typeof value.then === 'function') { await value; await lease.assertCurrent(); }
      }
    };
    // Explicit stop may precede the next public batch. These bytes are still
    // authorized before the consumer stores its failure checkpoint; an aborted
    // upstream signal does not by itself revoke the account capability.
    const drain = async () => { if (pendingCallbacks.length) { await lease.assertCurrent(); await deliver(); } };
    activeDrains.add(drain);
    const flushCallbacks = async () => {
      try {
        while (pendingCallbacks.length) {
          await check();
          await deliver();
        }
      } finally { flushing = false; }
    };
    for (const key of ['onContentDelta', 'onThoughtDelta', 'onStreamEvent']) {
      if (typeof options[key] !== 'function') continue;
      forwarded[key] = (...args) => {
        pendingCallbacks.push([key, args]);
        if (!flushing) {
          flushing = true;
          // Provider parsers may yield between every character. A small public
          // event batch, authorized at delivery, avoids one D1 call per token.
          callbacks = new Promise(resolve => { startBatch = resolve; batchTimer = setTimeout(resolve, 25); })
            .then(() => { startBatch = null; clearTimeout(batchTimer); return flushCallbacks(); });
        }
        void callbacks.catch(() => { retired = true; controller.abort(); });
      };
    }
    try {
      await check();
      let result, executionError;
      try {
        result = kind === 'ask'
          ? await (dependencies.ask || askAI)(messages, { ...privateConfig, ...overrides }, privateEnv, forwarded)
          : await (dependencies.chat || chatAI)(messages, tools, { ...privateConfig, ...overrides }, privateEnv, forwarded);
      } catch (error) { executionError = error; }
      startBatch?.();
      await callbacks;
      await check();
      if (executionError) throw executionError;
      return result;
    } finally {
      clearInterval(timer);
      clearTimeout(batchTimer);
      activeDrains.delete(drain);
      for (const item of signals) item.removeEventListener('abort', abort);
    }
  }
  return Object.freeze({ config, identity, assertCurrent: lease.assertCurrent, guardedDb: lease.guardedDb,
    drain: async () => { for (const drain of activeDrains) await drain(); },
    ask: (messages, overrides, options) => execute('ask', messages, [], overrides, options),
    chat: (messages, tools, overrides, options) => execute('chat', messages, tools, overrides, options) });
}
