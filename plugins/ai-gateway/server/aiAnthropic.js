import { aiConnection, aiHeaders, fetchAi, parseArguments } from "./aiTransport.js";
import { consumeAiStream } from "./aiStream.js";

function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new Error('AI_CONTENT_UNSUPPORTED');
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image_url') {
      const url = part.image_url.url;
      const inline = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
      return { type: 'image', source: inline ? { type: 'base64', media_type: inline[1], data: inline[2] }
        : { type: 'url', url } };
    }
    throw new Error('AI_CONTENT_UNSUPPORTED');
  });
}

export function buildAnthropicMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (['system', 'developer'].includes(message.role)) continue;
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) };
      const previous = result.at(-1);
      if (previous?.role === 'user' && previous.content.every((part) => part.type === 'tool_result')) previous.content.push(block);
      else result.push({ role: 'user', content: [block] });
      continue;
    }
    if (message.nativeContext?.protocol === 'anthropic_messages') {
      result.push({ role: 'assistant', content: message.nativeContext.payload });
    } else if (message.tool_calls) {
      result.push({ role: 'assistant', content: message.tool_calls.map((call) => ({ type: 'tool_use',
        id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })) });
    } else result.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: contentBlocks(message.content) });
  }
  return result;
}

function requestBody(messages, tools, config, source, stream) {
  const options = config.generationOptions || {};
  const maxTokens = options.maxOutputTokens || 4096;
  const payload = { model: config.model, max_tokens: maxTokens,
    messages: buildAnthropicMessages(messages), stream };
  const system = messages.filter(({ role }) => ['system', 'developer'].includes(role))
    .map(({ content }) => typeof content === 'string' ? content : '').filter(Boolean).join('\n\n');
  if (system) payload.system = system;
  if (tools?.length) payload.tools = tools.map(({ function: fn }) => ({ name: fn.name,
    description: fn.description, input_schema: fn.parameters }));
  if (config.enableThinking === false || options.reasoningEffort === 'none') payload.thinking = { type: 'disabled' };
  else if (config.enableThinking === true) {
    const legacyModel = /claude-(?:3|(?:opus|sonnet|haiku)-4(?:-(?:[0-5](?:-|$)|\d{8}$)|$))/i.test(config.model);
    const mode = options.thinkingMode || (source === 'deepseek' || legacyModel ? 'enabled' : 'adaptive');
    if (mode === 'adaptive') payload.thinking = { type: 'adaptive' };
    else {
      const budget = options.thinkingBudget ?? 1024;
      if (budget < 1024 || budget >= maxTokens) throw new Error('AI_THINKING_BUDGET_INVALID');
      payload.thinking = { type: 'enabled', budget_tokens: budget };
    }
    if (options.reasoningEffort) payload.output_config = { effort: options.reasoningEffort };
  }
  if (!payload.thinking || payload.thinking.type === 'disabled') payload.temperature = options.temperature ?? config.temperature;
  return payload;
}

function resultFromBlocks(blocks) {
  const calls = blocks.filter((part) => part.type === 'tool_use').map((part) => {
    if (!part.id || !part.name) throw new Error('AI_TOOL_CALL_INVALID');
    return { id: part.id, name: part.name, args: part.input };
  });
  return { type: calls.length ? 'function_calls' : 'content',
    content: blocks.filter((part) => part.type === 'text').map((part) => part.text || '').join(''),
    ...(calls.length ? { functionCalls: calls } : {}),
    nativeContext: { protocol: 'anthropic_messages', payload: blocks } };
}

const normalStop = (reason) => ['end_turn', 'tool_use', 'stop_sequence'].includes(reason);

export async function askAnthropic(messages, config, env, signal) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/messages`, { method: 'POST',
    headers: aiHeaders('anthropic_messages', apiKey), signal,
    body: JSON.stringify(requestBody(messages, [], config, source, false)) });
  const data = await response.json();
  if (!normalStop(data.stop_reason) || !Array.isArray(data.content)) throw new Error('AI_RESPONSE_INCOMPLETE');
  const result = resultFromBlocks(data.content);
  if (result.type !== 'content' || !result.content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return result.content;
}

export async function chatAnthropic(messages, tools, config, env, signal, onContentDelta,
  onThoughtDelta, streamIdleTimeoutMs, onStreamEvent) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/messages`, { method: 'POST',
    headers: aiHeaders('anthropic_messages', apiKey), signal,
    body: JSON.stringify(requestBody(messages, tools, config, source, true)) });
  const blocks = new Map();
  const rawInputs = new Map();
  const closed = new Set();
  let terminal = false;
  let stopReason;
  const processChunk = async (raw) => {
    if (terminal) return;
    let event;
    try { event = JSON.parse(raw); } catch { throw new Error('AI_STREAM_INVALID'); }
    if (event.type === 'error') throw new Error('AI_UPSTREAM_FAILURE');
    if (event.type === 'content_block_start') {
      if (blocks.has(event.index) || !event.content_block) throw new Error('AI_STREAM_INVALID');
      blocks.set(event.index, structuredClone(event.content_block));
      if (event.content_block.type === 'text' && event.content_block.text) await onContentDelta?.(event.content_block.text);
      if (event.content_block.type === 'thinking' && event.content_block.thinking) await onThoughtDelta?.(event.content_block.thinking);
    } else if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block || closed.has(event.index)) throw new Error('AI_STREAM_INVALID');
      const delta = event.delta;
      if (delta?.type === 'text_delta') { block.text = (block.text || '') + delta.text; await onContentDelta?.(delta.text); }
      else if (delta?.type === 'thinking_delta') { block.thinking = (block.thinking || '') + delta.thinking; await onThoughtDelta?.(delta.thinking); }
      else if (delta?.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
      else if (delta?.type === 'input_json_delta') rawInputs.set(event.index, (rawInputs.get(event.index) || '') + delta.partial_json);
    } else if (event.type === 'content_block_stop') {
      if (!blocks.has(event.index)) throw new Error('AI_STREAM_INVALID');
      if (rawInputs.has(event.index)) blocks.get(event.index).input = parseArguments(rawInputs.get(event.index));
      closed.add(event.index);
    } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
      stopReason = event.delta.stop_reason;
      if (!normalStop(stopReason)) throw new Error('AI_RESPONSE_INCOMPLETE');
    } else if (event.type === 'message_stop') {
      if (!normalStop(stopReason) || closed.size !== blocks.size) throw new Error('AI_RESPONSE_INCOMPLETE');
      terminal = true;
    }
  };
  await consumeAiStream(response, processChunk, { isTerminal: () => terminal,
    idleTimeoutMs: streamIdleTimeoutMs, onStreamEvent });
  return resultFromBlocks([...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block));
}
