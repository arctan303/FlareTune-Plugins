import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.action, ...(tree.props?.children || [])].flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
const edit = tree => nodes(tree).find(node => node.type === 'button' && text(node) === '编辑');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const value = { provider: 'deepseek', model: 'legacy-model', temperature: 0.2, styleRules: 'Keep timing', targetLanguage: 'zh',
  completionEnabled: true, automaticCompletionEnabled: true, cleanDirtyLyrics: true, translateLyrics: true,
  detectLanguage: true, referenceExistingTranslation: false };
function fixture() {
  const calls = [], notices = []; let active = true; let save;
  const host = { isCurrent: () => active, notify: text => notices.push(text), request: async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'PUT') return save ? save.promise : { setting: { value: init.body.value, revision: 8 } };
    return path === 'settings' ? { setting: { value, revision: 7 }, defaults: { styleRules: 'Default rules' } }
      : { setting: { value: { version: 2, sources: [] }, revision: 3 } };
  } };
  const view = createBackgroundModuleHarness({ file: new URL('./LyricsSettings.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { t: key => key, SettingsSection: 'section', SettingsEditDialog: 'dialog', ServiceModelSettings: 'model-settings', SettingsActions: 'actions', SettingsButton: 'button',
      SettingsToggle: 'toggle', SettingsInput: 'input', SettingsTextarea: 'textarea', SelectControl: 'select', InfoTip: 'tip',
      ALL_LANGUAGES: [{ code: 'zh', label: '中文' }, { code: 'en', label: '英语' }] }, './LyricSourcesSettings.jsx': 'sources',
  }, globals: {} });
  return { ...view, calls, notices, host, retire() { active = false; }, delaySave() { save = deferred(); return save; },
    renderSettings() { return view.render({ host }); } };
}

test('lyrics configuration preserves legacy fields and sends the loaded revision when an administrator changes a switch', async () => {
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync(); let tree = f.renderSettings();
  assert.equal(nodes(tree).some(node => node.type === 'form'),false);
  assert.match(text(tree),/歌词 AI 已开启/);
  edit(tree).props.onClick(); tree=f.renderSettings();
  const toggles = nodes(tree).filter(node => node.type === 'toggle'); assert.equal(toggles.length, 6);
  toggles[1].props.onChange({ target: { checked: false } }); tree = f.renderSettings();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await flushBackgroundAsync();
  const saved = f.calls.find(call => call.init?.method === 'PUT');
  assert.equal(saved.init.body.expectedRevision, 7); assert.equal(saved.init.body.value.model, 'legacy-model');
  assert.equal(saved.init.body.value.styleRules, 'Keep timing'); assert.equal(saved.init.body.value.automaticCompletionEnabled, false);
  assert.deepEqual(f.notices, ['设置已成功保存。']);
  assert.ok(nodes(f.renderSettings()).some(node => node.type === 'sources'));
  f.unmount();
});

test('configuration saves do not notify after plugin retirement and duplicate clicks produce one write', async () => {
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync(); edit(f.renderSettings()).props.onClick(); const tree = f.renderSettings(); const waiting = f.delaySave();
  const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.init?.method === 'PUT').length, 1);
  f.retire(); waiting.resolve({ setting: { value, revision: 8 } }); await first; await flushBackgroundAsync();
  assert.deepEqual(f.notices, []); f.unmount();
});

test('lyric policy cancels an isolated draft without saving and reopens the current stored values', async () => {
  const f=fixture();f.renderSettings();await flushBackgroundAsync();edit(f.renderSettings()).props.onClick();let tree=f.renderSettings();
  nodes(tree).find(node=>node.type==='select').props.onChange({target:{value:'en'}});
  nodes(tree).find(node=>node.type==='textarea').props.onChange({target:{value:'Discarded draft'}});tree=f.renderSettings();
  assert.equal(nodes(tree).find(node=>node.type==='button'&&text(node)==='取消').props.closeDialog,true);
  nodes(tree).find(node=>node.type==='dialog').props.onClose();tree=f.renderSettings();
  assert.equal(nodes(tree).some(node=>node.type==='form'),false);
  assert.equal(f.calls.some(call=>call.init?.method==='PUT'),false);
  edit(tree).props.onClick();tree=f.renderSettings();
  assert.equal(nodes(tree).find(node=>node.type==='select').props.value,'zh');
  assert.equal(nodes(tree).find(node=>node.type==='textarea').props.value,'Keep timing');f.unmount();
});

test('the lyric policy summary changes only after the save response succeeds', async () => {
  const f=fixture();f.renderSettings();await flushBackgroundAsync();edit(f.renderSettings()).props.onClick();let tree=f.renderSettings();
  nodes(tree).find(node=>node.type==='select').props.onChange({target:{value:'en'}});tree=f.renderSettings();
  const waiting=f.delaySave(),write=nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}});
  assert.match(text(f.renderSettings()),/中文/);waiting.resolve({setting:{value:{...value,targetLanguage:'en'},revision:8}});await write;await flushBackgroundAsync();
  tree=f.renderSettings();assert.equal(nodes(tree).some(node=>node.type==='dialog'),false);assert.match(text(tree),/英语/);f.unmount();
});
