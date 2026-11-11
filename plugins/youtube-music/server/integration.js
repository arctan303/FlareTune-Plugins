import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { requirePluginSession } from "@flaretune/plugin-sdk/server/plugin-common";
import { getYouTubeBinding } from "./connection.js";
import { createYouTubeService } from "./service.js";
import { YouTubeError } from "./core.js";
import { loadYouTubeSettings } from "./settings.js";
import { handleLocalMusicReadRoute } from "@flaretune/plugin-sdk/server/music-catalog";
import { handleLocalAlbumReadRoute } from "@flaretune/plugin-sdk/server/album-catalog";
import { handleLocalMusicDiscoveryRoute } from "@flaretune/plugin-sdk/server/catalog-discovery";
import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { createLyricDocument } from "@flaretune/plugin-sdk/server/lyric-document";
import { externalMusicSchemaReady, loadExternalSongs, prepareExternalSongs } from "@flaretune/plugin-sdk/server/external-music-references";

const YT_SONG = /^yt:([A-Za-z0-9_-]{11})$/u;
const fail = (code, status = 409) => { throw new AuthError(code, status); };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const success = data => json({ code: 200, data });
const pageOf = url => {
  const limit = url.searchParams.get('limit') ?? '20', offset = url.searchParams.get('offset') ?? '0';
  if (!/^\d+$/u.test(limit) || !/^\d+$/u.test(offset) || +limit < 1 || +limit > 50 || +offset > 2000) fail('invalid_input', 400);
  return { limit: +limit, offset: +offset };
};
const languageOf = url => {
  const hl = url.searchParams.get('hl');
  if (hl === null) return undefined;
  if (!/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(hl)) fail('invalid_input', 400);
  return hl;
};
const inactiveCodes = new Set(['PLUGIN_NOT_INSTALLED', 'PLUGIN_NOT_FOUND', 'PLUGIN_UNAVAILABLE', 'YOUTUBE_NOT_CONNECTED']);
const codeOf = error => error?.code || error?.message || '';

export async function createYouTubeAccess(env, session, ctx, { bindingFor = getYouTubeBinding,
  createService = createYouTubeService, checkSession = requirePluginSession, settingsFor = loadYouTubeSettings } = {}) {
  await checkSession(env, session);
  const binding = await bindingFor(env);
  const settings = await settingsFor(env.DB);
  const service = createService({ env, credentials: binding.credentials, epoch: binding.epoch, ctx, settings });
  const assertCurrent = async () => {
    await checkSession(env, session);
    const current = await bindingFor(env, { expectedEpoch: binding.record.epoch });
    if (current.epoch !== binding.epoch) fail('YOUTUBE_CONNECTION_CHANGED');
    return true;
  };
  return { service, assertCurrent, epoch: binding.epoch, settings };
}

export function youtubeLyricDependencies(env, session, ctx, options = {}) {
  // Capture this request's authority once. A later reconnect must not grant an
  // earlier metadata/AI request the new binding's permission to persist.
  let accessPromise;
  const requestAccess = () => accessPromise ||= (options.getAccess || createYouTubeAccess)(env, session, ctx);
  return {
    async fetchNativeDocument(song, { signal } = {}) {
      const match = YT_SONG.exec(song?.id);
      if (!match) return null;
      signal?.throwIfAborted();
      const access = await requestAccess();
      const result = await access.service.lyrics(match[1]);
      signal?.throwIfAborted();
      await access.assertCurrent();
      if (result?.status !== 'available' || !result.text?.trim()) return null;
      return createLyricDocument({ source: 'youtube', format: result.syncMode === 'line' ? 'lrc' : 'plain',
        lines: result.syncMode === 'line' && Array.isArray(result.lines) ? result.lines
          : result.text.split(/\r?\n/u).map(text => ({ text: text.trim() })).filter(line => line.text),
        providerMeta: { providerLyricId: song.id, matchedTitle: song.title,
          matchedArtist: song.artist, matchedDuration: song.duration, durationDelta: 0 } });
    },
    async resolveSong(id) {
      const match = YT_SONG.exec(id);
      if (!match) return null;
      const access = await requestAccess();
      const song = await access.service.song(match[1]);
      await access.assertCurrent();
      return song?.id === id ? song : null;
    },
    async songStillExists(id) {
      if (!YT_SONG.test(id)) return false;
      try {
        const access = await requestAccess();
        return await access.assertCurrent();
      } catch { return false; }
    },
  };
}

// Account-owned references contain only metadata obtained by this server. Keep
// one authority capture across resolving a batch and its eventual write check.
export function youtubeAccountMusicDependencies(env, session, ctx, options = {}) {
  let accessPromise;
  const requestAccess = () => accessPromise ||= (options.getAccess || createYouTubeAccess)(env, session, ctx);
  return {
    externalReferences: true,
    async resolveExternalSongs(ids, { partial = false } = {}) {
      if (!Array.isArray(ids) || ids.length > 500 || ids.some(id => !YT_SONG.test(id))) fail('invalid_input', 400);
      if (!ids.length) return [];
      const access = await requestAccess();
      const resolved = [];
      for (let at = 0; at < ids.length; at += 4) {
        const batch = ids.slice(at, at + 4);
        const songs = await Promise.allSettled(batch.map(id => access.service.song(id.slice(3))));
        for (let i = 0; i < songs.length; i++) {
          const result = songs[i];
          if (result.status !== 'fulfilled' || result.value?.id !== batch[i]) {
            if (partial) continue;
            if (result.status === 'rejected') throw result.reason;
            throw new YouTubeError('YOUTUBE_REFERENCE_UNAVAILABLE', 503);
          }
          resolved.push(result.value);
        }
      }
      await access.assertCurrent();
      return resolved;
    },
    async assertExternalCurrent() { return (await requestAccess()).assertCurrent(); },
  };
}

async function rememberPlayedReference(env, session, ctx, access, id) {
  if (!env.DB?.prepare || !await externalMusicSchemaReady(env.DB)) return;
  const deps = youtubeAccountMusicDependencies(env, session, ctx, { getAccess: async () => access });
  const prepared = await prepareExternalSongs(env.DB, session.account.accountId, ['yt:' + id], Date.now(), deps);
  await prepared.assertCurrent();
  if (prepared.statements.length) await env.DB.batch(prepared.statements);
}

export async function handleYouTubeMusicRoute(request, url, env, session, ctx, options = {}) {
  const getAccess = options.getAccess || createYouTubeAccess;
  const path = url.pathname;
  const isSearch = request.method === 'GET' && (path === '/api/songs/search' || path === '/api/artists' || path === '/api/albums')
    && Boolean((url.searchParams.get('q') || '').trim());
  const detail = request.method === 'GET' && /^\/api\/(songs|artists|albums)\/([^/]+)$/u.exec(path);
  let id;
  try { id = detail ? decodeURIComponent(detail[2]) : null; } catch { return null; }
  const external = detail && id.startsWith('yt:');
  const isResolve = request.method === 'POST' && path === '/api/songs/resolve';
  if (!isSearch && !external && !isResolve) return null;
  if (!session?.account?.accountId || session.mode !== 'normal') return json({ error: 'authentication_required' }, 401);
  if (isSearch) {
    const local = await (options.localRead || (path === '/api/songs/search' ? handleLocalMusicReadRoute : handleLocalAlbumReadRoute))(
      request, url, env.DB, {}, session.account.accountId);
    if (!local?.ok) return local;
    const payload = await local.json();
    if (!payload.data) return json(payload);
    const field = path === '/api/songs/search' ? 'songs' : path === '/api/artists' ? 'artists' : 'albums';
    const page = pageOf(url), localItems = payload.data[field] || [];
    let remote = [], remoteHasMore = false, warning;
    try {
      const access = await getAccess(env, session, ctx);
      const language = url.searchParams.get('language');
      if (language && language !== 'all') {
        // YouTube does not provide a reliable song-language field. Preserve the
        // host's explicit filter rather than pretending hl identifies the song.
        return success({ ...payload.data, sourceWarnings: [{ source: 'youtube', code: 'language_filter' }] });
      }
      const result = await access.service.search(url.searchParams.get('q').trim(), {
        filter: field === 'songs' ? 'song' : field === 'artists' ? 'artist' : 'album', hl: languageOf(url), ...page });
      await access.assertCurrent();
      remote = (result[field] || []).slice(page.offset, page.offset + page.limit);
      remoteHasMore = Boolean(result.hasMore);
    } catch (error) {
      if (inactiveCodes.has(codeOf(error))) return json(payload);
      warning = { source: 'youtube', code: /429|RATE|rate/u.test(codeOf(error)) ? 'rate_limited' : 'unavailable',
        ...(error instanceof YouTubeError ? { reason: error.code } : {}) };
    }
    return success({ ...payload.data, [field]: [...localItems, ...remote],
      hasMore: Boolean(payload.data.hasMore ?? localItems.length === page.limit) || remoteHasMore,
      nextOffset: page.offset + page.limit,
      ...(warning ? { sourceWarnings: [warning] } : {}) });
  }
  if (isResolve) {
    const body = await readBoundedJson(request.clone(), 65536);
    if (!Array.isArray(body.song_ids) || !body.song_ids.some(id => typeof id === 'string' && id.startsWith('yt:'))) return null;
    if (!body.song_ids.length || body.song_ids.length > 500 || body.song_ids.some(id => typeof id !== 'string' || !id || id.length > 80)) fail('invalid_input', 400);
    const ids = [...new Set(body.song_ids)];
    const ytIds = ids.filter(id => YT_SONG.test(id));
    if (ytIds.length > 50) fail('invalid_input', 400);
    const localIds = ids.filter(id => !id.startsWith('yt:'));
    const found = new Map();
    if (localIds.length) {
      const input = new Request(request, { body: JSON.stringify({ song_ids: localIds }) });
      const local = await (options.localResolve || handleLocalMusicDiscoveryRoute)(input, url, env.DB, {}, session.account.accountId);
      if (!local.ok) return local;
      for (const song of (await local.json()).data.songs) found.set(song.id, song);
    }
    // Source outages must not erase a saved personal-library reference. A
    // snapshot is visible only to the account that originally saved it.
    if (env.DB?.prepare) for (const song of await loadExternalSongs(env.DB, session.account.accountId, ytIds)) {
      found.set(song.id, { ...song, sourceUnavailable: true });
    }
    try {
      const access = await getAccess(env, session, ctx);
      const live = new Map();
      // Keep the resolver's upstream concurrency bounded for restored queues.
      for (let at = 0; at < ytIds.length; at += 4) {
        const values = await Promise.allSettled(ytIds.slice(at, at + 4).map(id => access.service.song(id.slice(3))));
        for (const value of values) if (value.status === 'fulfilled' && ytIds.includes(value.value?.id)) live.set(value.value.id, value.value);
      }
      await access.assertCurrent();
      for (const [id, song] of live) found.set(id, song);
    } catch { /* Keep only account-owned snapshots when live authority is unavailable. */ }
    return success({ songs: ids.map(id => found.get(id)).filter(Boolean), missing_ids: ids.filter(id => !found.has(id)) });
  }
  const access = await getAccess(env, session, ctx), hl = languageOf(url);
  let data;
  if (detail[1] === 'songs' && YT_SONG.test(id)) data = await access.service.song(id.slice(3), { hl });
  else if (detail[1] === 'albums' && /^yt:album:MPREb_[\w-]+$/u.test(id)) data = await access.service.album(id.slice(9), { hl });
  else if (detail[1] === 'artists' && /^yt:artist:UC[\w-]+$/u.test(id)) {
    const page = pageOf(url);
    const result = await access.service.artist(id.slice(10), { hl, ...page });
    const songs = result.songs || [];
    data = { ...result, songs: songs.slice(page.offset, page.offset + page.limit),
      total: songs.length, songCount: songs.length, hasMore: Boolean(result.hasMore),
      nextOffset: page.offset + page.limit };
  } else fail('invalid_input', 400);
  await access.assertCurrent();
  return success(data);
}

export async function handleYouTubeMedia(request, pathname, env, session, ctx, options = {}) {
  if (!pathname.startsWith('/media/youtube/')) return null;
  const denied = status => new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } });
  if (!['GET', 'HEAD'].includes(request.method)) return denied(405);
  try {
    const audio = /^\/media\/youtube\/audio\/([A-Za-z0-9_-]{11})$/u.exec(pathname);
    const image = pathname === '/media/youtube/image';
    if (!audio && !image) return denied(404);
    const access = await (options.getAccess || createYouTubeAccess)(env, session, ctx);
    let response;
    if (audio && env.YTM_RUNTIME) {
      const target = new URL('https://youtube-runtime.internal/audio/' + audio[1]);
      const incoming = new URL(request.url);
      for (const name of ['codec', 'itag']) if (incoming.searchParams.has(name)) target.searchParams.set(name, incoming.searchParams.get(name));
      const headers = new Headers({ 'X-FlareTune-YT-Epoch': access.epoch });
      for (const name of ['Range', 'If-Range', 'User-Agent']) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      const actor = env.YTM_RUNTIME.get(env.YTM_RUNTIME.idFromName('youtube:' + access.epoch));
      response = await actor.fetch(target.href, { method: request.method, headers, signal: request.signal });
    } else response = audio ? await access.service.stream(request, audio[1])
      : await access.service.image(request, new URL(request.url).searchParams.get('url'));
    try { await access.assertCurrent(); }
    catch (error) { await response.body?.cancel(); throw error; }
    if (audio && request.method === 'GET' && [200, 206].includes(response.status)) {
      // Register a trusted playback reference before a later statistics flush.
      // Never make an auxiliary metadata/storage outage interrupt the song.
      try { await rememberPlayedReference(env, session, ctx, access, audio[1]); }
      catch { /* A missing reference remains a retryable statistics item. */ }
      try { await access.assertCurrent(); }
      catch (error) { await response.body?.cancel(); throw error; }
    }
    const headers = new Headers(response.headers);
    headers.delete('Location');
    headers.set('Cache-Control', image ? 'private, max-age=3600' : 'private, no-store');
    headers.set('Vary', 'Cookie'); headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } catch (error) {
    const response = denied(error instanceof AuthError || error instanceof YouTubeError ? error.status : 502);
    if (error instanceof YouTubeError) response.headers.set('X-FlareTune-Source-Error', error.code);
    return response;
  }
}
