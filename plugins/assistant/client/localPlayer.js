import { dispatchAiPlayerAction } from './actionDispatch.js';
import { applyRoamControl } from './playerActions.js';

export function dispatchLocalAssistantPlayerAction(action, { host } = {}) {
  host.assertCurrent();
  const execute = value => host.player.execute(value);
  return dispatchAiPlayerAction(action, {
    hydrateSong: song => host.catalog.hydrateSong(song),
    playNow: song => execute({ type: 'play_now', action: 'play_song', song }),
    insertNext: song => execute({ type: 'insert_next', action: 'insert_next', song }),
    replaceQueue: songs => execute({ type: 'replace_queue', action: 'replace', songs }),
    appendQueue: songs => execute({ type: 'append', action: 'append', songs }),
    controlPlayer: execute,
    setRoam: args => { host.assertCurrent(); return host.features.isAvailable('roam-control') ? applyRoamControl(args) : { ok: false, outcome: 'failed', error: 'roam_unavailable' }; },
    notify: message => host.notify(message),
  });
}
