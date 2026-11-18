import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticBudgetRetry, budgetFailureCode, budgetFailureState, budgetRetryScope,
  publicBudgetErrorCode, publicRetryArtifact } from './automaticRetry.js';

const start = Date.parse('2026-11-18T00:00:00.000Z');
const scope = 'a'.repeat(32);
const failure = (exhausted = false) => ({ status: 'failed', errorCode: budgetFailureCode({ scope, consumed: exhausted }), updatedAt: new Date(start).toISOString() });
test('existing schema-safe failure codes persist a cooldown and one recovery across fresh policy calls', () => {
  for (const completion of [failure(), { ...failure(), errorCode: 'request_budget_exhausted' }]) {
    for (const elapsed of [0, 59_999]) assert.equal(automaticBudgetRetry({ completion, scope, automatic: true, now: start + elapsed }).allowed, false);
    assert.deepEqual(automaticBudgetRetry({ completion, scope, automatic: true, now: start + 60_000 }), { allowed: true, consumed: true });
  }
  assert.equal(automaticBudgetRetry({ completion: failure(true), scope, automatic: true, now: start + 3_600_000 }).allowed, false);
  for (const consumed of [false, true]) assert.match(budgetFailureCode({ scope, consumed }), /^[a-z0-9][a-z0-9_]{0,63}$/u);
});
test('explicit actions bypass the cooldown without restoring an already consumed same-scope recovery', () => {
  assert.deepEqual(automaticBudgetRetry({ completion: failure(), scope, automatic: false, now: start }), { allowed: true, consumed: false });
  assert.deepEqual(automaticBudgetRetry({ completion: failure(true), scope, automatic: false, now: start }), { allowed: true, consumed: true });
  assert.deepEqual(automaticBudgetRetry({ completion: failure(true), scope: 'b'.repeat(32), automatic: true, now: start }), { allowed: true, consumed: false });
  assert.equal(automaticBudgetRetry({ completion: { status: 'pending', updatedAt: new Date(start).toISOString() }, scope, automatic: true, now: start + 60_000 }).allowed, false);
});
test('scope binds actual input and public model configuration with stable ordering, without private fields', async () => {
  const value = { artifact: { textHash: 'a'.repeat(64), original: { lines: [{ text: 'private original' }] } }, song: { language: 'en', title: 'private title' },
    targetLanguage: 'zh-CN', config: { model: 'm1', provider: 'deepseek', generationOptions: { temperature: 0.2, maxTokens: 1000 }, privateKey: 'never hashed', systemPrompt: 'private prompt' }, identity: 'provider-capability-1' };
  const first = await budgetRetryScope(value);
  assert.equal(first.length, 32);
  assert.equal(await budgetRetryScope({ ...value, targetLanguage: 'zh', config: { ...value.config, generationOptions: { maxTokens: 1000, temperature: 0.2 }, privateKey: 'changed secret', systemPrompt: 'changed prompt' },
    artifact: { ...value.artifact, original: {} }, song: { ...value.song, title: 'another title' } }), first);
  for (const changed of [{ targetLanguage: 'ja' }, { artifact: { ...value.artifact, textHash: 'b'.repeat(64) } },
    { config: { ...value.config, model: 'm2' } }, { identity: 'provider-capability-2' }, { song: { ...value.song, language: 'ja' } }]) {
    assert.notEqual(await budgetRetryScope({ ...value, ...changed }), first);
  }
});
test('public projections remove private retry identity without mutating persisted state', () => {
  for (const consumed of [false, true]) {
    const artifact = { aiCompletion: failure(consumed), original: { lines: [] } };
    const publicArtifact = publicRetryArtifact(artifact);
    assert.equal(publicArtifact.aiCompletion.errorCode, 'request_budget_exhausted');
    assert.equal(artifact.aiCompletion.errorCode, budgetFailureCode({ scope, consumed }));
    assert.deepEqual(budgetFailureState(artifact.aiCompletion), { scope, exhausted: consumed });
  }
  assert.equal(publicBudgetErrorCode('invalid_output'), 'invalid_output');
  assert.equal(budgetFailureState({ status: 'failed', errorCode: 'request_budget_exhausted_not_a_scope' }), null);
});
