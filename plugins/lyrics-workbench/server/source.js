import { createLyricDocument } from '@flaretune/plugin-sdk/server/lyric-document';
import { lyricArtifactStoreForEnv, buildReadyLyricArtifact, projectLyricArtifact,
  hasCurrentLyricNoTranslationDecision } from '@flaretune/plugin-sdk/server/lyric-workflow';
import { preferredAutomaticDocument, reliableAutomaticMatch } from '@flaretune/plugin-sdk/server/lyric-resolution';
import { fetchLyricsDocumentWithFallback } from '@flaretune/plugin-sdk/server/lyric-sources';
import { computeHash } from '@flaretune/plugin-sdk/server/lyric-parsing';
import { loadLyricSources, lyricSourceLoaderForDb } from '@flaretune/plugin-sdk/server/lyric-source-settings';
import { resolveLyricSong, guardExternalLyricStore } from '@flaretune/plugin-sdk/server/playback-lyrics';
import { guardStoreAuthority, storeAuthorityGuard } from '@flaretune/plugin-sdk/server/store-authority';
import { createPluginOperationLease } from '@flaretune/plugin-sdk/server/service-leases';
import { loadLyricAiConfig, loadLyricPolicySnapshot } from './config.js';
import { createLyricsAiLease, createLyricsAiAccess } from './aiAccess.js';
import { beginLyricAssetAiCompletion, prepareLyricLanguage } from './translation.js';
import { dominantLyricTranslationNeed } from './languageAssessment.js';
import { createWorkbenchSourceCore } from './sourceCore.js';

import { workbenchMessage } from '../shared/messages.js';

export function createLyricSource({ env, db = env?.DB, session, executionContext, context, dependencies = {} }) {
  let ownLease, aiLease, processingSettings, policySnapshot, completionConfig, assessmentSources, completionAccess;
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
  // This factory is request-scoped. The model/configuration assertion remains
  // live on every call; only the already-resolved client capability is reused.
  const accessFor = input => input.deps.aiAccess || (completionAccess ||= (async () =>
    createLyricsAiAccess({ env, db, session, context, signal: input.deps.signal,
      deps: { ...input.deps, aiLease: await ai() } }))());
  const safeCode = value => /^[a-z][a-z0-9_]{0,63}$/u.test(value || '') ? value : 'completion_failed';
  const lang = dependencies.locale || context?.locale || context?.language || 'en';
  const sourceStore = dependencies.store || guardStoreAuthority(lyricArtifactStoreForEnv(env), authority);
  const songExists = async id => typeof dependencies.songStillExists === 'function'
    ? Boolean(await dependencies.songStillExists(id))
    : Boolean(await (dependencies.resolveSong ? dependencies.resolveSong(id) : resolveLyricSong(db, id, dependencies)));
  // Keep the existence check inside the final I/O method, including injected
  // stores. A later AI lease wrapper still calls these closures, so it cannot
  // drop the local-song write guard or the external-source read/write guard.
  const wrapStore = base => {
    const wrapped = Object.fromEntries(Object.entries(base).map(([name, value]) => [name,
      typeof value !== 'function' ? value : (...args) => {
        const songId = args[0];
        if (typeof songId !== 'string') return value.apply(base, args);
        const guarded = guardExternalLyricStore(base, songId, () => songExists(songId));
        return guarded[name](...args);
      }]));
    // Delegate to the original store's authority composition. Only the host
    // can recognize a genuine stronger service/configuration gate; unknown
    // assertions retain the original guards. Reapply the song-existence gate
    // outside that composition so it always protects the final I/O.
    Object.defineProperty(wrapped, storeAuthorityGuard, { value: assertion =>
      wrapStore(guardStoreAuthority(base, assertion)) });
    return wrapped;
  };
  const store = wrapStore(sourceStore);
  const configurationFailure = async (input, error) => {
    const code = String(error?.code || error?.message || '');
    if (error?.name === 'AbortError' || error?.name === 'AuthError' || [401, 403].includes(error?.status)
      || !(/^AI_/u.test(code) || code === 'PLUGIN_UPDATE_REQUIRED')) throw error;
    const current = input.deps.initialRead || await store.get(input.song.id);
    if (current?.artifact?.status !== 'ready') throw error;
    const updatedAt = new Date((input.deps.now || Date.now)()).toISOString();
    // Even an initialization failure must retain the live Gateway/consumer
    // lease at the final I/O; the weaker source gate alone is insufficient.
    const failureStore = guardStoreAuthority(store, (await ai()).assertCurrent);
    const failed = await failureStore.putIfMatch(input.song.id, { ...current.artifact,
      aiCompletion: { status: 'failed', errorCode: 'language_assessment_configuration_unavailable', updatedAt }, updatedAt }, current.etag,
    { automation: current.automation });
    if (failed.state !== 'updated') throw Object.assign(new Error('LYRIC_RESULT_STALE'), { code: 'LYRIC_RESULT_STALE', status: 409 });
    return { ...failed, song: input.song, task: null, state: 'failed' };
  };
  const core = createWorkbenchSourceCore({ env, db, session, executionContext, context,
    store,
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
      resolveTranslationNeed: dependencies.resolveTranslationNeed || ((original, song, { artifact, ...options }) =>
        dominantLyricTranslationNeed(artifact || { original }, song, options)),
      hasNoTranslationDecision: dependencies.hasNoTranslationDecision || hasCurrentLyricNoTranslationDecision,
      preferred: dependencies.preferred || preferredAutomaticDocument,
      reliable: dependencies.reliable || reliableAutomaticMatch,
      fetchCandidate: dependencies.fetchCandidate || (async (song, options) => {
        const loader = await lyricSourceLoaderForDb(db);
        return fetchLyricsDocumentWithFallback('auto', song, loader.cachedDocument, { ...options, enabledSources: loader.enabledSources });
      }),
      beginCompletion: async input => {
        try { return await (dependencies.beginCompletion || beginLyricAssetAiCompletion)({ ...input,
          deps: { ...input.deps, aiAccess: await accessFor(input) } }); }
        catch (error) { return configurationFailure(input, error); }
      },
      prepareLanguage: async input => {
        const unknown = dominantLyricTranslationNeed(input.deps.initialRead.artifact, input.song,
          { targetLanguage: input.targetLanguage }).state === 'unknown';
        try { return await (dependencies.prepareLanguage || prepareLyricLanguage)({ ...input,
          // Tagged no-ops need no gateway. Unknown songs and their subsequent
          // translation share the exact same request/model snapshot.
          deps: { ...input.deps, ...(unknown ? { aiAccess: await accessFor(input) }
            : aiLease ? { aiLease: await aiLease } : {}) } }); }
        catch (error) {
          const failed = await configurationFailure(input, error);
          return { read: { ...failed, state: 'found' }, song: input.song, language: null,
            need: 'unknown', reason: 'language_assessment_configuration_unavailable' };
        }
      },
      aiAvailable: async () => { try { await ai(); return true; } catch { return false; } },
      aiConfig: sourceConfig,
      resolveSong: id => dependencies.resolveSong ? dependencies.resolveSong(id) : resolveLyricSong(db, id, dependencies),
      translationError: code => ({ code: safeCode(code), message: workbenchMessage('translationFailed', lang) }),
    } });
  return core;
}
