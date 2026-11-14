import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Public-capability unit contract. Actual SDK/R2 authorization and the whole
// HTTP Free50 budget are exercised separately by host integration fixtures.
const stubs = {
  '@flaretune/plugin-sdk/server/auth': 'export class AuthError extends Error { constructor(code,status=409){super(code);this.code=code;this.status=status;} }',
  '@flaretune/plugin-sdk/server/plugin-common': 'export const requirePluginSession=async env=>env.test.identity;',
  '@flaretune/plugin-sdk/server/service-leases': 'export const createPluginOperationLease=async ({env,requestIdentity,pluginId})=>{if(requestIdentity!==env.test.identity||pluginId!=="youtube-music")throw Error("incorrect trusted identity");env.test.leases++;return env.test.lease;};',
  '@flaretune/plugin-sdk/server/music-catalog': 'export const handleLocalMusicReadRoute=()=>{};',
  '@flaretune/plugin-sdk/server/album-catalog': 'export const handleLocalAlbumReadRoute=()=>{};',
  '@flaretune/plugin-sdk/server/catalog-discovery': 'export const handleLocalMusicDiscoveryRoute=()=>{};',
  '@flaretune/plugin-sdk/server/http-security': 'export const readBoundedJson=()=>{};',
  '@flaretune/plugin-sdk/server/lyric-document': 'export const createLyricDocument=x=>x;',
  '@flaretune/plugin-sdk/server/external-music-references': 'export const externalMusicSchemaReady=()=>false;export const loadExternalSongs=()=>[];export const prepareExternalSongs=()=>{};',
  './connection.js': 'export const YOUTUBE_CONNECTION_KEY="plugin.youtube-music.connection";export const getYouTubeBinding=async env=>env.test.binding;',
  './settings.js': 'export const loadYouTubeSettings=async()=>({});',
  './service.js': 'export const createYouTubeService=()=>({});',
};
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./integration.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'access-capabilities', setup(api) {
    api.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs,args.path) ? {path:args.path,namespace:'access-fixture'} : undefined);
    api.onLoad({filter:/.*/,namespace:'access-fixture'},args=>({contents:stubs[args.path],loader:'js'}));
  } }] });
const {createYouTubeAccess} = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
function fixture() {
  const state={ identity:{accountId:'member',role:'member'},binding:{epoch:'1:binding',record:{epoch:1,revision:7},credentials:{}},leases:0,queries:0,diagnoses:0,revision:7,retired:false };
  const env={DB:{raw:true},test:state};
  state.lease={plugin:{epoch:1},guardedDb:db=>{assert.equal(db,env.DB);return{prepare:sql=>({bind:key=>({first:async()=>{
    assert.equal(sql,'SELECT revision FROM instance_settings WHERE key=?');assert.equal(key,'plugin.youtube-music.connection');state.queries++;
    if(state.retired)throw Error('guarded database rejected');return{revision:state.revision};
  }})})};},assertCurrent:async()=>{state.diagnoses++;if(state.retired)throw Object.assign(Error('forbidden'),{code:'forbidden',status:403});}};
  return{state,env};
}
test('request-owned access checks the guarded connection revision on every boundary with one lease',async()=>{
 const {state,env}=fixture(),access=await createYouTubeAccess(env,{account:state.identity},null);await access.assertCurrent();await access.assertCurrent();
 assert.equal(state.leases,1);assert.equal(state.queries,2);assert.equal(state.diagnoses,0);
});
test('connection revision changes retire the captured access',async()=>{
 const {state,env}=fixture(),access=await createYouTubeAccess(env,{account:state.identity},null);state.revision++;
 await assert.rejects(access.assertCurrent(),{code:'YOUTUBE_CONNECTION_CHANGED'});
});
test('a reinstalled source cannot grant the earlier binding a new epoch',async()=>{
 const {state,env}=fixture();state.lease.plugin.epoch=2;
 await assert.rejects(createYouTubeAccess(env,{account:state.identity},null),{code:'YOUTUBE_CONNECTION_CHANGED'});assert.equal(state.queries,0);
});
test('guard rejection uses the lease typed authority diagnosis only on failure',async()=>{
 const {state,env}=fixture(),access=await createYouTubeAccess(env,{account:state.identity},null);state.retired=true;
 await assert.rejects(access.assertCurrent(),{code:'forbidden',status:403});assert.equal(state.queries,1);assert.equal(state.diagnoses,1);
});
test('custom injected access retains the original session and binding checks',async()=>{
 let sessions=0,bindings=0;const binding={epoch:'original',record:{epoch:1},credentials:{}};
 const access=await createYouTubeAccess({}, {},null,{checkSession:async()=>{sessions++;},bindingFor:async()=>{bindings++;return binding;},settingsFor:async()=>({}),createService:()=>({})});
 await access.assertCurrent();assert.equal(sessions,2);assert.equal(bindings,2);
});
