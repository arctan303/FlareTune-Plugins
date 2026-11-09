import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantFetch, clearConversation, registerConversationClear, loadThinkingPreference, saveThinkingPreference } from './client.js';

function fixture() {
  let current = true;
  const calls = [], notices = [];
  const host = { isCurrent: () => current, assertCurrent() { if (!current) throw new DOMException('Retired', 'AbortError'); },
    session: { get: () => current ? { authenticated: true, user: { accountId: 'one' } } : null },
    notify: value => notices.push(value), requestResponse: async (...args) => { calls.push(args); return 'response'; },
    request: async (...args) => { calls.push(args); return { thread: { revision: 4, messages: [] } }; } };
  return { host, calls, notices, retire: () => { current = false; } };
}
function confirm(t, value) {
  const previous = globalThis.confirm;
  globalThis.confirm = () => value;
  t.after(() => { if (previous === undefined) delete globalThis.confirm; else globalThis.confirm = previous; });
}

test('assistant transport maps only its legacy endpoints to scoped response requests and parses JSON bodies', async () => {
  const f = fixture(); const controller = new AbortController();
  assert.equal(await assistantFetch(f.host, '/api/ai/chat', { method: 'POST', body: '{"message":"hello"}', signal: controller.signal }), 'response');
  assert.deepEqual(f.calls[0][0], 'chat'); assert.deepEqual(f.calls[0][1].body, { message: 'hello' });
  assert.equal(f.calls[0][1].signal, controller.signal);
  assert.throws(() => assistantFetch(f.host, '/api/admin/settings'), TypeError);
});

test('clear uses an active conversation controller and releases it on unmount', async t => {
  const f = fixture(); let clears = 0;
  const release = registerConversationClear(f.host, async () => { clears++; return true; });
  assert.equal(await clearConversation(f.host), true); assert.equal(clears, 1); assert.deepEqual(f.calls, []);
  release(); confirm(t, false);
  assert.equal(await clearConversation(f.host), false); assert.equal(clears, 1);
});

test('clear without a mounted view confirms, stops a pending turn, refreshes revision and deletes once', async t => {
  const f = fixture(); confirm(t, true);
  let read = 0;
  f.host.request = async (path, options) => {
    f.calls.push([path, options]);
    return { thread: read++ === 0 ? { revision: 3, pendingTurn: { clientMessageId: 'pending' } } : { revision: 4 } };
  };
  assert.equal(await clearConversation(f.host), true);
  assert.deepEqual(f.calls.map(([path, options]) => [path, options?.method || 'GET']), [['thread', 'GET'], ['stop', 'POST'], ['thread', 'GET'], ['thread', 'DELETE']]);
  assert.equal(f.calls.at(-1)[1].body.revision, 4); assert.equal(f.notices.length, 1);
});

test('retirement after clear response prevents follow-up writes and success notification', async t => {
  const f = fixture(); confirm(t, true);
  f.host.request = async (...args) => { f.calls.push(args); f.retire(); return { thread: { revision: 4 } }; };
  await assert.rejects(clearConversation(f.host), { name: 'AbortError' });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.notices, []);
});

test('thinking preferences are account-scoped and retired contexts cannot change them', () => {
  const f = fixture(), saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  assert.equal(loadThinkingPreference(f.host, storage), true);
  saveThinkingPreference(f.host, false, storage); assert.equal(loadThinkingPreference(f.host, storage), false);
  assert.deepEqual([...saved.keys()], ['flaretune.plugin.assistant.one.thinking']);
  f.retire(); assert.throws(() => saveThinkingPreference(f.host, true, storage), { name: 'AbortError' });
});

test('missing account thinking preference migrates the host boolean without replacing an explicit new value', () => {
  const f = fixture(), saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  f.host.preferences = { getLegacyBoolean: key => key === 'thinking' ? false : undefined };
  assert.equal(loadThinkingPreference(f.host, storage), false);
  saveThinkingPreference(f.host, true, storage);
  assert.equal(loadThinkingPreference(f.host, storage), true);
  assert.deepEqual([...saved.keys()], ['flaretune.plugin.assistant.one.thinking']);
});
