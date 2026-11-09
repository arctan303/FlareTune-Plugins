import {
  askGemini,
  chatGemini,
} from "./aiGemini.js";
import {
  askChatCompletions,
  chatOpenAICompatible,
} from "./aiOpenAICompatible.js";
import { askResponses, chatResponses } from "./aiResponses.js";
import { askAnthropic, chatAnthropic } from "./aiAnthropic.js";
import { AI_PROTOCOLS, AI_SOURCES, legacyProtocol, normalizeGenerationOptions, sourceFromProvider } from "../shared/aiProtocols.js";
import { setAiConnectionTimeout } from "./aiTransport.js";

export {
  AI_STREAM_IDLE_TIMEOUT_MS,
  buildGeminiContents,
  createAiStreamIdleTimeoutError,
  isTerminalGeminiFinishReason,
  parseGeminiCandidateParts,
  readStreamChunkWithIdleTimeout,
} from "./aiGemini.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 120_000;

export function getPublicAiErrorCode(error) {
  const message = String(error?.message || error || '');
  if (message.includes('AI_STREAM_IDLE_TIMEOUT')) return 'upstream_idle_timeout';
  if (message.includes('AI_TIMEOUT') || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return 'upstream_timeout';
  }
  if (message.includes('AI_UPSTREAM_503') || message.includes('503')) return 'upstream_unavailable';
  if (message.includes('AI_UPSTREAM_429') || message.includes('429')) return 'upstream_rate_limited';
  return 'upstream_failure';
}

const getTimeoutMs = (env, requestedTimeoutMs) => {
  const configured = Number(requestedTimeoutMs ?? env?.AI_TRANSLATION_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 5000) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(configured), MAX_TIMEOUT_MS);
};

export function resolveAIConfig(configInput = {}) {
  const provider = String(configInput.provider || '').trim().toLowerCase();
  const model = String(configInput.model || '').trim();
  if (!provider || !model) throw new Error('AI_CONFIG_INVALID');
  if (!['gemini', 'deepseek', 'openai', 'anthropic'].includes(provider)) throw new Error('UNSUPPORTED_PROVIDER');
  const source = configInput.source || sourceFromProvider(provider);
  const protocol = configInput.protocol || (provider === 'anthropic' ? 'anthropic_messages' : legacyProtocol(provider));
  if (!Object.hasOwn(AI_PROTOCOLS, protocol) || !Object.hasOwn(AI_SOURCES, source)) throw new Error('AI_PROTOCOL_UNSUPPORTED');
  const generationOptions = normalizeGenerationOptions(configInput.generationOptions, protocol);
  const temperature = typeof configInput.temperature === 'number' ? configInput.temperature : 0.2;
  const enableThinking = configInput.enableThinking !== undefined ? Boolean(configInput.enableThinking) : undefined;
  return { provider, source, protocol, generationOptions, model, temperature, ...(enableThinking !== undefined ? { enableThinking } : {}),
    ...(configInput.exactModel === true ? { exactModel: true } : {}) };
}

export async function getAIAssistantConfig(db, assistantId) {
  if (!db?.prepare) throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE');
  const row = await db.prepare(
    'SELECT id, name, provider, model, system_prompt, temperature FROM AI_Assistants WHERE id = ?',
  ).bind(assistantId).first();
  if (!row?.provider || !row?.model) throw new Error('AI_ASSISTANT_CONFIG_UNAVAILABLE');
  return {
    provider: row.provider,
    model: row.model,
    systemPrompt: row.system_prompt || '',
    temperature: typeof row.temperature === 'number' ? row.temperature : 0.2,
  };
}

const withAiTimeout = async (env, options, execute) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options?.signal?.addEventListener('abort', abort, { once: true });
  if (options?.signal?.aborted) abort();
  if (options?.timeoutPolicy === 'idle') setAiConnectionTimeout(controller.signal,
    getTimeoutMs(env, options?.connectionTimeoutMs));
  const timer = options?.timeoutPolicy === 'idle' ? null : setTimeout(
    () => controller.abort(),
    getTimeoutMs(env, options?.timeoutMs),
  );
  try {
    return await execute(controller.signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('AI_TIMEOUT');
    if (String(error?.message || '').startsWith('AI_')) throw error;
    throw new Error('AI_UPSTREAM_FAILURE');
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abort);
  }
};

/**
 * 统一非流式 AI 请求服务。
 * @param {Array<{role: string, content: string}>} messages
 * @param {Object} configInput 当前数据库解析出的 provider/model 配置
 * @param {Object} env 环境变量包含 API Key
 * @param {Object} options 包含 timeoutMs 等选项
 */
export async function askAI(messages, configInput = {}, env = {}, options = {}) {
  const config = resolveAIConfig(configInput);
  return withAiTimeout(env, { ...options, timeoutPolicy: 'total' }, (signal) => {
    if (config.protocol === 'gemini_native') return askGemini(messages, config, env, signal);
    if (config.protocol === 'responses') return askResponses(messages, config, env, signal);
    if (config.protocol === 'anthropic_messages') return askAnthropic(messages, config, env, signal);
    return askChatCompletions(messages, config, env, signal);
  });
}

/**
 * 多轮对话与 Tool Calling 服务。
 */
export async function chatAI(messages, tools = [], configInput = {}, env = {}, options = {}) {
  const config = resolveAIConfig(configInput);
  const onContentDelta = typeof options?.onContentDelta === 'function' ? options.onContentDelta : null;
  const onThoughtDelta = typeof options?.onThoughtDelta === 'function' ? options.onThoughtDelta : null;

  return withAiTimeout(env, options, (signal) => {
    if (config.protocol !== 'gemini_native') {
      const adapter = { chat_completions: chatOpenAICompatible, responses: chatResponses,
        anthropic_messages: chatAnthropic }[config.protocol];
      return adapter(
        messages,
        tools,
        config,
        env,
        signal,
        onContentDelta,
        onThoughtDelta,
        options?.streamIdleTimeoutMs,
        options?.onStreamEvent,
      );
    }
    return chatGemini(
      messages,
      tools,
      config,
      env,
      signal,
      onContentDelta,
      options?.onStreamEvent,
      options?.streamIdleTimeoutMs,
      onThoughtDelta,
    );
  });
}
