import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAssistantLink, resolveXiaoaLink } from './markdownLinks.js';

test('Xiaoa Markdown links allow safe http/https URLs and deployment-local paths', () => {
  assert.equal(resolveXiaoaLink('javascript:alert(1)'), null);
  assert.equal(resolveXiaoaLink('httpjavascript:payload'), null);
  assert.equal(resolveXiaoaLink('//evil.example/path'), null);
  assert.deepEqual(resolveXiaoaLink('song:song_1'), {
    href: 'song:song_1', isBlogArticle: false, songId: 'song_1',
  });
  assert.equal(resolveXiaoaLink('song:<invalid>'), null);
  assert.equal(resolveXiaoaLink('data:text/html,payload'), null);
  assert.equal(resolveXiaoaLink('example.com/path')?.href, 'https://example.com/path');
});

test('Xiaoa Markdown classifies only internal song markers as playable songs', () => {
  assert.equal(resolveXiaoaLink('https://blog.example.test/post/12')?.isBlogArticle, false);
  assert.equal(resolveXiaoaLink('https://legacy-blog.example.test/post/12/')?.isBlogArticle, false);
  assert.equal(resolveXiaoaLink('https://blog.example.test.evil.example/post/12')?.isBlogArticle, false);
  assert.equal(resolveXiaoaLink('https://blog.example.test/about')?.isBlogArticle, false);
  assert.equal(resolveXiaoaLink('https://flaretune.example.test/?id=song_1')?.songId, '');
  assert.equal(resolveXiaoaLink('/song/some-id')?.songId, '');
  assert.equal(resolveXiaoaLink('https://evil.example/?id=song_1')?.songId, '');
});
