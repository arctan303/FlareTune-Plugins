import { translationLanguageMatches } from '../shared/translation-languages.js';
const DEFAULT_SETTINGS = Object.freeze({ onlineEnabled: true, lyricPreference: 'word', targetLanguage: 'en', completionEnabled: true });
const readyArtifact = read => read?.artifact?.status === 'ready' ? read.artifact : null;
export const isProtectedWorkbenchArtifact = artifact => artifact?.original?.source === 'manual' || artifact?.provenance?.evaluation === 'manual';
export function markManuallySelectedArtifact(artifact) {
  return artifact?.status === 'ready' ? { ...artifact, provenance: { ...artifact.provenance,
    managedBy: 'lyrics-workbench', evaluation: 'manual', quality: 'good',
    originalSource: artifact.provenance?.originalSource || artifact.original.source } } : artifact;
}
const isAssessed = (artifact, config) => artifact?.provenance?.managedBy === 'lyrics-workbench' && artifact.provenance.evaluation === 'assessed'
  && (!config.assessmentKey || artifact.provenance.assessmentKey === config.assessmentKey);
const spokenLanguageMatches = translationLanguageMatches;
const safeFailure = code => Object.assign(new Error(code), { code, status: 409 });
const MISS_TTL_MS = 10 * 60 * 1000;

// The adapter injects the existing host matching, storage and AI capabilities.
// Selection stays pure until the outer chain actually adopts this source.
export function createWorkbenchSourceCore({ env, db, session, executionContext, context, store, operations, dependencies = {} }) {
  const claimedReads = new Map(), checkedFiles = new Map();
  const settings = async () => ({ ...DEFAULT_SETTINGS, ...await operations.settings() });
  const current = async song => { await operations.assertReadScope?.(); return store.get(song.id); };
  const beginRead = () => (operations.beginRead || operations.assertCurrent)();
  const documentFor = (artifact, song) => {
    const matched = Number(artifact.provenance?.matchedDuration), duration = Number(song.duration);
    return operations.createDocument({ ...artifact.original, providerMeta: { ...artifact.provenance,
      durationDelta: matched > 0 && duration > 0 ? Math.abs(matched - duration) : undefined } });
  };
  const grade = (document, artifact, config) => {
    if (isProtectedWorkbenchArtifact(artifact)) return 'good';
    if (isAssessed(artifact, config) && artifact.provenance.quality === 'weak') return 'weak';
    return operations.reliable(document) && (config.lyricPreference === 'line' ? ['line', 'word'].includes(document.syncMode) : document.syncMode === 'word') ? 'good' : 'weak';
  };
  const toResult = async (read, song, config, { onAdopt } = {}) => {
    const artifact = readyArtifact(read); if (!artifact) return null;
    const document = documentFor(artifact, song);
    const projected = operations.project(artifact, { song, targetLanguage: config.targetLanguage });
    // Projection hides invalid legacy layers without mutating their saved bytes.
    const translation = projected?.translation;
    const translationLanguage = operations.translationLanguage ? operations.translationLanguage(translation)
      : translation?.language || (translation?.source === 'ai' ? 'zh' : null);
    const valid = translation && translation.originalTextHash === artifact.textHash
      && spokenLanguageMatches(translationLanguage, config.targetLanguage);
    const cachedNoOp = operations.hasNoTranslationDecision(artifact, song, { targetLanguage: config.targetLanguage });
    const needs = !cachedNoOp && operations.resolveTranslationNeed(artifact.original, song,
      { targetLanguage: config.targetLanguage, artifact }).state !== 'not_needed';
    const available = !valid && config.completionEnabled && needs && await operations.aiAvailable();
    const state = valid ? 'ready' : !needs ? 'not_needed' : projected?.translationState === 'pending' ? 'pending'
      : projected?.translationState === 'failed' ? 'failed' : available ? 'idle' : 'unavailable';
    const supported = Boolean(valid || available && state !== 'not_needed');
    return { quality: grade(document, artifact, config), document, artifact, etag: read.etag,
      translation: { supported, state: supported || state === 'not_needed' ? state : 'unavailable', targetLanguage: config.targetLanguage,
        language: valid ? translationLanguage : null,
        source: valid ? translation.source : available ? 'ai' : null,
        kind: valid ? translation.kind || (translation.source === 'ai' ? 'ai' : translation.source === 'manual' ? 'manual' : 'provider') : available ? 'ai' : null,
        lines: valid ? [...translation.lines] : [],
        ...(state === 'failed' ? { error: operations.translationError(artifact.aiCompletion?.errorCode || 'completion_failed') } : {}) },
      provenance: { ...artifact.provenance, originalSource: artifact.provenance?.originalSource || artifact.original.source },
      sourceRef: { targetLanguage: config.targetLanguage }, ...(onAdopt ? { onAdopt } : {}) };
  };
  const verify = async (song, hash) => {
    const read = await current(song);
    if (!readyArtifact(read) || hash && read.artifact.textHash !== hash) throw safeFailure('LYRIC_RESULT_STALE');
    return read;
  };
  const completeSelected = async (read, song, config, options = {}, automatic = false) => {
    let result = await toResult(read, song, config);
    if (!result || ['ready', 'pending'].includes(result.translation.state) || !config.completionEnabled) return result;
    const cachedNoOp = operations.hasNoTranslationDecision(read.artifact, song, { targetLanguage: config.targetLanguage });
    if (result.translation.state === 'not_needed' && cachedNoOp
      || !result.translation.supported && result.translation.state !== 'not_needed') return result;
    // An unknown-language failure is not a no-translation decision. Ordinary
    // reads retain its retryable status; the owning-source POST may retry it.
    if (automatic && result.translation.state === 'failed'
      && /^(?:language_assessment_|language_undetermined$)/u.test(read.artifact.aiCompletion?.errorCode || '')) return result;
    const expectedHash = read.artifact.textHash;
    const aiConfig = await operations.aiConfig(db);
    const completionDeps = { ...dependencies.aiDeps, session, consumerContext: context,
      subsonicPrincipal: dependencies.subsonicPrincipal, registry: dependencies.registry,
      signal: options.signal, lyricConfig: aiConfig,
      checkCurrent: value => { if (value?.artifact?.textHash !== expectedHash) throw safeFailure('LYRIC_RESULT_STALE'); return value; } };
    // beginCompletion synchronously assesses an idle song and hands its one
    // pending claim to generation. A separate prepare here would settle and
    // immediately recreate that claim. Existing failures/no-ops still need
    // their decision cache reconciled before considering automatic work.
    if (operations.prepareLanguage && result.translation.state !== 'idle') {
      const prepared = await operations.prepareLanguage({ env, db, song, store,
        actorAccountId: session?.account?.accountId || context?.identity?.accountId,
        targetLanguage: config.targetLanguage,
        deps: { ...completionDeps, initialRead: { ...read, state: 'found' } } });
      read = prepared.read;
      song = prepared.song || song;
      if (!readyArtifact(read) || read.artifact.textHash !== expectedHash) throw safeFailure('LYRIC_RESULT_STALE');
      result = await toResult(read, song, config);
      if (prepared.need !== 'needed' || !result || ['ready', 'pending', 'not_needed'].includes(result.translation.state)
        || !result.translation.supported) return result;
    }
    // A freshly prepared policy decision clears only obsolete pre-1.0 failures.
    // New generation failures remain visible until POST, without a read loop.
    if (automatic && result.translation.state === 'failed'
      && read.artifact.aiCompletion?.errorCode !== 'request_budget_exhausted') return result;
    const started = await operations.beginCompletion({ env, db, song, store,
      actorAccountId: session?.account?.accountId || context?.identity?.accountId,
      force: false, targetLanguage: config.targetLanguage, automatic,
      deps: { ...completionDeps, initialRead: { ...read, state: 'found' } } });
    if (started.task) {
      if (executionContext?.waitUntil) executionContext.waitUntil(started.task);
      else void started.task.catch(() => undefined);
    }
    return toResult(started.artifact ? started : read, started.song || song, config);
  };
  const ensureSongAvailable = async song => {
    const exists = typeof dependencies.songStillExists === 'function'
      ? await dependencies.songStillExists(song.id) : await operations.resolveSong(song.id);
    if (!exists) throw safeFailure('LYRIC_SONG_DELETED');
  };
  const samePreparedWinner = (read, planned) => {
    const winner = readyArtifact(read), expected = readyArtifact(planned.read);
    return winner && expected && !isProtectedWorkbenchArtifact(winner)
      && winner.textHash === expected.textHash && winner.offsetMs === expected.offsetMs
      && winner.provenance?.managedBy === 'lyrics-workbench'
      && winner.provenance?.assessmentKey === expected.provenance?.assessmentKey
      && JSON.stringify(winner.original) === JSON.stringify(expected.original);
  };
  const prepare = async (song, config, options, claimedRead) => {
    const initial = claimedRead || await current(song), artifact = readyArtifact(initial);
    if (artifact && isProtectedWorkbenchArtifact(artifact)) return { read: initial, changed: false };
    const missAge = (dependencies.now || Date.now)() - Date.parse(initial.artifact?.updatedAt);
    if (initial.artifact?.status === 'deleting' || initial.artifact?.status === 'not_found' && missAge >= 0 && missAge < MISS_TTL_MS) return { read: initial, changed: false };
    if (operations.assessmentSettings) Object.assign(config, await operations.assessmentSettings(config));
    if (artifact && isAssessed(artifact, config)) return { read: initial, changed: false };
    const checkedKey = JSON.stringify([initial.etag, config.assessmentKey, config.onlineEnabled, config.lyricPreference]);
    if (artifact && checkedFiles.get(song.id) === checkedKey) return { read: initial, changed: false };
    let selected = artifact ? documentFor(artifact, song) : null;
    let selectedFromFile = Boolean(artifact);
    if (config.onlineEnabled) {
      try {
        const candidate = await operations.fetchCandidate(song, { signal: options.signal, executionContext, ...options });
        if (candidate && (!selected || operations.preferred(candidate, selected))) { selected = operations.createDocument(candidate); selectedFromFile = false; }
      } catch (error) {
        options.signal?.throwIfAborted();
        // A provider failure retains an existing file, with its real confidence.
        if (!selected) throw error;
      }
    }
    if (!selected?.lines?.length) {
      // A confirmed provider miss is a bounded negative cache, not ready lyrics.
      // It never claims another provider's result and cannot erase legacy data.
      if (config.onlineEnabled && initial.state !== 'legacy') {
        await ensureSongAvailable(song); options.signal?.throwIfAborted();
        const empty = { schemaVersion: 1, songId: song.id, status: 'not_found', updatedAt: new Date((dependencies.now || Date.now)()).toISOString() };
        if (initial.etag) await store.putIfMatch(song.id, empty, initial.etag, { signal: options.signal });
        else await store.createIfAbsent(song.id, empty, { signal: options.signal });
      }
      return { read: initial, changed: false };
    }
    // Reusing the same original does not require a storage mutation merely to
    // record that providers were checked. Keep this evaluation in this request;
    // the original ETag and provenance remain valid for completion and CAS.
    if (artifact && selectedFromFile) {
      checkedFiles.set(song.id, checkedKey);
      return { read: initial, changed: false };
    }
    let built = await operations.buildArtifact(song, selected, { targetLanguage: config.targetLanguage });
    if (artifact && artifact.textHash === built.artifact.textHash && artifact.original.lines.length === built.artifact.original.lines.length) {
      // A same-text upgrade may improve real timing: retain the new original,
      // while reusing a compatible layer and the saved overall offset.
      built = { ...built, artifact: { ...built.artifact, offsetMs: artifact.offsetMs,
        translation: built.artifact.translation || artifact.translation,
        ...(artifact.translationDecision ? { translationDecision: artifact.translationDecision } : {}),
        aiCompletion: built.artifact.translation ? null : artifact.aiCompletion } };
    }
    const quality = grade(selected, built.artifact, config);
    built.artifact.provenance = { ...built.artifact.provenance,
      managedBy: 'lyrics-workbench', evaluation: 'assessed', quality,
      ...(config.assessmentKey ? { assessmentKey: config.assessmentKey } : {}),
      originalSource: selectedFromFile && artifact
        ? artifact.provenance?.originalSource || artifact.original.source : selected.source };
    return { read: { ...initial, artifact: built.artifact }, changed: true };
  };
  const source = {
    id: 'lyrics-workbench',
    async claim(song) {
      if (!song?.id || song.language === 'instrumental') return false;
      await operations.assertReadScope?.();
      const config = await settings();
      if (config.onlineEnabled) return true;
      const read = await current(song);
      if (!readyArtifact(read)) return false;
      claimedReads.set(song.id, read);
      return true;
    },
    async resolve(song, options = {}) {
      if (!song?.id || song.language === 'instrumental') return null;
      options.signal?.throwIfAborted();
      await beginRead();
      const config = await settings();
      const claimedRead = options.resultRef ? null : claimedReads.get(song.id);
      claimedReads.delete(song.id);
      const planned = store.singleflight
        ? await store.singleflight(song.id, ({ signal = options.signal } = {}) => prepare(song, config, { ...options, signal }, claimedRead),
          { signal: options.signal, executionContext })
        : await prepare(song, config, options, claimedRead);
      if (!readyArtifact(planned.read)) return null;
      const selectedHash = planned.read.artifact.textHash;
      return toResult(planned.read, song, config, { onAdopt: async () => {
        await operations.assertReadScope?.(); options.signal?.throwIfAborted();
        let adopted = planned.read;
        if (planned.changed) {
          const latest = await current(song);
          if (samePreparedWinner(latest, planned)) adopted = latest;
          else {
            if (latest.etag !== planned.read.etag || isProtectedWorkbenchArtifact(readyArtifact(latest))) throw safeFailure('LYRIC_RESULT_STALE');
            await ensureSongAvailable(song); options.signal?.throwIfAborted();
            const artifact = { ...planned.read.artifact, updatedAt: new Date((dependencies.now || Date.now)()).toISOString() };
            adopted = latest.etag ? await store.putIfMatch(song.id, artifact, latest.etag, { automation: latest.automation, signal: options.signal })
              : await store.createIfAbsent(song.id, artifact, { signal: options.signal });
            if (!['created', 'updated'].includes(adopted.state)) {
              adopted = await current(song);
              if (!samePreparedWinner(adopted, planned)) throw safeFailure('LYRIC_RESULT_STALE');
            }
          }
        }
        if (adopted.artifact.textHash !== selectedHash) throw safeFailure('LYRIC_RESULT_STALE');
        return config.completionEnabled
          ? completeSelected(adopted, song, config, options, true)
          : toResult(adopted, song, config);
      } });
    },
    async translate(ref, options = {}) {
      if (!ref?.songId || !ref.textHash) throw safeFailure('LYRIC_RESULT_STALE');
      await beginRead();
      const config = await settings();
      if (ref.sourceRef?.targetLanguage && ref.sourceRef.targetLanguage !== config.targetLanguage) throw safeFailure('LYRIC_RESULT_STALE');
      const song = options.song || await operations.resolveSong(ref.songId);
      if (!song || song.id !== ref.songId) throw safeFailure('LYRIC_RESULT_STALE');
      const read = await verify(song, ref.textHash);
      return completeSelected(read, song, config, options, false);
    },
  };
  return Object.freeze(source);
}
