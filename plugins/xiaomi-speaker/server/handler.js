import { handleSpeakerApi } from "./api.js";

// Only this legacy bridge closes over the old handler's environment. New
// plugin services receive a host-created context through the dispatcher.
export const createXiaomiHandler = (env, session) => async ({ request, path, scope, json }) => {
  if (scope !== 'account') return json({ error: 'not_found' }, 404);
  return handleSpeakerApi(request, `/api/account/speakers${path}`, env, session, json);
};
