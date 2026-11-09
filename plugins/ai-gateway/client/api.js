async function request(host, path, settings = {}) {
  host.assertCurrent();
  const value = await host.request(path, { ...settings, admin: true });
  host.assertCurrent();
  return value;
}
export const getAiProviders = host => request(host, 'providers');
export const createAiProvider = (provider, host) => request(host, 'providers', { method: 'POST', body: provider });
export const updateAiProvider = (id, provider, expectedRevision, host) => request(host, `providers/${encodeURIComponent(id)}`, {
  method: 'PUT', body: { provider, expectedRevision } });
export const deleteAiProvider = (id, expectedRevision, host) => request(host, `providers/${encodeURIComponent(id)}`, {
  method: 'DELETE', body: { expectedRevision } });
export const getAiProviderModels = (providerId, expectedRevision, host) => request(host, 'provider-models', {
  method: 'POST', body: { providerId, expectedRevision } });
export const saveAiFeatureModel = (configuration, host) => request(host, 'feature-models', { method: 'PUT', body: configuration });
