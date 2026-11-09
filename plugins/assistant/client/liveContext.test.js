import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAssistantLiveContext } from './liveContext.js';

test('assistant snapshot reflects the song selected at send time and only bounded recent context', () => {
  const state = { currentSong: { id: 'last-christmas', title: 'Last Christmas', artist: 'Wham!' },
    isPlaying: true, progress: 12, duration: 263, playMode: 'loop',
    playlist: [{ id: 'old', title: '只因你太美' },
      { id: 'last-christmas', title: 'Last Christmas' }, { id: 'next', title: '下一首' }] };
  const snapshot = captureAssistantLiveContext(state,
    [{ title: '更早' }, { title: '只因你太美' }], [{ id: 'call-1', ok: false, outcome: 'playback_rejected' }]);
  assert.equal(snapshot.playback.songId, 'last-christmas');
  assert.equal(snapshot.playback.currentIndex, 2);
  assert.deepEqual(snapshot.playback.upcomingSongs.map((song) => song.id), ['next']);
  assert.equal(snapshot.recentPlayback.at(-1).title, '只因你太美');
  assert.deepEqual(snapshot.playerActionReceipts, [{ id: 'call-1', ok: false,
    outcome: 'playback_rejected' }]);
  assert.ok(snapshot.timeZone);
});

test('assistant snapshot marks no selected song without inheriting an earlier title', () => {
  const snapshot = captureAssistantLiveContext({ currentSong: null, playlist: [], isPlaying: false });
  assert.equal(snapshot.playback.songId, '');
  assert.equal(snapshot.playback.title, '');
  assert.equal(snapshot.playback.isPlaying, false);
});
