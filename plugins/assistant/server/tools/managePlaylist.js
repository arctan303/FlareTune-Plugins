export const managePlaylistTool = {
  name: 'manage_playlist',
  displayName: '管理账号歌单',
  description: '读取或管理当前登录听众的账号个人歌单。我的收藏名称与封面固定；详情编辑只调整曲序，明确指令仍可增删收藏歌曲。普通歌单支持创建、编辑与删除。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'add_songs', 'remove_songs', 'clear', 'replace_songs', 'reorder_songs', 'update_metadata', 'delete'],
        description: '操作类型：list（获取歌单列表）、read（读取歌单详情与歌曲）、create（创建新歌单）、add_songs（添加歌曲）、remove_songs（移除歌曲）、clear（清空歌单）、replace_songs（替换全部歌曲）、reorder_songs（调整歌曲顺序）、update_metadata（修改名称/简介）、delete（删除歌单）。',
      },
      playlist_id: {
        type: 'string',
        description: '目标歌单 ID（我的收藏为 fav_...，普通歌单为 pl_...，由 list/read 或 create 返回）。',
      },
      song_ids: {
        type: 'array',
        maxItems: 500,
        items: { type: 'string' },
        description: '歌曲 ID 数组（必须是 music_query 查询到的歌曲 id，如 ["4839ac1ad2a4e009"]；也支持传入精确歌名）。',
      },
      expected_revision: {
        type: 'integer',
        minimum: 0,
        description: '目标歌单的版本号 expectedRevision（可选；新建歌单为 0，已有歌单由 list/read 返回；若不提供则自动采用当前最新版本）。',
      },
      name: {
        type: 'string',
        maxLength: 40,
        description: '歌单名称（action=create 时必填，action=update_metadata 时可选）。',
      },
      description: {
        type: 'string',
        maxLength: 300,
        description: '歌单描述简介（可选）。',
      },
    },
    required: ['action'],
  },
};
