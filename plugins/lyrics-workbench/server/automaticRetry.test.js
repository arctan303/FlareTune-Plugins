import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticCompletionAllowed, budgetFailureState, publicBudgetErrorCode, publicRetryArtifact } from './automaticRetry.js';

test('ordinary reads never restart any persisted failure regardless of its age or legacy budget family', () => {
  for (const errorCode of ['invalid_output', 'ai_timeout', 'request_budget_exhausted',
    'request_budget_exhausted_' + 'a'.repeat(32), 'request_budget_retry_exhausted_' + 'b'.repeat(32)]) {
    const completion = { status: 'failed', errorCode, updatedAt: '2000-01-01T00:00:00.000Z' };
    assert.equal(automaticCompletionAllowed(completion, true), false);
    assert.equal(automaticCompletionAllowed(completion, false), true);
  }
  assert.equal(automaticCompletionAllowed({ status: 'pending' }, true), false);
  assert.equal(automaticCompletionAllowed(null, true), true);
  assert.equal(automaticCompletionAllowed({ status: 'completed' }, true), true);
});
test('old scoped budget errors still project to the established public code without rewriting stored bytes', () => {
  for (const prefix of ['request_budget_exhausted_', 'request_budget_retry_exhausted_']) {
    const artifact = { aiCompletion: { status: 'failed', errorCode: prefix + 'a'.repeat(32) } };
    assert.equal(publicRetryArtifact(artifact).aiCompletion.errorCode, 'request_budget_exhausted');
    assert.equal(artifact.aiCompletion.errorCode, prefix + 'a'.repeat(32));
    assert.equal(budgetFailureState(artifact.aiCompletion).scope, 'a'.repeat(32));
  }
  assert.equal(publicBudgetErrorCode('invalid_output'), 'invalid_output');
});
