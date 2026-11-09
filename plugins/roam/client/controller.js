import { createInactiveRandomRoam, buildRandomRoamPayload, normalizeRandomRoamResponse,
  normalizeRandomRoamSongIds, normalizeRoamLanguage, shouldPrefetchRandomRoam, splitRoamQueue, recentRoamIds } from "./algorithms.js";
import { createRoamPreferences } from "./preferences.js";

const playable = songs => Array.isArray(songs) ? songs.filter(song => song?.id != null && typeof song.audio_url === 'string' && song.audio_url.trim()) : [];
const errorMessage = error => error?.name === 'AbortError' ? '续播请求超时，请重试'
  : error?.status === 401 ? '登录状态已失效，重新登录后可继续漫游'
    : error?.status === 429 ? '请求过于频繁，请稍后重试' : '续播加载失败，请重试';

export function createRoamController(host, { storage, timeoutMs = 10000, setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout, schedule = queueMicrotask } = {}) {
  const preferences = createRoamPreferences(host, { storage });
  let state = { ...createInactiveRandomRoam(), ...preferences.load(), available: true };
  let disposed = false, started = false, serial = 0, request = null, requestTimer = null, scheduled = false, suppressPump = 0;
  let lastHandledManualNonce = 0, lastRequestKey = '';
  const listeners = new Set();
  const cleanup = [];
  const isCurrent = () => !disposed && !host.signal?.aborted && host.isCurrent();
  const queueSnapshot = () => host.queue.getSnapshot();
  const ready = () => isCurrent() && queueSnapshot().ready !== false;
  const emit = patch => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
    kick();
  };
  function kick() {
    if (!started || scheduled || suppressPump || !isCurrent()) return;
    scheduled = true;
    schedule(() => { scheduled = false; if (isCurrent()) void pump(); });
  }
  function cancel() {
    serial++;
    request?.abort(); request = null;
    if (requestTimer !== null) clearTimeoutImpl(requestTimer);
    requestTimer = null;
    lastRequestKey = '';
  }
  function reset(patch = {}) {
    cancel();
    emit({ ...createInactiveRandomRoam(), language: state.language, batchSize: state.batchSize,
      manualNonce: state.manualNonce, retryNonce: state.retryNonce, ...patch });
    lastHandledManualNonce = state.manualNonce;
  }
  function disable() {
    if (!isCurrent()) return false;
    reset(); return true;
  }
  async function pump() {
    if (!ready() || request || state.status === 'loading') return;
    const manual = state.manualNonce > lastHandledManualNonce;
    if ((!state.enabled && !manual) || state.status === 'error' || state.exhausted) return;
    const snapshot = queueSnapshot();
    if (!shouldPrefetchRandomRoam({ randomRoam: state, playlist: snapshot.queue, currentSong: snapshot.currentSong, lastHandledManualNonce })) return;
    const payload = buildRandomRoamPayload(state, snapshot.queue, snapshot.currentSong);
    const key = [state.language, state.batchSize, snapshot.currentSong?.id || '', payload.queuedSongIds.join(','), state.manualNonce, state.retryNonce].join(':');
    if (key === lastRequestKey) return;
    const generation = ++serial;
    const controller = new AbortController(); request = controller;
    lastRequestKey = key; lastHandledManualNonce = state.manualNonce;
    const language = state.language;
    emit({ status: 'loading', error: null });
    let timedOut = false;
    const timer = setTimeoutImpl(() => {
      timedOut = true; controller.abort();
      if (isCurrent() && generation === serial) {
        serial++; request = null; requestTimer = null;
        emit({ status: 'error', error: '续播请求超时，请重试' });
      }
    }, timeoutMs);
    requestTimer = timer;
    try {
      const response = await host.request('sample', { method: 'POST', body: payload, signal: controller.signal });
      if (!isCurrent() || controller.signal.aborted || generation !== serial || language !== state.language) return;
      const result = normalizeRandomRoamResponse(response);
      const songs = playable(result.songs.map(song => host.catalog?.hydrateSong ? host.catalog.hydrateSong(song) : song));
      const { played } = splitRoamQueue(snapshot.queue, snapshot.currentSong, state.waitingAtQueueEnd);
      const recentSongIds = recentRoamIds([...state.recentSongIds, ...played.map(song => song.id)]);
      const resume = state.waitingAtQueueEnd && state.resumeWhenAppended;
      suppressPump++;
      let applied;
      try {
        applied = host.queue.append(songs, { expectedCurrentSongId: snapshot.currentSong?.id ?? null,
          expectedRevision: snapshot.revision, resume, relocatePlayedDuplicates: result.strategy === 'recent' });
      } finally { suppressPump--; }
      if (!isCurrent() || generation !== serial) return;
      if (!applied || applied.stale) { emit({ status: 'idle' }); lastRequestKey = ''; return; }
      const additions = applied.added || [];
      const after = applied.snapshot || queueSnapshot();
      const exhausted = result.exhausted === true;
      const ended = state.waitingAtQueueEnd && !additions.length && exhausted;
      emit({ status: ended ? 'exhausted' : 'idle', error: null, enabled: ended ? false : state.enabled,
        totalPlayable: result.totalPlayable, remainingPlayable: result.remainingPlayable, exhausted,
        seenSongIds: normalizeRandomRoamSongIds([...state.seenSongIds, ...after.queue.map(song => song.id)]),
        recentSongIds, recentWindow: result.recentWindow,
        saturatedAtSongId: result.remainingPlayable === 0 ? after.currentSong?.id ?? null : null,
        saturatedQueueKey: result.remainingPlayable === 0 ? splitRoamQueue(after.queue, after.currentSong).queued.map(song => String(song.id)).join(',') : '',
        waitingAtQueueEnd: !ended && state.waitingAtQueueEnd && !additions.length,
        resumeWhenAppended: !ended && state.resumeWhenAppended && !additions.length });
      if (additions.length) lastRequestKey = '';
    } catch (error) {
      if (!isCurrent() || generation !== serial || (controller.signal.aborted && !timedOut)) return;
      emit({ status: 'error', error: errorMessage(error) });
    } finally {
      clearTimeoutImpl(timer);
      if (requestTimer === timer) requestTimer = null;
      if (request === controller) { request = null; kick(); }
    }
  }
  const controller = {
    isCurrent,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start() {
      if (started || !isCurrent()) return false;
      started = true;
      cleanup.push(host.queue.subscribe(kick));
      cleanup.push(host.queue.registerContinuation({
        onQueueEnd() {
          if (!ready() || !state.enabled) return false;
          if (state.exhausted) { reset({ status: 'exhausted', exhausted: true }); return true; }
          emit({ waitingAtQueueEnd: true, resumeWhenAppended: true, retryNonce: state.retryNonce + 1 });
          return true;
        },
        onQueueCleared: disable,
        onExplicitPlay: disable,
        onPause() { if (isCurrent()) emit({ resumeWhenAppended: false }); },
        onModeChange(snapshot) { if (snapshot.playMode !== 'sequence') disable(); },
      }));
      const abort = () => controller.dispose();
      host.signal?.addEventListener('abort', abort, { once: true });
      cleanup.push(() => host.signal?.removeEventListener('abort', abort));
      return true;
    },
    setLanguage(value) {
      if (!ready()) return false;
      const language = normalizeRoamLanguage(value);
      if (language === state.language) return true;
      cancel(); suppressPump++;
      try { if (state.enabled) host.queue.trimAfterCurrent(); }
      finally { suppressPump--; }
      const snapshot = queueSnapshot();
      emit({ language, status: 'idle', error: null, exhausted: false, totalPlayable: null, remainingPlayable: null,
        seenSongIds: normalizeRandomRoamSongIds(snapshot.queue.map(song => song.id)), saturatedAtSongId: null,
        retryNonce: state.retryNonce + 1 });
      preferences.save(state); return true;
    },
    setBatchSize(value) {
      if (!ready()) return false;
      const batchSize = Number.isInteger(value) && value >= 1 ? Math.min(value, 50) : 10;
      if (batchSize !== state.batchSize) { cancel(); emit({ batchSize, status: 'idle', error: null }); preferences.save(state); }
      return true;
    },
    setEnabled(enabled, options = {}) {
      if (!ready()) return false;
      if (!enabled) return disable();
      cancel(); suppressPump++;
      try { host.queue.setSequence(); }
      finally { suppressPump--; }
      const snapshot = queueSnapshot();
      emit({ ...createInactiveRandomRoam(), language: normalizeRoamLanguage(options.language || state.language),
        batchSize: state.batchSize, manualNonce: state.manualNonce, enabled: true, waitingAtQueueEnd: !snapshot.queue.length,
        resumeWhenAppended: !snapshot.queue.length, seenSongIds: normalizeRandomRoamSongIds(snapshot.queue.map(song => song.id)) });
      preferences.save(state); return true;
    },
    startWithSongs(songs, options = {}) {
      if (!ready()) return false;
      const queue = playable(songs);
      if (!queue.length) return false;
      cancel(); suppressPump++;
      let startedQueue;
      try { startedQueue = host.queue.start(queue); }
      finally { suppressPump--; }
      if (!startedQueue) return false;
      emit({ ...createInactiveRandomRoam(), language: normalizeRoamLanguage(options.language || state.language),
        batchSize: state.batchSize, manualNonce: state.manualNonce, enabled: true, seenSongIds: normalizeRandomRoamSongIds(queue.map(song => song.id)) });
      preferences.save(state); return true;
    },
    requestManual() {
      if (!ready()) return false;
      cancel(); suppressPump++;
      try { host.queue.setSequence(); } finally { suppressPump--; }
      const empty = !queueSnapshot().queue.length;
      emit({ status: 'idle', error: null, exhausted: false, manualNonce: state.manualNonce + 1,
        retryNonce: state.retryNonce + 1, enabled: empty || state.enabled,
        waitingAtQueueEnd: empty || state.waitingAtQueueEnd, resumeWhenAppended: empty || state.resumeWhenAppended });
      return true;
    },
    retry() {
      if (!ready() || (!state.enabled && state.status !== 'error')) return false;
      cancel(); emit({ status: 'idle', error: null, retryNonce: state.retryNonce + 1,
        manualNonce: state.enabled ? state.manualNonce : state.manualNonce + 1 }); return true;
    },
    resetHistory() {
      if (!ready()) return false;
      cancel(); emit({ status: 'idle', error: null, exhausted: false, totalPlayable: null, remainingPlayable: null,
        seenSongIds: [], recentSongIds: [], saturatedAtSongId: null, retryNonce: state.retryNonce + 1 }); return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true; cancel();
      for (const stop of cleanup.splice(0)) stop?.();
      state = Object.freeze({ ...createInactiveRandomRoam(), language: state.language, batchSize: state.batchSize, available: false });
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
  return controller;
}
