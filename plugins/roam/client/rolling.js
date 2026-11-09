import { recentRoamIds, splitRoamQueue } from "./algorithms.js";
export { recentRoamIds, splitRoamQueue } from "./algorithms.js";

export function appendRollingRoam(playlist, currentSong, randomRoam, songs) {
  const { played, queued } = splitRoamQueue(playlist, currentSong, randomRoam.waitingAtQueueEnd);
  const occupied = new Set(queued.map(song => String(song.id)));
  const additions = songs.filter(song => {
    const id = String(song.id);
    if (occupied.has(id)) return false;
    occupied.add(id);
    return true;
  });
  const renewed = new Set(additions.map(song => String(song.id)));
  return {
    additions,
    // The player addresses entries by song ID. Relocate an old occurrence instead
    // of introducing duplicates that would make next/previous pick the wrong one.
    playlist: [...played.filter(song => !renewed.has(String(song.id))), ...queued, ...additions],
    recentSongIds: recentRoamIds([...(randomRoam.recentSongIds || []), ...played.map(song => song.id)]),
  };
}
