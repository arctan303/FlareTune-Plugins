const requireText = (value, field) => {
  if (typeof value !== 'string') throw new TypeError(`Tool result ${field} must be a string`);
  return value;
};

const requireEventData = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Tool result eventData must be an object');
  }
  if (typeof value.ok !== 'boolean') {
    throw new TypeError('Tool result eventData.ok must be a boolean');
  }
  return value;
};

/**
 * Canonical server-tool result consumed by the AI loop.
 *
 * - modelText: text returned to the model as the tool message
 * - eventData: structured payload emitted through SSE
 * - playerAction: optional browser-side player instruction
 */
export function assertToolResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Tool result must be an object');
  }
  const { modelText, summary, eventData, playerAction } = value;
  requireText(modelText, 'modelText');
  requireText(summary, 'summary');
  requireEventData(eventData);
  if (['result', 'content', 'data', 'songs', 'articles', 'cards'].some((field) => Object.hasOwn(value, field))) {
    throw new TypeError('Tool result contains a retired DTO field');
  }
  if (!Object.hasOwn(value, 'playerAction')) throw new TypeError('Tool result playerAction is required');
  return value;
}

export function createToolResult({
  modelText,
  summary,
  eventData,
  playerAction = null,
}) {
  return assertToolResult({
    modelText,
    summary,
    eventData,
    playerAction,
  });
}

export function createToolFailure({
  modelText,
  summary,
  type,
  code,
  message,
  data = {},
}) {
  const error = { code, ...(message ? { message } : {}) };
  return createToolResult({
    modelText,
    summary,
    eventData: { type, ...data, ok: false, error },
  });
}
