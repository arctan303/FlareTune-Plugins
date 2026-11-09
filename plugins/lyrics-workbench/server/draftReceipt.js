const encoder = new TextEncoder();
const decoder = new TextDecoder();
const RECEIPT_TTL_MS = 15 * 60_000;
const LANGUAGES = new Set(['zh', 'ja', 'en', 'ko', 'ru', 'es', 'fr', 'de', 'sv', 'vi',
  'yue', 'it', 'th', 'pt', 'other']);

const encode = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '');
const decode = (value) => Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')),
  (character) => character.charCodeAt(0));

async function signingKey(env) {
  const secret = env?.SETUP_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('LYRIC_DRAFT_RECEIPT_UNAVAILABLE');
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256',
    salt: encoder.encode('FlareTune instance secret separation v2'),
    info: encoder.encode('lyric draft language receipt HMAC v1') }, material,
  { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

export async function createLyricDraftReceipt(env, { songId, accountId, etag, language, textHash,
  now = Date.now() }) {
  if (!language) return null;
  const payload = encoder.encode(JSON.stringify({ v: 1, songId, accountId, etag,
    language, textHash, expiresAt: now + RECEIPT_TTL_MS }));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), payload);
  return `${encode(payload)}.${encode(new Uint8Array(signature))}`;
}

export async function verifyLyricDraftReceipt(env, token, { songId, accountId, etag, textHash,
  now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 4096
    || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token)) return null;
  try {
    const [encodedPayload, encodedSignature] = token.split('.');
    const payload = decode(encodedPayload);
    const valid = await crypto.subtle.verify('HMAC', await signingKey(env),
      decode(encodedSignature), payload);
    if (!valid) return null;
    const result = JSON.parse(decoder.decode(payload));
    if (result.v !== 1 || result.songId !== songId || result.accountId !== accountId
      || result.etag !== etag || result.textHash !== textHash
      || typeof result.expiresAt !== 'number' || result.expiresAt < now
      || result.expiresAt > now + RECEIPT_TTL_MS
      || !LANGUAGES.has(result.language)) {
      return null;
    }
    return result.language;
  } catch {
    return null;
  }
}
