import { normalizeSong } from "@flaretune/plugin-sdk/server/song-dto";
import { createToolFailure, createToolResult } from "./toolResult.js";
import { accountPlaysTable, readAccountTopSongs } from "@flaretune/plugin-sdk/server/account-read-model";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const failure = (code, modelText, summary, message) => createToolFailure({
  modelText,
  summary,
  type: 'music_cards',
  code,
  message,
  data: { songs: [] },
});

const limitOf = (args) => {
  if (args === undefined || args === null) return DEFAULT_LIMIT;
  if (typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some((key) => key !== 'limit')) return null;
  if (args.limit === undefined) return DEFAULT_LIMIT;
  return Number.isInteger(args.limit) && args.limit >= 1 && args.limit <= MAX_LIMIT
    ? args.limit : null;
};

/**
 * Read-only personal statistics for the local-account assistant. The caller
 * must pass accountId obtained from the verified normal session, never from
 * a model argument, legacy OAuth subject or request header.
 */
export const localListeningStatsTool = {
  name: 'my_listening_stats',
  displayName: '我的收听统计',
  description: '读取当前登录账号自己的累计播放次数、收听曲目数，以及播放次数最多的歌曲。',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_LIMIT,
        description: '返回的歌曲数量，默认 20，最大 50。',
      },
    },
  },
  async execute(args, context = {}) {
    const accountId = context?.accountId;
    if (typeof accountId !== 'string' || !accountId.trim()) {
      return failure('authentication_required', '收听统计只对登录账号开放，请先登录后再问。',
        '需要登录账号', 'local account session is required');
    }
    const db = context?.db;
    if (!db || typeof db.prepare !== 'function') {
      return failure('database_unavailable', '播放统计存储当前不可用，请稍后再试。',
        '播放统计存储不可用', 'music database binding is unavailable');
    }
    const limit = limitOf(args);
    if (limit === null) {
      return failure('invalid_arguments', '收听统计仅接受 1 到 50 的歌曲数量。',
        '收听统计参数无效', 'limit must be an integer between 1 and 50');
    }

    try {
      const plays = await accountPlaysTable(db);
      const [rows, totals] = await Promise.all([
        readAccountTopSongs(db, accountId, limit),
        db.prepare(`SELECT COALESCE(SUM(play_count), 0) AS total_plays,
          COUNT(*) AS total_unique_songs
          FROM ${plays} WHERE account_id = ?`)
          .bind(accountId).first(),
      ]);
      const songs = rows.map(normalizeSong);
      const totalPlays = Number(totals?.total_plays || 0);
      const totalUniqueSongs = Number(totals?.total_unique_songs || 0);
      const modelText = songs.length === 0
        ? '当前账号还没有可用的收听记录。'
        : [
          `这是当前账号播放次数最多的 ${songs.length} 首歌：`,
          ...songs.map((song, index) => `${index + 1}. 《${song.title}》 - ${song.artist}（播放 ${Number(rows[index].play_count) || 0} 次）`),
          `累计播放 ${totalPlays} 次，共 ${totalUniqueSongs} 首曲目。`,
        ].join('\n');
      return createToolResult({
        modelText,
        summary: songs.length > 0 ? `读到 ${songs.length} 首收听最多的歌曲` : '暂无收听记录',
        eventData: {
          ok: true,
          type: 'music_cards',
          songs,
          total_plays: totalPlays,
          total_unique_songs: totalUniqueSongs,
        },
      });
    } catch {
      return failure('database_query_failed', '收听统计查询失败，请稍后再试。',
        '收听统计查询失败', 'music database query failed');
    }
  },
};
