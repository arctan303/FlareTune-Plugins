import test from 'node:test';
import assert from 'node:assert/strict';
import { clipboardImageFiles, dropAttachmentFiles, isFileTransfer, pasteAttachmentImages } from './attachmentInput.js';

const png = { name: 'clipboard.png', type: 'image/png' };
const webp = { name: 'image.webp', type: 'image/webp' };
function event(transfer, text = '') {
  return { clipboardData: { ...transfer, getData: () => text }, dataTransfer: transfer,
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

test('clipboard image items are extracted once, ignoring text and null files', () => {
  const transfer = { items: [
    { kind: 'string', type: 'text/plain' },
    { kind: 'file', type: 'image/png', getAsFile: () => png },
    { kind: 'file', type: 'image/png', getAsFile: () => null },
  ], files: [png] };
  assert.deepEqual(clipboardImageFiles(transfer), [png]);
  assert.deepEqual(clipboardImageFiles({ files: [png, { type: 'text/plain' }, webp] }), [png, webp]);
});

test('image paste uses the same upload callback while ordinary and mixed text keep native insertion', () => {
  const calls = [];
  const image = event({ files: [png] });
  assert.equal(pasteAttachmentImages(image, files => calls.push(files)), true);
  assert.equal(image.prevented, true);
  const mixed = event({ files: [png] }, 'caption');
  pasteAttachmentImages(mixed, files => calls.push(files));
  assert.equal(mixed.prevented, false);
  const plain = event({ files: [] }, 'music');
  assert.equal(pasteAttachmentImages(plain, files => calls.push(files)), false);
  assert.equal(plain.prevented, false);
  assert.deepEqual(calls, [[png], [png]]);
});

test('disabled image paste does not upload or intercept text', () => {
  const image = event({ files: [png] });
  assert.equal(pasteAttachmentImages(image, null), false);
  assert.equal(image.prevented, false);
});

test('file drops prevent navigation and share validation/upload, including invalid file types', () => {
  const files = [png, { name: 'not-an-image.txt', type: 'text/plain' }];
  const drop = event({ types: ['Files'], files });
  let received;
  assert.equal(dropAttachmentFiles(drop, value => { received = value; }), true);
  assert.deepEqual(received, files);
  assert.equal(drop.prevented, true);
  assert.equal(drop.stopped, true);
  const disabled = event({ types: ['Files'], files: [png] });
  dropAttachmentFiles(disabled, null);
  assert.equal(disabled.prevented, true);
});

test('text/link drags remain native and file drag types work before file bytes become available', () => {
  const text = event({ types: ['text/plain', 'text/uri-list'], files: [] });
  assert.equal(dropAttachmentFiles(text, () => assert.fail()), false);
  assert.equal(text.prevented, false);
  assert.equal(isFileTransfer({ types: ['Files'], files: [] }), true);
  assert.equal(isFileTransfer({ files: [png] }), true);
});
