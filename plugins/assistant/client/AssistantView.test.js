import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

test('AssistantView provides a full-page conversation without a fixed header', () => {
  const xiaoa = readSource('./AssistantView.jsx');
  const composer = readSource('./Composer.jsx');

  // 页面化容器和无障碍标题；导航与操作使用现有侧边栏。
  assert.match(xiaoa, /xiaoa-page assistant-page/);
  assert.doesNotMatch(xiaoa, /<h1/);
  assert.doesNotMatch(xiaoa, /assistant-header app-page-heading/);
  assert.doesNotMatch(xiaoa, /AI ASSISTANT/);

  // 思考模式靠近输入框，清空仍由对话页处理。
  assert.match(xiaoa, /enableThinking/);
  assert.match(xiaoa, /setEnableThinking/);
  assert.match(xiaoa, /handleClearMessages/);
  assert.match(composer, /aria-pressed=\{Boolean\(enableThinking\)\}/);

  // 对话流与输入组件
  assert.match(xiaoa, /AiReviewConversation/);
  assert.match(xiaoa, /AiReviewComposer/);
  assert.match(xiaoa, /createAiResponseTypewriter/);
  assert.match(xiaoa, /consumeSseJsonStream/);
  assert.match(xiaoa, /handleSuggestionClick/);

  // 抽屉解耦：不使用 DrawerFrame 与抽屉过渡
  assert.doesNotMatch(xiaoa, /DrawerFrame/);
  assert.doesNotMatch(xiaoa, /useDrawerTransition/);

  // 本地会话独占认证；线程采用服务端 revision 与稳定客户端消息 ID。
  assert.match(xiaoa, /isAuthed = Boolean\(authSession\?\.authenticated\)/);
  assert.match(xiaoa, /client_message_id: clientMessageId/);
  assert.match(xiaoa, /revision: threadRevisionRef\.current/);
  assert.match(xiaoa, /event\.type === 'thread_state'/);
  assert.match(xiaoa, /event\.type === 'tool_call'/);
  assert.match(xiaoa, /event\.type === 'tool_result'/);
  assert.match(xiaoa, /captureAssistantLiveContext\(host\.player\.getSnapshot\(\)/);
  assert.match(xiaoa, /event\.type === 'player_action'/);
  assert.match(xiaoa, /event\.type === 'error'/);
  assert.match(xiaoa, /assistantFetch\(host, url, init\)/);
  assert.doesNotMatch(xiaoa, /X-XiaoA-CSRF/);
  assert.match(xiaoa, /<AiReviewComposer[\s\S]*authenticated=\{isAuthed\}/);
});
