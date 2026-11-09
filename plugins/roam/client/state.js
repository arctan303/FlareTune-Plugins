import { useSyncExternalStore } from 'react';
import { createInactiveRandomRoam } from "./algorithms.js";

const inactive = () => Object.freeze({ ...createInactiveRandomRoam(), available: false });
let snapshot = inactive();
let controller = null;
const listeners = new Set();
const publish = value => { snapshot = Object.freeze({ ...value }); for (const listener of [...listeners]) listener(); };
export const getRoamState = () => snapshot;
export const subscribeRoam = listener => { listeners.add(listener); return () => listeners.delete(listener); };
export function useRoamState(selector = value => value) {
  return selector(useSyncExternalStore(subscribeRoam, getRoamState, getRoamState));
}

export function bindRoamController(next) {
  controller = next; publish(next.getState());
  const unsubscribe = next.subscribe(() => { if (controller === next) publish(next.getState()); });
  return () => {
    unsubscribe();
    if (controller === next) { controller = null; publish(inactive()); }
  };
}
const invoke = (method, args) => controller?.isCurrent() ? controller[method](...args) : false;
export const roamActions = Object.freeze({
  setRandomRoamLanguage: (...args) => invoke('setLanguage', args),
  setRandomRoamBatchSize: (...args) => invoke('setBatchSize', args),
  setRandomRoamEnabled: (...args) => invoke('setEnabled', args),
  startRandomRoam: (...args) => invoke('startWithSongs', args),
  triggerManualRandomRoam: (...args) => invoke('requestManual', args),
  retryRandomRoam: (...args) => invoke('retry', args),
  resetRandomRoamHistory: (...args) => invoke('resetHistory', args),
});
