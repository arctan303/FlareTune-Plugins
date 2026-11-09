// This adapter holds no account state. Its private QR state must stay on the server.
const ACCOUNT = 'https://account.xiaomi.com';
const MINA = 'https://api2.mina.mi.com';
const MINA_UA = 'MiHome/6.0.103 (com.xiaomi.mihome; build:6.0.103.1; iOS 14.4.0) Alamofire/6.0.103 MICO/iOSApp/appStore/6.0.103';
const REQUEST_TIMEOUT = 15000;
const POLL_TIMEOUT = 25000;
const QR_LIFETIME = 300000;
const JSON_LIMIT = 512 * 1024;
const IMAGE_LIMIT = 1024 * 1024;
const REDIRECT_LIMIT = 5;
const COOKIE_LIMIT = 64;
const CODES = new Set([
  'XIAOMI_AUTH_EXPIRED', 'XIAOMI_QR_EXPIRED', 'XIAOMI_INVALID_STATE',
  'XIAOMI_INVALID_REQUEST', 'XIAOMI_UNSAFE_URL', 'XIAOMI_REDIRECT_LIMIT',
  'XIAOMI_NETWORK', 'XIAOMI_TIMEOUT', 'XIAOMI_CANCELLED',
  'XIAOMI_INVALID_RESPONSE', 'XIAOMI_RESPONSE_TOO_LARGE', 'XIAOMI_UPSTREAM_ERROR',
]);

export class XiaomiError extends Error {
  constructor(code, status = 502) {
    const safeCode = CODES.has(code) ? code : 'XIAOMI_UPSTREAM_ERROR';
    super(safeCode);
    this.name = 'XiaomiError';
    this.code = safeCode;
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
  }
}

function fail(code, status) { throw new XiaomiError(code, status); }
function timestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  if (!Number.isSafeInteger(value) || value < 0) fail('XIAOMI_INVALID_STATE', 400);
  return value;
}
function text(value, limit = 4096) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}
function cookieValue(value) { return text(value) && !/[\s;,]/.test(value); }
function randomHex(size) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function xiaomiUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { fail('XIAOMI_UNSAFE_URL'); }
  const allowed = ['account.xiaomi.com', 'api2.mina.mi.com', 'api.mina.mi.com'].includes(url.hostname)
    || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.lp\.account\.xiaomi\.com$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowed || url.href.length > 16384) {
    fail('XIAOMI_UNSAFE_URL');
  }
  return url;
}
function domainMatches(host, cookie) {
  return host === cookie.domain || (!cookie.hostOnly && host.endsWith('.' + cookie.domain));
}
function pathMatches(path, cookiePath) {
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
}
function cookiesFor(url, ctx) {
  return ctx.cookies.filter(cookie => (cookie.expiresAt === null || cookie.expiresAt > ctx.now)
    && domainMatches(url.hostname, cookie) && pathMatches(url.pathname, cookie.path)
    && (!cookie.secure || url.protocol === 'https:'))
    .sort((a, b) => b.path.length - a.path.length);
}
function defaultPath(path) {
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}
function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.getAll === 'function') {
    try { return headers.getAll('Set-Cookie'); } catch { /* Non-Workers implementations may not support getAll. */ }
  }
  const combined = headers.get('set-cookie');
  // An Expires comma is followed by a date; only a subsequent cookie-name= starts a new cookie.
  return combined ? combined.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}
function saveCookies(response, url, ctx) {
  const lines = setCookieLines(response.headers);
  if (lines.length > COOKIE_LIMIT) fail('XIAOMI_INVALID_RESPONSE');
  for (const line of lines) {
    if (typeof line !== 'string' || line.length > 8192) continue;
    const [pair, ...attributes] = line.split(';');
    const equals = pair.indexOf('=');
    if (equals < 1) continue;
    const cookie = {
      name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim(),
      domain: url.hostname, hostOnly: true, path: defaultPath(url.pathname), secure: false, expiresAt: null,
    };
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || cookie.name.length > 128
      || cookie.value.length > 4096 || /[\x00-\x20\x7f;,]/.test(cookie.value)) continue;
    let invalidDomain = false;
    let maxAge;
    for (const attribute of attributes) {
      const split = attribute.indexOf('=');
      const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
      const value = split < 0 ? '' : attribute.slice(split + 1).trim();
      if (key === 'domain') {
        const domain = value.replace(/^\./, '').toLowerCase();
        const valid = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)
          && (domain === 'xiaomi.com' || domain.endsWith('.xiaomi.com') || domain === 'mi.com' || domain.endsWith('.mi.com'))
          && (url.hostname === domain || url.hostname.endsWith('.' + domain));
        if (!valid) invalidDomain = true;
        else { cookie.domain = domain; cookie.hostOnly = false; }
      } else if (key === 'path' && value.startsWith('/') && !/[\x00-\x20\x7f;]/.test(value)) cookie.path = value;
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
      else if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expiresAt = Date.parse(value);
    }
    if (invalidDomain) continue;
    if (maxAge !== undefined) cookie.expiresAt = maxAge <= 0 ? 0 : ctx.now + Math.min(maxAge, 315360000) * 1000;
    ctx.cookies = ctx.cookies.filter(old => !(old.name === cookie.name && old.domain === cookie.domain && old.path === cookie.path));
    if (cookie.expiresAt === null || cookie.expiresAt > ctx.now) ctx.cookies.push(cookie);
    if (ctx.cookies.length > COOKIE_LIMIT) fail('XIAOMI_INVALID_RESPONSE');
  }
}
function seedCookie(ctx, name, value, domain) {
  if (!cookieValue(value)) fail('XIAOMI_INVALID_STATE', 400);
  ctx.cookies.push({ name, value, domain, path: '/', hostOnly: true, secure: true, expiresAt: null });
}
function qrContext(state, now) {
  if (!state || state.version !== 1 || !/^[a-f0-9]{32}$/.test(state.deviceId)
    || !text(state.ua, 512) || !Number.isSafeInteger(state.expiresAt)
    || !Array.isArray(state.cookies) || state.cookies.length > COOKIE_LIMIT || !text(state.lp, 16384)) {
    fail('XIAOMI_INVALID_STATE', 400);
  }
  xiaomiUrl(state.lp);
  const cookies = state.cookies.map(cookie => {
    if (!cookie || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(cookie.name)
      || typeof cookie.value !== 'string' || cookie.value.length > 4096 || /[\x00-\x20\x7f;,]/.test(cookie.value)
      || !text(cookie.domain, 253) || !text(cookie.path, 4096) || !cookie.path.startsWith('/')
      || typeof cookie.hostOnly !== 'boolean' || typeof cookie.secure !== 'boolean'
      || !(cookie.expiresAt === null || Number.isFinite(cookie.expiresAt))) fail('XIAOMI_INVALID_STATE', 400);
    return { ...cookie };
  });
  return { ...state, cookies, now };
}
function privateState(ctx) {
  return { version: 1, cookies: ctx.cookies, deviceId: ctx.deviceId, ua: ctx.ua, lp: ctx.lp, expiresAt: ctx.expiresAt };
}

// Preserve integer nonce/userId/audio IDs before JSON.parse can round them. Quoted
// strings are scanned as complete JSON tokens, so embedded text is never rewritten.
function parseJson(raw) {
  try {
    const source = raw.replace(/^&&&START&&&/, '');
    let transformed = '';
    let start = 0;
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== '"') continue;
      const tokenStart = i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      const tokenEnd = i + 1;
      const key = JSON.parse(source.slice(tokenStart, tokenEnd));
      let next = tokenEnd;
      while (/\s/.test(source[next] || '') && next < source.length) next++;
      if (!['nonce', 'userId', 'audio_id', 'global_id'].includes(key) || source[next] !== ':') continue;
      next++;
      while (/\s/.test(source[next] || '') && next < source.length) next++;
      const match = /^-?\d+(?=\s*[,}])/.exec(source.slice(next));
      if (match) {
        transformed += source.slice(start, next) + JSON.stringify(match[0]);
        start = next + match[0].length;
        i = start - 1;
      }
    }
    const value = JSON.parse(transformed + source.slice(start));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('XIAOMI_INVALID_RESPONSE');
    return value;
  } catch { fail('XIAOMI_INVALID_RESPONSE'); }
}
async function readBytes(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    fail('XIAOMI_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        fail('XIAOMI_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function request(value, ctx, {
  fetchImpl = fetch, signal, timeout = REQUEST_TIMEOUT, method = 'GET', body,
  followRedirects = true, limit = JSON_LIMIT, stopOnCookie,
} = {}) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => { controller.abort(); reject(new XiaomiError('XIAOMI_CANCELLED', 499)); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new XiaomiError('XIAOMI_TIMEOUT', 504)); }, timeout);
  });
  const operation = async () => {
    let url = xiaomiUrl(value);
    for (let redirects = 0; ; redirects++) {
      if (controller.signal.aborted) fail('XIAOMI_CANCELLED', 499);
      const cookieHeader = cookiesFor(url, ctx).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      const response = await fetchImpl(url.href, {
        method, body, redirect: 'manual', signal: controller.signal,
        headers: {
          'User-Agent': ctx.ua, ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
      });
      saveCookies(response, url, ctx);
      const redirected = [301, 302, 303, 307, 308].includes(response.status);
      let nextUrl;
      if (followRedirects && redirected) {
        const location = response.headers.get('location');
        if (!location) fail('XIAOMI_INVALID_RESPONSE');
        nextUrl = xiaomiUrl(location, url);
      }
      if (stopOnCookie?.()) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, headers: response.headers, bytes: new Uint8Array() };
      }
      if (followRedirects && redirected) {
        void response.body?.cancel().catch(() => {});
        if (redirects >= REDIRECT_LIMIT) fail('XIAOMI_REDIRECT_LIMIT');
        url = nextUrl;
        continue;
      }
      return { status: response.status, headers: response.headers, bytes: await readBytes(response, limit) };
    }
  };
  try { return await Promise.race([operation(), interrupted]); }
  catch (error) {
    if (error instanceof XiaomiError) throw error;
    if (error?.name === 'TimeoutError') fail('XIAOMI_TIMEOUT', 504);
    fail('XIAOMI_NETWORK');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
function authFailure(status, data) {
  return status === 401 || status === 403 || data?.code === 401 || data?.code === 403
    || (data?.code !== 0 && typeof data?.message === 'string' && /auth/i.test(data.message.slice(0, 512)));
}
function jsonResponse(response) {
  if (authFailure(response.status)) fail('XIAOMI_AUTH_EXPIRED', 401);
  if (response.status < 200 || response.status >= 300) fail('XIAOMI_UPSTREAM_ERROR');
  const data = parseJson(new TextDecoder().decode(response.bytes));
  if (authFailure(response.status, data)) fail('XIAOMI_AUTH_EXPIRED', 401);
  return data;
}

export async function beginQr({ fetchImpl = fetch, now = Date.now() } = {}) {
  const startedAt = timestamp(now);
  const deviceId = randomHex(16);
  const ctx = {
    version: 1, cookies: [], deviceId, now: startedAt, expiresAt: startedAt + QR_LIFETIME,
    ua: `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${deviceId} APP/xiaomi.smarthome APPV/62830`,
  };
  seedCookie(ctx, 'sdkVersion', '3.8.6', 'account.xiaomi.com');
  seedCookie(ctx, 'deviceId', deviceId, 'account.xiaomi.com');
  const handshake = jsonResponse(await request(`${ACCOUNT}/pass/serviceLogin?sid=mijia&_json=true`, ctx, { fetchImpl }));
  if (!text(handshake._sign, 8192) || !text(handshake.qs, 8192) || !text(handshake.callback, 8192)) fail('XIAOMI_INVALID_RESPONSE');
  const params = new URLSearchParams({
    _qrsize: '280', qs: handshake.qs, sid: 'mijia', _sign: handshake._sign,
    callback: handshake.callback, _json: 'true', _dc: String(startedAt),
  });
  const info = jsonResponse(await request(`${ACCOUNT}/longPolling/loginUrl?${params}`, ctx, { fetchImpl }));
  if (!text(info.lp, 16384) || !text(info.qr, 16384)) fail('XIAOMI_INVALID_RESPONSE');
  ctx.lp = xiaomiUrl(info.lp).href;
  const image = await request(xiaomiUrl(info.qr).href, ctx, { fetchImpl, limit: IMAGE_LIMIT });
  const type = (image.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (image.status !== 200 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type) || image.bytes.length === 0) {
    fail('XIAOMI_INVALID_RESPONSE');
  }
  return { state: privateState(ctx), qrDataUrl: `data:${type};base64,${base64(image.bytes)}`, expiresAt: ctx.expiresAt };
}

export async function pollQr(state, { fetchImpl = fetch, now = Date.now(), signal } = {}) {
  const ctx = qrContext(state, timestamp(now));
  if (ctx.now >= ctx.expiresAt) fail('XIAOMI_QR_EXPIRED', 410);
  let response;
  try {
    response = await request(ctx.lp, ctx, { fetchImpl, signal, timeout: Math.min(POLL_TIMEOUT, ctx.expiresAt - ctx.now) });
  } catch (error) {
    if (error.code === 'XIAOMI_TIMEOUT') return { phase: 'waiting', state: privateState(ctx) };
    throw error;
  }
  if (response.status === 408 || response.status === 204) return { phase: 'waiting', state: privateState(ctx) };
  const data = jsonResponse(response);
  if (data.code !== 0) fail('XIAOMI_QR_EXPIRED', 410);
  if (!data.userId && !data.passToken) return { phase: 'waiting', state: privateState(ctx) };
  const userId = String(data.userId ?? '');
  if (!cookieValue(userId) || !cookieValue(data.passToken)) fail('XIAOMI_INVALID_RESPONSE');
  return { phase: 'confirmed', state: privateState(ctx), login: { userId, passToken: data.passToken } };
}

export async function exchange(login, state, { fetchImpl = fetch } = {}) {
  const original = qrContext(state, Date.now());
  if (!login || !cookieValue(login.userId) || !cookieValue(login.passToken)) fail('XIAOMI_INVALID_STATE', 400);
  // mijia's serviceToken must never participate in the micoapi exchange.
  const ctx = { cookies: [], deviceId: original.deviceId, ua: original.ua, now: Date.now() };
  for (const [name, value] of Object.entries({ sdkVersion: '3.8.6', deviceId: ctx.deviceId, userId: login.userId, passToken: login.passToken })) {
    seedCookie(ctx, name, value, 'account.xiaomi.com');
  }
  const data = jsonResponse(await request(`${ACCOUNT}/pass/serviceLogin?sid=micoapi&_json=true`, ctx, { fetchImpl }));
  if (data.code !== 0) fail('XIAOMI_AUTH_EXPIRED', 401);
  if (!text(data.location, 16384) || !text(data.ssecurity) || !/^-?\d{1,100}$/.test(data.nonce)
    || (data.userId !== undefined && String(data.userId) !== login.userId)) fail('XIAOMI_INVALID_RESPONSE');
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`nonce=${data.nonce}&${data.ssecurity}`));
  const location = xiaomiUrl(data.location);
  location.searchParams.set('clientSign', base64(new Uint8Array(digest)));
  const serviceToken = () => cookiesFor(new URL(MINA + '/'), ctx).find(cookie => cookie.name === 'serviceToken')?.value;
  const response = await request(location.href, ctx, { fetchImpl, stopOnCookie: () => Boolean(serviceToken()) });
  if (authFailure(response.status)) fail('XIAOMI_AUTH_EXPIRED', 401);
  const token = serviceToken();
  if (!cookieValue(token) || response.status >= 400) fail('XIAOMI_UPSTREAM_ERROR');
  return { userId: login.userId, serviceToken: token };
}

async function mina(account, path, body, { fetchImpl = fetch } = {}) {
  if (!account || !cookieValue(account.userId) || !cookieValue(account.serviceToken)) fail('XIAOMI_AUTH_EXPIRED', 401);
  const ctx = { cookies: [], ua: MINA_UA, now: Date.now() };
  seedCookie(ctx, 'userId', account.userId, 'api2.mina.mi.com');
  seedCookie(ctx, 'serviceToken', account.serviceToken, 'api2.mina.mi.com');
  const requestId = 'app_ios_' + randomHex(15);
  const url = new URL(path, MINA);
  if (!body) url.searchParams.set('requestId', requestId);
  return request(url.href, ctx, {
    fetchImpl, followRedirects: false, method: body ? 'POST' : 'GET',
    body: body ? new URLSearchParams({ ...body, requestId }).toString() : undefined,
  });
}
export async function listDevices(account, options = {}) {
  const data = jsonResponse(await mina(account, '/admin/v2/device_list?master=0', undefined, options));
  if (data.code !== 0) fail('XIAOMI_UPSTREAM_ERROR');
  if (!Array.isArray(data.data) || data.data.length > 1000) fail('XIAOMI_INVALID_RESPONSE');
  return data.data.filter(device => device && text(device.deviceID, 256)).map(device => ({
    id: device.deviceID,
    name: text(device.name, 256) ? device.name : '小爱音箱',
    hardware: text(device.hardware, 64) ? device.hardware : '',
    supported: device.hardware === 'L05B',
  }));
}
function numericCode(value) { return Number.isSafeInteger(value) ? value : undefined; }
function rejection(code) { return [400, 404, 405, 422].includes(code); }
async function command(account, deviceId, method, message, options) {
  if (!text(deviceId, 256)) fail('XIAOMI_INVALID_REQUEST', 400);
  let response;
  try { response = await mina(account, '/remote/ubus', { deviceId, method, path: 'mediaplayer', message: JSON.stringify(message) }, options); }
  catch (error) {
    if (error.code === 'XIAOMI_AUTH_EXPIRED') throw error;
    return { outcome: 'uncertain' };
  }
  if (authFailure(response.status)) fail('XIAOMI_AUTH_EXPIRED', 401);
  if (response.status < 200 || response.status >= 300) return { outcome: rejection(response.status) ? 'failed' : 'uncertain' };
  let data;
  try { data = parseJson(new TextDecoder().decode(response.bytes)); }
  catch { return { outcome: 'uncertain' }; }
  if (authFailure(response.status, data)) fail('XIAOMI_AUTH_EXPIRED', 401);
  const code = numericCode(data.code);
  let device = data.data;
  if (typeof device === 'string') { try { device = parseJson(device); } catch { device = undefined; } }
  const deviceCode = numericCode(device?.code);
  const result = { ...(code !== undefined ? { code } : {}), ...(deviceCode !== undefined ? { deviceCode } : {}) };
  if (code === 0 && deviceCode === 0) return { outcome: 'sent', ...result };
  if (code !== 100 && (rejection(code) || (code === 0 && rejection(deviceCode)))) return { outcome: 'failed', ...result };
  return { outcome: 'uncertain', ...result };
}

export async function playMusic(account, deviceId, audioUrl, options = {}) {
  let url;
  try { url = new URL(audioUrl); } catch { fail('XIAOMI_INVALID_REQUEST', 400); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.href.length > 4096) fail('XIAOMI_INVALID_REQUEST', 400);
  const offset = options.positionSeconds === undefined ? undefined : positionMilliseconds(options.positionSeconds);
  const audioId = Date.now().toString();
  const music = {
    payload: {
      audio_type: '',
      audio_items: [{
        item_id: { audio_id: audioId, cp: { album_id: '-1', episode_index: 0, id: '355454500', name: 'xiaowei' } },
        stream: { url: url.href },
      }],
      list_params: { listId: '-1', loadmore_offset: 0, origin: 'xiaowei', type: 'MUSIC' },
    },
    play_behavior: 'REPLACE_ALL',
  };
  const result = await command(account, deviceId, 'player_play_music', {
    startaudioid: audioId, music: JSON.stringify(music), ...(offset === undefined ? {} : { startOffset: offset }),
  }, options);
  return { ...result, audioId };
}

export async function stopMusic(account, deviceId, options = {}) {
  // L05B acknowledges "stop" without halting player_play_music audio. The
  // service revokes the track grant first; pause halts the current renderer.
  // Unlike pauseMusic, the service revokes the ticket before this operation.
  return command(account, deviceId, 'player_play_operation', { action: 'pause', media: 'app_ios' }, options);
}

export async function pauseMusic(account, deviceId, options = {}) {
  return command(account, deviceId, 'player_play_operation', { action: 'pause', media: 'app_ios' }, options);
}

export async function resumeMusic(account, deviceId, options = {}) {
  return command(account, deviceId, 'player_play_operation', { action: 'play', media: 'app_ios' }, options);
}

export async function setVolume(account, deviceId, volume, options = {}) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) fail('XIAOMI_INVALID_REQUEST', 400);
  return command(account, deviceId, 'player_set_volume', { volume, media: 'app_ios' }, options);
}

function positionMilliseconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 85500) fail('XIAOMI_INVALID_REQUEST', 400);
  return Math.round(seconds * 1000);
}

// S12's published ubus schema uses this original misspelling. Milliseconds and
// startOffset are protocol candidates; neither is yet verified on L05B MiNA.
export async function seekMusic(account, deviceId, positionSeconds, options = {}) {
  return command(account, deviceId, 'player_set_positon', { position: positionMilliseconds(positionSeconds), media: 'app_ios' }, options);
}

const unknownPlayback = () => ({ audioId: null, positionSeconds: null, durationSeconds: null, volume: null, status: null });
function decodedObject(value) {
  if (typeof value === 'string') { try { return parseJson(value); } catch { return null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function secondsFromMilliseconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86400000 ? value / 1000 : null;
}

export async function getPlaybackState(account, deviceId, options = {}) {
  if (!text(deviceId, 256)) fail('XIAOMI_INVALID_REQUEST', 400);
  const reply = await mina(account, '/remote/ubus', {
    deviceId, method: 'player_get_play_status', path: 'mediaplayer', message: JSON.stringify({ media: 'app_ios' }),
  }, options);
  options.diagnostic?.({ httpStatus: reply.status });
  const result = jsonResponse(reply);
  options.diagnostic?.({ code: numericCode(result.code) ?? null });
  // MiNA also returns its ambiguous command code for read-only status. It does
  // not establish a device error or a foreign playback identity.
  if (result.code === 100) return unknownPlayback();
  if (result.code !== 0) fail('XIAOMI_UPSTREAM_ERROR');
  const device = decodedObject(result.data);
  if (device?.code !== 0) return unknownPlayback();
  const info = decodedObject(device.info);
  if (!info) return unknownPlayback();
  const detail = decodedObject(info.play_song_detail);
  const rawId = detail?.audio_id ?? detail?.global_id;
  const audioId = typeof rawId === 'number' && Number.isSafeInteger(rawId) ? String(rawId) : rawId;
  return {
    audioId: text(audioId, 256) ? audioId : null,
    positionSeconds: secondsFromMilliseconds(detail?.position),
    durationSeconds: secondsFromMilliseconds(detail?.duration),
    volume: typeof info.volume === 'number' && Number.isFinite(info.volume) && info.volume >= 0 && info.volume <= 100 ? info.volume : null,
    status: typeof info.status === 'number' ? ({ 0: 'idle', 1: 'playing', 2: 'paused' })[info.status] ?? null : null,
  };
}
