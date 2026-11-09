import React from 'react';
import { renderMarkdownSafe } from "./markdownRenderer.js";
import { insertInlineCursorHtml } from '@flaretune/plugin-sdk/client/typewriter';
import { activateInlineAssistantSong } from "./inlinePlayback.js";
import { useLocale } from "@flaretune/plugin-sdk/client/i18n";

export { renderMarkdownSafe };

/**
 * 完整 GitHub Flavored Markdown 渲染组件
 */
export function AssistantMarkdown({ host, content, showCursor = false }) {
    const locale = useLocale();

    const html = React.useMemo(() => {
        const rendered = renderMarkdownSafe(content || '');
        return showCursor ? insertInlineCursorHtml(rendered) : rendered;
    }, [content, showCursor, locale]);

    if (!content && !showCursor) return null;

    const handleClick = (e) => activateInlineAssistantSong(e, { host });
    const handleKeyDown = (e) => activateInlineAssistantSong(e, { host, keyboard: true });

    return (
        <div
            className="prose-paper whitespace-normal break-words"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

export const XiaoaMarkdown = AssistantMarkdown;
export const MarkdownContent = AssistantMarkdown;
export default AssistantMarkdown;
