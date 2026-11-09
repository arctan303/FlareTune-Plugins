import { normalizeSong } from "@flaretune/plugin-sdk/server/song-dto";
import { createToolResult } from "./toolResult.js";

export const playerQueueTool = {
  name: 'player_queue',
  displayName: '管理当前播放队列',
  description: '编辑当前播放队列，不修改账号个人歌单。支持把歌曲放到下一首（insert_next）、追加到队尾（append）或替换整个队列（replace）。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['insert_next', 'append', 'replace'],
        description: '队列动作：insert_next（插播为下一首）、append（追加到队尾）、replace（替换整个播放队列）。',
      },
      song_ids: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 50,
        description: '歌曲 ID 数组（来自 music_query 的 song.id，如 ["4839ac1ad2a4e009"]；也支持传入精确歌名）。',
      },
    },
    required: ['action', 'song_ids'],
  },
  async execute(args, { db } = {}) {
    const action = String(args?.action || '').trim().toLowerCase();
    if (!['insert_next', 'append', 'replace'].includes(action)) {
      return createToolResult({
        summary: '队列动作参数无效',
        modelText: '队列动作参数无效，仅支持 insert_next、append、replace。',
        eventData: { type: 'player_queue', ok: false, error: 'invalid_action' },
      });
    }
    const rawSongIds = Array.isArray(args?.song_ids) ? args.song_ids.map(String).map((s) => s.trim()).filter(Boolean) : [];
    if (rawSongIds.length === 0) {
      return createToolResult({
        summary: '缺少歌曲 ID',
        modelText: '队列操作需要提供有效的歌曲 ID。',
        eventData: { type: 'player_queue', ok: false, error: 'song_ids_required' },
      });
    }

    if (!db || typeof db.prepare !== 'function') {
      return createToolResult({
        summary: '曲库数据库不可用',
        modelText: '曲库数据库暂时不可用。',
        eventData: { type: 'player_queue', ok: false, error: 'database_unavailable' },
      });
    }

    try {
      const resolvedSongs = [];
      const missingIds = [];

      for (const idOrTitle of rawSongIds) {
        let row = await db.prepare(`
          SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
          FROM Songs s
          WHERE s.id = ? AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
        `).bind(idOrTitle).first();

        if (!row) {
          const cleanTitle = idOrTitle.replace(/^《|》$/g, '').trim();
          if (cleanTitle) {
            row = await db.prepare(`
              SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
              FROM Songs s
              WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
                AND (LOWER(s.title) = LOWER(?) OR LOWER(s.title) LIKE ?)
              LIMIT 1
            `).bind(cleanTitle, `%${cleanTitle.toLowerCase()}%`).first();
          }
        }

        if (row) {
          resolvedSongs.push(normalizeSong(row));
        } else {
          missingIds.push(idOrTitle);
        }
      }

      if (resolvedSongs.length === 0) {
        return createToolResult({
          summary: '未找到可播放的曲目',
          modelText: '未在曲库中找到可加入播放队列的曲目。',
          eventData: { type: 'player_queue', ok: false, error: 'no_playable_songs', missing: missingIds },
        });
      }

      const summaries = {
        insert_next: `插播《${resolvedSongs[0].title}》为下一首`,
        append: `向播放队列追加 ${resolvedSongs.length} 首歌曲`,
        replace: `替换为包含 ${resolvedSongs.length} 首歌曲的播放队列`,
      };
      const targetText = summaries[action] || `更新播放队列（${resolvedSongs.length} 首）`;
      const summaryText = `播放器指令已生成：${targetText}`;

      return createToolResult({
        summary: summaryText,
        modelText: `播放器指令已生成，浏览器执行结果未知。目标：${targetText}。`,
        eventData: {
          type: 'player_queue',
          ok: true,
          action,
          count: resolvedSongs.length,
          songs: resolvedSongs,
          missing: missingIds,
          instruction_status: 'generated',
          browser_execution: 'unknown',
        },
        playerAction: {
          type: action === 'replace' ? 'replace_queue' : action,
          action,
          song: resolvedSongs[0],
          songs: resolvedSongs,
          requestedSongIds: rawSongIds,
          missingSongIds: missingIds,
        },
      });
    } catch (err) {
      console.error('player_queue failed:', err);
      return createToolResult({
        summary: '播放队列操作失败',
        modelText: '播放队列查询异常。',
        eventData: { type: 'player_queue', ok: false, error: 'database_query_failed' },
      });
    }
  },
};
