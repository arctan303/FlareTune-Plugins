// These implementation contracts moved with their owning plugin source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const sources={
  "./components/LyricsManagementWorkspace.jsx": "./LyricsPluginPage.jsx",
  "./components/LyricsCandidatePanel.jsx": "./LyricsCandidatePanel.jsx"
};
const readSource = path => { if (!Object.hasOwn(sources,path)) throw new Error('Unknown plugin test source: '+path); return readFileSync(new URL(sources[path],import.meta.url),'utf8'); };

test("fullscreen lyric entry opens the shared workspace without a tools drawer", () => {
const lyricsWorkspace = readSource('./components/LyricsManagementWorkspace.jsx');
assert.match(lyricsWorkspace, /managed\.saveDocument/);
assert.match(lyricsWorkspace, /lyricsWorkspaceApi\.prepareLyricsDraft/);
assert.doesNotMatch(lyricsWorkspace, /managed\.(shiftTimeline|importLrc|restoreBackup|clearTranslation|reset)\(/);
assert.doesNotMatch(lyricsWorkspace, /updateSongLanguage|歌曲语言<select/);
assert.match(lyricsWorkspace, /canEdit && managed\.aiCompletionEnabled && <button/);
assert.match(lyricsWorkspace, /managed\.isAiCompleting/);
assert.doesNotMatch(lyricsWorkspace, /manageApi\.updateSong/);
assert.match(lyricsWorkspace, /<LyricsCandidatePanel key=\{song\.id\}/);
assert.match(readSource('./components/LyricsCandidatePanel.jsx'), /lyricsWorkspaceApi\.getLyricsCandidates\(song\.id/);
assert.match(lyricsWorkspace, /lyricsWorkspaceApi\.completeDraftLyrics\(/);
});

test("protected pages rely on the app auth gate without shipping visitor UI branches", () => {
const lyrics = readSource('./components/LyricsManagementWorkspace.jsx');
assert.doesNotMatch(lyrics, /lyrics-workspace__auth|访客状态|登录后管理共享歌词/);
assert.match(lyrics, /enabled: Boolean\(baseSong\?\.id\) && authenticated/);
});
