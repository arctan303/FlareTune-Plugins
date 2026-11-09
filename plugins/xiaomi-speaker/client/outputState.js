import { create } from 'zustand';

let controls = null;
export function bindSpeakerOutputControls(next) {
  controls = next;
  return () => { if (controls === next) controls = null; };
}

// Output is deliberately session-local. A reload must not start a speaker.
export const useSpeakerOutputStore = create((set, get) => ({
  enabled: false, speakerId: '', deviceName: '', busy: false, error: '',
  phase: 'off', canDetach: false, speakerVolume: 0.5,
  setSpeakerVolume(value) {
    if (!get().enabled || !Number.isFinite(value)) return;
    const volume = Math.max(0, Math.min(1, value));
    set({ speakerVolume: volume });
    controls?.volume(volume);
  },
  setTarget(device) {
    if (get().enabled || get().busy) return;
    set({ speakerId: device?.id || '', deviceName: device?.name || '', error: '' });
  },
  enable: () => controls?.enable() || Promise.resolve(false),
  disable: () => controls?.disable() || Promise.resolve(false),
}));
