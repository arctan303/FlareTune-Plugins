import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeakerSessionGuard, speakerRequest } from './speakers.js';
test('speaker transport uses the supplied host namespace, signal and units without receiving CSRF or stores', async () => {
  const calls = [], signal = new AbortController().signal;
  const host = { request: async (...args) => { calls.push(args); return { outcome: 'sent' }; } };
  await speakerRequest('status', host, undefined, { signal });
  await speakerRequest('seek', host, { speakerId: 'device', positionSeconds: 12 }, { signal });
  await speakerRequest('volume', host, { volume: 37 }, { signal });
  assert.equal(calls[0][0], ''); assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].signal, signal);
  assert.equal(calls[1][1].body.positionSeconds, 12); assert.equal(calls[2][1].body.volume, 37);
  assert.doesNotMatch(JSON.stringify(calls), /csrfToken|accountId/);
});
test('speaker scope rejects late replies and future operations after retirement', async () => {
  let current = true, resolve;
  const host = { isCurrent: () => current }, scope = createSpeakerSessionGuard(host);
  const pending = scope.run(() => new Promise(done => { resolve = done; }));
  current = false; assert.equal(scope.isCurrent(), false); assert.equal(scope.signal.aborted, true);
  resolve({ secret: 'old' }); await assert.rejects(pending, { name: 'AbortError' });
  current = true; await assert.rejects(scope.run(async () => true), { name: 'AbortError' });
});
