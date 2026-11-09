import { InstanceAdminError } from "@flaretune/plugin-sdk/server/admin-common";
import { updateDefinedSetting } from "@flaretune/plugin-sdk/server/settings";
const definition = { defaultValue: '', validate(value) {
  if (value === '') return value;
  if (typeof value === 'string' && value.length <= 2048) {
    try { const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return value;
    } catch {}
  }
  throw new InstanceAdminError('invalid_setting', 400);
} };
export const updateAdminSetting = (db, actor, key, value, revision, now) =>
  updateDefinedSetting(db, actor, key, value, revision, key === 'ai.compatible_api_url' ? definition : undefined, now);
