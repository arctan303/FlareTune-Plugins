import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler } from '../../../tests/fullscreenBackgroundHarness.js';

const noop = () => {};
const owner = { authenticated: true, user: { accountId: 'A' }, csrfToken: 'csrf-A' };
const device = { id: 'd1', name: 'Living room', hardware: 'L05B', supported: true };
const find = (element, type) => {
  if (!element || typeof element !== 'object') return undefined;
  if (element.type === type) return element;
  return element.props?.children?.flat(Infinity).map(child => find(child, type)).find(Boolean);
};
const findRole = (element, role) => {
  if (!element || typeof element !== 'object') return undefined;
  if (element.props?.role === role) return element;
  return element.props?.children?.flat(Infinity).map(child => findRole(child, role)).find(Boolean);
};
function panelHarness({ enabled = false, demo = false, supported = true, connected = true } = {}) {
  const calls = [];
  const output = { enabled, speakerId: enabled ? device.id : '', deviceName: enabled ? device.name : '',
    busy: false, error: '', estimated: enabled, phase: enabled ? 'playing' : 'off',
    setTarget: (next) => { calls.push(['target', next.id]); output.speakerId = next.id; output.deviceName = next.name; },
    enable: async () => { calls.push(['enable']); }, disable: async () => { calls.push(['disable']); } };
  const speakers = { status: { connected, devices: [{ ...device, supported }] }, loading: false, busy: false, demo };
  const harness = createBackgroundModuleHarness({
    file: new URL('./SpeakerOutputSettings.jsx', import.meta.url), exportName: 'SpeakerOutputPanel',
    modules: { '@flaretune/plugin-sdk/client/settings-section': 'section',
      '@flaretune/plugin-sdk/client/i18n': { t: text => text, useLocale: noop },
      './useSpeakers.js': { useSpeakers: () => speakers },
      '../store/useUIStore.js': { useUIStore: selector => selector({ authSession: owner }) },
      './outputState.js': { useSpeakerOutputStore: () => output },
      '../store/usePluginStore.js': { usePluginStore: selector => selector({ loaded: true, installedIds: ['xiaomi-speaker'] }) },
      '@flaretune/plugin-sdk/client/settings-dialog': 'dialog', '@flaretune/plugin-sdk/client/settings-skeleton': 'skeleton',
      '@flaretune/plugin-sdk/client/settings-controls': { SettingsToggle: 'toggle', SettingsButton: 'button', SettingsActions: 'actions' },
      './SpeakerSettings.jsx': { SpeakerConnectionPanel: 'connection', SpeakerFeedback: 'feedback', SpeakerPicker: 'picker' },
    }, globals: {},
  });
  return { ...harness, calls, output, view: () => harness.render({ host: { session: { get: () => owner } }, onClose: noop }) };
}

test('output switch selects a server-provided target then enables; opening and selecting never start a song', () => {
  const harness = panelHarness();
  let panel = harness.view();
  assert.deepEqual(harness.calls, []);
  find(panel, 'picker').props.onChange('forged-device');
  assert.deepEqual(harness.calls, []);
  find(panel, 'picker').props.onChange('d1');
  assert.deepEqual(harness.calls, [['target', 'd1']]);
  panel = harness.view();
  find(panel, 'toggle').props.onChange({ target: { checked: true } });
  assert.deepEqual(harness.calls, [['target', 'd1'], ['enable']]);
  harness.unmount();
});

test('enabled output locks device selection and the same switch disables it', () => {
  const harness = panelHarness({ enabled: true }), panel = harness.view();
  assert.equal(find(panel, 'picker').props.disabled, true);
  find(panel, 'picker').props.onChange('d1');
  assert.deepEqual(harness.calls, []);
  find(panel, 'toggle').props.onChange({ target: { checked: false } });
  assert.deepEqual(harness.calls, [['disable']]);
  harness.unmount();
});

test('rejected enable and disable operations do not escape event handlers or cause retries', async () => {
  for (const enabled of [false, true]) {
    const harness = panelHarness({ enabled });
    let attempts = 0;
    harness.output[enabled ? 'disable' : 'enable'] = async () => { attempts++; throw new Error('store handles safe error state'); };
    find(harness.view(), 'toggle').props.onChange({ target: { checked: !enabled } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    harness.unmount();
  }
});

test('unsupported, disconnected and Demo targets cannot enable speaker output', () => {
  for (const options of [{ supported: false }, { connected: false }, { demo: true }]) {
    const harness = panelHarness(options), toggle = find(harness.view(), 'toggle');
    assert.equal(toggle.props.disabled, true);
    toggle.props.onChange({ target: { checked: true } });
    assert.deepEqual(harness.calls, []);
    harness.unmount();
  }
});

test('changing the account closes the output UI rather than opening a new account scope', () => {
  let authSession = owner, closed = 0; const listeners = new Set();
  const harness = createBackgroundModuleHarness({
    file: new URL('./SpeakerOutputSettings.jsx', import.meta.url),
    modules: { '@flaretune/plugin-sdk/client/settings-section': 'section',
      '@flaretune/plugin-sdk/client/i18n': { t: text => text, useLocale: noop },
      './useSpeakers.js': { useSpeakers: () => assert.fail('wrapper cannot load an account resource itself') },
      '../store/useUIStore.js': { useUIStore: selector => selector({ authSession }) },
      './outputState.js': {}, '@flaretune/plugin-sdk/client/settings-dialog': 'dialog', '@flaretune/plugin-sdk/client/settings-skeleton': 'skeleton',
      '../store/usePluginStore.js': { usePluginStore: selector => selector({ loaded: true, installedIds: ['xiaomi-speaker'] }) },
      '@flaretune/plugin-sdk/client/settings-controls': {}, './SpeakerSettings.jsx': {},
    }, globals: {},
  });
  const props = { onClose: () => closed++, host: { isCurrent: () => authSession === owner,
    session: { get: () => authSession === owner ? owner : null, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } } } };
  assert.ok(harness.render(props));
  authSession = { ...owner, user: { accountId: 'B' }, csrfToken: 'csrf-B' }; for (const callback of listeners) callback(null);
  assert.equal(harness.render(props), null);
  assert.equal(closed, 1);
  harness.unmount();
});

