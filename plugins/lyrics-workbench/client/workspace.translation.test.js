import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes, button, flushAsync } from '../../../tests/lyricCandidateHarness.js';
import * as editor from './editor.js';
import * as shift from './timelineShift.js';

test('workspace retains imported and existing translation language, switching it only after AI redo', async () => {
  const saves = [], aiRequests = [];
  const song = { id: 's1', title: 'Song', artist: 'Artist' };
  const auth = { authenticated: true, user: { role: 'admin' } };
  const ui = { lyricsWorkspaceSong: song, authSession: auth,
    setLyricsWorkspaceBeforeCloseGuard() {}, approveLyricsWorkspaceExit: () => true };
  const useUIStore = selector => selector(ui); useUIStore.getState = () => ui;
  const usePlayerStore = selector => selector({ currentSong: null, currentTime: 0, duration: 200 });
  const managed = { asset: { status: 'ready', original: { syncMode: 'line' },
    translation: { language: 'en', lines: ['English translation'] } },
    lyrics: { syncMode: 'line', lines: [{ time: 1, text: 'こんにちは' }] },
    etag: 'e1', aiCompletionEnabled: true, saveDocument: async (...args) => { saves.push(args); return true; } };
  const modules = {
    '../../../shared/lyricSources.js': { lyricSourceLabel: x => x }, '@flaretune/plugin-sdk/client/i18n': { t: x => x },
    './SettingsReadOnly.jsx': { SettingsInput: 'input', useSettingsReadOnly: () => false },
    '@flaretune/plugin-sdk': { t: x => x, lyricSourceLabel: x => x, SettingsInput: 'input', useSettingsReadOnly: () => false,
        SyncedLyricText: 'SyncedLyricText', ProgressBar: 'ProgressBar', PageBackButton: 'PageBackButton' },
      './useHostPlayer.js': { useHostPlayer: () => ({ currentSong: null, currentTime: 0, duration: 200 }) },
      './LyricsSettings.jsx': 'LyricsSettings',
      './api.js': { createLyricsWorkspaceApi: () => ({ completeDraftLyrics: async (_, body) => {
        aiRequests.push(body); return { data: { lines: [{ time: 1, text: 'こんにちは', tlyric: '你好' }], translationLanguage: 'zh' } };
      } }) },
      'lucide-react': {}, '../store/useUIStore.js': { useUIStore, showToast() {} },
    '../store/usePlayerStore.js': { usePlayerStore },
    './useManagedLyricsAsset.js': { useManagedLyricsAsset: () => managed },
    '../hooks/useCompactPlayerPlacement.js': { useCompactPlayerPlacement: () => ({ placement: 'bottom' }) },
    '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: { completeDraftLyrics: async (_, body) => {
      aiRequests.push(body); return { data: { lines: [{ time: 1, text: 'こんにちは', tlyric: '你好' }], translationLanguage: 'zh' } };
    } } },
    '../utils/lyricTimeline.js': {}, './LyricsCandidatePanel.jsx': 'LyricsCandidatePanel',
    '../utils/navigation.js': { formatPath: () => '/lyrics/s1', syncBrowserHistory() {}, returnToOriginRoute() {} },
    './lyrics/SyncedLyricText.jsx': 'SyncedLyricText', './playerbar/ProgressBar.jsx': 'ProgressBar',
    './PageBackButton.jsx': 'PageBackButton', './editor.js': editor,
    './previewScroll.js': {}, './timelineShift.js': shift, './workspace.css': {},
  };
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsPluginPage.jsx', import.meta.url)),
    exportName: 'LyricsWorkspaceContent', modules, globals: { window: { confirm: () => true, addEventListener() {}, removeEventListener() {} } } });
  const props = { host: { isCurrent: () => true, notify() {}, session: { get: () => auth }, beforeLeave: { register: () => () => {}, approve: () => true }, navigate() {}, returnToOrigin() {} }, context: { song, route: { songId: 's1' } } };
  const render = () => component.render(props);
  button(render(), '编辑歌词').props.onClick();
  let tree = render();
  const preview = nodes(tree).find(node => node.props.editing === true && Array.isArray(node.props.rows));
  assert.equal(preview.props.rows[0].translation, 'English translation', 'editing sees the saved layer even when playback targets Chinese');
  await button(tree, '保存').props.onClick(); await flushAsync();
  assert.equal(saves.at(-1)[3], 'en');
  nodes(render()).find(node => node.type === 'LyricsCandidatePanel').props.onImport({
    lyrics: { lines: [{ time: 1, text: 'こんにちは' }] }, translation: { language: 'en', lines: ['Imported English'] },
  });
  tree = render();
  await button(tree, '保存').props.onClick(); await flushAsync();
  assert.equal(saves.at(-1)[0][0].tlyric, 'Imported English');
  assert.equal(saves.at(-1)[3], 'en');
  button(render(), '编辑歌词').props.onClick(); tree = render();
  button(tree, 'AI 补全').props.onClick(); await flushAsync(); tree = render();
  assert.equal(aiRequests.at(-1).translationLanguage, 'en');
  button(tree, '保存').props.onClick(); await flushAsync();
  assert.equal(saves.at(-1)[0][0].tlyric, '你好');
  assert.equal(saves.at(-1)[3], 'zh');
  component.unmount();
});
