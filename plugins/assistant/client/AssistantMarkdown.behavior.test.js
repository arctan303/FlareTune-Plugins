import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import React from 'react';
import { renderMarkdownSafe } from './markdownRenderer.js';
import { insertInlineCursorHtml } from '@flaretune/plugin-sdk/client/typewriter';
import { getLocale, setUiLanguage } from '@flaretune/plugin-sdk/client/i18n';

// Exercise the actual component with a normal dependency-based memo cache.
// Playback is a seam here; these tests never dispatch a browser player action.
function component() {
    let memoDependencies, memoValue;
    const dependencies = {
        react: { ...React, useMemo(fn, values) {
            if (!memoDependencies || values.some((value, index) => !Object.is(value, memoDependencies[index]))) {
                memoValue = fn(); memoDependencies = values;
            }
            return memoValue;
        } },
        './markdownRenderer.js': { renderMarkdownSafe },
        '@flaretune/plugin-sdk/client/typewriter': { insertInlineCursorHtml },
        './inlinePlayback.js': { activateInlineAssistantSong() {} },
        '@flaretune/plugin-sdk/client/i18n': { useLocale: getLocale },
    };
    const compiled = transformSync(readFileSync(new URL('./AssistantMarkdown.jsx', import.meta.url), 'utf8'), {
        loader: 'jsx', format: 'cjs', jsx: 'transform',
    }).code;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(name => {
        assert.ok(Object.hasOwn(dependencies, name), `Unhandled component import: ${name}`);
        return dependencies[name];
    }, module, module.exports);
    return module.exports.AssistantMarkdown;
}

test('changing UI language refreshes memoized controls with unchanged assistant prose and cursor', async () => {
    const AssistantMarkdown = component();
    const props = { content: '保留原文 [《晴天》](song:song_1)', showCursor: true };
    await setUiLanguage('en');
    const english = AssistantMarkdown(props).props.dangerouslySetInnerHTML.__html;
    assert.ok(english.includes('title="Play 《晴天》 in FlareTune"'));
    await setUiLanguage('ja');
    const japanese = AssistantMarkdown(props).props.dangerouslySetInnerHTML.__html;
    assert.ok(japanese.includes('title="FlareTune で《晴天》を再生"'));
    assert.notEqual(japanese, english);
    assert.ok(japanese.includes('保留原文'));
    assert.ok(japanese.includes('ai-typing-cursor'));
    assert.equal(AssistantMarkdown({ content: '', showCursor: false }), null);
    await setUiLanguage('en');
});
