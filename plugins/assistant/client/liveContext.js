const clean = (value, max = 200) => typeof value === 'string'
    ? Array.from(value.trim()).slice(0, max).join('') : '';

export function captureAssistantLiveContext(state, recentPlayback = [], playerActionReceipts = []) {
    const currentSong = state?.currentSong;
    const queue = Array.isArray(state?.queue) ? state.queue : Array.isArray(state?.playlist) ? state.playlist : [];
    const currentIndex = currentSong ? queue.findIndex((song) => song?.id === currentSong.id) : -1;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Singapore';
    return {
        timeZone: zone,
        playback: {
            songId: clean(currentSong?.id, 120),
            title: clean(currentSong?.title),
            artist: clean(currentSong?.artist),
            album: clean(currentSong?.album),
            isPlaying: state?.isPlaying === true,
            isBuffering: state?.isBuffering === true,
            currentTime: Number.isFinite(state?.currentTime) ? state.currentTime : Number.isFinite(state?.progress) ? state.progress : null,
            duration: Number.isFinite(state?.duration) ? state.duration : null,
            playMode: clean(state?.playMode, 30),
            queueLength: queue.length,
            currentIndex: currentIndex >= 0 ? currentIndex + 1 : null,
            upcomingSongs: queue.slice(Math.max(0, currentIndex + 1), Math.max(0, currentIndex + 1) + 15)
                .map((song) => ({ id: clean(song?.id, 120), title: clean(song?.title), artist: clean(song?.artist) })),
        },
        recentPlayback: recentPlayback.slice(-3).map((song) => ({
            title: clean(song?.title), artist: clean(song?.artist),
        })),
        playerActionReceipts: playerActionReceipts.slice(-10).map((receipt) => ({
            id: clean(receipt?.id, 120), ok: receipt?.ok === true,
            outcome: clean(receipt?.outcome, 200),
        })),
    };
}
