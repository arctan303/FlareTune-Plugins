import { readBoundedJson } from "@flaretune/plugin-sdk/server/http-security";
import { AuthError } from "@flaretune/plugin-sdk/server/auth";
import * as service from "./service.js";
import { requireInstalled } from "@flaretune/plugin-sdk/server/plugin-registry";

export async function handleSpeakerApi(request, path, env, session, json) {
  const base = '/api/account/speakers';
  if (path !== base && !path.startsWith(`${base}/`)) return null;
  if (session?.mode !== 'normal' || !['admin', 'member'].includes(session.account?.role)) return json({ error: 'forbidden' }, 403);
  try {
    await requireInstalled(env);
    if (path === base && request.method === 'GET') return json(await service.status(env, session));
    if (path === base && request.method === 'DELETE') {
      await readBoundedJson(request);
      return json(await service.disconnect(env, session));
    }
    if (request.method !== 'POST') return json({ error: 'not_found' }, 404);
    const input = await readBoundedJson(request);
    if (path === `${base}/login`) return json(await service.beginLogin(env, session));
    if (path === `${base}/login/poll`) return json(await service.pollLogin(env, session, input.loginId, request.signal));
    if (path === `${base}/devices`) return json(await service.refreshDevices(env, session));
    if (path === `${base}/state`) return json(await service.playbackState(env, session, input));
    const action = path.slice(base.length + 1);
    if (['play', 'stop', 'test', 'pause', 'resume', 'volume', 'seek'].includes(action)) return json(await service.command(env, session, input, action, new URL(request.url).origin));
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    if (error instanceof AuthError || error?.name === 'XiaomiError') return json({ error: error.code }, error.status);
    // Upstream URLs, cookies, parse failures and ciphertext never enter logs or
    // the public error body. Body parser errors retain their safe fixed code.
    return json({ error: error?.name === 'RequestBodyError' ? 'invalid_input' : 'service_unavailable' }, error?.name === 'RequestBodyError' ? 400 : 503);
  }
}
