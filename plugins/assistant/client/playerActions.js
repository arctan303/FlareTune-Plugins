export { applyPlayerQueueEdit, applyCurrentSongMetadataAndToggle, applyPlaySongNow, applyReplacePlayerQueue, applyPlayerControl } from '@flaretune/plugin-sdk/client/player-actions';
import { getRoamState, roamActions } from '@flaretune/plugin-service/roam/client/state.js';
/**
 * Assistant commands use the active plugin controller, never the player store.
 */
export function applyRoamControl({ action, language } = {}, { getState = getRoamState, actions = roamActions } = {}) {
  let state;
  try { state = getState?.(); } catch { return { ok: false, outcome: 'failed', error: 'roam_unavailable' }; }
  if (state?.available !== true || typeof actions?.setRandomRoamEnabled !== 'function') {
    return { ok: false, outcome: 'failed', error: 'roam_unavailable' };
  }

  const wasEnabled = state.enabled === true;
  if (action === 'disable') {
    if (!actions.setRandomRoamEnabled(false)) return { ok: false, outcome: 'failed', error: 'roam_unavailable' };
    return { ok: true, outcome: wasEnabled ? 'applied' : 'noop', enabled: false };
  }
  if (action !== 'enable') return { ok: false, outcome: 'ignored' };

  const requested = typeof language === 'string' ? language.trim() : '';
  const nextLanguage = requested || state.language || 'all';
  const isSameScope = wasEnabled && (state.language || 'all') === nextLanguage;
  if (!actions.setRandomRoamEnabled(true, { language: nextLanguage })) return { ok: false, outcome: 'failed', error: 'roam_unavailable' };
  return {
    ok: true,
    outcome: isSameScope ? 'noop' : 'applied',
    enabled: true,
    language: nextLanguage,
  };
}

/**
 * 播放今日推荐全部已退役：原 `daily_recommend` 工具（Phase 78 引入）已由 Phase 79 移除，
 * 今日精选的刷新与播放全部仍由详情页自身入口提供。
 */
