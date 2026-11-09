import { buildSongLanguageFilter } from "@flaretune/plugin-sdk/server/song-language";
import { normalizeSong } from "@flaretune/plugin-sdk/server/song-dto";
import { createToolResult } from "./toolResult.js";
import { queryRomanizedSongs } from "@flaretune/plugin-sdk/server/romanized-search";

const PLAYABLE_WHERE = "audio_url IS NOT NULL AND TRIM(audio_url) <> ''";

const escapeLikePattern = (value) => value.replace(/[\\%_]/g, '\\$&');

const normalizeSearchQuery = (value) => String(value || '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/\s+/gu, '');

const compactSqlField = (field) => (
  `REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${field}), ' ', ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), '')`
);

const extractSearchCandidates = (input) => {
  const clean = input.replace(/[!！?？,，。、“”"’'~～:：]/g, ' ').trim();
  if (!clean) return [];
  const candidates = new Set([clean]);
  clean.split(/\s+/).filter((part) => part.length >= 2).forEach((part) => candidates.add(part));
  const stripped = clean.replace(/\(.*?\)|（.*?）|\[.*?\]|-.*$/g, '').trim();
  if (stripped.length >= 2) candidates.add(stripped);
  return [...candidates];
};

const makeResult = ({ ok, markdown, summary, data, error }) => {
  return createToolResult({
    modelText: markdown,
    summary,
    eventData: {
      ...(data || {}),
      ok: Boolean(ok),
      ...(error ? { error } : {}),
    },
  });
};

/**
 * 随机抽取可播放曲目。
 *
 * random 分支使用这一套规则：可播放校验、语种筛选与去重。
 */
export const queryRandomSongs = async (db, {
  count = 5,
  excludeIds = [],
  languageFilter = { sql: '', bindings: [] },
} = {}) => {
  const where = [
    PLAYABLE_WHERE.replaceAll('audio_url', 's.audio_url'),
    languageFilter.sql || '',
    excludeIds.length > 0 ? `s.id NOT IN (${excludeIds.map(() => '?').join(',')})` : '',
  ].filter(Boolean).join(' AND ');
  const bindings = [...languageFilter.bindings, ...excludeIds, count];
  const { results = [] } = await db.prepare(`
    SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
    FROM Songs s WHERE ${where} ORDER BY RANDOM() LIMIT ?
  `).bind(...bindings).all();
  return results.map(normalizeSong);
};

const unavailable = () => makeResult({
  ok: false,
  markdown: '乐境曲库数据库当前不可用，请稍后再试。',
  summary: '乐境曲库不可用',
  error: { code: 'database_unavailable', message: 'music database binding is unavailable' },
  data: { type: 'music_cards', songs: [] },
});

const queryFailed = () => makeResult({
  ok: false,
  markdown: '乐境曲库查询失败，请稍后再试。',
  summary: '乐境曲库查询失败',
  error: { code: 'database_query_failed', message: 'music database query failed' },
  data: { type: 'music_cards', songs: [] },
});

export const musicQueryTool = {
  name: 'music_query',
  displayName: '检索乐境曲库',
  description: '查询当前 FlareTune 实例的完整可播放曲库。支持搜索和随机发现；个人歌单请使用 my_playlists。',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search', 'random'],
        description: '查询类型：search（关键词搜索）、random（随机发现）。',
      },
      keyword: {
        type: 'string',
        description: '搜索关键词，可为歌名、标准歌手名或专辑；日语假名可用罗马字输入。action=search 时必填。',
      },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: '返回数量，默认 5，最大 10。',
      },
      exclude_ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 50,
        description: '需要排除的歌曲 ID，用于多轮推荐避免重复。',
      },
      language: {
        type: 'string',
        enum: ['zh', 'en', 'ja', 'ko', 'instrumental', 'other'],
        description: '按语种筛选曲目：zh（华语/中文）、en（英语）、ja（日语）、ko（韩语）、instrumental（纯音乐/器乐曲）、other（其他语种，如粤语/俄/法/西/德等）。当听众指定语种时传入。',
      },
    },
  },
  async execute(args, context = {}) {
    const db = context?.db;
    if (!db || typeof db.prepare !== 'function') return unavailable();

    const rawLanguage = typeof args?.language === 'string' ? args.language.trim().toLowerCase() : null;
    const languageFilter = rawLanguage ? buildSongLanguageFilter(rawLanguage, 's.language') : { sql: '', bindings: [] };
    if (rawLanguage && languageFilter === null) {
      return makeResult({
        ok: false,
        markdown: '指定的歌曲语种不支持，支持的语种代码为：zh、en、ja、ko、instrumental、other。',
        summary: '语种参数无效',
        error: { code: 'invalid_language', message: 'language parameter is invalid' },
        data: { type: 'music_cards', songs: [] },
      });
    }

    const keyword = typeof args?.keyword === 'string' ? args.keyword.trim().slice(0, 200) : '';
    const action = typeof args?.action === 'string' && args.action
      ? args.action
      : (keyword ? 'search' : 'random');
    const count = Math.max(1, Math.min(Math.trunc(Number(args?.count) || 5), 10));
    const excludeIds = Array.isArray(args?.exclude_ids)
      ? [...new Set(args.exclude_ids.map(String).filter(Boolean))].slice(0, 50)
      : [];

    if (args?.playlist_id !== undefined) {
      return makeResult({
        ok: false,
        markdown: '个人歌单请使用 my_playlists 工具读取。',
        summary: '曲库查询参数无效',
        error: { code: 'invalid_arguments', message: 'playlist_id is not supported' },
        data: { type: 'music_cards', songs: [] },
      });
    }

    try {
      let songs = [];
      if (action === 'search') {
        if (!keyword) {
          return makeResult({
            ok: false,
            markdown: '搜索曲库需要有效的 keyword。',
            summary: '搜索词为空',
            error: { code: 'invalid_arguments', message: 'keyword is required' },
            data: { type: 'music_cards', songs: [] },
          });
        }
        const languageSql = languageFilter.sql ? `AND ${languageFilter.sql}` : '';
        for (const candidate of extractSearchCandidates(keyword)) {
          const like = `%${escapeLikePattern(candidate.toLowerCase())}%`;
          const compact = `%${escapeLikePattern(normalizeSearchQuery(candidate))}%`;
          const excludeClause = excludeIds.length > 0
            ? `AND s.id NOT IN (${excludeIds.map(() => '?').join(',')})`
            : '';
          const { results = [] } = await db.prepare(`
            SELECT s.id, s.title, s.artist, s.album, s.duration, s.audio_url, s.cover_url, s.language
            FROM Songs s
            WHERE ${PLAYABLE_WHERE.replaceAll('audio_url', 's.audio_url')}
              ${languageSql}
              AND (
                LOWER(s.title) LIKE ? ESCAPE '\\' OR LOWER(s.artist) LIKE ? ESCAPE '\\'
                OR LOWER(s.album) LIKE ? ESCAPE '\\'
                OR ${compactSqlField('s.title')} LIKE ? ESCAPE '\\'
                OR ${compactSqlField('s.artist')} LIKE ? ESCAPE '\\'
                OR ${compactSqlField('s.album')} LIKE ? ESCAPE '\\'
              )
              ${excludeClause}
            LIMIT ?
          `).bind(...languageFilter.bindings, like, like, like, compact, compact, compact, ...excludeIds, count).all();
          if (results.length > 0) {
            songs = results.map(normalizeSong);
            break;
          }
        }
        if (songs.length < count) {
          for (const candidate of extractSearchCandidates(keyword)) {
            const romanized = await queryRomanizedSongs(db, candidate, count - songs.length, 0, {
              languageFilter, excludeIds: [...excludeIds, ...songs.map((song) => song.id)],
            });
            if (romanized.length > 0) {
              songs.push(...romanized.map(normalizeSong));
              break;
            }
          }
        }
      } else if (action === 'random') {
        songs = await queryRandomSongs(db, {
          count,
          excludeIds,
          languageFilter,
        });
      } else {
        return makeResult({
          ok: false,
          markdown: `不支持的曲库查询类型：${action}`,
          summary: '曲库查询参数无效',
          error: { code: 'invalid_arguments', message: 'unsupported action' },
          data: { type: 'music_cards', songs: [] },
        });
      }

      const markdown = songs.length > 0
        ? songs.map((song) => `- [《${song.title}》- ${song.artist}](song:${encodeURIComponent(song.id)}) (ID: \`${song.id}\`)${song.album ? `（${song.album}）` : ''}`).join('\n')
        : (action === 'search' ? `没有找到与「${keyword}」匹配的歌曲。` : '当前查询没有可播放歌曲。');
      return makeResult({
        ok: true,
        markdown,
        summary: action === 'search'
          ? `搜索「${keyword}」找到 ${songs.length} 首歌曲`
          : `查询到 ${songs.length} 首歌曲`,
        data: { type: 'music_cards', songs },
      });
    } catch (error) {
      console.error('music_query failed:', error);
      return queryFailed();
    }
  },
};
