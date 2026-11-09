// The music source declares its own identity; the host owns cancellation and
// pausing. No player, account or plugin store crosses the SDK boundary.
export function startYouTubeRuntime(host) {
  return host.musicSources.register({ matches: song => song?.source === 'youtube'
    || String(song?.id || '').startsWith('yt:') });
}
