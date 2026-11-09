// Cache only shared catalog IDs/languages. Every sampled song is rechecked in D1.
import { buildSongLanguageFilter } from "@flaretune/plugin-sdk/server/song-language";
import { runtimeSongColumns } from "@flaretune/plugin-sdk/server/song-projection";
import { keepTaskAlive } from "@flaretune/plugin-sdk/server/request-task";

export function createRoamSampler({ ttlMs = 3_600_000, maxIds = 100_000 } = {}) {
  const snapshots = new WeakMap();
  async function directory(db, now, measure, executionContext) {
    const cached = snapshots.get(db);
    if (cached && now - cached.startedAt < ttlMs) return keepTaskAlive(cached.promise, executionContext);
    const entry = { startedAt: now };
    entry.promise = (async () => {
      const result = await db.prepare(`SELECT id, language FROM Songs
        WHERE audio_url IS NOT NULL AND TRIM(audio_url) <> ''`).bind().all();
      measure?.(result);
      // Large catalogs remain usable without retaining an oversized snapshot.
      if (result.results.length > maxIds && snapshots.get(db) === entry) snapshots.delete(db);
      return result.results;
    })();
    keepTaskAlive(entry.promise, executionContext);
    snapshots.set(db, entry);
    try { return await entry.promise; }
    catch (error) {
      if (snapshots.get(db) === entry) snapshots.delete(db);
      throw error;
    }
  }
  return {
    clear(db) { snapshots.delete(db); },
    async sample(db, { language = null, recent = [], queued = [], buffered = [], limit = 10,
      recentRatio = 0.2, now = Date.now(), random = Math.random, measure, executionContext } = {}) {
      const filter = buildSongLanguageFilter(language === 'all' ? null : language);
      if (!filter || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('INVALID_SAMPLE');
      if (recentRatio !== null && (!Number.isFinite(recentRatio) || recentRatio < 0 || recentRatio > 1)) throw new Error('INVALID_RATIO');
      const hard = new Set([...queued, ...buffered].map(String));
      // Recent IDs are ordered oldest to newest. Queue/buffer exclusions never relax.
      const history = [...new Set([...recent].reverse().map(String))].reverse();
      for (let attempt = 0; attempt < 2; attempt++) {
        const catalog = await directory(db, now, measure, executionContext);
        const range = catalog.filter((song) => !filter.bindings.length || filter.bindings.includes(song.language));
        const windowSize = recentRatio === null ? 200 : Math.min(5000, Math.floor(range.length * recentRatio));
        const candidates = range.filter((song) => !hard.has(String(song.id))).map((song) => String(song.id));
        const candidateSet = new Set(candidates);
        const rangeSet = new Set(range.map((song) => String(song.id)));
        const rangeHistory = windowSize ? history.filter((id) => rangeSet.has(id)).slice(-windowSize) : [];
        const applicableHistory = rangeHistory.filter((id) => candidateSet.has(id));
        const exclude = new Set(applicableHistory);
        const target = Math.min(limit, candidates.length);
        let relaxed = 0;
        while (candidates.length - exclude.size < target && relaxed < applicableHistory.length) {
          exclude.delete(applicableHistory[relaxed++]);
        }
        const eligible = candidates.filter((id) => !exclude.has(id));
        const size = Math.min(limit, eligible.length);
        for (let i = 0; i < size; i++) {
          const pick = i + Math.floor(random() * (eligible.length - i));
          [eligible[i], eligible[pick]] = [eligible[pick], eligible[i]];
        }
        const ids = eligible.slice(0, size);
        if (!ids.length) return { songs: [], relaxed, windowSize, rangeSize: range.length, eligible: eligible.length, stale: false };
        const result = await db.prepare(`SELECT ${runtimeSongColumns('s')} FROM Songs s
          WHERE s.id IN (${ids.map(() => '?').join(',')})
            AND s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> ''
            ${filter.sql ? `AND ${filter.sql}` : ''}`).bind(...ids, ...filter.bindings).all();
        measure?.(result);
        const found = new Map(result.results.map((song) => [String(song.id), song]));
        const songs = ids.map((id) => found.get(id)).filter(Boolean);
        if (songs.length === ids.length) return { songs, relaxed, windowSize, rangeSize: range.length, eligible: eligible.length, stale: false };
        // A deletion or language edit invalidates the directory. Rebuild at most
        // once so concurrent catalog edits cannot cause an unbounded retry loop.
        snapshots.delete(db);
        if (attempt === 1) return { songs, relaxed, windowSize, rangeSize: range.length, eligible: eligible.length, stale: true };
      }
    },
  };
}
