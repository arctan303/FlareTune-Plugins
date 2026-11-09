// Keep preview state on the page; resolve only from the current account/thread.
export function resolveAssistantImagePreview(messages, selection, accountId) {
    if (!accountId || selection?.accountId !== accountId) return null;
    return messages.find(message => message.id === selection.messageId)
        ?.images?.find(image => image.id === selection.imageId) || null;
}
