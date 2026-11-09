import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./LyricsPluginPage.jsx', import.meta.url), 'utf8');
const candidates = readFileSync(new URL('./LyricsCandidatePanel.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./workspace.css', import.meta.url), 'utf8');
test('workspace remains a page rather than a modal', () => { assert.match(source, /className="lyric-studio"/); assert.doesNotMatch(source, /aria-modal="true"/); });
test('workspace edits and imports shared lyrics with visible word timing caveat', () => {
  assert.match(source, /managed\.saveDocument\(lines, editingEtagRef\.current, draftReceiptRef\.current,/);
  assert.match(source, /managed\.shiftTimeline\(shift\)/);
  assert.match(source, /managed\.importLrc/);
  assert.match(source, /managed\.restoreBackup/);
  assert.match(source, /changedWordRows/);
  assert.match(source, /逐行同步/);
  assert.match(source, /managed\.completeTranslation\(\)/);
  assert.doesNotMatch(source, /managed\.adoptCandidate/);
  assert.match(candidates, /导入当前歌词草稿/);
  assert.match(source, /<LyricsCandidatePanel key=\{song.id\}/);
  assert.match(source, /editingEtagRef\.current = managed\.etag/);
  assert.match(source, /isAdmin &&/);
});

test('workspace follows app page scrolling and light and dark themes', () => {
  assert.match(css, /\.lyric-studio \{/);
  assert.match(css, /html\.dark \.lyric-studio \{/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /\.lyric-studio__layout \{[\s\S]*display: block;/);
  assert.doesNotMatch(css, /position: fixed;/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);

  assert.doesNotMatch(readFileSync(new URL("./workspace.css", import.meta.url), 'utf8'), /prefers-reduced-motion/);
});

