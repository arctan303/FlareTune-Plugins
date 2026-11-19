// Old scoped budget errors remain readable; this version never generates them.
const BUDGET_FAILURE = 'request_budget_exhausted';
const scopedFailure = /^request_budget_(retry_)?exhausted_([a-f0-9]{32})$/u;

// Ordinary reads cannot restart a failed task or an abandoned pending claim.
export const automaticCompletionAllowed = (completion, automatic) => !automatic
  || !['failed', 'pending'].includes(completion?.status);

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
