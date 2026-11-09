import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { AI_PROTOCOLS, AI_SOURCES } from '../shared/aiProtocols.js';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
test('Gateway settings show the existing key as configured and edit through their bound host', async () => {
  const calls = [];
  const host = { assertCurrent() {}, request: async (path, options) => { calls.push({ path, options }); return { id: 'two', name: 'DeepSeek', source: 'deepseek', revision: 1, hasKey: true }; } };
  const resource = { data: { ready: true, credentialReady: true,
    providers: [{ id: 'one', name: 'Saved provider', source: 'deepseek', hasKey: true, revision: 1 }],
    features: { assistant: { revision: 0 }, lyrics: { revision: 0 } } }, loading: false,
    setData: fn => { resource.data = fn(resource.data); }, refresh: async () => resource.data };
  const sdk = { t: key => key, useSettingsResource: () => resource, AI_PROTOCOLS, AI_SOURCES,
    SettingsInput: 'input', SettingsWriteButton: 'button', SettingsEditDialog: 'dialog', SettingsSkeleton: 'skeleton',
    InfoTip: 'tip', SettingsActions: 'actions', SettingsButton: 'button', SettingsToggle: 'toggle', SelectControl: 'select' };
  const view = createBackgroundModuleHarness({ file: new URL('./GatewaySettings.jsx', import.meta.url),
    modules: { '@flaretune/plugin-sdk': sdk, 'lucide-react': icons }, globals: { window: { confirm: () => true } } });
  let tree = view.render({ host });
  assert.match(text(tree), /Saved provider/); assert.match(text(tree), /密钥已配置/);
  assert.equal(nodes(tree).some(node => node.type === 'input' && node.props.type === 'password'), false);
  nodes(tree).find(node => node.type === 'button' && text(node) === '添加供应商').props.onClick();
  tree = view.render({ host });
  const password = nodes(tree).find(node => node.type === 'input' && node.props.type === 'password');
  assert.equal(password.props.value, '');
  password.props.onChange({ target: { value: 'newly-entered-private-key' } });
  tree = view.render({ host });
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[0].path, 'providers'); assert.equal(calls[0].options.admin, true);
  assert.equal(calls[0].options.body.apiKey, 'newly-entered-private-key');
  tree = view.render({ host });
  assert.equal(nodes(tree).some(node => node.type === 'dialog'), false);
  assert.doesNotMatch(text(tree), /newly-entered-private-key/);
  view.unmount();
});
