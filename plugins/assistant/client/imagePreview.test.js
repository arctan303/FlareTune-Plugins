import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAssistantImagePreview } from './imagePreview.js';

const image = { id: 'image-1', url: '/api/account/images/image-1' };
const messages = [{ id: 'message-1', images: [image] }];
const selection = { accountId: 'alice', messageId: 'message-1', imageId: 'image-1' };

test('preview resolves the selected image from the current message', () => {
    assert.equal(resolveAssistantImagePreview(messages, selection, 'alice'), image);
    const updated = { ...image, url: '/api/account/images/replaced' };
    assert.equal(resolveAssistantImagePreview([{ ...messages[0], images: [updated] }], selection, 'alice'), updated);
});

test('preview closes on account change or logout even with stale visible messages', () => {
    assert.equal(resolveAssistantImagePreview(messages, selection, 'bob'), null);
    assert.equal(resolveAssistantImagePreview(messages, selection, null), null);
    assert.equal(resolveAssistantImagePreview(messages, null, 'alice'), null);
});

test('preview does not retain removed images, messages or another message image', () => {
    assert.equal(resolveAssistantImagePreview([], selection, 'alice'), null);
    assert.equal(resolveAssistantImagePreview([{ id: 'message-1', images: [] }], selection, 'alice'), null);
    assert.equal(resolveAssistantImagePreview([{ id: 'message-2', images: [image] }], selection, 'alice'), null);
});
