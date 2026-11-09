import { getLocale, t, useLocale } from "@flaretune/plugin-sdk/client/i18n";
import React from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { MarkdownContent } from "./AssistantMarkdown.jsx";
import { PrivateCoverImage } from '@flaretune/plugin-sdk';
import { getAssistantProcessStatus, getAssistantProcessTimeline, getAssistantProcessOverview } from "../shared/assistantProcessTrace.js";
import { resolveAssistantMessageTime } from "./messageTime.js";
import { formatAssistantToolEntry } from "./toolText.js";

const resolveMessageTime = (createdAt) => resolveAssistantMessageTime(createdAt, { locale: getLocale() });

export default function AiReviewConversation({
    host,
    containerRef,
    expandedDetails,
    messages,
    playlistConfirmations = {},
    onPlaylistConfirmationDecision,
    onPreviewImage,
    onScroll,
    onUserScrollIntent,
    onToggleDetails,
    phase,
    processClock,
    welcomeReady,
    welcomeText,
}) {
    useLocale();
    const showGreeting = phase === 'ready' && welcomeReady && messages.length === 0;

    return (
        <div
            ref={containerRef}
            onScroll={onScroll}
            onWheel={event => { if (event.deltaY < 0) onUserScrollIntent?.(); }}
            onTouchStart={onUserScrollIntent}
            onKeyDown={event => { if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) onUserScrollIntent?.(); }}
            onPointerDown={event => { if (event.target === event.currentTarget) onUserScrollIntent?.(); }}
            className={`assistant-conversation flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 md:px-8 py-6 flex flex-col bg-transparent relative custom-scrollbar ${showGreeting ? 'assistant-conversation--welcome' : ''}`}
        >
            {showGreeting ? (
                <div className="assistant-greeting" aria-label={welcomeText}>
                    <span>{welcomeText}</span>
                </div>
            ) : messages.length > 0 ? (
            <div className="w-full min-w-0 max-w-3xl mx-auto space-y-7 flex flex-col">
            {messages.map((message) => {
                const displayContent = (message.isError ? message.partialContent : message.content) || '';
                const hasContent = Boolean(displayContent && displayContent.trim());
                const isGenerating = Boolean(message.isGenerating);
                const confirmationChoices = Object.values(playlistConfirmations)
                    .filter((item) => item.messageId === message.id);
                if (!hasContent && !isGenerating && !message.isError && confirmationChoices.length === 0
                    && message.role === 'assistant') return null;
                const processTimeline = getAssistantProcessTimeline(message);
                const processStatus = getAssistantProcessStatus(message, processClock);
                const processOverview = getAssistantProcessOverview(message, processTimeline);
                const isDetailsExpanded = Boolean(expandedDetails[message.id]);
                const messageTime = resolveMessageTime(message.createdAt);

                return (
                    <div
                        key={message.id}
                        className={`flex min-w-0 items-start w-full ${message.role === 'user' ? 'justify-end' : ''}`}
                    >
                        {message.role === 'user' ? (
                            <div className="max-w-[85%] sm:max-w-[70%] min-w-0 flex flex-col items-end gap-1">
                                {message.images?.length > 0 && <div className="assistant-message-images">
                                    {message.images.map((image, index) => <button key={image.id} type="button"
                                        className="assistant-message-images__thumbnail" aria-label={t('查看第 {position} 张图片', { position: index + 1 })}
                                        onClick={() => onPreviewImage?.(message.id, image.id)}>
                                        <PrivateCoverImage src={image.url} alt={t('聊天图片')} />
                                    </button>)}
                                </div>}
                                {hasContent && <div className="assistant-user-message__text px-4 py-2.5 rounded-2xl text-sm sm:text-[14.5px] leading-relaxed bg-[var(--ink)] text-[var(--surface-raised)] rounded-tr-xs whitespace-pre-wrap break-words shadow-sm">
                                    {message.content}
                                </div>}
                                {messageTime && (
                                    <time
                                        dateTime={messageTime.dateTime}
                                        className="px-1 text-[10px] leading-none text-[var(--muted)] tabular-nums select-none"
                                    >
                                        {messageTime.label}
                                    </time>
                                )}
                            </div>
                        ) : (
                            <div className="assistant-reply w-full min-w-0 text-[var(--ink)] flex flex-col gap-3">
                                <div className={`assistant-process min-w-0 text-xs text-[var(--muted)] ${isGenerating ? '' : 'assistant-process--settled'}`}>
                                        <button
                                            type="button"
                                            onClick={() => onToggleDetails(message.id)}
                                            aria-expanded={isDetailsExpanded}
                                            className="assistant-process__toggle"
                                        >
                                            <span role="status" aria-live="polite" className={isGenerating
                                                ? processStatus.stage === 'thinking' ? 'assistant-process__thinking' : 'assistant-process__active'
                                                : ''}>
                                                {t(processStatus.label)}
                                                {isGenerating && processStatus.stage === 'processing'
                                                    && <span aria-hidden="true"> {t('（{seconds} 秒）', { seconds: processStatus.seconds })}</span>}
                                            </span>
                                            {isGenerating && (processOverview.toolName || processOverview.detail)
                                                && <span className="assistant-process__overview">
                                                {processOverview.toolName && <Wrench size={13} aria-hidden="true" />}
                                                <span className="assistant-process__tool-name" title={processOverview.toolName
                                                    ? t('调用工具：{name}', { name: t(processOverview.toolName) }) : t(processOverview.detail)}>
                                                    {processOverview.toolName
                                                        ? t('调用工具：{name}', { name: t(processOverview.toolName) }) : t(processOverview.detail)}
                                                </span>
                                            </span>}
                                            {isDetailsExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                        </button>
                                        {isDetailsExpanded && (
                                            <div>
                                                {processTimeline.length > 1 && processTimeline.some((entry) => entry.orderUnknown) && (
                                                    <p className="assistant-process__legacy-note">{t("旧记录未保存过程顺序")}</p>
                                                )}
                                                <div className="assistant-process__timeline custom-scrollbar" role="list">
                                                    {processTimeline.length > 0 ? processTimeline.map((entry, index) => (
                                                        <div key={`${entry.type}-${entry.id || index}-${index}`} role="listitem"
                                                            className={entry.type === 'tool' ? 'assistant-process__tool' : 'assistant-process__thought'}>
                                                            {entry.type === 'tool' ? (
                                                                <>
                                                                    <Wrench size={15} aria-hidden="true" />
                                                                    <span className="min-w-0 break-words">
                                                                        {`${entry.ok === false ? t("未完成：") : ''}${formatAssistantToolEntry(entry)}`}
                                                                    </span>
                                                                </>
                                                            ) : entry.text}
                                                        </div>
                                                    )) : <div role="listitem">{isGenerating ? t("等待模型响应…") : t("本轮没有可展示的过程记录")}</div>}
                                                </div>
                                            </div>
                                        )}
                                </div>

                                {hasContent && (
                                    <div className="min-w-0">
                                        <MarkdownContent host={host} content={displayContent} showCursor={isGenerating} />
                                    </div>
                                )}

                                {message.isError && (
                                    <div className="text-xs text-[var(--danger)] font-medium">
                                        {t(message.content)}
                                        {isGenerating && <span className="ai-typing-cursor" aria-hidden="true" />}
                                    </div>
                                )}

                                {confirmationChoices.map((choice) => (
                                    <div key={choice.id} className="assistant-playlist-confirmation"
                                        role="group" aria-label={t("删除歌单《{p0}》", { p0: (choice.confirmation?.name || '') })}>
                                        <p className="assistant-playlist-confirmation__question">{t('是否删除歌单《{name}》？', { name: choice.confirmation?.name || '' })}
                                        </p>
                                        <p className="assistant-playlist-confirmation__hint">{t("删除后无法恢复。")}</p>
                                        {choice.status === 'pending' ? (
                                            <div className="assistant-playlist-confirmation__actions">
                                                <button type="button" className="assistant-playlist-confirmation__delete"
                                                    onClick={() => onPlaylistConfirmationDecision(choice.id, 'delete')}>{t("删除歌单")}</button>
                                                <button type="button" className="assistant-playlist-confirmation__keep"
                                                    onClick={() => onPlaylistConfirmationDecision(choice.id, 'keep')}>{t("保留歌单")}</button>
                                            </div>
                                        ) : (
                                            <p className="assistant-playlist-confirmation__result" role="status">
                                                {choice.status === 'deleting' ? t("正在删除…")
                                                    : choice.status === 'deleted' ? t("歌单已删除")
                                                    : choice.status === 'kept' ? t("已保留歌单")
                                                    : choice.status === 'account_changed' ? t("账号已切换，未删除歌单")
                                                    : t(choice.error || '删除失败，歌单仍在。')}
                                            </p>
                                        )}
                                    </div>
                                ))}

                                {messageTime && (
                                    <time
                                        dateTime={messageTime.dateTime}
                                        className="self-start text-[10px] leading-none text-[var(--muted)] tabular-nums select-none"
                                    >
                                        {messageTime.label}
                                    </time>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}
            </div>
            ) : null}
        </div>
    );
}
