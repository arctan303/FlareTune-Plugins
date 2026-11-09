import { normalizeSong } from "@flaretune/plugin-sdk/server/song-dto";
import { createToolResult } from "./toolResult.js";
import { queryRomanizedSongs } from "@flaretune/plugin-sdk/server/romanized-search";

const failure = (markdown, summary, code) => createToolResult({
  modelText: markdown,
  summary,
  eventData: { type: 'client_action', ok: false, error: { code } },
});

export const musicControlTool = {
  name: 'music_control',
  displayName: '音乐播放控制',
  description: '控制当前页面的音乐播放器。明确要求播放指定歌曲或随心点播时使用 play_song（可传 song_name 或 song_id；未指定或未找到时会自动挑选曲库精选歌曲播放）；继续、暂停或切换播放状态时使用 play、pause、toggle。工具只生成播放器指令，浏览器执行结果未知。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['play_song', 'play', 'pause', 'toggle'],
        description: '动作类型：play_song（立即播放指定歌曲）、play（继续当前播放）、pause（暂停播放）、toggle（切换播放/暂停）。',
      },
      song_name: {
        type: 'string',
        description: '要播放的歌名、歌手或关键词；日语假名可用罗马字输入。action=play_song 且不知道 song_id 时使用。',
      },
      song_id: {
        type: 'string',
        description: '已确认的乐境歌曲 ID；已知时优先使用。',
      },
    },
    required: ['action'],
  },
  async execute(args, { db } = {}) {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!['play_song', 'play', 'pause', 'toggle'].includes(action)) {
      return failure('不支持的播放器动作。', '播放器参数无效', 'invalid_arguments');
    }
    if (action !== 'play_song') {
      const summaryText = action === 'pause' ? '暂停播放' : (action === 'play' ? '继续播放' : '切换播放状态');
      return createToolResult({
        modelText: `播放器指令已生成，浏览器执行结果未知。目标：${summaryText}。`,
        summary: `播放器指令已生成：${summaryText}`,
        eventData: { type: 'client_action', ok: true, action, instruction_status: 'generated', browser_execution: 'unknown' },
        playerAction: { type: 'control', action },
      });
    }

    const songId = String(args?.song_id || '').trim().slice(0, 120);
    const songName = String(args?.song_name || '').trim().replace(/^《|》$/g, '').slice(0, 200);
    if (!db || typeof db.prepare !== 'function') return failure('乐境曲库数据库当前不可用，请稍后再试。', '乐境曲库不可用', 'database_unavailable');

    try {
      let song = null;
      if (songId) {
        song = await db.prepare(`
          SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
          FROM Songs s WHERE s.id = ? AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
        `).bind(songId).first();
      }
      if (!song && songName) {
        const pattern = `%${songName.replace(/[\\%_]/g, '\\$&').toLowerCase()}%`;
        song = await db.prepare(`
          SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
          FROM Songs s
          WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
            AND (LOWER(s.title) LIKE ? ESCAPE '\\' OR LOWER(s.artist) LIKE ? ESCAPE '\\' OR LOWER(s.album) LIKE ? ESCAPE '\\')
          ORDER BY CASE WHEN LOWER(s.title) = LOWER(?) THEN 0 ELSE 1 END
          LIMIT 1
        `).bind(pattern, pattern, pattern, songName).first();
        if (!song) [song] = await queryRomanizedSongs(db, songName, 1);
      }
      // 仅当既未传 song_id 也未传 song_name 时（用户泛指随心听），才随机抽取一首；若明确指定了但未找到，据实说明
      if (!song && !songId && !songName) {
        song = await db.prepare(`
          SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
          FROM Songs s
          WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
          ORDER BY RANDOM()
          LIMIT 1
        `).first();
      }
      if (!song) return failure(`曲库中没有找到${songName ? `「${songName}」` : '可播放'}的歌曲。`, '未找到可播放歌曲', 'song_not_found');
      const normalized = normalizeSong(song);
      return createToolResult({
        modelText: `播放器指令已生成，浏览器执行结果未知。目标：播放《${normalized.title}》- ${normalized.artist}。`,
        summary: `播放器指令已生成：播放《${normalized.title}》`,
        eventData: { type: 'client_action', ok: true, action: 'play_song', song: normalized, instruction_status: 'generated', browser_execution: 'unknown' },
        playerAction: { type: 'play_now', action: 'play_song', song: normalized },
      });
    } catch (error) {
      console.error('music_control failed:', error);
      return failure('乐境曲库查询失败，请稍后再试。', '播放歌曲查询失败', 'database_query_failed');
    }
  },
};
