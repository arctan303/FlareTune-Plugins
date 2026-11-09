// Source presets are convenience defaults, not model capability guarantees.
export const AI_PROTOCOLS = Object.freeze({
  chat_completions: 'Chat Completions', responses: 'Responses',
  anthropic_messages: 'Anthropic Messages', gemini_native: 'Gemini 原生',
});
export const AI_REASONING_EFFORTS = Object.freeze({
  chat_completions: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  responses: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  anthropic_messages: ['none', 'low', 'medium', 'high'],
  gemini_native: ['none', 'minimal', 'low', 'medium', 'high'],
});
export const AI_SOURCES = Object.freeze({
  deepseek: { name: 'DeepSeek', protocol: 'chat_completions', baseUrl: 'https://api.deepseek.com' },
  openai: { name: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic', protocol: 'anthropic_messages', baseUrl: 'https://api.anthropic.com/v1' },
  gemini: { name: 'Gemini', protocol: 'gemini_native', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  custom: { name: '自定义源', protocol: 'chat_completions', baseUrl: '' },
});
export const sourceFromProvider = (provider) => provider === 'compatible' ? 'custom' : provider;
export const legacyProtocol = (provider) => provider === 'gemini' ? 'gemini_native' : 'chat_completions';
const protocolAddresses = {
  deepseek: { chat_completions: 'https://api.deepseek.com', responses: 'https://api.deepseek.com',
    anthropic_messages: 'https://api.deepseek.com/anthropic/v1' },
  openai: { chat_completions: 'https://api.openai.com/v1', responses: 'https://api.openai.com/v1' },
  anthropic: { anthropic_messages: 'https://api.anthropic.com/v1' },
  gemini: { gemini_native: 'https://generativelanguage.googleapis.com/v1beta',
    chat_completions: 'https://generativelanguage.googleapis.com/v1beta/openai' },
};
export const effectiveAiBaseUrl = (source, baseUrl = '', protocol = AI_SOURCES[source]?.protocol) =>
  (baseUrl || protocolAddresses[source]?.[protocol] || '').replace(/\/+$/, '');

export function validateAiBaseUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : null;
  // Do not accept literal private/loopback/link-local addresses or local hostnames.
  const privateHost = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
    || !host.includes('.') || (ipv4 && (ipv4[0] === 0 || ipv4[0] === 10 || ipv4[0] === 127
      || ipv4[0] >= 224 || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127)))
    || host.startsWith('['); // IP literals are unnecessary for public model endpoints.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || privateHost || /\/(?:chat\/completions|responses|messages|models(?:\/[^/]+)?:(?:streamGenerateContent|generateContent))\/?$/i.test(url.pathname)) {
    throw new Error('AI_BASE_URL_INVALID');
  }
  return value.replace(/\/+$/, '');
}

export function normalizeGenerationOptions(input = {}, protocol) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((key) => !['temperature', 'maxOutputTokens', 'reasoningEffort', 'thinkingBudget', 'thinkingMode'].includes(key))) {
    throw new Error('AI_OPTIONS_INVALID');
  }
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === '' || value === null || value === undefined) continue;
    if (key === 'temperature' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) result[key] = value;
    else if (key === 'maxOutputTokens' && Number.isInteger(value) && value >= 1 && value <= 131072) result[key] = value;
    else if (key === 'thinkingBudget' && Number.isInteger(value) && value >= 0 && value <= 32768) result[key] = value;
    else if (key === 'reasoningEffort' && (AI_REASONING_EFFORTS[protocol] || AI_REASONING_EFFORTS.responses).includes(value)) result[key] = value;
    else if (key === 'thinkingMode' && ['adaptive', 'enabled'].includes(value)) result[key] = value;
    else throw new Error('AI_OPTIONS_INVALID');
  }
  return result;
}
