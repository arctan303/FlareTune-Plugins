import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, nodes, button, deferred, flushAsync } from '../../../tests/lyricCandidateHarness.js';
import * as editor from './editor.js';
import * as shift from './timelineShift.js';
import { workbenchMessage } from '../shared/messages.js';
import { createLyricsWorkspaceApi } from './api.js';

const prepared = (text = 'Imported', translation = 'Imported translation') => ({
  asset: { status: 'ready', original: { syncMode: 'line', lines: [{ time: 2, text }] },
    translation: { language: 'en', lines: [translation] } },
  lyrics: { syncMode: 'line', lines: [{ time: 2, text }] },
});
function fixture({ role = 'member', saveResult = true, prepare, complete, asset } = {}) {
  let song = { id: 'one', title: 'One', artist: 'Singer' }, section = 'current', guard, confirmResult = true;
  const saves = [], requests = [], notices = [], confirmations = [], legacyWrites = [], exits = [];
  const managed = { ...prepared('Saved', 'Saved translation'), etag: 'v1', aiCompletionEnabled: true,
    ...(asset ? { asset } : {}),
    // Reading may hide a different-language translation in the player projection.
    lyrics: { syncMode: 'line', lines: [{ time: 2, text: 'Saved', tlyric: 'Player-only translation' }] },
    load: async () => {}, saveDocument: async (...args) => { saves.push(args); return saveResult; } };
  for (const action of ['shiftTimeline', 'importLrc', 'restoreBackup', 'clearTranslation', 'reset', 'completeTranslation']) {
    managed[action] = async () => { legacyWrites.push(action); throw new Error(`Unexpected shared write: ${action}`); };
  }
  const api = {
    prepareLyricsDraft: async (songId, body) => {
      requests.push({ action: 'preview', songId, body });
      return prepare ? prepare(songId, body) : { data: body.asset ? { asset: body.asset } : prepared() };
    },
    completeDraftLyrics: async (songId, body) => {
      requests.push({ action: 'draft-ai', songId, body });
      return complete ? complete(songId, body) : { data: { lines: body.lines.map(line => ({ ...line, tlyric: 'AI translation' })),
        receipt: 'receipt', translationLanguage: 'zh' } };
    },
  };
  const host = { isCurrent: () => true, notify: value => notices.push(value),
    session: { get: () => ({ authenticated: true, user: { role } }) },
    beforeLeave: { register: callback => { guard = callback; return () => {}; }, approve: () => guard() },
    navigate: next => { section = next; }, returnToOrigin: path => exits.push(path) };
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsPluginPage.jsx', import.meta.url)),
    exportName: 'LyricsWorkspaceContent', modules: {
      '@flaretune/plugin-sdk': { t: x => x, useLocale: () => 'zh', lyricSourceLabel: x => x,
        SettingsInput: 'input', SettingsToggle: 'toggle', useSettingsReadOnly: () => false,
        SyncedLyricText: 'synced', ProgressBar: 'progress', PageBackButton: 'back' },
      'lucide-react': {}, './workspace.css': {}, './LyricsSettings.jsx': 'settings', './LyricsCandidatePanel.jsx': 'candidates',
      './useHostPlayer.js': { useHostPlayer: () => ({ currentSong: null, currentTime: 0, duration: 100 }) },
      './useManagedLyricsAsset.js': { useManagedLyricsAsset: () => managed },
      './api.js': { createLyricsWorkspaceApi: () => api }, './editor.js': editor,
      './timelineShift.js': shift, './previewScroll.js': {}, '../shared/messages.js': { workbenchMessage },
    }, globals: { window: { confirm: message => { confirmations.push(message); return confirmResult; },
      addEventListener() {}, removeEventListener() {} } } });
  const render = () => component.render({ host, pageId: section, context: { song, route: { songId: song.id } } });
  return { component, managed, saves, requests, notices, confirmations, legacyWrites, exits, render,
    page: value => { section = value; return render(); },
    song: value => { song = { ...song, id: value }; return render(); },
    confirm: value => { confirmResult = value; }, canLeave: () => guard(),
    importCandidate: value => nodes(render()).find(node => node.type === 'candidates').props.onImport(value),
    async importFile(kind, value) {
      const tree = this.page('tools');
      const input = nodes(tree).find(node => node.type === 'input' && node.props['aria-label'] === (kind === 'lrc' ? '导入 LRC 文件' : '导入歌词备份'));
      input.props.onChange({ target: { files: [{ size: 100, text: async () => kind === 'lrc' ? value : JSON.stringify(value) }], value: 'fixture' } });
      await flushAsync();
      return render();
    },
  };
}
const preview = tree => nodes(tree).find(node => node.props.editing && Array.isArray(node.props.rows));
const rail = tree => nodes(tree).find(node => typeof node.props.onChange === 'function' && 'value' in node.props && 'saving' in node.props);

for (const role of ['member', 'admin']) {
  test(`${role} combines candidate, time, text, translation and clear tools in one shared save`, async () => {
    const f = fixture({ role });
    assert.ok(button(f.render(), '编辑歌词'));
    f.importCandidate(prepared('Candidate', 'Candidate translation'));
    let tree = f.render();
    preview(tree).props.onPatch('0', { text: 'Corrected', time: '00:03.000' }); tree = f.render();
    rail(tree).props.onChange(150); tree = f.page('tools');
    button(tree, '清除译文').props.onClick(); tree = f.page('candidates');
    assert.ok(button(tree, '保存'), 'the single save remains reachable on every same-song page');
    tree = f.page('current');
    assert.equal(preview(tree).props.rows[0].text, 'Corrected');
    assert.equal(preview(tree).props.rows[0].translation, '');
    preview(tree).props.onPatch('0', { translation: 'Final translation' }); tree = f.render();
    assert.equal(f.saves.length, 0); assert.deepEqual(f.legacyWrites, []);
    assert.equal(f.confirmations.length, 0, 'combining tools never asks to save or discard first');
    button(tree, '保存').props.onClick(); await flushAsync();
    assert.equal(f.saves.length, 1); assert.equal(f.saves[0][0][0].text, 'Corrected');
    assert.equal(f.saves[0][0][0].time, 3.15); assert.equal(f.saves[0][0][0].tlyric, 'Final translation');
    assert.equal(f.saves[0][1], 'v1'); assert.equal(preview(f.render()), undefined);
    f.component.unmount();
  });
}

test('a timing adjustment starts the same editable draft and does not apply a shared mutation', async () => {
  const f = fixture(); rail(f.render()).props.onChange(current => current + 50);
  let tree = f.render(); assert.equal(rail(tree).props.value, 50); assert.ok(preview(tree));
  preview(tree).props.onPatch('0', { text: 'Edited after timing' }); tree = f.render();
  await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][0][0].time, 2.05); assert.equal(f.saves[0][0][0].text, 'Edited after timing');
  assert.deepEqual(f.legacyWrites, []); f.component.unmount();
});

test('LRC preview replaces the draft and its pending shift while retaining the original conflict baseline', async () => {
  const f = fixture(); button(f.render(), '编辑歌词').props.onClick();
  rail(f.render()).props.onChange(100); f.render(); f.managed.etag = 'v2';
  await f.importFile('lrc', '[00:02]Imported');
  let tree = f.render(); assert.equal(f.requests[0].action, 'preview');
  assert.equal(JSON.stringify(f.requests[0].body), JSON.stringify({ lrc: '[00:02]Imported' }));
  assert.equal(preview(tree).props.rows[0].text, 'Imported');
  assert.equal(preview(tree).props.rows[0].translation, 'Imported translation');
  assert.equal(rail(tree).props.value, 0); assert.equal(f.saves.length, 0);
  await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][1], 'v1'); assert.equal(f.saves[0][0][0].time, 2);
  assert.deepEqual(f.legacyWrites, []); assert.equal(f.confirmations.length, 0); f.component.unmount();
});

test('backup preview retains the original asset metadata and applies subsequent edits at save', async () => {
  const asset = { ...prepared('Restored', 'Restored translation').asset, offsetMs: 375,
    original: { ...prepared('Restored').asset.original, source: 'backup-source' } };
  const before = JSON.stringify(asset), f = fixture();
  rail(f.render()).props.onChange(250); f.render();
  await f.importFile('asset', asset); let tree = f.render();
  assert.equal(JSON.stringify(f.requests[0].body), JSON.stringify({ asset })); assert.equal(f.saves.length, 0);
  assert.equal(rail(tree).props.value, 0, 'the backup offset must not inherit the replaced draft delta');
  preview(tree).props.onPatch('0', { text: 'Corrected restore', translation: 'Corrected translation' });
  tree = f.render(); rail(tree).props.onChange(-100); tree = f.render();
  await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][0][0].text, 'Corrected restore'); assert.equal(f.saves[0][0][0].time, 1.9);
  assert.equal(f.saves[0][0][0].tlyric, 'Corrected translation'); assert.equal(f.saves[0][3], 'en');
  assert.equal(JSON.stringify(f.saves[0][4].restoreAsset), before); assert.equal(JSON.stringify(asset), before);
  assert.deepEqual(f.legacyWrites, []); f.component.unmount();
});

test('replacing a candidate discards the old content timing delta but accepts a new adjustment', async () => {
  const f=fixture();rail(f.render()).props.onChange(450);f.render();
  f.importCandidate(prepared('Replacement'));let tree=f.render();assert.equal(rail(tree).props.value,0);
  rail(tree).props.onChange(50);tree=f.render();button(tree,'保存').props.onClick();await flushAsync();
  assert.equal(f.saves[0][0][0].text,'Replacement');assert.equal(f.saves[0][0][0].time,2.05);
  assert.equal(f.saves[0][1],'v1');f.component.unmount();
});

test('reset stays local until save and can be followed by fresh row edits', async () => {
  const f = fixture(); button(f.page('tools'), '重置歌词').props.onClick();
  let tree = f.page('current'); assert.equal(preview(tree).props.rows.length, 0); assert.equal(f.saves.length, 0);
  preview(tree).props.onInsert(undefined, 'new-one'); tree = f.render();
  preview(tree).props.onPatch('new-one', { text: 'New document', translation: 'New translation' }); tree = f.render();
  await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][4].reset, false); assert.equal(f.saves[0][0][0].text, 'New document');
  button(f.page('tools'), '重置歌词').props.onClick(); tree = f.render();
  await button(tree, '保存').props.onClick(); assert.equal(f.saves[1][0].length, 0); assert.equal(f.saves[1][4].reset, true);
  assert.deepEqual(f.legacyWrites, []); assert.equal(f.confirmations.length, 0); f.component.unmount();
});

for (const result of [false, 'conflict']) {
  test(`${String(result)} save preserves rows, shift, backup intent and the initial etag`, async () => {
    const f = fixture({ saveResult: result }); await f.importFile('asset', prepared('Backup').asset);
    let tree = f.render(); preview(tree).props.onPatch('0', { text: 'Unsaved' });
    tree = f.render(); rail(tree).props.onChange(250); tree = f.render();
    await button(tree, '保存').props.onClick(); f.managed.etag = 'latest-after-read'; tree = f.render();
    assert.equal(preview(tree).props.rows[0].text, 'Unsaved'); assert.equal(rail(tree).props.value, 250);
    assert.ok(button(tree, '保存')); assert.ok(button(tree, '取消'));
    await button(tree, '保存').props.onClick();
    assert.equal(f.saves[1][1], 'v1'); assert.equal(f.saves[1][0][0].time, 2.25);
    assert.equal(f.saves[1][4].restoreAsset.original.lines[0].text, 'Backup');
    f.component.unmount();
  });
}

test('non-editing AI redo stages its result and subsequent manual edits in the same draft', async () => {
  const f = fixture(); button(f.render(), 'AI 补全').props.onClick(); await flushAsync();
  let tree = f.render(); assert.ok(preview(tree)); assert.equal(f.requests[0].action, 'draft-ai');
  assert.equal(f.requests[0].body.lines[0].tlyric, 'Saved translation', 'AI receives the actual saved translation layer');
  assert.equal(f.saves.length, 0); assert.equal(preview(tree).props.rows[0].translation, 'AI translation');
  preview(tree).props.onPatch('0', { translation: 'Manually corrected AI' }); tree = f.render();
  await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][0][0].tlyric, 'Manually corrected AI'); assert.equal(f.saves[0][2], 'receipt');
  assert.equal(f.saves[0][3], 'zh'); assert.deepEqual(f.legacyWrites, []); f.component.unmount();
});

test('conflict on manual edits keeps the editor open with the edited rows', async () => {
  const f = fixture({ role: 'admin', saveResult: 'conflict' });
  button(f.render(), '编辑歌词').props.onClick();
  preview(f.render()).props.onPatch('0', { text: 'Keep conflict draft' });
  button(f.render(), '保存').props.onClick(); await flushAsync();
  assert.ok(preview(f.render()), 'a conflict must not close the editor');
  assert.equal(preview(f.render()).props.rows[0].text, 'Keep conflict draft');
  assert.equal(f.saves[0][1], 'v1'); f.component.unmount();
});

test('continuous row insertion and deletion preserve untouched word timing and exact time values', async () => {
  const word = { time: 1.0004, text: 'Word', endTime: 1.9999,
    words: [{ text: 'Word', startTime: 1.0004, endTime: 1.9999 }] };
  const asset = { status: 'ready', original: { syncMode: 'word', lines: [word] }, translation: { language: 'en', lines: ['Original'] } };
  const f = fixture({ asset }); button(f.render(), '编辑歌词').props.onClick();
  let tree = f.render(); preview(tree).props.onInsert('0', 'new-temporary'); tree = f.render();
  preview(tree).props.onPatch('new-temporary', { time: '00:02.000', text: 'Temporary' }); tree = f.render();
  preview(tree).props.onDelete('new-temporary'); tree = f.render();
  preview(tree).props.onPatch('0', { translation: 'Corrected translation' }); tree = f.render();
  button(tree, '保存').props.onClick(); await flushAsync();
  assert.equal(f.saves[0][0].length, 1); assert.equal(f.saves[0][0][0].time, 1.0004);
  assert.equal(f.saves[0][0][0].endTime, 1.9999); assert.equal(f.saves[0][0][0].words, word.words);
  assert.equal(f.saves[0][0][0].tlyric, 'Corrected translation');
  assert.equal(JSON.stringify(asset.original.lines[0]), JSON.stringify(word)); f.component.unmount();
});

test('AI finishing after newer manual edits cannot replace those edits', async () => {
  const pending = deferred(), f = fixture({ complete: () => pending.promise });
  button(f.render(), 'AI 补全').props.onClick(); let tree = f.render();
  preview(tree).props.onPatch('0', { text: 'Newer edit' }); f.render();
  pending.resolve({ data: { lines: [{ text: 'Late AI' }], receipt: 'late' } }); await flushAsync();
  tree = f.render(); assert.equal(preview(tree).props.rows[0].text, 'Newer edit');
  await button(tree, '保存').props.onClick(); assert.equal(f.saves[0][2], null); f.component.unmount();
});

test('cancel can discard a pending AI draft and its late result cannot reopen it', async () => {
  const pending = deferred(), f = fixture({ complete: () => pending.promise });
  button(f.render(), 'AI 补全').props.onClick(); let tree = f.render();
  assert.ok(!button(tree, '取消').props.disabled); button(tree, '取消').props.onClick(); f.render();
  pending.resolve({ data: { lines: [{ text: 'Late AI' }], receipt: 'late' } }); await flushAsync();
  assert.equal(preview(f.render()), undefined); assert.equal(f.saves.length, 0); f.component.unmount();
});

test('late preview cannot overwrite a newer edit or the next song', async () => {
  const pending = deferred(), f = fixture({ prepare: () => pending.promise });
  button(f.render(), '编辑歌词').props.onClick(); f.render();
  await f.importFile('lrc', 'pending'); let tree = f.page('current');
  preview(tree).props.onPatch('0', { text: 'Keep newest edit' }); f.render();
  pending.resolve({ data: prepared('Too late') }); await flushAsync();
  assert.equal(preview(f.render()).props.rows[0].text, 'Keep newest edit');
  assert.equal(f.notices.at(-1), '导入期间草稿已修改，保留当前修改；需要时可重新导入');
  const next = deferred(); f.component.unmount();
  const g = fixture({ prepare: () => next.promise }); await g.importFile('lrc', 'pending'); g.song('two');
  next.resolve({ data: prepared('Previous song') }); await flushAsync();
  assert.equal(preview(g.render()), undefined); assert.equal(g.saves.length, 0); g.component.unmount();
});

test('failed file preview retains the current draft and permits continued editing', async () => {
  const f = fixture({ prepare: async () => { throw new Error('Invalid fixture'); } });
  f.importCandidate(prepared('Keep candidate')); f.render(); await f.importFile('lrc', 'invalid');
  let tree = f.page('current'); assert.equal(preview(tree).props.rows[0].text, 'Keep candidate');
  assert.equal(f.notices.at(-1), 'Invalid fixture'); assert.equal(button(tree, '保存').props.disabled, false);
  preview(tree).props.onPatch('0', { text: 'Repair' }); tree = f.render(); await button(tree, '保存').props.onClick();
  assert.equal(f.saves[0][0][0].text, 'Repair'); f.component.unmount();
});

test('same-song pages preserve the draft and a declined true-leave or cancel keeps it intact', () => {
  const f = fixture(); f.importCandidate(prepared('Keep draft')); f.render();
  f.confirm(false); f.page('tools'); f.page('candidates'); let tree = f.page('current');
  assert.equal(f.confirmations.length, 0); assert.equal(preview(tree).props.rows[0].text, 'Keep draft');
  nodes(tree).find(node => node.type === 'back').props.onClick();
  assert.equal(f.exits.length, 0); assert.equal(f.confirmations.length, 1);
  button(f.render(), '取消').props.onClick(); assert.equal(preview(f.render()).props.rows[0].text, 'Keep draft');
  f.confirm(true); button(f.render(), '取消').props.onClick(); assert.equal(preview(f.render()), undefined);
  assert.equal(f.saves.length, 0); f.component.unmount();
});

test('workspace API forwards member preview and final draft intent while rejecting non-editing roles', async () => {
  const calls = []; let role = 'member';
  const host = { isCurrent: () => true, session: { get: () => ({ user: { role } }) },
    features: { isAvailable: () => true }, request: async (...args) => { calls.push(args); return { data: {} }; } };
  const api = createLyricsWorkspaceApi(host), asset = prepared().asset;
  await api.prepareLyricsDraft('one', { lrc: 'literal LRC' });
  await api.prepareLyricsDraft('one', { asset });
  await api.saveLyricsDocument('one', { lines: [], etag: 'v1', restoreAsset: asset, reset: true });
  await api.completeDraftLyrics('one', { lines: [{ text: 'Hello' }], etag: 'v1' });
  assert.equal(calls[0][0], 'workspace/one/preview'); assert.deepEqual(calls[0][1].body, { lrc: 'literal LRC' });
  assert.deepEqual(calls[1][1].body, { asset });
  assert.deepEqual(calls[2][1].body, { lines: [], etag: 'v1', restoreAsset: asset, reset: true });
  assert.equal(calls[3][0], 'workspace/one/draft-ai');
  role = 'visitor'; await assert.rejects(api.prepareLyricsDraft('one', { lrc: 'Blocked' }), error => error.code === 'FORBIDDEN');
  assert.equal(calls.length, 4);
});
