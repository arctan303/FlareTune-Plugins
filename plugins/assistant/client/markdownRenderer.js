import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { resolveAssistantLink } from "./markdownLinks.js";
import { t } from "@flaretune/plugin-sdk/client/i18n";

const escapeAttribute = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');

const customRenderer = {
    link({ href, title, text }) {
        const resolved = resolveAssistantLink(href);
        if (resolved?.songId) {
            // 内部歌曲标记转换为用户点击后播放的内联胶囊。
            const cleanTitle = String(text || '').replace(/^[▶\s]+/, '').replace(/^《|》$/g, '').trim();
            const displayTitle = cleanTitle ? (cleanTitle.startsWith('《') ? cleanTitle : `《${cleanTitle}》`) : t('播放歌曲');
            const tooltip = escapeAttribute(t('在 FlareTune 播放{title}', { title: displayTitle }));
            return `<span class="xiaoa-inline-song" data-song-id="${resolved.songId}" role="button" tabindex="0" title="${tooltip}">${displayTitle}</span>`;
        }
        if (typeof href === 'string' && (href.startsWith('http://') || href.startsWith('https://'))) {
            const titleAttr = title ? ` title="${title}"` : '';
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="xiaoa-markdown-link"${titleAttr}>${text}</a>`;
        }
        return text;
    },
};

const markedInstance = new Marked({
    gfm: true,
    breaks: true,
    renderer: customRenderer,
});

function sanitizeHtml(html) {
    if (typeof window !== 'undefined') {
        const purify = typeof DOMPurify.sanitize === 'function' ? DOMPurify : DOMPurify(window);
        return purify.sanitize(html, {
            ALLOWED_TAGS: [
                'a', 'p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'pre',
                'ul', 'ol', 'li', 'blockquote', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'
            ],
            ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel', 'data-song-id', 'role', 'tabindex'],
            ALLOWED_URI_REGEXP: /^(?:(?:https?:)|#|\/(?!\/)|[^:]*$)/i,
            KEEP_CONTENT: true,
        });
    }
    return html;
}

/**
 * 安全渲染 Markdown 为带音乐站交互的 HTML
 */
export function renderMarkdownSafe(text) {
    if (!text) return '';
    const rawHtml = markedInstance.parse(text || '');
    return sanitizeHtml(rawHtml)
        .replaceAll('<table>', `<div class="assistant-table-scroll" role="region" aria-label="${escapeAttribute(t('表格，可左右滚动'))}" tabindex="0"><table>`)
        .replaceAll('</table>', '</table></div>');
}
