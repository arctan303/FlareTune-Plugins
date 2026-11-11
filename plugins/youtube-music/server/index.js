export { createYouTubeHandler as createHandler } from './admin.js';
export { createLyricSource } from './lyric-source.js';
export { youtubeLyricDependencies as createLyricDependencies, handleYouTubeMusicRoute, handleYouTubeMedia, youtubeAccountMusicDependencies } from './integration.js';
// Keep actor creation asynchronous so the host platform shell loads only the
// runtime selected in this build. Actor requests retain the package's gates.
export async function createRuntime(ctx, env) {
  const { YouTubeRuntime } = await import('./runtime-actor.js');
  return new YouTubeRuntime(ctx, env);
}
