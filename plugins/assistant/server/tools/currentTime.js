import { createToolResult } from "./toolResult.js";

export const DEFAULT_TIME_ZONE = 'Asia/Singapore';

function dateTimeParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  const zoneName = value('timeZoneName');
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}:${value('second')}`,
    utc_offset: zoneName === 'GMT' ? '+00:00' : zoneName.replace(/^GMT/, ''),
  };
}

export const currentTimeTool = {
  name: 'current_time',
  displayName: '查询当前时间',
  description: '查询 Worker 服务端当前时间。可指定 IANA 时区；未指定时使用听众浏览器时区（未知时为 Asia/Singapore）。返回日期、时间、时区、UTC 偏移和 ISO 时间，不访问数据库也不修改状态。',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: '可选 IANA 时区名称，例如 Asia/Singapore、Asia/Shanghai、Europe/London。默认听众浏览器时区。',
      },
    },
  },
  async execute(args = {}, context = {}) {
    const timeZone = String(args.timezone || context.timeZone || DEFAULT_TIME_ZONE).trim().slice(0, 100) || DEFAULT_TIME_ZONE;
    const now = context.now instanceof Date ? context.now : new Date(context.now ?? Date.now());
    try {
      const formatted = dateTimeParts(now, timeZone);
      const data = { type: 'current_time', time_zone: timeZone, ...formatted, iso: now.toISOString() };
      const content = `${data.date} ${data.time}（${data.time_zone}，UTC${data.utc_offset}）`;
      return createToolResult({
        modelText: content,
        summary: `查询 ${data.time_zone} 当前时间`,
        eventData: { ...data, ok: true },
      });
    } catch {
      const error = { code: 'invalid_timezone', message: 'timezone must be a valid IANA time zone' };
      const content = `无法识别时区“${timeZone}”，请使用有效的 IANA 时区名称。`;
      return createToolResult({
        modelText: content,
        summary: '时区参数无效',
        eventData: { type: 'current_time', time_zone: timeZone, ok: false, error },
      });
    }
  },
};
