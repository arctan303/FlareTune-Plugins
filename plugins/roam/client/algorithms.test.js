import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRandomRoamPayload,
  createInactiveRandomRoam,
  getRandomRoamRemainingAfterCurrent,
  normalizeRandomRoamResponse,
  normalizeRandomRoamSongIds,
  normalizeRandomRoamState,
  shouldPrefetchRandomRoam,
} from './algorithms.js';

const song = (id) => ({ id, audio_url: `/${id}.mp3` });

test('random roam ids are string-normalized, unique and bounded', () => {
  assert.deepEqual(normalizeRandomRoamSongIds([' a ', 'a', 2, '', null, 'x'.repeat(81)]), ['a', '2']);
  assert.equal(normalizeRandomRoamSongIds(Array.from({ length: 5010 }, (_, index) => index)).length, 5000);
});

test('random roam persistence restores an active round without a stale loading lock', () => {
  const restored = normalizeRandomRoamState({
    enabled: true,
    seenSongIds: ['a', 'a', 'b'],
    totalPlayable: 20,
    status: 'loading',
    waitingAtQueueEnd: true,
  });
  assert.equal(restored.enabled, true);
  assert.equal(restored.status, 'idle');
  assert.deepEqual(restored.seenSongIds, ['a', 'b']);
  assert.equal(restored.waitingAtQueueEnd, true);
  assert.equal(restored.resumeWhenAppended, false);
  assert.deepEqual(normalizeRandomRoamState(null), createInactiveRandomRoam());
});

test('random roam prefetches at two remaining songs and stops after the playable total is queued', () => {
  const playlist = ['a', 'b', 'c', 'd'].map(song);
  const randomRoam = { ...createInactiveRandomRoam(), enabled: true, seenSongIds: ['a', 'b', 'c', 'd'] };
  assert.equal(getRandomRoamRemainingAfterCurrent(playlist, playlist[1]), 2);
  assert.equal(shouldPrefetchRandomRoam({ randomRoam, playlist, currentSong: playlist[1] }), true);
  assert.equal(shouldPrefetchRandomRoam({
    randomRoam: { ...randomRoam, exhausted: true },
    playlist,
    currentSong: playlist[1],
  }), false);
  assert.equal(shouldPrefetchRandomRoam({
    randomRoam: { ...randomRoam, status: 'error' },
    playlist,
    currentSong: playlist[1],
  }), false);
});

test('random roam requests include both persisted history and current queue ids, limit and optional language', () => {
  const payloadAll = buildRandomRoamPayload(
    { seenSongIds: ['old', 'same'], language: 'all' },
    [song('same'), song('new')],
  );
  assert.deepEqual(payloadAll, { strategy: 'recent', recentSongIds: [], queuedSongIds: ['same', 'new'], limit: 10 });

  const payloadZh = buildRandomRoamPayload(
    { seenSongIds: ['old'], language: 'zh', batchSize: 5 },
    [song('zh-1')],
  );
  assert.deepEqual(payloadZh, { strategy: 'recent', recentSongIds: [], queuedSongIds: ['zh-1'], limit: 5, language: 'zh' });
});

test('random roam normalization preserves language and batchSize preference', () => {
  const restored = normalizeRandomRoamState({
    enabled: true,
    language: 'ja',
    batchSize: 15,
    manualNonce: 2,
    seenSongIds: ['ja-1'],
  });
  assert.equal(restored.language, 'ja');
  assert.equal(restored.batchSize, 15);
  assert.equal(restored.manualNonce, 2);

  const restoredInactive = normalizeRandomRoamState({
    enabled: false,
    language: 'en',
    batchSize: 20,
  });
  assert.equal(restoredInactive.language, 'en');
  assert.equal(restoredInactive.batchSize, 20);
});

test('random roam triggers prefetch immediately when manualNonce is higher than last handled', () => {
  const playlist = ['a', 'b', 'c', 'd', 'e'].map(song);
  const randomRoam = { ...createInactiveRandomRoam(), enabled: true, manualNonce: 1 };
  // Queue remaining > 2, normal prefetch would be false, but manualNonce > lastHandled(0) triggers it
  assert.equal(shouldPrefetchRandomRoam({
    randomRoam,
    playlist,
    currentSong: playlist[0],
    lastHandledManualNonce: 0,
  }), true);

  // Once handled, normal prefetch rule applies (remaining = 4 > 2 -> false)
  assert.equal(shouldPrefetchRandomRoam({
    randomRoam,
    playlist,
    currentSong: playlist[0],
    lastHandledManualNonce: 1,
  }), false);
});

test('random roam response requires songs, server exhaustion and non-negative playable counts', () => {
  assert.deepEqual(normalizeRandomRoamResponse({ data: {
    songs: [song('a')], totalPlayable: 1, remainingPlayable: 0, exhausted: true,
  } }), {
    songs: [song('a')],
    totalPlayable: 1,
    remainingPlayable: 0,
    exhausted: true,
  });
  assert.throws(() => normalizeRandomRoamResponse({ data: {
    songs: [], totalPlayable: -1, remainingPlayable: 0, exhausted: true,
  } }));
  assert.throws(() => normalizeRandomRoamResponse({ data: { totalPlayable: 1 } }));
});
