import React from 'react';
import { t } from "@flaretune/plugin-sdk";

export function unwrapManagedLyricsAsset(response) {
  const data = response?.data || null;
  if (!data) return { song: null, asset: null, lyrics: null, etag: null, aiCompletionEnabled: false };
  const directAsset = data.schemaVersion || ['ready', 'not_found'].includes(data.status) ? data : null;
  return { song: data.song || null, asset: data.asset || data.artifact || directAsset, lyrics: data.lyrics || null,
    etag: data.etag || data.assetEtag || null, aiCompletionEnabled: data.aiCompletionEnabled === true };
}
const empty = () => ({ song: null, asset: null, lyrics: null, etag: null, aiCompletionEnabled: false,
  loading: false, saving: false, error: '' });
const errorMessage = (error, fallback) => error?.status === 409 && error?.code === 'LYRIC_ASSET_CONFLICT'
  ? '歌词文件已在别处更新，已回读最新内容，请重试。' : error?.message || fallback;

export function useManagedLyricsAsset({ host, api, songId, enabled }) {
  const [state, setState] = React.useState(empty);
  const [isAiCompleting, setIsAiCompleting] = React.useState(false);
  const ownerRef = React.useRef(null);
  if (!ownerRef.current || ownerRef.current.host !== host || ownerRef.current.songId !== songId || ownerRef.current.enabled !== enabled) {
    if (ownerRef.current) ownerRef.current.active = false;
    ownerRef.current = { host, songId, enabled, active: true, read: 0, saving: false };
  }
  const owner = ownerRef.current;
  const current = React.useCallback(() => owner.active && enabled && Boolean(songId) && host.isCurrent(), [owner, enabled, songId, host]);
  const timerRef = React.useRef(null);
  const deadlineRef = React.useRef(0);
  const pollingRef = React.useRef(null);
  const notify = React.useCallback(message => { if (current()) host.notify(t(message)); }, [current, host]);
  const refreshPlayback = React.useCallback(language => {
    if (current()) host.lyrics.changed(songId, language ? { language } : {});
  }, [current, host, songId]);
  const stopPolling = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null; deadlineRef.current = 0; pollingRef.current = null;
    if (current()) setIsAiCompleting(false);
  }, [current]);
  const load = React.useCallback(async ({ quiet = false } = {}) => {
    if (!current()) return null;
    const read = ++owner.read;
    setState(value => ({ ...value, error: '', loading: quiet ? value.loading : true }));
    try {
      const next = unwrapManagedLyricsAsset(await api.getLyrics(songId));
      if (!current() || read !== owner.read) return null;
      setState(value => ({ ...value, ...next, loading: false }));
      const playing = host.player.getSnapshot().currentSong;
      if (next.song?.language && String(playing?.id) === String(songId) && playing.language !== next.song.language) {
        refreshPlayback(next.song.language);
      }
      return next;
    } catch (error) {
      if (!current() || read !== owner.read) return null;
      setState(value => ({ ...value, ...empty(), error: errorMessage(error, '读取当前歌词文件失败') }));
      return null;
    }
  }, [api, current, owner, host, refreshPlayback, songId]);
  const startPolling = React.useCallback(() => {
    if (!current() || host.features?.isAvailable?.('ai') === false || pollingRef.current === owner) return;
    pollingRef.current = owner; deadlineRef.current = Date.now() + 120000;
    setIsAiCompleting(true);
    const schedule = () => {
      if (!current() || pollingRef.current !== owner) return;
      if (host.features?.isAvailable?.('ai') === false) { stopPolling(); return; }
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        if (!current() || pollingRef.current !== owner) return;
        if (host.features?.isAvailable?.('ai') === false) { stopPolling(); return; }
        if (Date.now() > deadlineRef.current) {
          setState(value => ({ ...value, error: 'AI 补全仍未完成，请稍后刷新或重试。' })); stopPolling(); return;
        }
        const next = await load({ quiet: true });
        if (!current() || pollingRef.current !== owner) return;
        if (!next) { schedule(); return; }
        if (!next.aiCompletionEnabled) { stopPolling(); return; }
        const pending = next.asset?.aiCompletion?.status === 'pending' || next.lyrics?.translationState === 'pending';
        const failed = next.asset?.aiCompletion?.status === 'failed' || next.lyrics?.translationState === 'failed';
        if (failed) { setState(value => ({ ...value, error: 'AI 补全失败，可以重试。' })); stopPolling(); return; }
        if (!pending) {
          stopPolling(); refreshPlayback(next.song?.language);
          notify(next.asset?.translation || next.lyrics?.translationState === 'ready' ? 'AI 补全已完成' : 'AI 歌曲语言识别已完成');
          return;
        }
        schedule();
      }, 1800);
    };
    schedule();
  }, [current, host, load, notify, owner, refreshPlayback, stopPolling]);
  React.useEffect(() => {
    owner.active = true; setState(empty()); setIsAiCompleting(false);
    if (enabled && songId) void load();
    const retire = () => { owner.active = false; owner.read++; owner.saving = false; stopPolling(); };
    host.signal?.addEventListener('abort', retire, { once: true });
    return () => { retire(); host.signal?.removeEventListener('abort', retire); };
  }, [enabled, host, load, owner, songId, stopPolling]);
  React.useEffect(() => {
    if (current() && state.aiCompletionEnabled && (state.asset?.aiCompletion?.status === 'pending' || state.lyrics?.translationState === 'pending')) startPolling();
  }, [current, startPolling, state.aiCompletionEnabled, state.asset?.aiCompletion?.status, state.lyrics?.translationState]);

  const runMutation = React.useCallback(async (action, successMessage, { refreshPlayer = true, conflictResult = false } = {}) => {
    if (!current() || owner.saving) return false;
    owner.saving = true; setState(value => ({ ...value, saving: true, error: '' }));
    try {
      const response = await action();
      if (!current()) return false;
      if (refreshPlayer) refreshPlayback(response?.data?.song?.language);
      await load({ quiet: true });
      if (!current()) return false;
      if (response?.data?.languageUpdateFailed) notify('歌词已保存，但歌曲语言更新失败；可稍后重新运行 AI 补全');
      else if (successMessage) notify(successMessage);
      return true;
    } catch (error) {
      if (!current()) return false;
      const message = errorMessage(error, '更新歌词文件失败');
      if (error?.status === 409 && error?.code === 'LYRIC_ASSET_CONFLICT') await load({ quiet: true });
      if (!current()) return false;
      setState(value => ({ ...value, error: message })); notify(message);
      return error?.status === 409 && error?.code === 'LYRIC_ASSET_CONFLICT' ? conflictResult : false;
    } finally {
      owner.saving = false;
      if (current()) setState(value => ({ ...value, saving: false }));
    }
  }, [current, load, notify, owner, refreshPlayback]);
  return { ...state, isAiCompleting, load,
    updateOffset: offsetMs => runMutation(() => api.updateLyricsOffset(songId, { offsetMs, etag: state.etag }), t('歌词偏移已设为 {p0}ms', { p0: offsetMs })),
    shiftTimeline: deltaMs => runMutation(() => api.shiftLyricsTimeline(songId, { deltaMs, etag: state.etag }), '已将位移写入当前歌词时间轴'),
    saveDocument: (lines, baselineEtag = state.etag, aiReceipt = null, translationLanguage = null) => runMutation(
      () => api.saveLyricsDocument(songId, { lines, etag: baselineEtag, aiReceipt, translationLanguage }), '共享歌词已更新', { conflictResult: 'conflict' }),
    importLrc: lrc => runMutation(() => api.importLyricsLrc(songId, { lrc, etag: state.etag }), 'LRC 已导入为当前歌词'),
    restoreBackup: asset => runMutation(() => api.restoreLyricsBackup(songId, { asset, etag: state.etag }), '歌词备份已恢复'),
    completeTranslation: async () => {
      const saved = await runMutation(() => api.completeLyricsTranslation(songId), 'AI 处理已提交', { refreshPlayer: false });
      if (saved && current()) startPolling();
      return saved;
    },
    clearTranslation: () => runMutation(() => api.clearLyricsTranslation(songId, state.etag), '译文已清除'),
    reset: () => runMutation(() => api.resetLyrics(songId, state.etag), '歌词文件已重置'),
  };
}
