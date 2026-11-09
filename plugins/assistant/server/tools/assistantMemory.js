import { saveAssistantMemory, readAssistantMemories, deleteAssistantMemory, mergeAssistantMemories, memoryEnabled, MemoryError } from "../memory.js";
import { createToolFailure, createToolResult } from "./toolResult.js";

export const assistantMemoryTool = {
  name: 'remember_user',
  displayName: '记忆',
  description: '开启记忆后维护当前账号的长期资料。list 查询全部记忆及 ID；save 新增或按 ID 修改；delete 真实删除过时/重复条目；merge 更新保留的 id 并原子删除 merge_ids。最多 30 条，优先更新合并而非重复累加。禁止保存可工具查询的播放次数、排名、歌单数量等易变快照；推断标 inferred。禁止凭据、编造、覆盖或删除用户手动编辑条目。',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'save', 'delete', 'merge'], description: '默认 save；list 不需要其他参数。' },
    content: { type: 'string', maxLength: 240, description: '简短、具体、可在未来对话使用的记忆。推断用可能/似乎等措辞。' },
    source: { type: 'string', enum: ['stated', 'inferred'], description: '用户明确陈述为 stated；由收听信息推断为 inferred。' },
    id: { type: 'string', description: '修正已有记忆时提供精确 ID；新记忆省略。' },
    merge_ids: { type: 'array', minItems: 1, maxItems: 29, items: { type: 'string' }, description: 'merge 时要删除的重复/过时条目 ID，不包含保留 id。' },
  }, required: [] },
  async execute(args, context = {}) {
    try {
      const action = args.action || 'save';
      if (!await memoryEnabled(context.db, context.accountId)) throw new MemoryError('memory_disabled', 403);
      let result;
      if (action === 'list') {
        const data = await readAssistantMemories(context.db, context.accountId, { forAssistant: true });
        if (!data.enabled) throw new MemoryError('memory_disabled', 403);
        return createToolResult({ modelText: JSON.stringify({ memories: data.memories, capacity: 30 }),
          summary: `已查询 ${data.memories.length} 条记忆`, eventData: { ok: true, type: 'assistant_memory', action: 'listed' } });
      }
      if (action === 'delete') {
        await deleteAssistantMemory(context.db, context.accountId, args.id, { actor: 'assistant' });
        result = { action: 'deleted', id: args.id };
      } else if (action === 'merge') result = await mergeAssistantMemories(context.db, context.accountId, args);
      else if (action === 'save') result = await saveAssistantMemory(context.db, context.accountId, {
        id: args.id, content: args.content, source: args.source, actor: 'assistant',
      });
      else throw new MemoryError('invalid_input');
      return createToolResult({ modelText: result.action === 'unchanged' ? '这条记忆已经存在，无需重复记录。'
        : `记忆维护成功：${JSON.stringify(result)}`,
      summary: result.action === 'unchanged' ? '记忆已存在' : '已记住',
      eventData: { ok: true, type: 'assistant_memory', ...result } });
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : 'storage_unavailable';
      return createToolFailure({ modelText: `记忆操作未完成（${code}）；不要声称已保存或删除。手动编辑条目只能由用户管理。`,
        summary: '记忆操作未完成', type: 'assistant_memory', code,
        message: code });
    }
  },
};
