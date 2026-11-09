import { normalizeRoamLanguage } from "./algorithms.js";

export const normalizeRoamPreferences = value => ({
  language: normalizeRoamLanguage(value?.language),
  batchSize: Number.isInteger(value?.batchSize) && value.batchSize >= 1 ? Math.min(value.batchSize, 50) : 10,
});

export function createRoamPreferences(host, { storage } = {}) {
  if (storage === undefined) try { storage = globalThis.localStorage; } catch { /* Storage may be blocked. */ }
  const accountId = host.session?.get()?.user?.accountId;
  const key = accountId ? `flaretune.plugin.roam.preferences.${encodeURIComponent(accountId)}` : null;
  const load = () => {
    if (key) try {
      const serialized = storage?.getItem(key);
      if (serialized && serialized.length <= 4096) return normalizeRoamPreferences(JSON.parse(serialized));
    } catch { /* Private browsing or malformed data must not reset playback. */ }
    return normalizeRoamPreferences(host.queue.getLegacyPreferences?.());
  };
  const save = value => {
    if (!key || !host.isCurrent()) return;
    try { storage?.setItem(key, JSON.stringify(normalizeRoamPreferences(value))); } catch { /* Preferences are optional. */ }
  };
  return { load, save };
}
