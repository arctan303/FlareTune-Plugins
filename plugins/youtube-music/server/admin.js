import { Innertube, Log } from 'youtubei.js/cf-worker';
import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { readYouTubeConnection, saveYouTubeConnection, publicYouTubeStatus, validYouTubeCredentials } from "./connection.js";
import { createYouTubeService } from "./service.js";
import { upstreamFetch } from "./upstream.js";
import { createPluginOperationLease } from "@flaretune/plugin-sdk/server/service-leases";
import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { readYouTubeSettings, saveYouTubeSettings } from "./settings.js";

Log.setLevel(Log.Level.NONE);
const fail = (code, status = 409) => { throw new AuthError(code, status); };
const validRevision = value => Number.isSafeInteger(value) && value >= 0;
const allowedKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const timedFetch = upstreamFetch;
const createOAuth = async () => (await Innertube.create({ retrieve_player: false, retrieve_innertube_config: false,
  generate_session_locally: true, enable_session_cache: false, fetch: timedFetch })).session.oauth;

export function safeDeviceDisplay(pending) {
  const url = new URL(pending.verificationUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['youtube.com', 'www.youtube.com', 'google.com', 'www.google.com', 'accounts.google.com'].includes(url.hostname)) fail('YOUTUBE_AUTH_FAILED', 502);
  return { verificationUrl: url.href, userCode: pending.userCode, expiresAt: pending.expiresAt,
    interval: pending.interval, pendingId: pending.id };
}

export function createYouTubeHandler(env, session, services = {}) {
  const read = services.read || readYouTubeConnection;
  const save = services.save || saveYouTubeConnection;
  const service = services.createService || createYouTubeService;
  const publicStatus = record => ({ ...publicYouTubeStatus(record), cacheAvailable: Boolean(env.YTM_KV) });
  return async ({ request, path, scope, context, json }) => {
    if (scope !== 'admin' || context.identity.role !== 'admin') return json({ error: 'forbidden' }, 403);
    if (path === '/settings') {
      const lease = await (services.createLease || createPluginOperationLease)({ env, session,
        pluginId: 'youtube-music', context, admin: true });
      const db = lease.guardedDb(env.DB);
      try {
        let setting;
        if (request.method === 'GET') setting = await (services.readSettings || readYouTubeSettings)(db, context.identity.accountId);
        else if (request.method === 'PUT') {
          const body = await readBoundedJson(request, 8192);
          if (!body || !allowedKeys(body, ['value', 'expectedRevision']) || !Object.hasOwn(body, 'value')
            || !validRevision(body.expectedRevision)) fail('invalid_input', 400);
          setting = await (services.saveSettings || saveYouTubeSettings)(db, context.identity.accountId, body.value, body.expectedRevision);
        } else return json({ error: 'method_not_allowed' }, 405);
        await lease.assertCurrent();
        return json({ setting });
      } catch (error) {
        if (error instanceof InstanceAdminError) return json({ error: error.code }, error.status);
        throw error;
      }
    }
    const record = await read(env, { expectedEpoch: context.plugin.epoch });
    if (path === '/status' && request.method === 'GET') return json(publicStatus(record));
    if (request.method !== 'POST' || !['/connection/start', '/connection/poll', '/connection/import', '/connection/disconnect'].includes(path)) return null;
    const body = await readBoundedJson(request, 16384);
    if (!validRevision(body.revision) || record.revision !== body.revision) fail('YOUTUBE_CONNECTION_CHANGED');
    const now = Date.now();
    if (path === '/connection/disconnect') {
      if (!allowedKeys(body, ['revision'])) fail('invalid_input', 400);
      return json(publicStatus(await save(env, session, record, {})));
    }
    if (path === '/connection/import') {
      if (!allowedKeys(body, ['revision', 'credentials']) || !validYouTubeCredentials(body.credentials)) fail('invalid_input', 400);
      await service({ env, credentials: body.credentials, epoch: crypto.randomUUID() }).validateAuth();
      const binding = { id: crypto.randomUUID(), credentials: { clientId: body.credentials.clientId,
        clientSecret: body.credentials.clientSecret, refreshToken: body.credentials.refreshToken }, connectedAt: new Date(now).toISOString() };
      return json(publicStatus(await save(env, session, record, { binding })));
    }
    if (path === '/connection/start') {
      if (!allowedKeys(body, ['revision'])) fail('invalid_input', 400);
      let oauth, code;
      try {
        oauth = await (services.createOAuth || createOAuth)();
        oauth.client_id = await oauth.getClientID();
        code = await oauth.getDeviceAndUserCode();
      } catch { fail('YOUTUBE_AUTH_FAILED', 502); }
      if (typeof code.device_code !== 'string' || code.device_code.length > 8192
        || typeof code.user_code !== 'string' || code.user_code.length > 128
        || !Number.isFinite(code.expires_in) || code.expires_in < 1) fail('YOUTUBE_AUTH_FAILED', 502);
      const pending = { id: crypto.randomUUID(), owner: session.account.accountId,
        deviceCode: code.device_code, userCode: code.user_code, verificationUrl: code.verification_url,
        clientId: oauth.client_id.client_id, clientSecret: oauth.client_id.client_secret,
        interval: Math.max(5, Math.min(60, Number(code.interval) || 5)),
        expiresAt: now + Math.min(600, code.expires_in) * 1000, nextPollAt: now + 5000 };
      const display = safeDeviceDisplay(pending);
      const updated = await save(env, session, record, { ...record.value, pending });
      return json({ ...publicStatus(updated), pending: display });
    }
    if (!allowedKeys(body, ['revision', 'pendingId'])) fail('invalid_input', 400);
    const pending = record.value.pending;
    if (!pending || pending.id !== body.pendingId || pending.owner !== session.account.accountId || pending.expiresAt <= now) fail('YOUTUBE_AUTH_EXPIRED');
    if (pending.nextPollAt > now) return json({ error: 'YOUTUBE_POLL_WAIT', retryAfter: Math.ceil((pending.nextPollAt - now) / 1000), revision: record.revision }, 429);
    const claimed = await save(env, session, record, { ...record.value,
      pending: { ...pending, nextPollAt: now + pending.interval * 1000 } });
    let token;
    try {
      const response = await (services.fetch || timedFetch)('https://www.youtube.com/o/oauth2/token', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: pending.clientId,
          client_secret: pending.clientSecret, code: pending.deviceCode, grant_type: 'http://oauth.net/grant_type/device/1.0' }) });
      token = await readBoundedJson(response, 32768);
    } catch { fail('YOUTUBE_AUTH_FAILED', 502); }
    if (['authorization_pending', 'slow_down'].includes(token.error)) {
      let waiting = claimed;
      if (token.error === 'slow_down') {
        const interval = Math.min(60, pending.interval + 5);
        waiting = await save(env, session, claimed, { ...claimed.value,
          pending: { ...claimed.value.pending, interval, nextPollAt: Date.now() + interval * 1000 } });
      }
      return json({ ...publicStatus(waiting), pending: safeDeviceDisplay(waiting.value.pending) });
    }
    if (token.error || !validYouTubeCredentials({ clientId: pending.clientId, clientSecret: pending.clientSecret, refreshToken: token.refresh_token })) {
      await save(env, session, claimed, { ...record.value, pending: undefined });
      fail('YOUTUBE_AUTH_FAILED', 502);
    }
    const binding = { id: crypto.randomUUID(), connectedAt: new Date(now).toISOString(), credentials: {
      clientId: pending.clientId, clientSecret: pending.clientSecret, refreshToken: token.refresh_token } };
    return json(publicStatus(await save(env, session, claimed, { binding })));
  };
}
