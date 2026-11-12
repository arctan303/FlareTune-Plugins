import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as i18n from '@flaretune/plugin-sdk/client/i18n';
import { renderMarkdownSafe } from './markdownRenderer.js';
import { formatAssistantToolEntry } from './toolText.js';
import * as trace from '../shared/assistantProcessTrace.js';
import { resolveAssistantMessageTime } from './messageTime.js';

const empty = () => null;
const dependencies = {
    react: React,
    '@flaretune/plugin-sdk/client/i18n': i18n,
    'lucide-react': { ChevronDown: empty, ChevronRight: empty, Wrench: empty },
    './AssistantMarkdown.jsx': { MarkdownContent: ({ content }) => React.createElement('div', {
        dangerouslySetInnerHTML: { __html: renderMarkdownSafe(content) },
    }) },
    '@flaretune/plugin-sdk': { PrivateCoverImage: empty },
    '../shared/assistantProcessTrace.js': trace,
    './messageTime.js': { resolveAssistantMessageTime },
    './toolText.js': { formatAssistantToolEntry },
};
const compiled = transformSync(readFileSync(new URL('./AssistantConversation.jsx', import.meta.url), 'utf8'), {
    loader: 'jsx', format: 'cjs', jsx: 'transform',
}).code;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unhandled component import: ${name}`);
    return dependencies[name];
}, module, module.exports);
const Conversation = module.exports.default;

test('history loading preserves the blank visual surface and announces its real state',()=>{
    const html=renderToStaticMarkup(React.createElement(Conversation,{messages:[],phase:'skeleton',welcomeReady:true,welcomeText:'greeting'}));
    assert.match(html, /<span role="status" class="sr-only">[^<]+<\/span>/);
    assert.ok(!html.includes('assistant-greeting'));
    assert.ok(!html.includes('aria-hidden="true"'), 'loading does not add visible decorative message blocks');
});

test('history failure renders an enduring error with a local recovery action',()=>{
    const html=renderToStaticMarkup(React.createElement(Conversation,{messages:[],phase:'failed',loadError:'offline',onRetryLoad(){}}));
    assert.ok(html.includes('role="alert"'));assert.ok(html.includes('offline'));assert.match(html,/<button[^>]*type="button"/);
    assert.ok(!html.includes('assistant-greeting'),'failure is not a new empty conversation');
});

test('conversation localizes tool details while user text, assistant prose and thoughts retain their original language', async () => {
    const thought = '查询到 2 首歌曲';
    const messages = [
        { id: 'user', role: 'user', content: '登录' },
        { id: 'assistant', role: 'assistant', content: '原文保持：播放《登录》', thought,
            processEntries: [{ type: 'thought', start: 0, end: thought.length },
                { type: 'tool', summary: '查询到 2 首歌曲', ok: true },
                { type: 'tool', summary: '等待确认删除歌单《登录》', ok: true }] },
    ];
    const original = JSON.stringify(messages);
    for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
        await i18n.setUiLanguage(locale);
        const html = renderToStaticMarkup(React.createElement(Conversation, {
            messages, expandedDetails: { assistant: true }, processClock: 0,
            phase: 'ready', welcomeReady: false,
        }));
        assert.ok(html.includes('原文保持：播放《登录》'), locale);
        assert.ok(html.includes('>登录</div>'), locale);
        assert.ok(html.includes('查询到 2 首歌曲'), 'thought text stays verbatim');
        if (locale === 'en') {
            assert.ok(html.includes('Found 2 songs'));
            assert.ok(html.includes('Waiting for confirmation to delete playlist “登录”'));
        }
    }
    assert.equal(JSON.stringify(messages), original);
    await i18n.setUiLanguage('en');
});
