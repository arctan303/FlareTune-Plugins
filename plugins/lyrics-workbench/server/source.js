import { createLyricDocument } from '@flaretune/plugin-sdk/server/lyric-document';
import { lyricArtifactStoreForEnv, buildReadyLyricArtifact, projectLyricArtifact,
  resolveLyricTranslationNeed, hasCurrentLyricNoTranslationDecision } from '@flaretune/plugin-sdk/server/lyric-workflow';
import { preferredAutomaticDocument, reliableAutomaticMatch } from '@flaretune/plugin-sdk/server/lyric-resolution';
import { fetchLyricsDocumentWithFallback } from '@flaretune/plugin-sdk/server/lyric-sources';
import { computeHash } from '@flaretune/plugin-sdk/server/lyric-parsing';
import { loadLyricSources, lyricSourceLoaderForDb } from '@flaretune/plugin-sdk/server/lyric-source-settings';
import { resolveLyricSong } from '@flaretune/plugin-sdk/server/playback-lyrics';
import { guardStoreAuthority } from '@flaretune/plugin-sdk/server/store-authority';
import { createPluginOperationLease } from '@flaretune/plugin-sdk/server/service-leases';
import { loadLyricAiConfig, loadLyricPolicySnapshot } from './config.js';
import { createLyricsAiLease } from './aiAccess.js';
import { beginLyricAssetAiCompletion } from './translation.js';
import { createWorkbenchSourceCore } from './sourceCore.js';

import { workbenchMessage } from '../shared/messages.js';

export function createLyricSource({ env, db = env?.DB, session, executionContext, context, dependencies = {} }) {
  let ownLease, aiLease, processingSettings, policySnapshot, completionConfig, assessmentSources;
  const policy = () => policySnapshot ||= loadLyricPolicySnapshot(db);
  const authority = async () => {
    if (typeof dependencies.assertCurrent === 'function') return dependencies.assertCurrent();
    if (typeof context?.assertCurrent === 'function') return context.assertCurrent();
    if (dependencies.subsonicPrincipal) throw new Error('PLUGIN_SERVICE_CONTEXT_MISMATCH');
    ownLease ||= (dependencies.createOperationLease || createPluginOperationLease)({ env, session,
      pluginId: 'lyrics-workbench', context, registry: dependencies.registry });
    return (await ownLease).assertCurrent();
  };
  const ai = () => aiLease ||= Promise.resolve((dependencies.createAiLease || createLyricsAiLease)({ env, session, context,
    deps: { subsonicPrincipal: dependencies.subsonicPrincipal, registry: dependencies.registry } })).then(async lease => {
      await dependencies.registerServiceAuthority?.(lease);
      return lease;
    });
  const sourceConfig = storage => completionConfig ||= (async () => {
    const config = dependencies.loadLyricAiConfig ? await dependencies.loadLyricAiConfig(storage)
      : await loadLyricAiConfig(storage, { snapshot: await policy() });
    // Routine playback only fills translations. Cleanup is an explicit action.
    return { ...config, cleanDirtyLyrics: false, translateLyrics: true, detectLanguage: true,
      referenceExistingTranslation: true };
  })();
  const safeCode = value => /^[a-z][a-z0-9_]{0,63}$/u.test(value || '') ? value : 'completion_failed';
  const lang = dependencies.locale || context?.locale || context?.language || 'en';
  const core = createWorkbenchSourceCore({ env, db, session, executionContext, context,
    store: dependencies.store || guardStoreAuthority(lyricArtifactStoreForEnv(env), authority),
    dependencies: { ...dependencies,
      aiDeps: { ...dependencies.aiDeps, subsonicPrincipal: dependencies.subsonicPrincipal },
      // No native provider callback can cross this source's boundary.
      fetchNativeDocument: undefined },
    operations: {
      assertCurrent: authority,
      assertReadScope: async () => { await dependencies.assertReadScope?.(); context?.signal?.throwIfAborted(); },
      settings: async () => {
        await dependencies.assertReadScope?.();
        return processingSettings ||= (dependencies.loadSettings ? dependencies.loadSettings(db) : policy().then(snapshot => snapshot.config));
      },
      assessmentSettings: async config => {
        const sources = await (assessmentSources ||= (dependencies.loadSources || loadLyricSources)(db));
        return { assessmentKey: await computeHash(JSON.stringify({ onlineEnabled: config.onlineEnabled, lyricPreference: config.lyricPreference, sources })) };
      },
      createDocument: dependencies.createDocument || createLyricDocument,
      buildArtifact: dependencies.buildArtifact || buildReadyLyricArtifact,
      project: dependencies.project || projectLyricArtifact,
      resolveTranslationNeed: dependencies.resolveTranslationNeed || resolveLyricTranslationNeed,
      hasNoTranslationDecision: dependencies.hasNoTranslationDecision || hasCurrentLyricNoTranslationDecision,
      preferred: dependencies.preferred || preferredAutomaticDocument,
      reliable: dependencies.reliable || reliableAutomaticMatch,
      fetchCandidate: dependencies.fetchCandidate || (async (song, options) => {
        const loader = await lyricSourceLoaderForDb(db);
        return fetchLyricsDocumentWithFallback('auto', song, loader.cachedDocument, { ...options, enabledSources: loader.enabledSources });
      }),
      beginCompletion: async input => (dependencies.beginCompletion || beginLyricAssetAiCompletion)({ ...input,
        deps: { ...input.deps, aiLease: await ai() } }),
      aiAvailable: async () => { try { await ai(); return true; } catch { return false; } },
      aiConfig: sourceConfig,
      resolveSong: id => dependencies.resolveSong ? dependencies.resolveSong(id) : resolveLyricSong(db, id, dependencies),
      translationError: code => ({ code: safeCode(code), message: workbenchMessage('translationFailed', lang) }),
    } });
  return core;
}
