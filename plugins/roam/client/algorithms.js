export const RANDOM_ROAM_PREFETCH_THRESHOLD = 2;
export const RANDOM_ROAM_SEEN_IDS_LIMIT = 5000;

export const normalizeRoamLanguage = value => {
    if (value === 'all' || typeof value !== 'string') return 'all';
    const selected = new Set(value.split(',').map(key => key.trim()));
    const keys = ['zh', 'en', 'ja', 'ko', 'instrumental', 'other'].filter(key => selected.has(key));
    return keys.length && keys.length < 6 ? keys.join(',') : 'all';
};

export const createInactiveRandomRoam = () => ({
    enabled: false,
    language: 'all',
    batchSize: 10,
    manualNonce: 0,
    seenSongIds: [],
    recentSongIds: [],
    totalPlayable: null,
    remainingPlayable: null,
    exhausted: false,
    status: 'idle',
    error: null,
    retryNonce: 0,
    waitingAtQueueEnd: false,
    resumeWhenAppended: false,
});

export const normalizeRandomRoamSongIds = (values) => {
    if (!Array.isArray(values)) return [];
    const ids = [];
    const seen = new Set();
    for (const value of values.slice(0, RANDOM_ROAM_SEEN_IDS_LIMIT)) {
        const id = typeof value === 'string' || typeof value === 'number'
            ? String(value).trim()
            : '';
        if (!id || id.length > 80 || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
};

export const normalizeRandomRoamState = (value) => {
    const rawBatchSize = value?.batchSize;
    const batchSize = Number.isInteger(rawBatchSize) && rawBatchSize >= 1
        ? Math.min(rawBatchSize, 50)
        : 10;
    const manualNonce = Number.isInteger(value?.manualNonce) ? value.manualNonce : 0;

    if (!value || value.enabled !== true) {
        const inactive = createInactiveRandomRoam();
        if (typeof value?.language === 'string' && value.language.trim()) {
            inactive.language = value.language.trim();
        }
        inactive.batchSize = batchSize;
        inactive.manualNonce = manualNonce;
        return inactive;
    }
    const totalPlayable = Number.isInteger(value.totalPlayable) && value.totalPlayable >= 0
        ? value.totalPlayable
        : null;
    const status = ['idle', 'loading', 'error', 'exhausted'].includes(value.status)
        ? value.status
        : 'idle';
    const language = typeof value.language === 'string' && value.language.trim()
        ? value.language.trim()
        : 'all';
    return {
        enabled: status !== 'exhausted',
        language,
        batchSize,
        manualNonce,
        seenSongIds: normalizeRandomRoamSongIds(value.seenSongIds),
        recentSongIds: normalizeRandomRoamSongIds(value.recentSongIds),
        totalPlayable,
        remainingPlayable: Number.isInteger(value.remainingPlayable) && value.remainingPlayable >= 0
            ? value.remainingPlayable
            : null,
        exhausted: Boolean(value.exhausted),
        // 页面恢复后允许重新发起上次未完成的请求，不能永久停留在 loading。
        status: status === 'loading' ? 'idle' : status,
        error: status === 'error' && typeof value.error === 'string' ? value.error : null,
        retryNonce: Number.isInteger(value.retryNonce) ? value.retryNonce : 0,
        waitingAtQueueEnd: Boolean(value.waitingAtQueueEnd),
        // 只允许当前页面运行期无缝衔接；刷新恢复后必须保持暂停。
        resumeWhenAppended: false,
    };
};

export const getRandomRoamRemainingAfterCurrent = (playlist, currentSong) => {
    if (!Array.isArray(playlist) || playlist.length === 0) return 0;
    const currentIndex = playlist.findIndex((song) => String(song?.id) === String(currentSong?.id));
    return currentIndex >= 0 ? playlist.length - currentIndex - 1 : playlist.length;
};

export const shouldPrefetchRandomRoam = ({ randomRoam, playlist, currentSong, lastHandledManualNonce = 0 }) => {
    if (!randomRoam || randomRoam.status === 'loading' || randomRoam.status === 'error') return false;
    if (randomRoam.exhausted) return false;
    const manualNonce = Number.isInteger(randomRoam.manualNonce) ? randomRoam.manualNonce : 0;
    if (manualNonce > lastHandledManualNonce) return true;
    if (!randomRoam.enabled) return false;
    if (randomRoam.waitingAtQueueEnd) return true;
    if (randomRoam.saturatedAtSongId != null
        && String(randomRoam.saturatedAtSongId) === String(currentSong?.id)
        && randomRoam.saturatedQueueKey === splitRoamQueue(playlist, currentSong).queued.map(song => String(song.id)).join(',')) return false;
    if (!Array.isArray(playlist) || playlist.length === 0 || !currentSong) return false;
    return getRandomRoamRemainingAfterCurrent(playlist, currentSong) <= RANDOM_ROAM_PREFETCH_THRESHOLD;
};

export const normalizeRandomRoamResponse = (payload) => {
    const data = payload?.data;
    if (!data
        || !Array.isArray(data.songs)
        || !Number.isInteger(data.totalPlayable)
        || data.totalPlayable < 0
        || !Number.isInteger(data.remainingPlayable)
        || data.remainingPlayable < 0
        || typeof data.exhausted !== 'boolean') {
        throw new Error('random_roam_invalid_response');
    }
    return {
        songs: data.songs,
        totalPlayable: data.totalPlayable,
        remainingPlayable: data.remainingPlayable,
        exhausted: data.exhausted,
        ...(data.strategy === 'recent' ? { strategy: 'recent', recentWindow: data.recentWindow } : {}),
    };
};

export const buildRandomRoamPayload = (randomRoam, playlist = [], currentSong = null) => {
    const { played, queued } = splitRoamQueue(playlist, currentSong, randomRoam?.waitingAtQueueEnd);
    const payload = {
        strategy: 'recent',
        recentSongIds: recentRoamIds([...(randomRoam?.recentSongIds || []), ...played.map(song => song.id)]),
        queuedSongIds: normalizeRandomRoamSongIds(queued.map(song => song.id)),
        limit: (Number.isInteger(randomRoam?.batchSize) && randomRoam.batchSize >= 1)
            ? Math.min(randomRoam.batchSize, 50)
            : 10,
    };
    if (randomRoam?.language && randomRoam.language !== 'all') {
        payload.language = randomRoam.language;
    }
    return payload;
};

export function recentRoamIds(values) {
  // Preserve the newest occurrence and the newest 5000 IDs, not the first 5000.
  return normalizeRandomRoamSongIds([...values].reverse()).reverse();
}

export function splitRoamQueue(playlist, currentSong, waitingAtQueueEnd = false) {
  const index = playlist.findIndex(song => String(song.id) === String(currentSong?.id));
  const boundary = index >= 0 ? index : waitingAtQueueEnd ? playlist.length : 0;
  return { played: playlist.slice(0, boundary), queued: playlist.slice(boundary) };
}
