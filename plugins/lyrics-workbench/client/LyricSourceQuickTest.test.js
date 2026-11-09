import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';

const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
  ? node.flatMap(flatten) : [node, ...flatten(node.props?.children)];
const text = node => !node ? '' : Array.isArray(node) ? node.map(text).join('')
  : typeof node === 'object' ? text(node.props?.children) : String(node);
function fixture({ currentSong = { title: 'Current song', artist: 'Current artist', duration: 210 }, readOnly = false } = {}) {
  const calls = [], busy = [];
  let resolve, reject;
  const harness = createBackgroundModuleHarness({
    file: new URL('./LyricSourceQuickTest.jsx', import.meta.url),
    modules: {
      '@flaretune/plugin-sdk': { SettingsButton: 'button', SettingsInput: 'input', useSettingsReadOnly: () => readOnly, t: (key, values = {}) => key.replace(/\{(\w+)\}/g, (_, key) => values[key]), formatNumber: String },
      './useHostPlayer.js': { useHostPlayer: () => ({ currentSong }) },
      '../instance/adminApi.js': { testLyricSource: (...args) => { calls.push(args); return new Promise((yes, no) => { resolve = yes; reject = no; }); }, adminErrorMessage: () => 'Service error' },
      './SettingsControls.jsx': { SettingsButton: 'button' },
      './SettingsReadOnly.jsx': { SettingsInput: 'input', useSettingsReadOnly: () => readOnly },
    },
  });
  const props = { source: { protocol: 'custom_krc', searchUrl: 'https://lyrics.example.com/search', downloadUrl: 'https://lyrics.example.com/download', translationLanguage: 'zh' },
    host: { isCurrent: () => true, request: (_path, {body}) => { calls.push([body.source,body.song]); return new Promise((yes,no) => { resolve=yes;reject=no; }); } }, busy: false, onTesting: next => busy.push(next) };
  const render = () => harness.render(props);
  const button = label => flatten(render()).find(node => node.type === 'button' && text(node) === label);
  const input = label => flatten(render()).find(node => node.type === 'input' && node.props['aria-label'] === label);
  return { harness, calls, busy, props, render, button, input, resolve: value => resolve(value), reject: value => reject(value) };
}
const ready = { status: 'ready', stage: 'parse', candidateCount: 5, lineCount: 55, syncMode: 'word', hasTranslation: true, elapsedMs: 200 };

test('probe defaults to the current song, tests the draft once and displays actual precision', async () => {
  const f = fixture();
  assert.equal(f.input('测试歌名').props.value, 'Current song');
  const run = f.button('开始测试').props.onClick;
  run(); run();
  assert.equal(f.calls.length, 1, 'rapid duplicate clicks do not create multiple probes');
  assert.equal(f.calls[0][0].searchUrl, f.props.source.searchUrl);
  assert.equal(f.calls[0][1].duration, 210);
  assert.equal(f.render().props.disabled, true);
  f.resolve(ready); await flushBackgroundAsync();
  assert.match(text(f.render()), /测试通过：5 个候选，55 行歌词，逐字，有翻译/);
  assert.deepEqual(f.busy, [true, false]);
  f.props.source = { ...f.props.source, downloadUrl: 'https://other.example.com/download' };
  assert.doesNotMatch(text(f.render()), /测试通过/);
  f.harness.unmount();
});

test('manual song entry drops the current duration and can restore the current song', async () => {
  const f = fixture();
  f.input('测试歌名').props.onChange({ target: { value: 'Manual title' } });
  f.input('测试歌手').props.onChange({ target: { value: 'Manual artist' } });
  f.button('开始测试').props.onClick();
  assert.equal(f.calls[0][1].title, 'Manual title');
  assert.equal(f.calls[0][1].artist, 'Manual artist');
  assert.equal(f.calls[0][1].duration, undefined, 'a different song must not inherit the playback duration');
  f.resolve({ status: 'no_matches', stage: 'search', candidateCount: 0, elapsedMs: 20 }); await flushBackgroundAsync();
  assert.match(text(f.render()), /下载和解析尚未验证/);
  f.button('使用当前歌曲').props.onClick();
  assert.equal(f.input('测试歌名').props.value, 'Current song');
  assert.doesNotMatch(text(f.render()), /下载和解析尚未验证/);
  f.harness.unmount();
});

test('empty songs and demo read-only policy never send a probe', () => {
  for (const options of [{ currentSong: null }, { readOnly: true }]) {
    const f = fixture(options);
    f.button('开始测试').props.onClick();
    assert.equal(f.calls.length, 0);
    if (!options.readOnly) assert.equal(f.button('使用当前歌曲').props.disabled, true);
    f.harness.unmount();
  }
});

test('network failure preserves form data and allows retry; unmount ignores a late result', async () => {
  const f = fixture();
  f.button('开始测试').props.onClick(); f.reject(new Error('Service error')); await flushBackgroundAsync();
  assert.equal(f.input('测试歌名').props.value, 'Current song');
  assert.match(text(f.render()), /Service error/);
  f.button('开始测试').props.onClick();
  assert.equal(f.calls.length, 2);
  f.harness.unmount();
  f.resolve(ready); await flushBackgroundAsync();
  assert.deepEqual(f.busy, [true, false, true], 'unmounted parent receives no late completion');
});
