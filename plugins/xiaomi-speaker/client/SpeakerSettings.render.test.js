import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

const session = { authenticated: true, user: { accountId: 'A' }, csrfToken: 'csrf-A' };
const noop = () => {};
const host = { isCurrent: () => true, session: { get: () => session, subscribe: () => noop } };
const supported = { id: 'd1', name: 'Living room', hardware: 'L05B', supported: true };
let speakerState;
let outputState;
function resetState(overrides = {}, outputOverrides = {}) {
  speakerState = { status: { connected: true, needsReconnect: false, devices: [supported] },
    loading: false, busy: false, error: '', message: '', qr: null, polling: false, demo: false,
    connect: noop, refresh: noop, refreshDevices: noop, disconnect: noop, retryLogin: noop, play: noop, stop: noop, test: noop,
    ...overrides };
  outputState = { enabled: false, speakerId: '', deviceName: '', busy: false, error: '', estimated: false, phase: 'off',
    setTarget: noop, enable: noop, disable: noop, ...outputOverrides };
}
const button = ({ children, variant, closeDialog, ...props }) => React.createElement('button', props, children);
const dependencies = {
  react: React,
  '@flaretune/plugin-sdk/client/i18n': { t: (text) => text, useLocale: noop },
  './useSpeakers.js': { useSpeakers: () => speakerState },
  '../store/useUIStore.js': { useUIStore: (selector) => selector({ authSession: session }) },
  './outputState.js': { useSpeakerOutputStore: (selector) => selector ? selector(outputState) : outputState },
  '../store/usePluginStore.js': { usePluginStore: selector => selector({ loaded: true, installedIds: ['xiaomi-speaker'] }) },
  '@flaretune/plugin-sdk/client/settings-section': ({ title, action, children }) => React.createElement('section', null, title, action, children),
  '@flaretune/plugin-sdk/client/settings-dialog': ({ title, children }) => React.createElement('section', { 'aria-label': title }, children),
  '@flaretune/plugin-sdk/client/settings-skeleton': () => React.createElement('div', { role: 'status' }, 'Loading'),
  '@flaretune/plugin-sdk/client/settings-controls': { SettingsButton: button, SettingsActions: ({ children }) => React.createElement('div', null, children),
    SettingsToggle: ({ label, info, ...props }) => React.createElement('label', null, label, info && React.createElement('span', { role: 'tooltip' }, info), React.createElement('input', { ...props, type: 'checkbox', role: 'switch' })) },
  '@flaretune/plugin-sdk/client/select-control': ({ children, ...props }) => React.createElement('select', props, children),
};
function loadComponent(file) {
  const compiled = transformSync(readFileSync(new URL(file, import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unhandled component dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const settings = loadComponent('./SpeakerSettings.jsx');
dependencies['./SpeakerSettings.jsx'] = settings;
const SpeakerOutputSettings = loadComponent('./SpeakerOutputSettings.jsx').default;
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('output setting offers one switch and the existing player controls, with no single-track remote controls', () => {
  resetState();
  const markup = render(SpeakerOutputSettings, { host, onClose: noop });
  assert.match(markup, /role="switch"/);
  assert.match(markup, /网页播放器的队列和播放控件/);
  assert.match(markup, /音箱输出已关闭/);
  assert.doesNotMatch(markup, /投放此歌曲|停止音箱播放|播放测试音效/);
  assert.equal((markup.match(/<button\b/gu) || []).length, 1, 'only the connection management action is separate from the switch');
});

test('enabled output identifies the selected speaker and locks device selection without redundant helper paragraphs', () => {
  resetState({}, { enabled: true, speakerId: 'd1', deviceName: 'Living room', phase: 'playing', estimated: true });
  const markup = render(SpeakerOutputSettings, { host, onClose: noop });
  assert.match(markup, /音箱输出已启用.*Living room/);
  assert.match(markup, /音箱正在播放/);
  assert.match(markup, /<select[^>]*disabled=""/);
  assert.doesNotMatch(markup, /关闭音箱输出后可切换音箱|音量控件调整当前输出；音箱播放时本机保持静音/);
});

test('unsupported devices remain visible but cannot receive playback commands', () => {
  resetState({ status: { connected: true, devices: [{ ...supported, hardware: 'OTHER', supported: false }] } });
  const markup = render(SpeakerOutputSettings, { host, onClose: noop });
  assert.match(markup, /暂不支持此型号/);
  assert.match(markup, /当前没有可用的 L05B 音箱/);
  assert.match(markup, /<input[^>]*disabled=""[^>]*role="switch"/);
});

test('expired authorization still offers unlink, and interrupted QR authorization can be checked manually', () => {
  resetState({ status: { connected: false, needsReconnect: true, devices: [] }, error: '小米授权已失效，请重新连接。' });
  let markup = render(settings.SpeakerConnectionPanel, { speakers: speakerState });
  assert.match(markup, /解绑小米账号/);
  assert.match(markup, /连接小米账号/);
  resetState({ status: { connected: false, devices: [] }, qr: { qrDataUrl: 'data:image/png;base64,AA==', expiresAt: Date.now() + 60_000 } });
  markup = render(settings.SpeakerConnectionPanel, { speakers: speakerState });
  assert.match(markup, /自动检查已停止/);
  assert.match(markup, /重试检查授权/);
  assert.match(markup, /小米账号授权二维码/);
});

test('Demo connection UI exposes no QR session or real connect action', () => {
  resetState({ demo: true, status: null });
  const markup = render(settings.SpeakerConnectionPanel, { speakers: speakerState });
  assert.match(markup, /演示模式不连接小米账号/);
  assert.doesNotMatch(markup, /<img|>连接小米账号<|>投放此歌曲</);
});

test('connected speaker settings keep unlink after device controls with its privacy consequences',()=>{
  resetState();const markup=render(settings.SpeakerConnectionPanel,{speakers:speakerState});
  assert.ok(markup.indexOf('解绑小米账号')>markup.indexOf('刷新音箱列表'));
  assert.ok(markup.indexOf('解绑会撤销后续请求')>markup.indexOf('Living room'));
  assert.equal((markup.match(/解绑小米账号/g)||[]).length,1);
  resetState({status:{connected:false,devices:[]}});const disconnected=render(settings.SpeakerConnectionPanel,{speakers:speakerState});
  assert.match(disconnected,/授权将按你的 FlareTune 账号加密保存在后端/);assert.doesNotMatch(disconnected,/解绑小米账号/);
});

