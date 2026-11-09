export function clipboardImageFiles(transfer) {
  const items = Array.from(transfer?.items || []);
  const images = items.filter(item => item.kind === 'file' && item.type?.startsWith('image/'))
    .map(item => item.getAsFile()).filter(Boolean);
  return images.length ? images : Array.from(transfer?.files || []).filter(file => file.type?.startsWith('image/'));
}

export function isFileTransfer(transfer) {
  return Array.from(transfer?.types || []).includes('Files') || Boolean(transfer?.files?.length);
}

export function pasteAttachmentImages(event, addFiles) {
  if (!addFiles) return false;
  const files = clipboardImageFiles(event.clipboardData);
  if (!files.length) return false;
  // Mixed text and images keep the browser's normal text insertion.
  if (!event.clipboardData.getData?.('text/plain')) event.preventDefault();
  addFiles(files);
  return true;
}

export function dropAttachmentFiles(event, addFiles) {
  if (!isFileTransfer(event.dataTransfer)) return false;
  // Never let a file drop navigate away, including while attachments are disabled.
  event.preventDefault();
  event.stopPropagation();
  const files = Array.from(event.dataTransfer.files || []);
  if (files.length) addFiles?.(files);
  return true;
}
