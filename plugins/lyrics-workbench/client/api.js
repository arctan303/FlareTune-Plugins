import { modelErrorMessage } from './modelError.js';
export const LYRIC_OFFSET_MIN = -5000;
export const LYRIC_OFFSET_MAX = 5000;
export function clampLyricOffset(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(LYRIC_OFFSET_MAX, Math.max(LYRIC_OFFSET_MIN, Math.round(numeric))) : 0;
}
export class LyricsWorkspaceError extends Error {
  constructor(message, { status, code, data } = {}) { super(message); this.status = status; this.code = code; this.data = data; }
}
const inactive = () => new LyricsWorkspaceError('此插件尚未安装，请联系管理员。', { status: 409, code: 'PLUGIN_NOT_INSTALLED' });
export function createLyricsWorkspaceApi(host) {
  const request = async (path, { method = 'GET', body, query, signal } = {}) => {
    if (!host?.isCurrent()) throw inactive();
    const session = host.session.get();
    const memberAction = method === 'POST' && ['/candidates/inspect', '/ai-completion'].some(suffix => path.endsWith(suffix));
    if (method !== 'GET' && !memberAction && session?.user?.role !== 'admin') {
      throw new LyricsWorkspaceError('只有管理员可以修改共享歌词。', { status: 403, code: 'FORBIDDEN' });
    }
    if (['/ai-completion', '/draft-ai'].some(suffix => path.endsWith(suffix)) && !host.features.isAvailable('ai')) {
      const code = 'PLUGIN_DEPENDENCY_UNAVAILABLE';
      throw new LyricsWorkspaceError(modelErrorMessage({ code }), { status: 409, code });
    }
    let result;
    try { result = await host.request(path, { method, ...(body === undefined ? {} : { body }), query, signal }); }
    catch (error) { const message = modelErrorMessage(error); if (message) throw new LyricsWorkspaceError(message, { status: error.status, code: error.code, data: error.data }); throw error; }
    if (!host.isCurrent()) throw inactive();
    return result;
  };
  const path = songId => `workspace/${encodeURIComponent(songId)}`;
  return Object.freeze({
    getSources: () => request('sources'),
    getLyrics: songId => request(path(songId)),
    getLyricsCandidates: (songId, options = {}) => request(`${path(songId)}/candidates`, {
      signal: options.signal, query: Object.fromEntries(Object.entries({ title: options.title, artist: options.artist,
        source: options.source === 'all' ? undefined : options.source }).filter(([, value]) => value)) }),
    inspectLyricsCandidates: (songId, candidates, options = {}) => request(`${path(songId)}/candidates/inspect`, {
      method: 'POST', signal: options.signal, body: { candidates,
        ...(options.title ? { searchTitle: options.title } : {}), ...(options.artist ? { searchArtist: options.artist } : {}) } }),
    updateLyrics: (songId, selection, options = {}) => request(path(songId), { method: 'PUT', body: {
      source: selection.source, providerLyricId: selection.providerLyricId ?? null, etag: selection.etag ?? null,
      ...(selection.searchTitle || options.title ? { searchTitle: selection.searchTitle || options.title } : {}),
      ...(selection.searchArtist || options.artist ? { searchArtist: selection.searchArtist || options.artist } : {}) } }),
    updateLyricsOffset: (songId, offset) => request(`${path(songId)}/offset`, { method: 'PATCH', body: {
      offsetMs: clampLyricOffset(offset.offsetMs), etag: offset.etag ?? null } }),
    shiftLyricsTimeline: (songId, { deltaMs, etag }) => request(`${path(songId)}/timeline`, { method: 'PATCH', body: { deltaMs, etag } }),
    saveLyricsDocument: (songId, { lines, etag, aiReceipt, translationLanguage }) => request(`${path(songId)}/document`, {
      method: 'PUT', body: { lines, etag, ...(aiReceipt ? { aiReceipt } : {}), ...(translationLanguage ? { translationLanguage } : {}) } }),
    completeDraftLyrics: (songId, { lines, etag, translationLanguage }) => request(`${path(songId)}/draft-ai`, {
      method: 'POST', body: { lines, etag, ...(translationLanguage ? { translationLanguage } : {}) } }),
    importLyricsLrc: (songId, { lrc, etag }) => request(`${path(songId)}/import`, { method: 'POST', body: { lrc, etag } }),
    restoreLyricsBackup: (songId, { asset, etag }) => request(`${path(songId)}/restore`, { method: 'POST', body: { asset, etag } }),
    resetLyrics: (songId, etag = null) => request(path(songId), { method: 'DELETE', body: { etag } }),
    completeLyricsTranslation: songId => request(`${path(songId)}/ai-completion`, { method: 'POST', body: {} }),
    clearLyricsTranslation: (songId, etag = null) => request(`${path(songId)}/translation`, { method: 'DELETE', body: { etag } }),
  });
}
let current = null;
export function bindLyricsWorkspaceHost(host) {
  const binding = { host, api: createLyricsWorkspaceApi(host) }; current = binding;
  return () => { if (current === binding) current = null; };
}
// Legacy player shortcuts are clients of the active plugin, never installers.
export const lyricsWorkspaceApi = new Proxy(Object.freeze({}), { get(_target, name) {
  return (...args) => {
    if (!current?.host.isCurrent() || typeof current.api[name] !== 'function') return Promise.reject(inactive());
    return current.api[name](...args);
  };
} });
