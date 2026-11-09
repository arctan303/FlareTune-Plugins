import { effectiveAiBaseUrl, sourceFromProvider, validateAiBaseUrl } from "../shared/aiProtocols.js";

const connectionTimeouts = new WeakMap();
export function setAiConnectionTimeout(signal, timeoutMs) { connectionTimeouts.set(signal, timeoutMs); }

export function aiConnection(config, env) {
  const source = config.source || sourceFromProvider(config.provider);
  const prefix = { deepseek: 'DEEPSEEK', openai: 'OPENAI', gemini: 'GEMINI', anthropic: 'ANTHROPIC', custom: 'OPENAI' }[source];
  const apiKey = env.AI_PROFILE_API_KEY || env[`${prefix}_API_KEY`];
  if (!apiKey) throw new Error('AI_MISSING_KEY');
  const baseUrl = effectiveAiBaseUrl(source, env.AI_PROFILE_BASE_URL || env[`${prefix}_BASE_URL`] || '', config.protocol);
  validateAiBaseUrl(baseUrl);
  return { apiKey, baseUrl, source };
}

export function aiHeaders(protocol, apiKey) {
  return { 'Content-Type': 'application/json',
    ...(protocol === 'gemini_native' ? { 'x-goog-api-key': apiKey }
      : protocol === 'anthropic_messages' ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${apiKey}` }) };
}

export async function fetchAi(url, init, { allowErrorResponse = false } = {}) {
  // Workers only supports follow/manual. Never forward credentials to a redirect.
  const timeoutMs = connectionTimeouts.get(init.signal);
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(url, { ...init, redirect: 'manual',
      ...(timeoutMs ? { signal: AbortSignal.any([init.signal, controller.signal]) } : {}) });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('AI_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); }
  // Never include upstream response bodies (possibly credentials) in errors.
  if (!response.ok && !allowErrorResponse) throw new Error(`AI_UPSTREAM_${response.status}`);
  return response;
}

export function requestReasoningEffort(config) {
  const configured = config.generationOptions?.reasoningEffort;
  if (config.enableThinking === false) return 'none';
  return configured || (config.enableThinking === true ? 'medium' : undefined);
}

export const isOpenAiReasoningModel = (model) => /^(?:o\d(?:-|$)|gpt-[5-9](?:\.|-|$))/i.test(model);

export function parseArguments(raw) {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return raw; } // Route validator must reject malformed arguments.
}
