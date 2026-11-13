import { createLyricsAiAccess, createLyricsAiLease, guardLyricsStore } from "./aiAccess.js";
import { DEFAULT_LYRIC_AI_CONFIG, lyricAiProcessingKey } from "./policy.js";
import { reserveDailyQuota } from "./usage.js";
import { buildTranslationBatches, parseLanguageAwareTranslationResponse } from "./translationFormat.js";
import { createLyricDocument, isSingableLineText, isLeadingProviderMetadata } from "@flaretune/plugin-sdk/server/lyric-document";
import { computeHash, isNonLyricText } from "@flaretune/plugin-sdk/server/lyric-parsing";
import {
  isFreshLyricAiPending,
  projectLyricArtifact,
  lyricTextForHash,
  getCurrentLyricTranslationDecision,
  hasCurrentLyricNoTranslationDecision,
  buildLyricNoTranslationDecision,
  buildLyricTranslationDecision,
} from "@flaretune/plugin-sdk/server/lyric-workflow";

import { dominantLyricTranslationNeed, buildLanguageAssessmentPrompt, parseLanguageAssessmentResponse, lyricLanguageTag } from './languageAssessment.js';
export { dominantLyricTranslationNeed } from './languageAssessment.js';

const DEFAULT_DAILY_LIMIT = 50;
const AI_COMPLETION_DEADLINE_MS = 24_000;
// ai.js treats shorter overrides as invalid, so stop before it could fall back to 90 seconds.
const MIN_AI_REQUEST_BUDGET_MS = 5_000;
const VALIDATION_CODES = new Set([
  'INVALID_TARGET_LANGUAGE', 'NO_TRANSLATABLE_LINES', 'INVALID_BATCH_LIMIT', 'INVALID_JSON',
  'INVALID_NOT_NEEDED', 'INVALID_RESPONSE_FIELDS', 'INVALID_COVERAGE', 'INVALID_TRANSLATION_INDEX',
  'INVALID_TRANSLATION_TEXT', 'TARGET_LANGUAGE_MISMATCH', 'UNCHANGED_TRANSLATION',
  'INVALID_UNIT_LANGUAGES', 'INVALID_LANGUAGE_SEGMENTS', 'SOURCE_LANGUAGE_MISMATCH',
  'TARGET_SEGMENT_REWRITTEN', 'LANGUAGE_UNDETERMINED', 'INVALID_TRANSLATION_OUTPUT',
  'INVALID_LYRIC_TRANSLATION_DECISION', 'INVALID_LANGUAGE_ASSESSMENT', 'INVALID_CLEANUP_INDICES',
]);
const VALIDATION_STAGES = new Set(['setup', 'validation', 'finalization']);
// Provenance stays in memory: upstream errors cannot impersonate local
// validation by using a matching message, and nothing is added to the artifact.
const validationFailures = new WeakMap();
export function safeLyricValidationDiagnostic(value) {
  if (!value || typeof value !== 'object') return null;
  const { validationCode, stage, batchIndex } = value;
  const hasBatch = Object.hasOwn(value, 'batchIndex');
  if (!VALIDATION_CODES.has(validationCode) || !VALIDATION_STAGES.has(stage)
    || hasBatch && (!Number.isInteger(batchIndex) || batchIndex < 0 || batchIndex >= 2000)) return null;
  return { validationCode, stage, ...(hasBatch ? { batchIndex } : {}) };
}
function markValidationFailure(error, stage, batchIndex) {
  const diagnostic = safeLyricValidationDiagnostic({ validationCode: error?.message, stage,
    ...(batchIndex === undefined ? {} : { batchIndex }) });
  if (diagnostic && error && typeof error === 'object') validationFailures.set(error, diagnostic);
  return error;
}
function validateCompletion(operation, stage, batchIndex) {
  try {
    const result = operation();
    return result && typeof result.then === 'function'
      ? result.catch(error => { throw markValidationFailure(error, stage, batchIndex); }) : result;
  } catch (error) { throw markValidationFailure(error, stage, batchIndex); }
}
const CLEANUP_INSTRUCTION = 'For this explicitly requested cleanup only, return optional discardLineIndices containing only provided cleanupUnits indices that are clearly non-sung metadata, credits, ads or corrupt text. Keep every uncertain or sung row, including a sung title. Do not change original lyrics or timing. Never remove all sung content.';

export function getDailyLyricCompletionLimit(env) {
  const configured = Number(env?.AI_TRANSLATION_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
  return Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : DEFAULT_DAILY_LIMIT;
}

const dateKey = (now) => new Date(now).toISOString().slice(0, 10);
const completionTimeoutError = () => new Error('AI_COMPLETION_TIMEOUT');
const safeErrorCode = (error) => {
  const message = String(error?.code || error?.message || '').toLocaleUpperCase();
  if (message === 'LYRICS_INVOCATION_BUDGET_EXHAUSTED') return 'request_budget_exhausted';
  if (message.includes('AI_MISSING_KEY')) return 'missing_key';
  if (message.includes('AI_QUOTA_EXHAUSTED')) return 'quota_exhausted';
  if (message.includes('TIMEOUT')) return 'ai_timeout';
  if (message.includes('AI_UPSTREAM_429')) return 'upstream_rate_limited';
  if (/AI_UPSTREAM_5\d\d/u.test(message)) return 'upstream_unavailable';
  if (message.includes('AI_ASSISTANT_CONFIG') || message.includes('AI_CONFIG_INVALID')) return 'configuration_unavailable';
  if (message.includes('AI_EMPTY_RESPONSE') || message.includes('NO_TRANSLATABLE_LINES')
    || message === 'INVALID_JSON' || message.startsWith('INVALID_') || message === 'LANGUAGE_UNDETERMINED'
    || message === 'SOURCE_LANGUAGE_MISMATCH' || message === 'TARGET_LANGUAGE_MISMATCH'
    || message === 'UNCHANGED_TRANSLATION') return 'invalid_output';
  return 'completion_failed';
};

function completionDeadline(deps, execute) {
  const requested = Number(deps.completionDeadlineMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), AI_COMPLETION_DEADLINE_MS)
    : AI_COMPLETION_DEADLINE_MS;
  const monotonicNow = deps.monotonicNow || (() => performance.now());
  const deadlineAt = monotonicNow() + timeoutMs;
  const deadline = {
    expired: false,
    remainingMs() {
      if (this.expired) return 0;
      return Math.max(0, Math.floor(deadlineAt - monotonicNow()));
    },
    assertRemaining(minimumMs = 1) {
      if (this.remainingMs() < minimumMs) throw completionTimeoutError();
    },
  };
  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      deadline.expired = true;
      reject(completionTimeoutError());
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => execute(deadline)), timedOut])
    .finally(() => clearTimeout(timer));
}

function completionUnits(original, song) {
  const songTextKey = text => String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const titleKey = songTextKey(song?.title);
  return original.lines
    .flatMap((line, index) => isLeadingProviderMetadata(line, index, song)
      && !(titleKey && songTextKey(line.text) === titleKey) ? []
      : [{ unitId: index, index, text: String(line.text || '').trim(), repeatCount: 1 }])
    .filter((unit) => isSingableLineText(unit.text));
}

function cleanupUnits(original) {
  const lines = original.lines.map((line, index) => ({ index, text: String(line.text || '').trim() }))
    .filter(({ text }) => text);
  const selected = lines.length <= 220 ? lines : [...lines.slice(0, 170), ...lines.slice(-50)];
  let length = 0;
  return selected.filter(({ text }) => {
    length += text.length;
    return length <= 8_000;
  });
}

async function updateInferredSongLanguage(db, song, language, deps) {
  if (!language || language === song.language) return;
  // External songs have no Songs row. Their lyrics remain keyed by source ID;
  // language inference must not create or update a local catalog entry.
  if (/^yt:[A-Za-z0-9_-]{11}$/u.test(song.id)) return;
  const update = deps.updateSongLanguage || (async (songId, inferred, previous) => db.prepare(
    'UPDATE Songs SET language = ? WHERE id = ? AND language IS ?',
  ).bind(inferred, songId, previous).run());
  const result = await update(song.id, language, song.language ?? null);
  if (result?.meta?.changes === 0 || result?.changes === 0) {
    const current = await db.prepare('SELECT language FROM Songs WHERE id = ?').bind(song.id).first();
    if (current?.language !== language) throw new Error('SONG_LANGUAGE_CHANGED');
  }
}

async function finishWithInferredLanguage(store, db, song, finished, language, deps) {
  if (finished.state !== 'updated') return finished;
  try {
    await updateInferredSongLanguage(db, song, language, deps);
    return finished;
  } catch {
    const failedAt = new Date((deps.now || Date.now)()).toISOString();
    const { translationDecision: _uncommittedLanguageDecision, ...retryable } = finished.artifact;
    const failed = await store.putIfMatch(song.id, {
      ...retryable,
      aiCompletion: { status: 'failed', errorCode: 'language_assessment_update_failed', updatedAt: failedAt },
      updatedAt: failedAt,
    }, finished.etag, { automation: finished.automation });
    return failed.state === 'updated' ? failed : { state: 'superseded' };
  }
}

async function conditionallyFinish(store, songId, startedAt, textHash, update, pendingSnapshot = null) {
  // A successful pending/assessment CAS already supplied this exact version.
  // The final conditional write atomically rejects any intervening edit/task.
  const current = pendingSnapshot || await store.get(songId);
  if (current.state !== 'found' || current.artifact.status !== 'ready') return { state: 'superseded' };
  if (current.artifact.textHash !== textHash
    || current.artifact.aiCompletion?.status !== 'pending'
    || current.artifact.aiCompletion.updatedAt !== startedAt) {
    return { state: 'superseded', artifact: current.artifact, etag: current.etag };
  }
  const next = await update(current.artifact);
  const written = await store.putIfMatch(songId, next, current.etag, { automation: current.automation });
  if (written.state === 'conflict') {
    const winner = await store.get(songId);
    return { state: 'superseded', artifact: winner.artifact, etag: winner.etag };
  }
  return written;
}

async function applySuggestedCleanup(artifact, indices, updatedAt, song, processingKey = null) {
  const lines = artifact.original.lines;
  const removed = new Set(indices.filter((index) => Number.isInteger(index)
    && index >= 0 && index < lines.length));
  const keptIndices = lines.flatMap((_line, index) => removed.has(index) ? [] : [index]);
  const aiCompletion = processingKey ? { status: 'completed', processingKey, updatedAt } : null;
  const finished = { ...artifact, aiCompletion, updatedAt };
  if (!removed.size || !keptIndices.some((index) => isSingableLineText(lines[index].text, song))) {
    return finished;
  }
  const canonical = createLyricDocument({ ...artifact.original,
    lines: keptIndices.map((index) => lines[index]) });
  const original = { ...artifact.original, syncMode: canonical.syncMode, lines: canonical.lines };
  const textHash = await computeHash(lyricTextForHash(original.lines));
  const translated = artifact.translation?.lines
    && keptIndices.map((index) => artifact.translation.lines[index]);
  const translation = translated?.some((line) => String(line || '').trim())
    ? { ...artifact.translation, originalTextHash: textHash, lines: translated, updatedAt }
    : null;
  const result = { ...finished, original, textHash, translation };
  if (textHash !== artifact.textHash) delete result.translationDecision;
  return result;
}

export async function resolveLegacyLyricCleanup(_store, _song, read, _now = Date.now) {
  // Historical review records are proposals, never permission to delete on a
  // read. Keep both the original asset and proposal intact until an explicit
  // current workbench cleanup action is submitted.
  return read;
}

async function askModel(access, messages, deadline) {
  const remaining = deadline.remainingMs();
  if (remaining < MIN_AI_REQUEST_BUDGET_MS) throw completionTimeoutError();
  const options = { ...(access.config.temperature === undefined ? {} : { temperature: access.config.temperature }),
    ...((access.config.source || access.config.provider) === 'deepseek' ? { enableThinking: false } : {}) };
  const execute = () => access.client.ask(messages, options, { timeoutMs: remaining });
  const response = access.budget ? await access.budget.executeAi(execute) : await execute();
  deadline.assertRemaining();
  return response;
}

const found = read => ({ ...read, state: 'found' });
const localSong = (song, language) => language && !/^yt:[A-Za-z0-9_-]{11}$/u.test(song.id)
  ? { ...song, language } : song;
const completionKey = (config, targetLanguage) => lyricAiProcessingKey({ ...DEFAULT_LYRIC_AI_CONFIG, ...config, targetLanguage });
const assessmentResult = (read, song, need, reason, language = null, diagnostic) => ({
  read: found(read), song, language, need, reason, ...(diagnostic ? { diagnostic } : {}),
});
const assessmentFlights = new WeakMap();

function requestSignal(deps) {
  return deps.signal || deps.consumerContext?.signal || null;
}
function abortReason(signal) {
  return signal?.reason || Object.assign(new Error('LYRIC_REQUEST_ABORTED'), { name: 'AbortError' });
}
function assertRequestActive(signal) {
  if (signal?.aborted) throw abortReason(signal);
}
function awaitOwnedRequest(operation, signal) {
  assertRequestActive(signal);
  if (!signal?.addEventListener) return Promise.resolve().then(operation);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(abortReason(signal)); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve().then(() => { assertRequestActive(signal); return operation(); }).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}

/** Settle the selected song's predominant language before exposing its
 * translation capability. Only calls owned by the same request may share a
 * pending Promise. Other requests coordinate solely through persisted CAS. */
export async function prepareLyricLanguage(options) {
  const { env, db, song, store, targetLanguage, deps = {} } = options;
  const signal = requestSignal(deps);
  assertRequestActive(signal);
  let read = deps.initialRead || await store.get(song.id);
  if (deps.checkCurrent) read = await deps.checkCurrent(read);
  assertRequestActive(signal);
  if (!read?.artifact || read.artifact.status !== 'ready') return assessmentResult(read || {}, song, 'unknown', 'missing');
  const target = targetLanguage || deps.lyricConfig?.targetLanguage || deps.aiAccess?.config.targetLanguage || 'en';
  const preparedOptions = { ...options, initialRead: read, effectiveTarget: target };
  const owner = signal || deps.consumerContext;
  const scope = env?.DB || db || store;
  if (!owner || !['object', 'function'].includes(typeof owner)
    || !scope || !['object', 'function'].includes(typeof scope)) {
    return awaitOwnedRequest(() => prepareLanguage(preparedOptions), signal);
  }
  let scopes = assessmentFlights.get(owner);
  if (!scopes) assessmentFlights.set(owner, scopes = new WeakMap());
  let flights = scopes.get(scope);
  if (!flights) scopes.set(scope, flights = new Map());
  const key = JSON.stringify([song.id, read.artifact.textHash, song.language, target, deps.keepPending === true, deps.skipExistingTranslation === true]);
  if (flights.has(key)) return flights.get(key);
  const task = awaitOwnedRequest(() => prepareLanguage(preparedOptions), signal)
    .finally(() => { if (flights.get(key) === task) flights.delete(key); });
  flights.set(key, task);
  return task;
}

async function prepareLanguage({ env, db, song, store, initialRead: read, effectiveTarget: target, deps = {} }) {
  const signal = requestSignal(deps);
  assertRequestActive(signal);
  if (!deps.skipExistingTranslation && projectLyricArtifact(read.artifact, { song, targetLanguage: target })?.translation) {
    return assessmentResult(read, song, 'needed', 'existing_translation', lyricLanguageTag(song.language));
  }
  let need = dominantLyricTranslationNeed(read.artifact, song, { targetLanguage: target });
  const currentDecision = getCurrentLyricTranslationDecision(read.artifact, song, { targetLanguage: target });
  if (currentDecision) return assessmentResult(read, song, need.state, need.reason, need.sourceLanguage);
  let access = deps.aiAccess;
  let inferred = null;
  const originalHash = read.artifact.textHash;
  const fail = async (code, diagnostic) => {
    assertRequestActive(signal);
    const latest = read;
    if (latest?.artifact?.status !== 'ready' || latest.artifact.textHash !== originalHash || !latest.etag) {
      return assessmentResult(latest || read, song, 'unknown', 'superseded');
    }
    const timestamp = new Date((deps.now || Date.now)()).toISOString();
    assertRequestActive(signal);
    const failed = await store.putIfMatch(song.id, { ...latest.artifact,
      aiCompletion: { status: 'failed', errorCode: code, updatedAt: timestamp }, updatedAt: timestamp }, latest.etag,
    { automation: latest.automation });
    if (failed.state !== 'updated') return assessmentResult(await store.get(song.id), song, 'unknown', 'superseded');
    return assessmentResult(failed, song, 'unknown', code, null, diagnostic);
  };
  try {
    if (need.reason === 'invalid_target') throw markValidationFailure(new Error('INVALID_TARGET_LANGUAGE'), 'setup');
    if (need.state === 'unknown') {
      access ||= await createLyricsAiAccess({ env, db, session: deps.session,
        context: deps.consumerContext, signal: deps.signal, deps });
      if (access.config.completionEnabled === false) return assessmentResult(read, song, 'unknown', 'ai_disabled');
      db = access.db;
      store = guardLyricsStore(store, access.client.assertCurrent);
      await access.client.assertCurrent();
      assertRequestActive(signal);
      const now = (deps.now || Date.now)();
      if (!deps.keepPending && isFreshLyricAiPending(read.artifact.aiCompletion, now)) {
        return assessmentResult(read, song, 'unknown', 'pending');
      }
      if (!deps.keepPending) {
        access.budget?.requireSettlementRoom();
        const timestamp = new Date(now).toISOString();
        assertRequestActive(signal);
        const pending = await store.putIfMatch(song.id, { ...read.artifact,
          aiCompletion: { status: 'pending', updatedAt: timestamp }, updatedAt: timestamp }, read.etag,
        { automation: read.automation });
        if (pending.state !== 'updated') return assessmentResult(await store.get(song.id), song, 'unknown', 'superseded');
        read = found(pending);
      }
      const decision = await completionDeadline(deps, async deadline => {
        const reserved = await (deps.reserveDailyQuota || reserveDailyQuota)(db, dateKey(now), getDailyLyricCompletionLimit(env), now);
        if (!reserved) throw new Error('AI_QUOTA_EXHAUSTED');
        assertRequestActive(signal);
        const response = await awaitOwnedRequest(() => askModel(access, buildLanguageAssessmentPrompt(read.artifact.original, song), deadline), signal);
        assertRequestActive(signal);
        return validateCompletion(() => parseLanguageAssessmentResponse(response), 'validation');
      });
      if (!decision.language) return fail('language_assessment_undetermined');
      inferred = decision.language;
      need = dominantLyricTranslationNeed(read.artifact, { ...song, language: inferred }, { targetLanguage: target });
    }
    assertRequestActive(signal);
    const effectiveSong = localSong(song, inferred);
    const latest = read;
    if (latest?.artifact?.status !== 'ready' || latest.artifact.textHash !== originalHash || !latest.etag) {
      return assessmentResult(latest || read, song, 'unknown', 'superseded');
    }
    const timestamp = new Date((deps.now || Date.now)()).toISOString();
    const sourceLanguage = need.sourceLanguage || inferred;
    const decision = buildLyricTranslationDecision(latest.artifact, effectiveSong, {
      status: need.state === 'not_needed' ? 'not_needed' : 'needed', targetLanguage: target,
      sourceLanguage, basis: inferred || sourceLanguage && !lyricLanguageTag(song.language) ? 'ai' : sourceLanguage ? 'tag' : 'rules',
    });
    assertRequestActive(signal);
    const saved = await store.putIfMatch(song.id, { ...latest.artifact, translationDecision: decision,
      aiCompletion: deps.keepPending ? latest.artifact.aiCompletion
        : { status: 'completed', processingKey: completionKey(access?.config || deps.lyricConfig, target), updatedAt: timestamp },
      updatedAt: timestamp }, latest.etag, { automation: latest.automation });
    if (saved.state !== 'updated') return assessmentResult(await store.get(song.id), song, 'unknown', 'superseded');
    assertRequestActive(signal);
    const finished = inferred ? await finishWithInferredLanguage(store, db, song, saved, inferred, deps) : saved;
    if (finished.artifact?.aiCompletion?.status === 'failed') return assessmentResult(finished, song, 'unknown', 'language_assessment_failed');
    return assessmentResult(finished, effectiveSong, need.state, inferred ? 'ai_language' : need.reason, sourceLanguage);
  } catch (error) {
    assertRequestActive(signal);
    if (/PLUGIN_|AUTH|LYRIC_RESULT_STALE|LYRIC_SONG_DELETED/u.test(String(error?.code || error?.message || ''))) throw error;
    try { await access?.client.assertCurrent(); } catch { throw new Error('LYRIC_RESULT_STALE'); }
    const diagnostic = safeLyricValidationDiagnostic(validationFailures.get(error));
    return fail(String(error?.message || '').includes('TIMEOUT') ? 'language_assessment_timeout' : 'language_assessment_failed', diagnostic);
  }
}

export async function runLyricAssetAiCompletion({ env, db, song, store, startedAt, textHash,
  actorAccountId = null, force = false, deps = {} }) {
  let access, lease, completionSnapshot;
  try {
    lease = deps.aiAccess?.lease || deps.aiLease || await createLyricsAiLease({ env,
      session: deps.session, context: deps.consumerContext, deps });
    if (!deps.aiAccess) await lease.assertCurrent();
  } catch { return { state: 'unavailable' }; }
  try {
    access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
      context: deps.consumerContext, signal: deps.signal, deps: { ...deps, aiLease: lease } });
  } catch (error) {
    try { await lease.assertCurrent(); } catch { return { state: 'superseded' }; }
    return conditionallyFinish(guardLyricsStore(store, lease.assertCurrent), song.id, startedAt, textHash,
      current => ({ ...current, aiCompletion: { status: 'failed', errorCode: safeErrorCode(error),
        updatedAt: new Date((deps.now || Date.now)()).toISOString() } }));
  }
  db = access.db;
  store = guardLyricsStore(store, access.client.assertCurrent);
  try {
    let read = deps.initialRead || await store.get(song.id);
    completionSnapshot = read;
    if (read.state !== 'found' || read.artifact?.status !== 'ready' || read.artifact.textHash !== textHash
      || read.artifact.aiCompletion?.status !== 'pending' || read.artifact.aiCompletion.updatedAt !== startedAt) return { state: 'superseded' };
    const config = access.config;
    if (config.completionEnabled === false) return conditionallyFinish(store, song.id, startedAt, textHash,
      current => ({ ...current, aiCompletion: null }), read);
    const targetLanguage = config.targetLanguage || 'en';
    const prepared = await prepareLyricLanguage({ env, db, song, store, actorAccountId, targetLanguage,
      deps: { ...deps, aiAccess: access, initialRead: read, keepPending: true, skipExistingTranslation: force } });
    read = prepared.read;
    completionSnapshot = read;
    song = prepared.song;
    if (prepared.need === 'unknown') return prepared.diagnostic ? { ...read, diagnostic: prepared.diagnostic } : read;
    const translateLyrics = config.translateLyrics !== false && prepared.need === 'needed';
    const cleanDirtyLyrics = config.cleanDirtyLyrics === true;
    if (!translateLyrics && !cleanDirtyLyrics) {
      const timestamp = new Date((deps.now || Date.now)()).toISOString();
      return conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
        aiCompletion: { status: 'completed', processingKey: completionKey(config, targetLanguage), updatedAt: timestamp }, updatedAt: timestamp }), read);
    }
    return await completionDeadline(deps, async deadline => {
      const artifact = read.artifact;
      const units = completionUnits(artifact.original, song);
      if (!units.length) throw markValidationFailure(new Error('NO_TRANSLATABLE_LINES'), 'setup');
      const now = (deps.now || Date.now)();
      const quota = await (deps.reserveDailyQuota || reserveDailyQuota)(db, dateKey(now), getDailyLyricCompletionLimit(env), now);
      if (!quota) throw new Error('AI_QUOTA_EXHAUSTED');
      const selectedCleanup = cleanDirtyLyrics ? cleanupUnits(artifact.original) : [];
      const allowedCleanupIndices = new Set(selectedCleanup.map(row => row.index));
      const discarded = new Set();
      const translated = new Map();
      const referenceByUnitId = config.referenceExistingTranslation && artifact.translation?.language === targetLanguage
        ? new Map(artifact.translation.lines.map((text, unitId) => [unitId, text])) : null;
      const compact = (config.source || config.provider) === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(config.model);
      const batches = translateLyrics ? validateCompletion(() => buildTranslationBatches(units, song.title, song.artist,
        { targetLanguage, referenceByUnitId, ...(compact ? { maxUnits: 40 } : {}) }), 'setup') : [{ units, messages: [
        { role: 'system', content: 'Perform only the explicitly requested lyric cleanup. Return exactly {"discardLineIndices":[0]}; no translations, language assessment or other fields.\n' + CLEANUP_INSTRUCTION },
        { role: 'user', content: JSON.stringify({ cleanupUnits: selectedCleanup }) },
      ] }];
      let retriedInvalidJson = false;
      for (const [index, batch] of batches.entries()) {
        let messages = batch.messages;
        if (cleanDirtyLyrics && translateLyrics && index === 0) messages = [
          { ...messages[0], content: messages[0].content + '\n\n' + CLEANUP_INSTRUCTION },
          ...messages.slice(1, -1),
          { ...messages.at(-1), content: JSON.stringify({ ...JSON.parse(messages.at(-1).content), cleanupUnits: selectedCleanup }) },
        ];
        const parse = response => validateCompletion(() => parseLanguageAwareTranslationResponse(response, batch.units,
          { targetLanguage, allowedCleanupIndices: cleanDirtyLyrics && index === 0 ? allowedCleanupIndices : undefined,
            analysisOnly: !translateLyrics }), 'validation', index);
        let parsed;
        try { parsed = parse(await askModel(access, messages, deadline)); }
        catch (error) {
          if (error?.message !== 'INVALID_JSON' || retriedInvalidJson) throw error;
          retriedInvalidJson = true;
          parsed = parse(await askModel(access, messages.map((message, i) => i ? message : { ...message,
            content: message.content + '\nReturn syntactically valid JSON only. Repeat the original task; no explanation.' }), deadline));
        }
        parsed.discardLineIndices.forEach(value => discarded.add(value));
        parsed.translations?.forEach(({ unitId, text }) => translated.set(unitId, text));
      }
      if (translateLyrics && translated.size !== units.length) throw markValidationFailure(new Error('INVALID_COVERAGE'), 'finalization');
      access.budget?.settle();
      const completedAt = new Date((deps.now || Date.now)()).toISOString();
      return conditionallyFinish(store, song.id, startedAt, textHash, current => validateCompletion(async () => {
        const next = await applySuggestedCleanup({ ...current,
          ...(translateLyrics ? { translation: { source: 'ai', kind: 'ai', originalTextHash: textHash,
            lines: artifact.original.lines.map((_line, index) => translated.get(index) || ''),
            language: targetLanguage, updatedAt: completedAt } } : {}),
        }, [...discarded], completedAt, song, completionKey(config, targetLanguage));
        const previous = read.artifact.translationDecision;
        next.translationDecision = buildLyricTranslationDecision(next, song, { status: translateLyrics ? 'translated' : prepared.need === 'needed' ? 'needed' : 'not_needed',
          targetLanguage, sourceLanguage: prepared.language, basis: previous?.basis || 'tag' });
        if (translateLyrics && !projectLyricArtifact(next, { song, targetLanguage })?.translation) throw new Error('INVALID_TRANSLATION_OUTPUT');
        return next;
      }, 'finalization'), read);
    });
  } catch (error) {
    access.budget?.settle();
    try { await access.client.assertCurrent(); } catch { return { state: 'superseded' }; }
    const failedAt = new Date((deps.now || Date.now)()).toISOString();
    const failed = await conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
      aiCompletion: { status: 'failed', errorCode: access.budget?.depleted ? 'request_budget_exhausted' : safeErrorCode(error), updatedAt: failedAt }, updatedAt: failedAt }), completionSnapshot);
    const diagnostic = !access.budget?.depleted && safeLyricValidationDiagnostic(validationFailures.get(error));
    return failed.state === 'updated' && diagnostic ? { ...failed, diagnostic } : failed;
  }
}

export async function beginLyricAssetAiCompletion({
  env,
  db,
  song,
  store,
  actorAccountId = null,
  force = false,
  targetLanguage = null,
  automatic = false,
  deps = {},
}) {
  let access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
    context: deps.consumerContext, signal: deps.signal, deps });
  // Automatic work may inherit an old cleanup preference, but only an explicit
  // current workbench cleanup action authorizes deleting original rows.
  if (automatic) access = { ...access, config: { ...access.config, cleanDirtyLyrics: false } };
  db = access.db;
  store = guardLyricsStore(store, access.client.assertCurrent);
  // Internal source adapters may reuse their already authorized snapshot. The
  // pending write below still CAS-checks its ETag before any AI work starts.
  const read = deps.initialRead || await store.get(song.id);
  let current = deps.checkCurrent ? await deps.checkCurrent(read) : read;
  if (current.state !== 'found' || current.artifact.status !== 'ready') {
    return { state: 'missing', task: null };
  }
  const effectiveTarget = targetLanguage || access.config.targetLanguage || 'en';
  if (access.config.translateLyrics !== false && access.config.cleanDirtyLyrics !== true
    && hasCurrentLyricNoTranslationDecision(current.artifact, song, { targetLanguage: effectiveTarget })) {
    return { state: 'not_needed', song, artifact: current.artifact, etag: current.etag, task: null };
  }
  const now = (deps.now || Date.now)();
  if (isFreshLyricAiPending(current.artifact.aiCompletion, now)) {
    return { state: 'pending', artifact: current.artifact, etag: current.etag, task: null };
  }
  const activeLayer = projectLyricArtifact(current.artifact, { song,
    targetLanguage: targetLanguage || access.config.targetLanguage || 'en' })?.translation;
  if (!force && activeLayer) {
    return { state: 'already_translated', artifact: current.artifact, etag: current.etag, task: null };
  }

  if (access.config.completionEnabled === false) return { state: 'unavailable', artifact: current.artifact, etag: current.etag, task: null };
  // One request owns one pending claim across classification and translation.
  // Keep that claim while recording the assessment instead of settling it and
  // immediately issuing an identical second pending write.
  let classificationClaim = null;
  if (dominantLyricTranslationNeed(current.artifact, song, { targetLanguage: effectiveTarget }).state === 'unknown') {
    const claimedAt = new Date((deps.now || Date.now)()).toISOString();
    access.budget?.requireSettlementRoom();
    const claimed = await store.putIfMatch(song.id, { ...current.artifact,
      aiCompletion: { status: 'pending', updatedAt: claimedAt }, updatedAt: claimedAt }, current.etag,
    { automation: automatic ? current.automation : undefined });
    if (claimed.state !== 'updated') {
      const winner = await store.get(song.id);
      return winner.state === 'found' && isFreshLyricAiPending(winner.artifact?.aiCompletion, now)
        ? { state: 'pending', artifact: winner.artifact, etag: winner.etag, task: null } : { state: 'conflict', task: null };
    }
    current = { ...claimed, state: 'found' };
    classificationClaim = { startedAt: claimedAt, textHash: claimed.artifact.textHash };
  }
  const prepared = await prepareLyricLanguage({ env, db, song, store, actorAccountId, targetLanguage: effectiveTarget,
    deps: { ...deps, aiAccess: access, initialRead: current, skipExistingTranslation: force,
      keepPending: Boolean(classificationClaim) } });
  current = prepared.read;
  song = prepared.song;
  if (prepared.reason === 'superseded') return { state: 'conflict', task: null };
  if (prepared.need === 'unknown') return { state: current.artifact?.aiCompletion?.status === 'pending' ? 'pending' : 'failed',
    artifact: current.artifact, etag: current.etag, diagnostic: prepared.diagnostic, task: null };
  if (prepared.need === 'not_needed' && access.config.cleanDirtyLyrics !== true) {
    if (classificationClaim) {
      const completedAt = new Date((deps.now || Date.now)()).toISOString();
      const completed = await conditionallyFinish(store, song.id, classificationClaim.startedAt, classificationClaim.textHash,
        artifact => ({ ...artifact, aiCompletion: { status: 'completed', processingKey: completionKey(access.config, effectiveTarget), updatedAt: completedAt }, updatedAt: completedAt }));
      if (completed.state !== 'updated') return { state: 'conflict', task: null };
      current = { ...completed, state: 'found' };
    }
    return { state: 'not_needed', song, artifact: current.artifact, etag: current.etag, task: null };
  }
  const startedAt = classificationClaim?.startedAt || new Date((deps.now || Date.now)()).toISOString();
  const pending = {
    ...current.artifact,
    aiCompletion: { status: 'pending', updatedAt: startedAt },
    updatedAt: startedAt,
  };
  access.budget?.requireSettlementRoom();
  const written = classificationClaim ? current : await store.putIfMatch(song.id, pending, current.etag,
    { automation: automatic ? current.automation : undefined });
  if (written.state === 'conflict') {
    const winner = await store.get(song.id);
    if (winner.state === 'found'
      && winner.artifact.status === 'ready'
      && isFreshLyricAiPending(winner.artifact.aiCompletion, now)) {
      return { state: 'pending', artifact: winner.artifact, etag: winner.etag, task: null };
    }
    return { state: 'conflict', task: null };
  }
  return {
    state: 'started',
    song,
    artifact: written.artifact,
    etag: written.etag,
    automation: written.automation,
    task: runLyricAssetAiCompletion({
      env,
      db,
      song,
      store,
      startedAt,
      textHash: written.artifact.textHash,
      actorAccountId,
      force,
      deps: { ...deps, aiAccess: access, initialRead: { ...written, state: 'found' } },
    }),
  };
}
