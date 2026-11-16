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
  const calls = { ai: 0, quota: 0, roles: [] };
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: String(revision) });
  const store = { get: async () => read(), putIfMatch: async (_id, next, etag) => {
    if (etag !== String(revision)) return { state: 'conflict' };
    artifact = structuredClone(next); revision++; return { ...read(), state: 'updated' };
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
  const deps = { aiAccess: access, now, updateSongLanguage, reserveDailyQuota: async () => { calls.quota++; return true; } };
  const start = (options = {}) => begin({ env, db, song, store, force: options.force, targetLanguage: config.targetLanguage,
    deps: { ...deps, ...options.deps } });
  const assess = (options = {}) => prepare({ env, db, song, store, targetLanguage: config.targetLanguage,
    deps: { ...deps, ...options.deps } });
  return { song, env, db, config, store, calls, start, assess };
}

test('a dominant Chinese catalog tag skips all AI despite a few actual foreign sentences', async () => {
  const f = await fixture({ language: 'zh', ask: () => assert.fail('No model needed') });
  const first = await f.start();
  assert.equal(first.state, 'not_needed'); assert.equal(first.task, null);
  const artifact = (await f.store.get()).artifact;
  assert.equal(artifact.translationDecision.policyVersion, 2);
  assert.equal(artifact.translationDecision.status, 'not_needed');
  for (const force of [false, true]) assert.equal((await f.start({ force })).state, 'not_needed');
  assert.deepEqual(f.calls, { ai: 0, quota: 0, roles: [] });
});

test('missing language waits only for classification and caches no-translation without generation', async () => {
  const f = await fixture();
  const original = (await f.store.get()).artifact.original;
  const first = await f.start();
  assert.equal(first.state, 'not_needed'); assert.equal(first.task, null);
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translation, null);
  assert.equal(saved.translationDecision.sourceLanguage, 'zh');
  assert.deepEqual(saved.original, original);
  assert.equal((await f.start({ force: true })).state, 'not_needed');
  assert.deepEqual(f.calls, { ai: 1, quota: 1, roles: ['classify'] });
});

test('foreign untagged song separates synchronous classification from background translation', async () => {
  let finishTranslation;
  const waiting = new Promise(resolve => { finishTranslation = resolve; });
  const f = await fixture({ texts: ['君を待っている'], ask: async messages => {
    return JSON.parse(messages.at(-1).content).languageTable ? { language: 'ja', match: 0.99 } : waiting;
  } });
  const original = (await f.store.get()).artifact.original;
  const started = await f.start();
  assert.equal(started.state, 'started');
  assert.equal(started.artifact.translationDecision.status, 'needed');
  assert.equal(started.artifact.translation, null);
  assert.equal(started.artifact.aiCompletion.status, 'pending');
  const repeated = await f.start(); assert.equal(repeated.state, 'pending'); assert.equal(repeated.task, null);
  finishTranslation({ translations: [{ unitId: 0, text: '我在等你' }] });
  await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision.status, 'translated');
  assert.deepEqual(saved.translation.lines, ['我在等你']);
  assert.deepEqual(saved.original, original);
  assert.deepEqual(f.calls.roles, ['classify', 'translate']);
});

test('low match, other and invalid assessment outputs never become permanent no-translation', async () => {
  for (const result of [{ language: 'zh', match: 0.7 }, { language: 'other', match: 0.99 },
    { language: 'zh', match: '1' }, { language: 'zh-Hant', match: 1 }, { notNeeded: true, songLanguage: 'zh' }]) {
    const f = await fixture({ ask: async () => result });
    const first = await f.start();
    assert.equal(first.state, 'failed'); assert.equal(first.task, null);
    const saved = (await f.store.get()).artifact;
    assert.equal(saved.translationDecision, undefined);
    assert.match(saved.aiCompletion.errorCode, /^language_assessment_/u);
  }
});

test('a target change reuses known classification and translates instead of reclassifying the same body', async () => {
  const f = await fixture({ ask: async messages => JSON.parse(messages.at(-1).content).languageTable
    ? { language: 'zh', match: 0.99 } : { translations: [{ unitId: 0, text: 'The wind passes the window' }, { unitId: 1, text: 'I will wait for you' }] } });
  assert.equal((await f.start()).state, 'not_needed');
  f.config.targetLanguage = 'en';
  const started = await f.start(); await started.task;
  assert.equal((await f.store.get()).artifact.translation.language, 'en');
  assert.deepEqual(f.calls.roles, ['classify', 'translate']);
});

test('parallel classification requests for the same scoped body join one model call', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ ask: () => waiting });
  const signal = new AbortController().signal;
  const options = { deps: { signal } };
  const results = [f.assess(options), f.assess(options), f.assess(options)];
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  finish({ language: 'zh', match: 0.95 });
  for (const result of await Promise.all(results)) assert.equal(result.need, 'not_needed');
  assert.equal(f.calls.ai, 1);
});

test('a concurrent edit wins over a late classifier response and cannot receive its marker', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ ask: () => waiting });
  const task = f.assess();
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  const read = await f.store.get();
  const edit = (await buildReadyLyricArtifact(f.song, { source: 'manual', format: 'lrc', lines: [{ time: 1, text: 'A newer edit' }] })).artifact;
  await f.store.putIfMatch(f.song.id, edit, read.etag);
  finish({ language: 'zh', match: 0.95 });
  assert.equal((await task).reason, 'superseded');
  const saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.original, edit.original); assert.equal(saved.translationDecision, undefined);
});

test('failed catalog tag writes revoke the new assessment and expose a retryable classifier failure', async () => {
  const f = await fixture({ id: 'library-song', updateSongLanguage: async () => { throw Error('Database failure'); } });
  const result = await f.assess();
  assert.equal(result.need, 'unknown');
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision, undefined);
  assert.equal(saved.aiCompletion.errorCode, 'language_assessment_update_failed');
});

test('successful catalog inference binds its assessment to the tag actually committed', async () => {
  let updated;
  const f = await fixture({ id: 'library-song', updateSongLanguage: async (_id, language) => { updated = language; } });
  const result = await f.assess();
  assert.equal(updated, 'zh'); assert.equal(result.song.language, 'zh');
  assert.equal(result.read.artifact.translationDecision.songLanguage, 'zh');
});

test('new known-tag assessment clears an obsolete developer failure once', async () => {
  const f = await fixture({ language: 'en', targetLanguage: 'zh', texts: ['We sing together'] });
  const read = await f.store.get();
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() } }, read.etag);
  const prepared = await f.assess();
  assert.equal(prepared.need, 'needed');
  assert.equal(prepared.read.artifact.aiCompletion.status, 'completed');
  assert.equal(prepared.read.artifact.translationDecision.status, 'needed');
  const second = await f.store.get();
  await f.store.putIfMatch(f.song.id, { ...second.artifact, aiCompletion: { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() } }, second.etag);
  assert.equal((await f.assess()).read.artifact.aiCompletion.status, 'failed');
  assert.equal(f.calls.ai, 0);
});

test('classification timeout cannot publish a late successful language marker', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ ask: () => waiting });
  const result = await f.assess({ deps: { completionDeadlineMs: 5_000, monotonicNow: () => 0 } });
  assert.equal(result.need, 'unknown');
  assert.equal(result.read.artifact.aiCompletion.errorCode, 'language_assessment_timeout');
  finish({ language: 'zh', match: 0.95 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await f.store.get()).artifact.translationDecision, undefined);
});

async function boundedRead(task) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('A new request joined another request owner I/O')), 150);
    })]);
  } finally { clearTimeout(timer); }
}

test('an aborted owner cannot block a new signal and stale pending can be recovered without its Promise', async () => {
  let finishOld;
  const waiting = new Promise(resolve => { finishOld = resolve; });
  let request = 0;
  const f = await fixture({ ask: () => ++request === 1 ? waiting : { language: 'zh', match: 0.95 } });
  const owner = new AbortController();
  const oldTask = f.assess({ deps: { signal: owner.signal } });
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  const pending = await boundedRead(f.assess({ deps: { signal: new AbortController().signal } }));
  assert.equal(pending.reason, 'pending');
  assert.equal(f.calls.ai, 1);
  const rejected = assert.rejects(oldTask, error => error.name === 'AbortError');
  owner.abort();
  await rejected;
  const read = await f.store.get();
  assert.equal(read.artifact.aiCompletion.status, 'pending');
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: {
    status: 'pending', updatedAt: '2000-01-01T00:00:00.000Z',
  } }, read.etag);
  const recovered = await boundedRead(f.assess({ deps: { signal: new AbortController().signal } }));
  assert.equal(recovered.need, 'not_needed');
  assert.equal(recovered.language, 'zh');
  assert.equal(f.calls.ai, 2);
  finishOld({ language: 'ja', match: 0.99 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal((await f.store.get()).artifact.translationDecision.sourceLanguage, 'zh');
});

test('an unfinished foreign request owner never lends its pending I/O to another signal', async () => {
  let finishOld;
  const waiting = new Promise(resolve => { finishOld = resolve; });
  let request = 0;
  const f = await fixture({ ask: () => ++request === 1 ? waiting : { language: 'zh', match: 0.95 } });
  const oldTask = f.assess({ deps: { signal: new AbortController().signal } });
  while (!f.calls.ai) await new Promise(resolve => setTimeout(resolve, 0));
  const pending = await boundedRead(f.assess({ deps: { signal: new AbortController().signal } }));
  assert.equal(pending.reason, 'pending');
  const read = await f.store.get();
  await f.store.putIfMatch(f.song.id, { ...read.artifact, aiCompletion: {
    status: 'pending', updatedAt: '2000-01-01T00:00:00.000Z',
  } }, read.etag);
  const recovered = await boundedRead(f.assess({ deps: { signal: new AbortController().signal } }));
  assert.equal(recovered.need, 'not_needed');
  finishOld({ language: 'ja', match: 0.99 });
  assert.equal((await oldTask).reason, 'superseded');
  assert.equal((await f.store.get()).artifact.translationDecision.sourceLanguage, 'zh');
  assert.equal(f.calls.ai, 2);
});

test('an already-aborted owner performs no read, write, quota reservation or AI call', async () => {
  const f = await fixture();
  const owner = new AbortController(); owner.abort();
  const forbidden = () => assert.fail('No work for an aborted request');
  await assert.rejects(prepare({ env: f.env, db: f.db, song: f.song,
    store: { get: forbidden, putIfMatch: forbidden }, targetLanguage: 'zh',
    deps: { signal: owner.signal, reserveDailyQuota: forbidden } }), error => error.name === 'AbortError');
  assert.equal(f.calls.ai, 0);
});

test('classification hands off one pending task without publishing an intermediate completed state', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const f = await fixture({ texts: ['君を待っている'], ask: messages =>
    JSON.parse(messages.at(-1).content).languageTable ? { language: 'ja', match: 0.99 } : waiting });
  const statuses = [], put = f.store.putIfMatch;
  f.store.putIfMatch = (...args) => { statuses.push(args[1].aiCompletion?.status); return put(...args); };
  const started = await f.start();
  assert.equal(started.state, 'started');
  assert.ok(statuses.length > 0 && statuses.every(status => status === 'pending'));
  finish({ translations: [{ unitId: 0, text: '我在等你' }] });
  await started.task;
  assert.equal(statuses.at(-1), 'completed');
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
