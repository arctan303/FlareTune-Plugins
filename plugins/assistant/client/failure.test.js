import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantFailureMessage, withAssistantFailure } from './failure.js';
import { normalizeCloudThreadMessages } from './thread.js';

const failure = { id: 'optimistic-assistant', role: 'assistant', clientMessageId: 'request-1',
  userMessage: { id: 'optimistic-user', role: 'user', content: '记忆测试' },
  content: '模型响应超时', isError: true, processEntries: [{ type: 'tool', id: 'memory-1' }] };

test('failure and received process survive a successful canonical thread refresh', () => {
  const canonical = normalizeCloudThreadMessages([{ id: 'saved-user', role: 'user', content: '记忆测试',
    clientMessageId: 'request-1' }]);
  const visible = withAssistantFailure(canonical, failure);
  assert.equal(visible.length, 2);
  assert.equal(visible[0].id, 'saved-user');
  assert.equal(visible[1].isError, true);
  assert.deepEqual(visible[1].processEntries, failure.processEntries);
  assert.equal(canonical.length, 1);
});

test('transport failures keep the unsaved request visible and replace generating placeholders', () => {
  assert.deepEqual(withAssistantFailure([], failure), [failure.userMessage, failure]);
  assert.deepEqual(withAssistantFailure([failure.userMessage, { id: failure.id, isGenerating: true }], failure),
    [failure.userMessage, failure]);
});

test('a reply saved before transport interruption is shown without a false failure', () => {
  const canonical = normalizeCloudThreadMessages([
    { id: 'saved-user', role: 'user', clientMessageId: 'request-1', content: '记忆测试' },
    { id: 'saved-assistant', role: 'assistant', content: '已完成' },
  ]);
  assert.equal(withAssistantFailure(canonical, failure), canonical);
  // An older identical request is not mistaken for the failed request.
  canonical[0].clientMessageId = 'request-old';
  assert.equal(withAssistantFailure(canonical, failure).at(-1).isError, true);
});

test('server timeout codes have specific reasons and unknown failures retain their message', () => {
  assert.match(assistantFailureMessage({ code: 'upstream_idle_timeout' }), /长时间没有返回内容/);
  assert.match(assistantFailureMessage({ code: 'upstream_timeout' }), /响应超时/);
  assert.match(assistantFailureMessage({ code: 'upstream_unavailable' }), /暂时不可用/);
  assert.match(assistantFailureMessage({ code: 'upstream_rate_limited' }), /过于频繁/);
  assert.match(assistantFailureMessage({ code: 'tool_call_limit' }), /单次最多允许 4 个/);
  assert.match(assistantFailureMessage({ code: 'invalid_tool_call_id' }), /标识格式无效/);
  assert.match(assistantFailureMessage({ code: 'duplicate_tool_call_id' }), /标识重复/);
  assert.equal(assistantFailureMessage({ message: '助手响应未完成' }), '助手响应未完成');
  assert.equal(withAssistantFailure([], null).length, 0);
});

test('reloaded failure records retain ordered process, tool results and failure status', () => {
  const recorded = { id: 'persisted-failure', role: 'assistant', content: '模型响应超时',
    isError: true, errorCode: 'upstream_timeout', thinkingRequested: true, thought: '已执行查询',
    processEntries: [{ type: 'thought', start: 0, end: 5 }, { type: 'tool', id: 'query', ok: true }],
    toolSummaries: [{ id: 'query', summary: '已查询', ok: true }] };
  const normalized = normalizeCloudThreadMessages([recorded])[0];
  assert.equal(normalized.isError, true);
  assert.equal(normalized.errorCode, recorded.errorCode);
  assert.deepEqual(normalized.processEntries, recorded.processEntries);
  assert.deepEqual(normalized.toolSummaries, recorded.toolSummaries);
  assert.equal(normalized.thinkingRequested, true);
});
