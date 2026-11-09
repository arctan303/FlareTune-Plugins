import { isSpeakerMp3, speakerErrorMessage } from "./speakers.js";

// Native audio remains the queue/lyrics/progress clock. Forward its intents
// without chasing timing differences or adding another browser audio element.
export function createSpeakerMirror({ audio, getPlayer, request, onState = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let alive = true, ownedSong = '', remoteAudioId = null, playing = false, finished = false, suspended = false;
  let uncertainPlay = false, definiteFailure = false, stateReadFailed = false;
  let chain = Promise.resolve(), volumeTimer = null, seekTimer = null, revision = 0;
  // A volume chosen while a state read is in flight, or still debouncing or
  // queued, is newer than that device reply and must not be reverted by it.
  let volumeIntent = 0, volumePending = false;
  const key = () => `${getPlayer().currentSong?.id || ''}:${getPlayer().currentSong?.audio_url || ''}`;
  const changed = patch => { if (alive) onState(patch); };
  const enqueue = operation => {
    const task = chain.catch(() => {}).then(() => alive ? operation() : undefined);
    chain = task.catch(() => {}); return task;
  };
  const report = error => {
    if (!alive || error?.name === 'AbortError') return;
    const canDetach = ['PLUGIN_NOT_INSTALLED', 'SPEAKER_RECONNECT_REQUIRED', 'XIAOMI_AUTH_EXPIRED', 'SPEAKER_NOT_FOUND'].includes(error?.code);
    if (canDetach) suspended = true;
    changed({ phase: 'disconnected', canDetach,
      error: speakerErrorMessage(error?.code) || '音箱连接异常，请检查连接后重试。' });
  };
  const uncertain = () => changed({ phase: 'uncertain', error: '下发状态不确定，请先检查音箱，避免重复播放。' });
  async function send(action, body = {}, version = revision) {
    definiteFailure = false; stateReadFailed = false;
    changed({ busy: true, phase: 'sending', error: '' });
    try {
      const response = await request(action, body);
      if (!alive || version !== revision) return null;
      if (response?.outcome === 'failed') {
        definiteFailure = true;
        changed({ phase: 'disconnected', error: '指令发送失败，请检查连接后重试。' }); return null;
      }
      if (response?.outcome !== 'sent') { uncertain(); return null; }
      return response;
    } catch (error) {
      if (alive && version === revision && error?.name !== 'AbortError') {
        // A lost HTTP response cannot establish whether a device command ran.
        if (error?.status >= 400 && error.status < 500 && error.code !== 'invalid_response') {
          definiteFailure = true; report(error);
        }
        else uncertain();
      }
      return null;
    }
    finally { if (version === revision) changed({ busy: false }); }
  }
  async function readState(version = revision) {
    const intent = volumeIntent;
    try {
      const result = await request('state', {});
      if (!alive || version !== revision) return null;
      const state = result?.playback || {};
      if (stateReadFailed && !suspended) {
        changed({ phase: !ownedSong ? 'ready' : playing === true ? 'playing' : playing === false ? 'paused' : 'uncertain', error: '' });
        stateReadFailed = false;
      }
      if (Number.isFinite(state.volume) && !volumePending && intent === volumeIntent) {
        changed({ speakerVolume: state.volume / 100 });
      }
      if (state.matched === false) {
        suspended = true; revision++; playing = null;
        changed({ busy: false, phase: 'suspended', error: '音箱正在播放其他内容，自动续播已暂停。' });
      }
      return state;
    } catch (error) {
      if (version === revision) { stateReadFailed = true; report(error); }
      return null;
    }
  }
  function syncPlay() {
    const song = getPlayer().currentSong, songKey = key();
    if (suspended) return Promise.resolve(false);
    if (ownedSong !== songKey || finished) { revision++; changed({ busy: false }); }
    const version = revision;
    if (!song || !isSpeakerMp3(song)) {
      // A cancelled volume change is never sent; later reads show the device again.
      clearTimer(seekTimer); clearTimer(volumeTimer); volumePending = false;
      return enqueue(async () => {
        if (version !== revision) return false;
        if (ownedSong) {
          if (!await send('stop', {}, version)) return false;
          ownedSong = ''; remoteAudioId = null; playing = false;
        }
        if (song) report({ code: 'SPEAKER_MP3_REQUIRED' });
        return false;
      });
    }
    return enqueue(async () => {
      if (version !== revision || suspended) return false;
      const sameTrack = ownedSong === songKey && !finished;
      if (sameTrack && (playing === true || (uncertainPlay && !remoteAudioId))) return playing === true;
      const canResume = sameTrack && Boolean(remoteAudioId);
      // Even an ambiguous play may reach the device. Keep enough context to
      // forward a later explicit pause without automatically replaying it.
      if (!canResume) { ownedSong = songKey; remoteAudioId = null; finished = false; }
      playing = null;
      // L05B can acknowledge startOffset without fetching the stream. Start
      // normally, then use the separately verified positioning operation.
      const result = await send(canResume ? 'resume' : 'play', canResume ? {} : { songId: song.id }, version);
      if (!alive || version !== revision) return false;
      uncertainPlay = !result && !definiteFailure;
      if (!result) return false;
      ownedSong = songKey; remoteAudioId = result.playback?.audioId || remoteAudioId; playing = true;
      changed({ phase: 'playing' });
      if (!canResume && !audio.paused && Number(audio.currentTime) > 2) {
        await positionSpeaker(Number(audio.currentTime), version, false);
      }
      return true;
    });
  }
  function syncPause() {
    const version = revision;
    return enqueue(async () => {
      if (version !== revision || !ownedSong || suspended) return false;
      playing = null;
      const result = await send('pause', {}, version);
      if (result) { playing = false; changed({ phase: 'paused' }); }
      return Boolean(result);
    });
  }
  async function positionSpeaker(position, version, confirm = true) {
    if (suspended || version !== revision || ownedSong !== key()) return;
    const result = await send('seek', { positionSeconds: position }, version);
    if (!result) return;
    if (!confirm) { changed({ phase: playing ? 'playing' : 'paused' }); return; }
    const state = await readState(version);
    if (!alive || version !== revision) return;
    const confirmed = state?.matched === true && state.audioId === remoteAudioId
      && Number.isFinite(state.positionSeconds) && Math.abs(state.positionSeconds - position) < 6;
    changed({ phase: playing ? 'playing' : 'paused',
      ...(!confirmed ? { error: '跳转指令已发送，音箱未返回可确认的位置。' } : {}) });
  }
  function syncSeek() {
    if (suspended || ownedSong !== key()) return;
    clearTimer(seekTimer);
    const position = Math.max(0, Number(audio.currentTime) || 0), version = revision;
    seekTimer = setTimer(() => {
      seekTimer = null;
      void enqueue(() => positionSpeaker(position, version));
    }, 200);
  }
  const handlers = { play: () => { void syncPlay(); }, pause: () => { void syncPause(); },
    seeked: syncSeek, ended: () => { playing = false; finished = true; } };
  for (const [event, handler] of Object.entries(handlers)) audio.addEventListener(event, handler);
  return {
    play: syncPlay, pause: syncPause, poll: () => enqueue(() => readState()),
    // True once another source owns the device or the binding is lost; stop()
    // then skips the device command, so the device may still be playing.
    isSuspended: () => suspended,
    volume(value) {
      clearTimer(volumeTimer); const version = revision, intent = ++volumeIntent;
      volumePending = true;
      volumeTimer = setTimer(() => {
        volumeTimer = null;
        void enqueue(async () => {
          try {
            if (suspended || version !== revision) return;
            if (await send('volume', { volume: Math.round(value * 100) }, version)) changed({ phase: playing ? 'playing' : 'ready' });
          } finally { if (intent === volumeIntent) volumePending = false; }
        });
      }, 400);
    },
    stop: () => enqueue(async () => {
      // Once another source owns the device, closing this mode must not pause it.
      if (suspended || !ownedSong) return true;
      const result = await send('stop');
      if (result) { playing = false; ownedSong = ''; remoteAudioId = null; }
      return Boolean(result);
    }),
    dispose() {
      alive = false; revision++; clearTimer(volumeTimer); clearTimer(seekTimer);
      for (const [event, handler] of Object.entries(handlers)) audio.removeEventListener(event, handler);
    },
  };
}
