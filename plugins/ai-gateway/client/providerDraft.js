import { t } from '@flaretune/plugin-sdk/pure';
import { AI_SOURCES, effectiveAiBaseUrl } from '../shared/aiProtocols.js';
export const providerDraft = (source, previous = null) => ({ source, name: previous?.name || AI_SOURCES[source].name, apiKey: '',
  ...(source === 'custom' ? { protocol: previous?.protocol || 'chat_completions', baseUrl: previous?.baseUrl || '' } : {}) });
export const changeProviderSource = (draft, source) => ({ ...providerDraft(source),
  name: draft.name === AI_SOURCES[draft.source].name ? AI_SOURCES[source].name : draft.name });
export function providerNeedsKey(draft, previous) {
  return !previous?.hasKey || draft.source !== previous.source || (draft.source === 'custom'
    && (draft.protocol !== previous.protocol || effectiveAiBaseUrl('custom', draft.baseUrl, draft.protocol) !== effectiveAiBaseUrl('custom', previous.baseUrl, previous.protocol)));
}
export const providerLabel = provider => provider.name || AI_SOURCES[provider.source].name;
export const featureDraft = assignment => ({ providerId: assignment?.providerId || '', model: assignment?.model || '', supportsImages: assignment?.supportsImages === true });
export const changeFeatureProvider = (draft, providerId) => ({ ...draft, providerId, model: '', supportsImages: false });
export const changeFeatureModel = (draft, model) => ({ ...draft, model, supportsImages: model === draft.model && draft.supportsImages });
export const modelListError = error => ({
  ai_model_list_auth_failed: '供应商拒绝认证，请检查 API Key 及其模型读取权限。',
  ai_model_list_rate_limited: '供应商暂时限流，请稍后再试。',
  ai_model_list_unsupported: '此供应商不提供模型列表，请手动填写模型 ID。',
  ai_model_list_timeout: '获取模型超时，请重试或手动填写模型 ID。',
  ai_model_list_network_failed: 'Worker 无法连接供应商模型接口，请稍后重试或手动填写模型 ID。',
  ai_model_list_invalid_response: '供应商模型列表响应格式异常，请手动填写模型 ID。',
  ai_profile_key_required: '请先为此供应商配置可用的 API Key。',
  revision_conflict: '供应商已更新，请刷新后重新获取模型。',
}[error?.code] || (/^ai_model_list_http_\d{3}$/.test(error?.code || '')
  ? t('供应商模型接口返回 HTTP {status}，请稍后重试或手动填写模型 ID。', { status: error.code.slice(-3) })
  : '模型列表暂时无法读取，仍可手动填写模型 ID。'));
