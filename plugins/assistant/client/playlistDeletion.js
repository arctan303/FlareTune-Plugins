export async function confirmAssistantPlaylistDeletion(confirmation, { isCurrent, deletePlaylist }) {
  if (!confirmation || typeof confirmation.playlistId !== 'string' || !confirmation.playlistId
    || typeof confirmation.name !== 'string'
    || !Number.isInteger(confirmation.expectedRevision) || confirmation.expectedRevision < 0) {
    throw new Error('删除歌单请求无效，请重试。');
  }
  if (!isCurrent()) return 'account_changed';
  await deletePlaylist(confirmation.playlistId, confirmation.expectedRevision);
  return 'deleted';
}

export function rebindAssistantPlaylistConfirmations(items, temporaryMessageId, savedMessageId) {
  if (!savedMessageId || savedMessageId === temporaryMessageId) return items;
  return Object.fromEntries(Object.entries(items).map(([id, item]) => [id,
    item.messageId === temporaryMessageId ? { ...item, messageId: savedMessageId } : item]));
}
