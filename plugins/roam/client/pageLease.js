import { createInactiveRandomRoam } from './algorithms.js';

const bindings = new Map(), registryListeners = new Map();
const inactiveSnapshot = Object.freeze({ ...createInactiveRandomRoam(), available: false });
const reject = () => false, noop = () => {};
const actionMethods = Object.freeze({ setRandomRoamLanguage: 'setLanguage', setRandomRoamBatchSize: 'setBatchSize',
  setRandomRoamEnabled: 'setEnabled', startRandomRoam: 'startWithSongs', triggerManualRandomRoam: 'requestManual',
  retryRandomRoam: 'retry', resetRandomRoamHistory: 'resetHistory' });
export const inactiveRoamPageLease = Object.freeze({ scope: null, isCurrent: reject, getSnapshot: () => inactiveSnapshot,
  subscribe: () => noop, actions: Object.freeze(Object.fromEntries(Object.keys(actionMethods).map(name => [name, reject]))), retire: noop });

// Runtime and independent content pages receive distinct public host facades.
// Match their currently valid public subject, never mutable global controller
// state. Each mounted page still captures one concrete runtime lease below.
function scopeFor(host) {
  if (!host?.isCurrent?.() || host.signal?.aborted) return null;
  const session = host.session?.get?.(), account = session?.user?.accountId;
  if (session?.authenticated === false || typeof account !== 'string' || !account) return null;
  return JSON.stringify([host.pluginId || 'roam', host.version || '', account, session.user.role || '']);
}
const notifyRegistry = scope => { for (const listener of [...(registryListeners.get(scope) || [])]) listener(); };
export function getRoamPageLease(host) {
  const scope = scopeFor(host), lease = scope && bindings.get(scope);
  return lease?.isCurrent() ? lease : inactiveRoamPageLease;
}
export function subscribeRoamPageLeases(host, listener) {
  const scope = scopeFor(host);
  if (!scope) return noop;
  if (!registryListeners.has(scope)) registryListeners.set(scope, new Set());
  const listeners = registryListeners.get(scope); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) registryListeners.delete(scope); };
}
export function bindRoamPageLease(host, controller) {
  const scope = scopeFor(host);
  if (!scope) throw new Error('Roam runtime host is inactive');
  let active = true, lease;
  const listeners = new Set();
  const current = () => active && bindings.get(scope) === lease && controller.isCurrent();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  const stop = controller.subscribe(publish);
  const actions = Object.freeze(Object.fromEntries(Object.entries(actionMethods).map(([name, method]) =>
    [name, (...args) => current() ? controller[method](...args) : false])));
  lease = Object.freeze({ scope, isCurrent: current, actions,
    getSnapshot: () => current() ? controller.getState() : inactiveSnapshot,
    subscribe(listener) { if (!active) return noop; listeners.add(listener); return () => listeners.delete(listener); },
    retire() {
      if (!active) return; active = false; stop();
      const owned = bindings.get(scope) === lease;
      if (owned) bindings.delete(scope);
      publish(); listeners.clear();
      if (owned) notifyRegistry(scope);
    },
  });
  const previous = bindings.get(scope);
  bindings.set(scope, lease); previous?.retire(); notifyRegistry(scope);
  return lease;
}
export function createRoamPageViewLease(host, runtime) {
  const current = () => scopeFor(host) === runtime.scope && runtime.isCurrent();
  return Object.freeze({
    actions: Object.freeze(Object.fromEntries(Object.entries(runtime.actions).map(([name, action]) =>
      [name, (...args) => current() ? action(...args) : false]))),
    getSnapshot: () => current() ? runtime.getSnapshot() : inactiveSnapshot,
    subscribe(listener) {
      const stop = runtime.subscribe(listener);
      const stopSession = host.session?.subscribe?.(listener) || noop;
      host.signal?.addEventListener('abort', listener);
      return () => { stop(); stopSession(); host.signal?.removeEventListener('abort', listener); };
    },
  });
}
