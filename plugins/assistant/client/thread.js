import { t } from "@flaretune/plugin-sdk/pure";

const normalizeThought = (value) => (
  typeof value === 'string' && value ? value : undefined
);

const processFields = (message) => ({
  ...(Array.isArray(message?.images) ? { images: message.images
    .filter(image => typeof image?.id === 'string' && typeof image?.url === 'string')
    .map(({ id, url }) => ({ id, url })) } : {}),
  ...(typeof message?.clientMessageId === 'string' ? { clientMessageId: message.clientMessageId } : {}),
  ...(typeof message?.turnId === 'string' ? { turnId: message.turnId } : {}),
  ...(Array.isArray(message?.processEntries) ? { processEntries: message.processEntries } : {}),
  ...(Array.isArray(message?.toolSummaries) ? { toolSummaries: message.toolSummaries } : {}),
  ...(message?.thinkingRequested === true ? { thinkingRequested: true } : {}),
  ...(message?.isError === true ? { isError: true, errorCode: message.errorCode } : {}),
  ...(typeof message?.partialContent === 'string' ? { partialContent: message.partialContent } : {}),
});

export function normalizeCloudThreadMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message, index) => ({
    id: message?.id || `cloud-${message?.createdAt || index}`,
    role: message?.role,
    content: typeof message?.content === 'string' ? message.content : '',
    createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : undefined,
    thought: normalizeThought(message?.thought),
    ...processFields(message),
  }));
}

export function pendingAssistantTurn(thread) {
  const last = thread?.messages?.at(-1);
  return last?.role === 'user' && typeof thread?.pendingTurn?.clientMessageId === 'string'
    && last.clientMessageId === thread.pendingTurn.clientMessageId
    ? { clientMessageId: thread.pendingTurn.clientMessageId } : null;
}

export function normalizeCloudThread(thread) {
  return {
    revision: Number(thread?.revision || 0),
    pendingTurn: pendingAssistantTurn(thread),
    messages: normalizeCloudThreadMessages(thread?.messages),
  };
}

const fingerprintNormalizedThread = (thread) => JSON.stringify({
  revision: thread.revision,
  messages: thread.messages,
});

export class AiThreadRequestError extends Error {
  constructor(message, { status = 0, data } = {}) {
    super(message);
    this.name = 'AiThreadRequestError';
    this.status = status;
    this.data = data;
  }
}

export async function fetchCloudThread({
  fetchImpl = () => Promise.reject(new Error('Assistant plugin context required')),
  apiBase = '',
  signal,
} = {}) {
  const response = await fetchImpl(`${apiBase}/api/ai/thread`, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new AiThreadRequestError(t("云端线程响应异常 ({p0})", { p0: (response.status) }), {
      status: response.status,
      data,
    });
  }
  const data = await response.json();
  const thread = normalizeCloudThread(data?.thread);
  return {
    thread,
    fingerprint: fingerprintNormalizedThread(thread),
  };
}

const comparableMessage = (message) => ({
  id: message?.id,
  role: message?.role,
  content: typeof message?.content === 'string' ? message.content : '',
  createdAt: Number.isFinite(Number(message?.createdAt)) ? Number(message.createdAt) : undefined,
  thought: normalizeThought(message?.thought),
  ...processFields(message),
});

const messagesMatch = (left, right) => (
  JSON.stringify(comparableMessage(left)) === JSON.stringify(comparableMessage(right))
);

// Called only inside the current account's thread. Keep received process data
// when an older/partial history DTO omits it; never carry removed or edited replies.
export function mergeAssistantProcessMessages(incoming, received = []) {
  const previous = new Map(received.map((message) => [message.id, message]));
  return (Array.isArray(incoming) ? incoming : []).map((message) => {
    const known = previous.get(message.id);
    if (message.role !== 'assistant' || known?.role !== 'assistant'
      || message.content !== known.content
      || (message.thought && known.thought && message.thought !== known.thought)) return message;
    const result = { ...message };
    if (!result.thought && known.thought) result.thought = known.thought;
    const remoteEntries = Array.isArray(message.processEntries) ? message.processEntries : [];
    const knownEntries = Array.isArray(known.processEntries) ? known.processEntries : [];
    const remoteTools = new Map(remoteEntries.filter((entry) => entry?.type === 'tool' && entry.id)
      .map((entry) => [entry.id, entry]));
    if (knownEntries.length && (!remoteEntries.length || knownEntries.some((entry) => (
      entry?.type === 'tool' && entry.id && !remoteTools.has(entry.id)
    )))) {
      const knownIds = new Set(knownEntries.filter((entry) => entry?.type === 'tool').map((entry) => entry.id));
      result.processEntries = [
        ...knownEntries.map((entry) => entry?.type === 'tool' && remoteTools.has(entry.id)
          ? { ...entry, ...remoteTools.get(entry.id) } : entry),
        ...remoteEntries.filter((entry) => entry?.type === 'tool' && !knownIds.has(entry.id)),
      ];
    }
    const summaries = Array.isArray(message.toolSummaries) ? [...message.toolSummaries] : [];
    for (const item of known.toolSummaries || []) {
      if (!summaries.some((remote) => item.id ? remote.id === item.id : remote.summary === item.summary)) {
        summaries.push(item);
      }
    }
    if (summaries.length) result.toolSummaries = summaries;
    return result;
  });
}

export function planCloudThreadSync({
  thread,
  currentMessages,
  previousFingerprint = '',
}) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const normalizedThread = normalizeCloudThread(thread);
  const remote = mergeAssistantProcessMessages(normalizedThread.messages, current);
  const fingerprint = fingerprintNormalizedThread(normalizedThread);
  const hasCurrent = current.length > 0;

  if (fingerprint === previousFingerprint && hasCurrent) {
    return { kind: 'unchanged', fingerprint, messages: current };
  }
  if (remote.length === 0) {
    return { kind: 'empty', fingerprint, messages: [] };
  }

  const canAppend = hasCurrent
    && remote.length > current.length
    && remote.slice(0, current.length).every((message, index) => messagesMatch(message, current[index]));

  return {
    kind: canAppend ? 'append' : 'replace',
    fingerprint,
    messages: canAppend ? [...current, ...remote.slice(current.length)] : remote,
  };
}
