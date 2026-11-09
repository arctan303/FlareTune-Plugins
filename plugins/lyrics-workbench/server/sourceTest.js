import { InstanceAdminError, requireActiveAdmin } from "@flaretune/plugin-sdk/server/admin-common";
import { normalizeLyricSources } from "@flaretune/plugin-sdk/server/lyric-source-contract";
import { createLyricSourceLoader, LyricSourceError } from "@flaretune/plugin-sdk/server/lyric-sources";

function validateInput(input) {
  const source = input?.source, song = input?.song;
  if (!input || Object.keys(input).some(key => !['source', 'song'].includes(key))
    || !source || Array.isArray(source) || Object.keys(source).length !== 4
    || Object.keys(source).some(key => !['protocol', 'searchUrl', 'downloadUrl', 'translationLanguage'].includes(key))
    || !['custom_krc', 'custom_lrc'].includes(source.protocol)
    || !song || Array.isArray(song) || Object.keys(song).some(key => !['title', 'artist', 'duration'].includes(key))
    || ['title', 'artist'].some(key => typeof song[key] !== 'string' || !song[key].trim()
      || song[key].length > 300 || /[\u0000-\u001f\u007f]/u.test(song[key]))
    || (song.duration !== undefined && (!Number.isFinite(song.duration) || song.duration <= 0 || song.duration > 86400))) {
    throw new InstanceAdminError('invalid_input', 400);
  }
  let config;
  try {
    config = normalizeLyricSources({ [source.protocol]: { enabled: true,
      searchUrl: source.searchUrl, downloadUrl: source.downloadUrl, translationLanguage: source.translationLanguage } });
  } catch { throw new InstanceAdminError('invalid_input', 400); }
  return { protocol: source.protocol, config, song: { ...song, title: song.title.trim(), artist: song.artist.trim() } };
}

// A draft probe uses the playback adapters, but never reads or writes settings,
// candidate receipts, lyric assets, AI jobs or the playback source cache.
export async function testLyricSource(db, actorAccountId, input, {
  fetchImpl = (url, init) => fetch(url, init), signal, budgetMs = 20_000,
} = {}) {
  await requireActiveAdmin(db, actorAccountId);
  const { protocol, config, song } = validateInput(input);
  const startedAt = Date.now(), controller = new AbortController();
  let expired = false, stage = 'search', candidateCount = 0, requestCount = 0;
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, budgetMs);
  const summary = result => ({ ...result, candidateCount, elapsedMs: Date.now() - startedAt });
  const failure = error => summary({ status: 'failed', stage,
    kind: expired ? 'timeout' : error instanceof LyricSourceError ? error.kind : 'upstream' });
  try {
    const loader = createLyricSourceLoader({ sources: config, fetchImpl: (url, init) => {
      if (++requestCount > 16) throw new LyricSourceError('rate_limited', protocol, 'budget', 'Probe request budget exceeded');
      return fetchImpl(url, init);
    } });
    const snapshot = await loader.createCandidateInspectionSnapshot(protocol, song, { signal: controller.signal });
    candidateCount = snapshot.providerLyricIds.length;
    if (!candidateCount) return summary({ status: 'no_matches', stage: 'search' });
    stage = 'download';
    let lastError;
    for (const id of snapshot.providerLyricIds.slice(0, 3)) {
      try {
        const document = await snapshot.loadDocument(id, { signal: controller.signal });
        return summary({ status: 'ready', stage: 'parse', syncMode: document.syncMode,
          lineCount: document.lines.length, hasTranslation: document.lines.some(line => Boolean(line.tlyric)) });
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break;
      }
    }
    if (/parse|decode/u.test(lastError?.stage || '')) stage = 'parse';
    return failure(lastError);
  } catch (error) { return failure(error); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
