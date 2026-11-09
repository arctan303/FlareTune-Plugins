import React from 'react';
import RoamOverview from "./RoamOverview.jsx";
import { roamActions, useRoamState } from "./state.js";

export default function RoamPluginPage({ host }) {
  const randomRoam = useRoamState();
  return <RoamOverview isAuthenticated items={host.catalog?.categories || []} randomRoam={randomRoam}
    onToggleRoam={() => roamActions.setRandomRoamEnabled(!randomRoam.enabled)}
    setRandomRoamLanguage={roamActions.setRandomRoamLanguage} setRandomRoamBatchSize={roamActions.setRandomRoamBatchSize}
    onRetry={roamActions.retryRandomRoam}
    onOpenLanguage={item => host.catalog?.openLanguage(item.key)} showToast={message => host.notify?.(message)} />;
}
