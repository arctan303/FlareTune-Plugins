export function resolveAssistantMessageTime(createdAt, { locale = 'en', now = Date.now() } = {}) {
    const timestamp = Number(createdAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) return null;

    const today = new Date(now);
    // Compare complete calendar dates in the browser's time zone, including the year.
    const sameYear = date.getFullYear() === today.getFullYear();
    const sameDate = sameYear && date.getMonth() === today.getMonth()
        && date.getDate() === today.getDate();
    const options = {
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        ...(!sameDate ? { month: '2-digit', day: '2-digit' } : {}),
        ...(!sameYear ? { year: 'numeric' } : {}),
    };
    return {
        label: new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale, options).format(date),
        dateTime: date.toISOString(),
    };
}
