export function createJsonEventStreamParser(processJson, { onDone } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  let event = '';

  const dispatch = async () => {
    const raw = data.join('\n');
    const type = event;
    data = [];
    event = '';
    if (!raw) return;
    if (raw.trim() === '[DONE]') { await onDone?.(); return; }
    await processJson(raw, type);
  };

  const processLine = async (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed) { await dispatch(); return; }
    if (trimmed.startsWith('data:')) {
      data.push(trimmed.slice(5).replace(/^ /, ''));
      return;
    }
    if (trimmed.startsWith('event:')) { event = trimmed.slice(6).trim(); return; }
    // Retain the original NDJSON compatibility without treating SSE fields as JSON.
    if (trimmed.trimStart().startsWith('{')) await processJson(trimmed);
  };

  return {
    async push(value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) await processLine(line);
    },
    async flushJsonTail() {
      const tail = (buffer + decoder.decode()).trim();
      buffer = '';
      if (tail) await processLine(tail);
      await dispatch();
    },
  };
}
