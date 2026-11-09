import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRollingRoam, recentRoamIds } from './rolling.js';
import { buildRandomRoamPayload } from './algorithms.js';
const song = id => ({ id, audio_url: `/${id}.mp3` });

test('requests distinguish played history from current and upcoming songs', () => {
  const queue = ['a', 'b', 'c', 'd'].map(song);
  const payload = buildRandomRoamPayload({ recentSongIds: ['old', 'a'], batchSize: 10 }, queue, queue[2]);
  assert.deepEqual(payload.recentSongIds, ['old', 'a', 'b']);
  assert.deepEqual(payload.queuedSongIds, ['c', 'd']);
  assert.equal(payload.strategy, 'recent');
});

test('old recommendations relocate without duplicate queue IDs or losing the current song', () => {
  const queue = ['a', 'b', 'c', 'd'].map(song);
  const result = appendRollingRoam(queue, queue[2], { recentSongIds: ['old'] }, ['a', 'c', 'd', 'e', 'e'].map(song));
  assert.deepEqual(result.playlist.map(s => s.id), ['b', 'c', 'd', 'a', 'e']);
  assert.deepEqual(result.additions.map(s => s.id), ['a', 'e']);
  assert.deepEqual(result.recentSongIds, ['old', 'a', 'b']);
  assert.equal(result.playlist[1], queue[2]);
});

test('removing the current tail allows its played prefix to be sampled again', () => {
  const payload = buildRandomRoamPayload({ waitingAtQueueEnd: true }, ['a', 'b'].map(song), null);
  assert.deepEqual(payload.queuedSongIds, []);
  assert.deepEqual(payload.recentSongIds, ['a', 'b']);
});

test('recent history stays bounded and keeps latest IDs when the history fills up', () => {
  const ids = recentRoamIds([...Array.from({ length: 5010 }, (_, i) => String(i)), '5008']);
  assert.ok(ids.length <= 5000);
  assert.equal(ids.at(-1), '5008');
  assert.ok(!ids.includes('0'));
  assert.equal(new Set(ids).size, ids.length);
});
