import assert from 'node:assert/strict';
import test from 'node:test';
import { playAssistantInlineSong, activateInlineAssistantSong } from './inlinePlayback.js';

function fixture() {
  let current = true, playing = null, finish;
  const calls = [], notices = [];
  const song = { id: 'one', title: 'Test', audio_url: 'https://audio.test/one.mp3' };
  const host = { isCurrent: () => current, assertCurrent() { if (!current) throw new DOMException('Ended', 'AbortError'); },
    player: { getSnapshot: () => playing || { currentSong: null }, execute: async value => { calls.push(value); return { ok: true }; } },
    catalog: { resolveSong: async id => { calls.push(['lookup', id]); return song; } }, notify: text => notices.push(text) };
  return { host, song, calls, notices, retire() { current = false; }, snapshot(value) { playing = value; } };
}
test('an explicit inline activation resolves through the host and executes one scoped play', async () => {
  const f = fixture(); assert.deepEqual(f.calls, []);
  assert.deepEqual(await playAssistantInlineSong('one', { host: f.host }), { ok: true, outcome: 'started' });
  assert.deepEqual(f.calls[0], ['lookup', 'one']); assert.equal(f.calls[1].song, f.song); assert.equal(f.calls[1].action, 'play_song');
  assert.equal(f.notices.length, 1);
});
test('the active song resumes without refetch and retired lookup cannot start playback or notify', async () => {
  const f = fixture(); f.snapshot({ currentSong: f.song, isPlaying: false });
  assert.equal((await playAssistantInlineSong('one', { host: f.host })).outcome, 'resumed');
  assert.deepEqual(f.calls, [{ type: 'control', action: 'play' }]);
  let resolve; f.snapshot(null); f.calls.length = 0;
  const pending = playAssistantInlineSong('one', { host: f.host, fetchSong: () => new Promise(done => { resolve = done; }) });
  f.retire(); resolve(f.song); await pending; assert.deepEqual(f.calls, []); assert.deepEqual(f.notices, []);
});
test('inline keyboard activation requires Enter or Space and never auto-executes prose', () => {
  const calls = [], event = key => ({ key, target: { closest: () => ({ getAttribute: () => 'one' }) }, preventDefault() {}, stopPropagation() {} });
  assert.equal(activateInlineAssistantSong(event('Escape'), { keyboard: true, playSong: id => calls.push(id) }), false);
  assert.equal(activateInlineAssistantSong(event('Enter'), { keyboard: true, playSong: id => calls.push(id) }), true);
  assert.deepEqual(calls, ['one']);
});
