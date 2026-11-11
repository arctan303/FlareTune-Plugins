import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { DEFAULT_YOUTUBE_SETTINGS } from '../shared/preferences.js';

async function compile(file, stubs) {
  const entry = fileURLToPath(new URL(file, import.meta.url));
  const result = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{
    name: 'behavior-dependencies', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'behavior-test' } : undefined);
      plugin.onLoad({ filter: /.*/, namespace: 'behavior-test' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    },
  }] });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}
const { createYouTubeService } = await compile('./service.js', {
  './upstream.js': 'export const createSessionManager=()=>{throw Error("inject manager")};export const mediaFetch=()=>{throw Error("unused media")};',
  './player.js': 'export const createPlayer=()=>({});',
  'youtubei.js/cf-worker': 'export const YTNodes={Tab:class{}};',
  '@flaretune/plugin-sdk/server/lyric-document': 'export const createLyricDocument=x=>({...x,version:2,syncMode:x.format==="lrc"?"line":"none"});',
});
test('metadata settings reach the session without substituting the lyric target language', async () => {
  const calls = [];
  const service = createYouTubeService({ settings: { ...DEFAULT_YOUTUBE_SETTINGS, metadataLanguage: 'en', region: 'JP', translationLanguage: 'ko' },
    services: { manager: { guest: async (...args) => { calls.push(args); return { music: { getUpNext: async () => ({ contents: [{ video_id: 'abcde123456', title: 'Original title' }] }) } }; } }, player: {} } });
  assert.equal((await service.song('abcde123456')).title, 'Original title');
  assert.deepEqual(calls, [['en', 'JP']]);
});
test('metadata and paged searches do not leak cached region-specific results between settings', async () => {
  const searches = [];
  const create = region => createYouTubeService({ settings: { ...DEFAULT_YOUTUBE_SETTINGS, region }, services: {
    player: {}, manager: { guest: async () => ({ music: {
      getUpNext: async () => ({ contents: [{ video_id: 'region12345', title: region }] }),
      search: async () => { searches.push(region); return { contents: [] }; },
    } }) },
  } });
  const us = create('US'), jp = create('JP');
  assert.equal((await us.song('region12345')).title, 'US'); assert.equal((await jp.song('region12345')).title, 'JP');
  await us.search('region isolated request'); await jp.search('region isolated request'); assert.deepEqual(searches, ['US', 'JP']);
});
test('next metadata remains English while paired lyrics request the independent Korean target', async () => {
  const guestCalls = [], iosCalls = [];
  let calls = 0;
  const mobile = { actions: { execute: async () => {
    calls++;
    if (calls === 1) return { data: { browseEndpoint: { browseId: 'MPLYt_case' } } };
    if (calls === 2) {
      let data = { timedLyricsData: [{ lyricLine: 'hello', cueRange: { startTimeMilliseconds: '0', endTimeMilliseconds: '1000' } }], translationContinuationToken: 'opaque' };
      for (const field of ['lyricsData', 'timedLyricsModel', 'model', 'componentType', 'type', 'newElement', 'elementRenderer', 'contents']) data = { [field]: data };
      return { data };
    }
    return { data: { continuationContents: { musicLyricsContinuation: { lyricsTranslations: [{ translatedLyricText: '안녕' }] } } } };
  } } };
  const service = createYouTubeService({ settings: { ...DEFAULT_YOUTUBE_SETTINGS, metadataLanguage: 'en', region: 'JP', translationLanguage: 'ko' },
    services: { player: {}, manager: {
      guest: async (...args) => { guestCalls.push(args); return { music: { getUpNext: async () => ({ contents: [] }) } }; },
      musicIos: async (...args) => { iosCalls.push(args); return mobile; },
    } } });
  const result = await service.next('langtest123'); assert.equal(result.lyrics.translation.language, 'ko');
  assert.deepEqual(guestCalls, [['en', 'JP']]); assert.deepEqual(iosCalls, [['ko', 'JP']]); assert.equal(calls, 3);
});
const { createYouTubeHandler } = await compile('./admin.js', {
  'youtubei.js/cf-worker': 'export const Innertube={};export const Log={setLevel(){},Level:{NONE:0}};',
  '@flaretune/plugin-sdk/server/http-security': 'export const readBoundedJson=request=>request.json();',
  '@flaretune/plugin-sdk/server/auth': 'export class AuthError extends Error {constructor(code,status){super(code);this.code=code;this.status=status}}',
  '@flaretune/plugin-sdk/server/admin-common': 'export class InstanceAdminError extends Error{}',
  '@flaretune/plugin-sdk/server/service-leases': 'export const createPluginOperationLease=()=>{throw Error("inject lease")};',
  './connection.js': 'export const readYouTubeConnection=()=>{throw Error("connection should not be read")};export const saveYouTubeConnection=()=>{};export const publicYouTubeStatus=()=>{};export const validYouTubeCredentials=()=>false;',
  './service.js': 'export const createYouTubeService=()=>({});',
  './upstream.js': 'export const upstreamFetch=()=>{};',
  './settings.js': 'export const readYouTubeSettings=()=>{};export const saveYouTubeSettings=()=>{};',
});
const json = (data, status = 200) => ({ data, status });
test('settings routes reject non-admin roles before accessing storage', async () => {
  const handler = createYouTubeHandler({}, {}, { createLease: () => { throw Error('must not reach lease'); } });
  const result = await handler({ request: new Request('https://example/settings'), path: '/settings', scope: 'admin', context: { identity: { role: 'member' } }, json });
  assert.equal(result.status, 403);
});
test('admin settings use guarded storage, expected revision, and the final lease check', async () => {
  const guardedDb = { guarded: true }, calls = [];
  const handler = createYouTubeHandler({ DB: { unguarded: true } }, { account: { accountId: 'admin' } }, {
    createLease: async options => { assert.equal(options.admin, true); assert.equal(options.pluginId, 'youtube-music'); return {
      guardedDb: () => guardedDb, assertCurrent: async () => calls.push('current'),
    }; },
    saveSettings: async (db, actor, value, revision) => { assert.equal(db, guardedDb); assert.equal(actor, 'admin');
      assert.equal(revision, 7); assert.equal(value.translationEnabled, false); calls.push('save'); return { value, revision: 8 }; },
  });
  const result = await handler({ request: new Request('https://example/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: { ...DEFAULT_YOUTUBE_SETTINGS, translationEnabled: false }, expectedRevision: 7 }) }),
    path: '/settings', scope: 'admin', context: { identity: { role: 'admin', accountId: 'admin' }, plugin: { epoch: 'current' } }, json });
  assert.equal(result.status, 200); assert.equal(result.data.setting.revision, 8); assert.deepEqual(calls, ['save', 'current']);
});
