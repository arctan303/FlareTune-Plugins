import React from 'react';
export function useHostPlayer(host) {
  const [snapshot, setSnapshot] = React.useState(() => host.player.getSnapshot());
  React.useEffect(() => {
    let active = true;
    const update = () => { if (active && host.isCurrent()) setSnapshot(host.player.getSnapshot()); };
    update();
    const unsubscribe = host.player.subscribe(update);
    return () => { active = false; unsubscribe(); };
  }, [host]);
  return snapshot;
}
