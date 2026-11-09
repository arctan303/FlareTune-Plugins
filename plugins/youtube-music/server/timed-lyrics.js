import { YTNodes } from 'youtubei.js/cf-worker';
import { createLyricDocument } from "@flaretune/plugin-sdk/server/lyric-document";
import { safeText, YouTubeError } from "./core.js";

// Same native response/request used by ytmusicapi's get_lyrics(timestamps=True):
// https://github.com/sigma67/ytmusicapi/blob/main/ytmusicapi/mixins/browsing.py
// Keep the installed SDK for transport and navigation; only adapt the missing
// timedLyricsModel renderer instead of forking its parser or fabricating times.
export const MUSIC_LYRICS_CLIENT_VERSION = '7.21.50';
const milliseconds = value => (typeof value === 'number' || typeof value === 'string' && /^\d+$/u.test(value))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 86400000 ? Number(value) : null;

export function normalizeTimedLyrics(response) {
  const data = response?.contents?.elementRenderer?.newElement?.type?.componentType?.model?.timedLyricsModel?.lyricsData;
  const raw = data?.timedLyricsData;
  if (!Array.isArray(raw) || !raw.length) return null;
  if (raw.length > 2000 || raw.some(line => typeof line?.lyricLine !== 'string' || line.lyricLine.length > 4000)) {
    throw new YouTubeError('YOUTUBE_LYRICS_TOO_LARGE', 502);
  }
  const text = raw.map(line => line.lyricLine).join('\n');
  if (text.length > 200000) throw new YouTubeError('YOUTUBE_LYRICS_TOO_LARGE', 502);
  if (!text.trim()) return null;
  const ranges = raw.map(line => ({ start: milliseconds(line.cueRange?.startTimeMilliseconds),
    end: milliseconds(line.cueRange?.endTimeMilliseconds) }));
  const timed = ranges.every(range => range.start !== null && range.end !== null && range.end >= range.start)
    && ranges.some(range => range.start > 0 || range.end > 0)
    && ranges.every((range, i) => i === 0 || range.start >= ranges[i - 1].start);
  const document = createLyricDocument({ source: 'youtube', format: timed ? 'lrc' : 'plain',
    lines: raw.map((line, i) => ({ text: line.lyricLine,
      ...(timed ? { time: ranges[i].start / 1000, endTime: ranges[i].end / 1000 } : {}) })) });
  return { status: 'available', source: 'youtube', format: document.format, syncMode: document.syncMode,
    lines: document.lines, text, attribution: safeText(data.sourceMessage).slice(0, 2000) };
}

export async function fetchTimedLyrics(guest, mobile, id) {
  const next = await guest.actions.execute('/next', { videoId: id, client: 'YTMUSIC', parse: true });
  const tab = next.contents_memo?.getType(YTNodes.Tab)?.find(node =>
    node.endpoint?.payload?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType === 'MUSIC_PAGE_TYPE_TRACK_LYRICS');
  const browseId = tab?.endpoint?.payload?.browseId;
  if (typeof browseId !== 'string' || !/^MPLYt[\w-]{1,2040}$/u.test(browseId)) return null;
  // A client option here would downgrade 7.21.50 to the SDK's old 5.34.51.
  // The isolated mobile session already supplies the correct body and headers.
  const response = await mobile.actions.execute('/browse', { browseId, parse: false });
  return normalizeTimedLyrics(response.data);
}
