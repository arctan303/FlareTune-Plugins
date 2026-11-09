import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';
import { createSpeakerSessionGuard, speakerOutcomeMessage, speakerErrorMessage } from './speakers.js';

const session = (id, token = `csrf-${id}`) => ({ authenticated: true, user: { accountId: id }, csrfToken: token });
const disconnected = { connected: false, needsReconnect: false, devices: [] };
const connected = { connected: true, needsReconnect: false, devices: [{ id: 'd1', name: 'Speaker', hardware: 'L05B', supported: true }] };

function speakerHarness({ demo = false } = {}) {
  const scheduler = createBackgroundScheduler(), calls = [], listeners = new Set(), statuses = [];
  let currentSession = session('A'), pauses = 0, pluginRefreshes = 0;
  const makeHost = () => {
    const owner = currentSession;
    return { environment: { demo }, isCurrent: () => currentSession === owner,
      session: { get: () => currentSession === owner ? { authenticated: owner.authenticated, user: owner.user } : null,
        subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback); } },
      player: { pause: () => pauses++ } };
  };
  let host = makeHost();
  const harness = createBackgroundModuleHarness({
    file: new URL('./useSpeakers.js', import.meta.url),
    modules: {
      '../store/useUIStore.js': { useUIStore: { getState: () => ({ authSession: currentSession }),
        subscribe: (callback) => { listeners.add(callback); return () => listeners.delete(callback); } } },
      '../store/usePlayerStore.js': { usePlayerStore: { getState: () => ({ pause: () => pauses++ }) } },
      '../store/usePluginStore.js': { usePluginStore: { getState: () => ({ refresh: async () => { pluginRefreshes++; } }) } },
      '../services/runtimeFetch.js': { isDemoRuntime: demo },
      './speakers.js': { createSpeakerSessionGuard, speakerOutcomeMessage, speakerErrorMessage,
        speakerRequest: (action, owner, body, { signal }) => new Promise((resolve, reject) => {
          calls.push({ action, owner: owner.session.get(), body, signal, resolve, reject, pauses });
        }) },
    },
    globals: { ...scheduler, Date },
    render: (module, { owner }) => module.useSpeakers(owner, { onStatus: (status) => statuses.push(status) }),
  });
  return { ...harness, scheduler, calls, statuses, pauses: () => pauses, pluginRefreshes: () => pluginRefreshes,
    view: () => harness.render({ owner: host }),
    changeSession(next) { currentSession = next; for (const listener of listeners) listener(); host = makeHost(); },
    async answer(index, value) { calls[index].resolve(value); await flushBackgroundAsync(); },
    async fail(index, error = new Error('private raw upstream error')) { calls[index].reject(error); await flushBackgroundAsync(); },
  };
}

test('a plugin build mismatch stays actionable without retrying a Xiaomi request', async () => {
  const subject = speakerHarness(); subject.view(); await subject.answer(0, disconnected);
  void subject.view().connect();
  await subject.fail(1, Object.assign(new Error(), { code: 'PLUGIN_BUILD_MISMATCH', status: 409 }));
  assert.equal(subject.calls.length, 2);
  assert.match(subject.view().error, /刷新网页/); subject.unmount();
});

async function showQr(harness) {
  harness.view(); await harness.answer(0, disconnected);
  void harness.view().connect();
  await harness.answer(1, { loginId: 'qr-session-A', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: Date.now() + 60_000 });
  return harness.view();
}

test('QR polling failure stops automatic checks and explicit retry retains the same login ID', async () => {
  const harness = speakerHarness();
  assert.equal((await showQr(harness)).polling, true);
  harness.scheduler.expire(1500);
  assert.equal(harness.calls[2].action, 'poll');
  await harness.fail(2);
  let view = harness.view();
  assert.equal(view.polling, false);
  assert.match(view.error, /重试检查授权/);
  assert.doesNotMatch(view.error, /private|upstream/);
  assert.equal(harness.scheduler.timeouts.size, 0);
  harness.scheduler.expire(2000);
  assert.equal(harness.calls.length, 3);
  view.retryLogin(); harness.view(); harness.scheduler.expire(1500);
  assert.equal(harness.calls[3].body.loginId, 'qr-session-A');
  await harness.answer(3, { phase: 'ready', ...connected });
  view = harness.view();
  assert.equal(view.qr, null);
  assert.equal(view.status.connected, true);
  harness.unmount();
});

test('closing QR UI aborts in-flight polling, removes timers and rejects its eventual result', async () => {
  const harness = speakerHarness(); await showQr(harness);
  harness.scheduler.expire(1500);
  const before = harness.statuses.length;
  harness.unmount();
  assert.equal(harness.calls[2].signal.aborted, true);
  await harness.answer(2, { phase: 'ready', ...connected });
  assert.equal(harness.statuses.length, before);
  assert.equal(harness.scheduler.timeouts.size, 0);
});

test('account/session changes cannot revive pending QR authorization or issue a poll as another user', async () => {
  for (const next of [session('B'), session('A', 'new-session')]) {
    const harness = speakerHarness(); harness.view(); await harness.answer(0, disconnected);
    void harness.view().connect();
    harness.changeSession(next);
    assert.equal(harness.calls[1].signal.aborted, true);
    harness.changeSession(session('A'));
    await harness.answer(1, { loginId: 'old-qr', qrDataUrl: 'data:image/png;base64,AA==', expiresAt: Date.now() + 60_000 });
    assert.equal(harness.view().qr, null);
    harness.scheduler.expire(1500);
    assert.deepEqual(harness.calls.map(call => call.action), ['status', 'login', 'status']);
    harness.unmount();
  }
});

test('play is single-flight, pauses locally before dispatch, and network ambiguity never causes retries', async () => {
  const harness = speakerHarness(); harness.view(); await harness.answer(0, connected);
  const view = harness.view();
  void view.play('d1', 'song-1'); void view.play('d1', 'song-1');
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[1].pauses, 1, 'local audio is paused before the remote request starts');
  await harness.fail(1, { status: 0 });
  assert.match(harness.view().message, /不确定/);
  harness.scheduler.expire(2000);
  assert.equal(harness.calls.length, 2);
  void harness.view().stop('d1');
  assert.equal(harness.pauses(), 1, 'stopping the speaker does not resume or alter local playback');
  await harness.answer(2, { outcome: 'sent' });
  assert.equal(harness.view().message, '指令已发送，请检查音箱。');
  harness.unmount();
});

test('Demo UI cannot load authorization, create QR sessions, or dispatch speaker commands', async () => {
  const harness = speakerHarness({ demo: true }), view = harness.view();
  await view.refresh(); await view.connect(); await view.play('d1', 'song-1'); await view.stop('d1');
  assert.equal(view.demo, true);
  assert.equal(view.loading, false);
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.pauses(), 0);
  harness.unmount();
});

test('failed commands refresh connection status without resending; expired authorizations and busy errors stay actionable', async () => {
  const harness = speakerHarness(); harness.view(); await harness.answer(0, connected);
  void harness.view().play('d1', 'song-1');
  await harness.answer(1, { outcome: 'failed' });
  assert.equal(harness.calls[2].action, 'status');
  await harness.answer(2, { ...connected, needsReconnect: true });
  assert.equal(harness.view().status.needsReconnect, true);
  void harness.view().stop('d1');
  await harness.fail(3, { status: 409, code: 'SPEAKER_BUSY' });
  assert.match(harness.view().error, /稍候后手动重试/);
  assert.equal(harness.calls.length, 4);
  harness.unmount();
});

test('an unreadable successful HTTP receipt remains uncertain rather than inviting another play command', async () => {
  const harness = speakerHarness(); harness.view(); await harness.answer(0, connected);
  void harness.view().play('d1', 'song-1');
  await harness.fail(1, { status: 200, code: 'invalid_response' });
  assert.match(harness.view().message, /不确定/);
  assert.equal(harness.calls.length, 2);
  harness.unmount();
});
