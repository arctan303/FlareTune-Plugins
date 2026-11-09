import { createJsonEventStreamParser } from "./aiJsonEventStream.js";

export const AI_STREAM_IDLE_TIMEOUT_MS = 12000;
export function createAiStreamIdleTimeoutError() {
  const error = new Error('AI_STREAM_IDLE_TIMEOUT');
  error.code = 'AI_STREAM_IDLE_TIMEOUT';
  return error;
}
export async function readStreamChunkWithIdleTimeout(reader, timeoutMs = AI_STREAM_IDLE_TIMEOUT_MS) {
  const delay = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs)) : AI_STREAM_IDLE_TIMEOUT_MS;
  let timer;
  try {
    return await Promise.race([reader.read(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(createAiStreamIdleTimeoutError()), delay);
    })]);
  } finally { clearTimeout(timer); }
}

export async function consumeAiStream(response, processJson, { isTerminal, onDone, idleTimeoutMs,
  onStreamEvent } = {}) {
  if (!response.body) throw new Error('AI_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const parser = createJsonEventStreamParser(processJson, { onDone });
  try {
    while (!isTerminal?.()) {
      const { done, value } = await readStreamChunkWithIdleTimeout(reader, idleTimeoutMs);
      if (done) { await parser.flushJsonTail(); break; }
      await parser.push(value);
    }
    if (!isTerminal?.()) throw new Error('AI_STREAM_INCOMPLETE');
  } catch (error) {
    if (String(error?.message).includes('AI_STREAM_IDLE_TIMEOUT')) onStreamEvent?.({ type: 'idle_timeout' });
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
