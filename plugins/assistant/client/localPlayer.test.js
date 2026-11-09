import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchLocalAssistantPlayerAction } from './localPlayer.js';
test('assistant commands use only the host player and unavailable optional Roam does not access its controller', async () => {
  const calls = [], notices = [];
  const host = { assertCurrent() {}, features: { isAvailable: () => false },
    catalog: { hydrateSong: value => value }, player: { execute: async value => { calls.push(value); return { ok: true }; } },
    notify: value => notices.push(value) };
  const song = { id: 'one', title: 'One' };
  assert.equal((await dispatchLocalAssistantPlayerAction({ type: 'play_now', action: 'play_song', song }, { host })).ok, true);
  assert.deepEqual(calls, [{ type: 'play_now', action: 'play_song', song }]); assert.equal(notices.length, 1);
  assert.equal((await dispatchLocalAssistantPlayerAction({ type: 'roam', action: 'enable' }, { host })).ok, false);
  assert.equal(calls.length, 1); assert.equal(notices.length, 1);
});
