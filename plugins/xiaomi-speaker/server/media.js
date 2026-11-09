import { resolveInstanceState } from "@flaretune/plugin-sdk/server/instance-state";
import { isUsableCredentialMaterial } from "@flaretune/plugin-sdk/server/credential-format";
import { resolveMediaObjectKey } from "@flaretune/plugin-sdk/server/media-objects";
import { open, readRecord } from "./store.js";
import { songMediaPath } from "./service.js";
import { requireInstalled } from "@flaretune/plugin-sdk/server/plugin-registry";

const headers = () => new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
const denied = (status, extra = {}) => new Response(null, { status, headers: {
  'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
} });

export function parseSpeakerRange(value, size) {
  if (value === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  if ([left, right].some(number => number !== null && !Number.isSafeInteger(number))) return false;
  if (left === null) return right > 0 ? { offset: Math.max(0, size - right), length: Math.min(size, right) } : false;
  if (left >= size || (right !== null && right < left)) return false;
  const end = right === null ? size - 1 : Math.min(right, size - 1);
  return { offset: left, length: end - left + 1 };
}

export async function handleSpeakerMedia(request, env, ctx) {
  if (!['GET', 'HEAD'].includes(request.method)) return denied(405, { Allow: 'GET, HEAD' });
  try {
    const instance = await resolveInstanceState(env?.DB, Date.now(), { cacheSchema: true, executionContext: ctx });
    if (instance.state !== 'ready') return denied(503);
    const installation = await requireInstalled(env);
    const url = new URL(request.url);
    const tokens = url.searchParams.getAll('ticket');
    if (url.pathname !== '/speaker-media/audio.mp3' || tokens.length !== 1 || tokens[0].length > 2048) return denied(403);
    let grant;
    try { grant = await open(tokens[0], env, 'media ticket'); } catch { return denied(403); }
    if (typeof grant?.owner !== 'string' || grant.owner.length > 128) return denied(403);
    const record = await readRecord(env, grant.owner, installation.epoch);
    const binding = record.value.binding;
    const ticket = binding?.tickets?.[grant.speaker];
    if (!binding?.account || binding.needsReconnect || binding.id !== grant.binding
      || !ticket || ticket.id !== grant.ticket || ticket.pluginEpoch !== installation.epoch
      || ticket.expiresAt <= Date.now()) return denied(403);
    const session = await env.DB.prepare(`SELECT c.* FROM account_sessions s
      JOIN accounts a ON a.account_id=s.account_id JOIN account_credentials c ON c.account_id=a.account_id
      WHERE s.token_hash=? AND s.account_id=? AND s.revoked_at IS NULL AND s.expires_at>?
        AND s.mode='normal' AND a.status='active' AND c.must_change_password=0`)
      .bind(ticket.sessionHash, grant.owner, Date.now()).first();
    if (!session || !isUsableCredentialMaterial(session)) return denied(403);
    const song = await env.DB.prepare('SELECT id,audio_url FROM Songs WHERE id=?').bind(ticket.songId).first();
    if (!song || songMediaPath(song, env) !== ticket.path) return denied(404);
    const key = resolveMediaObjectKey(ticket.path, env);
    if (!key || !env.MEDIA_BUCKET) return denied(503);
    const head = await env.MEDIA_BUCKET.head(key);
    if (!head || (head.etag || head.httpEtag?.replace(/^"|"$/g, '')) !== ticket.etag) return denied(404);
    if (!Number.isSafeInteger(head.size) || head.size <= 0) return denied(404);
    // HEAD describes the full representation, regardless of a Range header.
    const range = request.method === 'GET' ? parseSpeakerRange(request.headers.get('Range'), head.size) : null;
    if (range === false) return denied(416, { 'Content-Range': `bytes */${head.size}` });
    const responseHeaders = headers();
    responseHeaders.set('ETag', head.httpEtag || `"${ticket.etag}"`);
    responseHeaders.set('Content-Length', String(range ? range.length : head.size));
    if (range) responseHeaders.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    if (request.method === 'HEAD') {
      await requireInstalled(env, installation.epoch);
      return new Response(null, { status: 200, headers: responseHeaders });
    }
    const object = await env.MEDIA_BUCKET.get(key, { onlyIf: { etagMatches: ticket.etag }, ...(range ? { range } : {}) });
    if (!object?.body || (object.etag || object.httpEtag?.replace(/^"|"$/g, '')) !== ticket.etag) return denied(404);
    await requireInstalled(env, installation.epoch);
    return new Response(object.body, { status: range ? 206 : 200, headers: responseHeaders });
  } catch (error) { return denied(error?.code === 'PLUGIN_NOT_INSTALLED' ? 409 : 503); }
}
