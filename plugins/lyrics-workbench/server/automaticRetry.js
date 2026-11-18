// Retry state lives in the existing failed completion record, never in an
// isolate-local counter. Public responses keep the pre-existing failure code.
import { normalizeTranslationTarget } from '../shared/translation-languages.js';

export const AUTOMATIC_BUDGET_RETRY_DELAY_MS = 60_000;
const BUDGET_FAILURE = 'request_budget_exhausted';
const scopedFailure = /^request_budget_(retry_)?exhausted_([a-f0-9]{32})$/u;
const modelFields = ['provider', 'source', 'protocol', 'model', 'temperature', 'generationOptions',
  'supportsImages', 'profileId', 'profileRevision', 'featureRevision', 'configurationRevision', 'providerBinding', 'exactModel'];
const processingFields = ['translateLyrics', 'detectLanguage', 'cleanDirtyLyrics', 'referenceExistingTranslation', 'completionEnabled'];
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, stable(value[key])])) : value;
const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
  .map(byte => byte.toString(16).padStart(2, '0')).join('');

export function budgetFailureState(completion) {
  if (completion?.status !== 'failed') return null;
  if (completion.errorCode === BUDGET_FAILURE) return { scope: null, exhausted: false };
  const match = scopedFailure.exec(completion.errorCode || '');
  return match ? { scope: match[2], exhausted: Boolean(match[1]) } : null;
}

export const publicBudgetErrorCode = code => code === BUDGET_FAILURE || scopedFailure.test(code || '') ? BUDGET_FAILURE : code;
export function publicRetryArtifact(artifact) {
  const completion = artifact?.aiCompletion, code = publicBudgetErrorCode(completion?.errorCode);
  return code !== completion?.errorCode ? { ...artifact, aiCompletion: { ...completion, errorCode: code } } : artifact;
}

export async function budgetRetryScope({ artifact, song, targetLanguage, config = {}, identity }) {
  // Only the text hash and a whitelist of public effective configuration enter
  // the fingerprint. Lyrics, titles, prompts, credentials and env stay out.
  const model = Object.fromEntries(modelFields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const processing = Object.fromEntries(processingFields.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
  const value = ['lyric-budget-retry-v1', artifact.textHash, normalizeTranslationTarget(targetLanguage) || targetLanguage,
    song.language || null, model, processing, typeof identity === 'string' ? await hash(identity) : null];
  return (await hash(JSON.stringify(stable(value)))).slice(0, 32);
}

export function automaticBudgetRetry({ completion, scope, automatic, now }) {
  const previous = budgetFailureState(completion);
  const sameScope = previous && (!previous.scope || previous.scope === scope);
  if (!automatic) return { allowed: true, consumed: Boolean(sameScope && previous.exhausted) };
  // A crashed pending claim has lost its retry scope. Do not let language
  // preparation silently make it a fresh automatic task; POST can recover it.
  if (completion?.status === 'pending') return { allowed: false, consumed: true };
  if (!sameScope) return { allowed: true, consumed: false };
  if (previous.exhausted) return { allowed: false, consumed: true };
  const failedAt = Date.parse(completion.updatedAt);
  if (!Number.isFinite(failedAt) || now - failedAt < AUTOMATIC_BUDGET_RETRY_DELAY_MS) return { allowed: false, consumed: false };
  return { allowed: true, consumed: true };
}

export const budgetFailureCode = ({ scope, consumed } = {}) => scope
  ? `request_budget_${consumed ? 'retry_' : ''}exhausted_${scope}` : BUDGET_FAILURE;
