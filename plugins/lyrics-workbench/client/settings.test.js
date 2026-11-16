import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...[tree.props?.action,...(tree.props?.children || [])].flat(Infinity).flatMap(nodes)] : [];
const text=node=>typeof node==='string'?node:(node?.props?.children||[]).flat(Infinity).map(text).join('');
const open=tree=>nodes(tree).find(n=>n.type==='button'&&text(n)==='编辑').props.onClick();
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const value = { provider: 'deepseek', model: 'legacy-model', temperature: 0.2, styleRules: 'Keep timing', targetLanguage: 'zh',
  completionEnabled: true, automaticCompletionEnabled: true, cleanDirtyLyrics: true, translateLyrics: true,
  detectLanguage: true, referenceExistingTranslation: false };
function fixture(locale = 'zh', overrides = {}) {
  const storedValue = { ...value, ...overrides };
  const calls = [], notices = []; let active = true; let save;
  const host = { isCurrent: () => active, notify: text => notices.push(text), request: async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'PUT') return save ? save.promise : { setting: { value: init.body.value, revision: 8 } };
    return path === 'settings' ? { setting: { value: storedValue, revision: 7 }, defaults: { styleRules: 'Default rules' } }
      : { setting: { value: { version: 2, sources: [] }, revision: 3 } };
  } };
  const view = createBackgroundModuleHarness({ file: new URL('./LyricsSettings.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { t: key => key, useLocale: () => locale, SettingsSection: 'section', SettingsActions: 'actions', SettingsButton: 'button',
      SettingsToggle: 'toggle', SettingsInput: 'input', SettingsTextarea: 'textarea', SelectControl: 'select', InfoTip: 'tip', ServiceModelSettings: 'model-settings', SettingsEditDialog:'dialog',
      ALL_LANGUAGES: [{ code: 'zh', label: '中文' }, { code: 'en', label: '英语' }] }, './LyricSourcesSettings.jsx': 'sources',
  }, globals: {} });
  return { ...view, calls, notices, host, retire() { active = false; }, delaySave() { save = deferred(); return save; },
    renderSettings() { return view.render({ host }); } };
}

test('one lyric AI switch saves both compatibility flags and preserves model, policy and revision', async () => {
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync(); let tree = f.renderSettings();
  assert.equal(nodes(tree).filter(node => node.type === 'model-settings').length,1);
  assert.equal(nodes(tree).some(node=>node.type==='form'),false);open(tree);tree=f.renderSettings();
  const toggles = nodes(tree).filter(node => node.type === 'toggle'); assert.equal(toggles.length, 2);
  assert.equal(nodes(tree).some(node => node.type === 'select' && node.props['aria-label'] === '歌词 AI'), false);
  toggles.find(node => node.props.label === '歌词 AI').props.onChange({ target: { checked: false } }); tree = f.renderSettings();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  await flushBackgroundAsync();
  const saved = f.calls.find(call => call.init?.method === 'PUT');
  assert.equal(saved.init.body.expectedRevision, 7); assert.equal(saved.init.body.value.model, 'legacy-model');
  assert.equal(saved.init.body.value.styleRules, 'Keep timing'); assert.equal(saved.init.body.value.automaticCompletionEnabled, false);
  assert.equal(saved.init.body.value.completionEnabled, false); assert.equal(saved.init.body.value.targetLanguage, 'zh');
  assert.equal(saved.init.body.value.detectLanguage, true); assert.equal(saved.init.body.value.cleanDirtyLyrics, true);
  assert.deepEqual(f.notices, ['设置已成功保存。']);
  assert.ok(nodes(f.renderSettings()).some(node => node.type === 'sources'));
  f.unmount();
});

test('configuration saves do not notify after plugin retirement and duplicate clicks produce one write', async () => {
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync();open(f.renderSettings()); const tree = f.renderSettings(); const waiting = f.delaySave();
  const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.init?.method === 'PUT').length, 1);
  f.retire(); waiting.resolve({ setting: { value, revision: 8 } }); await first; await flushBackgroundAsync();
  assert.deepEqual(f.notices, []); f.unmount();
});

test('new policy labels come from the package messages in each supported locale', async () => {
  for (const [locale, aiLabel, preferenceLabel] of [
    ['zh','歌词 AI','歌词偏好'], ['zh-Hant','歌詞 AI','歌詞偏好'],
    ['en','Lyrics AI','Lyric preference'], ['ja','歌詞 AI','歌詞の優先設定'], ['ko','가사 AI','가사 기본 설정'],
  ]) {
    const f = fixture(locale); f.renderSettings(); await flushBackgroundAsync();open(f.renderSettings()); const tree = f.renderSettings();
    assert.ok(nodes(tree).some(node => node.type === 'toggle' && node.props.label === aiLabel), locale);
    assert.equal(nodes(tree).filter(node => node.type === 'model-settings').length, 1);
    assert.equal(nodes(tree).some(node => node.type === 'option' && ['manual', 'auto', 'off'].includes(node.props.value)), false);
    assert.ok(nodes(tree).some(node => node.type === 'select' && node.props['aria-label'] === preferenceLabel), locale);
    f.unmount();
  }
});

test('Traditional Chinese can be explicitly selected without changing a saved target just by viewing another UI language', async () => {
  const f=fixture('en'); f.renderSettings(); await flushBackgroundAsync();open(f.renderSettings()); let tree=f.renderSettings();
  const target=nodes(tree).find(node=>node.type==='select' && node.props['aria-label']==='目标译文语言');
  assert.equal(target.props.value,'zh');
  assert.ok(nodes(tree).some(node=>node.type==='option' && node.props.value==='zh-Hant'));
  target.props.onChange({target:{value:'zh-Hant'}}); tree=f.renderSettings();
  await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}}); await flushBackgroundAsync();
  const saved=f.calls.find(call=>call.init?.method==='PUT'); assert.equal(saved.init.body.value.targetLanguage,'zh-Hant');
  assert.equal(saved.init.body.value.model,'legacy-model'); f.unmount();
});

test('four-policy editor cancels drafts and keeps source online gating based on saved settings',async()=>{
  const f=fixture();f.renderSettings();await flushBackgroundAsync();let tree=f.renderSettings();
  assert.equal(nodes(tree).find(n=>n.type==='sources').props.onlineEnabled,true);open(tree);tree=f.renderSettings();
  nodes(tree).find(n=>n.type==='toggle').props.onChange({target:{checked:false}});
  nodes(tree).find(n=>n.type==='toggle'&&n.props.label==='歌词 AI').props.onChange({target:{checked:false}});tree=f.renderSettings();
  assert.equal(nodes(tree).find(n=>n.type==='sources').props.onlineEnabled,true);
  assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)==='取消').props.closeDialog,true);
  nodes(tree).find(n=>n.type==='dialog').props.onClose();tree=f.renderSettings();
  assert.equal(f.calls.some(c=>c.init?.method==='PUT'),false);assert.equal(nodes(tree).some(n=>n.type==='form'),false);
  open(tree);tree=f.renderSettings();assert.equal(nodes(tree).find(n=>n.type==='toggle').props.checked,true);
  assert.equal(nodes(tree).find(n=>n.type==='toggle'&&n.props.label==='歌词 AI').props.checked,true);f.unmount();
});

test('old manual preference becomes one enabled AI switch without writing until explicit save', async () => {
  const f = fixture('zh', { automaticCompletionEnabled: false }); f.renderSettings(); await flushBackgroundAsync();
  let tree = f.renderSettings(); assert.equal(f.calls.some(call => call.init?.method === 'PUT'), false);
  open(tree); tree = f.renderSettings();
  assert.equal(nodes(tree).find(node => node.type === 'toggle' && node.props.label === '歌词 AI').props.checked, true);
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flushBackgroundAsync();
  const saved = f.calls.find(call => call.init?.method === 'PUT').init.body.value;
  assert.equal(saved.completionEnabled, true); assert.equal(saved.automaticCompletionEnabled, true);
  assert.equal(saved.model, 'legacy-model'); f.unmount();
});

test('legacy translation-off stays off until the user explicitly enables the one AI switch', async () => {
  const f = fixture('zh', { translateLyrics: false }); f.renderSettings(); await flushBackgroundAsync(); open(f.renderSettings());
  let tree = f.renderSettings(); const toggle = nodes(tree).find(node => node.type === 'toggle' && node.props.label === '歌词 AI');
  assert.equal(toggle.props.checked, false); toggle.props.onChange({ target: { checked: true } }); tree = f.renderSettings();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await flushBackgroundAsync();
  const saved = f.calls.find(call => call.init?.method === 'PUT').init.body.value;
  assert.equal(saved.translateLyrics, true); assert.equal(saved.completionEnabled, true); assert.equal(saved.automaticCompletionEnabled, true);
  f.unmount();
});
