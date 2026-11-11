import { assistantFailureReason } from "../shared/assistantFailure.js";
import { modelErrorMessage } from './modelError.js';

export function assistantFailureMessage(error) {
  return modelErrorMessage(error) || assistantFailureReason(error?.code) || error?.message || '助手连接失败，请稍后重试。';
}

export function withAssistantFailure(messages, failure) {
  if (!failure) return messages;
  const userIndex = messages.findIndex((message) => message.role === 'user'
    && message.clientMessageId === failure.clientMessageId);
  // A lost completion event does not turn an already saved reply into a failure.
  if (userIndex >= 0 && messages[userIndex + 1]?.role === 'assistant') return messages;
  const visible = messages.filter((message) => message.id !== failure.id);
  if (userIndex < 0 && !visible.some((message) => message.id === failure.userMessage.id)) {
    visible.push(failure.userMessage);
  }
  visible.push(failure);
  return visible;
}
