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
function setup({ initial = null, candidate = document(), config = {}, available = true, failure = null, projectTranslation = artifact => artifact.translation, dependencies = {}, resolveSong = async () => song } = {}) {
  const store = memory(initial), calls = { fetch: 0, ai: 0, available: 0, read: 0, authority: 0 };
  const settings = { onlineEnabled: true, lyricPreference: 'word', targetLanguage: 'zh', completionEnabled: true, automaticCompletionEnabled: true, ...config };
  const begin = async ({ song: target, deps }) => {
    calls.ai++; const read = await store.get(target.id);
    if (deps?.initialRead) assert.equal(deps.initialRead.state, 'found');
    deps?.checkCurrent?.(read);
    return store.putIfMatch(target.id, { ...read.artifact, aiCompletion: { status: 'pending', updatedAt: new Date().toISOString() } }, read.etag);
  };
  const source = createWorkbenchSourceCore({ env: {}, db: {}, session: { account: { accountId: 'member' } }, store, dependencies,
    operations: {
      settings: async () => settings, assertCurrent: async () => { calls.authority++; }, createDocument: x => structuredClone(x),
      buildArtifact: async (_song, doc) => ({ artifact: asset(doc) }),
      project: value => ({ translation: projectTranslation(value), translationState: value.aiCompletion?.status === 'pending' ? 'pending' : value.aiCompletion?.status === 'failed' ? 'failed' : 'missing' }),
      resolveTranslationNeed: () => ({ state: 'needed' }),
      hasNoTranslationDecision: (artifact, _song, { targetLanguage }) => artifact.translationDecision?.status === 'not_needed'
        && artifact.translationDecision.textHash === artifact.textHash && artifact.translationDecision.targetLanguage === targetLanguage,
      preferred: (left, right) => ({ none: 0, line: 1, word: 2 }[left.syncMode] > { none: 0, line: 1, word: 2 }[right.syncMode]), reliable: value => !value.providerMeta?.versionMismatch,
      fetchCandidate: async () => { calls.fetch++; if (failure) throw failure; return candidate; },
      aiAvailable: async () => { calls.available++; return available; }, aiConfig: async () => settings,
      translationError: code => ({ code, message: 'Safe translation error' }),
      resolveSong, beginCompletion: begin,
      readPlayback: async ({ song: target, deps }) => { calls.read++; let read = await deps.readOrCreateLyricArtifact();
        if (settings.completionEnabled && settings.automaticCompletionEnabled && available && !read.artifact.translation && read.artifact.aiCompletion?.status !== 'pending') read = await begin({ song: target });
        return read;
      },
    } });
  return { source, store, calls, settings };
}

test('an offline empty workbench does not claim or search a song', async () => {
  const f = setup({ config: { onlineEnabled: false } });
  assert.equal(await f.source.claim(song), false); assert.equal(await f.source.resolve(song), null);
  assert.equal(f.calls.fetch, 0); assert.equal(f.calls.ai, 0);
});

test('a weak workbench result has no storage or AI side effects before adoption', async () => {
  const f = setup({ candidate: document('lrclib', 'line') }); const result = await f.source.resolve(song);
  assert.equal(result.quality, 'weak'); assert.equal(result.translation.supported, true);
  assert.equal(f.calls.ai, 0); assert.equal(f.store.calls.create, 0); assert.equal(f.store.calls.put, 0);
});

test('adopting an automatic result saves assessment before starting one selected-body completion', async () => {
  const f = setup(); const result = await f.source.resolve(song); const adopted = await result.onAdopt();
  assert.equal(adopted.translation.state, 'pending'); assert.equal(f.calls.ai, 1);
  const saved = await f.store.get(song.id); assert.equal(saved.artifact.provenance.managedBy, 'lyrics-workbench');
  assert.equal(saved.artifact.provenance.evaluation, 'assessed'); assert.equal(saved.artifact.provenance.quality, 'good');
  await f.source.translate({ songId: song.id, textHash: saved.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal(f.calls.ai, 1, 'pending work is reused');
});

test('manual mode advertises translation but waits for the owning-source action', async () => {
  const f = setup({ config: { automaticCompletionEnabled: false } });
  const result = await f.source.resolve(song); assert.equal(result.translation.state, 'idle');
  const adopted = await result.onAdopt(); assert.equal(f.calls.ai, 0);
  const translated = await f.source.translate({ songId: song.id, textHash: adopted.artifact.textHash, sourceRef: adopted.sourceRef });
  assert.equal(f.calls.ai, 1); assert.equal(translated.translation.state, 'pending');
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
  assert.equal(next.provenance.originalSource, 'youtube');
});

test('an assessed weak file does not become good solely because it was written', async () => {
  const initial = asset(document('lrclib', 'line'), { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'weak' } });
  const f = setup({ initial }); const result = await f.source.resolve(song);
  assert.equal(result.quality, 'weak'); assert.equal(f.calls.fetch, 0);
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

test('a changed assessment key rechecks precision and sources once, AI mode alone does not', async () => {
  const oldKey = 'a'.repeat(64), newKey = 'b'.repeat(64);
  const initial = asset(document('lrclib', 'line'), { provenance: { managedBy: 'lyrics-workbench', evaluation: 'assessed', quality: 'good', assessmentKey: oldKey } });
  const f = setup({ initial, config: { assessmentKey: oldKey, lyricPreference: 'line', completionEnabled: false } });
  await f.source.resolve(song); assert.equal(f.calls.fetch, 0);
  f.settings.assessmentKey = newKey; f.settings.lyricPreference = 'word';
  const result = await f.source.resolve(song); assert.equal(f.calls.fetch, 1); await result.onAdopt();
  const saved = await f.store.get(song.id); assert.equal(saved.artifact.provenance.assessmentKey, newKey);
  f.settings.automaticCompletionEnabled = false; await f.source.resolve(song); assert.equal(f.calls.fetch, 1);
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

test('automatic adoption bypasses the retired playback resolver and shares the direct completion path', async () => {
  const f = setup(); const result = await f.source.resolve(song); await result.onAdopt();
  assert.equal(f.calls.read, 0); assert.equal(f.calls.ai, 1);
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
    assert.equal(f.calls.ai, 0);
    if (completionEnabled) {
      const started = await f.source.translate({ songId: song.id, textHash: initial.textHash, sourceRef: adopted.sourceRef });
      assert.equal(started.translation.state, 'pending');
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
  assert.equal(started.translation.state, 'pending'); assert.equal(f.calls.ai, 1);
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
