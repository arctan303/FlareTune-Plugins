import { isRomanizedSearchQuery, romanizeJapaneseKana } from "@flaretune/plugin-sdk/server/japanese-romanization";
import { songSearchKeys, songSearchOrder } from "@flaretune/plugin-sdk/server/song-search-order";

const PAGE_SIZE = 1000;

export async function queryRomanizedSongs(db, rawQuery, limit, offset = 0, {
  languageFilter = { sql: '', bindings: [] }, excludeIds = [], onMatch,
} = {}) {
  if (!isRomanizedSearchQuery(rawQuery)) return [];
  const query = romanizeJapaneseKana(rawQuery);
  if (!query) return [];
  const excluded = new Set(excludeIds);
  const matches = [];
  // Repeated artists/albums should not be romanized once per candidate row.
  // Request-local LRU bounds memory and never serves stale catalog metadata.
  const normalized = new Map();
  const romanized = value => {
    const key = String(value || '');
    let result = normalized.get(key);
    if (result === undefined) result = romanizeJapaneseKana(key);
    else normalized.delete(key);
    normalized.set(key, result);
    if (normalized.size > 1024) normalized.delete(normalized.keys().next().value);
    return result;
  };
  const keys = songSearchKeys();
  let cursor;
  while (matches.length < offset + limit) {
    const projection = `s.id, s.title, s.artist, s.album,
      ${keys.map((key, index) => `${key} AS search_key_${index}`).join(', ')}`;
    // SQLite does not seek through expression indexes for a row-value > test.
    // Disjoint prefix ranges each seek the index and read at most one page.
    // Numbered parameters reuse language/cursor values, staying below D1's 100.
    let parameter = 0;
    const languageSql = cursor ? languageFilter.sql.replace(/\?/gu, () => `?${++parameter}`) : languageFilter.sql;
    const where = `s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
        ${languageSql ? `AND ${languageSql}` : ''}
        AND (s.title GLOB '*[ぁ-ゖァ-ヺ]*' OR s.artist GLOB '*[ぁ-ゖァ-ヺ]*'
          OR s.album GLOB '*[ぁ-ゖァ-ヺ]*')`;
    const page = (range = '', limitParameter = '?') => `SELECT ${projection} FROM Songs s
      WHERE ${where} ${range ? `AND ${range}` : ''} ORDER BY ${songSearchOrder()} LIMIT ${limitParameter}`;
    const limitParameter = `?${languageFilter.bindings.length + keys.length + 1}`;
    const sqlQuery = cursor ? `SELECT * FROM (${keys.map((key, index) => {
      const range = keys.slice(0, index).map((prefix, i) => `${prefix} = ?${languageFilter.bindings.length + i + 1}`);
      range.push(`${key} > ?${languageFilter.bindings.length + index + 1}`);
      return `SELECT * FROM (${page(range.join(' AND '), limitParameter)})`;
    }).join(' UNION ALL ')}) ORDER BY ${keys.map((_,i) => `search_key_${i}`).join(', ')} LIMIT ${limitParameter}` : page();
    const { results = [] } = await db.prepare(sqlQuery)
      .bind(...languageFilter.bindings, ...(cursor || []), PAGE_SIZE).all();
    for (const song of results) {
      if (excluded.has(song.id)) continue;
      if ([song.title, song.artist, song.album].some((field) => romanized(field).includes(query))) {
        matches.push(song.id);
        onMatch?.();
        if (matches.length === offset + limit) break;
      }
    }
    if (results.length) cursor = keys.map((_, index) => results.at(-1)[`search_key_${index}`]);
    if (results.length < PAGE_SIZE) break;
  }
  const ids = matches.slice(offset, offset + limit);
  if (!ids.length) return [];
  // Fetch large projection fields only for the selected page, with live filters.
  const { results = [] } = await db.prepare(`SELECT s.id,s.title,s.artist,s.album,s.duration,s.audio_url,s.cover_url,s.language
    FROM Songs s WHERE s.id IN (${ids.map(() => '?').join(',')})
      AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
      ${languageFilter.sql ? `AND ${languageFilter.sql}` : ''}`)
    .bind(...ids, ...languageFilter.bindings).all();
  const byId = new Map(results.map(song => [song.id, song]));
  return ids.map(id => byId.get(id)).filter(song => song
    && [song.title, song.artist, song.album].some(field => romanizeJapaneseKana(field).includes(query)));
}
