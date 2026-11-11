export const YOUTUBE_SETTINGS_KEY = 'plugin.youtube-music.settings';
export const YOUTUBE_TRANSLATION_LANGUAGES = Object.freeze(['en', 'zh-CN', 'zh-TW', 'ja', 'ko']);
export const DEFAULT_YOUTUBE_SETTINGS = Object.freeze({ metadataLanguage: 'en', region: 'US', lyricsEnabled: true, translationEnabled: true, translationLanguage: 'zh-CN' });
export function normalizeYouTubeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_YOUTUBE_SETTINGS, key))) throw new TypeError('YOUTUBE_INVALID_SETTINGS');
  const next = { ...DEFAULT_YOUTUBE_SETTINGS, ...value };
  if (typeof next.metadataLanguage !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(next.metadataLanguage)
    || typeof next.region !== 'string' || !/^[A-Z]{2}$/u.test(next.region)
    || typeof next.lyricsEnabled !== 'boolean' || typeof next.translationEnabled !== 'boolean'
    || !YOUTUBE_TRANSLATION_LANGUAGES.includes(next.translationLanguage)) throw new TypeError('YOUTUBE_INVALID_SETTINGS');
  return next;
}
