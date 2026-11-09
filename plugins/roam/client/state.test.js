import test from 'node:test';
import assert from 'node:assert/strict';
import { bindRoamController, getRoamState, roamActions, subscribeRoam } from './state.js';

function controller(language) {
  const listeners = new Set(), calls = [];
  let current = true, state = { available: true, enabled: false, language, batchSize: 10 };
  return { calls, getState: () => state, isCurrent: () => current,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) { calls.push(value); return true; },
    update(patch) { state = { ...state, ...patch }; for (const listener of listeners) listener(); },
    retire() { current = false; },
  };
}

test('a new account binding rejects old updates, cleanup and controls', () => {
  const first = controller('zh'), second = controller('en');
  const updates = [], stop = subscribeRoam(() => updates.push(getRoamState().language));
  const unbindFirst = bindRoamController(first);
  assert.equal(getRoamState().language, 'zh');
  const unbindSecond = bindRoamController(second);
  first.update({ enabled: true, language: 'ja' }); unbindFirst();
  assert.equal(getRoamState().language, 'en'); assert.equal(getRoamState().enabled, false);
  roamActions.setRandomRoamEnabled(true); assert.deepEqual(second.calls, [true]); assert.deepEqual(first.calls, []);
  second.retire(); assert.equal(roamActions.setRandomRoamEnabled(true), false);
  unbindSecond();
  assert.equal(getRoamState().available, false); assert.equal(getRoamState().language, 'all');
  assert.equal(roamActions.setRandomRoamEnabled(true), false);
  assert.deepEqual(updates, ['zh', 'en', 'all']); stop();
});
