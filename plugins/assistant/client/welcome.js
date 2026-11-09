import { t } from "@flaretune/plugin-sdk/pure";

export const DEFAULT_ASSISTANT_NAME = '小A';
const LEGACY_DEFAULT_WELCOME = '你好，我是小A。想听什么？';

export function resolveAssistantWelcome(assistant) {
  const configured = typeof assistant?.welcomeMessage === 'string' ? assistant.welcomeMessage.trim() : '';
  if (configured && configured !== LEGACY_DEFAULT_WELCOME) return configured;
  const name = typeof assistant?.name === 'string' && assistant.name.trim()
    ? assistant.name.trim() : DEFAULT_ASSISTANT_NAME;
  return t('你好，我是{name}。想听什么？', { name });
}
