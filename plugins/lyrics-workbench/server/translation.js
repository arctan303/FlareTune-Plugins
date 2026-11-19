import { createLyricsAiAccess, createLyricsAiLease, guardLyricsStore } from "./aiAccess.js";
import { DEFAULT_LYRIC_AI_CONFIG, lyricAiProcessingKey } from "./policy.js";
import { reserveDailyQuota } from "./usage.js";
import { buildWholeSongCompletionPrompt, parseWholeSongCompletionResponse } from "./completionFormat.js";
import { createLyricDocument, isSingableLineText, isLeadingProviderMetadata } from "@flaretune/plugin-sdk/server/lyric-document";
import { computeHash } from "@flaretune/plugin-sdk/server/lyric-parsing";
import {
  isFreshLyricAiPending,
  projectLyricArtifact,
  lyricTextForHash,
  hasCurrentLyricNoTranslationDecision,
  buildLyricTranslationDecision,
} from "@flaretune/plugin-sdk/server/lyric-workflow";

import { dominantLyricTranslationNeed, lyricLanguageTag, buildLanguageAssessmentPrompt, parseLanguageAssessmentResponse } from './languageAssessment.js';
import { automaticCompletionAllowed } from './automaticRetry.js';
export { dominantLyricTranslationNeed } from './languageAssessment.js';

const AI_REQUEST_TIMEOUT_MS = 90_000;
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
// Unset means statistics only. An explicitly configured instance limit,
// including zero, keeps its existing meaning.
export function getDailyLyricCompletionLimit(env) {
  if (env?.AI_TRANSLATION_DAILY_LIMIT === undefined || env?.AI_TRANSLATION_DAILY_LIMIT === null) return null;
  const configured = Number(env.AI_TRANSLATION_DAILY_LIMIT);
  if (!Number.isFinite(configured) || configured < 0) throw new Error('AI_CONFIG_INVALID');
  return Math.floor(configured);
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
  return original.lines.map((line, index) => ({ index, text: String(line.text || '').trim() }))
    .filter(({ text }) => text);
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

function requestSignal(deps) {
  return deps.signal || deps.consumerContext?.signal || null;
}
function assertRequestActive(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('LYRIC_REQUEST_ABORTED'), { name: 'AbortError' });
}
const completionKey = (config, targetLanguage) => lyricAiProcessingKey({ ...DEFAULT_LYRIC_AI_CONFIG, ...config, targetLanguage });
const found = read => ({ ...read, state: 'found' });
const assessmentResult = (read, song, need, reason, language = null) => ({ read: found(read), song, language, need, reason });

// Preparation owns only the short language response. Its persisted decision
// can be reused by a later translation request without holding a pending claim.
export async function prepareLyricLanguage({ env, db, song, store, targetLanguage, force = false, deps = {} }) {
  const signal = requestSignal(deps); assertRequestActive(signal);
  let read = deps.initialRead || await store.get(song.id);
  if (deps.checkCurrent) read = await deps.checkCurrent(read);
  assertRequestActive(signal);
  if (read?.artifact?.status !== 'ready') return assessmentResult(read || {}, song, 'unknown', 'missing');
  const target = targetLanguage || deps.lyricConfig?.targetLanguage || deps.aiAccess?.config.targetLanguage || 'en';
  const need = dominantLyricTranslationNeed(read.artifact, song, { targetLanguage: target });
  if (need.state !== 'unknown' || need.reason !== 'unknown_language') return assessmentResult(read, song, need.state, need.reason, need.sourceLanguage);
  const ownedPending = deps.ownedLanguagePendingAt && read.artifact.aiCompletion?.status === 'pending'
    && read.artifact.aiCompletion.updatedAt === deps.ownedLanguagePendingAt;
  if (!ownedPending && isFreshLyricAiPending(read.artifact.aiCompletion, (deps.now || Date.now)())) return assessmentResult(read, song, 'unknown', 'pending');
  if (!ownedPending && !force && !deps.retryFailed && ['failed', 'pending'].includes(read.artifact.aiCompletion?.status)) {
    return assessmentResult(read, song, 'unknown', 'failed');
  }
  let access;
  try { access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
    context: deps.consumerContext, signal, deps }); }
  catch { return assessmentResult(read, song, 'unknown', 'unavailable'); }
  if (access.config.completionEnabled === false) return assessmentResult(read, song, 'unknown', 'unavailable');
  access = { ...access, config: { ...access.config, targetLanguage: target } };
  store = guardLyricsStore(store, access.client.assertCurrent);
  const startedAt = ownedPending ? read.artifact.aiCompletion.updatedAt : new Date((deps.now || Date.now)()).toISOString();
  if (!ownedPending) {
    const claimed = await store.putIfMatch(song.id, { ...read.artifact,
      aiCompletion: { status: 'pending', updatedAt: startedAt }, updatedAt: startedAt }, read.etag, { automation: read.automation });
    if (claimed.state !== 'updated') {
      const winner = await store.get(song.id);
      const winnerNeed = dominantLyricTranslationNeed(winner.artifact, song, { targetLanguage: target });
      return assessmentResult(winner, song, winnerNeed.state, winnerNeed.state === 'unknown' ? 'pending' : winnerNeed.reason, winnerNeed.sourceLanguage);
    }
    read = found(claimed);
  }
  const textHash = read.artifact.textHash;
  try {
    const language = await classifyLanguage(access, read.artifact, song, env, deps);
    const spoken = value => /^zh(?:-|$)/u.test(value || '') ? 'zh' : value;
    const state = spoken(language) === spoken(target) ? 'not_needed' : 'needed';
    const timestamp = new Date((deps.now || Date.now)()).toISOString();
    const saved = await conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
      translationDecision: completionDecision(current, song, target, state, language),
      aiCompletion: state === 'not_needed' ? { status: 'completed', processingKey: completionKey(access.config, target), updatedAt: timestamp } : null,
      updatedAt: timestamp }), read);
    if (saved.state !== 'updated') return assessmentResult(saved, song, 'unknown', 'superseded');
    return assessmentResult(saved, song, state, 'assessed_language', language);
  } catch (error) {
    if (signal?.aborted) return assessmentResult(read, song, 'unknown', 'superseded');
    try { await access.client.assertCurrent(); } catch { return assessmentResult(read, song, 'unknown', 'superseded'); }
    const timestamp = new Date((deps.now || Date.now)()).toISOString();
    const failed = await conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
      aiCompletion: { status: 'failed', errorCode: safeErrorCode(error), updatedAt: timestamp }, updatedAt: timestamp }), read);
    return assessmentResult(failed, song, 'unknown', failed.state === 'updated' ? 'failed' : 'superseded');
  }
}

async function classifyLanguage(access, artifact, song, env, deps) {
  const messages = validateCompletion(() => buildLanguageAssessmentPrompt(artifact.original, song), 'setup');
  const now = (deps.now || Date.now)();
  if (!await (deps.reserveDailyQuota || reserveDailyQuota)(access.db, dateKey(now), getDailyLyricCompletionLimit(env), now)) throw new Error('AI_QUOTA_EXHAUSTED');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await askModel(access, attempt ? messages.map((message, index) => index ? message : { ...message,
      content: message.content + '\nThe previous output was invalid. Return only the required language and numeric match JSON object.' }) : messages, deps);
    assertRequestActive(requestSignal(deps));
    try {
      const parsed = validateCompletion(() => parseLanguageAssessmentResponse(response), 'validation');
      if (!parsed.language) throw markValidationFailure(new Error('LANGUAGE_UNDETERMINED'), 'validation');
      return parsed.language;
    } catch (error) { if (attempt || !validationFailures.has(error)) throw error; }
  }
}

async function askModel(access, messages, deps) {
  const signal = requestSignal(deps); assertRequestActive(signal);
  // The gateway's existing per-request timeout is 90s. Retain the bounded test
  // override, but no 24s task deadline or request-local database budget.
  const requested = Number(deps.modelTimeoutMs ?? deps.completionDeadlineMs);
  let timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, AI_REQUEST_TIMEOUT_MS) : AI_REQUEST_TIMEOUT_MS;
  const automaticDeadline = Number(deps.automaticDeadlineAt);
  if (Number.isFinite(automaticDeadline)) {
    const remaining = automaticDeadline - (deps.now || Date.now)();
    if (remaining <= 0) throw completionTimeoutError();
    timeoutMs = Math.min(timeoutMs, remaining);
  }
  const controller = new AbortController();
  const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const options = { ...(access.config.temperature === undefined ? {} : { temperature: access.config.temperature }),
    ...((access.config.source || access.config.provider) === 'deepseek' ? { enableThinking: false } : {}) };
  let timer, interrupted;
  try {
    return await Promise.race([
      access.client.ask(messages, options, { timeoutMs, signal: linked }),
      new Promise((_resolve, reject) => {
        interrupted = () => reject(controller.signal.aborted ? completionTimeoutError()
          : signal?.reason || Object.assign(new Error('LYRIC_REQUEST_ABORTED'), { name: 'AbortError' }));
        linked.addEventListener('abort', interrupted, { once: true });
        if (linked.aborted) interrupted();
        timer = setTimeout(() => controller.abort('model_timeout'), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); linked.removeEventListener('abort', interrupted); }
}

function completionDecision(artifact, song, targetLanguage, need, sourceLanguage) {
  return buildLyricTranslationDecision(artifact, song, { status: need, targetLanguage, sourceLanguage,
    basis: !sourceLanguage ? 'rules' : lyricLanguageTag(song.language) ? 'tag' : 'ai' });
}

export async function runLyricAssetAiCompletion({ env, db, song, store, startedAt, textHash,
  actorAccountId = null, force = false, deps = {} }) {
  let access, lease, completionSnapshot;
  const signal = requestSignal(deps);
  try {
    assertRequestActive(signal);
    lease = deps.aiAccess?.lease || deps.aiLease || await createLyricsAiLease({ env,
      session: deps.session, context: deps.consumerContext, deps });
    if (!deps.aiAccess) await lease.assertCurrent();
  } catch { return { state: 'unavailable' }; }
  try {
    access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
      context: deps.consumerContext, signal, deps: { ...deps, aiLease: lease } });
  } catch (error) {
    try { await lease.assertCurrent(); } catch { return { state: 'superseded' }; }
    return await conditionallyFinish(guardLyricsStore(store, lease.assertCurrent), song.id, startedAt, textHash,
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
    const config = access.config, targetLanguage = config.targetLanguage || 'en';
    if (config.completionEnabled === false) return await conditionallyFinish(store, song.id, startedAt, textHash,
      current => ({ ...current, aiCompletion: null }), read);
    let need = dominantLyricTranslationNeed(read.artifact, song, { targetLanguage });
    if (need.reason === 'invalid_target') throw markValidationFailure(new Error('INVALID_TARGET_LANGUAGE'), 'setup');
    const translateLyrics = config.translateLyrics !== false;
    const cleanDirtyLyrics = config.cleanDirtyLyrics === true;
    if (need.state === 'unknown') {
      // Direct/draft callers may already own a pending completion. Resolve its
      // language separately, then acquire a new translation claim from that CAS.
      const prepared = await prepareLyricLanguage({ env, db, song, store, targetLanguage,
        deps: { ...deps, aiAccess: access, initialRead: read, checkCurrent: undefined,
          ownedLanguagePendingAt: startedAt, retryFailed: true } });
      if (prepared.need === 'unknown') return { ...prepared.read, state: prepared.reason === 'superseded' ? 'superseded' : 'failed' };
      read = prepared.read;
      need = dominantLyricTranslationNeed(read.artifact, song, { targetLanguage });
      if (need.state === 'not_needed' && !cleanDirtyLyrics) return { ...read, state: 'updated' };
      startedAt = new Date((deps.now || Date.now)()).toISOString();
      const claimed = await store.putIfMatch(song.id, { ...read.artifact,
        aiCompletion: { status: 'pending', updatedAt: startedAt }, updatedAt: startedAt }, read.etag, { automation: read.automation });
      if (claimed.state !== 'updated') return { state: 'superseded' };
      read = found(claimed); completionSnapshot = read;
    }
    const artifact = read.artifact;
    const units = completionUnits(artifact.original, song);
    if (need.state === 'not_needed' && !cleanDirtyLyrics || !translateLyrics && !cleanDirtyLyrics) {
      const timestamp = new Date((deps.now || Date.now)()).toISOString();
      return await conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
        ...(need.state === 'not_needed' ? { translationDecision: completionDecision(current, song, targetLanguage, 'not_needed', need.sourceLanguage) } : {}),
        aiCompletion: { status: 'completed', processingKey: completionKey(config, targetLanguage), updatedAt: timestamp }, updatedAt: timestamp }), read);
    }
    if (!units.length) throw markValidationFailure(new Error('NO_TRANSLATABLE_LINES'), 'setup');
    const now = (deps.now || Date.now)();
    const quota = await (deps.reserveDailyQuota || reserveDailyQuota)(db, dateKey(now), getDailyLyricCompletionLimit(env), now);
    if (!quota) throw new Error('AI_QUOTA_EXHAUSTED');
    assertRequestActive(signal);
    const selectedCleanup = cleanDirtyLyrics ? cleanupUnits(artifact.original) : undefined;
    const allowedCleanupIndices = selectedCleanup && new Set(selectedCleanup.map(row => row.index));
    const format = { targetLanguage, sourceLanguage: need.sourceLanguage, translateLyrics, allowedCleanupIndices };
    const referenceByUnitId = config.referenceExistingTranslation && artifact.translation?.language === targetLanguage
      ? new Map(artifact.translation.lines.map((text, unitId) => [unitId, text])) : null;
    const messages = validateCompletion(() => buildWholeSongCompletionPrompt(units, song,
      { ...format, referenceByUnitId, cleanupUnits: selectedCleanup }), 'setup');
    let candidate;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Only locally verified output failures get the one repair request.
      // Network, provider, timeout and quota errors leave this loop directly.
      const response = await askModel(access, attempt ? messages.map((message, index) => index ? message : { ...message,
        content: message.content + '\nThe previous output failed validation. Repeat the entire original task with complete coverage and valid JSON only.' }) : messages, deps);
      assertRequestActive(signal);
      try {
        const parsed = validateCompletion(() => parseWholeSongCompletionResponse(response, units, format), 'validation');
        candidate = await validateCompletion(async () => {
          const completedAt = new Date((deps.now || Date.now)()).toISOString();
          const translated = new Map((parsed.translations || []).map(({ unitId, text }) => [unitId, text]));
          const next = await applySuggestedCleanup({ ...artifact,
            ...(parsed.translations ? { translation: { source: 'ai', kind: 'ai', originalTextHash: textHash,
              lines: artifact.original.lines.map((_line, index) => translated.get(index) || ''),
              language: targetLanguage, updatedAt: completedAt } } : {}),
          }, parsed.discardLineIndices, completedAt, song, completionKey(config, targetLanguage));
          next.translationDecision = completionDecision(next, song, targetLanguage,
            parsed.translations ? 'translated' : parsed.needed ? 'needed' : 'not_needed', parsed.sourceLanguage);
          if (parsed.translations && !projectLyricArtifact(next, { song, targetLanguage })?.translation) throw new Error('INVALID_TRANSLATION_OUTPUT');
          return next;
        }, 'finalization');
        break;
      } catch (error) {
        if (attempt || !validationFailures.has(error)) throw error;
      }
    }
    assertRequestActive(signal);
    // Publish only the complete translated result. Preparation may already have
    // saved its independent language decision, but never a partial translation.
    return await conditionallyFinish(store, song.id, startedAt, textHash, () => candidate, read);
  } catch (error) {
    if (signal?.aborted) return { state: 'superseded' };
    try { await access.client.assertCurrent(); } catch { return { state: 'superseded' }; }
    const failedAt = new Date((deps.now || Date.now)()).toISOString();
    const failed = await conditionallyFinish(store, song.id, startedAt, textHash, current => ({ ...current,
      aiCompletion: { status: 'failed', errorCode: safeErrorCode(error), updatedAt: failedAt }, updatedAt: failedAt }), completionSnapshot);
    const diagnostic = safeLyricValidationDiagnostic(validationFailures.get(error));
    return failed.state === 'updated' && diagnostic ? { ...failed, diagnostic } : failed;
  }
}

export async function beginLyricAssetAiCompletion({ env, db, song, store, actorAccountId = null,
  force = false, targetLanguage = null, automatic = false, deps = {} }) {
  const signal = requestSignal(deps); assertRequestActive(signal);
  let access = deps.aiAccess || await createLyricsAiAccess({ env, db, session: deps.session,
    context: deps.consumerContext, signal, deps });
  const effectiveTarget = targetLanguage || access.config.targetLanguage || 'en';
  access = { ...access, config: { ...access.config, targetLanguage: effectiveTarget,
    ...(automatic ? { cleanDirtyLyrics: false } : {}) } };
  db = access.db;
  store = guardLyricsStore(store, access.client.assertCurrent);
  const read = deps.initialRead || await store.get(song.id);
  let current = deps.checkCurrent ? await deps.checkCurrent(read) : read;
  assertRequestActive(signal);
  if (current.state !== 'found' || current.artifact.status !== 'ready') return { state: 'missing', task: null };
  if (isFreshLyricAiPending(current.artifact.aiCompletion, (deps.now || Date.now)())) return { state: 'pending', artifact: current.artifact, etag: current.etag, task: null };
  if (!automaticCompletionAllowed(current.artifact.aiCompletion, automatic)) return { state: 'failed', song, artifact: current.artifact, etag: current.etag, task: null };
  if (!force && projectLyricArtifact(current.artifact, { song, targetLanguage: effectiveTarget })?.translation) return { state: 'already_translated', artifact: current.artifact, etag: current.etag, task: null };
  if (access.config.completionEnabled === false) return { state: 'unavailable', artifact: current.artifact, etag: current.etag, task: null };
  let need = dominantLyricTranslationNeed(current.artifact, song, { targetLanguage: effectiveTarget });
  if (need.state === 'unknown') {
    const prepared = await prepareLyricLanguage({ env, db, song, store, targetLanguage: effectiveTarget,
      deps: { ...deps, aiAccess: access, initialRead: current, checkCurrent: undefined, retryFailed: !automatic } });
    current = prepared.read;
    if (prepared.need === 'unknown') return { state: prepared.reason === 'pending' ? 'pending'
      : prepared.reason === 'unavailable' ? 'unavailable' : prepared.reason === 'superseded' ? 'conflict' : 'failed',
      song, artifact: current.artifact, etag: current.etag, task: null };
    need = dominantLyricTranslationNeed(current.artifact, song, { targetLanguage: effectiveTarget });
  }
  if (need.state === 'not_needed' && access.config.cleanDirtyLyrics !== true) {
    if (hasCurrentLyricNoTranslationDecision(current.artifact, song, { targetLanguage: effectiveTarget })) return { state: 'not_needed', song, artifact: current.artifact, etag: current.etag, task: null };
    const timestamp = new Date((deps.now || Date.now)()).toISOString();
    const next = { ...current.artifact, translationDecision: completionDecision(current.artifact, song, effectiveTarget, 'not_needed', need.sourceLanguage),
      aiCompletion: { status: 'completed', processingKey: completionKey(access.config, effectiveTarget), updatedAt: timestamp }, updatedAt: timestamp };
    const saved = await store.putIfMatch(song.id, next, current.etag, { automation: current.automation });
    return saved.state === 'updated' ? { ...saved, state: 'not_needed', song, task: null } : { state: 'conflict', task: null };
  }
  const startedAt = new Date((deps.now || Date.now)()).toISOString();
  const written = await store.putIfMatch(song.id, { ...current.artifact, aiCompletion: { status: 'pending', updatedAt: startedAt }, updatedAt: startedAt }, current.etag,
    { automation: automatic ? current.automation : undefined });
  if (written.state !== 'updated') {
    const winner = await store.get(song.id);
    return winner.state === 'found' && winner.artifact?.aiCompletion?.status === 'pending'
      ? { state: 'pending', artifact: winner.artifact, etag: winner.etag, task: null } : { state: 'conflict', task: null };
  }
  return { state: 'started', song, artifact: written.artifact, etag: written.etag, automation: written.automation,
    task: runLyricAssetAiCompletion({ env, db, song, store, startedAt, textHash: written.artifact.textHash,
      actorAccountId, force, deps: { ...deps, aiAccess: access, initialRead: { ...written, state: 'found' } } }) };
}
