import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const value = { provider: 'deepseek', model: 'legacy-model', temperature: 0.2, styleRules: 'Keep timing', targetLanguage: 'zh',
  completionEnabled: true, automaticCompletionEnabled: true, cleanDirtyLyrics: true, translateLyrics: true,
  detectLanguage: true, referenceExistingTranslation: false };
function fixture(locale = 'zh') {
  const calls = [], notices = []; let active = true; let save;
  const host = { isCurrent: () => active, notify: text => notices.push(text), request: async (path, init) => {
    calls.push({ path, init });
    if (init?.method === 'PUT') return save ? save.promise : { setting: { value: init.body.value, revision: 8 } };
    return path === 'settings' ? { setting: { value, revision: 7 }, defaults: { styleRules: 'Default rules' } }
      : { setting: { value: { version: 2, sources: [] }, revision: 3 } };
  } };
  const view = createBackgroundModuleHarness({ file: new URL('./LyricsSettings.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { t: key => key, useLocale: () => locale, SettingsSection: 'section', SettingsActions: 'actions', SettingsButton: 'button',
      SettingsToggle: 'toggle', SettingsInput: 'input', SettingsTextarea: 'textarea', SelectControl: 'select', InfoTip: 'tip', ServiceModelSettings: 'model-settings',
      ALL_LANGUAGES: [{ code: 'zh', label: '中文' }, { code: 'en', label: '英语' }] }, './LyricSourcesSettings.jsx': 'sources',
  }, globals: {} });
  return { ...view, calls, notices, host, retire() { active = false; }, delaySave() { save = deferred(); return save; },
    renderSettings() { return view.render({ host }); } };
}

test('four-option lyric configuration preserves legacy fields and revision when selecting manual AI', async () => {
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync(); let tree = f.renderSettings();
  assert.equal(nodes(tree).filter(node => node.type === 'model-settings').length,1);
  const toggles = nodes(tree).filter(node => node.type === 'toggle'); assert.equal(toggles.length, 1);
  const mode = nodes(tree).find(node => node.type === 'select' && node.props['aria-label'] === 'AI 补全');
  mode.props.onChange({ target: { value: 'manual' } }); tree = f.renderSettings();
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
  const f = fixture(); f.renderSettings(); await flushBackgroundAsync(); const tree = f.renderSettings(); const waiting = f.delaySave();
  const submit = nodes(tree).find(node => node.type === 'form').props.onSubmit;
  const first = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
  assert.equal(f.calls.filter(call => call.init?.method === 'PUT').length, 1);
  f.retire(); waiting.resolve({ setting: { value, revision: 8 } }); await first; await flushBackgroundAsync();
  assert.deepEqual(f.notices, []); f.unmount();
});

test('new policy labels come from the package messages in each supported locale', async () => {
  for (const [locale, aiLabel, preferenceLabel] of [
    ['zh','AI 补全','歌词偏好'], ['zh-Hant','AI 補全','歌詞偏好'],
    ['en','AI completion','Lyric preference'], ['ja','AI 補完','歌詞の優先設定'], ['ko','AI 보완','가사 기본 설정'],
  ]) {
    const f = fixture(locale); f.renderSettings(); await flushBackgroundAsync(); const tree = f.renderSettings();
    assert.ok(nodes(tree).some(node => node.type === 'select' && node.props['aria-label'] === aiLabel), locale);
    assert.ok(nodes(tree).some(node => node.type === 'select' && node.props['aria-label'] === preferenceLabel), locale);
    f.unmount();
  }
});

test('Traditional Chinese can be explicitly selected without changing a saved target just by viewing another UI language', async () => {
  const f=fixture('en'); f.renderSettings(); await flushBackgroundAsync(); let tree=f.renderSettings();
  const target=nodes(tree).find(node=>node.type==='select' && node.props['aria-label']==='目标译文语言');
  assert.equal(target.props.value,'zh');
  assert.ok(nodes(tree).some(node=>node.type==='option' && node.props.value==='zh-Hant'));
  target.props.onChange({target:{value:'zh-Hant'}}); tree=f.renderSettings();
  await nodes(tree).find(node=>node.type==='form').props.onSubmit({preventDefault(){}}); await flushBackgroundAsync();
  const saved=f.calls.find(call=>call.init?.method==='PUT'); assert.equal(saved.init.body.value.targetLanguage,'zh-Hant');
  assert.equal(saved.init.body.value.model,'legacy-model'); f.unmount();
});
