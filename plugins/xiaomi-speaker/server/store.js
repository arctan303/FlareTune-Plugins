import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import { INSTALLATION_KEY, requireInstalled } from "@flaretune/plugin-sdk/server/plugin-registry";

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encode = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
export const speakerKey = owner => `account.speakers.${owner}`;
export const fail = (code, status = 400) => { throw new AuthError(code, status); };

async function key(env, purpose) {
  if (typeof env.SETUP_SECRET !== 'string' || env.SETUP_SECRET.length < 32) fail('service_unavailable', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(env.SETUP_SECRET), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune speakers v1'), info: encoder.encode(purpose) }, material,
  { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(value, env, purpose, context = '') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
    additionalData: encoder.encode(`speakers-v1:${purpose}:${context}`) }, await key(env, purpose), encoder.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}

export async function open(value, env, purpose, context = '') {
  if (typeof value !== 'string' || value.length > 180000 || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_ciphertext');
  const [iv, ciphertext] = value.split('.');
  return JSON.parse(decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv),
    additionalData: encoder.encode(`speakers-v1:${purpose}:${context}`) }, await key(env, purpose), decode(ciphertext))));
}

export async function readRecord(env, owner, expectedEpoch) {
  const { epoch: pluginEpoch } = await requireInstalled(env, expectedEpoch);
  const row = await env.DB.prepare('SELECT value_json, revision FROM instance_settings WHERE key = ?').bind(speakerKey(owner)).first();
  if (!row) return { value: {}, revision: 0, corrupt: false, pluginEpoch };
  try {
    const saved = JSON.parse(row.value_json);
    const value = await open(saved.encrypted, env, 'account record', owner);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_record');
    return { value, revision: Number(row.revision), corrupt: false, pluginEpoch };
  } catch { return { value: {}, revision: Number(row.revision), corrupt: true, pluginEpoch }; }
}

export async function saveRecord(env, session, record, value, now = Date.now()) {
  const owner = session.account.accountId;
  const encrypted = await seal(value, env, 'account record', owner);
  // A single CAS guards all login/control changes, including a slow upstream
  // response arriving after unlink, another QR login, logout or account reset.
  const result = await env.DB.prepare(`INSERT INTO instance_settings (key,value_json,revision,updated_at,updated_by)
    SELECT ?,?,1,?,? WHERE EXISTS (SELECT 1 FROM account_sessions s
      JOIN accounts a ON a.account_id=s.account_id JOIN account_credentials c ON c.account_id=a.account_id
      WHERE s.token_hash=? AND s.account_id=? AND s.mode='normal' AND s.revoked_at IS NULL
        AND s.expires_at>? AND a.status='active' AND c.must_change_password=0)
      AND COALESCE((SELECT revision FROM instance_settings WHERE key=?),0)=?
      AND EXISTS (SELECT 1 FROM instance_settings WHERE key=? AND json_extract(value_json,'$.installed')=1
        AND json_extract(value_json,'$.epoch')=?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
      revision=instance_settings.revision+1,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
    .bind(speakerKey(owner), JSON.stringify({ encrypted }), now, owner, session.tokenHash, owner, now,
      speakerKey(owner), record.revision, INSTALLATION_KEY, record.pluginEpoch).run();
  if (Number(result?.meta?.changes) !== 1) {
    await requireInstalled(env, record.pluginEpoch);
    fail('SPEAKER_CHANGED', 409);
  }
  return { value, revision: record.revision + 1, corrupt: false, pluginEpoch: record.pluginEpoch };
}

export function publicStatus(record) {
  const binding = record.value.binding;
  const connected = Boolean(binding?.account && !binding.needsReconnect);
  return { connected, needsReconnect: Boolean(record.corrupt || binding?.needsReconnect),
    devices: connected ? (binding.devices || []).map(({ id, name, hardware, supported }) => ({ id, name, hardware, supported })) : [] };
}
