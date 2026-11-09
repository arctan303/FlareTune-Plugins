import { projectTimelineShift } from "./timelineShift.js";

export function parseLyricTime(value) {
  const match = /^(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?$/.exec(String(value || '').trim());
  if (!match || Number(match[2]) > 59) return null;
  const milliseconds = Number(match[1]) * 60000 + Number(match[2]) * 1000
    + Number(String(match[3] || '0').padEnd(3, '0'));
  return milliseconds <= 86400000 ? milliseconds / 1000 : null;
}

export function serializeLyricEditorRows(rows, shiftMs = 0) {
  const lines = rows.map((row) => {
    const time = row.time.trim()
      ? row.time === row.originalTime && Number.isFinite(row.originalTimeValue)
        ? row.originalTimeValue : parseLyricTime(row.time)
      : undefined;
    const preserveWords = row.words?.length && row.time === row.originalTime && row.text === row.originalText;
    const line = { ...(time === undefined ? {} : { time }), text: preserveWords ? row.text : row.text.trim(),
      tlyric: row.translation.trim() };
    if (preserveWords) {
      line.words = row.words;
      if (row.endTime !== undefined) line.endTime = row.endTime;
    }
    return line;
  });
  return projectTimelineShift(lines, shiftMs);
}

export function insertLyricRow(rows, afterKey, newKey) {
  const index = rows.findIndex((row) => row.key === afterKey);
  const row = {
    key: newKey, time: '', originalTime: '', text: '', originalText: '', translation: '',
  };
  const next = [...rows];
  next.splice(index < 0 ? next.length : index + 1, 0, row);
  return next;
}

export function validateLyricRows(rows) {
  const errors = {};
  const times = rows.map((row) => row.time.trim() ? parseLyricTime(row.time) : undefined);
  const hasTimedRows = times.some((time) => typeof time === 'number');
  const mark = (key, field, source, values) => {
    errors[key] ??= {};
    // Keep validation data independent of the language selected at validation time.
    errors[key][field] ??= { source, values };
  };

  rows.forEach((row, index) => {
    if (!row.text.trim()) mark(row.key, 'text', '请填写歌词');
    if (times[index] === null) mark(row.key, 'time', '时间格式应为 mm:ss.mmm');
    if (times[index] === undefined && (row.originalTime || (hasTimedRows && row.key.startsWith('new-')))) {
      mark(row.key, 'time', '请填写时间');
    }
  });

  let previousIndex = -1;
  rows.forEach((row, index) => {
    if (typeof times[index] !== 'number') return;
    if (previousIndex >= 0 && times[index] < times[previousIndex]) {
      mark(rows[previousIndex].key, 'time', '应不晚于下一行 {p0}', { p0: rows[index].time });
      mark(row.key, 'time', '应不早于上一行 {p0}', { p0: rows[previousIndex].time });
    }
    previousIndex = index;
  });
  return errors;
}
