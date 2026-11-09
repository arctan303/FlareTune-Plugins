import { createToolResult } from "./toolResult.js";

export const getCurrentPlaybackTool = {
  name: 'get_current_playback',
  displayName: '获取播放器现场状态',
  description: '获取听众当前的音乐播放器现场。可查询当前正在播放的曲目（歌名、歌手、专辑、时长）、播放与暂停状态、实时进度秒数与百分比、播放模式，以及播放队列概况。默认仅返回当前曲目与精简状态；仅在听众明确询问下一首、接下来放什么或后续曲目时，才将 include_queue 设为 true。',
  parameters: {
    type: 'object',
    properties: {
      include_queue: {
        type: 'boolean',
        description: '是否获取队列中即将播放的后续歌曲列表。默认 false（极简模式，仅返回当前歌曲、播放状态、进度与队列总数统计）；当且仅当听众询问接下来要放什么、歌单后续曲目或下一首时传入 true。',
      },
      queue_limit: {
        type: 'integer',
        minimum: 1,
        maximum: 15,
        description: '获取接下来即将播放的曲目数量，默认 5，最大 15。仅在 include_queue=true 时生效。',
      },
    },
  },
  async execute(args, { currentSong, playbackState = null } = {}) {
    const includeQueue = args?.include_queue === true;
    const queueLimit = Math.min(Math.max(Number.isInteger(Number(args?.queue_limit)) ? Number(args.queue_limit) : 5, 1), 15);

    const hasSong = Boolean(currentSong && (currentSong.title || currentSong.id));
    const normalizedPlayback = playbackState && typeof playbackState === 'object'
      ? {
          is_playing: Boolean(playbackState.isPlaying),
          is_buffering: Boolean(playbackState.isBuffering),
          progress_seconds: Number.isFinite(playbackState.progress) ? Number(playbackState.progress) : null,
          duration_seconds: Number.isFinite(playbackState.duration) ? Number(playbackState.duration) : null,
          play_mode: playbackState.playMode || null,
          queue_length: Number.isInteger(playbackState.queueLength) ? playbackState.queueLength : null,
          current_index: Number.isInteger(playbackState.currentIndex) ? playbackState.currentIndex : null,
        }
      : null;

    let progressPercent = null;
    if (normalizedPlayback?.progress_seconds !== null && normalizedPlayback?.duration_seconds) {
      progressPercent = `${Math.min(100, Math.max(0, Math.round((normalizedPlayback.progress_seconds / normalizedPlayback.duration_seconds) * 100)))}%`;
    }

    const stateLabel = normalizedPlayback
      ? (normalizedPlayback.is_buffering ? '缓冲中' : (normalizedPlayback.is_playing ? '播放中' : '已暂停'))
      : (hasSong ? '状态未知' : '未播放');

    const playbackData = normalizedPlayback
      ? {
          state: stateLabel,
          ...normalizedPlayback,
          ...(progressPercent ? { progress_percent: progressPercent } : {}),
        }
      : null;

    if (playbackData && includeQueue && Array.isArray(playbackState?.upcomingSongs)) {
      playbackData.upcoming_songs = playbackState.upcomingSongs.slice(0, queueLimit).map((s) => ({
        id: s?.id ? String(s.id) : undefined,
        title: String(s?.title || ''),
        artist: String(s?.artist || ''),
      }));
    }

    if (!hasSong) {
      return createToolResult({
        modelText: `听众当前未在播放任何歌曲。${normalizedPlayback ? `播放器状态：${stateLabel}${typeof normalizedPlayback.queue_length === 'number' ? `，播放队列共有 ${normalizedPlayback.queue_length} 首曲目` : ''}。` : '播放器状态未知。'}`,
        summary: '当前无播放曲目',
        eventData: { ok: true },
      });
    }

    const progressPart = normalizedPlayback?.progress_seconds !== null && normalizedPlayback?.duration_seconds
      ? `（${Math.round(normalizedPlayback.progress_seconds)}s / ${Math.round(normalizedPlayback.duration_seconds)}s${progressPercent ? `，${progressPercent}` : ''}）`
      : '';

    const contentLines = [
      `当前播放曲目：《${currentSong.title}》 - ${currentSong.artist}${currentSong.album ? `（专辑：${currentSong.album}）` : ''}`,
      `播放状态：${stateLabel}${progressPart}`,
    ];
    if (normalizedPlayback?.play_mode) contentLines.push(`播放模式：${normalizedPlayback.play_mode}`);
    if (typeof normalizedPlayback?.queue_length === 'number') {
      contentLines.push(`队列位置：第 ${normalizedPlayback.current_index || 1} 首 / 共 ${normalizedPlayback.queue_length} 首`);
    }
    if (Array.isArray(playbackData?.upcoming_songs) && playbackData.upcoming_songs.length > 0) {
      contentLines.push(`即将播放：\n${playbackData.upcoming_songs.map((s, i) => `  ${i + 1}. 《${s.title}》 - ${s.artist}`).join('\n')}`);
    }

    return createToolResult({
      modelText: contentLines.join('\n'),
      summary: `${stateLabel}${progressPart}：《${currentSong.title}》- ${currentSong.artist}`,
      eventData: { ok: true },
    });
  }
};
