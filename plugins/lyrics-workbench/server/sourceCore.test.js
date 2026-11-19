import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorkbenchSourceCore, markManuallySelectedArtifact } from './sourceCore.js';

const song = { id: 'yt:WqkrwFSFeAE', title: 'Example', artist: 'Singer', duration: 120, language: 'en' };
const document = (source = 'lrclib', syncMode = 'word', text = 'Hello world') => ({ version: 2, source, format: syncMode === 'word' ? 'krc' : syncMode === 'line' ? 'lrc' : 'plain', syncMode,
  lines: [{ text, ...(syncMode !== 'none' ? { time: 1, endTime: 2 } : {}) }], providerMeta: { matchedDuration: 120, durationDelta: 0 } });
const hash = doc => createHash('sha256').update(doc.lines.map(x => x.text).join('\n')).digest('hex');
const asset = (doc = document(), overrides = {}) => ({ schemaVersion: 1, songId: song.id, status: 'ready', original: { source: doc.source, format: doc.format, syncMode: doc.syncMode, lines: structuredClone(doc.lines) }, textHash: hash(doc),
  translation: null, aiCompletion: null, offsetMs: 0, provenance: { matchedDuration: 120 }, updatedAt: '2026-11-11T00:00:00.000Z', ...overrides });
function memory(initial) {
  let current = initial ? structuredClone(initial) : null, revision = initial ? 1 : 0;
  const calls = { get: 0, put: 0, create: 0 };
  const snapshot = () => ({ state: current ? 'found' : 'missing', artifact: structuredClone(current), etag: current ? `v${revision}` : null });
  return { calls, get: async () => { calls.get++; return snapshot(); },
    putIfMatch: async (_id, value, etag) => { calls.put++; if (!current || etag !== `v${revision}`) return { state: 'conflict' }; current = structuredClone(value); revision++; return { ...snapshot(), state: 'updated' }; },
    createIfAbsent: async (_id, value) => { calls.create++; if (current) return { state: 'conflict' }; current = structuredClone(value); revision++; return { ...snapshot(), state: 'created' }; },
  };
}
const translationNeedForFixture = (_original, target, { artifact, targetLanguage } = {}) => {
  if (target.language === 'instrumental') return { state: 'not_needed' };
  const language = target.language && target.language !== 'other' ? target.language : artifact?.translationDecision?.sourceLanguage;
  return { state: !language ? 'unknown' : language === targetLanguage ? 'not_needed' : 'needed' };
};
function setup({ initial = null, candidate = document(), config = {}, available = true, failure = null, projectTranslation = artifact => artifact.translation, dependencies = {}, resolveSong = async () => song,
  prepareLanguage, translationNeed = translationNeedForFixture, beginCompletion, executionContext, assessmentSettings, buildArtifact } = {}) {
  const store = memory(initial), calls = { fetch: 0, ai: 0, language: 0, available: 0, read: 0, authority: 0, retain: 0, release: 0 }, tasks = [];
  const settings = { onlineEnabled: true, lyricPreference: 'word', targetLanguage: 'zh', completionEnabled: true, automaticCompletionEnabled: true, ...config };
  const begin = async ({ song: target, deps }) => {
    calls.ai++; const read = await store.get(target.id);
    if (deps?.initialRead) assert.equal(deps.initialRead.state, 'found');
    deps?.checkCurrent?.(read);
    const written = await store.putIfMatch(target.id, { ...read.artifact, aiCompletion: { status: 'pending', updatedAt: new Date().toISOString() } }, read.etag);
    return { ...written, task: Promise.resolve(written) };
  };
  const complete = async input => beginCompletion ? beginCompletion(input, { store, calls, begin, prepare }) : begin(input);
  const prepare = async input => {
    calls.language++;
    if (prepareLanguage) return prepareLanguage(input, { store, calls, settings });
    const read = input.deps.initialRead;
    const existing = read.artifact.translationDecision;
    const initialNeed = translationNeed(read.artifact.original, input.song, { artifact: read.artifact, targetLanguage: settings.targetLanguage }).state;
    const state = initialNeed === 'unknown' ? 'needed' : initialNeed;
    if (existing?.policyVersion === 2 && existing.textHash === read.artifact.textHash
      && existing.targetLanguage === settings.targetLanguage) return { read, song: input.song, need: state };
    const updated = await store.putIfMatch(input.song.id, { ...read.artifact,
      translationDecision: { status: state, sourceLanguage: input.song.language === 'other' || !input.song.language ? 'ja' : input.song.language,
        policyVersion: 2, textHash: read.artifact.textHash, targetLanguage: settings.targetLanguage } }, read.etag);
    return { read: updated, song: input.song, need: state };
  };
  const source = createWorkbenchSourceCore({ env: {}, db: {}, session: { account: { accountId: 'member' } },
    executionContext: executionContext || { waitUntil(task) { tasks.push(task); task.catch(() => {}); } }, store,
    dependencies: { retainBackgroundTask() { calls.retain++; return { deadlineAt: Date.now() + 28_000, release() { calls.release++; } }; }, ...dependencies },
    operations: {
      settings: async () => settings, assertCurrent: async () => { calls.authority++; }, createDocument: x => structuredClone(x),
      buildArtifact: buildArtifact || (async (_song, doc) => ({ artifact: asset(doc) })),
      assessmentSettings,
      project: value => ({ translation: projectTranslation(value), translationState: value.aiCompletion?.status === 'pending'
        && Date.now() - Date.parse(value.aiCompletion.updatedAt) < 30_000 ? 'pending'
        : ['pending', 'failed'].includes(value.aiCompletion?.status) ? 'failed' : 'missing' }),
      resolveTranslationNeed: translationNeed,
      hasNoTranslationDecision: (artifact, _song, { targetLanguage }) => artifact.translationDecision?.status === 'not_needed'
        && artifact.translationDecision.textHash === artifact.textHash && artifact.translationDecision.targetLanguage === targetLanguage,
      preferred: (left, right) => ({ none: 0, line: 1, word: 2 }[left.syncMode] > { none: 0, line: 1, word: 2 }[right.syncMode]), reliable: value => !value.providerMeta?.versionMismatch,
      fetchCandidate: async () => { calls.fetch++; if (failure) throw failure; return candidate; },
      aiAvailable: async () => { calls.available++; return available; }, aiConfig: async () => settings,
      translationError: code => ({ code, message: 'Safe translation error' }),
      resolveSong, beginCompletion: complete, prepareLanguage: prepare,
      readPlayback: async ({ song: target, deps }) => { calls.read++; let read = await deps.readOrCreateLyricArtifact();
        if (settings.completionEnabled && settings.automaticCompletionEnabled && available && !read.artifact.translation && read.artifact.aiCompletion?.status !== 'pending') read = await begin({ song: target });
        return read;
      },
    } });
  return { source, store, calls, settings, tasks };
}

test('an offline empty workbench does not claim or search a song', async () => {
  const f = setup({ config: { onlineEnabled: false } });
  assert.equal(await f.source.claim(song), false); assert.equal(await f.source.resolve(song), null);
  assert.equal(f.calls.fetch, 0); assert.equal(f.calls.ai, 0);
});

test('offline claim and resolve share one request-owned original read', async () => {
  const f = setup({ initial: asset(document('manual', 'line')), config: { onlineEnabled: false, completionEnabled: false } });
  assert.equal(await f.source.claim(song), true);
  const result = await f.source.resolve(song);
  assert.equal(result.document.lines[0].text, 'Hello world');
  assert.equal(f.store.calls.get, 1);
});

test('an evaluated unchanged external original is marked processed once without rewriting its content', async () => {
  const initial = asset(document('youtube', 'none'), { provenance: { managedBy: 'youtube-music', evaluation: 'unassessed', quality: 'weak' } });
  const f = setup({ initial, candidate: null, config: { completionEnabled: false } });
  const result = await f.source.resolve(song);
  const adopted = await result.onAdopt();
  assert.equal(result.quality, 'weak'); assert.equal(adopted.quality, 'good');
  assert.equal(f.store.calls.put, 1);
  const saved = (await f.store.get(song.id)).artifact;
  assert.deepEqual(saved.original, initial.original); assert.deepEqual(saved.translation, initial.translation);
  assert.equal(saved.provenance.managedBy, 'lyrics-workbench'); assert.equal(saved.provenance.evaluation, 'assessed');
  await f.source.resolve(song); assert.equal(f.calls.fetch, 1);
});

test('a weak workbench result has no storage or AI side effects before adoption', async () => {
  const f = setup({ candidate: document('lrclib', 'line') }); const result = await f.source.resolve(song);
  assert.equal(result.quality, 'weak'); assert.equal(result.translation.supported, true);
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.language, 0); assert.equal(f.store.calls.create, 0); assert.equal(f.store.calls.put, 0);
});

test('adopting a new known-language original immediately dispatches automatic translation without classification', async () => {
  const f = setup(); const result = await f.source.resolve(song); const adopted = await result.onAdopt();
  assert.equal(adopted.translation.state, 'idle'); assert.equal(adopted.translation.supported, true);
  assert.deepEqual(adopted.translation.lines, []); assert.equal(typeof adopted.settled?.then, 'function');
  const pending = await adopted.settled; assert.equal(pending.translation.state, 'pending');
  assert.equal(f.calls.ai, 1); assert.equal(f.calls.language, 0); assert.equal(f.tasks.length, 1);
  const saved = await f.store.get(song.id); assert.equal(saved.artifact.provenance.managedBy, 'lyrics-workbench');
  assert.equal(saved.artifact.provenance.evaluation, 'assessed'); assert.equal(saved.artifact.provenance.quality, 'good');
  const started = await f.source.translate({ songId: song.id, textHash: saved.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal(started.translation.state, 'pending'); assert.equal(started.settled, undefined); assert.equal(f.calls.ai, 1);
  await f.source.translate({ songId: song.id, textHash: saved.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal(f.calls.ai, 1, 'pending work is reused');
});

test('the retired separate automatic flag cannot disable the current completion switch', async () => {
  const f = setup({ config: { automaticCompletionEnabled: false } });
  const result = await f.source.resolve(song); assert.equal(result.translation.state, 'idle');
  const adopted = await result.onAdopt(); assert.equal((await adopted.settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1); assert.equal(f.calls.language, 0);
  const translated = await f.source.translate({ songId: song.id, textHash: adopted.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal(translated.translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});

test('a manually fixed file stays good, is not searched and retains its translation with AI disabled', async () => {
  const original = asset(document('manual', 'line')); original.translation = { source: 'manual', language: 'zh', originalTextHash: original.textHash, lines: ['人工译文'] };
  const f = setup({ initial: original, config: { completionEnabled: false } });
  const result = await f.source.resolve(song); assert.equal(result.quality, 'good'); assert.equal(result.translation.state, 'ready');
  assert.equal(result.translation.supported, true); assert.equal(f.calls.fetch, 0); assert.equal(f.calls.available, 0);
  await result.onAdopt(); assert.equal(f.store.calls.put, 0); assert.equal(f.calls.ai, 0);
});

test('an unassessed YT file is evaluated once without any YT provider call', async () => {
  const initial = asset(document('youtube', 'line'), { provenance: { managedBy: 'youtube-music', evaluation: 'unassessed', matchedDuration: 120 } });
  initial.translation = { source: 'youtube', kind: 'machine', originalTextHash: initial.textHash, language: 'zh-CN', lines: ['你好'] };
  const f = setup({ initial, candidate: null, config: { lyricPreference: 'line' } });
  const first = await f.source.resolve(song); assert.equal(f.calls.fetch, 1); assert.equal(first.translation.state, 'ready');
  await first.onAdopt(); const next = await f.source.resolve(song);
  assert.equal(next.quality, 'good'); assert.equal(f.calls.fetch, 1); assert.equal(f.calls.ai, 0);
  assert.equal(f.calls.language, 0, 'a usable provider layer needs neither language assessment nor generation');
  assert.equal(next.provenance.originalSource, 'youtube');
});

test('an existing assessed weak file is a good-priority processed cache without re-evaluation', async () => {
  const initial = asset(document('lrclib', 'line'), { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'weak' } });
  const f = setup({ initial }); const result = await f.source.resolve(song);
  assert.equal(result.quality, 'good'); assert.equal(f.calls.fetch, 0);
});

test('same-body assessment preserves the exact existing timeline offset and translation', async () => {
  const initial = asset(document('youtube', 'line'), { offsetMs: 250 });
  initial.translation = { source: 'youtube', originalTextHash: initial.textHash, language: 'ja', lines: ['翻訳'] };
  const f = setup({ initial, candidate: null, config: { completionEnabled: false, targetLanguage: 'zh' } });
  const adopted = await (await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.artifact.offsetMs, 250); assert.deepEqual(adopted.artifact.translation, initial.translation);
  assert.equal(adopted.translation.supported, false); assert.equal(adopted.translation.lines.length, 0);
});

test('foreign text hash or changed target cannot trigger completion', async () => {
  const initial = asset(); const f = setup({ initial, config: { automaticCompletionEnabled: false } });
  await assert.rejects(f.source.translate({ songId: song.id, textHash: 'b'.repeat(64) }), { code: 'LYRIC_RESULT_STALE' });
  await assert.rejects(f.source.translate({ songId: song.id, textHash: initial.textHash, sourceRef: { targetLanguage: 'ja' } }), { code: 'LYRIC_RESULT_STALE' });
  assert.equal(f.calls.ai, 0);
});

test('a later manual edit wins before adoption and never receives the old completion', async () => {
  const initial = asset(document('youtube', 'line')); const f = setup({ initial }); const result = await f.source.resolve(song);
  const read = await f.store.get(song.id); await f.store.putIfMatch(song.id, asset(document('manual', 'word', 'Edited')), read.etag);
  await assert.rejects(result.onAdopt(), { code: 'LYRIC_RESULT_STALE' }); assert.equal(f.calls.ai, 0);
});

test('provider errors preserve an existing file and do not falsely create a no-lyrics asset', async () => {
  const initial = asset(document('youtube', 'line')); const f = setup({ initial, failure: Error('upstream') });
  const result = await f.source.resolve(song); assert.equal(result.document.source, 'youtube');
  assert.equal(f.store.calls.create, 0); assert.equal(f.store.calls.put, 0);
});

test('a processed file ignores changed assessment settings and the AI switch on ordinary reads', async () => {
  const oldKey = 'a'.repeat(64), newKey = 'b'.repeat(64);
  const initial = asset(document('lrclib', 'line'), { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'good', assessmentKey: oldKey } });
  const f = setup({ initial, config: { assessmentKey: oldKey, lyricPreference: 'line', completionEnabled: false } });
  await f.source.resolve(song); assert.equal(f.calls.fetch, 0);
  f.settings.assessmentKey = newKey; f.settings.lyricPreference = 'word';
  const result = await f.source.resolve(song); assert.equal(result.quality, 'good'); assert.equal(f.calls.fetch, 0); await result.onAdopt();
  const saved = await f.store.get(song.id); assert.equal(saved.artifact.provenance.assessmentKey, oldKey);
  f.settings.completionEnabled = true; await f.source.resolve(song); assert.equal(f.calls.fetch, 0); assert.equal(f.store.calls.put, 0);
});

test('same-text candidates can improve timing without dropping the saved translation', async () => {
  const initial = asset(document('youtube', 'line'));
  initial.translation = { source: 'youtube', originalTextHash: initial.textHash, language: 'zh', lines: ['你好'] };
  const f = setup({ initial, candidate: document('lrclib', 'word'), config: { completionEnabled: false } });
  const result = await f.source.resolve(song); assert.equal(result.document.syncMode, 'word');
  assert.equal(result.provenance.originalSource, 'lrclib');
  const adopted = await result.onAdopt(); assert.equal(adopted.artifact.original.syncMode, 'word');
  assert.deepEqual(adopted.translation.lines, ['你好']);
});

test('explicit candidate selection protects even a provider-named original', () => {
  const initial = asset(document('lrclib', 'line')); const marked = markManuallySelectedArtifact(initial);
  assert.equal(marked.original.source, 'lrclib'); assert.equal(marked.provenance.evaluation, 'manual');
  assert.equal(marked.provenance.quality, 'good'); assert.equal(initial.provenance.evaluation, undefined);
});

test('ordinary new adoption bypasses the retired playback resolver and starts automatic translation', async () => {
  const f = setup(); const result = await f.source.resolve(song); const adopted = await result.onAdopt(); await adopted.settled;
  assert.equal(f.calls.read, 0); assert.equal(f.calls.ai, 1); assert.equal(f.tasks.length, 1);
  const read=await f.store.get(song.id);
  await f.source.translate({songId:song.id,textHash:read.artifact.textHash});assert.equal(f.calls.ai,1);
});

test('protected-file claim and adoption do not repeat the owning-source strong gate', async () => {
  const f = setup({ initial: asset(document('manual')), config: { completionEnabled: false } });
  await f.source.claim(song); assert.equal(f.calls.authority, 0);
  const result = await f.source.resolve(song); await result.onAdopt(); assert.equal(f.calls.authority, 1);
  await f.source.translate({ songId: song.id, textHash: result.artifact.textHash }); assert.equal(f.calls.authority, 2);
});

for (const completionEnabled of [false, true]) {
  test('a host-hidden copied layer is never ready; AI capability follows settings: ' + completionEnabled, async () => {
    const initial = asset(document('manual'));
    initial.translation = { source: 'manual', language: 'zh', originalTextHash: initial.textHash, lines: ['Hello world'] };
    const f = setup({ initial, candidate: null, projectTranslation: () => null,
      config: { completionEnabled, automaticCompletionEnabled: false } });
    const result = await f.source.resolve(song);
    assert.equal(result.translation.state, completionEnabled ? 'idle' : 'unavailable');
    assert.equal(result.translation.supported, completionEnabled);
    assert.deepEqual(result.translation.lines, []);
    const adopted = await result.onAdopt();
    assert.deepEqual((await f.store.get(song.id)).artifact.translation, initial.translation, 'read/adoption leaves the old layer intact');
    assert.equal(f.calls.ai, 0, 'adoption never generates a hidden layer'); assert.equal(f.calls.language, 0);
    if (completionEnabled) {
      const started = await f.source.translate({ songId: song.id, textHash: initial.textHash, sourceRef: adopted.sourceRef });
      assert.equal((await started.settled).translation.state, 'pending');
      assert.equal(f.calls.ai, 1);
      assert.deepEqual((await f.store.get(song.id)).artifact.translation, initial.translation);
    }
  });
}

test('confirmed misses are negatively cached without forging a ready result', async () => {
  const f = setup({ candidate: null });
  assert.equal(await f.source.resolve(song), null);
  assert.equal((await f.store.get(song.id)).artifact.status, 'not_found');
  assert.equal(await f.source.resolve(song), null);
  assert.equal(f.calls.fetch, 1);
});

test('concurrent preparations reuse an identical adopted winner instead of failing CAS', async () => {
  const f = setup({ config: { completionEnabled: false } });
  const planned = await Promise.all([f.source.resolve(song), f.source.resolve(song), f.source.resolve(song)]);
  const adopted = await Promise.all(planned.map(result => result.onAdopt()));
  assert.ok(adopted.every(result => result.document.lines[0].text === 'Hello world'));
  assert.equal((await f.store.get(song.id)).artifact.provenance.managedBy, 'lyrics-workbench');
  assert.equal(f.calls.ai, 0);
});

for (const completionEnabled of [false, true]) {
  test('a current no-op decision is returned without acquiring AI or reprocessing: ' + completionEnabled, async () => {
    const initial = asset(document('manual', 'line', '风吹过窗前'));
    initial.translationDecision = { status: 'not_needed', textHash: initial.textHash, targetLanguage: 'zh',
      policyVersion: 1, songLanguage: 'en', sourceLanguage: 'zh', basis: 'ai' };
    initial.aiCompletion = { status: 'completed', processingKey: 'zh|0|1|1|1|1|1' };
    const f = setup({ initial, config: { completionEnabled } });
    const result = await f.source.resolve(song);
    assert.equal(result.translation.state, 'not_needed'); assert.equal(result.translation.supported, false);
    await result.onAdopt();
    await f.source.translate({ songId: song.id, textHash: initial.textHash, sourceRef: result.sourceRef });
    assert.equal(f.calls.ai, 0); assert.equal(f.calls.available, 0);
    assert.equal(f.store.calls.put, 0);
  });
}

test('a generic completed marker is not treated as proof that unknown lyrics need no translation', async () => {
  const initial = asset(document('manual'));
  initial.aiCompletion = { status: 'completed', processingKey: 'zh|0|1|1|1|1|1' };
  const f = setup({ initial, config: { automaticCompletionEnabled: false } });
  const result = await f.source.resolve(song);
  assert.equal(result.translation.state, 'idle');
  assert.equal(result.translation.supported, true);
  const started = await f.source.translate({ songId: song.id, textHash: initial.textHash, sourceRef: result.sourceRef });
  assert.equal((await started.settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});

for (const candidate of [null, document()]) {
  test('a song deleted during lookup cannot create a ready or negative-cache file: ' + Boolean(candidate), async () => {
    const f = setup({ candidate, resolveSong: async () => null });
    if (candidate) {
      const result = await f.source.resolve(song);
      await assert.rejects(result.onAdopt(), { code: 'LYRIC_SONG_DELETED' });
    } else await assert.rejects(f.source.resolve(song), { code: 'LYRIC_SONG_DELETED' });
    assert.equal((await f.store.get(song.id)).artifact, null);
    assert.equal(f.calls.ai, 0);
  });
}

test('a mainly Chinese song with foreign inserts needs no model or extra decision write', async () => {
  const chineseSong = { ...song, language: 'zh' };
  const f = setup({ candidate: document('kugou', 'word', '听着歌想念一个人 SHOW HA'),
    translationNeed: (_original, target) => ({ state: target.language === 'zh' ? 'not_needed' : 'needed' }) });
  const selected = await f.source.resolve(chineseSong);
  assert.equal(selected.translation.state, 'not_needed');
  assert.equal(f.calls.language, 0, 'a losing candidate is not assessed');
  const adopted = await selected.onAdopt();
  assert.equal(adopted.translation.state, 'not_needed'); assert.equal(adopted.translation.supported, false);
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.available, 0);
  assert.equal((await f.store.get(song.id)).artifact.translationDecision, undefined);
  await (await f.source.resolve(chineseSong)).onAdopt();
  assert.equal(f.calls.language, 0, 'the trusted language tag suffices on every read');
});

test('unknown first GET settles language assessment and pending dispatch without awaiting whole translation', { timeout: 1500 }, async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const unknownSong = { ...song, language: 'other' };
  const f = setup({ prepareLanguage: async (input, { store }) => {
    entered(); await gate;
    const read = input.deps.initialRead;
    const written = await store.putIfMatch(song.id, { ...read.artifact,
      translationDecision: { status: 'needed', sourceLanguage: 'ja', policyVersion: 2, textHash: read.artifact.textHash, targetLanguage: 'zh' },
      aiCompletion: { status: 'completed', updatedAt: new Date().toISOString() } }, read.etag);
    return { read: written, song: { ...input.song, language: 'ja' }, need: 'needed' };
  } });
  const selected = await f.source.resolve(unknownSong);
  const adopted = await selected.onAdopt();
  await started; assert.equal(adopted.translation.state, 'idle'); assert.equal(f.calls.ai, 0); assert.equal(f.calls.language, 1);
  assert.equal(typeof adopted.settled?.then, 'function');
  let settled = false; const assessment = adopted.settled.then(value => { settled = true; return value; });
  await Promise.resolve(); assert.equal(settled, false);
  release();
  const assessed = await assessment;
  assert.equal(assessed.translation.state, 'pending'); assert.equal(assessed.translation.supported, true);
  assert.deepEqual(assessed.translation.lines, []); assert.equal(assessed.document.lines[0].text, 'Hello world');
  assert.equal(f.calls.ai, 1, 'settling the GET dispatches translation'); assert.equal(f.tasks.length, 1);
  const translated = await f.source.translate({ songId: song.id, textHash: assessed.artifact.textHash, sourceRef: assessed.sourceRef }, { song: unknownSong });
  assert.equal(translated.translation.state, 'pending'); assert.equal(f.calls.language, 1); assert.equal(f.calls.ai, 1);
});

test('an explicit translation task exposes final completion instead of relying on waitUntil', { timeout: 1500 }, async () => {
  let finish, began;
  const task = new Promise(resolve => { finish = resolve; });
  const entered = new Promise(resolve => { began = resolve; });
  const tasks = [];
  const f = setup({ initial: asset(document('manual')), executionContext: { waitUntil(value) { tasks.push(value); } },
    beginCompletion: async (input, { begin }) => { const pending = await begin(input); began(); return { ...pending, task }; } });
  const adopted = await (await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.translation.state, 'idle'); assert.equal(f.calls.ai, 0); assert.equal(adopted.settled, undefined);
  const started = await f.source.translate({songId:song.id,textHash:adopted.artifact.textHash,sourceRef:adopted.sourceRef});
  assert.equal(started.translation.state, 'idle'); assert.deepEqual(tasks, []);
  assert.equal(typeof started.settled?.then, 'function');
  await entered;
  const pending = await f.store.get(song.id);
  const saved = await f.store.putIfMatch(song.id, { ...pending.artifact,
    translation: { language: 'zh', source: 'ai', originalTextHash: pending.artifact.textHash, lines: ['你好'] }, aiCompletion: { status: 'completed', updatedAt: new Date().toISOString() } }, pending.etag);
  finish(saved); assert.equal((await started.settled).translation.state, 'ready');
});

test('a language assessment failure preserves original lyrics and retries only on the translation action', async () => {
  const unknownSong={...song,language:'other'};
  const f = setup({ prepareLanguage: async (input, { store, calls }) => {
    const read = input.deps.initialRead;
    if (calls.language > 1) {
      const written = await store.putIfMatch(song.id, { ...read.artifact,
        translationDecision: { status: 'needed', sourceLanguage:'ja', policyVersion: 2, textHash: read.artifact.textHash, targetLanguage: 'zh' },
        aiCompletion: { status: 'completed', updatedAt: new Date().toISOString() } }, read.etag);
      return { read: written, song: input.song, need: 'needed' };
    }
    const failed = await store.putIfMatch(song.id, { ...read.artifact,
      aiCompletion: { status: 'failed', errorCode: 'language_assessment_undetermined', updatedAt: new Date().toISOString() } }, read.etag);
    return { read: failed, song: input.song, need: 'unknown' };
  },beginCompletion:async(input,{prepare,begin})=>{
    const prepared=await prepare(input);
    assert.equal(prepared.need,'needed');
    return begin({...input,song:prepared.song,deps:{...input.deps,initialRead:{...prepared.read,state:'found'}}});
  } });
  const adopted = await (await (await f.source.resolve(unknownSong)).onAdopt()).settled;
  assert.equal(adopted.translation.state, 'failed'); assert.equal(adopted.translation.supported, true);
  assert.equal(adopted.document.lines[0].text, 'Hello world'); assert.equal(f.calls.ai, 0);
  assert.equal(adopted.artifact.translationDecision, undefined);
  await (await f.source.resolve(unknownSong)).onAdopt(); assert.equal(f.calls.language, 1);
  const retried = await f.source.translate({ songId: song.id, textHash: adopted.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal((await retried.settled).translation.state, 'pending'); assert.equal(f.calls.language, 2); assert.equal(f.calls.ai, 1);
  assert.equal(f.calls.fetch, 1, 'retry reuses the adopted original');
});

test('a new-policy generation failure is not retried on each read but can be retried explicitly', async () => {
  const initial = asset(document('manual'));
  initial.translationDecision = { status: 'needed', policyVersion: 2, textHash: initial.textHash, targetLanguage: 'zh' };
  initial.aiCompletion = { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() };
  const f = setup({ initial });
  const adopted = await (await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.translation.state, 'failed'); assert.equal(f.calls.ai, 0);
  await (await f.source.resolve(song)).onAdopt(); assert.equal(f.calls.ai, 0);
  const started = await f.source.translate({ songId: song.id, textHash: initial.textHash });
  assert.equal((await started.settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});

test('old budget failures remain read-only and their public codes omit the retired retry scope', async () => {
  for (const errorCode of ['request_budget_exhausted', 'request_budget_exhausted_' + 'a'.repeat(32),
    'request_budget_retry_exhausted_' + 'a'.repeat(32)]) {
    const initial = asset(document('manual'));
    initial.aiCompletion = { status: 'failed', errorCode, updatedAt: new Date().toISOString() };
    initial.translationDecision = { status: 'needed', policyVersion: 2, textHash: initial.textHash, targetLanguage: 'zh' };
    let starts = 0;
    const f = setup({ initial, prepareLanguage: () => assert.fail('failed retries must be gated before language preparation'),
      beginCompletion: async input => { starts++; assert.equal(input.automatic, true); return { ...input.deps.initialRead, task: null }; } });
    const adopted = await (await f.source.resolve(song)).onAdopt();
    assert.equal(adopted.translation.state, 'failed'); assert.equal(adopted.translation.error.code, 'request_budget_exhausted');
    assert.equal(starts, 0); assert.equal(f.calls.language, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.put, 0);
    assert.equal((await f.store.get()).artifact.aiCompletion.errorCode, errorCode);
  }
});

test('a stale pending original cannot re-enter classification from an ordinary read', async () => {
  const initial = asset(document('manual'));
  initial.aiCompletion = { status: 'pending', updatedAt: new Date(Date.now() - 60_000).toISOString() };
  const f = setup({ initial, prepareLanguage: () => assert.fail('stale pending must not start classification') });
  const result = await (await f.source.resolve(song)).onAdopt();
  assert.equal(result.translation.state, 'failed'); assert.deepEqual(result.document.lines, initial.original.lines);
  assert.equal(f.calls.language, 0); assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.put, 0);
});

test('a legacy generation failure waits for an explicit action instead of restarting on reads', async () => {
  const initial = asset(document('manual'));
  initial.aiCompletion = { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() };
  const f = setup({ initial });
  const adopted = await (await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.translation.state, 'failed'); assert.equal(f.calls.language, 0); assert.equal(f.calls.ai, 0);
  await (await f.source.resolve(song)).onAdopt(); assert.equal(f.calls.language, 0); assert.equal(f.calls.ai, 0);
  const retry = await f.source.translate({ songId: song.id, textHash: initial.textHash }, { song });
  assert.equal((await retry.settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});

test('a legacy Chinese failure is displayed as unnecessary without rewriting its saved history', async () => {
  const initial = asset(document('manual', 'word', '听着歌想念一个人 SHOW HA'));
  initial.aiCompletion = { status: 'failed', errorCode: 'invalid_output', updatedAt: new Date().toISOString() };
  const f = setup({ initial, translationNeed: () => ({ state: 'not_needed' }) });
  const adopted = await (await f.source.resolve({ ...song, language: 'zh' })).onAdopt();
  assert.equal(adopted.translation.state, 'not_needed'); assert.equal(adopted.translation.supported, false);
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.available, 0);
  assert.equal(adopted.artifact.aiCompletion.status, 'failed'); assert.equal(f.store.calls.put, 0);
});

test('language preparation cannot start generation over a newly edited original', { timeout: 1500 }, async () => {
  const f = setup({ prepareLanguage: async (input, { store }) => {
    const read = await store.get(song.id);
    const edited = await store.putIfMatch(song.id, asset(document('manual', 'word', 'New edit')), read.etag);
    input.deps.checkCurrent(edited);
    return { read: edited, song: input.song, need: 'needed' };
  } });
  const selected = await f.source.resolve({...song,language:'other'});
  const adopted=await selected.onAdopt();
  await assert.rejects(adopted.settled, { code: 'LYRIC_RESULT_STALE' });
  assert.equal(f.calls.ai, 0); assert.equal((await f.store.get(song.id)).artifact.original.lines[0].text, 'New edit');
});

test('Subsonic adoption retains automatic completion because it has no JSON translation action', async () => {
  const principal={fixture:true};
  const f=setup({dependencies:{subsonicPrincipal:principal},beginCompletion:async(input,{begin})=>{
    assert.equal(input.automatic,true);assert.equal(input.deps.subsonicPrincipal,principal);return begin(input);
  }});
  const adopted=await(await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.translation.state,'idle');
  assert.equal((await adopted.settled).translation.state,'pending');assert.equal(f.calls.ai,1);assert.equal(f.calls.language,0);
});

test('explicit unknown classification returns a provisional result before its gate completes', { timeout: 1500 }, async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const initial = asset(document('manual'));
  const f = setup({ initial, beginCompletion: async (input, { begin }) => { entered(); await gate; return begin(input); } });
  const provisional = await f.source.translate({ songId: song.id, textHash: initial.textHash }, { song: { ...song, language: 'other' } });
  await started;
  assert.equal(provisional.translation.state, 'idle'); assert.equal(f.calls.ai, 0);
  let finished = false; const settled = provisional.settled.then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(finished, false);
  release(); assert.equal((await settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});

test('every processed provenance and completion state bypasses selection and generation on fresh ordinary reads', async () => {
  for (const provenance of [{}, { evaluation: 'manual' }, { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'weak', assessmentKey: 'old' }]) {
    for (const status of [null, 'failed', 'pending']) {
      const initial = asset(document(Object.keys(provenance).length ? 'lrclib' : 'manual', 'line'), { provenance,
        aiCompletion: status ? { status, errorCode: status === 'failed' ? 'ai_timeout' : undefined, updatedAt: new Date().toISOString() } : null });
      const f = setup({ initial, config: { assessmentKey: 'new', lyricPreference: 'word' },
        assessmentSettings: () => assert.fail('Processed files do not reload source assessment settings') });
      assert.equal(await f.source.claim(song), true);
      const result = await f.source.resolve(song), adopted = await result.onAdopt();
      assert.equal(result.quality, 'good'); assert.equal(adopted.settled, undefined);
      assert.deepEqual((await f.store.get(song.id)).artifact, initial);
      assert.equal(f.calls.fetch, 0); assert.equal(f.calls.language, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.retain, 0);
      assert.equal(f.store.calls.put, 0); assert.equal(f.store.calls.create, 0);
    }
  }
});

test('instrumental metadata short-circuits only when no processed file exists', async () => {
  const instrumental = { ...song, language: 'instrumental' };
  for (const initial of [asset(document('manual')), asset(document('lrclib'), { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed' } })]) {
    const f = setup({ initial }); assert.equal(await f.source.claim(instrumental), true);
    const adopted = await (await f.source.resolve(instrumental)).onAdopt();
    assert.equal(adopted.quality, 'good'); assert.deepEqual(adopted.document.lines, initial.original.lines);
    assert.equal(f.calls.fetch, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.language, 0);
  }
  for (const initial of [null, asset(document('youtube'))]) {
    const f = setup({ initial }); assert.equal(await f.source.claim(instrumental), false);
    assert.equal(await f.source.resolve(instrumental), null); assert.equal(f.calls.fetch, 0);
  }
});

test('a new provider candidate with a valid target translation is adopted ready without any AI work', async () => {
  const f = setup({ buildArtifact: async (_song, doc) => {
    const artifact = asset(doc); artifact.translation = { language: 'zh', source: 'provider', originalTextHash: artifact.textHash, lines: ['已有目标译文'] };
    return { artifact };
  } });
  const selected = await f.source.resolve(song); assert.equal(selected.translation.state, 'ready');
  const adopted = await selected.onAdopt(); assert.equal(adopted.translation.state, 'ready'); assert.deepEqual(adopted.translation.lines, ['已有目标译文']);
  assert.equal(f.calls.ai, 0); assert.equal(f.calls.language, 0); assert.equal(f.calls.available, 0); assert.equal(f.calls.retain, 0);
});

test('automatic settlement exposes pending while waitUntil owns the task and its accepted authority until finalization', { timeout: 1500 }, async () => {
  let finish, retained = 0, released = 0;
  const task = new Promise(resolve => { finish = resolve; }), hold = new AbortController(), caller = new AbortController(), tasks = [];
  const f = setup({ executionContext: { waitUntil(value) { tasks.push(value); } },
    dependencies: { retainBackgroundTask() { retained++; return { deadlineAt: 123456, signal: hold.signal, release() { released++; } }; } },
    beginCompletion: async (input, { begin }) => {
      assert.equal(retained, 1); assert.equal(input.automatic, true); assert.equal(input.deps.automaticDeadlineAt, 123456);
      assert.equal(input.deps.signal.aborted, false); hold.abort('retained-abort'); assert.equal(input.deps.signal.aborted, true);
      return { ...await begin(input), task };
    } });
  const adopted = await (await f.source.resolve(song, { signal: caller.signal })).onAdopt();
  const pending = await adopted.settled;
  assert.equal(pending.translation.state, 'pending'); assert.equal(tasks.length, 1); assert.equal(released, 0);
  finish(pending); await tasks[0]; assert.equal(released, 1);
});

test('automatic authority releases on no task, initialization errors and failed waitUntil registration', async () => {
  for (const mode of ['joined', 'throws', 'registration']) {
    let released = 0; const hold = new AbortController();
    const f = setup({ dependencies: { retainBackgroundTask() { return { deadlineAt: Date.now() + 28000, signal: hold.signal,
      release() { released++; hold.abort('released'); } }; } },
      executionContext: mode === 'registration' ? { waitUntil() { throw new Error('registration failed'); } } : undefined,
      beginCompletion: async (input, { begin }) => {
        if (mode === 'throws') throw new Error('begin failed');
        const pending = await begin(input);
        return { ...pending, task: mode === 'joined' ? null : new Promise(resolve => {
          input.deps.signal.addEventListener('abort', () => resolve({ state: 'superseded' }), { once: true });
        }) };
      } });
    const adopted = await (await f.source.resolve(song)).onAdopt();
    if (mode === 'joined') assert.equal((await adopted.settled).translation.state, 'pending');
    else await assert.rejects(adopted.settled, /failed/u);
    assert.equal(released, 1); assert.equal(hold.signal.aborted, true);
  }
});

test('without host background retention automatic reads stay idle and explicit translation remains available', async () => {
  const f = setup({ dependencies: { retainBackgroundTask: undefined } });
  const adopted = await (await f.source.resolve(song)).onAdopt();
  assert.equal(adopted.translation.state, 'idle'); assert.equal(adopted.settled, undefined); assert.equal(f.calls.ai, 0);
  const started = await f.source.translate({ songId: song.id, textHash: adopted.artifact.textHash });
  assert.equal((await started.settled).translation.state, 'pending'); assert.equal(f.calls.ai, 1);
});
