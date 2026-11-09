import { useEffect } from 'react';
import { useSpeakerOutputStore, bindSpeakerOutputControls } from "./outputState.js";
import { createSpeakerSessionGuard, speakerRequest, speakerErrorMessage } from "./speakers.js";
import { createSpeakerMirror } from "./speakerMirror.js";

export function useSpeakerOutput(host) { useEffect(() => mountSpeakerOutput(host), [host]); }

export function mountSpeakerOutput(host) {
  const target = host.outputTargets.register();
  const audioRef = { current: target.clock };
  const mirrorRef = { current: null }, guardRef = { current: null };
    let live = true;
    const output = useSpeakerOutputStore;
    const mountedAccount = host.session.get()?.user?.accountId;
    function release() {
      guardRef.current?.close(); guardRef.current = null;
      mirrorRef.current?.dispose(); mirrorRef.current = null;
    }
    const restoreLocalAudio = options => target.restoreLocal(options);
    // The mirror stays suspended after an external takeover or a lost binding,
    // even when a later ordinary polling error replaces the visible phase.
    const detachedFromDevice = () => output.getState().canDetach || output.getState().phase === 'suspended'
      || Boolean(mirrorRef.current?.isSuspended());
    function detachPlugin(message = '插件已卸载，音箱输出已关闭。') {
      release();
      restoreLocalAudio({ quiet: true });
      output.setState({ enabled: false, speakerId: '', deviceName: '', busy: false, phase: 'off',
        error: message });
    }
    const controls = {
      async enable() {
        const selected = output.getState();
        if (selected.enabled || selected.busy || !selected.speakerId || !audioRef.current) return false;
        if (!target.canClaim() || !host.isCurrent()) return false;
        if (!host.session.get()?.authenticated) return false;
        release();
        const guard = createSpeakerSessionGuard(host);
        guardRef.current = guard;
        const request = async (action, body) => {
          try {
            return await guard.run(signal => speakerRequest(action, host,
              { speakerId: selected.speakerId, ...body }, { signal }));
          } catch (error) {
            if (['PLUGIN_NOT_INSTALLED', 'PLUGIN_BUILD_MISMATCH'].includes(error?.code) && guardRef.current === guard && guard.isCurrent()) {
              detachPlugin(error.code === 'PLUGIN_BUILD_MISMATCH' ? '插件版本与当前网页不兼容，请刷新网页后重试。' : undefined);
            }
            throw error;
          }
        };
        output.setState({ busy: true, phase: 'sending', error: '' });
        try {
          const ready = await request('status');
          const device = ready.devices?.find(item => item.id === selected.speakerId && item.supported);
          if (!device) throw Object.assign(new Error(), { code: 'SPEAKER_NOT_FOUND' });
          const state = await request('state'); guard.assertCurrent();
          if (!live) return false;
          const mirror = createSpeakerMirror({ audio: audioRef.current, getPlayer: () => host.player.getSnapshot(), request,
            onState(patch) { if (live && guard.isCurrent()) output.setState(patch); } });
          mirrorRef.current = mirror;
          if (!target.muteLocal()) throw new Error("Output unavailable");
          output.setState({ enabled: true, deviceName: device.name, busy: false, phase: 'ready', error: '', canDetach: false,
            ...(Number.isFinite(state.playback?.volume) ? { speakerVolume: state.playback.volume / 100 } : {}) });
          // Native audio remains the clock, while only the selected output is
          // audible. The normal volume control targets the speaker in this mode.
          if (!audioRef.current.paused) await mirror.play();
          return true;
        } catch (error) {
          if (guard.isCurrent()) {
            release(); restoreLocalAudio({ quiet: true });
            output.setState({ enabled: false, busy: false, phase: 'disconnected',
              error: speakerErrorMessage(error.code) || '音箱连接异常，请检查连接后重试。' });
          }
          return false;
        }
      },
      async disable() {
        if (!mirrorRef.current || output.getState().busy) return false;
        const guard = guardRef.current, mirror = mirrorRef.current;
        const detachedBeforeStop = detachedFromDevice();
        if (!output.getState().canDetach && !await mirror.stop()) return false;
        if (!live || guardRef.current !== guard || !guard?.isCurrent()) return false;
        // stop() waits behind any in-flight state read. When that read finds
        // another source or a lost binding, stop skips the device command and
        // the device is still playing, so local sound must stay paused.
        const quiet = detachedBeforeStop || detachedFromDevice();
        release();
        restoreLocalAudio({ quiet });
        output.setState({ enabled: false, busy: false, phase: 'off', error: '' });
        return true;
      },
      volume(value) { mirrorRef.current?.volume(value); },
    };
    const unbind = bindSpeakerOutputControls(controls);
    const publish = () => { const state = output.getState(); target.publish(state.enabled ? { id: `speaker:${state.speakerId}`, name: state.deviceName, volume: state.speakerVolume, error: state.error, write: state.setSpeakerVolume, fallback: 0.5 } : null); };
    const unsubOutput = output.subscribe(publish); publish();
    const unsub = host.session.subscribe(() => { if (!host.isCurrent()) detachPlugin(''); });
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden' && mirrorRef.current) void mirrorRef.current.poll();
    }, 15_000);
    return () => {
      live = false; unbind(); unsub(); clearInterval(timer); release();
      restoreLocalAudio({ quiet: true });
      // The host can retire this runtime from an earlier account-change
      // listener, which removes the subscriber above before it runs. Device
      // selections and messages never carry over to another identity.
      const identityChanged = host.session.get()?.user?.accountId !== mountedAccount;
      output.setState({ enabled: false, busy: false, phase: 'off',
        ...(identityChanged ? { speakerId: '', deviceName: '', error: '', canDetach: false } : {}) });
      unsubOutput(); target.dispose();
    };
}
