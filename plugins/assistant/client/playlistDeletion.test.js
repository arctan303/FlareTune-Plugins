import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmAssistantPlaylistDeletion, rebindAssistantPlaylistConfirmations } from './playlistDeletion.js';

const playlist = { playlistId: 'playlist-1', name: '圣诞歌单', expectedRevision: 3 };

test('confirmed assistant deletion sends the exact playlist ID and revision', async () => {
  const deleted = [];
  const outcome = await confirmAssistantPlaylistDeletion(playlist, {
    isCurrent: () => true,
    deletePlaylist: async (...args) => deleted.push(args),
  });
  assert.equal(outcome, 'deleted');
  assert.deepEqual(deleted, [['playlist-1', 3]]);
});

test('account change never deletes the playlist', async () => {
  let deletes = 0;
  const deletePlaylist = async () => { deletes += 1; };
  const switched = await confirmAssistantPlaylistDeletion(playlist, {
    isCurrent: () => false, deletePlaylist,
  });
  assert.equal(switched, 'account_changed');
  assert.equal(deletes, 0);
});

test('malformed confirmation payload is rejected before deleting', async () => {
  await assert.rejects(confirmAssistantPlaylistDeletion({ ...playlist, expectedRevision: undefined }, {
    isCurrent: () => true,
    deletePlaylist: async () => { throw new Error('should not delete'); },
  }), /请求无效/);
});

test('confirmation stays attached when the saved assistant message replaces its streaming ID', () => {
  const items = { call1: { messageId: 'assistant-temporary', status: 'pending', confirmation: playlist },
    call2: { messageId: 'older-message', status: 'kept', confirmation: playlist } };
  const rebound = rebindAssistantPlaylistConfirmations(items, 'assistant-temporary', 'saved-message');
  assert.equal(rebound.call1.messageId, 'saved-message');
  assert.equal(rebound.call1.status, 'pending');
  assert.equal(rebound.call2.messageId, 'older-message');
});
