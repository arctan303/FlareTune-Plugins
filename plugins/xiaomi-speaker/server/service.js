import * as xiaomi from "./xiaomi.js";
import { fail, readRecord, saveRecord, publicStatus, seal } from "./store.js";
import { resolveMediaObjectKey } from "@flaretune/plugin-sdk/server/media-objects";
import { isUsableCredentialMaterial } from "@flaretune/plugin-sdk/server/credential-format";
import { requireInstalled } from "@flaretune/plugin-sdk/server/plugin-registry";

export const TEST_AUDIO_URL = 'https://www.w3schools.com/html/horse.mp3';
const QR_TTL = 5 * 60_000;
const COMMAND_TTL = 45_000;
const id = () => crypto.randomUUID();
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const owner = session => session.account.accountId;

export async function status(env, session) {
  let record = await readRecord(env, owner(session));
  if (record.value.login?.expiresAt <= Date.now()) {
    try { record = await saveRecord(env, session, record, { ...record.value, login: null }); }
    catch { /* A concurrent operation owns the newer state. */ }
  }
  await requireInstalled(env, record.pluginEpoch);
  return publicStatus(record);
}

export async function beginLogin(env, session, adapter = xiaomi) {
  let record = await readRecord(env, owner(session));
  const now = Date.now();
  if (record.value.lastLoginAt && now - record.value.lastLoginAt < 15_000) fail('SPEAKER_RATE_LIMITED', 429);
  const loginId = id();
  record = await saveRecord(env, session, record, { ...record.value, lastLoginAt: now,
    login: { id: loginId, sessionHash: session.tokenHash, expiresAt: now + QR_TTL, pluginEpoch: record.pluginEpoch } });
  await requireInstalled(env, record.pluginEpoch);
  const qr = await adapter.beginQr();
  const current = await readRecord(env, owner(session), record.pluginEpoch);
  if (current.revision !== record.revision || current.value.login?.id !== loginId) fail('SPEAKER_CHANGED', 409);
  const expiresAt = Math.min(qr.expiresAt, now + QR_TTL);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) fail('XIAOMI_QR_EXPIRED', 410);
  await saveRecord(env, session, current, { ...current.value, login: {
    ...current.value.login, state: qr.state, expiresAt,
  } });
  return { loginId, qrDataUrl: qr.qrDataUrl, expiresAt };
}

function requireLogin(record, session, loginId) {
  const login = record.value.login;
  if (!validId(loginId) || !login || login.id !== loginId || login.sessionHash !== session.tokenHash
    || login.pluginEpoch !== record.pluginEpoch) fail('SPEAKER_LOGIN_NOT_FOUND', 404);
  if (login.expiresAt <= Date.now()) fail('XIAOMI_QR_EXPIRED', 410);
  if (!login.state) fail('SPEAKER_BUSY', 409);
  return login;
}

function deviceList(devices, previous = []) {
  if (!Array.isArray(devices) || devices.length > 64) fail('SPEAKER_INVALID_DEVICES', 502);
  const seen = new Set();
  return devices.filter(device => typeof device.id === 'string' && device.id.length > 0 && device.id.length <= 256
    && !/[\u0000-\u001f\u007f;]/.test(device.id) && !seen.has(device.id) && seen.add(device.id))
    .map(device => ({ id: previous.find(saved => saved.minaId === device.id)?.id || id(), minaId: device.id,
      name: String(device.name || '小爱音箱').slice(0, 128), hardware: String(device.hardware || '').slice(0, 64),
      supported: device.hardware === 'L05B' }));
}

export async function pollLogin(env, session, loginId, signal, adapter = xiaomi) {
  let record = await readRecord(env, owner(session));
  let login = requireLogin(record, session, loginId);
  if (!login.credentials) {
    await requireInstalled(env, record.pluginEpoch);
    const result = await adapter.pollQr(login.state, { signal });
    requireLogin(record, session, loginId);
    login = { ...login, state: result.state };
    if (result.phase === 'confirmed') login.credentials = result.login;
    record = await saveRecord(env, session, record, { ...record.value, login });
    if (!login.credentials) return { phase: 'waiting' };
  }
  // Save the short-lived passToken before exchange. A failed exchange can be
  // retried explicitly without another scan; neither value reaches the client.
  await requireInstalled(env, record.pluginEpoch);
  const account = await adapter.exchange(login.credentials, login.state);
  await requireInstalled(env, record.pluginEpoch);
  const devices = deviceList(await adapter.listDevices(account));
  requireLogin(record, session, loginId);
  record = await saveRecord(env, session, record, { lastLoginAt: record.value.lastLoginAt,
    binding: { id: id(), account, devices, tickets: {}, needsReconnect: false }, login: null });
  return { phase: 'ready', ...publicStatus(record) };
}

export async function disconnect(env, session) {
  const record = await readRecord(env, owner(session));
  // Keep a tombstone revision so an in-flight QR/control cannot resurrect it.
  return publicStatus(await saveRecord(env, session, record, {}));
}

function requireBinding(record) {
  const binding = record.value.binding;
  if (!binding?.account || binding.needsReconnect) fail('SPEAKER_RECONNECT_REQUIRED', 409);
  return binding;
}

async function invalidateExpired(env, session, record, error) {
  if (error.code !== 'XIAOMI_AUTH_EXPIRED') return;
  try {
    await saveRecord(env, session, record, { ...record.value,
      binding: { ...record.value.binding, account: null, tickets: {}, needsReconnect: true } });
  } catch { /* A newer unlink/login wins. */ }
}

export async function refreshDevices(env, session, adapter = xiaomi) {
  const record = await readRecord(env, owner(session));
  const binding = requireBinding(record);
  try {
    await requireInstalled(env, record.pluginEpoch);
    const devices = deviceList(await adapter.listDevices(binding.account), binding.devices);
    const tickets = Object.fromEntries(Object.entries(binding.tickets || {}).filter(([key]) => devices.some(d => d.id === key && d.supported)));
    return publicStatus(await saveRecord(env, session, record, { ...record.value, binding: { ...binding, devices, tickets } }));
  } catch (error) { await invalidateExpired(env, session, record, error); throw error; }
}

export function songMediaPath(song, env) {
  const stored = song?.audio_url;
  const path = typeof stored === 'string' && stored.startsWith('audio/') ? `/media/${stored}` : stored;
  if (typeof path !== 'string' || !path.startsWith('/media/audio/') || path.includes('?') || path.includes('#')
    || !/\.mp3$/i.test(path) || !resolveMediaObjectKey(path, env)) fail('SPEAKER_MP3_REQUIRED', 415);
  return path;
}

async function createTicket(env, session, binding, device, songId, origin, pluginEpoch) {
  if (typeof songId !== 'string' || !songId || songId.length > 256) fail('invalid_input');
  // Operators may use another hostname on this same Worker for device media.
  // Never accept a media origin from the command body or follow a redirect.
  let url;
  try { url = new URL(env.SPEAKER_MEDIA_ORIGIN || origin); }
  catch { fail('service_unavailable', 503); }
  if (url.protocol !== 'https:') fail('SPEAKER_HTTPS_REQUIRED', 409);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('service_unavailable', 503);
  const song = await env.DB.prepare('SELECT id,audio_url,duration FROM Songs WHERE id=?').bind(songId).first();
  if (!song) fail('SPEAKER_SONG_NOT_FOUND', 404);
  const path = songMediaPath(song, env);
  if (!env.MEDIA_BUCKET) fail('service_unavailable', 503);
  const object = await env.MEDIA_BUCKET.head(resolveMediaObjectKey(path, env));
  if (!object) fail('SPEAKER_SONG_NOT_FOUND', 404);
  const etag = object.etag || object.httpEtag?.replace(/^"|"$/g, '');
  if (!etag || !Number.isSafeInteger(object.size) || object.size <= 0) fail('service_unavailable', 503);
  const duration = Number(song.duration);
  if (!Number.isFinite(duration) || duration < 0 || duration > 85500) fail('SPEAKER_DURATION_UNSUPPORTED', 415);
  const lifetime = Math.max(3600, duration + 900) * 1000;
  const expiresAt = Date.now() + lifetime;
  if (session.expiresAt < expiresAt) fail('SPEAKER_SESSION_EXPIRING', 409);
  const ticket = { id: id(), songId, path, etag, expiresAt, sessionHash: session.tokenHash, durationSeconds: duration, pluginEpoch };
  // The random ticket ID resolves to its saved installation epoch. Keeping the
  // epoch in that record avoids lengthening the device-facing capability URL.
  const token = await seal({ owner: owner(session), binding: binding.id, speaker: device.id, ticket: ticket.id }, env, 'media ticket');
  const mediaUrl = new URL('/speaker-media/audio.mp3', url);
  mediaUrl.searchParams.set('ticket', token);
  return { ticket, audioUrl: mediaUrl.href };
}

function selectedDevice(binding, speakerId) {
  if (!validId(speakerId)) fail('invalid_input');
  const device = binding.devices.find(item => item.id === speakerId && item.supported && item.hardware === 'L05B');
  if (!device) fail('SPEAKER_NOT_FOUND', 404);
  return device;
}
function validAudioId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validPosition(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 85500;
}
function activeTicket(binding, device, session, pluginEpoch) {
  const ticket = binding.tickets?.[device.id];
  // A new browser session starts its own playback. It cannot resume an old
  // session's capability after logout, even when the same owner signs in again.
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.sessionHash !== session.tokenHash
    || ticket.pluginEpoch !== pluginEpoch) fail('SPEAKER_PLAYBACK_EXPIRED', 409);
  return ticket;
}
const unknownPlayback = volume => ({ audioId: null, positionSeconds: null, durationSeconds: null,
  volume, status: null, matched: null });
const safeNumber = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;

export async function playbackState(env, session, input, adapter = xiaomi) {
  const record = await readRecord(env, owner(session));
  const binding = requireBinding(record);
  const device = selectedDevice(binding, input?.speakerId);
  let reported;
  try { await requireInstalled(env, record.pluginEpoch);
    reported = await adapter.getPlaybackState(binding.account, device.minaId,
    env.SPEAKER_DIAGNOSTICS === 'true' ? { diagnostic: value => console.info('speaker-diagnostic', {
      operation: 'state',
      ...(Number.isInteger(value.httpStatus) ? { httpStatus: value.httpStatus } : {}),
      ...(Number.isInteger(value.code) ? { code: value.code } : {}),
    }) } : {}); }
  catch (error) { await invalidateExpired(env, session, record, error); throw error; }
  const volume = safeNumber(reported?.volume, 100);
  const activeSession = await env.DB.prepare(`SELECT c.* FROM account_sessions s
    JOIN accounts a ON a.account_id=s.account_id JOIN account_credentials c ON c.account_id=a.account_id
    WHERE s.token_hash=? AND s.account_id=? AND s.revoked_at IS NULL AND s.expires_at>?
      AND s.mode='normal' AND a.status='active' AND c.must_change_password=0`)
    .bind(session.tokenHash, owner(session), Date.now()).first();
  if (!activeSession || !isUsableCredentialMaterial(activeSession)) fail('SPEAKER_CHANGED', 409);
  const current = await readRecord(env, owner(session), record.pluginEpoch);
  const ticket = current.value.binding?.tickets?.[device.id];
  if (current.revision !== record.revision || current.value.binding?.id !== binding.id
    || (current.value.binding?.command?.pluginEpoch === record.pluginEpoch
      && current.value.binding?.command?.until > Date.now())) return { playback: unknownPlayback(null) };
  if (ticket?.id !== binding.tickets?.[device.id]?.id || !ticket || ticket.expiresAt <= Date.now()
    || ticket.sessionHash !== session.tokenHash || ticket.pluginEpoch !== record.pluginEpoch
    || !validAudioId(ticket.audioId) || !validAudioId(reported?.audioId)) {
    return { playback: unknownPlayback(volume) };
  }
  const matched = reported.audioId === ticket.audioId;
  if (!matched) return { playback: { ...unknownPlayback(volume), matched: false } };
  return { playback: {
    audioId: ticket.audioId, positionSeconds: safeNumber(reported.positionSeconds, 86400),
    durationSeconds: safeNumber(reported.durationSeconds, 86400), volume,
    status: ['idle', 'playing', 'paused'].includes(reported.status) ? reported.status : null, matched: true,
  } };
}

export async function command(env, session, input, action, origin, adapter = xiaomi) {
  if (!input || !validId(input.speakerId) || !['play', 'stop', 'test', 'pause', 'resume', 'volume', 'seek'].includes(action)) fail('invalid_input');
  if (action === 'volume' && (!Number.isInteger(input.volume) || input.volume < 0 || input.volume > 100)) fail('invalid_input');
  if ((action === 'seek' || (action === 'play' && input.positionSeconds !== undefined)) && !validPosition(input.positionSeconds)) fail('invalid_input');
  let record = await readRecord(env, owner(session));
  let binding = requireBinding(record);
  const device = selectedDevice(binding, input.speakerId);
  // Uninstall cannot recall a request already accepted by Xiaomi. Keep its
  // bounded lease across reinstallation so a new command cannot overlap it.
  if (binding.command?.until > Date.now()) fail('SPEAKER_BUSY', 409);
  let audioUrl = TEST_AUDIO_URL;
  const tickets = { ...binding.tickets };
  if (['play', 'stop', 'test'].includes(action)) delete tickets[device.id];
  if (['pause', 'resume', 'seek'].includes(action)) {
    const ticket = activeTicket(binding, device, session, record.pluginEpoch);
    if (action === 'seek' && ticket.durationSeconds > 0 && input.positionSeconds > ticket.durationSeconds) fail('invalid_input');
  }
  if (action === 'play') {
    const created = await createTicket(env, session, binding, device, input.songId, origin, record.pluginEpoch);
    tickets[device.id] = created.ticket;
    audioUrl = created.audioUrl;
    if (created.ticket.durationSeconds > 0 && input.positionSeconds > created.ticket.durationSeconds) fail('invalid_input');
  }
  const commandId = id();
  binding = { ...binding, tickets, command: { id: commandId, until: Date.now() + COMMAND_TTL, pluginEpoch: record.pluginEpoch } };
  record = await saveRecord(env, session, record, { ...record.value, binding });
  const beforeSend = await readRecord(env, owner(session), record.pluginEpoch);
  if (beforeSend.value.binding?.id !== binding.id || beforeSend.value.binding?.command?.id !== commandId) fail('SPEAKER_CHANGED', 409);
  await requireInstalled(env, record.pluginEpoch);
  let result;
  let authExpired = false;
  try {
    if (action === 'stop') result = await adapter.stopMusic(binding.account, device.minaId);
    else if (action === 'pause') result = await adapter.pauseMusic(binding.account, device.minaId);
    else if (action === 'resume') result = await adapter.resumeMusic(binding.account, device.minaId);
    else if (action === 'volume') result = await adapter.setVolume(binding.account, device.minaId, input.volume);
    else if (action === 'seek') result = await adapter.seekMusic(binding.account, device.minaId, input.positionSeconds);
    else result = await adapter.playMusic(binding.account, device.minaId, audioUrl,
      action === 'play' && input.positionSeconds !== undefined ? { positionSeconds: input.positionSeconds } : {});
  } catch (error) {
    authExpired = error.code === 'XIAOMI_AUTH_EXPIRED';
    result = { outcome: authExpired ? 'failed' : 'uncertain' };
  }
  if (!['sent', 'uncertain', 'failed'].includes(result?.outcome)) result = { outcome: 'uncertain' };
  const current = await readRecord(env, owner(session), record.pluginEpoch);
  if (current.value.binding?.id !== binding.id || current.value.binding.command?.id !== commandId) return { outcome: 'uncertain' };
  const next = current.value.binding;
  next.command = null;
  if (action === 'play' && next.tickets[device.id] && validAudioId(result.audioId)) next.tickets[device.id].audioId = result.audioId;
  if (result.outcome === 'failed' && ['play', 'test'].includes(action)) delete next.tickets[device.id];
  if (authExpired) { next.account = null; next.needsReconnect = true; next.tickets = {}; }
  try { await saveRecord(env, session, current, { ...current.value, binding: next }); }
  catch (error) {
    if (error?.code === 'PLUGIN_NOT_INSTALLED') throw error;
    return { outcome: 'uncertain' };
  }
  return { outcome: result.outcome,
    ...(action === 'play' ? { playback: { audioId: validAudioId(result.audioId) && result.outcome !== 'failed' ? result.audioId : null } } : {}),
    ...(action === 'seek' || (action === 'play' && input.positionSeconds > 0) ? { protocolVerified: false } : {}),
  };
}
