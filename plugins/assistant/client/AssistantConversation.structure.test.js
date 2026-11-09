import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('AiReviewConversation remains a prop-driven presentational boundary on the assistant page', () => {
  const conversation = readSource('./AssistantConversation.jsx');
  const page = readSource('./AssistantView.jsx');

  assert.match(page, /<AiReviewConversation/);
  assert.match(page, /containerRef=\{chatContainerRef\}/);
  assert.match(page, /onToggleDetails=\{toggleExpandDetails\}/);
  assert.match(page, /onPreviewImage=\{/);
  assert.match(page, /<ImagePreviewDialog/);
  assert.match(conversation, /onPreviewImage\?\.\(message\.id, image\.id\)/);
  assert.doesNotMatch(conversation, /<ImagePreviewDialog/);
  assert.match(conversation, /messages\.map\(\(message\) =>/);
  assert.doesNotMatch(conversation, /AssistantMusicCard|XiaoaMessageMusicCards|displaySongs/);
  assert.doesNotMatch(conversation, /use(?:Effect|LayoutEffect|State|Store)|fetch\(|window\.|localStorage|sessionStorage/);
});

test('AiReviewConversation leaves song recommendations in prose and drops the retired blog thought branch', () => {
  const conversation = readSource('./AssistantConversation.jsx');

  assert.match(conversation, /<MarkdownContent host={host} content=\{displayContent\}/);
  assert.doesNotMatch(conversation, /message\.songs|message\.displaySongs/);
  assert.doesNotMatch(conversation, /content=\{message\.content\}/);
  // 一方札记（博客）工具已移除，思考态文案不再保留文章检索分支。
  assert.doesNotMatch(conversation, /札记|文章/);
});

test('AiReviewConversation renders an accessible message time from createdAt', () => {
  const conversation = readSource('./AssistantConversation.jsx');

  assert.match(conversation, /const resolveMessageTime = \(createdAt\) =>/);
  assert.match(conversation, /const messageTime = resolveMessageTime\(message\.createdAt\)/);
  assert.match(conversation, /<time\s+dateTime=\{messageTime\.dateTime\}/);
  assert.equal((conversation.match(/<time\b/g) || []).length, 2);
  assert.match(conversation, /\{messageTime\.label\}/);
});

test('processing status remains expandable while thought and tool events stream in', () => {
  const conversation = readSource('./AssistantConversation.jsx');
  assert.match(conversation, /onClick=\{\(\) => onToggleDetails\(message\.id\)\}/);
  assert.match(conversation, /aria-expanded=\{isDetailsExpanded\}/);
  assert.match(conversation, /\{isDetailsExpanded && \(/);
  assert.doesNotMatch(conversation, /!isGenerating && isDetailsExpanded/);
});
