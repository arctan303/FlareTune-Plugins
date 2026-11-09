import { createLyricArtifactStore } from "@flaretune/plugin-sdk/server/lyric-assets";
import { projectLyricArtifact } from "@flaretune/plugin-sdk/server/lyric-workflow";
import { createToolResult } from "./toolResult.js";

export const songDetailsTool = {
  name: 'song_details',
  displayName: '读取歌曲资料',
  description: '按已确认的歌曲 ID 读取曲库元数据；可选读取本实例已经保存的有界歌词片段，用于回答这首歌的具体问题。不会向外部歌词提供商请求。',
  parameters: {
    type: 'object', properties: {
      song_id: { type: 'string', maxLength: 120, description: '曲库中的精确歌曲 ID，优先取本轮当前播放或 music_query 结果。' },
      include_lyrics: { type: 'boolean', description: '是否读取已保存的歌词片段，默认 false。' },
      lyric_offset: { type: 'integer', minimum: 0, maximum: 500, description: '歌词起始行，默认 0。' },
    }, required: ['song_id'],
  },
  async execute(args, { db, env } = {}) {
    const id = typeof args?.song_id === 'string' ? args.song_id.trim() : '';
    if (!id || id.length > 120 || !db?.prepare) return createToolResult({
      modelText: '歌曲 ID 无效或曲库不可用。', summary: '歌曲资料不可用',
      eventData: { ok: false, error: 'invalid_song_id' },
    });
    const song = await db.prepare(`SELECT id,title,artist,album,duration,language
      FROM Songs WHERE id = ?`).bind(id).first();
    if (!song) return createToolResult({ modelText: '曲库中没有这首歌。',
      summary: '未找到歌曲', eventData: { ok: false, error: 'song_not_found' } });
    const data = { song, lyrics: null };
    if (args.include_lyrics === true && song.language !== 'instrumental') {
      try {
        const read = await createLyricArtifactStore(env).get(id);
        if (read.state === 'found' && read.artifact?.status === 'ready') {
          const projection = projectLyricArtifact(read.artifact, { song });
          const offset = Number.isInteger(args.lyric_offset) ? args.lyric_offset : 0;
          const lines = (projection?.lines || []).slice(offset, offset + 12)
            .map((line) => ({ text: String(line.text || '').slice(0, 200),
              ...(line.tlyric ? { translation: String(line.tlyric).slice(0, 200) } : {}) }))
            .filter((line) => line.text);
          data.lyrics = { lines, offset, totalLines: projection?.lines?.length || 0,
            source: projection?.source || null };
        }
      } catch {
        // Metadata remains usable when a saved lyric artifact is unavailable.
      }
    }
    return createToolResult({ modelText: JSON.stringify(data),
      summary: data.lyrics ? `读取了《${song.title}》资料与 ${data.lyrics.lines.length} 行歌词` : `读取了《${song.title}》资料`,
      eventData: { ok: true, song, lyricsAvailable: Boolean(data.lyrics) } });
  },
};
