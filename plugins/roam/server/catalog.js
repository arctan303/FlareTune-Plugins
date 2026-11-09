import { buildSongLanguageFilter } from "@flaretune/plugin-sdk/server/song-language";
import { runtimeSongColumns } from "@flaretune/plugin-sdk/server/song-projection";
import { createRoamSampler } from "./sampler.js";

const sampler = createRoamSampler();

// Same-workspace compatibility adapter. The catalog belongs to the host; the
// plugin only receives playable song DTOs and never writes catalog/user data.
export function createRoamCatalog(db, { executionContext } = {}) {
  return Object.freeze({
    supportsLanguage(language) { return Boolean(buildSongLanguageFilter(language === 'all' ? null : language)); },
    sampleRecent(options) { return sampler.sample(db, { ...options, executionContext }); },
    async listPlayable(language) {
      const filter = buildSongLanguageFilter(language === 'all' ? null : language);
      const rows = await db.prepare(`SELECT ${runtimeSongColumns('s')} FROM Songs s
        WHERE s.audio_url IS NOT NULL AND TRIM(s.audio_url) <> '' ${filter.sql ? `AND ${filter.sql}` : ''}
        ORDER BY RANDOM()`).bind(...filter.bindings).all();
      return rows.results || [];
    },
  });
}
