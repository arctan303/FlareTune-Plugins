import React, { useMemo, useRef, useSyncExternalStore } from 'react';
import RoamOverview from './RoamOverview.jsx';
import { getRoamPageLease, subscribeRoamPageLeases, createRoamPageViewLease, inactiveRoamPageLease } from './pageLease.js';

export default function RoamPluginPage({ host, lease: suppliedLease }) {
  const registry = useMemo(() => ({ subscribe: listener => subscribeRoamPageLeases(host, listener),
    getSnapshot: () => getRoamPageLease(host) }), [host]);
  const available = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const captured = useRef({ host, lease: null });
  if (captured.current.host !== host) captured.current = { host, lease: null };
  if (!captured.current.lease && available !== inactiveRoamPageLease) captured.current.lease = available;
  const runtime = suppliedLease || captured.current.lease || inactiveRoamPageLease;
  const view = useMemo(() => createRoamPageViewLease(host, runtime), [host, runtime]);
  const randomRoam = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot);
  const actions = view.actions;
  return <RoamOverview randomRoam={randomRoam}
    onToggleRoam={() => actions.setRandomRoamEnabled(!randomRoam.enabled)}
    setRandomRoamLanguage={actions.setRandomRoamLanguage} setRandomRoamBatchSize={actions.setRandomRoamBatchSize}
    onRetry={actions.retryRandomRoam}
    showToast={message => { if (host.isCurrent() && runtime.isCurrent()) host.notify?.(message); }} />;
}
