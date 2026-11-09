import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { pluginRegistry, installationKey } from "@flaretune/plugin-sdk/server/plugin-registry";
import { requirePluginSession, sessionPredicate, sessionBindings } from "@flaretune/plugin-sdk/server/plugin-common";

export const YOUTUBE_PLUGIN_ID = 'youtube-music';
export const YOUTUBE_CONNECTION_KEY = 'plugin.youtube-music.connection';
const encoder = new TextEncoder();
const fail = (code, status = 409) => { throw new AuthError(code, status); };
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
const domain = encoder.encode('FlareTune YouTube Music connection v1');

async function encryptionKey(env) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) fail('YOUTUBE_SECRET_UNAVAILABLE', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: domain, info: domain }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export function validYouTubeCredentials(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && ['clientId', 'clientSecret', 'refreshToken'].every(key => typeof value[key] === 'string'
      && value[key].length >= 8 && value[key].length <= (key === 'refreshToken' ? 8192 : 2048)
      && !/[\s\u0000-\u001f\u007f]/u.test(value[key]));
}

export async function sealYouTubeConnection(env, value) {
  const plaintext = encoder.encode(JSON.stringify(value));
  if (plaintext.length > 32768) fail('invalid_input', 400);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: domain },
    await encryptionKey(env), plaintext);
  return `${encode(iv)}.${encode(new Uint8Array(cipher))}`;
}

export async function openYouTubeConnection(env, serialized) {
  if (typeof serialized !== 'string' || serialized.length > 50000 || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u.test(serialized)) throw new Error('invalid_connection');
  const [iv, cipher] = serialized.split('.');
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: domain },
    await encryptionKey(env), decode(cipher));
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_connection');
  return value;
}

export async function readYouTubeConnection(env, { registry = pluginRegistry, expectedEpoch } = {}) {
  const installation = await registry.requirePluginInstalled(env, YOUTUBE_PLUGIN_ID, expectedEpoch);
  const row = await env.DB.prepare('SELECT value_json, revision FROM instance_settings WHERE key=?')
    .bind(YOUTUBE_CONNECTION_KEY).first();
  if (!row) return { value: {}, revision: 0, epoch: installation.epoch, corrupt: false };
  try {
    const saved = JSON.parse(row.value_json);
    const value = await openYouTubeConnection(env, saved.encrypted);
    // A reinstall requires an administrator to reconnect; retained credentials
    // cannot silently reopen an earlier installation's account access.
    return { value: value.installationEpoch === installation.epoch ? value : {},
      revision: Number(row.revision), epoch: installation.epoch, corrupt: false };
  } catch { return { value: {}, revision: Number(row.revision), epoch: installation.epoch, corrupt: true }; }
}

export async function saveYouTubeConnection(env, session, record, value, { registry = pluginRegistry, now = Date.now() } = {}) {
  await requirePluginSession(env, session, true);
  await registry.requirePluginInstalled(env, YOUTUBE_PLUGIN_ID, record.epoch);
  const encrypted = await sealYouTubeConnection(env, { ...value, installationEpoch: record.epoch });
  const result = await env.DB.prepare(`INSERT INTO instance_settings(key,value_json,revision,updated_at,updated_by)
    SELECT ?,?,1,?,? WHERE ${sessionPredicate}
      AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      AND EXISTS(SELECT 1 FROM instance_settings WHERE key=? AND json_extract(value_json,'$.installed')=1
        AND json_extract(value_json,'$.epoch')=?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,revision=instance_settings.revision+1,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(YOUTUBE_CONNECTION_KEY, JSON.stringify({ encrypted }), now, session.account.accountId,
      ...sessionBindings(session, now, true), YOUTUBE_CONNECTION_KEY, record.revision,
      installationKey(YOUTUBE_PLUGIN_ID), record.epoch).run();
  if (Number(result?.meta?.changes) !== 1) fail('YOUTUBE_CONNECTION_CHANGED');
  return { ...record, value: { ...value, installationEpoch: record.epoch }, revision: record.revision + 1, corrupt: false };
}

export function publicYouTubeStatus(record) {
  const binding = record.value.binding;
  return { connected: Boolean(binding?.id && validYouTubeCredentials(binding.credentials)),
    connectedAt: binding?.connectedAt || null, revision: record.revision,
    needsReconnect: Boolean(record.corrupt) };
}

export async function getYouTubeBinding(env, options = {}) {
  const record = await readYouTubeConnection(env, options);
  const binding = record.value.binding;
  if (record.corrupt || !binding?.id || !validYouTubeCredentials(binding.credentials)) fail('YOUTUBE_NOT_CONNECTED');
  return { credentials: binding.credentials, epoch: `${record.epoch}:${binding.id}`, record };
}
