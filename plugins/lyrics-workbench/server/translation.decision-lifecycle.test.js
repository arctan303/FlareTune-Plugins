import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { beginLyricAssetAiCompletion: begin, prepareLyricLanguage: prepare, buildReadyLyricArtifact } =
  await loadTestModule(new URL('./translation.js', import.meta.url), { workflow: true });

async function fixture({ language = 'other', targetLanguage = 'zh', texts = ['风吹过窗前', 'I will wait for you'],
  id = 'yt:abcdefghijk', ask = async () => ({ language: 'zh', match: 0.95 }), updateSongLanguage,
  now = Date.now } = {}) {
  const song = { id, title: 'Fixture', artist: 'Singer', language };
  const env = { DB: {} }, db = {};
  let artifact = (await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: texts.map((text, index) => ({ time: index + 1, text, words: [{ text, start: index + 1, end: index + 1.5 }] })) })).artifact;
  let revision = 1;
  const calls = { ai: 0, quota: 0, roles: [], writes: 0, statuses: [], limits: [] };
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: String(revision) });
  const store = { get: async () => read(), putIfMatch: async (_id, next, etag) => {
    if (etag !== String(revision)) return { state: 'conflict' };
    artifact = structuredClone(next); revision++; calls.writes++; calls.statuses.push(next.aiCompletion?.status); return { ...read(), state: 'updated' };
  } };
  const config = { targetLanguage, provider: 'openai', model: 'fixture', completionEnabled: true,
    automaticCompletionEnabled: true, translateLyrics: true, detectLanguage: true, cleanDirtyLyrics: false,
    referenceExistingTranslation: false };
  const access = { db, config, lease: {}, client: { assertCurrent: async () => {}, ask: async (messages, ...args) => {
    calls.ai++;
    const payload = JSON.parse(messages.at(-1).content);
    calls.roles.push(payload.languageTable ? 'classify' : 'translate');
    return ask(messages, ...args);
  } } };
  const deps = { aiAccess: access, now, updateSongLanguage, reserveDailyQuota: async (_db, _day, limit) => { calls.quota++; calls.limits.push(limit); return true; } };
  const start = (options = {}) => begin({ env, db, song, store, force: options.force, automatic: options.automatic ?? true, targetLanguage: config.targetLanguage,
    deps: { ...deps, ...options.deps } });
  const assess = (options = {}) => prepare({ env, db, song, store, targetLanguage: config.targetLanguage,
    deps: { ...deps, ...options.deps } });
  return { song, env, db, config, store, calls, start, assess };
}

test('a dominant same-target catalog tag skips AI and caches a complete no-translation decision once', async () => {
  const f = await fixture({ language: 'zh', ask: () => assert.fail('No model needed') });
  const first = await f.start(); assert.equal(first.state, 'not_needed'); assert.equal(first.task, null);
  const artifact = (await f.store.get()).artifact;
  assert.equal(artifact.translationDecision.policyVersion, 2); assert.equal(artifact.translationDecision.status, 'not_needed');
  for (const force of [false, true]) assert.equal((await f.start({ force })).state, 'not_needed');
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.quota, 0); assert.equal(f.calls.writes, 1);
});

test('unknown same-target language needs one independent short classification and no translation', async () => {
  const f = await fixture({ texts: Array.from({ length: 264 }, (_, i) => '风吹过窗前 ' + i), ask: messages => {
    const payload = JSON.parse(messages.at(-1).content);
    assert.equal(payload.units.length, 264); assert.equal(payload.units.at(-1).unitId, 263);
    return { language: 'zh', match: 0.95 };
  } });
  const original = (await f.store.get()).artifact.original;
  const prepared = await f.assess(); assert.equal(prepared.need, 'not_needed');
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision.sourceLanguage, 'zh'); assert.equal(saved.translationDecision.songLanguage, null);
  assert.equal(saved.translationDecision.status, 'not_needed'); assert.equal(saved.translation, null);
  assert.deepEqual(saved.original, original); assert.deepEqual(f.calls.statuses, ['pending', 'completed']);
  assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1); assert.deepEqual(f.calls.limits, [null]);
  assert.equal((await f.start()).state, 'not_needed'); assert.equal(f.calls.ai, 1);
});

test('foreign unknown language GET saves only needed decision; later POST translates with no second classification', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ texts: ['君を待っている'], ask: messages => JSON.parse(messages.at(-1).content).languageTable
    ? { language: 'ja', match: 0.99 } : waiting });
  const original = (await f.store.get()).artifact.original;
  const prepared = await f.assess(); assert.equal(prepared.need, 'needed');
  assert.equal(prepared.read.artifact.translationDecision.status, 'needed');
  assert.equal(prepared.read.artifact.aiCompletion, null); assert.equal(prepared.read.artifact.translation, null);
  assert.equal(f.calls.ai, 1);
  assert.equal((await f.assess()).need, 'needed'); assert.equal(f.calls.ai, 1);
  const started = await f.start({ automatic: false }); assert.equal(started.state, 'started');
  assert.equal((await f.start()).state, 'pending'); assert.equal(f.calls.ai, 2);
  finish({ translations: [{ unitId: 0, text: '我在等你' }] }); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision.status, 'translated'); assert.equal(saved.translationDecision.sourceLanguage, 'ja');
  assert.deepEqual(saved.translation.lines, ['我在等你']); assert.deepEqual(saved.original, original);
  assert.deepEqual(f.calls.statuses, ['pending', undefined, 'pending', 'completed']); assert.equal(f.calls.ai, 2); assert.equal(f.calls.quota, 2);
});

test('known-language compact DeepSeek models receive 176, 264 and 400 rows in one complete request', async () => {
  for (const length of [176, 264, 400]) {
    const f = await fixture({ language: 'en', texts: Array.from({ length }, (_, i) => 'We sing verse ' + i), ask: messages => {
      const payload = JSON.parse(messages.at(-1).content);
      assert.equal(payload.units.length, length);
      assert.equal(Object.hasOwn(payload, 'languageTable'), false);
      return { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: '我们唱起第' + unit.unitId + '段' })) };
    } });
    f.config.provider = 'deepseek'; f.config.model = 'deepseek-flash';
    const original = (await f.store.get()).artifact.original;
    await (await f.start()).task;
    const saved = (await f.store.get()).artifact;
    assert.equal(saved.translation.lines.length, length); assert.deepEqual(saved.original, original);
    assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1); assert.deepEqual(f.calls.statuses, ['pending', 'completed']);
  }
});

test('low-confidence and malformed inference get at most one repair and never become no-translation', async () => {
  for (const response of [{ language: 'zh', match: 0.7 }, { language: 'other', match: 0.99 },
    { language: 'zh', match: '1' }, { language: 'zh-Hant', match: 1 },
    { language: 'zh', match: 0.99, translations: [] }, { notNeeded: true }]) {
    const f = await fixture({ ask: () => response }); const started = await f.start(); await started.task;
    const saved = (await f.store.get()).artifact;
    assert.equal(saved.translationDecision, undefined); assert.equal(saved.aiCompletion.status, 'failed');
    assert.equal(f.calls.ai, 2); assert.equal(f.calls.quota, 1); assert.deepEqual(f.calls.statuses, ['pending', 'failed']);
    assert.equal((await f.start()).state, 'failed'); assert.equal(f.calls.ai, 2);
  }
});

test('changing target reuses the saved predominant language without requesting a second classification', async () => {
  const f = await fixture({ ask: messages => JSON.parse(messages.at(-1).content).languageTable
    ? { language: 'zh', match: 0.99 }
    : { translations: [{ unitId: 0, text: 'The wind passes the window' }, { unitId: 1, text: 'I will wait for you' }] } });
  await (await f.start()).task;
  f.config.targetLanguage = 'en'; await (await f.start()).task;
  assert.equal((await f.store.get()).artifact.translation.language, 'en');
  assert.deepEqual(f.calls.roles, ['classify', 'translate']);
});

test('a valid tag prepares locally and never clears an existing failed translation', async () => {
  const f = await fixture({ language: 'en', ask: () => assert.fail('Known tag is local') });
  const before = await f.store.get(); const prepared = await f.assess();
  assert.equal(prepared.need, 'needed'); assert.deepEqual(await f.store.get(), before); assert.equal(f.calls.ai, 0);
  await f.store.putIfMatch(f.song.id, { ...before.artifact, aiCompletion: { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() } }, before.etag);
  const failed = await f.store.get();
  assert.equal((await f.assess()).need, 'needed'); assert.deepEqual(await f.store.get(), failed);
});

test('direct explicit translation with missing tag classifies first and then translates the whole song', async () => {
  const f = await fixture({ texts: ['We sing together', 'We cross the ocean'], ask: messages => {
    const payload = JSON.parse(messages.at(-1).content);
    return payload.languageTable ? { language: 'en', match: 0.99 }
      : { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: '我们一起唱歌' })) };
  } });
  await (await f.start({ automatic: false })).task;
  assert.deepEqual(f.calls.roles, ['classify', 'translate']); assert.equal(f.calls.quota, 2);
  assert.equal((await f.store.get()).artifact.aiCompletion.status, 'completed');
});

test('failed preparation is persistent across fresh runtime instances; explicit POST can recover immediately', async () => {
  let valid = false;
  const f = await fixture({ texts: ['We sing together'], ask: messages => {
    if (!valid) throw Error('AI_UPSTREAM_503');
    return JSON.parse(messages.at(-1).content).languageTable ? { language: 'en', match: 0.99 }
      : { translations: [{ unitId: 0, text: '我们一起唱歌' }] };
  } });
  assert.equal((await f.assess()).reason, 'failed'); assert.equal(f.calls.ai, 1);
  const before = await f.store.get();
  const fresh = await loadTestModule(new URL('./translation.js', import.meta.url));
  assert.equal((await fresh.prepareLyricLanguage({ env: f.env, db: f.db, song: f.song, store: f.store, targetLanguage: 'zh' })).reason, 'failed');
  assert.deepEqual(await f.store.get(), before); assert.equal(f.calls.ai, 1);
  valid = true; await (await f.start({ automatic: false })).task;
  assert.deepEqual(f.calls.roles, ['classify', 'classify', 'translate']);
  assert.equal(f.calls.quota, 3); assert.equal((await f.store.get()).artifact.translation.lines[0], '我们一起唱歌');
});

test('fresh preparation instances reuse a saved needed decision with zero model, usage and writes', async () => {
  const f = await fixture({ ask: () => ({ language: 'ja', match: 0.99 }) });
  assert.equal((await f.assess()).need, 'needed');
  const before = await f.store.get(), counts = structuredClone(f.calls);
  const fresh = await loadTestModule(new URL('./translation.js', import.meta.url));
  const prepared = await fresh.prepareLyricLanguage({ env: f.env, db: f.db, song: f.song, store: f.store, targetLanguage: 'zh' });
  assert.equal(prepared.need, 'needed'); assert.equal(prepared.language, 'ja');
  assert.deepEqual(await f.store.get(), before); assert.deepEqual(f.calls, counts);
});

test('independent preparation claims allow one classifier and reject a late decision after an edit', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ ask: () => waiting });
  const first = f.assess();
  while (!f.calls.ai) await new Promise(resolve => setImmediate(resolve));
  const fresh = await loadTestModule(new URL('./translation.js', import.meta.url));
  const other = await fresh.prepareLyricLanguage({ env: f.env, db: f.db, song: f.song, store: f.store, targetLanguage: 'zh' });
  assert.equal(other.reason, 'pending'); assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1);
  const current = await f.store.get(), edit = { ...current.artifact, offsetMs: 400, aiCompletion: null };
  await f.store.putIfMatch(f.song.id, edit, current.etag);
  finish({ language: 'ja', match: 0.99 });
  assert.equal((await first).reason, 'superseded');
  assert.deepEqual((await f.store.get()).artifact, edit);
});

test('classification and translation each count one task even when each needs its one format repair', async () => {
  let classification = 0, translation = 0;
  const f = await fixture({ ask: messages => {
    const payload = JSON.parse(messages.at(-1).content);
    if (payload.languageTable) return ++classification === 1 ? { language: 'ja', match: 'wrong' } : { language: 'ja', match: 0.99 };
    return ++translation === 1 ? { translations: [] } : { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: '我们一起唱歌' })) };
  } });
  f.env.AI_TRANSLATION_DAILY_LIMIT = 7;
  const prepared = await f.assess(); assert.equal(prepared.need, 'needed');
  assert.equal(f.calls.ai, 2); assert.equal(f.calls.quota, 1); assert.equal(prepared.read.artifact.aiCompletion, null);
  await (await f.start({ automatic: false })).task;
  assert.equal(f.calls.ai, 4); assert.equal(f.calls.quota, 2); assert.deepEqual(f.calls.limits, [7, 7]);
  assert.equal((await f.store.get()).artifact.aiCompletion.status, 'completed');
});

test('classification network, rate-limit and timeout failures do not request repair or retry on another read', async () => {
  for (const message of ['AI_UPSTREAM_503', 'AI_UPSTREAM_429', 'AI_REQUEST_TIMEOUT']) {
    const f = await fixture({ ask: () => { throw new Error(message); } });
    assert.equal((await f.assess()).reason, 'failed');
    const before = await f.store.get();
    assert.equal((await f.assess()).reason, 'failed'); assert.deepEqual(await f.store.get(), before);
    assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1);
  }
});

test('classification and failed later translation both preserve the original and an existing other-target translation', async () => {
  const f = await fixture({ ask: messages => JSON.parse(messages.at(-1).content).languageTable
    ? { language: 'ja', match: 0.99 } : { translations: [] } });
  const before = await f.store.get();
  const prior = { source: 'manual', kind: 'manual', language: 'en', originalTextHash: before.artifact.textHash,
    lines: ['The old translation', 'Keep this old translation'], updatedAt: '2026-01-01T00:00:00.000Z' };
  await f.store.putIfMatch(f.song.id, { ...before.artifact, translation: prior }, before.etag);
  assert.equal((await f.assess()).need, 'needed');
  let saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.translation, prior); assert.deepEqual(saved.original, before.artifact.original);
  await (await f.start({ automatic: false })).task;
  saved = (await f.store.get()).artifact;
  assert.equal(saved.aiCompletion.status, 'failed'); assert.deepEqual(saved.translation, prior);
  assert.deepEqual(saved.original, before.artifact.original);
  assert.equal(saved.translationDecision.status, 'needed'); assert.equal(saved.translationDecision.sourceLanguage, 'ja');
  assert.equal(f.calls.ai, 3); assert.equal(f.calls.quota, 2);
});

test('every output validation failure can use the same one whole-song repair, with one usage reservation', async () => {
  for (const invalid of ['not JSON', { translations: [] }, { translations: [{ unitId: 99, text: '坏结果' }] },
    { translations: [{ unitId: 0, text: 'We sing together' }] }, { translations: [{ unitId: 0, text: '[00:01.00]坏结果' }] }]) {
    let calls = 0;
    const f = await fixture({ language: 'en', texts: ['We sing together'], ask: messages => {
      assert.equal(JSON.parse(messages.at(-1).content).units.length, 1);
      return ++calls === 1 ? invalid : { translations: [{ unitId: 0, text: '我们一起歌唱' }] };
    } });
    await (await f.start()).task;
    assert.equal((await f.store.get()).artifact.aiCompletion.status, 'completed');
    assert.equal(f.calls.ai, 2); assert.equal(f.calls.quota, 1); assert.deepEqual(f.calls.statuses, ['pending', 'completed']);
  }
});

test('network, rate-limit and timeout failures do not spend a repair request', async () => {
  for (const message of ['AI_UPSTREAM_503', 'AI_UPSTREAM_429', 'AI_REQUEST_TIMEOUT']) {
    const f = await fixture({ language: 'en', ask: () => { throw Error(message); } });
    await (await f.start()).task;
    assert.equal((await f.store.get()).artifact.aiCompletion.status, 'failed');
    assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1);
  }
});

test('catalog metadata is never written by successful inference and the decision binds the unchanged tag', async () => {
  const f = await fixture({ id: 'library-song', updateSongLanguage: () => assert.fail('No Songs write') });
  await (await f.start()).task;
  const saved = (await f.store.get()).artifact;
  assert.equal(f.song.language, 'other'); assert.equal(saved.translationDecision.songLanguage, null);
  assert.equal(saved.translationDecision.sourceLanguage, 'zh'); assert.equal((await f.start()).state, 'not_needed');
});

test('a model request uses the existing ninety-second timeout instead of the old twenty-four-second task budget', async () => {
  const f = await fixture({ language: 'en', texts: ['We sing together'], ask: (_messages, _options, limits) => {
    assert.equal(limits.timeoutMs, 90_000); return { translations: [{ unitId: 0, text: '我们一起歌唱' }] };
  } });
  await (await f.start()).task; assert.equal(f.calls.ai, 1);
  assert.equal((await f.store.get()).artifact.aiCompletion.status, 'completed');
});

test('timed-out model work cannot publish a late result or a language marker', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ ask: () => waiting });
  const started = await f.start({ deps: { modelTimeoutMs: 5 } }); await started.task;
  assert.equal((await f.store.get()).artifact.aiCompletion.errorCode, 'ai_timeout');
  const saved = await f.store.get(); finish({ language: 'zh', match: 0.95, translations: [] });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(await f.store.get(), saved); assert.equal(f.calls.ai, 1);
});

test('an already-aborted owner performs no read, write, usage reservation or model request', async () => {
  const f = await fixture(); const owner = new AbortController(); owner.abort();
  const forbidden = () => assert.fail('No work for an aborted request');
  await assert.rejects(prepare({ env: f.env, db: f.db, song: f.song, store: { get: forbidden, putIfMatch: forbidden },
    targetLanguage: 'zh', deps: { signal: owner.signal, reserveDailyQuota: forbidden } }), error => error.name === 'AbortError');
  assert.equal(f.calls.ai, 0);
});

test('the final snapshot CAS rejects a same-text offset edit without overwriting its newer version', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ language: 'en', texts: ['We sing together'], ask: () => waiting });
  const started = await f.start();
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  const current = await f.store.get();
  const edited = { ...current.artifact, offsetMs: 500, aiCompletion: null };
  await f.store.putIfMatch(f.song.id, edited, current.etag);
  finish({ translations: [{ unitId: 0, text: '我们一起唱歌' }] });
  assert.equal((await started.task).state, 'superseded');
  assert.deepEqual((await f.store.get()).artifact, edited);
});

test('failure settlement cannot mark a newer same-body task as failed', async () => {
  let fail;
  const waiting = new Promise((_resolve, reject) => { fail = reject; });
  const f = await fixture({ language: 'en', texts: ['We sing together'], ask: () => waiting });
  const started = await f.start();
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  const current = await f.store.get();
  const newer = { ...current.artifact, aiCompletion: { status: 'pending', updatedAt: '2099-01-01T00:00:00.000Z' } };
  await f.store.putIfMatch(f.song.id, newer, current.etag);
  fail(new Error('AI_UPSTREAM_503'));
  assert.equal((await started.task).state, 'superseded');
  assert.deepEqual((await f.store.get()).artifact, newer);
});

test('automatic requests use their remaining retained lifetime and preserve lyrics after timeout and a late model reply', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; }), limitsSeen = [];
  const f = await fixture({ language: 'en', texts: ['We sing together'], ask: (_messages, _options, limits) => {
    limitsSeen.push(limits.timeoutMs); return waiting;
  } });
  const before = (await f.store.get()).artifact;
  const started = await f.start({ deps: { automaticDeadlineAt: Date.now() + 15 } });
  await started.task;
  const timedOut = await f.store.get(); assert.equal(timedOut.artifact.aiCompletion.errorCode, 'ai_timeout');
  assert.ok(limitsSeen[0] > 0 && limitsSeen[0] <= 15); assert.equal(f.calls.ai, 1); assert.equal(f.calls.quota, 1);
  assert.deepEqual(timedOut.artifact.original, before.original); assert.deepEqual(timedOut.artifact.translation, before.translation);
  finish({ translations: [{ unitId: 0, text: '我们一起唱歌' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.store.get(), timedOut);
});

test('an exhausted automatic deadline settles failed without sending a model request or an output repair', async () => {
  const now = Date.now();
  const f = await fixture({ language: 'en', texts: ['We sing together'], now: () => now,
    ask: () => assert.fail('An expired retained task cannot call the model') });
  await (await f.start({ deps: { automaticDeadlineAt: now } })).task;
  assert.equal((await f.store.get()).artifact.aiCompletion.errorCode, 'ai_timeout'); assert.equal(f.calls.ai, 0);
});

test('the single output repair uses the same automatic deadline rather than receiving another platform lifetime', async () => {
  let now = Date.now(); const limitsSeen = [];
  const f = await fixture({ language: 'en', texts: ['We sing together'], now: () => now, ask: (_messages, _options, limits) => {
    limitsSeen.push(limits.timeoutMs);
    if (limitsSeen.length === 1) { now += 1500; return { translations: [] }; }
    return { translations: [{ unitId: 0, text: '我们一起唱歌' }] };
  } });
  await (await f.start({ deps: { automaticDeadlineAt: now + 28000 } })).task;
  assert.deepEqual(limitsSeen, [28000, 26500]); assert.equal(f.calls.quota, 1); assert.equal(f.calls.ai, 2);
  assert.equal((await f.store.get()).artifact.aiCompletion.status, 'completed');
});
