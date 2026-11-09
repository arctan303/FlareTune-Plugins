export function centeredLyricScrollTop({ scrollTop, containerTop, containerHeight, scrollHeight, lineTop, lineHeight }) {
  const lineOffset = scrollTop + lineTop - containerTop;
  const desired = lineOffset - (containerHeight - lineHeight) / 2;
  return Math.max(0, Math.min(Math.max(0, scrollHeight - containerHeight), desired));
}
