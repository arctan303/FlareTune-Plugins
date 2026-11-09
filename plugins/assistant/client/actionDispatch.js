import { t } from '@flaretune/plugin-sdk/client/i18n';
const hydrateActionSong = (rawSong, hydrateSong) => (
  rawSong ? hydrateSong(rawSong) : null
);

// 漫游语种标签与 MainContent 的 ROAM_LANGUAGE_OPTIONS 保持一致（仅用于提示文案）。
const ROAM_LANGUAGE_LABELS = {
  all: '全库',
  zh: '华语',
  ja: '日文',
  en: '欧美',
  yue: '粤语',
  ko: '韩语',
  instrumental: '纯音乐',
  other: '其他',
};

export async function dispatchAiPlayerAction(playerAction, {
  hydrateSong,
  playNow,
  insertNext,
  replaceQueue,
  appendQueue,
  controlPlayer,
  setRoam,
  notify,
}) {
  const action = playerAction?.action;
  const song = hydrateActionSong(playerAction?.song, hydrateSong);
  const songs = Array.isArray(playerAction?.songs)
    ? playerAction.songs.map((item) => hydrateActionSong(item, hydrateSong)).filter(Boolean)
    : [];

  if (playerAction?.type === 'play_now' && action === 'play_song' && song) {
    const applied = await playNow(song);
    if (applied?.ok) notify(t('正在播放《{title}》', { title: song.title || t('目标歌曲') }));
    return applied;
  }

  if (playerAction?.type === 'insert_next' && action === 'insert_next' && (song || songs[0])) {
    const targetSong = song || songs[0];
    const applied = await insertNext(targetSong);
    if (applied?.ok) notify(t('已将《{title}》插播为下一首', { title: targetSong.title || t('目标歌曲') }));
    return applied?.ok ? applied : { ok: false, outcome: applied?.outcome || applied?.error || 'failed' };
  }

  if (playerAction?.type === 'replace_queue' && action === 'replace' && songs.length > 0) {
    const applied = await replaceQueue(songs);
    if (applied?.ok) notify(t('已换上包含 {count} 首歌曲的播放队列', { count: songs.length }));
    return applied;
  }

  if (playerAction?.type === 'append' && action === 'append' && songs.length > 0) {
    const applied = await appendQueue(songs);
    if (applied?.ok) notify(t('已向播放队列追加 {count} 首歌曲', { count: songs.length }));
    return applied;
  }

  const isControl = playerAction?.type === 'control' && ['play', 'pause', 'toggle'].includes(action);
  const isSeek = playerAction?.type === 'seek' && action === 'seek';
  if (isControl || isSeek) {
    const applied = await controlPlayer(playerAction);
    if (applied?.ok) {
      const seekText = playerAction.mode === 'percent'
        ? t('已跳到 {position}%', { position: Math.round(playerAction.position || 0) })
        : t('已跳到 {position} 秒', { position: Math.round(applied.position_seconds ?? playerAction.position ?? 0) });
      const labels = {
        play: '播放器已播放',
        pause: '播放器已暂停',
        toggle: '播放器状态已切换',
        seek: seekText,
      };
      notify(t(labels[action] || seekText));
    }
    return applied;
  }

  if (playerAction?.type === 'roam') {
    const enabled = action === 'enable';
    if (!enabled && action !== 'disable') return { ok: false, outcome: 'ignored' };
    const applied = await setRoam({ action, language: playerAction?.language });
    if (!applied?.ok) return { ok: false, outcome: applied?.outcome || 'failed' };
    if (enabled) {
      const label = ROAM_LANGUAGE_LABELS[applied.language || playerAction?.language] || '';
      notify(label
        ? t('已开启【{language}】随机漫游，将在队尾自动补充歌曲', { language: t(label) })
        : t('已开启随机漫游，将在队尾自动补充歌曲'));
    } else {
      notify(t('已关闭随机漫游'));
    }
    return { ok: true, outcome: applied.outcome || 'applied' };
  }

  return { ok: false, outcome: 'ignored' };
}
