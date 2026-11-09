const MAX_ID_LENGTH = 80;
const MAX_SEEN_IDS = 5000;
const MAX_BATCH = 50;

export class RoamInputError extends Error {
  constructor(message = 'Invalid roam parameters') {
    super(message); this.name = 'RoamInputError'; this.code = 'invalid_input';
  }
}

const invalid = () => { throw new RoamInputError(); };
function batch(value, fallback = 10) {
  if (value === undefined || value === null || value === '') return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/u.test(String(value))) invalid();
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) invalid();
  return limit;
}
function ids(values) {
  if (!Array.isArray(values) || values.length > MAX_SEEN_IDS) invalid();
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string') invalid();
    const id = value.trim();
    if (!id || id.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(id)) invalid();
    seen.add(id);
  }
  return [...seen];
}

// Domain policy consumes a catalog capability rather than a host database.
export async function sampleRoam(body, catalog) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
  const language = body.language ?? 'all';
  if (typeof language !== 'string' || !catalog.supportsLanguage(language)) invalid();
  if (body.strategy === 'recent') {
    const recent = ids(body.recentSongIds), queued = ids(body.queuedSongIds), limit = batch(body.limit);
    const result = await catalog.sampleRecent({ recent, queued, limit, language });
    return { songs: result.songs, strategy: 'recent', language, limit,
      totalPlayable: result.rangeSize, remainingPlayable: Math.max(0, result.eligible - result.songs.length),
      recentWindow: result.windowSize, relaxed: result.relaxed,
      exhausted: result.rangeSize === 0 || (result.songs.length === 0 && queued.length <= 1 && !result.stale) };
  }
  const seenIds = ids(body.seenSongIds), limit = batch(body.limit ?? body.batchSize);
  const playable = await catalog.listPlayable(language);
  const seen = new Set(seenIds);
  const unseen = playable.filter(song => !seen.has(String(song.id)));
  const songs = unseen.slice(0, limit), remainingPlayable = unseen.length - songs.length;
  return { songs, language, limit, totalPlayable: playable.length, seenPlayable: playable.length - unseen.length,
    remainingPlayable, exhausted: remainingPlayable === 0 };
}
