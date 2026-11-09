import { createToolResult } from "./toolResult.js";

export const playerSeekTool = {
  name: 'player_seek',
  displayName: '跳转播放进度',
  description: '跳转当前播放器的播放位置。只在听众明确要求跳到某个秒数或百分比时使用。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['seconds', 'percent'], description: '按秒数或百分比跳转（默认 seconds）。' },
      position: { type: 'number', minimum: 0, description: '目标秒数或百分比（percent 时为 0-100）。' },
    },
    required: ['position'],
  },
  async execute(args) {
    const isPercent = args?.mode === 'percent';
    const position = Number(args?.position);
    if (!Number.isFinite(position) || position < 0) {
      return createToolResult({
        summary: '跳转参数无效',
        modelText: '跳转位置必须是非负数字。',
        eventData: { type: 'player_seek', ok: false, error: 'invalid_position' },
      });
    }
    const mode = isPercent ? 'percent' : 'seconds';
    const targetText = isPercent ? `跳转播放进度至 ${Math.round(position)}%` : `跳转播放进度至 ${Math.round(position)} 秒`;
    return createToolResult({
      summary: `播放器指令已生成：${targetText}`,
      modelText: `播放器指令已生成，浏览器执行结果未知。目标：${targetText}。`,
      eventData: { type: 'player_seek', ok: true, action: 'seek', mode, position, instruction_status: 'generated', browser_execution: 'unknown' },
      playerAction: {
        type: 'seek',
        action: 'seek',
        mode,
        position,
      },
    });
  },
};
