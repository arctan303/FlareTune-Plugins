import { createElement } from 'react';
import RoamPluginPage from './RoamPluginPage.jsx';
import QueueFooter from './QueueFooter.jsx';
import { t } from '@flaretune/plugin-sdk';
import { formatRoamLanguageScope } from './languages.js';
import { createRoamController } from './controller.js';
import { bindRoamController } from './state.js';
import { bindRoamPageLease } from './pageLease.js';

export function startRoamRuntime(host) {
  const controller = createRoamController(host);
  const lease = bindRoamPageLease(host, controller);
  const disconnect = bindRoamController(controller);
  const actions = lease.actions;
  const guarded = action => (...args) => lease.isCurrent() ? action(...args) : false;
  const retireContribution = host.contributions.register('queue-controls', {
    getSnapshot: () => ({ ...lease.getSnapshot(), renderers: { footer: QueueFooter } }), subscribe: lease.subscribe,
    actions: { ...actions,
      toggleFromCatalog: guarded(({ songs }) => {
        const state = lease.getSnapshot(), queue = host.queue.getSnapshot();
        if (state.enabled) {
          if (!actions.setRandomRoamEnabled(false)) return false;
          host.notify(t('已关闭随机漫游')); return true;
        }
        const accepted = queue.currentSong && queue.queue.length
          ? actions.setRandomRoamEnabled(true, { language: state.language })
          : actions.startRandomRoam(songs, { language: state.language });
        if (accepted) host.notify(t('已开启【{p0}】随机漫游，将在队尾自动补充歌曲', { p0: formatRoamLanguageScope(state.language || 'all') }));
        return accepted;
      }),
      toggleFromQueue: guarded(() => {
        const enabled = !lease.getSnapshot().enabled;
        if (!actions.setRandomRoamEnabled(enabled)) return false;
        host.notify(t(enabled ? host.queue.getSnapshot().queue.length === 0 ? '已开启随机漫游，正在载入歌曲…' : '已开启队尾随机续播' : '已关闭队尾随机续播'));
        return true;
      }),
      appendFromQueue: guarded(() => {
        if (lease.getSnapshot().status === 'loading' || !actions.triggerManualRandomRoam()) return false;
        host.notify(t('正在补充 {p0} 首漫游歌曲…', { p0: lease.getSnapshot().batchSize || 10 }));
        return true;
      }),
    },
  });
  const BrowseHeader = () => createElement(RoamPluginPage, { host, lease });
  const retireBrowseHeader = host.contributions.register('browse-header', {
    getSnapshot: () => ({ renderers: { header: BrowseHeader } }),
  });
  controller.start();
  let ended = false;
  return () => {
    if (ended) return; ended = true;
    lease.retire(); retireBrowseHeader(); retireContribution(); disconnect(); controller.dispose();
  };
}
