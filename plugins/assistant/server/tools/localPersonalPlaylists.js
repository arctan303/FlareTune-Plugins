import { normalizeSong } from "@flaretune/plugin-sdk/server/song-dto";
import { createToolFailure, createToolResult } from "./toolResult.js";
import { accountMembershipTable, readAccountPlaylistSongs } from "@flaretune/plugin-sdk/server/account-read-model";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_OFFSET = 500;
const rows = (result) => result?.results || [];

const failure = (code, modelText, summary, message) => createToolFailure({
  modelText,
  summary,
  type: 'personal_playlists',
  code,
  message,
  data: { playlists: [], songs: [] },
});

export function validPersonalPlaylistArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const action = args.action ?? 'list';
  if (action === 'list') return Object.keys(args).every((key) => key === 'action');
  if (action !== 'read' || Object.keys(args).some((key) => ![
    'action', 'playlist_id', 'limit', 'offset',
  ].includes(key))) return false;
  if (typeof args.playlist_id !== 'string' || !args.playlist_id
    || args.playlist_id !== args.playlist_id.trim() || args.playlist_id.length > 240) return false;
  if (args.limit !== undefined && (!Number.isInteger(args.limit)
    || args.limit < 1 || args.limit > MAX_LIMIT)) return false;
  if (args.offset !== undefined && (!Number.isInteger(args.offset)
    || args.offset < 0 || args.offset > MAX_OFFSET)) return false;
  return true;
}

const summary = (row) => ({
  id: row.id,
  source: 'member',
  kind: row.kind,
  name: row.kind === 'favorite' ? '我的收藏' : row.name,
  description: row.kind === 'favorite' ? '' : (row.description || ''),
  songCount: Number(row.song_count || 0),
  revision: Number(row.revision || 0),
});

export const localPersonalPlaylistsTool = {
  name: 'my_playlists',
  displayName: '我的歌单',
  description: '只读查询当前登录账号自己的个人歌单。先用 list 获取精确歌单 ID，再用 read 分页查看该歌单歌曲；不能创建、编辑或删除歌单。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'read'], description: 'list 列出我的歌单；read 读取指定歌单的歌曲。' },
      playlist_id: { type: 'string', description: 'read 必填；先从 list 结果获取精确 ID，不接受名称代替。' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'read 每页歌曲数，默认 20，最大 50。' },
      offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET, description: 'read 分页偏移，默认 0。' },
    },
  },
  async execute(args, context = {}) {
    const accountId = context?.accountId;
    if (typeof accountId !== 'string' || !accountId.trim()) {
      return failure('authentication_required', '个人歌单只对当前登录账号开放。',
        '需要登录账号', 'local account session is required');
    }
    const db = context?.db;
    if (!db || typeof db.prepare !== 'function') {
      return failure('database_unavailable', '个人歌单存储当前不可用，请稍后再试。',
        '个人歌单存储不可用', 'music database binding is unavailable');
    }
    if (!validPersonalPlaylistArgs(args)) {
      return failure('invalid_arguments', '个人歌单查询参数无效；请先列出歌单，再使用精确 ID 读取。',
        '个人歌单参数无效', 'invalid read-only playlist arguments');
    }
    try {
      const membership = await accountMembershipTable(db);
      if ((args.action ?? 'list') === 'list') {
        // This tool is strictly read-only. The HTTP list route may create the
        // favorite playlist on demand; the assistant never does that write.
        const result = await db.prepare(`SELECT p.id, p.kind, p.name, p.description,
          p.revision, COUNT(ps.song_id) AS song_count
          FROM Member_Playlists p LEFT JOIN ${membership} ps ON ps.playlist_id = p.id
          WHERE p.account_id = ? GROUP BY p.id
          ORDER BY CASE p.kind WHEN 'favorite' THEN 0 ELSE 1 END, p.created_at, p.id`)
          .bind(accountId).all();
        const playlists = rows(result).map(summary);
        return createToolResult({
          modelText: playlists.length ? [
            `当前账号有 ${playlists.length} 个个人歌单：`,
            ...playlists.map((item) => `- ${item.name}（ID：${item.id}，${item.songCount} 首）`),
          ].join('\n') : '当前账号还没有已保存的个人歌单。',
          summary: playlists.length ? `读到 ${playlists.length} 个个人歌单` : '暂无个人歌单',
          eventData: { ok: true, type: 'personal_playlists', playlists, songs: [] },
        });
      }

      const playlist = await db.prepare(`SELECT p.id, p.kind, p.name, p.description,
        p.revision, (SELECT COUNT(*) FROM ${membership} ps
          WHERE ps.playlist_id = p.id) AS song_count
        FROM Member_Playlists p WHERE p.account_id = ? AND p.id = ?`)
        .bind(accountId, args.playlist_id).first();
      if (!playlist) {
        return failure('playlist_not_found', '当前账号没有这个歌单；请先列出你的歌单并使用精确 ID。',
          '个人歌单不存在', 'playlist is not found in current account');
      }
      const limit = args.limit ?? DEFAULT_LIMIT;
      const offset = args.offset ?? 0;
      const songs = (await readAccountPlaylistSongs(db, accountId, args.playlist_id, { limit, offset })).map(normalizeSong);
      const item = summary(playlist);
      return createToolResult({
        modelText: [
          `个人歌单《${item.name}》（ID：${item.id}）共 ${item.songCount} 首；第 ${offset + 1} 首起返回 ${songs.length} 首：`,
          ...songs.map((song, index) => `${offset + index + 1}. 《${song.title}》 - ${song.artist}（ID：${song.id}）`),
        ].join('\n'),
        summary: `读到《${item.name}》的 ${songs.length} 首歌曲`,
        eventData: { ok: true, type: 'personal_playlists', playlist: item,
          playlists: [], songs, offset, limit },
      });
    } catch {
      return failure('database_query_failed', '个人歌单查询失败，请稍后再试。',
        '个人歌单查询失败', 'music database query failed');
    }
  },
};
