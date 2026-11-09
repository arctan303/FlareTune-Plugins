import { aiConnection, aiHeaders, fetchAi, isOpenAiReasoningModel, parseArguments,
  requestReasoningEffort } from "./aiTransport.js";
import { consumeAiStream } from "./aiStream.js";
import { wantsJson } from "./aiOpenAICompatible.js";

export function buildResponsesInput(messages) {
  return messages.flatMap((message) => {
    if (message.nativeContext?.protocol === 'responses') return message.nativeContext.payload;
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }];
    if (message.tool_calls) return message.tool_calls.map((call) => ({ type: 'function_call',
      call_id: call.id, name: call.function.name, arguments: call.function.arguments }));
    const content = Array.isArray(message.content) ? message.content.map((part) => {
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
      if (part.type === 'text') return { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
      throw new Error('AI_CONTENT_UNSUPPORTED');
    }) : message.content;
    return [{ role: message.role, content }];
  });
}

function body(messages, tools, config, source, stream) {
  const options = config.generationOptions || {};
  const reasoning = source === 'deepseek' || (source === 'openai' && isOpenAiReasoningModel(config.model))
    || options.reasoningEffort;
  const effort = reasoning ? requestReasoningEffort(config) : undefined;
  return { model: config.model, input: buildResponsesInput(messages), stream, store: false,
    ...(!(source === 'openai' && isOpenAiReasoningModel(config.model))
      ? { temperature: options.temperature ?? config.temperature } : {}),
    ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
    ...(effort ? { reasoning: { effort,
      ...(source === 'openai' && config.enableThinking === true ? { summary: 'auto' } : {}) } } : {}),
    ...(source === 'openai' && isOpenAiReasoningModel(config.model)
      ? { include: ['reasoning.encrypted_content'] } : {}),
    ...(tools?.length ? { tools: tools.map(({ function: fn }) => ({ type: 'function',
      name: fn.name, description: fn.description, parameters: fn.parameters, strict: false })) } : {}),
    ...(!stream && wantsJson(messages) ? { text: { format: { type: 'json_object' } } } : {}) };
}

function readOutput(output) {
  if (!Array.isArray(output)) throw new Error('AI_RESPONSE_INVALID');
  let content = '';
  const functionCalls = [];
  for (const item of output) {
    if (item.status === 'incomplete' || item.status === 'in_progress') throw new Error('AI_RESPONSE_INCOMPLETE');
    if (item.type === 'message') content += (item.content || []).filter((part) => part.type === 'output_text')
      .map((part) => part.text || '').join('');
    if (item.type === 'function_call') {
      if (!item.call_id || !item.name || typeof item.arguments !== 'string') throw new Error('AI_TOOL_CALL_INVALID');
      functionCalls.push({ id: item.call_id, name: item.name, args: parseArguments(item.arguments) });
    }
  }
  return { type: functionCalls.length ? 'function_calls' : 'content', content,
    ...(functionCalls.length ? { functionCalls } : {}),
    nativeContext: { protocol: 'responses', payload: output } };
}

export async function askResponses(messages, config, env, signal) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/responses`, { method: 'POST',
    headers: aiHeaders('responses', apiKey), signal,
    body: JSON.stringify(body(messages, [], config, source, false)) });
  const data = await response.json();
  if (data.status !== 'completed' || data.error) throw new Error('AI_RESPONSE_INCOMPLETE');
  const result = readOutput(data.output);
  if (result.type !== 'content' || !result.content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return result.content;
}

export async function chatResponses(messages, tools, config, env, signal, onContentDelta,
  onThoughtDelta, streamIdleTimeoutMs, onStreamEvent) {
  const { apiKey, baseUrl, source } = aiConnection(config, env);
  const response = await fetchAi(`${baseUrl}/responses`, { method: 'POST',
    headers: aiHeaders('responses', apiKey), signal,
    body: JSON.stringify(body(messages, tools, config, source, true)) });
  const items = new Map();
  let terminal = false;
  let output;
  let streamedText = '';
  const processChunk = async (raw) => {
    if (terminal) return;
    let event;
    try { event = JSON.parse(raw); } catch { throw new Error('AI_STREAM_INVALID'); }
    const type = event.type;
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') throw new Error('AI_RESPONSE_INCOMPLETE');
    if (type === 'response.output_text.delta') {
      streamedText += event.delta || '';
      await onContentDelta?.(event.delta || '');
    } else if (['response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(type)) {
      await onThoughtDelta?.(event.delta || '');
    } else if (type === 'response.output_item.done') {
      if (!event.item) throw new Error('AI_STREAM_INVALID');
      items.set(event.output_index, event.item);
    } else if (type === 'response.completed') {
      if (event.response?.status !== 'completed' || event.response.error) throw new Error('AI_RESPONSE_INCOMPLETE');
      output = event.response.output || [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      terminal = true;
    }
  };
  await consumeAiStream(response, processChunk, { isTerminal: () => terminal,
    idleTimeoutMs: streamIdleTimeoutMs, onStreamEvent });
  const result = readOutput(output);
  if (!streamedText && result.content) await onContentDelta?.(result.content);
  return result;
}
