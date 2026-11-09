import { localAccountPlaylistActions as service } from "@flaretune/plugin-sdk/server/account-music";
import { managePlaylistTool } from "./managePlaylist.js";
import { createToolResult } from "./toolResult.js";

const PUBLIC_ERRORS = new Set([
  'INVALID_BODY', 'INVALID_NAME', 'INVALID_DESCRIPTION', 'PLAYLIST_NOT_FOUND',
  'REVISION_CONFLICT', 'PLAYLIST_LIMIT_REACHED', 'PLAYLIST_SONG_LIMIT_REACHED',
  'SONG_NOT_FOUND', 'FAVORITE_DELETE_FORBIDDEN', 'FAVORITE_METADATA_FORBIDDEN',
  'AMBIGUOUS_SONG', 'INVALID_TOOL_CALL',
]);
const errorResult = (action, error) => {
  const code = PUBLIC_ERRORS.has(error?.code) ? error.code : 'PLAYLIST_OPERATION_FAILED';
  const message = code === 'PLAYLIST_OPERATION_FAILED' ? '个人歌单存储暂时不可用。' : error.message;
  return createToolResult({
    modelText: JSON.stringify({ ok: false, action, error: code, message }),
    summary: message,
    eventData: { ok: false, action, error: code, message },
  });
};

const result = (action, data, summary) => createToolResult({
  modelText: JSON.stringify({ ok: true, action, ...data }),
  summary,
  eventData: { ok: true, action, ...data },
});

async function resolveSongIds(db, value) {
  if (!Array.isArray(value) || value.length > 500 || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw Object.assign(new Error('song_ids 必须是有效歌曲 ID 或歌名数组。'), { code: 'INVALID_BODY' });
  }
  const resolved = [];
  for (const candidate of value) {
    const input = candidate.trim().replace(/^《|》$/g, '');
    const byId = await db.prepare('SELECT id FROM Songs WHERE id = ?').bind(input).first();
    if (byId) { resolved.push(byId.id); continue; }
    const matches = await db.prepare('SELECT id FROM Songs WHERE LOWER(title) = LOWER(?) LIMIT 2').bind(input).all();
    if (matches.results?.length !== 1) {
      throw Object.assign(new Error(matches.results?.length ? `歌名「${input}」对应多首歌曲，请使用歌曲 ID。` : `找不到歌曲「${input}」。`),
        { code: matches.results?.length ? 'AMBIGUOUS_SONG' : 'SONG_NOT_FOUND' });
    }
    resolved.push(matches.results[0].id);
  }
  return resolved;
}

function requireId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 240) {
    throw Object.assign(new Error('请提供有效的个人歌单 ID。'), { code: 'INVALID_BODY' });
  }
  return value.trim();
}

async function currentPlaylist(db, accountId, args) {
  const id = requireId(args.playlist_id);
  const playlist = await service.getPlaylist(db, accountId, id);
  if (args.expected_revision !== undefined && args.expected_revision !== playlist.revision) {
    throw Object.assign(new Error('歌单已在其他页面更新，请先重新读取。'), { code: 'REVISION_CONFLICT' });
  }
  return playlist;
}

export async function executeLocalManagePlaylist(args = {}, context = {}) {
  const action = typeof args?.action === 'string' ? args.action : '';
  const { db, accountId } = context;
  if (!db?.prepare || !db?.batch || typeof accountId !== 'string' || !accountId) {
    return errorResult(action, { code: 'AUTH_REQUIRED', message: '需要登录账号才能管理个人歌单。' });
  }
  const now = typeof context.now === 'number' ? context.now : Date.now();
  try {
    if (action === 'list') {
      const data = await service.listPlaylists(db, accountId, now);
      return result(action, data, `读取了 ${data.playlists.length} 个个人歌单`);
    }
    if (action === 'read') {
      const playlist = await currentPlaylist(db, accountId, args);
      return result(action, { playlist }, `读取歌单《${playlist.name}》`);
    }
    if (action === 'create') {
      if (typeof context.toolCallId !== 'string' || !context.toolCallId) {
        throw Object.assign(new Error('缺少操作标识，未创建歌单。'), { code: 'INVALID_TOOL_CALL' });
      }
      const data = await service.createPlaylist(db, accountId, {
        name: args.name, description: args.description,
        idempotencyKey: `${context.clientMessageId || ''}:${context.toolCallId}`,
      }, now);
      return result(action, data, data.outcome === 'noop' ? `歌单《${data.playlist.name}》此前已创建` : `已创建歌单《${data.playlist.name}》`);
    }
    const playlist = await currentPlaylist(db, accountId, args);
    const id = playlist.id;
    const expectedRevision = playlist.revision;
    if (action === 'add_songs') {
      const songIds = await resolveSongIds(db, args.song_ids);
      const data = await service.addSongs(db, accountId,
        { targets: [{ playlistId: id, expectedRevision }], songIds }, now);
      if (data.outcome === 'failed' || data.outcome === 'partial') {
        throw Object.assign(new Error('歌曲未能加入歌单。'), { code: data.results?.[0]?.error || 'PLAYLIST_OPERATION_FAILED' });
      }
      return result(action, data, data.outcome === 'noop' ? '这些歌曲已在歌单中' : '已将歌曲加入个人歌单');
    }
    if (['remove_songs', 'clear', 'replace_songs', 'reorder_songs'].includes(action)) {
      const existing = playlist.songs.map((song) => String(song.id));
      let songIds;
      if (action === 'clear') songIds = [];
      else {
        const requested = await resolveSongIds(db, args.song_ids);
        if (action === 'remove_songs') songIds = existing.filter((songId) => !requested.includes(songId));
        else if (action === 'reorder_songs') {
          if (requested.length !== existing.length || new Set(requested).size !== requested.length
            || requested.some((songId) => !existing.includes(songId))) {
            throw Object.assign(new Error('排序必须包含当前歌单所有歌曲，且不能重复。'), { code: 'INVALID_BODY' });
          }
          songIds = requested;
        } else songIds = requested;
      }
      const data = await service.replaceSongs(db, accountId, id, { expectedRevision, songIds }, now);
      return result(action, data, data.outcome === 'noop' ? '歌单内容无需修改' : '已更新个人歌单歌曲');
    }
    if (action === 'update_metadata') {
      const data = await service.updatePlaylist(db, accountId, id, {
        expectedRevision,
        ...(Object.hasOwn(args, 'name') ? { name: args.name } : {}),
        ...(Object.hasOwn(args, 'description') ? { description: args.description } : {}),
      }, now);
      return result(action, data, data.outcome === 'noop' ? '歌单信息无需修改' : '已更新个人歌单信息');
    }
    if (action === 'delete') {
      if (context.requireDeleteConfirmation === true) {
        if (playlist.kind === 'favorite') {
          throw Object.assign(new Error('“我的收藏”歌单不可删除。'), { code: 'FAVORITE_DELETE_FORBIDDEN' });
        }
        const confirmation = { playlistId: id, name: playlist.name, expectedRevision };
        return createToolResult({
          modelText: JSON.stringify({ ok: false, action, error: 'CONFIRMATION_REQUIRED',
            message: '当前助手消息内会显示删除歌单确认卡片，听众可点“删除歌单”或“保留歌单”；本轮工具不知道点选结果，不要称它为弹窗，也不要声称已删除。' }),
          summary: `等待确认删除歌单《${playlist.name}》`,
          eventData: { ok: false, action, error: 'CONFIRMATION_REQUIRED', confirmation },
        });
      }
      const data = await service.deletePlaylist(db, accountId, id, { expectedRevision }, now);
      return result(action, data, '已删除个人歌单');
    }
    throw Object.assign(new Error('未知的歌单动作。'), { code: 'INVALID_BODY' });
  } catch (error) {
    return errorResult(action, error);
  }
}

export const localManagePlaylistTool = {
  ...managePlaylistTool,
  description: '读取或修改当前登录账号自己的个人歌单，支持 list、read、create、add_songs、remove_songs、clear、replace_songs、reorder_songs、update_metadata 和 delete；delete 仅在当前助手消息内生成确认卡片，听众点选后才会删除，不需听众再输入确认句；不能访问其他账号。',
  execute: executeLocalManagePlaylist,
};
