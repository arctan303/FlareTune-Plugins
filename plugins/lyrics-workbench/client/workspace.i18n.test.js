import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes, text, button, flushAsync } from '../../../tests/lyricCandidateHarness.js';
import * as editor from './editor.js';
import * as shift from './timelineShift.js';

const dictionary = {
  '逐字': 'Word timing', '逐行': 'Line timing', '未位移': 'No shift',
  '请填写歌词': 'Enter lyrics', '请填写时间': 'Enter a time',
  '应不晚于下一行 {p0}': 'Must not be later than {p0}',
  '歌词有未保存的修改或位移草稿，确定放弃吗？': 'Discard unsaved lyric edits and timing shifts?',
  '有 {count} 行修改了逐字内容，保存后这些行会改为逐行同步。继续吗？': '{count} edited lines will use line timing after saving. Continue?',
  '导入会替换当前共享歌词。继续吗？': 'Importing will replace the shared lyrics. Continue?',
  '恢复备份会替换这首歌当前使用的共享歌词。继续吗？': 'Restoring will replace this song’s shared lyrics. Continue?',
  '读取当前歌词文件失败': 'Could not load lyrics',
  '重试': 'Retry',
};
const interpolate = (key, values) => key.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? `{${name}}`));
const translate = (key, values) => interpolate(dictionary[key] || key, values);

function setup({ managed: overrides = {}, section = 'current', translator = translate, exportName = 'LyricsWorkspaceContent' } = {}) {
  const song = { id: 's1', title: 'Song', artist: 'Artist' }, confirmations = [], saves = [], loads = [];
  const ui = { lyricsWorkspaceSong: song, authSession: { authenticated: true, user: { role: 'admin' } },
    setLyricsWorkspaceBeforeCloseGuard() {}, approveLyricsWorkspaceExit: () => true };
  const useUIStore = selector => selector(ui); useUIStore.getState = () => ui;
  const usePlayerStore = selector => selector({ currentSong: null, currentTime: 0, duration: 200 });
  const managed = { asset: { status: 'ready', original: { syncMode: 'line' } },
    lyrics: { syncMode: 'line', lines: [{ time: 1, text: 'Hello' }] }, etag: 'e1',
    saveDocument: async (...args) => { saves.push(args); return true; },
    importLrc: async () => true, restoreBackup: async () => true, load: async () => { loads.push('read'); }, ...overrides };
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsPluginPage.jsx', import.meta.url)), exportName,
    modules: {
      '../../../shared/lyricSources.js': { lyricSourceLabel: x => x }, '@flaretune/plugin-sdk/client/i18n': { t: translator },
      './SettingsReadOnly.jsx': { SettingsInput: 'input', useSettingsReadOnly: () => false },
      '@flaretune/plugin-sdk': { t: translator, lyricSourceLabel: x => x, SettingsInput: 'input', useSettingsReadOnly: () => false,
        SyncedLyricText: 'SyncedLyricText', ProgressBar: 'ProgressBar', PageBackButton: 'PageBackButton' },
      './useHostPlayer.js': { useHostPlayer: () => ({ currentSong: null, currentTime: 0, duration: 200 }) },
      './LyricsSettings.jsx': 'LyricsSettings',
      './api.js': { createLyricsWorkspaceApi: () => ({ completeDraftLyrics: async (_, body) => {
        return {data:{}};
      } }) },
      'lucide-react': {}, '../store/useUIStore.js': { useUIStore, showToast() {} },
      '../store/usePlayerStore.js': { usePlayerStore },
      './useManagedLyricsAsset.js': { useManagedLyricsAsset: () => managed },
      '../hooks/useCompactPlayerPlacement.js': { useCompactPlayerPlacement: () => ({ placement: 'bottom' }) },
      '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: {} },
      '../utils/lyricTimeline.js': {}, './LyricsCandidatePanel.jsx': 'LyricsCandidatePanel',
      '../utils/navigation.js': { formatPath: () => '/lyrics/s1', syncBrowserHistory() {}, returnToOriginRoute() {} },
      './lyrics/SyncedLyricText.jsx': 'SyncedLyricText', './playerbar/ProgressBar.jsx': 'ProgressBar',
      './PageBackButton.jsx': 'PageBackButton', './editor.js': editor,
      './previewScroll.js': {}, './timelineShift.js': shift, './workspace.css': {},
    }, globals: { window: { confirm: message => { confirmations.push(message); return false; },
      addEventListener() {}, removeEventListener() {} } } });
  const props = { host: { isCurrent: () => true, notify() {}, session: { get: () => ui.authSession }, beforeLeave: { register: () => () => {}, approve: () => true }, navigate() {}, returnToOrigin() {} }, pageId: section, context: { song, route: { songId: 's1', section } } };
  return { component, confirmations, saves, loads, render: () => component.render(props) };
}

test('workspace confirms unsaved edits and timing conversion using complete translated messages', async () => {
  const s = setup({ managed: { lyrics: { syncMode: 'word', lines: [
    { time: 1, text: 'Hello', words: [{ text: 'Hello', startTime: 1, endTime: 2 }] },
  ] } } });
  button(s.render(), '编辑歌词').props.onClick();
  let tree = s.render();
  const preview = nodes(tree).find(node => node.props.editing === true && Array.isArray(node.props.rows));
  preview.props.onPatch('0', { text: 'Edited' });
  tree = s.render();
  button(tree, '取消').props.onClick();
  assert.equal(s.confirmations.at(-1), 'Discard unsaved lyric edits and timing shifts?');
  await button(tree, '保存').props.onClick(); await flushAsync();
  assert.equal(s.confirmations.at(-1), '1 edited lines will use line timing after saving. Continue?');
  assert.equal(s.saves.length, 0, 'declining confirmation preserves the existing shared lyrics');
  s.component.unmount();
});

test('import and restore confirmations use translated sentences', async () => {
  const s = setup({ section: 'tools' });
  const inputs = nodes(s.render()).filter(node => node.type === 'input' && node.props.type === 'file');
  await inputs[0].props.onChange({ target: { files: [{ size: 20, text: async () => '[00:01]Hello' }], value: 'lyrics.lrc' } });
  await flushAsync();
  assert.equal(s.confirmations.at(-1), 'Importing will replace the shared lyrics. Continue?');
  await inputs[1].props.onChange({ target: { files: [{ size: 20, text: async () => '{}' }], value: 'lyrics.json' } });
  await flushAsync();
  assert.equal(s.confirmations.at(-1), 'Restoring will replace this song’s shared lyrics. Continue?');
  s.component.unmount();
});

test('workspace localizes the saved sync mode and managed errors with a working translated retry', async () => {
  const s = setup({ managed: { error: '读取当前歌词文件失败' } });
  const tree = s.render();
  const alert = nodes(tree).find(node => node.props.role === 'alert');
  assert.equal(text(nodes(alert).find(node => node.type === 'p')), 'Could not load lyrics');
  const retry = button(alert, 'Retry');
  assert.ok(retry, 'the recovery action uses the selected UI language');
  await retry.props.onClick(); await flushAsync();
  assert.deepEqual(s.loads, ['read'], 'retry re-reads the current lyric asset');
  assert.equal(text(nodes(tree).find(node => node.props.className === 'lyric-studio__formats')).includes('Line timing'), true);
  s.component.unmount();
});

test('cached row errors translate at display time after a language change', () => {
  let language = 'en';
  const translator = (key, values) => language === 'en' ? translate(key, values)
    : interpolate({ '请填写歌词': '歌詞を入力してください', '应不晚于下一行 {p0}': '{p0} 以前にしてください' }[key] || key, values);
  const s = setup({ exportName: 'Preview', translator });
  const rows = [
    { key: 'a', time: '00:20.000', text: '', translation: '' },
    { key: 'b', time: '00:10.000', text: 'Hello', translation: '' },
  ];
  const props = { editing: true, rows, errors: editor.validateLyricRows(rows) };
  const alerts = () => nodes(s.component.render(props)).filter(node => node.props.role === 'alert').map(text);
  assert.ok(alerts().includes('Enter lyrics'));
  assert.ok(alerts().includes('Must not be later than 00:10.000'));
  language = 'ja';
  assert.ok(alerts().includes('歌詞を入力してください'));
  assert.ok(alerts().includes('00:10.000 以前にしてください'));
  s.component.unmount();
});
