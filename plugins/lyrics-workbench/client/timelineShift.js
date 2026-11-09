export const TIMELINE_SHIFT_LIMIT_MS = 5000;
export const TIMELINE_SHIFT_STEP_MS = 50;

export const clampTimelineShift = (value) => Math.min(TIMELINE_SHIFT_LIMIT_MS,
  Math.max(-TIMELINE_SHIFT_LIMIT_MS,
    Math.round((Number(value) || 0) / TIMELINE_SHIFT_STEP_MS) * TIMELINE_SHIFT_STEP_MS));

export const stepTimelineShift = (value, direction) =>
  clampTimelineShift(value + Math.sign(direction) * TIMELINE_SHIFT_STEP_MS);

export const timelineShiftAtY = (y, top, height) => {
  if (height <= 0) return 0;
  return clampTimelineShift(((y - top) / height * 2 - 1) * TIMELINE_SHIFT_LIMIT_MS);
};

const shiftTime = (time, deltaMs) => Number.isFinite(time)
  ? Math.max(0, Math.round((time + deltaMs / 1000) * 1000) / 1000) : time;

export const projectTimelineShift = (lines, deltaMs) => {
  if (!deltaMs) return lines;
  return lines.map((line) => {
    if (!Number.isFinite(line.time)) return line;
    const time = shiftTime(line.time, deltaMs);
    const shifted = { ...line, time };
    if (Number.isFinite(line.endTime)) shifted.endTime = Math.max(time, shiftTime(line.endTime, deltaMs));
    if (Array.isArray(line.words) && line.words.length > 0) {
      shifted.words = line.words.map((word) => {
        const startTime = Math.max(time, shiftTime(word.startTime, deltaMs));
        return { ...word, startTime, endTime: Math.max(startTime, shiftTime(word.endTime, deltaMs)) };
      });
      shifted.endTime = Math.max(shifted.endTime ?? time, ...shifted.words.map((word) => word.endTime));
    }
    return shifted;
  });
};
