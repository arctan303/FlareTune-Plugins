import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { getYouTubeBinding } from "./connection.js";
import { YouTubeError } from "./core.js";
import { streamOptions } from "./media.js";
import { createYouTubeService } from "./service.js";

const EPOCH_HEADER = 'X-FlareTune-YT-Epoch';
const bindingErrors = new Set(['YOUTUBE_NOT_CONNECTED', 'YOUTUBE_SECRET_UNAVAILABLE',
  'YOUTUBE_CONNECTION_CHANGED', 'PLUGIN_NOT_INSTALLED', 'PLUGIN_UNAVAILABLE', 'PLUGIN_NOT_FOUND']);
function errorResponse(request, error) {
  const typed = error instanceof YouTubeError || (error instanceof AuthError && bindingErrors.has(error.code));
  const code = typed && /^YOUTUBE_[A-Z0-9_]{1,64}$|^PLUGIN_(?:NOT_INSTALLED|UNAVAILABLE|NOT_FOUND)$/.test(error.code || '') ?
    error.code : 'YOUTUBE_RUNTIME_UNAVAILABLE';
  const status = typed && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
  return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: code }), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-FlareTune-Source-Error': code } });
}
function requestTarget(request) {
  if (!['GET', 'HEAD'].includes(request.method)) throw new YouTubeError('YOUTUBE_RUNTIME_METHOD_NOT_ALLOWED', 405);
  const url = new URL(request.url);
  const match = /^\/audio\/([\w-]{11})$/.exec(url.pathname);
  if (!match) throw new YouTubeError('YOUTUBE_RUNTIME_NOT_FOUND', 404);
  for (const key of url.searchParams.keys()) {
    if (!['codec', 'itag'].includes(key) || url.searchParams.getAll(key).length !== 1) {
      throw new YouTubeError('YOUTUBE_RUNTIME_INVALID_QUERY', 400);
    }
  }
  if ((url.searchParams.has('codec') && !['opus', 'aac'].includes(url.searchParams.get('codec'))) ||
    (url.searchParams.has('itag') && !['774', '141', '251', '140'].includes(url.searchParams.get('itag')))) {
    throw new YouTubeError('YOUTUBE_RUNTIME_INVALID_QUERY', 400);
  }
  streamOptions(request);
  const epoch = request.headers.get(EPOCH_HEADER);
  if (!epoch || epoch.length > 128) throw new YouTubeError('YOUTUBE_RUNTIME_UNAUTHORIZED', 403);
  return { id: match[1], epoch };
}

// Private, same-Worker capability endpoint. The host authenticates the web
// session; this handler independently reads the active encrypted connection and
// checks its generation. The factory is also used by isolated tests.
export function createYouTubeRuntimeHandler({ env, ctx, getBinding = getYouTubeBinding, createService = createYouTubeService }) {
  return async function fetchRuntime(request) {
    let response;
    try {
      const { id, epoch } = requestTarget(request);
      const binding = await getBinding(env);
      if (epoch !== binding.epoch) throw new YouTubeError('YOUTUBE_RUNTIME_UNAUTHORIZED', 403);
      const bindingEpoch = binding.epoch, pluginEpoch = binding.record?.epoch;
      const headers = new Headers();
      for (const name of ['Range', 'If-Range', 'User-Agent']) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      // Browser credentials and the internal capability header are not inputs
      // to the source service or its Google/CDN requests.
      const mediaRequest = new Request(request.url, { method: request.method, headers, signal: request.signal });
      const service = createService({ env, credentials: binding.credentials, epoch: binding.epoch, ctx });
      response = await service.stream(mediaRequest, id);
      const current = await getBinding(env);
      if (current.epoch !== bindingEpoch || current.record?.epoch !== pluginEpoch) {
        throw new YouTubeError('YOUTUBE_CONNECTION_CHANGED', 409);
      }
      return response;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      return errorResponse(request, error);
    }
  };
}

// No persistent DO state is used. Parsing, anonymous visibility, player
// resolution, KV lookups and CDN streaming all execute in this actor's request.
export class YouTubeRuntime {
  #handle;
  constructor(ctx, env) { this.#handle = createYouTubeRuntimeHandler({ env, ctx }); }
  fetch(request) { return this.#handle(request); }
}
