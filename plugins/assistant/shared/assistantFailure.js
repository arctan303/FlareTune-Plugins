const reasons = {
  upstream_idle_timeout: '模型长时间没有返回内容，本次请求已停止。请重试。',
  upstream_timeout: '模型响应超时，本次请求已停止。请重试。',
  upstream_unavailable: '模型服务暂时不可用，请稍后重试。',
  upstream_rate_limited: '模型服务请求过于频繁，请稍后重试。',
  invalid_tool_arguments: '模型返回的工具参数无效，本次处理已停止。',
  invalid_tool_calls: '模型返回的工具调用无效，本次处理已停止。',
  tool_call_limit: '模型一次请求了过多工具，单次最多允许 4 个；该批工具均未执行。',
  invalid_tool_call_id: '模型返回的工具调用标识格式无效，该批工具均未执行。',
  duplicate_tool_call_id: '模型返回的工具调用标识重复，该批工具均未执行。此前已完成的操作仍然有效。',
  unsupported_tool: '模型请求了不支持的工具，本次处理已停止。',
  empty_response: '模型没有返回有效回答，本次处理已停止。',
  request_cancelled: '本次处理已停止，未完成的操作结果尚未确认。',
  thread_conflict: '对话已在其他页面更新，本次处理未能保存。',
  request_in_progress: '上一条请求尚未收尾，请稍候或停止生成后再发送。',
  upstream_failure: '模型处理失败，请稍后重试。',
};

export function assistantFailureReason(code) { return reasons[code]; }

export function assistantInternalFailureCode(error) {
  return { AI_INVALID_TOOL_ARGUMENTS: 'invalid_tool_arguments', AI_INVALID_TOOL_CALLS: 'invalid_tool_calls',
    AI_TOOL_CALL_LIMIT: 'tool_call_limit', AI_INVALID_TOOL_CALL_ID: 'invalid_tool_call_id',
    AI_DUPLICATE_TOOL_CALL_ID: 'duplicate_tool_call_id',
    AI_UNSUPPORTED_TOOL: 'unsupported_tool', AI_EMPTY_RESPONSE: 'empty_response',
    AI_STREAM_CANCELLED: 'request_cancelled', THREAD_CONFLICT: 'thread_conflict' }[error?.message];
}
