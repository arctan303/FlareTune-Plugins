export async function reserveDailyQuota(db, dateKey, limit, now) {
  if (limit !== null && limit !== undefined && limit <= 0) return false;
  const limited = limit !== null && limit !== undefined;
  const result = await db.prepare(`
    INSERT INTO AI_Daily_Usage (usage_date, action, generation_count, updated_at)
    VALUES (?, 'lyrics_translation', 1, ?)
    ON CONFLICT(usage_date, action) DO UPDATE SET
      generation_count = AI_Daily_Usage.generation_count + 1,
      updated_at = excluded.updated_at
    ${limited ? 'WHERE AI_Daily_Usage.generation_count < ?' : ''}
    RETURNING generation_count
  `).bind(dateKey, now, ...(limited ? [limit] : [])).run();
  return result?.results?.length === 1;
}
