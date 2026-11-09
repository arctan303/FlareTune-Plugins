import { t } from "@flaretune/plugin-sdk/pure";

export function assistantFetch(host, url, init = {}) {
  const prefix = '/api/ai/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) throw new TypeError('Invalid assistant endpoint');
  let body = init.body;
  if (typeof body === 'string') body = JSON.parse(body);
  return host.requestResponse(url.slice(prefix.length), { method: init.method || 'GET', body, signal: init.signal });
}

const clearListeners = new Map();
export function registerConversationClear(host, clear) {
  clearListeners.set(host, clear);
  return () => { if (clearListeners.get(host) === clear) clearListeners.delete(host); };
}
export async function clearConversation(host) {
  if (!host.isCurrent()) return false;
  for (const [owner, clear] of clearListeners) if (owner.isCurrent() && owner.session.get()?.user?.accountId === host.session.get()?.user?.accountId) return clear();
  if (!globalThis.confirm?.(t('确定要清空与小A的全部对话记录吗？'))) return false;
  let { thread } = await host.request('thread');
  host.assertCurrent();
  if (thread.pendingTurn?.clientMessageId) {
    await host.request('stop', { method: 'POST', body: { client_message_id: thread.pendingTurn.clientMessageId } });
    host.assertCurrent();
    ({ thread } = await host.request('thread'));
    host.assertCurrent();
  }
  await host.request('thread', { method: 'DELETE', body: { revision: thread.revision } });
  host.assertCurrent();
  host.notify(t('对话历史已清空'));
  return true;
}

export function loadThinkingPreference(host, storage = globalThis.localStorage) {
  const owner = host.session.get()?.user?.accountId;
  try {
    const stored = storage?.getItem(`flaretune.plugin.assistant.${encodeURIComponent(owner)}.thinking`);
    if (stored !== null && stored !== undefined) return stored !== 'false';
  } catch { /* A blocked browser store still permits the read-only migration. */ }
  try {
    const legacy = host.preferences?.getLegacyBoolean('thinking');
    return typeof legacy === 'boolean' ? legacy : true;
  } catch { return true; }
}
export function saveThinkingPreference(host, value, storage = globalThis.localStorage) {
  host.assertCurrent();
  const owner = host.session.get()?.user?.accountId;
  try { storage?.setItem(`flaretune.plugin.assistant.${encodeURIComponent(owner)}.thinking`, String(value === true)); } catch { /* Session-only when storage is unavailable. */ }
}

