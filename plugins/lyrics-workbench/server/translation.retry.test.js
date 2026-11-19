import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
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
test('a persisted failure remains failed across fresh reads and process-style reloads until an explicit action', async () => {
  const f = await fixture(); await failure(f);
  const saved = f.read(), counts = structuredClone(f.calls);
  for (const age of [0, 60_000, 3_600_000]) {
    f.clock.value += age;
    assert.equal((await f.start()).state, 'failed'); assert.deepEqual(f.read(), saved);
    assert.equal(f.calls.ai, counts.ai); assert.equal(f.calls.quota, counts.quota); assert.equal(f.calls.writes, counts.writes);
  }
  const restarted = await fixture({ initial: saved.artifact, clock: f.clock });
  assert.equal((await restarted.start()).state, 'failed'); assert.equal(restarted.calls.ai, 0); assert.equal(restarted.calls.writes, 0);
  f.ask = f.success;
  const explicit = await f.start({ automatic: false }); await explicit.task;
  assert.equal(f.read().artifact.aiCompletion.status, 'completed');
  assert.deepEqual(f.read().artifact.original, saved.artifact.original); assert.equal(f.read().artifact.offsetMs, 125);
});
test('target or model changes do not restart a failed asset from a GET', async () => {
  const f = await fixture(); await failure(f); const counts = structuredClone(f.calls);
  f.config.targetLanguage = 'ja'; f.config.model = 'another-model'; f.identity = 'another-capability';
  assert.equal((await f.start()).state, 'failed'); assert.equal(f.calls.ai, counts.ai); assert.equal(f.calls.writes, counts.writes);
});
test('old budget-family records and crashed pending claims need explicit recovery before independent classification and translation', async () => {
  for (const completion of [{ status: 'failed', errorCode: 'request_budget_exhausted' },
    { status: 'failed', errorCode: 'request_budget_retry_exhausted_' + 'a'.repeat(32) }, { status: 'pending' }]) {
    const f = await fixture(); f.song.language = 'other'; const read = f.read();
    await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: { ...completion, updatedAt: '2000-01-01T00:00:00.000Z' } }, read.etag);
    const before = f.read(), writes = f.calls.writes;
    assert.equal((await f.start()).state, 'failed'); assert.deepEqual(f.read(), before); assert.equal(f.calls.ai, 0); assert.equal(f.calls.writes, writes);
    f.ask = f.success;
    const explicit = await f.start({ automatic: false }); await explicit.task;
    assert.equal(f.read().artifact.aiCompletion.status, 'completed'); assert.equal(f.calls.ai, 2);
    assert.equal(f.calls.classifications, 1); assert.equal(f.calls.quota, 2);
  }
});
test('three explicit contenders share persistent pending ownership instead of issuing duplicate model requests', async () => {
  const f = await fixture(); await failure(f); const entered = deferred(), reply = deferred();
  const previousCalls = f.calls.ai; f.ask = () => { entered.resolve(); return reply.promise; };
  const initialRead = f.read();
  const attempts = await Promise.all(Array.from({ length: 3 }, () => f.start({ automatic: false, initialRead })));
  await entered.promise; assert.equal(attempts.filter(result => result.state === 'started').length, 1);
  assert.equal(f.calls.ai - previousCalls, 1);
  reply.resolve({ translations: [{ unitId: 0, text: '我们一起歌唱' }] }); await Promise.all(attempts.map(result => result.task));
  assert.equal(f.read().artifact.aiCompletion.status, 'completed');
});
test('late recovery failures cannot replace edited assets or persist after authority retires', async t => {
  for (const changed of ['edit', 'authority']) await t.test(changed, async () => {
    const f = await fixture(); await failure(f); f.clock.value += 60_000;
    const entered = deferred(), reply = deferred(); f.ask = async () => { entered.resolve(); return reply.promise; };
    const started = await f.start({ automatic: false }); await entered.promise;
    if (changed === 'edit') { const read = f.read(); await f.store.putIfMatch(f.song.id, { ...read.artifact, offsetMs: 650, aiCompletion: null }, read.etag); }
    else f.authorized = false;
    const before = f.read(); reply.reject(budgetError());
    assert.equal((await started.task).state, 'superseded'); assert.deepEqual(f.read(), before);
  });
});
