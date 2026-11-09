import test from 'node:test';
import assert from 'node:assert/strict';
import { getAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, getAiProviderModels, saveAiFeatureModel } from './api.js';

test('Gateway settings use only their plugin-owned administrator endpoints and do not transmit the host identity', async () => {
  const calls = [];
  const host = { assertCurrent() {}, request: async (path, options) => { calls.push({ path, options }); return { ok: true }; } };
  await getAiProviders(host);
  await createAiProvider({ source: 'deepseek', apiKey: 'entered-only-key' }, host);
  await updateAiProvider('provider-id', { name: 'New' }, 3, host);
  await deleteAiProvider('provider-id', 4, host);
  await getAiProviderModels('provider-id', 4, host);
  await saveAiFeatureModel({ feature: 'assistant', providerId: 'provider-id', expectedRevision: 2 }, host);
  assert.deepEqual(calls.map(call => call.path), ['providers', 'providers', 'providers/provider-id', 'providers/provider-id', 'provider-models', 'feature-models']);
  assert.ok(calls.every(call => call.options.admin === true));
  assert.equal(calls[1].options.body.apiKey, 'entered-only-key');
  assert.equal(calls[2].options.body.expectedRevision, 3);
  assert.equal(calls[4].options.body.providerId, 'provider-id');
  assert.doesNotMatch(JSON.stringify(calls), /csrfToken|accountId/);
});

test('a retired settings host cannot start a request or accept a late saved result', async () => {
  let current = false, requests = 0, resolve;
  const host = { assertCurrent() { if (!current) throw new DOMException('retired', 'AbortError'); },
    request() { requests++; return new Promise(done => { resolve = done; }); } };
  await assert.rejects(getAiProviders(host), { name: 'AbortError' });
  assert.equal(requests, 0);
  current = true;
  const pending = updateAiProvider('one', { name: 'saved' }, 1, host);
  current = false; resolve({ name: 'late' });
  await assert.rejects(pending, { name: 'AbortError' });
});
