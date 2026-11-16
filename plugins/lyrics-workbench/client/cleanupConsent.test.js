import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes, button, flushAsync } from '../../../tests/lyricCandidateHarness.js';
import * as editor from './editor.js';
import * as shift from './timelineShift.js';
import { workbenchMessage } from '../shared/messages.js';
import { createLyricsWorkspaceApi } from './api.js';

const original = [{ time: 1, text: 'Lyrics by Fixture' }, { time: 2, text: 'Hello' }];
function fixture({ role = 'admin', locale = 'en' } = {}) {
  let song = { id: 'one', title: 'One', artist: 'Singer' }, guard;
  const requests = [], notices = [], confirmations = [], saves = [];
  const managed = { asset: { status: 'ready', original: { syncMode: 'line' } },
    lyrics: { syncMode: 'line', lines: original }, aiCompletionEnabled: true, etag: 'v1',
    saveDocument: async (...args) => { saves.push(args); return true; }, completeTranslation: async () => requests.push('ordinary') };
  const host = { isCurrent: () => true, notify: message => notices.push(message), navigate() {},
    session: { get: () => ({ authenticated: true, user: { role } }) },
    beforeLeave: { register: callback => { guard = callback; return () => {}; } } };
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsPluginPage.jsx', import.meta.url)),
    exportName: 'LyricsWorkspaceContent', modules: {
      '@flaretune/plugin-sdk': { t: x => x, useLocale: () => locale, lyricSourceLabel: x => x,
        SettingsInput: 'input', SettingsToggle: 'toggle', useSettingsReadOnly: () => false,
        SyncedLyricText: 'synced', ProgressBar: 'progress', PageBackButton: 'back' },
      'lucide-react': {}, './workspace.css': {}, './LyricsSettings.jsx': 'settings', './LyricsCandidatePanel.jsx': 'candidates',
      './useHostPlayer.js': { useHostPlayer: () => ({ currentSong: null, currentTime: 0, duration: 100 }) },
      './useManagedLyricsAsset.js': { useManagedLyricsAsset: () => managed },
      './api.js': { createLyricsWorkspaceApi: () => ({ completeDraftLyrics: async (_songId, body) => {
        requests.push(body); return { data: { lines: body.cleanDirtyLyrics ? original.slice(1) : original, receipt: 'signed-fixture' } };
      } }) },
      './editor.js': editor, './timelineShift.js': shift, './previewScroll.js': {}, '../shared/messages.js': { workbenchMessage },
    }, globals: { window: { confirm: message => { confirmations.push(message); return true; }, addEventListener() {}, removeEventListener() {} } } });
  return { component, requests, notices, confirmations, saves,
    render: () => component.render({ host, pageId: 'current', context: { song, route: { songId: song.id } } }),
    changeSong: () => { song = { ...song, id: 'two', title: 'Two' }; }, canLeave: () => guard() };
}
const cleanupToggle = tree => nodes(tree).find(node => node.type === 'toggle');

test('draft translation preserves all original lines by default and never claims cleanup', async () => {
  const f = fixture(); assert.equal(cleanupToggle(f.render()), undefined);
  button(f.render(), '编辑歌词').props.onClick(); let tree = f.render();
  assert.equal(cleanupToggle(tree).props.checked, false);
  button(tree, 'AI 补全').props.onClick(); await flushAsync(); tree = f.render();
  assert.equal(f.requests[0].cleanDirtyLyrics, false);
  assert.deepEqual(nodes(tree).find(node => node.props.editing && node.props.rows).props.rows.map(row => row.text), original.map(row => row.text));
  assert.equal(f.notices.at(-1), workbenchMessage('draftCompleted', 'en'));
  assert.equal(cleanupToggle(tree).props.checked, false); assert.equal(f.saves.length, 0); f.component.unmount();
});
test('explicit administrator cleanup applies only to one draft invocation and uses its own result message', async () => {
  const f = fixture(); button(f.render(), '编辑歌词').props.onClick(); let tree = f.render();
  cleanupToggle(tree).props.onChange({ target: { checked: true } }); tree = f.render();
  button(tree, 'AI 补全').props.onClick(); await flushAsync(); tree = f.render();
  assert.equal(f.requests[0].cleanDirtyLyrics, true);
  assert.equal(f.notices.at(-1), workbenchMessage('draftCleaned', 'en'));
  assert.equal(cleanupToggle(tree).props.checked, false);
  assert.equal(nodes(tree).find(node => node.props.editing && node.props.rows).props.rows.length, 1);
  assert.equal(f.saves.length, 0); f.component.unmount();
});
test('cleanup consent participates in unsaved-change guarding and resets on cancel, song change and candidate import', () => {
  const f = fixture(); button(f.render(), '编辑歌词').props.onClick(); let tree = f.render();
  cleanupToggle(tree).props.onChange({ target: { checked: true } }); tree = f.render();
  assert.equal(f.canLeave(), true); assert.equal(f.confirmations.length, 1);
  button(tree, '取消').props.onClick(); button(f.render(), '编辑歌词').props.onClick(); tree = f.render();
  assert.equal(cleanupToggle(tree).props.checked, false);
  cleanupToggle(tree).props.onChange({ target: { checked: true } }); f.changeSong(); f.render();
  button(f.render(), '编辑歌词').props.onClick(); tree = f.render(); assert.equal(cleanupToggle(tree).props.checked, false);
  cleanupToggle(tree).props.onChange({ target: { checked: true } }); tree = f.render();
  nodes(tree).find(node => node.type === 'candidates').props.onImport({ lyrics: { lines: original } }); tree = f.render();
  assert.equal(cleanupToggle(tree).props.checked, false); f.component.unmount();
});
test('members never see draft cleanup and ordinary translation stays available without it', async () => {
  const f = fixture({ role: 'member' }); const tree = f.render();
  assert.equal(cleanupToggle(tree), undefined);
  assert.equal(nodes(tree).some(node => node.type === 'button' && node.props.children.includes('编辑歌词')), false);
  button(tree, 'AI 补全').props.onClick(); await flushAsync(); assert.deepEqual(f.requests, ['ordinary']); f.component.unmount();
});
test('cleanup controls and result messages have package-owned text for all five locales', () => {
  const labels = new Set();
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
    const f = fixture({ locale }); button(f.render(), '编辑歌词').props.onClick();
    const label = cleanupToggle(f.render()).props.label; assert.equal(label, workbenchMessage('cleanupWithDraft', locale)); labels.add(label);
    assert.notEqual(workbenchMessage('draftCompleted', locale), workbenchMessage('draftCleaned', locale)); f.component.unmount();
  }
  assert.equal(labels.size, 5);
});
test('the workspace API sends cleanup consent only on admin draft calls and defaults it to false', async () => {
  const requests = [];
  const host = { isCurrent: () => true, session: { get: () => ({ user: { role: 'admin' } }) },
    features: { isAvailable: () => true }, request: async (...args) => { requests.push(args); return { ok: true }; } };
  const api = createLyricsWorkspaceApi(host);
  await api.completeDraftLyrics('one', { lines: original, etag: 'v1' });
  await api.completeDraftLyrics('one', { lines: original, etag: 'v1', cleanDirtyLyrics: true });
  await api.completeLyricsTranslation('one');
  assert.equal(requests[0][1].body.cleanDirtyLyrics, false); assert.equal(requests[1][1].body.cleanDirtyLyrics, true);
  assert.deepEqual(requests[2][1].body, {});
});
