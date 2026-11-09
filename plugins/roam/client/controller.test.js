import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoamController } from './controller.js';
import { appendRollingRoam } from './rolling.js';

const song = id => ({ id, audio_url: `/media/${id}.mp3` });
const flush = () => new Promise(resolve => setImmediate(resolve));
const reply = (ids, extra = {}) => ({ code: 200, data: { songs: ids.map(song), totalPlayable: 20, remainingPlayable: 8, exhausted: false, strategy: 'recent', ...extra } });
function fixture(t, { queue = ['a', 'b', 'c'], current = 'a', ready = true, storage, account = 'one', legacy = {} } = {}) {
  let snapshot = { queue: queue.map(song), currentSong: current ? song(current) : null, isPlaying: !!current, playMode: 'sequence', revision: 1, ready };
  let continuation = null, valid = true;
  const listeners = new Set(), requests = [], timers = new Map();
  const abort = new AbortController();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const next = patch => { snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }; notify(); };
  const host = { signal: abort.signal, isCurrent: () => valid,
    session: { get: () => ({ user: { accountId: account } }) },
    request: (path, options) => new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })),
    catalog: { hydrateSong: value => value },
    queue: {
      getSnapshot: () => snapshot, getLegacyPreferences: () => legacy,
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      registerContinuation(value) { continuation = value; return () => { continuation = null; }; },
      append(songs, options) {
        if (options.expectedRevision !== snapshot.revision || options.expectedCurrentSongId !== (snapshot.currentSong?.id ?? null)) return { added: [], snapshot, stale: true };
        const appended = appendRollingRoam(snapshot.queue, snapshot.currentSong, { waitingAtQueueEnd: controller.getState().waitingAtQueueEnd }, songs);
        next({ queue: appended.playlist, ...(options.resume && appended.additions.length ? { currentSong: appended.additions[0], isPlaying: true } : {}) });
        return { added: appended.additions, snapshot };
      },
      setSequence() { next({ playMode: 'sequence' }); },
      trimAfterCurrent() { const index = snapshot.queue.findIndex(item => item.id === snapshot.currentSong?.id); if (index >= 0) next({ queue: snapshot.queue.slice(0, index + 1) }); },
      start(songs) { if (!songs.length) return false; next({ queue: songs, currentSong: songs[0], isPlaying: true, playMode: 'sequence' }); return true; },
    },
  };
  let timerId = 0;
  const controller = createRoamController(host, { storage, setTimeoutImpl: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeoutImpl: id => timers.delete(id) });
  controller.start(); t.after(() => controller.dispose());
  return { controller, requests, host, timers, get snapshot() { return snapshot; },
    stop() { valid = false; abort.abort(); },
    pause() { snapshot = { ...snapshot, isPlaying: false }; continuation.onPause(snapshot); notify(); },
    end() { const handled = continuation.onQueueEnd(snapshot); snapshot = { ...snapshot, isPlaying: false }; notify(); return handled; },
    clear() { next({ queue: [], currentSong: null, isPlaying: false }); continuation.onQueueCleared(snapshot); },
    explicit(id) { next({ queue: [song(id)], currentSong: song(id), isPlaying: true }); continuation.onExplicitPlay(snapshot); },
    mode(mode) { next({ playMode: mode }); continuation.onModeChange(snapshot); },
    advance(id) { next({ currentSong: song(id), isPlaying: true }); },
    removeTail() { next({ queue: snapshot.queue.slice(0, -1), currentSong: null, isPlaying: false }); return continuation.onQueueEnd(snapshot); },
    ready(value) { snapshot = { ...snapshot, ready: value }; notify(); },
  };
}

test('installation starts disabled and imports only legacy language and batch preferences', async t => {
  const f = fixture(t, { legacy: { enabled: true, language: 'zh', batchSize: 7, resumeWhenAppended: true } });
  await flush(); assert.equal(f.requests.length, 0);
  assert.equal(f.controller.getState().enabled, false); assert.equal(f.controller.getState().language, 'zh');
  assert.equal(f.controller.getState().batchSize, 7); assert.equal(f.controller.getState().resumeWhenAppended, false);
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b', 'c']);
});

test('explicit enable samples through plugin host; retirement aborts and rejects late songs without changing playback', async t => {
  const f = fixture(t); f.controller.setEnabled(true); await flush();
  assert.equal(f.requests[0].path, 'sample'); assert.equal(f.requests[0].options.method, 'POST');
  f.stop(); assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[0].resolve(reply(['d', 'e'])); await flush();
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b', 'c']); assert.equal(f.snapshot.isPlaying, true);
  assert.equal(f.controller.getState().available, false); assert.equal(f.timers.size, 0);
});

test('pausing at queue end cancels resume permission but a current batch may still join the queue', async t => {
  const f = fixture(t, { queue: ['a'], current: 'a' }); f.controller.setEnabled(true); await flush();
  assert.equal(f.end(), true); f.pause();
  f.requests[0].resolve(reply(['b', 'c', 'd'])); await flush();
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b', 'c', 'd']); assert.equal(f.snapshot.isPlaying, false);
});

test('queue end continues with deduplicated additions, and an exhausted source stops', async t => {
  const f = fixture(t, { queue: ['a'], current: 'a' }); f.controller.setEnabled(true); f.end(); await flush();
  f.requests[0].resolve(reply(['a', 'b', 'b', 'c'])); await flush();
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b', 'c']); assert.equal(f.snapshot.currentSong.id, 'b');
  assert.equal(f.snapshot.isPlaying, true);
  const e = fixture(t, { queue: [], current: null }); e.controller.setEnabled(true); await flush();
  e.requests[0].resolve(reply([], { exhausted: true, remainingPlayable: 0 })); await flush();
  assert.equal(e.controller.getState().enabled, false); assert.equal(e.controller.getState().status, 'exhausted');
});

test('language change retains played/current songs and cancels old-language results', async t => {
  const f = fixture(t, { queue: ['a', 'b', 'c'], current: 'b' }); f.controller.setEnabled(true); await flush();
  f.controller.setLanguage('ja'); await flush();
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b']);
  assert.equal(f.requests[0].options.signal.aborted, true); assert.equal(f.requests[1].options.body.language, 'ja');
  f.requests[0].resolve(reply(['wrong'])); f.requests[1].resolve(reply(['correct', 'new', 'tail'])); await flush();
  assert.ok(!f.snapshot.queue.some(item => item.id === 'wrong')); assert.equal(f.snapshot.currentSong.id, 'b');
});

test('clear, explicit play and non-sequence mode disable continuation and discard obsolete results', async t => {
  for (const action of ['clear', 'explicit', 'mode']) await t.test(action, async t => {
    const f = fixture(t); f.controller.setEnabled(true); await flush();
    if (action === 'clear') f.clear(); else if (action === 'explicit') f.explicit('chosen'); else f.mode('random');
    const retained = f.snapshot.queue.map(item => item.id);
    f.requests[0].resolve(reply(['late'])); await flush();
    assert.equal(f.controller.getState().enabled, false); assert.deepEqual(f.snapshot.queue.map(item => item.id), retained);
  });
});

test('manual batches work while automatic mode is disabled; an empty queue may explicitly start', async t => {
  const f = fixture(t, { queue: ['a', 'b', 'c', 'd'], current: 'a' });
  f.controller.requestManual(); await flush(); f.requests[0].resolve(reply(['e', 'f'])); await flush();
  assert.equal(f.controller.getState().enabled, false); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.snapshot.queue.map(item => item.id), ['a', 'b', 'c', 'd', 'e', 'f']);
  const empty = fixture(t, { queue: [], current: null }); empty.controller.requestManual(); await flush();
  empty.requests[0].resolve(reply(['start', 'second', 'third', 'fourth'])); await flush();
  assert.equal(empty.snapshot.currentSong.id, 'start'); assert.equal(empty.snapshot.isPlaying, true);
});

test('manual batch errors can retry once without enabling automatic mode', async t => {
  const f = fixture(t, { queue: ['a', 'b', 'c', 'd'], current: 'a' });
  f.controller.requestManual(); await flush(); f.requests[0].reject(new Error('offline')); await flush();
  assert.equal(f.controller.getState().status, 'error');
  assert.equal(f.controller.retry(), true); await flush();
  f.requests[1].resolve(reply(['e', 'f'])); await flush();
  assert.equal(f.requests.length, 2); assert.equal(f.controller.getState().enabled, false);
  assert.equal(f.snapshot.currentSong.id, 'a');
});

test('a changed queue rejects stale songs and source metadata, then samples the current queue', async t => {
  const f = fixture(t); f.controller.setEnabled(true); await flush();
  f.advance('b'); f.requests[0].resolve(reply(['old'], { exhausted: true, remainingPlayable: 0 })); await flush();
  assert.equal(f.controller.getState().enabled, true); assert.equal(f.controller.getState().exhausted, false);
  assert.equal(f.requests.length, 2); assert.ok(!f.snapshot.queue.some(item => item.id === 'old'));
  assert.deepEqual(f.requests[1].options.body.queuedSongIds, ['b', 'c']);
  f.requests[1].resolve(reply(['d', 'e', 'f'])); await flush();
  assert.equal(f.snapshot.currentSong.id, 'b'); assert.equal(f.controller.getState().status, 'idle');
});

test('an explicit seed list starts sequence playback before automatic continuation', async t => {
  const f = fixture(t, { queue: ['existing'], current: 'existing' });
  assert.equal(f.controller.startWithSongs([song('seed'), song('next')], { language: 'en' }), true);
  assert.equal(f.snapshot.currentSong.id, 'seed'); assert.equal(f.snapshot.isPlaying, true);
  assert.equal(f.snapshot.playMode, 'sequence'); assert.equal(f.controller.getState().language, 'en');
  assert.equal(f.controller.getState().enabled, true);
  await flush(); assert.equal(f.requests[0].options.body.language, 'en');
});

test('queue deletion at the current tail waits for a batch and resumes only while permission is retained', async t => {
  const f = fixture(t, { queue: ['a', 'b'], current: 'b' }); f.controller.setEnabled(true); f.removeTail(); await flush();
  assert.equal(f.requests[0].options.body.queuedSongIds.length, 0);
  f.requests[0].resolve(reply(['c', 'd', 'e'])); await flush();
  assert.equal(f.snapshot.currentSong.id, 'c'); assert.equal(f.snapshot.isPlaying, true);
});

test('failed requests stay retryable; timeouts settle even if transport ignores cancellation', async t => {
  const f = fixture(t); f.controller.setEnabled(true); await flush();
  f.requests[0].reject(Object.assign(new Error('unavailable'), { status: 503 })); await flush();
  assert.equal(f.controller.getState().status, 'error'); assert.equal(f.requests.length, 1);
  f.controller.retry(); await flush(); assert.equal(f.requests.length, 2);
  [...f.timers.values()][0](); await flush();
  assert.equal(f.controller.getState().status, 'error'); assert.equal(f.controller.getState().error, '续播请求超时，请重试');
  f.requests[1].resolve(reply(['late'])); await flush(); assert.ok(!f.snapshot.queue.some(item => item.id === 'late'));
});

test('ready and account-scoped preferences do not restore old autoplay permission', async t => {
  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const f = fixture(t, { ready: false, storage }); assert.equal(f.controller.setEnabled(true), false);
  f.ready(true); f.controller.setLanguage('ko'); f.controller.setBatchSize(500); assert.equal(f.controller.getState().batchSize, 50);
  f.controller.dispose();
  const restored = fixture(t, { storage }); assert.equal(restored.controller.getState().language, 'ko'); assert.equal(restored.controller.getState().enabled, false);
  const other = fixture(t, { storage, account: 'two' }); assert.equal(other.controller.getState().language, 'all');
  other.controller.setBatchSize(-1); assert.equal(other.controller.getState().batchSize, 10);
});
