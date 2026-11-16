import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { item, searchResult, albumResult, artistResult } from './normalize.js';

const compiled = await build({ entryPoints: [fileURLToPath(new URL('./service.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'song-search-dependencies', setup(plugin) {
    const stubs = {
      './upstream.js': 'export const createSessionManager=()=>{throw Error("inject manager")};export const mediaFetch=()=>{throw Error("unused media")};',
      './player.js': 'export const createPlayer=()=>({});',
      'youtubei.js/cf-worker': 'export const YTNodes={Tab:class{}};',
      '@flaretune/plugin-sdk/server/lyric-document': 'export const createLyricDocument=x=>({...x,version:2,syncMode:x.format==="lrc"?"line":"none"});',
    };
    plugin.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'song-search-test' } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: 'song-search-test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  } }] });
const { createYouTubeService } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const row = (id, itemType, title = 'Same title') => ({ id, item_type: itemType, title, duration: { seconds: 212 } });
const audio = row('song0000001', 'song');
const explicitVideo = row('video000001', 'video');
const unknown = row('other000001', 'unknown', 'Official music video');
function page(rows, next) {
  return { contents: [{ title: 'Songs', contents: rows }], has_continuation: Boolean(next),
    getContinuation: async () => next };
}
function service(music, namespace) {
  return createYouTubeService({ services: { manager: { guest: async () => ({ music }) }, player: {}, cacheNamespace: namespace } });
}

test('normalization preserves explicit SDK song/video type without changing stable identity or guessing unknown titles', () => {
  assert.equal(item(audio).item_type, 'song');
  assert.equal(item(explicitVideo).item_type, 'video');
  assert.equal(item(explicitVideo).id, 'yt:video000001');
  assert.equal(item(explicitVideo).kind, 'song');
  assert.equal(item(unknown).item_type, 'unknown');
  assert.equal(item({ id: 'unset000001', title: 'Official music video' }).item_type, null);
});

test('song-only search excludes explicit video before pagination and retains unknown types across continuation', async () => {
  let continued = 0;
  const last = page([row('video000002', 'video'), unknown, row('song0000002', 'song')]);
  const first = page([explicitVideo, audio], last);
  first.getContinuation = async () => { continued++; return last; };
  const searches = [];
  const source = service({ search: async (_query, options) => { searches.push(options.type); return first; } }, 'song-type-filter-pagination');
  const firstResult = await source.search('type fixture', { filter: 'song', limit: 1 });
  assert.deepEqual(firstResult.songs.slice(0, 1).map(x => x.id), ['yt:song0000001']);
  assert.deepEqual(firstResult.sections[0].items.map(x => x.id), ['yt:song0000001']);
  const second = await source.search('type fixture', { filter: 'song', offset: 1, limit: 1 });
  assert.deepEqual(second.songs.slice(1, 2).map(x => x.id), ['yt:other000001']);
  assert.deepEqual(second.items.map(x => x.id), ['yt:song0000001', 'yt:other000001', 'yt:song0000002']);
  assert.equal(continued, 1);
  const third = await source.search('type fixture', { filter: 'song', offset: 2, limit: 1 });
  assert.deepEqual(third.songs.slice(2, 3).map(x => x.id), ['yt:song0000002']);
  assert.equal(third.hasMore, false);
  assert.deepEqual(searches, ['song']);
});

test('all/video search and album/artist/next retain explicit videos and original IDs', async () => {
  for (const filter of ['all', 'video']) {
    const source = service({ search: async () => page([explicitVideo, audio]) }, 'song-type-preserve-' + filter);
    const result = await source.search('preserve fixture', { filter });
    assert.deepEqual(result.items.map(x => x.id), ['yt:video000001', 'yt:song0000001']);
  }
  const unfiltered = searchResult(page([explicitVideo]));
  assert.equal(unfiltered.items[0].id, 'yt:video000001');
  assert.equal(albumResult({ contents: [explicitVideo] }, 'MPREb_album').songs[0].id, 'yt:video000001');
  assert.equal(artistResult({}, 'UC_artist', { contents: [explicitVideo] }).songs[0].id, 'yt:video000001');
  const next = await service({ getUpNext: async () => ({ contents: [explicitVideo] }), getLyrics: async () => null }, 'song-type-next').next('video000001');
  assert.equal(next.queue[0].id, 'yt:video000001');
  assert.equal(next.queue[0].item_type, 'video');
});
