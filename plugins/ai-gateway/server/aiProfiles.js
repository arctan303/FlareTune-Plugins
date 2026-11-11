// Compatibility exports contain only administrator DTOs, never a decrypted environment.
export { PROVIDER_CONNECTION_MODEL, featureModelsReady, listAiProfiles, createAiProfile,
  updateAiProfile, deleteAiProfile, assignAiProfile, listAiModels } from './_private/profiles.js';
import { resolveAiFeature as resolvePrivateFeature } from './_private/profiles.js';
export async function resolveAiFeature(...args) {
  const resolved = await resolvePrivateFeature(...args);
  return resolved ? { config: Object.fromEntries(['provider','source','protocol','model','temperature','generationOptions','supportsImages','profileId','profileRevision','featureRevision','exactModel'].filter(key => resolved.config[key] !== undefined).map(key => [key, resolved.config[key]])) } : null;
}
