import { isTranslationTarget } from '../shared/translation-languages.js';
import { markManuallySelectedArtifact } from './sourceCore.js';
import {
  fetchLyricsDocumentWithFallback,
  fetchUncachedSourceLyricsDocument,
  createSourceCandidateInspectionSnapshot,
  listSourceLyricCandidates,
  LyricSourceError,
} from "@flaretune/plugin-sdk/server/lyric-sources";
import { applyLyricOffset, listLyricsResolutionCandidates } from "@flaretune/plugin-sdk/server/lyric-resolution";
import { createLyricDocument, parseLrcDocument } from "@flaretune/plugin-sdk/server/lyric-document";
import {
  buildLyricArtifactMarker,
  LyricArtifactStoreError,
  normalizeLyricArtifactSongId,
  validateLyricArtifact,
  MAX_LYRIC_ARTIFACT_BYTES,
} from "@flaretune/plugin-sdk/server/lyric-assets";
import {
  buildEditedLyricArtifact,
  buildReadyLyricArtifact,
  lyricArtifactStoreForEnv,
  projectLyricArtifact,
  buildLyricTranslationDecision,
  LYRIC_TRANSLATION_POLICY_VERSION,
} from "@flaretune/plugin-sdk/server/lyric-workflow";
import { beginLyricAssetAiCompletion, safeLyricValidationDiagnostic } from "./translation.js";
import { publicBudgetErrorCode, publicRetryArtifact } from './automaticRetry.js';
import { completeLyricDraft } from "./draftAi.js";
import { verifyLyricDraftReceiptData } from "./draftReceipt.js";
import { loadLyricAiConfig, loadLyricAiProcessingSettings } from "./config.js";
import { lyricSourceLoaderForDb } from "@flaretune/plugin-sdk/server/lyric-source-settings";
import {
  inspectLyricCandidates,
  LYRIC_CANDIDATE_INSPECTION_LIMITS,
  LyricCandidateInspectionError,
} from "@flaretune/plugin-sdk/server/lyric-candidates";
import { readBoundedJson, jsonTaskResponse } from "@flaretune/plugin-sdk/server/http-security";
import { guardExternalLyricStore, lyricSongStillExists, resolveLyricSong } from "@flaretune/plugin-sdk/server/playback-lyrics";
import { storedLyricTranslationLanguage, isLyricSourceId } from "@flaretune/plugin-sdk/server/lyric-source-contract";
import { createPluginServiceLease } from "@flaretune/plugin-sdk/server/service-leases";
import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { pluginFail } from "@flaretune/plugin-sdk/server/plugin-common";
import { createLyricsAiAccess, guardLyricsStore } from "./aiAccess.js";

// Only the new account-gated workspace path is dispatched here. Origin and CSRF
// are verified by the outer router before any mutation reaches this module.
const BASE = /^\/api\/lyrics\/workspace\/([^/]+)$/u;
const CHILD = /^\/api\/lyrics\/workspace\/([^/]+)\/(candidates(?:\/inspect)?|offset|timeline|document|preview|import|restore|translation|ai-completion|draft-ai)$/u;
const SOURCE = { has: source => source === 'auto' || isLyricSourceId(source) };
const encoder = new TextEncoder();
const DOCUMENT_REQUEST_BYTES = 2 * MAX_LYRIC_ARTIFACT_BYTES + 64 * 1024;

function response(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers: {
    ...headers, 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}
const success = (data, status, headers) => response({ ok: true, code: status, data }, status, headers);
const failure = (status, error, message, headers, data) => response({
  ok: false, code: status, error, message, ...(data === undefined ? {} : { data }),
}, status, headers);

function parseSongId(encoded) {
  if (encoded.length > 384) return null;
  try { return normalizeLyricArtifactSongId(decodeURIComponent(encoded)); }
  catch { return null; }
}

function exactFields(body, allowed, required = []) {
  return Object.keys(body).every((key) => allowed.includes(key))
    && required.every((key) => Object.hasOwn(body, key));
}

async function bodyOf(request, allowed, required = [], maxBytes = 16 * 1024) {
  let body;
  try { body = await readBoundedJson(request, maxBytes); } catch { return null; }
  return exactFields(body, allowed, required) ? body : null;
}

function textOverride(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value.trim();
}

function searchSong(song, title, artist) {
  const searchTitle = textOverride(title);
  const searchArtist = textOverride(artist);
  if (searchTitle === null || searchArtist === null) return null;
  return { ...song, title: searchTitle || song.title, artist: searchArtist || song.artist };
}

const validEtag = (value) => value === null
  || (typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value));

const validTranslationLanguage = value => value === undefined || isTranslationTarget(value);

function withCleanupConsent(deps, cleanDirtyLyrics = false) {
  return { ...deps, lyricConfig: { ...deps.lyricConfig, cleanDirtyLyrics },
    ...(deps.aiAccess ? { aiAccess: { ...deps.aiAccess,
      config: { ...deps.aiAccess.config, cleanDirtyLyrics } } } : {}) };
}

function currentData(read, song, now, targetLanguage = null, viewerAccountId = null) {
  if (read.state === 'missing' || read.state === 'legacy' || read.artifact?.status === 'reset') {
    return { status: 'missing', etag: read.etag ?? null, asset: null, lyrics: null };
  }
  const asset = read.artifact.aiCompletion?.status === 'review'
    && read.artifact.aiCompletion.reviewAccountId !== viewerAccountId
    ? { ...read.artifact, aiCompletion: null } : read.artifact;
  return { status: read.artifact.status, etag: read.etag, asset: publicRetryArtifact(asset),
    lyrics: projectLyricArtifact(read.artifact, { song, now, targetLanguage }) };
}

function notDeleting(read) {
  if (read.state === 'found' && read.artifact.status === 'deleting') {
    throw new LyricArtifactStoreError('lyric_asset_deleting', 'get', 'Lyric asset is being deleted');
  }
  return read;
}

function matches(read, expected) {
  return validEtag(expected) && (read.state === 'missing' ? expected === null : read.etag === expected);
}

function safeCandidate(candidate) {
  if (!candidate || !SOURCE.has(candidate.source) || candidate.source === 'auto'
    || typeof candidate.providerLyricId !== 'string' || !candidate.providerLyricId
    || candidate.providerLyricId.length > 256) return null;
  const numeric = (value) => value === null || value === undefined || value === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    source: candidate.source,
    providerLyricId: candidate.providerLyricId,
    matchedTitle: String(candidate.matchedTitle || '').slice(0, 1000),
    matchedArtist: String(candidate.matchedArtist || '').slice(0, 1000),
    matchedAlbum: String(candidate.matchedAlbum || '').slice(0, 1000),
    matchedDuration: numeric(candidate.matchedDuration),
    durationDelta: numeric(candidate.durationDelta),
    score: numeric(candidate.score),
    versionMismatch: candidate.versionMismatch === true,
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings.map(String).slice(0, 8) : [],
  };
}

function validEditorLines(lines) {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 2000) return false;
  return lines.every((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)
      || Object.keys(line).some((key) => !['time', 'endTime', 'text', 'tlyric', 'words'].includes(key))
      || typeof line.text !== 'string' || !line.text.trim() || line.text.length > 4000
      || /\r/u.test(line.text)
      || (line.tlyric !== undefined && (typeof line.tlyric !== 'string'
        || line.tlyric.length > 4000 || /[\r\n]/u.test(line.tlyric)))) return false;
    if (line.time !== undefined && (!Number.isFinite(line.time) || line.time < 0 || line.time > 86400)) return false;
    if (line.endTime !== undefined && (!Number.isFinite(line.endTime)
      || line.time === undefined || line.endTime < line.time || line.endTime > 86400)) return false;
    return line.words === undefined || (Array.isArray(line.words) && line.words.length > 0
      && line.words.every((word) => word && typeof word.text === 'string'
        && Number.isFinite(word.startTime) && Number.isFinite(word.endTime)));
  });
}

function boundedInspection(inspected, headers) {
  const limit = LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes;
  const source = Array.isArray(inspected?.items) ? inspected.items : [];
  const items = source.slice(0, LYRIC_CANDIDATE_INSPECTION_LIMITS.maxCandidates);
  const compact = (item) => ({ source: String(item?.source || 'unknown').slice(0, 32),
    providerLyricId: String(item?.providerLyricId || 'unknown').slice(0, 256),
    state: 'error', error: { code: 'response_too_large' } });
  const results = items.map(compact);
  let truncated = Boolean(inspected?.truncated) || source.length > items.length;
  for (let index = 0; index < items.length; index += 1) {
    const fallback = results[index];
    results[index] = items[index];
    const candidate = { ok: true, code: 200, data: { results, truncated: true } };
    if (encoder.encode(JSON.stringify(candidate)).byteLength > limit) {
      results[index] = fallback;
      truncated = true;
    }
  }
  const data = { results, truncated };
  if (encoder.encode(JSON.stringify({ ok: true, code: 200, data })).byteLength > limit) {
    return failure(503, 'LYRIC_INSPECTION_UNAVAILABLE', 'Candidate inspection unavailable', headers);
  }
  return success(data, 200, headers);
}

function knownFailure(error, headers) {
  const modelError = error?.code || error?.message;
  if (['PLUGIN_UPDATE_REQUIRED', 'AI_PROVIDER_UNCONFIGURED', 'AI_PROVIDER_MISSING', 'AI_CONFIG_INVALID'].includes(modelError)) {
    return failure(503, modelError, modelError, headers);
  }
  if (error?.message === 'AI_ASSISTANT_CONFIG_UNAVAILABLE') {
    return failure(503, 'LYRIC_AI_CONFIG_UNAVAILABLE', 'Lyric AI settings unavailable', headers);
  }
  if (error instanceof LyricArtifactStoreError) {
    const invalid = error.code === 'invalid_stored_artifact';
    return failure(invalid ? 502 : 503, invalid ? 'INVALID_LYRIC_ASSET' : 'LYRIC_STORAGE_UNAVAILABLE',
      invalid ? 'Stored lyric asset is invalid' : 'Lyric storage unavailable', headers);
  }
  if (error instanceof LyricSourceError) {
    const invalid = error.kind === 'invalid' || error.kind === 'not_found';
    return failure(invalid ? 422 : 503, invalid ? 'LYRIC_CANDIDATE_INVALID' : 'LYRIC_SOURCE_UNAVAILABLE',
      invalid ? 'Lyric candidate is unavailable' : 'Lyric source unavailable', headers);
  }
  if (error instanceof LyricCandidateInspectionError) {
    const invalid = ['duplicate_candidate', 'invalid_candidate', 'invalid_candidates', 'too_many_candidates'].includes(error.code);
    return failure(invalid ? 400 : 503, invalid ? 'INVALID_LYRIC_CANDIDATES' : 'LYRIC_INSPECTION_UNAVAILABLE',
      invalid ? 'Invalid lyric candidates' : 'Candidate inspection unavailable', headers);
  }
  return null;
}

async function writeCurrent(store, songId, artifact, current, etag) {
  artifact = markManuallySelectedArtifact(artifact);
  if (current.state === 'missing') return store.createIfAbsent(songId, artifact);
  return store.putIfMatch(songId, artifact, etag);
}

export async function handleLyricsWorkbenchRoute(request, url, db, headers = {}, session, env = {}, deps = {}) {
  const base = url.pathname.match(BASE);
  const child = url.pathname.match(CHILD);
  const sourcesRoute = url.pathname === '/api/lyrics/sources';
  if (!base && !child && !sourcesRoute) return null;
  const accountId = session?.account?.accountId;
  if (!accountId || session?.mode !== 'normal'
    || !['admin', 'member'].includes(session?.account?.role)) {
    return failure(401, 'UNAUTHORIZED', 'Normal local session required', headers);
  }
  if (!deps.context || typeof deps.context.requireRoles !== 'function') pluginFail('forbidden', 403);
  const assertCurrent = deps.assertCurrent || (() => deps.context.requireRoles(['admin', 'member']));
  if (!db?.prepare) return failure(503, 'DATABASE_UNAVAILABLE', 'Database unavailable', headers);
  if (sourcesRoute) {
    if (request.method !== 'GET') return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { ...headers, Allow: 'GET' });
    try {
      const loader = await lyricSourceLoaderForDb(db);
      return success({ sources: loader.enabledSources, details: loader.sourceDetails }, 200, headers);
    }
    catch { return failure(503, 'LYRIC_SOURCES_UNAVAILABLE', 'Lyric sources unavailable', headers); }
  }
  const songId = parseSongId((base || child)[1]);
  if (!songId) return failure(400, 'INVALID_SONG_ID', 'Invalid song ID', headers);
  if (url.searchParams.has('account_id') || url.searchParams.has('user_sub')) {
    return failure(400, 'INVALID_QUERY', 'Account identity is not accepted', headers);
  }
  const songOf = () => resolveLyricSong(db, songId, deps);
  const song = await songOf();
  if (!song) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
  const action = child?.[2] || 'asset';
  const method = request.method;
  const recognized = {
    asset: ['GET', 'PUT', 'DELETE'], candidates: ['GET'], 'candidates/inspect': ['POST'],
    offset: ['PATCH'], timeline: ['PATCH'], document: ['PUT'], preview: ['POST'], import: ['POST'], restore: ['POST'],
    translation: ['DELETE'], 'ai-completion': ['POST'], 'draft-ai': ['POST'],
  }[action];
  if (!recognized.includes(method)) return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', { ...headers, Allow: recognized.join(', ') });
  if (song.language === 'instrumental') {
    if (action === 'asset' && method === 'GET') return success({ song, status: 'not_needed', etag: null, asset: null, lyrics: null }, 200, headers);
    if (action === 'candidates') return success({ status: 'not_needed', candidates: [], warnings: [] }, 200, headers);
    if (action === 'candidates/inspect') return success({ status: 'not_needed', results: [], truncated: false }, 200, headers);
    return failure(422, 'LYRICS_NOT_NEEDED', 'Instrumental songs do not need lyrics', headers);
  }
  if (action === 'preview') {
    const body = await bodyOf(request, ['lrc', 'asset'], [], DOCUMENT_REQUEST_BYTES);
    if (!body || Object.keys(body).length !== 1) return failure(400, 'INVALID_LYRIC_PREVIEW', 'Preview accepts exactly one LRC or asset', headers);
    try {
      const settings = await loadLyricAiProcessingSettings(db);
      let artifact;
      if (Object.hasOwn(body, 'lrc')) {
        if (typeof body.lrc !== 'string') return failure(400, 'INVALID_LYRIC_PREVIEW', 'Invalid LRC preview', headers);
        const document = parseLrcDocument(body.lrc, { source: 'manual', format: 'lrc' });
        if (!document.lines.length) throw new RangeError('empty lyrics');
        artifact = (await buildReadyLyricArtifact(song, document, { now: Date.now(), targetLanguage: settings.targetLanguage })).artifact;
      } else artifact = body.asset;
      const validated = validateLyricArtifact(artifact, { expectedSongId: songId });
      if (!validated.valid || validated.artifact.status !== 'ready') return failure(422, 'INVALID_LYRIC_PREVIEW', 'Invalid lyric asset preview', headers);
      return success(currentData({ state: 'found', etag: null, artifact: { ...validated.artifact, aiCompletion: null } },
        song, Date.now(), settings.targetLanguage, session.account.accountId), 200, headers);
    } catch (error) {
      return knownFailure(error, headers) || failure(422, 'INVALID_LYRIC_PREVIEW', 'Lyrics cannot be previewed', headers);
    }
  }
  let store;
  try { store = guardLyricsStore(guardExternalLyricStore(deps.store || lyricArtifactStoreForEnv(env), songId,
    () => lyricSongStillExists(db, songId, deps)), assertCurrent); }
  catch (error) { return knownFailure(error, headers) || failure(503, 'LYRIC_STORAGE_UNAVAILABLE', 'Lyric storage unavailable', headers); }
  const now = deps.now || Date.now;
  try {
    let settings;
    try {
      settings = ['ai-completion', 'draft-ai'].includes(action)
        ? await (deps.aiDeps?.loadLyricAiConfig || loadLyricAiConfig)(db,
          deps.aiDeps?.getAIAssistantConfig ? { getLegacy: deps.aiDeps.getAIAssistantConfig } : {})
        : await loadLyricAiProcessingSettings(db);
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE');
    }
    if (settings.onlineEnabled === false && (['candidates', 'candidates/inspect'].includes(action) || action === 'asset' && method === 'PUT')) {
      return failure(409, 'LYRIC_ONLINE_DISABLED', 'Online lyric retrieval is disabled', headers);
    }
    const targetLanguage = settings.targetLanguage;
    let gatewayAvailable = false, aiLease = null;
    if (settings.completionEnabled) {
      try {
        if (deps.aiAvailable) gatewayAvailable = await deps.aiAvailable();
        else {
          aiLease = await createPluginServiceLease({ env, session, consumerId: 'lyrics-workbench', providerId: 'ai-gateway',
            consumerContext: deps.context, registry: deps.registry, admin: deps.aiDeps?.admin === true, authorization: 'request' });
          gatewayAvailable = true;
        }
      } catch (error) {
        if (error instanceof AuthError && error.status === 403) throw error;
        gatewayAvailable = false;
      }
    }
    const completionEnabled = settings.completionEnabled && gatewayAvailable;
    let aiDeps = withCleanupConsent({ ...deps.aiDeps, lyricConfig: settings, ...(aiLease ? { aiLease } : {}) });
    const resolvedAi = async taskSignal => {
      let scoped = { ...aiDeps, signal: taskSignal };
      if (aiLease && !scoped.aiAccess) {
        const access = await createLyricsAiAccess({ env, db, session, context: deps.context, signal: taskSignal, deps: scoped });
        scoped = withCleanupConsent({ ...scoped, aiAccess: access });
      }
      if (scoped.aiAccess) {
        deps.useAiLease?.(scoped.aiAccess.client);
        store = guardLyricsStore(guardExternalLyricStore(deps.store || lyricArtifactStoreForEnv(env), songId,
          () => lyricSongStillExists(db, songId, deps)), scoped.aiAccess.client.assertCurrent);
      }
      return scoped;
    };
    const dataOf = (read) => {
      const data = currentData(read, song, now(), targetLanguage, session.account.accountId);
      return !completionEnabled && data.lyrics && !data.lyrics.translationAvailable ? { ...data,
        lyrics: { ...data.lyrics, translationState: 'unavailable', translationStartedAt: null } } : data;
    };
    if (action === 'asset' && method === 'GET') {
      if ([...url.searchParams.keys()].length) return failure(400, 'INVALID_QUERY', 'Unexpected query', headers);
      const read = notDeleting(await store.get(songId));
      return success({ song, aiCompletionEnabled: completionEnabled,
        ...dataOf(read) }, 200, headers);
    }
    if (!completionEnabled && ['ai-completion', 'draft-ai'].includes(action)) {
      if (settings.completionEnabled && !gatewayAvailable) return failure(409, 'PLUGIN_DEPENDENCY_UNAVAILABLE', 'Lyric AI gateway is unavailable', headers);
      return failure(403, 'LYRIC_AI_DISABLED', 'Lyric AI completion is disabled', headers);
    }
    if (action === 'candidates') {
      if ([...url.searchParams.keys()].some((key) => !['title', 'artist', 'source'].includes(key))) {
        return failure(400, 'INVALID_QUERY', 'Unexpected query', headers);
      }
      const target = searchSong(song, url.searchParams.get('title') ?? undefined, url.searchParams.get('artist') ?? undefined);
      if (!target) return failure(400, 'INVALID_QUERY', 'Invalid search override', headers);
      const source = url.searchParams.get('source') || 'all';
      if (source !== 'all' && (!SOURCE.has(source) || source === 'auto')) {
        return failure(400, 'INVALID_QUERY', 'Invalid lyric source filter', headers);
      }
      const loader = deps.listCandidates || deps.listSourceCandidates ? null : await lyricSourceLoaderForDb(db);
      const found = await (deps.listCandidates || listLyricsResolutionCandidates)(target, {
        source, signal: request.signal, executionContext: deps.ctx, enabledSources: loader?.enabledSources,
        listCandidates: deps.listSourceCandidates || loader?.listSourceCandidates || listSourceLyricCandidates,
      });
      return success({ candidates: (found.candidates || []).map(safeCandidate).filter(Boolean),
        warnings: found.warnings || [] }, 200, headers);
    }
    if (action === 'candidates/inspect') {
      const body = await bodyOf(request, ['candidates', 'searchTitle', 'searchArtist'], ['candidates']);
      if (!body) return failure(400, 'INVALID_LYRIC_CANDIDATES', 'Invalid request body', headers);
      const target = searchSong(song, body.searchTitle, body.searchArtist);
      if (!target) return failure(400, 'INVALID_LYRIC_CANDIDATES', 'Invalid search override', headers);
      const emptyEnvelope = encoder.encode(JSON.stringify({ ok: true, code: 200, data: { results: [], truncated: false } })).byteLength;
      const loader = deps.inspectCandidates || deps.createProviderSnapshot ? null : await lyricSourceLoaderForDb(db);
      const inspected = await (deps.inspectCandidates || inspectLyricCandidates)(target, body.candidates, {
        signal: request.signal, executionContext: deps.ctx,
        createProviderSnapshot: deps.createProviderSnapshot || loader?.createCandidateInspectionSnapshot || createSourceCandidateInspectionSnapshot,
        maxResponseBytes: LYRIC_CANDIDATE_INSPECTION_LIMITS.maxResponseBytes - emptyEnvelope,
      });
      return boundedInspection(inspected, headers);
    }
    if (action === 'asset' && method === 'PUT') {
      const body = await bodyOf(request, ['source', 'providerLyricId', 'etag', 'searchTitle', 'searchArtist'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid request body', headers);
      const source = body.source || 'auto';
      const providerLyricId = body.providerLyricId ?? null;
      if (!SOURCE.has(source) || (providerLyricId !== null && (source === 'auto'
        || typeof providerLyricId !== 'string' || !providerLyricId.trim()
        || providerLyricId.length > 256))) {
        return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid lyric source', headers);
      }
      const target = searchSong(song, body.searchTitle, body.searchArtist);
      if (!target) return failure(400, 'INVALID_LYRIC_UPDATE', 'Invalid search override', headers);
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      let document;
      try {
        const loader = deps.fetchDocument ? null : await lyricSourceLoaderForDb(db);
        document = await fetchLyricsDocumentWithFallback(source, target,
          deps.fetchDocument || loader.fetchSourceDocument,
          { signal: request.signal, executionContext: deps.ctx, enabledSources: loader?.enabledSources, ...(providerLyricId ? { providerLyricId } : {}) });
      } catch (error) {
        if (providerLyricId && error instanceof LyricSourceError && error.kind !== 'aborted') {
          return failure(422, 'LYRIC_CANDIDATE_INVALID', 'Selected lyric candidate is unavailable', headers);
        }
        throw error;
      }
      if (!document) return failure(422, 'LYRIC_CANDIDATE_INVALID', 'No usable lyric candidate', headers);
      const built = await buildReadyLyricArtifact(song, document, {
        offsetMs: current.artifact?.status === 'ready' ? current.artifact.offsetMs : 0, now: now(),
      });
      if (!await songOf()) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
      const written = await writeCurrent(store, songId, built.artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'import') {
      const body = await bodyOf(request, ['lrc', 'etag'], ['lrc', 'etag'], 2 * 1024 * 1024);
      if (!body || !validEtag(body.etag) || typeof body.lrc !== 'string') {
        return failure(400, 'INVALID_LYRIC_IMPORT', 'Invalid LRC import', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      let artifact;
      try {
        const document = parseLrcDocument(body.lrc, { source: 'manual', format: 'lrc' });
        if (!document.lines.length) throw new RangeError('empty lyrics');
        artifact = (await buildReadyLyricArtifact(song, document, { now: now(), targetLanguage })).artifact;
      } catch {
        return failure(422, 'INVALID_LYRIC_IMPORT', 'LRC has no usable lyrics or exceeds limits', headers);
      }
      const written = await writeCurrent(store, songId, artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'restore') {
      const body = await bodyOf(request, ['asset', 'etag'], ['asset', 'etag'], 4 * 1024 * 1024);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_RESTORE', 'Invalid backup', headers);
      const validated = validateLyricArtifact(body.asset, { expectedSongId: songId });
      if (!validated.valid || validated.artifact.status !== 'ready') {
        return failure(422, 'INVALID_LYRIC_RESTORE', 'Backup is not a valid lyric asset for this song', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const restored = { ...validated.artifact, aiCompletion: null, updatedAt: new Date(now()).toISOString() };
      const written = await writeCurrent(store, songId, restored, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'document') {
      const body = await bodyOf(request, ['lines', 'etag', 'aiReceipt', 'translationLanguage', 'restoreAsset', 'reset'], ['lines', 'etag'], DOCUMENT_REQUEST_BYTES);
      if (!body || !validEtag(body.etag) || !Array.isArray(body.lines)
        || body.reset !== undefined && typeof body.reset !== 'boolean'
        || (body.reset === true ? body.lines.length !== 0 : !validEditorLines(body.lines))
        || !validTranslationLanguage(body.translationLanguage)) {
        return failure(400, 'INVALID_LYRIC_DOCUMENT', 'Invalid lyric document', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!['missing', 'found'].includes(current.state)) return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      if (body.reset === true) {
        if (!await songOf()) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
        const marker = buildLyricArtifactMarker(songId, 'reset', { now: now() });
        const written = await writeCurrent(store, songId, marker, current, body.etag);
        if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
        return success({ status: 'missing', etag: written.etag, asset: null, lyrics: null }, 200, headers);
      }
      let restored = null, artifact;
      if (Object.hasOwn(body, 'restoreAsset')) {
        const validated = validateLyricArtifact(body.restoreAsset, { expectedSongId: songId });
        if (!validated.valid || validated.artifact.status !== 'ready') return failure(422, 'INVALID_LYRIC_RESTORE', 'Invalid backup', headers);
        restored = validated.artifact;
      }
      try {
        artifact = await buildEditedLyricArtifact(song, body.lines, { now: now(), targetLanguage,
          translationLanguage: body.translationLanguage || storedLyricTranslationLanguage(restored?.translation)
            || storedLyricTranslationLanguage(current.artifact?.translation) || targetLanguage });
        const submittedWords = body.lines.reduce((sum, line) => sum + (line.words?.length || 0), 0);
        const savedWords = artifact.original.lines.reduce((sum, line) => sum + (line.words?.length || 0), 0);
        if (submittedWords !== savedWords) throw new RangeError('word timeline invalid');
        if (restored) {
          const edited = artifact;
          artifact = { ...restored, ...edited, original: { ...edited.original,
            source: restored.original.source, format: restored.original.format },
            provenance: { ...restored.provenance }, offsetMs: restored.offsetMs };
          // Submitted rows contain raw original times. Keep the backup's one
          // offset rather than baking it into those times a second time.
          if (restored.textHash === edited.textHash) {
            if (restored.translationDecision) artifact.translationDecision = restored.translationDecision;
            const submittedTranslations = body.lines.map(line => String(line.tlyric || '').trim());
            if (restored.translation && JSON.stringify(restored.translation.lines) === JSON.stringify(submittedTranslations)) {
              artifact.translation = { ...restored.translation, originalTextHash: edited.textHash,
                lines: submittedTranslations, updatedAt: edited.updatedAt };
            }
          } else delete artifact.translationDecision;
        }
      } catch { return failure(422, 'INVALID_LYRIC_DOCUMENT', 'Lyric lines are invalid', headers); }
      const receipt = body.aiReceipt === undefined ? null : await verifyLyricDraftReceiptData(env, body.aiReceipt, {
        songId, accountId: session.account.accountId, etag: body.etag, textHash: artifact.textHash, now: now() });
      if (body.aiReceipt !== undefined && !receipt) return failure(400, 'INVALID_LYRIC_DRAFT_RECEIPT', 'Draft AI result is no longer valid', headers);
      if (receipt?.decision) {
        try {
          if (receipt.decision.policyVersion !== LYRIC_TRANSLATION_POLICY_VERSION) throw new Error('LYRIC_POLICY_CHANGED');
          artifact.translationDecision = buildLyricTranslationDecision(artifact, song, {
            ...receipt.decision, targetLanguage: receipt.decision.targetLanguage });
        } catch { return failure(422, 'INVALID_LYRIC_DOCUMENT', 'Lyric decision is invalid', headers); }
      }
      const validated = validateLyricArtifact(markManuallySelectedArtifact(artifact), { expectedSongId: songId });
      if (!validated.valid || validated.artifact.status !== 'ready') return failure(422, 'INVALID_LYRIC_DOCUMENT', 'Lyric document exceeds limits or is invalid', headers);
      if (!await songOf()) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
      const written = await writeCurrent(store, songId, validated.artifact, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'draft-ai') {
      const body = await bodyOf(request, ['lines', 'etag', 'translationLanguage', 'cleanDirtyLyrics'], ['lines', 'etag'], 2 * 1024 * 1024);
      if (!body || !validEtag(body.etag) || !validEditorLines(body.lines)
        || !validTranslationLanguage(body.translationLanguage)
        || body.cleanDirtyLyrics !== undefined && typeof body.cleanDirtyLyrics !== 'boolean') {
        return failure(400, 'INVALID_LYRIC_DRAFT', 'Invalid lyric draft', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) {
        return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      }
      return jsonTaskResponse(async taskSignal => {
        let result;
        try {
          const scoped = await resolvedAi(taskSignal);
          result = await (deps.completeDraft || completeLyricDraft)({ env, db, song, lines: body.lines, etag: body.etag,
            translationLanguage: body.translationLanguage || storedLyricTranslationLanguage(current.artifact?.translation) || targetLanguage,
            actorAccountId: session.account.accountId, deps: withCleanupConsent(scoped, body.cleanDirtyLyrics === true) });
        } catch (error) {
          return knownFailure(error, headers) || failure(error instanceof RangeError || error instanceof TypeError ? 422 : 503,
            error instanceof RangeError || error instanceof TypeError ? 'INVALID_LYRIC_DRAFT' : 'LYRIC_AI_FAILED',
            error instanceof RangeError || error instanceof TypeError ? 'Lyric draft cannot be processed' : 'AI completion failed', headers);
        }
        if (result.status !== 'ready') {
          const diagnostic = safeLyricValidationDiagnostic(result.diagnostic);
          return failure(503, 'LYRIC_AI_FAILED', publicBudgetErrorCode(result.errorCode) || 'AI completion failed', headers,
            diagnostic ? { diagnostic: { code: diagnostic.validationCode, stage: diagnostic.stage,
              ...(diagnostic.batchIndex === undefined ? {} : { batch: diagnostic.batchIndex }) } } : undefined);
        }
        return success(result, 200, headers);
      }, { signal: request.signal, headers });
    }
    if (action === 'timeline') {
      const body = await bodyOf(request, ['deltaMs', 'etag'], ['deltaMs', 'etag']);
      if (!body || !validEtag(body.etag) || !Number.isInteger(body.deltaMs)
        || body.deltaMs < -5000 || body.deltaMs > 5000) {
        return failure(400, 'INVALID_LYRIC_OFFSET', 'Invalid timeline shift', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') {
        return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      }
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const base = applyLyricOffset({ version: 2, ...current.artifact.original }, current.artifact.offsetMs);
      const shifted = applyLyricOffset(base, body.deltaMs);
      const written = await store.putIfMatch(songId, markManuallySelectedArtifact({
        ...current.artifact,
        original: { ...current.artifact.original, syncMode: shifted.syncMode, lines: shifted.lines },
        offsetMs: 0,
        updatedAt: new Date(now()).toISOString(),
      }), current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'offset') {
      const body = await bodyOf(request, ['offsetMs', 'etag'], ['offsetMs', 'etag']);
      if (!body || !Number.isInteger(body.offsetMs) || body.offsetMs < -5000
        || body.offsetMs > 5000 || !validEtag(body.etag)) {
        return failure(400, 'INVALID_LYRIC_OFFSET', 'Invalid offset', headers);
      }
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') {
        return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      }
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const written = await store.putIfMatch(songId, markManuallySelectedArtifact({ ...current.artifact,
        offsetMs: body.offsetMs, updatedAt: new Date(now()).toISOString() }), current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'translation') {
      const body = await bodyOf(request, ['etag'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_TRANSLATION_RESET', 'Invalid request body', headers);
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const written = await store.putIfMatch(songId, { ...current.artifact, translation: null,
        aiCompletion: null, updatedAt: new Date(now()).toISOString() }, current.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success(dataOf({ ...written, state: 'found' }), 200, headers);
    }
    if (action === 'asset' && method === 'DELETE') {
      const body = await bodyOf(request, ['etag'], ['etag']);
      if (!body || !validEtag(body.etag)) return failure(400, 'INVALID_LYRIC_RESET', 'Invalid request body', headers);
      const current = notDeleting(await store.get(songId));
      if (!matches(current, body.etag)) return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(current));
      const marker = buildLyricArtifactMarker(songId, 'reset', { now: now() });
      if (!await songOf()) return failure(404, 'SONG_NOT_FOUND', 'Song not found', headers);
      const written = await writeCurrent(store, songId, marker, current, body.etag);
      if (written.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
      return success({ status: 'missing', etag: written.etag, asset: null, lyrics: null }, 200, headers);
    }
    if (action === 'ai-completion') {
      const body = await bodyOf(request, []);
      if (!body) return failure(400, 'INVALID_AI_COMPLETION', 'Invalid request body', headers);
      const current = notDeleting(await store.get(songId));
      if (current.state !== 'found' || current.artifact.status !== 'ready') return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
      return jsonTaskResponse(async taskSignal => {
        const scoped = await resolvedAi(taskSignal);
        const started = await (deps.beginCompletion || beginLyricAssetAiCompletion)({ env, db, song, store,
          actorAccountId: session.account.accountId, force: true,
          deps: { ...scoped, signal: taskSignal, initialRead: current, checkCurrent: notDeleting } });
        if (started.state === 'missing') return failure(404, 'LYRIC_ASSET_NOT_FOUND', 'Lyric asset not found', headers);
        if (started.state === 'conflict') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers);
        const finished = started.task ? await started.task : null;
        const read = notDeleting(await store.get(songId));
        if (finished?.state === 'superseded') return failure(409, 'LYRIC_ASSET_CONFLICT', 'Lyric asset changed', headers, dataOf(read));
        const data = dataOf(read);
        if (read.artifact?.aiCompletion?.status === 'failed') return failure(503, 'LYRIC_AI_FAILED',
          publicBudgetErrorCode(read.artifact.aiCompletion.errorCode) || 'AI completion failed', headers, data);
        if (started.state === 'unavailable' || finished?.state === 'unavailable'
          || started.task && read.artifact?.aiCompletion?.status !== 'completed') {
          return failure(503, 'LYRIC_AI_FAILED', 'AI completion did not finish', headers, data);
        }
        return success({ ...data, status: started.task ? 'completed' : started.state }, 200, headers);
      }, { signal: request.signal, headers });
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const known = knownFailure(error, headers);
    if (known) return known;
    return failure(503, 'LYRIC_WORKSPACE_UNAVAILABLE', 'Lyric workspace unavailable', headers);
  }
  return failure(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', headers);
}
