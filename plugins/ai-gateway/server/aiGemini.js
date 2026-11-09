import { createJsonEventStreamParser } from "./aiJsonEventStream.js";
import { aiConnection, aiHeaders, fetchAi } from "./aiTransport.js";

export const AI_STREAM_IDLE_TIMEOUT_MS = 12_000;

export function isTerminalGeminiFinishReason(value) {
  const reason = String(value || '').trim().toUpperCase();
  return Boolean(reason && reason !== 'FINISH_REASON_UNSPECIFIED');
}

export function createAiStreamIdleTimeoutError() {
  const error = new Error('AI_STREAM_IDLE_TIMEOUT');
  error.code = 'AI_STREAM_IDLE_TIMEOUT';
  return error;
}

export async function readStreamChunkWithIdleTimeout(reader, timeoutMs = AI_STREAM_IDLE_TIMEOUT_MS) {
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : AI_STREAM_IDLE_TIMEOUT_MS;
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(createAiStreamIdleTimeoutError()), delay);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function buildGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.nativeContext?.protocol === 'gemini_native') {
      contents.push(message.nativeContext.payload);
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      contents.push({
        role: 'model',
        parts: message.tool_calls.map((toolCall) => {
          const fn = toolCall.function;
          let args = fn.arguments || {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args || '{}'); } catch { args = {}; }
          }
          return {
            functionCall: {
              ...(toolCall.id ? { id: toolCall.id } : {}),
              name: fn.name,
              args,
            },
            ...(toolCall.thought_signature ? { thoughtSignature: toolCall.thought_signature } : {}),
          };
        }),
      });
      continue;
    }
    if (message.role === 'tool') {
      let response = message.content;
      if (typeof response === 'string') {
        try { response = JSON.parse(response); } catch { response = { result: response }; }
      }
      const part = {
        functionResponse: {
          ...(message.tool_call_id ? { id: message.tool_call_id } : {}),
          name: message.name,
          response: response && typeof response === 'object' ? response : { result: response },
        },
      };
      const previous = contents[contents.length - 1];
      if (previous?.role === 'user' && previous.parts.every((item) => item.functionResponse)) {
        previous.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: geminiContentParts(message.content),
    });
  }
  return contents;
}

function geminiContentParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) throw new Error('AI_CONTENT_UNSUPPORTED');
  return content.map((part) => {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'image_url') {
      const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(part.image_url.url);
      if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    throw new Error('AI_CONTENT_UNSUPPORTED');
  });
}

export function geminiGenerationConfig(config) {
  const options = config.generationOptions || {};
  const result = { temperature: options.temperature ?? config.temperature ?? 0.2,
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) };
  const modern = /^gemini-3(?:\.|-)/i.test(config.model);
  if (modern) {
    const effort = options.reasoningEffort;
    const minimalSupported = /^gemini-3(?:(?:\.(?:1|5|6))?-flash)(?:-|$)/i.test(config.model);
    const level = config.enableThinking === false || effort === 'none'
      ? (minimalSupported ? 'minimal' : 'low') : effort;
    if (level || config.enableThinking === true) result.thinkingConfig = {
      ...(level ? { thinkingLevel: level } : {}), ...(config.enableThinking === true ? { includeThoughts: true } : {}) };
  } else if (config.enableThinking === false) {
    result.thinkingConfig = { thinkingBudget: /^gemini-2\.5-pro/i.test(config.model) ? 128 : 0 };
  } else if (options.thinkingBudget !== undefined || config.enableThinking === true) {
    result.thinkingConfig = { ...(options.thinkingBudget !== undefined ? { thinkingBudget: options.thinkingBudget } : {}),
      ...(config.enableThinking === true ? { includeThoughts: true } : {}) };
  }
  return result;
}

export function parseGeminiCandidateParts(parts = [], fallbackScope = crypto.randomUUID()) {
  const functionCalls = [];
  let textContent = '';
  for (const part of parts) {
    if (part.functionCall) {
      functionCalls.push({
        id: part.functionCall.id || `call_gemini_${fallbackScope}_${functionCalls.length}_${part.functionCall.name}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
        thoughtSignature: part.thoughtSignature,
      });
    } else if (part.text && !part.thought) {
      textContent += part.text;
    }
  }
  return functionCalls.length > 0
    ? { type: 'function_calls', functionCalls }
    : { type: 'content', content: textContent };
}

export async function askGemini(messages, config, env, signal) {
  const { apiKey, baseUrl } = aiConnection(config, env);
  const systemMessage = messages.find(({ role }) => role === 'system');
  const contents = messages
    .filter(({ role }) => role !== 'system')
    .map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: geminiContentParts(content),
    }));
  const isJsonSchema = messages.some((message) => (
    typeof message.content === 'string' && (message.content.includes('unitId')
      || message.content.includes('songLanguage') || message.content.includes('discardLineIndices'))
  ));
  const requestedFields = messages.filter(({ role }) => role === 'system')
    .map(({ content }) => String(content || '')).join('\n');
  const payload = {
    contents,
    generationConfig: geminiGenerationConfig(config),
  };
  if (isJsonSchema) {
    payload.generationConfig.responseMimeType = 'application/json';
    payload.generationConfig.responseSchema = {
      type: 'OBJECT',
      properties: {
        notNeeded: { type: 'BOOLEAN' },
        ...(requestedFields.includes('songLanguage') ? { songLanguage: { type: 'STRING' } } : {}),
        ...(requestedFields.includes('discardLineIndices')
          ? { discardLineIndices: { type: 'ARRAY', items: { type: 'INTEGER' } } } : {}),
        translations: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              unitId: { type: 'INTEGER' },
              text: { type: 'STRING' },
            },
            required: ['unitId', 'text'],
          },
        },
      },
    };
  }
  if (systemMessage) payload.systemInstruction = { parts: [{ text: systemMessage.content }] };

  const url = `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`;
  const response = await fetchAi(url, {
    method: 'POST',
    headers: aiHeaders('gemini_native', apiKey),
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) throw new Error(`AI_UPSTREAM_${response.status}`);
  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (data.error || (candidate?.finishReason && candidate.finishReason !== 'STOP')) throw new Error('AI_RESPONSE_INCOMPLETE');
  const content = candidate?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI_EMPTY_RESPONSE');
  return content;
}

export async function chatGemini(
  messages,
  tools,
  config,
  env,
  signal,
  onContentDelta,
  onStreamEvent,
  streamIdleTimeoutMs = AI_STREAM_IDLE_TIMEOUT_MS,
  onThoughtDelta,
) {
  const { apiKey, baseUrl } = aiConnection(config, env);

  const systemContent = messages
    .filter(({ role }) => role === 'system')
    .map(({ content }) => content)
    .filter((content) => typeof content === 'string' && content.trim())
    .join('\n\n');
  const payload = {
    contents: buildGeminiContents(messages),
    generationConfig: geminiGenerationConfig(config),
  };
  if (systemContent) payload.systemInstruction = { parts: [{ text: systemContent }] };
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = [{
      functionDeclarations: tools.map((tool) => {
        const fn = tool.function;
        return {
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        };
      }),
    }];
  }

  const model = config.model || 'gemini-3.1-flash-lite';
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new Error('AI_TIMEOUT');
    response = await fetchAi(url, {
      method: 'POST',
      headers: aiHeaders('gemini_native', apiKey),
      redirect: 'manual', // Workers-compatible; the status check below rejects redirects.
      body: JSON.stringify(payload),
      signal,
    }, { allowErrorResponse: true });
    if (response.ok) break;

    if ((response.status === 503 || response.status === 429) && attempt === 0 && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }
    throw new Error(`AI_UPSTREAM_${response.status}`);
  }
  if (!response?.body) throw new Error('AI_EMPTY_RESPONSE');

  const reader = response.body.getReader();
  const candidateParts = [];
  let accumulatedText = '';
  let firstChunkSeen = false;
  let terminalFinishReason = '';
  let streamReachedEof = false;

  const processChunk = async (raw) => {
      if (terminalFinishReason) return;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error('AI_STREAM_INVALID'); }
      if (parsed.error || parsed.promptFeedback?.blockReason) throw new Error('AI_UPSTREAM_FAILURE');
      const candidate = parsed.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      for (const part of parts) {
        candidateParts.push(part);
        if (part.thought && part.text) {
          if (onThoughtDelta) await onThoughtDelta(part.text);
        } else if (part.text && !part.thought) {
          accumulatedText += part.text;
          if (onContentDelta) await onContentDelta(part.text);
        }
      }
      const finishReason = String(candidate?.finishReason || '').trim();
      if (!terminalFinishReason && isTerminalGeminiFinishReason(finishReason)) {
        terminalFinishReason = finishReason;
        onStreamEvent?.({ type: 'finish_reason', finishReason });
      }
  };
  const streamParser = createJsonEventStreamParser(processChunk);

  try {
    while (!terminalFinishReason) {
      let readResult;
      try {
        readResult = await readStreamChunkWithIdleTimeout(reader, streamIdleTimeoutMs);
      } catch (error) {
        if (String(error?.message || '').includes('AI_STREAM_IDLE_TIMEOUT')) {
          onStreamEvent?.({ type: 'idle_timeout' });
        }
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        streamReachedEof = true;
        onStreamEvent?.({ type: 'eof' });
        break;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        onStreamEvent?.({ type: 'first_chunk' });
      }
      await streamParser.push(value);
    }
    await streamParser.flushJsonTail();
  } finally {
    if (terminalFinishReason || !streamReachedEof) {
      try {
        await reader.cancel(
          terminalFinishReason
            ? `Gemini stream finished: ${terminalFinishReason}`
            : 'Gemini stream cancelled before EOF',
        );
      } catch {}
    }
    reader.releaseLock();
  }

  const parsedParts = parseGeminiCandidateParts(candidateParts);
  if (terminalFinishReason !== 'STOP') throw new Error('AI_RESPONSE_INCOMPLETE');
  let callIndex = 0;
  for (const part of candidateParts) if (part.functionCall) {
    part.functionCall.id = parsedParts.functionCalls?.[callIndex++]?.id;
  }
  return {
    ...parsedParts,
    content: accumulatedText || parsedParts.content || '',
    rawMessage: { role: 'model', parts: candidateParts },
    nativeContext: { protocol: 'gemini_native', payload: { role: 'model', parts: candidateParts } },
  };
}
