import { createAiGatewayClient } from "@flaretune/plugin-service/ai-gateway/server/client.js";
import { loadLyricAiConfig } from "./config.js";
import { createPluginServiceLease, isPluginServiceLease } from "@flaretune/plugin-sdk/server/service-leases";
import { createSubsonicPluginServiceLease } from "@flaretune/plugin-sdk/server/subsonic-principal";
import { lyricsInvocationBudget } from "./invocationBudget.js";

export const createLyricsAiLease = ({ env, session, context, deps = {} }) =>
  (deps.createServiceLease || (deps.subsonicPrincipal ? createSubsonicPluginServiceLease : createPluginServiceLease))({ env, session,
    principal: deps.subsonicPrincipal,
    consumerId: 'lyrics-workbench', providerId: 'ai-gateway', consumerContext: context, registry: deps.registry, admin: deps.admin === true });

export { storeAuthorityGuard as lyricsStoreGuard, guardStoreAuthority as guardLyricsStore } from "@flaretune/plugin-sdk/server/store-authority";

// The consumer owns lyric policy and saved model; Gateway resolves connection secrets and
// retains credential-bearing env entirely within its execution capability.
export async function createLyricsAiAccess({ env, db, session, context, signal, deps = {} }) {
  const budget = lyricsInvocationBudget(env.DB);
  const lease = deps.aiLease || await createLyricsAiLease({ env, session, context, deps });
  const legacy = deps.lyricConfig || await (deps.loadLyricAiConfig || loadLyricAiConfig)(lease.guardedDb(db),
    deps.getAIAssistantConfig ? { getLegacy: deps.getAIAssistantConfig } : {});
  const client = await (deps.createGatewayClient || createAiGatewayClient)({ env, session,
    consumerId: 'lyrics-workbench', feature: 'lyrics', consumerContext: context,
    serviceLease: isPluginServiceLease(lease) ? lease : undefined,
    subsonicPrincipal: deps.subsonicPrincipal, registry: deps.registry, signal: budget?.signal || signal,
    configuration: { slot: 'ai-model' } },
  // The lyric completion deadline is 24s. At most 12 waiting checks preserve
  // the Free invocation budget; every result and write still checks live state.
  { pollIntervalMs: 2000 });
  return Object.freeze({ lease, client, config: { ...legacy, ...client.config,
    temperature: client.config.generationOptions?.temperature }, db: client.guardedDb(),
    budget });
}
