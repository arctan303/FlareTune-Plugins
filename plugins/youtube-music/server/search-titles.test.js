import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('./', import.meta.url));
const stubs = {
  '@flaretune/plugin-sdk/server/auth': 'export class AuthError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}',
  '@flaretune/plugin-sdk/server/plugin-common': 'export const requirePluginSession=async()=>{};',
  '@flaretune/plugin-sdk/server/music-catalog': 'export const handleLocalMusicReadRoute=()=>{throw Error("inject local")};',
  '@flaretune/plugin-sdk/server/album-catalog': 'export const handleLocalAlbumReadRoute=()=>{throw Error("inject local")};',
  '@flaretune/plugin-sdk/server/catalog-discovery': 'export const handleLocalMusicDiscoveryRoute=()=>{};',
  '@flaretune/plugin-sdk/server/http-security': 'export const readBoundedJson=()=>{};',
  '@flaretune/plugin-sdk/server/lyric-document': 'export const createLyricDocument=x=>x;',
  '@flaretune/plugin-sdk/server/external-music-references': 'export const externalMusicSchemaReady=async()=>false; export const loadExternalSongs=async()=>[]; export const prepareExternalSongs=()=>{};',
  './connection.js': 'export const getYouTubeBinding=()=>{throw Error("inject access")};',
  './settings.js': 'export const loadYouTubeSettings=()=>{throw Error("inject access")};',
  './upstream.js': 'export const createSessionManager=()=>{throw Error("inject manager")}; export const mediaFetch=()=>{};',
  './player.js': 'export const createPlayer=()=>({});',
  './media.js': 'export const streamResponse=()=>{}; export const imageResponse=()=>{};',
  'youtubei.js/cf-worker': 'export const YTNodes={Tab:class{}};',
};
const built = await build({ stdin: { resolveDir: dir, contents: 'export {createYouTubeService} from "./service.js"; export {handleYouTubeMusicRoute} from "./integration.js";' },
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'only-host-capabilities', setup(plugin) {
    plugin.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'title-http-test' } : undefined);
    plugin.onLoad({ filter: /.*/, namespace: 'title-http-test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
  } }] });
const { createYouTubeService, handleYouTubeMusicRoute } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const rows = count => Array.from({ length: count }, (_, i) => ({ id: 'track' + String(i).padStart(6, '0'), item_type: 'song',
  title: `原名${i} - Original ${i}`, artists: [{ name: 'Artist' }], duration: { seconds: 100 + i } }));
const local = { id: 'local', title: 'Local title' };
function fixture(count = 5) {
  const calls = [], raw = rows(count), searches = [];
  const service = createYouTubeService({ services: { cacheNamespace: 'search-title-' + count + '-' + Math.random(), player: {},
    manager: { guest: async () => ({ music: { search: async (query, options) => {
      searches.push({ query, options }); return { contents: [{ title: 'Songs', contents: raw }], has_continuation: false };
    } } }) }, originalTitleFetch: async (url, init) => {
      assert.equal(url.origin, 'https://www.youtube.com'); assert.equal(init.credentials, 'omit');
      calls.push(url.searchParams.get('url').split('=').at(-1));
      return Response.json({ provider_name: 'YouTube', type: 'video', title: '发布原名' + calls.at(-1) });
    } } });
  const read = async (path, assertCurrent = async () => {}) => {
    const request = new Request('https://test.example' + path), url = new URL(request.url);
    return handleYouTubeMusicRoute(request, url, {}, { mode: 'normal', account: { accountId: 'owner' } }, {}, {
      localRead: async () => Response.json({ code: 200, data: { songs: [local], artists: [], albums: [], hasMore: false } }),
      getAccess: async () => ({ service, assertCurrent }),
    });
  };
  return { service, read, calls, searches };
}

test('HTTP display enrichment is sliced to this page and never changes cached song/lyric metadata or local results', async () => {
  const f = fixture();
  const before = await f.service.search('fixture', { filter: 'song', limit: 2, offset: 1 });
  const original = JSON.parse(JSON.stringify(before.songs));
  const response = await f.read('/api/songs/search?q=fixture&offset=1&limit=2');
  const data = (await response.json()).data;
  assert.equal(response.status, 200); assert.deepEqual(data.songs[0], local);
  assert.deepEqual(f.calls, ['track000001', 'track000002']);
  assert.deepEqual(data.songs.slice(1).map(({ displayTitle, ...rest }) => rest), original.slice(1, 3));
  assert.ok(data.songs.slice(1).every(song => song.displayTitle.startsWith('发布原名')));
  assert.deepEqual(before.songs, original);
  assert.equal((await f.service.song('track000001')).title, original[1].title);
  assert.equal(data.nextOffset, 3); assert.equal(data.hasMore, true);
});

test('connection retirement after name fetch discards the remote page before returning', async () => {
  const f = fixture(6);
  const response = await f.read('/api/songs/search?q=retirement&limit=2', async () => { throw Object.assign(Error('YOUTUBE_CONNECTION_CHANGED'), { code: 'YOUTUBE_CONNECTION_CHANGED' }); });
  const data = (await response.json()).data;
  assert.deepEqual(data.songs, [local]); assert.equal(data.sourceWarnings[0].code, 'unavailable');
});

test('a maximum-size page has at most twenty extra upstream requests and all rows remain available', async () => {
  const f = fixture(50);
  const data = (await (await f.read('/api/songs/search?q=max-page&limit=50')).json()).data;
  assert.equal(data.songs.length, 51); assert.ok(f.calls.length <= 20);
  assert.deepEqual(data.songs.slice(1).map(song => song.id), rows(50).map(row => 'yt:' + row.id));
});
