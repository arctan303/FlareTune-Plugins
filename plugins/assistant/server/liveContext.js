const clean = (value, limit = 160) => typeof value === 'string'
  ? Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, limit).join('')
  : '';

function timeZoneOf(value) {
  const name = clean(value, 80) || 'Asia/Singapore';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch { return 'Asia/Singapore'; }
}

export function liveAssistantContext(raw, now = Date.now()) {
  const context = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const timeZone = timeZoneOf(context.timeZone);
  const iso = new Date(now).toISOString();
  const localTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(now);
  const playback = context.playback && typeof context.playback === 'object'
    && !Array.isArray(context.playback) ? context.playback : null;
  let playbackText = '播放器现场未提供；不能从历史消息推断当前歌曲';
  let currentSong = null;
  let playbackState = null;
  if (playback) {
    const songId = clean(playback.songId, 120);
    const title = clean(playback.title, 200);
    const artist = clean(playback.artist, 200);
    const album = clean(playback.album, 200);
    currentSong = songId || title ? { id: songId || null, title, artist, album,
      duration: Number.isFinite(playback.duration) ? playback.duration : null } : null;
    playbackState = {
      isPlaying: playback.isPlaying === true,
      isBuffering: playback.isBuffering === true,
      progress: Number.isFinite(playback.currentTime) ? playback.currentTime : null,
      duration: Number.isFinite(playback.duration) ? playback.duration : null,
      playMode: clean(playback.playMode, 30),
      queueLength: Number.isInteger(playback.queueLength) ? playback.queueLength : null,
      currentIndex: Number.isInteger(playback.currentIndex) ? playback.currentIndex : null,
      upcomingSongs: Array.isArray(playback.upcomingSongs)
        ? playback.upcomingSongs.slice(0, 15).map((song) => ({ id: clean(song?.id, 120),
          title: clean(song?.title, 200), artist: clean(song?.artist, 200) })) : [],
    };
    playbackText = currentSong
      ? `《${title || songId}》${artist ? ` - ${artist}` : ''}（${playbackState.isPlaying ? '播放中' : '已暂停'}；歌曲 ID：${songId || '未知'}）`
      : '当前未选择歌曲';
  }
  const recentPlayback = Array.isArray(context.recentPlayback)
    ? context.recentPlayback.slice(-3).map((item) => {
      const title = clean(item?.title, 200);
      const artist = clean(item?.artist, 200);
      return title ? `《${title}》${artist ? ` - ${artist}` : ''}（此前播放）` : '';
    }).filter(Boolean).join('、') : '';
  const playerActionReceipts = Array.isArray(context.playerActionReceipts)
    ? context.playerActionReceipts.slice(-10).flatMap((item) => {
      const id = clean(item?.id, 120);
      if (!id || typeof item?.ok !== 'boolean') return [];
      return [{ id, ok: item.ok, outcome: clean(item?.outcome, 200) }];
    }) : [];
  return {
    time: `${localTime}（${timeZone}；UTC ${iso}）`, timeZone,
    playback: playbackText, currentSong, playbackState, recentPlayback,
    playerActionReceipts,
  };
}
