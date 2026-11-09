import { bindLyricsWorkspaceHost, createLyricsWorkspaceApi } from './api.js';
export function startLyricsWorkbenchRuntime(host) {
  const unbind = bindLyricsWorkspaceHost(host);
  const api = createLyricsWorkspaceApi(host);
  const retire = host.contributions.register('translation-completion', {
    getSnapshot: () => ({ available: host.features.isAvailable('ai') }),
    actions: { complete: songId => api.completeLyricsTranslation(songId) },
  });
  return () => { retire(); unbind(); };
}