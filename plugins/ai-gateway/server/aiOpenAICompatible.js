import { aiConnection, aiHeaders, fetchAi, isOpenAiReasoningModel,
  parseArguments, requestReasoningEffort } from "./aiTransport.js";
import { consumeAiStream } from "./aiStream.js";

export const wantsJson = (messages) => messages.some(({ content }) => typeof content === 'string'
  && /json|unitId|songLanguage|discardLineIndices/i.test(content));

export function buildChatMessages(messages) {
  return messages.map((message) => {
    if (message.nativeContext?.protocol === 'chat_completions') return message.nativeContext.payload;
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id,
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) };
    return { role: message.role, content: message.content ?? '',
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : {}) };
  });
}

function requestBody(messages, tools, config, source, stream) {
  const options = config.generationOptions || {};
  const reasoningModel = source === 'openai' && isOpenAiReasoningModel(config.model);
  const payload = { model: source === 'deepseek' && !config.exactModel
    && ['deepseek-chat', 'deepseek-reasoner'].includes(config.model) ? 'deepseek-flash' : config.model,
  messages: buildChatMessages(messages), stream,
  ...(!reasoningModel ? { temperature: options.temperature ?? config.temperature ?? 0.2 } : {}),
  ...(options.maxOutputTokens ? { max_completion_tokens: options.maxOutputTokens } : {}) };
  if (source === 'deepseek' && config.enableThinking !== undefined) payload.thinking = {
    type: config.enableThinking ? 'enabled' : 'disabled' };
  else if (reasoningModel || options.reasoningEffort) {
    const effort = requestReasoningEffort(config);
    if (effort) payload.reasoning_effort = effort;
  }
  if (source === 'deepseek' && options.maxOutputTokens) {
    delete payload.max_completion_tokens;
    payload.max_tokens = options.maxOutputTokens;
  }
  if (tools?.length) payload.tools = tools.map(({ function: fn }) => ({ type: 'function',
    function: { name: fn.name, description: fn.description, parameters: fn.parameters } }));
  if (!stream && wantsJson(messages)) payload.response_format = { type: 'json_object' };
  return payload;
}

export async function askChatCompletions(messages, config, env, signal) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/chat/completions`, { method: 'POST',
    headers: aiHeaders('chat_completions', apiKey), signal,
    body: JSON.stringify(requestBody(messages, [], config, source, false)) });
  const data = await response.json();
  const choice = data.choices?.[0];
  if (data.error || (choice?.finish_reason && !['stop', 'tool_calls'].includes(choice.finish_reason))) {
    throw new Error('AI_RESPONSE_INCOMPLETE');
  }
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return content;
}

export async function chatOpenAICompatible(messages, tools, config, env, signal,
  onContentDelta, onThoughtDelta, streamIdleTimeoutMs, onStreamEvent) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/chat/completions`, { method: 'POST',
    headers: aiHeaders('chat_completions', apiKey), signal,
    body: JSON.stringify(requestBody(messages, tools, config, source, true)) });
  const calls = new Map();
  let text = '';
  let thought = '';
  let terminal = false;
  const processChunk = async (raw) => {
    if (terminal) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('AI_STREAM_INVALID'); }
    if (parsed.error) throw new Error('AI_UPSTREAM_FAILURE');
    const choice = parsed.choices?.[0];
    const delta = choice?.delta || choice?.message;
    if (typeof delta?.content === 'string') {
      text += delta.content;
      await onContentDelta?.(delta.content);
    }
    const reasoning = delta?.reasoning_content || delta?.reasoning;
    if (typeof reasoning === 'string') { thought += reasoning; await onThoughtDelta?.(reasoning); }
    if (Array.isArray(delta?.tool_calls)) for (const [position, call] of delta.tool_calls.entries()) {
      const index = Number.isInteger(call.index) ? call.index : position;
      const current = calls.get(index) || { id: '', name: '', arguments: '' };
      if (call.id) current.id += call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += typeof call.function.arguments === 'string'
        ? call.function.arguments : JSON.stringify(call.function.arguments);
      calls.set(index, current);
    }
    if (choice?.finish_reason) {
      if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error('AI_RESPONSE_INCOMPLETE');
      terminal = true;
    }
  };
  await consumeAiStream(response, processChunk, { isTerminal: () => terminal,
    onDone: () => { terminal = true; }, idleTimeoutMs: streamIdleTimeoutMs, onStreamEvent });
  const rawCalls = [...calls.values()].map((call, index) => ({ id: call.id || `call_${index}_${crypto.randomUUID()}`,
    type: 'function', function: { name: call.name, arguments: call.arguments } }));
  const rawMessage = { role: 'assistant', content: text,
    ...(thought ? { reasoning_content: thought } : {}), ...(rawCalls.length ? { tool_calls: rawCalls } : {}) };
  return { type: rawCalls.length ? 'function_calls' : 'content', content: text, reasoningContent: thought,
    ...(rawCalls.length ? { functionCalls: rawCalls.map((call) => ({ id: call.id,
      name: call.function.name, args: parseArguments(call.function.arguments) })) } : {}),
    rawMessage, nativeContext: { protocol: 'chat_completions', payload: rawMessage } };
}
