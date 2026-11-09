import QueueFooter from './QueueFooter.jsx';
import { t } from '@flaretune/plugin-sdk';
import { formatRoamLanguageScope } from './languages.js';
import { createRoamController } from "./controller.js";
import { bindRoamController, getRoamState, subscribeRoam, roamActions } from "./state.js";

export function startRoamRuntime(host) {
  const controller = createRoamController(host);
  const disconnect = bindRoamController(controller);
  const retireContribution = host.contributions.register('queue-controls', { getSnapshot: () => ({ ...getRoamState(), renderers: { footer: QueueFooter } }), subscribe: subscribeRoam, actions: { ...roamActions,
    toggleFromCatalog({ songs }) {
      const state = getRoamState(), queue = host.queue.getSnapshot();
      if (state.enabled) { if (roamActions.setRandomRoamEnabled(false)) host.notify(t('已关闭随机漫游')); return; }
      const accepted = queue.currentSong && queue.queue.length
        ? roamActions.setRandomRoamEnabled(true, { language: state.language })
        : roamActions.startRandomRoam(songs, { language: state.language });
      if (accepted) host.notify(t('已开启【{p0}】随机漫游，将在队尾自动补充歌曲', { p0: formatRoamLanguageScope(state.language || 'all') }));
    },
    toggleFromQueue() {
      const state = getRoamState(), enabled = !state.enabled;
      if (!roamActions.setRandomRoamEnabled(enabled)) return;
      host.notify(t(enabled ? host.queue.getSnapshot().queue.length === 0 ? '已开启随机漫游，正在载入歌曲…' : '已开启队尾随机续播' : '已关闭队尾随机续播'));
    },
    appendFromQueue() {
      if (getRoamState().status === 'loading' || !roamActions.triggerManualRandomRoam()) return;
      host.notify(t('正在补充 {p0} 首漫游歌曲…', { p0: getRoamState().batchSize || 10 }));
    },
  } });
  controller.start();
  return () => { retireContribution(); disconnect(); controller.dispose(); };
}
