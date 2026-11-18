import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
import { budgetFailureCode, budgetRetryScope, publicBudgetErrorCode } from './automaticRetry.js';
const { beginLyricAssetAiCompletion: begin, buildReadyLyricArtifact } =
  await loadTestModule(new URL('./translation.js', import.meta.url), { workflow: true });

const budgetError = () => Object.assign(new Error('LYRICS_INVOCATION_BUDGET_EXHAUSTED'), { code: 'LYRICS_INVOCATION_BUDGET_EXHAUSTED' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture({ initial, config = {}, ask, clock = { value: Date.now() } } = {}) {
  const song = { id: 'yt:abcdefghijk', title: 'Fixture', artist: 'Singer', language: 'en' };
  let artifact = initial ? structuredClone(initial) : (await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: [{ text: 'We sing together', time: 1, words: [{ text: 'We', start: 1, end: 1.2 }] }] })).artifact;
  artifact.offsetMs = 125;
  let revision = 1, requestNumber = 0;
  const calls = { ai: 0, quota: 0, writes: 0, assertions: 0, classifications: 0, states: [] };
  const settings = { targetLanguage: 'zh', provider: 'openai', model: 'retry-fixture', completionEnabled: true,
    translateLyrics: true, detectLanguage: true, cleanDirtyLyrics: false, referenceExistingTranslation: false, ...config };
  const env = { DB: {} }, db = {};
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: String(revision) });
  const store = { get: async () => read(), putIfMatch: async (_id, value, etag) => {
    if (etag !== String(revision)) return { state: 'conflict' };
    artifact = structuredClone(value); revision++; calls.writes++; calls.states.push(value.aiCompletion?.status || null);
    return { ...read(), state: 'updated' };
  } };
  const f = { song, env, db, store, calls, config: settings, clock, identity: 'public-provider-capability-1', authorized: true,
    ask: ask || (() => { throw budgetError(); }), read };
  f.start = async ({ automatic = true, force = false, initialRead } = {}) => {
    const requestConfig = structuredClone(settings), context = { request: ++requestNumber };
    let depleted = false;
    const access = { db, config: requestConfig, lease: {}, budget: { get depleted() { return depleted; },
      requireSettlementRoom() {}, settle() {}, executeAi: execute => execute() },
    client: { identity: f.identity, assertCurrent: async () => { calls.assertions++; if (!f.authorized) throw Error('SOURCE_RETIRED'); },
      ask: async messages => {
        calls.ai++;
        const payload = JSON.parse(messages.at(-1).content);
        if (payload.languageTable) calls.classifications++;
        try { return await f.ask(payload, requestConfig); }
        catch (error) { if (error.code === 'LYRICS_INVOCATION_BUDGET_EXHAUSTED') depleted = true; throw error; }
      } } };
    return begin({ env, db, song, store, automatic, force, targetLanguage: requestConfig.targetLanguage,
      deps: { aiAccess: access, consumerContext: context, now: () => clock.value,
        reserveDailyQuota: async () => { calls.quota++; return true; }, ...(initialRead ? { initialRead } : {}) } });
  };
  f.success = (payload, requestConfig) => payload.languageTable ? { language: 'en', match: 0.99 }
    : { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: requestConfig.targetLanguage === 'ja' ? '一緒に歌う' : '我们一起歌唱' })) };
  return f;
}
const failure = async f => { const started = await f.start(); assert.equal(started.state, 'started'); await started.task; return f.read().artifact; };
async function terminal(f) {
  await failure(f); f.clock.value += 60_000; await failure(f);
  assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_retry_exhausted_[a-f0-9]{32}$/u);
}

test('persistent failures cool for sixty seconds, recover once across fresh invocations, then stop without writes or AI', async () => {
  const f = await fixture(); const original = structuredClone(f.read().artifact.original);
  const first = await failure(f);
  assert.match(first.aiCompletion.errorCode, /^request_budget_exhausted_[a-f0-9]{32}$/u);
  const before = structuredClone(f.calls), saved = f.read();
  for (const age of [0, 1000, 59_999]) {
    f.clock.value = Date.parse(first.aiCompletion.updatedAt) + age;
    const blocked = await f.start(); assert.equal(blocked.state, 'failed'); assert.equal(blocked.task, null);
  }
  assert.equal(f.calls.ai, before.ai); assert.equal(f.calls.quota, before.quota); assert.equal(f.calls.writes, before.writes);
  assert.deepEqual(f.read(), saved);
  f.clock.value = Date.parse(first.aiCompletion.updatedAt) + 60_000;
  await failure(f);
  const exhausted = f.read(), counts = structuredClone(f.calls);
  for (const age of [60_000, 3_600_000]) {
    f.clock.value += age; const result = await f.start(); assert.equal(result.state, 'failed'); assert.equal(result.task, null);
  }
  assert.equal(f.calls.ai, counts.ai); assert.equal(f.calls.quota, counts.quota); assert.equal(f.calls.writes, counts.writes);
  assert.deepEqual(f.read(), exhausted); assert.deepEqual(exhausted.artifact.original, original); assert.equal(exhausted.artifact.offsetMs, 125);
  const restarted = await fixture({ initial: exhausted.artifact, clock: f.clock });
  assert.equal((await restarted.start()).state, 'failed'); assert.equal(restarted.calls.ai, 0); assert.equal(restarted.calls.writes, 0);
});

test('explicit POST-style calls bypass cooling, preserve an exhausted same-scope failure, and can complete', async () => {
  const f = await fixture(); await failure(f);
  let explicit = await f.start({ automatic: false }); assert.equal(explicit.state, 'started'); await explicit.task;
  assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_exhausted_/u);
  f.clock.value += 60_000; await failure(f);
  explicit = await f.start({ automatic: false }); await explicit.task;
  assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_retry_exhausted_/u);
  f.ask = f.success;
  explicit = await f.start({ automatic: false }); await explicit.task;
  assert.equal(f.read().artifact.aiCompletion.status, 'completed'); assert.deepEqual(f.read().artifact.translation.lines, ['我们一起歌唱']);
});

test('a changed body, target, model, generation configuration or provider capability opens a new cycle', async t => {
  for (const change of ['body', 'target', 'model', 'options', 'provider']) await t.test(change, async () => {
    const f = await fixture(); await terminal(f); const before = f.calls.ai;
    if (change === 'body') {
      const read = f.read(), original = { ...read.artifact.original, lines: [{ text: 'A different original', time: 2 }] };
      await f.store.putIfMatch(f.song.id, { ...read.artifact, original, textHash: 'b'.repeat(64) }, read.etag);
    } else if (change === 'target') f.config.targetLanguage = 'ja';
    else if (change === 'model') f.config.model = 'retry-fixture-2';
    else if (change === 'options') f.config.generationOptions = { temperature: 0.8 };
    else f.identity = 'public-provider-capability-2';
    const started = await f.start(); assert.equal(started.state, 'started'); await started.task;
    assert.equal(f.calls.ai, before + 1);
    assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_exhausted_[a-f0-9]{32}$/u);
  });
});

test('old unscoped failures are cooled once and a missing decision cannot erase retry ownership during contention', async () => {
  const f = await fixture(), read = f.read();
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: { status: 'failed', errorCode: 'request_budget_exhausted',
    updatedAt: new Date(f.clock.value).toISOString() } }, read.etag);
  const before = f.read(), counts = structuredClone(f.calls);
  assert.equal((await f.start()).state, 'failed'); assert.deepEqual(f.read(), before); assert.equal(f.calls.writes, counts.writes);
  f.clock.value += 60_000;
  const entered = deferred(), reply = deferred(); f.ask = async () => { entered.resolve(); return reply.promise; };
  const snapshot = f.read();
  const attempts = await Promise.all([f.start({ initialRead: snapshot }), f.start({ initialRead: snapshot }), f.start({ initialRead: snapshot })]);
  await entered.promise;
  assert.equal(attempts.filter(result => result.state === 'started').length, 1);
  assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1);
  assert.ok(attempts.filter(result => !result.task).every(result => ['pending', 'conflict'].includes(result.state)));
  reply.reject(budgetError()); await Promise.all(attempts.map(result => result.task));
  assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_retry_exhausted_/u);
  const last = f.read(), finalCalls = structuredClone(f.calls);
  assert.equal((await f.start()).state, 'failed'); assert.deepEqual(f.read(), last); assert.equal(f.calls.ai, finalCalls.ai);
});

test('a budget recovery with no prior language decision never publishes an intermediate completed marker', async () => {
  const f = await fixture(), read = f.read();
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: { status: 'failed', errorCode: 'request_budget_exhausted',
    updatedAt: new Date(f.clock.value).toISOString() } }, read.etag);
  f.clock.value += 60_000; f.calls.states.length = 0;
  await failure(f);
  assert.equal(f.calls.states[0], 'pending');
  assert.ok(!f.calls.states.includes('completed'), 'a second request must never observe completed before the retry owner claims pending');
  assert.match(f.read().artifact.aiCompletion.errorCode, /^request_budget_retry_exhausted_/u);
});

test('crashed pending claims cannot classify or translate on GET, while explicit retry can recover', async () => {
  const f = await fixture(); f.song.language = 'other'; const read = f.read();
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: { status: 'pending', updatedAt: new Date(f.clock.value - 60_000).toISOString() } }, read.etag);
  const before = f.read(), counts = structuredClone(f.calls);
  assert.equal((await f.start()).state, 'failed'); assert.deepEqual(f.read(), before); assert.equal(f.calls.writes, counts.writes); assert.equal(f.calls.ai, 0);
  f.ask = f.success;
  const explicit = await f.start({ automatic: false }); assert.equal(explicit.state, 'started'); await explicit.task;
  assert.equal(f.read().artifact.aiCompletion.status, 'completed'); assert.equal(f.calls.classifications, 1);
});

test('late recovery failures cannot replace edited assets or persist after authority retires', async t => {
  for (const changed of ['edit', 'authority']) await t.test(changed, async () => {
    const f = await fixture(); await failure(f); f.clock.value += 60_000;
    const entered = deferred(), reply = deferred(); f.ask = async () => { entered.resolve(); return reply.promise; };
    const started = await f.start(); await entered.promise;
    if (changed === 'edit') { const read = f.read(); await f.store.putIfMatch(f.song.id, { ...read.artifact, offsetMs: 650, aiCompletion: null }, read.etag); }
    else f.authorized = false;
    const before = f.read(); reply.reject(budgetError());
    assert.equal((await started.task).state, 'superseded'); assert.deepEqual(f.read(), before);
  });
});

test('the retry scope matches actual public configuration and remains compatible with safe persisted error fields', async () => {
  const f = await fixture();
  const scope = await budgetRetryScope({ artifact: f.read().artifact, song: f.song, targetLanguage: 'zh', config: f.config, identity: f.identity });
  const code = budgetFailureCode({ scope, consumed: true });
  assert.equal(code.length, 63); assert.equal(publicBudgetErrorCode(code), 'request_budget_exhausted');
});
