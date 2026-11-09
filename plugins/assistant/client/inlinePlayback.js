import { t } from '@flaretune/plugin-sdk/client/i18n';

export async function playAssistantInlineSong(songId, { host, fetchSong = id => host.catalog.resolveSong(id),
  playSong = song => host.player.execute({ type: 'play_now', action: 'play_song', song }),
  notify = message => host.notify(message) } = {}) {
  const id = typeof songId === 'string' ? songId.trim() : '';
  if (!id || id.length > 256 || !host?.isCurrent()) return { ok: false, reason: 'invalid_song_id' };
  const current = host.player.getSnapshot();
  if (String(current.currentSong?.id || '') === id) {
    if (!current.isPlaying) await host.player.execute({ type: 'control', action: 'play' });
    return { ok: true, outcome: current.isPlaying ? 'already_playing' : 'resumed' };
  }
  try {
    const song = await fetchSong(id); host.assertCurrent();
    if (!song) { notify(t('歌曲不存在或无法播放')); return { ok: false, reason: 'song_not_found' }; }
    const result = await playSong(song); host.assertCurrent();
    if (!result?.ok) { notify(t('播放未成功，请再试一次')); return { ok: false, reason: 'playback_failed' }; }
    notify(t('正在播放《{title}》', { title: song.title || t('歌曲') }));
    return { ok: true, outcome: 'started' };
  } catch (error) {
    if (error?.name !== 'AbortError' && host.isCurrent()) notify(t('无法取得该曲目的播放信息'));
    return { ok: false, reason: 'song_unavailable' };
  }
}

export function activateInlineAssistantSong(event, { host, keyboard = false,
  playSong = id => playAssistantInlineSong(id, { host }) } = {}) {
  if (keyboard && event?.key !== 'Enter' && event?.key !== ' ') return false;
  const target = event?.target?.closest?.('.xiaoa-inline-song');
  const songId = target?.getAttribute?.('data-song-id');
  if (!songId) return false;
  event.preventDefault(); event.stopPropagation(); void playSong(songId); return true;
}
