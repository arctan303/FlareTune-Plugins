import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';
import { createSpeakerSessionGuard, speakerErrorMessage } from './speakers.js';
import { createSpeakerMirror } from './speakerMirror.js';

function store(initial) {
  let state = initial; const listeners = new Set();
  return { getState: () => state,
    setState(patch) { const previous = state; state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; for (const listener of listeners) listener(state, previous); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listenerCount: () => listeners.size };
}
class AudioClock extends EventTarget {
  constructor(paused = false) { super(); this.paused = paused; this.muted = false; this.currentTime = 12; this.volume = 0.35; this.nativeCalls = []; this.listeners = new Map(); }
  addEventListener(name, handler) { super.addEventListener(name, handler); if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { super.removeEventListener(name, handler); this.listeners.get(name)?.delete(handler); }
  pause() { this.nativeCalls.push('pause'); this.paused = true; }
  play() { this.nativeCalls.push('play'); this.paused = false; return Promise.resolve(); }
  load() { this.nativeCalls.push('load'); }
  set src(value) { this.nativeCalls.push(['src', value]); }
  get listenerCount() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
  emit(name) { this.dispatchEvent(new Event(name)); }
}
const account = (id) => ({ authenticated: true, user: { accountId: id }, csrfToken: `csrf-${id}` });

function outputHarness({ paused = false, deferAction, respond, retireOnAccountChange = false } = {}) {
  const scheduler = createBackgroundScheduler(), calls = [], audio = new AudioClock(paused);
  const song = { id: 'A', audio_url: '/media/A.mp3' };
  const player = store({ currentSong: song, volume: 0.35 });
  // The real cancelPendingPlayback is covered in usePlayerStore.test.js. Record
  // the mute gate at each call to prove pending starts are cancelled first.
  const cancelledWhileMuted = [];
  player.setState({ setVolume: (value) => player.setState({ volume: value }),
    cancelPendingPlayback: () => { cancelledWhileMuted.push(audio.muted); player.setState({ isPlaying: false, shouldAutoPlay: false }); } });
  const output = store({ enabled: false, speakerId: 'd1', deviceName: '', speakerVolume: 0.5,
    busy: false, error: '', phase: 'off' });
  const ui = store({ authSession: account('A') });
  const plugins = store({ loaded: true, installedIds: ['xiaomi-speaker'], refresh: async () => {},
    markUninstalled: () => plugins.setState({ installedIds: [] }) });
  let controls = null;
  const harness = createBackgroundModuleHarness({
    file: new URL('./useSpeakerOutput.js', import.meta.url), exportName: 'useSpeakerOutput',
    modules: {
      './outputState.js': { useSpeakerOutputStore: output,
        bindSpeakerOutputControls(next) { controls = next; return () => { if (controls === next) controls = null; }; } },
      '../store/usePlayerStore.js': { usePlayerStore: player }, '../store/useUIStore.js': { useUIStore: ui },
      '../store/usePluginStore.js': { usePluginStore: plugins },
      './speakers.js': { createSpeakerSessionGuard, speakerErrorMessage,
        speakerRequest: (action, session, body, { signal }) => {
          const call = { action, session, body, signal }; calls.push(call);
          if (action === deferAction) return new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
          return Promise.resolve(respond?.(action, body) ?? (action === 'status' ? { connected: true, devices: [{ id: 'd1', name: 'Living room', supported: true }] }
            : action === 'state' ? { playback: { matched: true, audioId: 'A', volume: 60, positionSeconds: audio.currentTime } }
              : { outcome: 'sent', playback: { audioId: 'A' } }));
        } },
      './speakerMirror.js': { createSpeakerMirror: (options) => createSpeakerMirror({ ...options,
        setTimer: scheduler.setTimeout, clearTimer: scheduler.clearTimeout }) },
    }, globals: { ...scheduler, document: { visibilityState: 'visible' } },
  });
  const audioRef = { current: audio }, mounted = ui.getState().authSession;
  let disposed = false, mutedBefore = false, muted = false;
  const host = { isCurrent: () => !disposed && ui.getState().authSession === mounted
      && plugins.getState().loaded && plugins.getState().installedIds.includes('xiaomi-speaker'),
    session: { get: () => host.isCurrent() ? { authenticated: true, user: mounted.user } : null,
      subscribe: callback => ui.subscribe(() => callback(host.session.get())) },
    player: { getSnapshot: () => player.getState() },
    outputTargets: { register: () => ({ clock: audio, canClaim: () => host.isCurrent(), publish() {},
      muteLocal() { if (!host.isCurrent()) return false; mutedBefore = audio.muted; audio.muted = true; muted = true; return true; },
      restoreLocal({ quiet = false } = {}) { if (!muted) return; muted = false;
        if (quiet) { player.getState().cancelPendingPlayback(); if (!audio.paused) audio.pause(); }
        audio.muted = mutedBefore;
      }, dispose() {} }) },
  };
  let unmount = () => {};
  const stopPlugins = plugins.subscribe(() => { if (!host.isCurrent()) unmount(); });
  const stopUI = retireOnAccountChange ? ui.subscribe(() => { if (!host.isCurrent()) unmount(); }) : () => {};
  unmount = () => { stopPlugins(); stopUI(); harness.unmount(); disposed = true; };
  harness.render(host);
  return { ...harness, unmount, scheduler, calls, audio, audioRef, player, output, ui, plugins, song, cancelledWhileMuted, controls: () => controls };

}

test('enabling speaker output keeps the native stream and clock running while muting only local sound', async () => {
  const subject = outputHarness();
  assert.equal(await subject.controls().enable(), true);
  assert.equal(subject.audio.paused, false);
  assert.equal(subject.audio.currentTime, 12);
  assert.equal(subject.player.getState().currentSong, subject.song);
  assert.deepEqual(subject.audio.nativeCalls, []);
  assert.equal(subject.audio.muted, true);
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.player.getState().volume, 0.35);
  assert.equal(subject.output.getState().speakerVolume, 0.6);
  assert.deepEqual(subject.calls.map(call => call.action), ['status', 'state', 'play', 'seek']);
  assert.equal(subject.calls[2].body.positionSeconds, undefined);
  assert.equal(subject.calls[3].body.positionSeconds, 12);
  subject.unmount();
});

test('speaker volume never changes local volume or removes the native mute gate', async () => {
  const subject = outputHarness(); await subject.controls().enable();
  subject.controls().volume(0.8); subject.scheduler.expire(400); await flushBackgroundAsync();
  assert.equal(subject.calls.at(-1).action, 'volume');
  assert.equal(subject.calls.at(-1).body.volume, 80);
  assert.equal(subject.player.getState().volume, 0.35);
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.audio.muted, true);
  assert.equal(await subject.controls().disable(), true);
  assert.equal(subject.calls.at(-1).action, 'stop');
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.player.getState().volume, 0.35);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.output.getState().enabled, false);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.unmount();
});

test('an uninstalled plugin cannot enable output or issue Xiaomi requests', async () => {
  const subject = outputHarness();
  const enable = subject.controls().enable;
  subject.plugins.setState({ installedIds: [] });
  assert.equal(await enable(), false);
  assert.deepEqual(subject.calls, []);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.output.getState().enabled, false);
  subject.unmount();
});

test('uninstalling an active plugin disposes mirroring and pauses the local clock before restoring mute', async () => {
  const subject = outputHarness();
  await subject.controls().enable();
  const before = subject.calls.length;
  subject.plugins.setState({ installedIds: [] });
  assert.equal(subject.audio.paused, true);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.audio.listenerCount, 0);
  assert.equal(subject.output.getState().enabled, false);
  assert.equal(subject.output.getState().speakerId, '');
  subject.audio.emit('play'); subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.calls.length, before, 'a retired plugin cannot send stop or keep polling');
  subject.unmount();
});

test('uninstall during an in-flight enable rejects the late response without muting or starting output', async () => {
  const subject = outputHarness({ deferAction: 'state' });
  const pending = subject.controls().enable();
  await flushBackgroundAsync();
  subject.plugins.setState({ installedIds: [] });
  subject.calls.at(-1).resolve({ playback: { volume: 50 } });
  assert.equal(await pending, false);
  assert.equal(subject.output.getState().enabled, false);
  assert.equal(subject.audio.muted, false);
  assert.deepEqual(subject.calls.map(call => call.action), ['status', 'state']);
  subject.unmount();
});

test('a quiet exit while the next track loads cancels its pending start before restoring local sound', async () => {
  const subject = outputHarness(); await subject.controls().enable();
  // Natural advance: the element is paused while the player waits for canplay.
  subject.audio.paused = true;
  subject.player.setState({ isPlaying: true, shouldAutoPlay: true });
  subject.plugins.setState({ installedIds: [] });
  assert.equal(subject.output.getState().enabled, false);
  assert.deepEqual(subject.cancelledWhileMuted, [true], 'pending starts are cancelled before the mute gate opens');
  assert.equal(subject.player.getState().shouldAutoPlay, false, 'canplay cannot start the next track audibly');
  assert.equal(subject.player.getState().isPlaying, false);
  assert.equal(subject.audio.muted, false);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.unmount();
});

test('closing output while a state read is in flight re-checks detachment before releasing the mute gate', async () => {
  let deferPoll = false, resolvePoll = null;
  const subject = outputHarness({ respond: action => deferPoll && action === 'state'
    ? new Promise(resolve => { resolvePoll = resolve; }) : undefined });
  await subject.controls().enable(); deferPoll = true;
  subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.ok(resolvePoll, 'the poll is still waiting for the device');
  const closing = subject.controls().disable(); await flushBackgroundAsync();
  resolvePoll({ playback: { matched: false, audioId: 'external-source', volume: 20 } });
  assert.equal(await closing, true);
  assert.equal(subject.calls.some(call => call.action === 'stop'), false, 'the external owner is not stopped');
  assert.equal(subject.audio.paused, true, 'local sound cannot join content still playing on the device');
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.output.getState().enabled, false);
  subject.unmount();
});

test('an account change that retires the runtime first still clears the previous device selection and message', async () => {
  const subject = outputHarness({ retireOnAccountChange: true });
  await subject.controls().enable();
  subject.output.setState({ error: '旧账号的音箱提示' });
  subject.ui.setState({ authSession: account('B') });
  assert.equal(subject.controls(), null);
  const state = subject.output.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.speakerId, '');
  assert.equal(state.deviceName, '');
  assert.equal(state.error, '');
  assert.equal(subject.audio.paused, true);
  assert.equal(subject.audio.muted, false);
});

test('server-side uninstall discovered by polling quietly detaches stale output', async () => {
  let removed = false;
  const subject = outputHarness({ respond: action => {
    if (removed && action === 'state') throw Object.assign(new Error(), { status: 409, code: 'PLUGIN_NOT_INSTALLED' });
  } });
  await subject.controls().enable();
  removed = true; subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.output.getState().enabled, false);
  assert.equal(subject.audio.paused, true);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.audio.listenerCount, 0);
  assert.match(subject.output.getState().error, /插件已卸载/);
  // Production then retires the runtime; the same-account notice must survive.
  subject.unmount();
  assert.match(subject.output.getState().error, /插件已卸载/);
});

test('a same-version build mismatch retires old speaker output quietly and does not replay a command', async () => {
  let updated = false;
  const subject = outputHarness({ respond: action => {
    if (updated && action === 'state') throw Object.assign(new Error(), { status: 409, code: 'PLUGIN_BUILD_MISMATCH' });
  } });
  await subject.controls().enable(); updated = true;
  subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.output.getState().enabled, false); assert.equal(subject.audio.paused, true);
  assert.equal(subject.audio.muted, false); assert.equal(subject.audio.listenerCount, 0);
  assert.deepEqual(subject.plugins.getState().installedIds, ['xiaomi-speaker'], 'a version mismatch is not an uninstall');
  assert.match(subject.output.getState().error, /刷新网页/);
  const count = subject.calls.length; subject.scheduler.rotate(); subject.audio.emit('play');
  await flushBackgroundAsync(); assert.equal(subject.calls.length, count); subject.unmount();
});

test('enabling while native playback is paused does not start it, and disabling restores the original local volume', async () => {
  const subject = outputHarness({ paused: true, respond: action => action === 'state'
    ? { playback: { matched: false, audioId: 'external-source', volume: 60 } } : undefined });
  await subject.controls().enable();
  assert.deepEqual(subject.calls.map(call => call.action), ['status', 'state']);
  assert.equal(subject.audio.paused, true);
  assert.deepEqual(subject.audio.nativeCalls, []);
  assert.equal(await subject.controls().disable(), true);
  assert.deepEqual(subject.calls.map(call => call.action), ['status', 'state'],
    'when this mode never sent a track, closing it cannot stop content already playing on the device');
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.player.getState().volume, 0.35);
  assert.equal(subject.audio.listenerCount, 0);
  assert.equal(subject.output.getState().enabled, false);
  subject.unmount();
});

test('a browser that was muted before output stays muted when output is disabled', async () => {
  const subject = outputHarness(); subject.audio.muted = true;
  await subject.controls().enable();
  assert.equal(await subject.controls().disable(), true);
  assert.equal(subject.player.getState().volume, 0.35);
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.audio.muted, true);
  assert.deepEqual(subject.audio.nativeCalls, []);
  subject.unmount();
});

test('local sound stays gated until stop succeeds and uncertain stops never auto-enable it', async () => {
  const subject = outputHarness({ deferAction: 'stop' }); await subject.controls().enable();
  const uncertainStop = subject.controls().disable(); await flushBackgroundAsync();
  assert.equal(subject.audio.muted, true);
  assert.equal(subject.output.getState().enabled, true);
  subject.calls.at(-1).resolve({ outcome: 'uncertain' });
  assert.equal(await uncertainStop, false);
  assert.equal(subject.audio.muted, true);
  assert.equal(subject.output.getState().enabled, true);
  const retry = subject.controls().disable(); await flushBackgroundAsync();
  assert.equal(subject.audio.muted, true);
  subject.calls.at(-1).resolve({ outcome: 'sent' });
  assert.equal(await retry, true);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.audio.paused, false);
  assert.equal(subject.player.getState().volume, 0.35);
  subject.unmount();
});

test('account exit and unmount restore native mute only after pausing its clock', async () => {
  for (const exit of ['account', 'unmount']) {
    const subject = outputHarness(); await subject.controls().enable();
    const writes = []; let audioMuted = true;
    Object.defineProperty(subject.audio, 'muted', { configurable: true,
      get: () => audioMuted, set: value => { writes.push({ value, paused: subject.audio.paused }); audioMuted = value; } });
    if (exit === 'account') subject.ui.setState({ authSession: account('B') });
    else subject.unmount();
    assert.equal(subject.output.getState().enabled, false);
    assert.equal(subject.player.getState().volume, 0.35);
    assert.equal(subject.audio.volume, 0.35);
    assert.equal(subject.audio.muted, false);
    assert.equal(subject.audio.paused, true);
    assert.ok(writes.length > 0);
    assert.equal(writes.some(write => !write.value && !write.paused), false,
      'restoring a preference during exit must never make the running local stream suddenly audible');
    if (exit === 'account') subject.unmount();
  }
});

test('closing output after polling detects external content leaves that content untouched', async () => {
  let external = false;
  const subject = outputHarness({ respond: action => external && action === 'state'
    ? { playback: { matched: false, audioId: 'external-source', volume: 20 } } : undefined });
  await subject.controls().enable(); external = true;
  subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.output.getState().phase, 'suspended');
  const count = subject.calls.length;
  assert.equal(await subject.controls().disable(), true);
  assert.equal(subject.output.getState().enabled, false);
  assert.equal(subject.calls.length, count, 'disable cannot send stop to the external owner');
  assert.equal(subject.audio.paused, true, 'do not add local sound while external content is still playing');
  assert.equal(subject.audio.muted, false);
  subject.unmount();
});

test('an ordinary polling error after an external takeover still keeps local sound paused on close', async () => {
  let reads = 0;
  const subject = outputHarness({ respond: action => {
    if (action !== 'state') return undefined;
    reads++;
    if (reads === 2) return { playback: { matched: false, audioId: 'external-source', volume: 20 } };
    if (reads === 3) return Promise.reject(Object.assign(new Error('upstream unavailable'), { status: 502 }));
    return undefined;
  } });
  await subject.controls().enable();
  subject.scheduler.rotate(); await flushBackgroundAsync();
  subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.output.getState().phase, 'disconnected', 'the visible phase no longer says suspended');
  assert.equal(subject.output.getState().canDetach, false);
  const count = subject.calls.length;
  assert.equal(await subject.controls().disable(), true);
  assert.equal(subject.calls.length, count, 'the external owner is not stopped');
  assert.equal(subject.audio.paused, true, 'local sound cannot join content still playing on the device');
  assert.equal(subject.audio.muted, false);
  subject.unmount();
});

test('losing device authorization pauses local playback before releasing the mute gate', async () => {
  let expired = false;
  const subject = outputHarness({ respond: action => expired && action === 'state'
    ? Promise.reject(Object.assign(new Error('expired'), { status: 409, code: 'SPEAKER_RECONNECT_REQUIRED' })) : undefined });
  await subject.controls().enable(); expired = true;
  subject.scheduler.rotate(); await flushBackgroundAsync();
  assert.equal(subject.output.getState().canDetach, true);
  assert.equal(subject.audio.muted, true);
  const count = subject.calls.length;
  assert.equal(await subject.controls().disable(), true);
  assert.equal(subject.calls.length, count);
  assert.equal(subject.audio.paused, true);
  assert.equal(subject.audio.muted, false);
  assert.equal(subject.player.getState().volume, 0.35);
  subject.unmount();
});

test('account switching aborts an in-flight command and prevents late replies, timers and native events from issuing more work', async () => {
  const subject = outputHarness({ deferAction: 'play' });
  const pending = subject.controls().enable(); await flushBackgroundAsync();
  const play = subject.calls.find(call => call.action === 'play'); assert.ok(play);
  subject.audio.currentTime = 30; subject.audio.emit('seeked'); subject.controls().volume(0.9);
  subject.ui.setState({ authSession: account('B') });
  assert.equal(play.signal.aborted, true);
  assert.equal(subject.audio.listenerCount, 0);
  assert.equal(subject.scheduler.timeouts.size, 0);
  const count = subject.calls.length;
  play.resolve({ outcome: 'sent', playback: { audioId: 'A' } }); await pending;
  subject.audio.emit('play'); subject.audio.emit('pause'); subject.scheduler.expire(200); subject.scheduler.expire(400); subject.scheduler.rotate();
  await flushBackgroundAsync();
  assert.equal(subject.calls.length, count);
  assert.equal(subject.output.getState().enabled, false);
  assert.equal(subject.output.getState().speakerId, '');
  subject.unmount();
});

test('unmount during authorization checks cancels the request and all polling without muting or replacing native audio', async () => {
  const subject = outputHarness({ deferAction: 'status' });
  const pending = subject.controls().enable(); await flushBackgroundAsync();
  subject.unmount();
  assert.equal(subject.calls[0].signal.aborted, true);
  assert.equal(subject.scheduler.intervals.size, 0);
  assert.equal(subject.ui.listenerCount(), 0);
  assert.equal(subject.player.listenerCount(), 0);
  subject.calls[0].resolve({ connected: true, devices: [{ id: 'd1', supported: true }] }); await pending;
  assert.equal(subject.calls.length, 1);
  assert.equal(subject.audio.volume, 0.35);
  assert.equal(subject.audio.listenerCount, 0);
  assert.deepEqual(subject.audio.nativeCalls, []);
  assert.equal(subject.controls(), null);
});

