import { InstanceAdminError } from '@flaretune/plugin-sdk/server/admin-common';
import { readDefinedSettings, updateDefinedSetting } from '@flaretune/plugin-sdk/server/settings';
import { YOUTUBE_SETTINGS_KEY, DEFAULT_YOUTUBE_SETTINGS, normalizeYouTubeSettings } from '../shared/preferences.js';
const definition = Object.freeze({ defaultValue: DEFAULT_YOUTUBE_SETTINGS,
  validate(value) { try { return normalizeYouTubeSettings(value); } catch { throw new InstanceAdminError('invalid_setting', 400); } } });
export async function loadYouTubeSettings(db) {
  const row = db?.prepare ? await db.prepare('SELECT value_json FROM instance_settings WHERE key=?').bind(YOUTUBE_SETTINGS_KEY).first() : null;
  if (!row) return { ...DEFAULT_YOUTUBE_SETTINGS };
  try { return normalizeYouTubeSettings(JSON.parse(row.value_json)); }
  catch { throw new InstanceAdminError('setting_corrupt', 503); }
}
export async function readYouTubeSettings(db, actor) {
  return (await readDefinedSettings(db, actor, { [YOUTUBE_SETTINGS_KEY]: definition }))[YOUTUBE_SETTINGS_KEY];
}
export const saveYouTubeSettings = (db, actor, value, revision) =>
  updateDefinedSetting(db, actor, YOUTUBE_SETTINGS_KEY, value, revision, definition);
