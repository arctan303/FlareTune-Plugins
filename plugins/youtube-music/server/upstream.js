import { Innertube, Log } from 'youtubei.js/cf-worker';
import { digest, localeOf, YouTubeError } from "./core.js";
import { MUSIC_LYRICS_CLIENT_VERSION } from "./timed-lyrics.js";
import { MUSIC_IOS_PROFILE } from "./native-translation.js";
Log.setLevel(Log.Level.NONE);
const guests = new Map();
const mobileGuests = new Map();
const iosGuests = new Map();
const sdkCreate = options => Innertube.create(options);
const upstreamHosts = new Set(['www.youtube.com', 'music.youtube.com', 'youtubei.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com']);

export async function upstreamFetch(input, init = {}) {
  const target = new URL(input instanceof Request ? input.url : input);
  if (target.protocol !== 'https:' || target.port || target.username || target.password || !upstreamHosts.has(target.hostname)) {
    throw new YouTubeError('YOUTUBE_INVALID_UPSTREAM');
  }
  const signal = init.signal || (input instanceof Request ? input.signal : null);
  // Workers implements follow/manual, not redirect:error. Manual both works in
  // workerd and prevents credentials from being forwarded to another target.
  const response = await fetch(input, { ...init, redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new YouTubeError('YOUTUBE_UPSTREAM_REDIRECT', 503);
  }
  if (!response.ok && target.pathname.startsWith('/youtubei/v1/')) {
    await response.body?.cancel();
    throw new YouTubeError('YOUTUBE_UPSTREAM_HTTP_' + response.status);
  }
  return response;
}
export async function mediaFetch(input, init = {}) {
  // This deadline ends when headers arrive; it must not abort a full song.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { return await fetch(input, { ...init,
    signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }); }
  finally { clearTimeout(timer); }
}
export async function credentialScope(credentials, epoch) {
  if (![credentials?.clientId, credentials?.clientSecret, credentials?.refreshToken].every(v => typeof v === 'string' && v.length > 0 && v.length < 16384) ||
    !['string', 'number'].includes(typeof epoch) || String(epoch).length > 128) {
    throw new YouTubeError('YOUTUBE_NOT_CONNECTED', 409);
  }
  return digest(JSON.stringify([String(epoch), credentials.clientId, credentials.clientSecret, credentials.refreshToken]));
}
export async function signInNative(session, credentials, cached) {
  const client = { client_id: credentials.clientId, client_secret: credentials.clientSecret };
  if (!cached) {
    try {
      session.oauth.client_id = client;
      session.oauth.oauth2_tokens = { refresh_token: credentials.refreshToken };
      await session.oauth.refreshAccessToken();
      cached = session.oauth.oauth2_tokens;
      if (typeof cached?.access_token !== 'string' || !cached.access_token || !Number.isFinite(Date.parse(cached.expiry_date))) {
        throw new Error('Invalid refreshed token');
      }
    } catch (error) {
      if (error instanceof YouTubeError && error.code === 'YOUTUBE_UPSTREAM_REDIRECT') throw error;
      // This is the pinned SDK's exact fixed HTTP error format. Never return an
      // arbitrary message, body, URL, token, or nested upstream exception.
      const status = typeof error?.message === 'string' ?
        error.message.match(/^Failed to refresh access token: (400|401|403|429|5\d\d)$/)?.[1] : null;
      throw new YouTubeError(status ? 'YOUTUBE_OAUTH_REFRESH_HTTP_' + status : 'YOUTUBE_OAUTH_REFRESH_FAILED', 503);
    }
  }
  try { await session.signIn({ ...cached, refresh_token: credentials.refreshToken, client }); }
  catch { throw new YouTubeError('YOUTUBE_OAUTH_SESSION_FAILED', 503); }
  return session.oauth.oauth2_tokens;
}
export function createSessionManager({ env, credentials, epoch, ctx, createSession = sdkCreate, fetchImpl = upstreamFetch }) {
  // Only completed anonymous SDK sessions cross requests. An in-flight task's
  // continuations belong to its initiating Worker request and may be dropped
  // when that request ends; another request must never inherit that task.
  const guestWork = new Map(), mobileWork = new Map(), iosWork = new Map(), refreshing = new Map();
  const cachedSession = async (cache, pending, key, load) => {
    if (createSession !== sdkCreate) return load();
    const cached = cache.get(key);
    if (cached && cached.at > Date.now() - 600000) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const work = load().then(value => {
      if (cache.size >= 8) cache.delete(cache.keys().next().value);
      cache.set(key, { at: Date.now(), value });
      return value;
    });
    pending.set(key, work);
    try { return await work; }
    finally { if (pending.get(key) === work) pending.delete(key); }
  };
  let scopePromise;
  const scope = () => scopePromise ||= credentialScope(credentials, epoch);
  const tokenKey = async () => 'yt:token:' + await scope();
  const save = async token => {
    const ttl = Math.floor((Date.parse(token.expiry_date) - Date.now()) / 1000) - 120;
    if (ttl >= 60 && typeof token.access_token === 'string') await env.YTM_KV.put(await tokenKey(),
      JSON.stringify({ access_token: token.access_token, expiry_date: token.expiry_date }), { expirationTtl: ttl });
  };
  const sessionOptions = (hl, gl = 'US') => ({ ...localeOf(hl, gl), retrieve_player: false, retrieve_innertube_config: false,
    enable_session_cache: false, generate_session_locally: false, fetch: fetchImpl });
  const create = async options => {
    try { return await createSession(options); }
    catch { throw new YouTubeError('YOUTUBE_SESSION_UNAVAILABLE', 503); }
  };
  return {
    scope, tokenKey,
    async guest(hl = 'en', gl = 'US') {
      const options = sessionOptions(hl, gl);
      const key = JSON.stringify(localeOf(hl, gl));
      return cachedSession(guests, guestWork, key, () => create(options));
    },
    async musicMobile(hl = 'en', gl = 'US') {
      const key = JSON.stringify(localeOf(hl, gl));
      return cachedSession(mobileGuests, mobileWork, key, async () => {
        const web = await this.guest(hl, gl);
        const yt = await create({ ...sessionOptions(hl, gl), generate_session_locally: true, fail_fast: true });
        // Never mutate the shared WEB_REMIX metadata session or sign in this
        // anonymous lyrics client with the global membership credential.
        yt.session.context.client = { ...structuredClone(web.session.context.client),
          clientName: 'ANDROID_MUSIC', clientVersion: MUSIC_LYRICS_CLIENT_VERSION };
        return yt;
      });
    },
    async musicIos(hl = 'en', gl = 'US') {
      const key = JSON.stringify(localeOf(hl, gl));
      return cachedSession(iosGuests, iosWork, key, async () => {
        const web = await this.guest(hl, gl);
        const yt = await create({ ...sessionOptions(hl, gl), generate_session_locally: true, fail_fast: true });
        yt.session.context.client = { ...structuredClone(web.session.context.client), ...MUSIC_IOS_PROFILE, hl, gl };
        for (const field of ['browserName', 'browserVersion', 'configInfo']) delete yt.session.context.client[field];
        yt.session.user_agent = MUSIC_IOS_PROFILE.userAgent;
        return yt;
      });
    },
    async tv(hl = 'en', extra = {}) {
      const key = await tokenKey();
      // OAuth validation needs no WEB sw.js_data bootstrap. Player requests may
      // still retrieve public player JS through the SDK's explicit extra flag.
      // Guest metadata retains its previous remote bootstrap/fallback behavior.
      const yt = await create({ ...sessionOptions(hl), client_type: 'TVHTML5', ...extra,
        generate_session_locally: true, fail_fast: true });
      let token;
      try { token = await env.YTM_KV.get(key, 'json'); }
      catch { throw new YouTubeError('YOUTUBE_CACHE_UNAVAILABLE', 503); }
      if (!token?.access_token || !(Date.parse(token.expiry_date) > Date.now() + 120000)) token = null;
      if (!token) {
        // Calls within this request share refresh work; other requests reuse
        // only completed tokens from KV, never a request-owned promise.
        if (!refreshing.has(key)) {
          const work = signInNative(yt.session, credentials, null).then(async active => {
            await save(active).catch(() => {});
            return { access_token: active.access_token, expiry_date: active.expiry_date };
          }).finally(() => refreshing.delete(key));
          refreshing.set(key, work);
        }
        token = await refreshing.get(key);
      }
      await signInNative(yt.session, credentials, token);
      yt.session.on('update-credentials', ({ credentials: active }) => {
        if (!active) return;
        const task = save(active).catch(() => {});
        if (ctx?.waitUntil) ctx.waitUntil(task);
      });
      return yt;
    },
  };
}
