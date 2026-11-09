import { t } from '@flaretune/plugin-sdk/client/i18n';
import React from 'react';
import { ArrowUp, Brain, ImagePlus, Loader2, Play, Square } from 'lucide-react';
import { dropAttachmentFiles, isFileTransfer, pasteAttachmentImages } from './attachmentInput.js';

export function AiReviewComposer({
  authenticated,
  enableThinking,
  onToggleThinking,
  textareaRef,
  inputText,
  isLoading,
  phase,
  onInputChange,
  onKeyDown,
  onSubmit,
  onStop,
  canContinue = false,
  onHeightChange,
  attachments,
  hasAttachments = false,
  attachmentsBusy = false,
  onAttachImage,
  onImageFiles,
  attachmentLimitReached = false,
}) {
  const [draggingFiles, setDraggingFiles] = React.useState(false);
  const dragDepth = React.useRef(0);
  const canAddImages = Boolean(onImageFiles) && !isLoading && !attachmentsBusy && phase === 'ready';
  React.useEffect(() => { if (!canAddImages) { dragDepth.current = 0; setDraggingFiles(false); } }, [canAddImages]);
  const resizePageInput = React.useCallback(() => {
    if (!textareaRef?.current) return;
    const textarea = textareaRef.current;
    textarea.style.height = 'auto';
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 22;
    const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const oneLineHeight = Math.ceil(lineHeight + padding);
    const maxHeight = Math.ceil(lineHeight * 6 + padding);
    const contentHeight = textarea.scrollHeight;
    textarea.style.height = `${Math.min(Math.max(contentHeight, oneLineHeight), maxHeight)}px`;
    textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
    onHeightChange?.();
  }, [onHeightChange, textareaRef]);

  React.useLayoutEffect(() => {
    resizePageInput();
  }, [inputText, hasAttachments, attachmentsBusy, resizePageInput]);

  React.useEffect(() => {
    window.addEventListener('resize', resizePageInput);
    return () => window.removeEventListener('resize', resizePageInput);
  }, [resizePageInput]);

  if (!authenticated) return null;

  return (
      <div className="assistant-composer-wrap w-full max-w-3xl lg:max-w-4xl mx-auto shrink-0 z-10">
        <form onSubmit={onSubmit} className={`assistant-composer${draggingFiles ? ' is-dragging-files' : ''}`}
          onPaste={event => pasteAttachmentImages(event, canAddImages ? onImageFiles : null)}
          onDragEnter={event => { if (isFileTransfer(event.dataTransfer)) { event.preventDefault(); if (canAddImages) { dragDepth.current += 1; setDraggingFiles(true); } } }}
          onDragOver={event => { if (isFileTransfer(event.dataTransfer)) { event.preventDefault(); event.dataTransfer.dropEffect = canAddImages ? 'copy' : 'none'; } }}
          onDragLeave={event => { if (isFileTransfer(event.dataTransfer)) { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDraggingFiles(false); } }}
          onDrop={event => { dropAttachmentFiles(event, canAddImages ? onImageFiles : null); dragDepth.current = 0; setDraggingFiles(false); }}>
          {attachments}
          {draggingFiles && <p role="status" className="px-4 pt-2 text-xs text-[var(--accent)]">{t('松开即可添加图片')}</p>}
          <div className="assistant-composer__field">
            <textarea
              ref={textareaRef}
              rows={1}
              value={inputText}
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t("聊聊音乐…")}
              disabled={isLoading || phase !== 'ready'}
              className="assistant-composer__input"
            />
          </div>
          <div className="assistant-composer__toolbar">
            <div className="assistant-composer__options">
              <button type="button" className={`assistant-composer__thinking${enableThinking ? ' is-active' : ''}`}
                onClick={onToggleThinking} aria-pressed={Boolean(enableThinking)}>
                <Brain size={16} aria-hidden="true" /><span>{t("思考模式")}</span>
              </button>
            </div>
            <div className="flex shrink-0 items-center gap-2">
            {onAttachImage && <button type="button" onClick={onAttachImage} disabled={!canAddImages || attachmentLimitReached}
              title={t(attachmentsBusy ? '正在处理图片…' : '附加图片')} aria-label={t('附加图片')} className="assistant-composer__attach">
              {attachmentsBusy ? <Loader2 size={20} className="animate-spin" aria-hidden="true" /> : <ImagePlus size={20} aria-hidden="true" />}
            </button>}
            {isLoading ? (
              <button type="button" onClick={onStop} title={t("停止生成")} className="assistant-composer__action" aria-label={t("停止生成")}>
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" disabled={(!inputText.trim() && !hasAttachments && !canContinue) || attachmentsBusy || phase !== 'ready'} title={t(canContinue && !inputText.trim() && !hasAttachments ? '继续处理' : '发送')} className="assistant-composer__action" aria-label={t(canContinue && !inputText.trim() && !hasAttachments ? '继续处理' : '发送问题')}>
                {canContinue && !inputText.trim() && !hasAttachments ? <Play size={19} fill="currentColor" /> : <ArrowUp size={21} strokeWidth={2.6} />}
              </button>
            )}
            </div>
          </div>
        </form>
      </div>
  );
}
