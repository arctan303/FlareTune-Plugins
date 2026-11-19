import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';
const deferred = () => { let resolve, reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const data = (etag='one') => ({ data: { song: {id:'s1',language:'en'}, asset:{status:'ready'}, lyrics:{lines:[{text:'Hello'}]}, etag, aiCompletionEnabled:true } });
function fixture(apiOverride = {}, globals = {}) {
  const scheduler = createBackgroundScheduler(); const notices=[], changed=[]; let active=true;
  const controller = new AbortController();
  const host = { signal:controller.signal, isCurrent:()=>active, notify:value=>notices.push(value),
    lyrics:{changed:(...args)=>changed.push(args)}, player:{getSnapshot:()=>({currentSong:{id:'s1',language:'en'}})} };
  const api = {getLyrics:async()=>data(),saveLyricsDocument:async()=>data(),completeLyricsTranslation:async()=>data(),...apiOverride};
  const harness = createBackgroundModuleHarness({file:new URL('./useManagedLyricsAsset.js',import.meta.url),
    exportName:'useManagedLyricsAsset', modules:{'@flaretune/plugin-sdk':{t:key=>key}},globals:{...scheduler,Date,...globals}});
  const props={host,api,songId:'s1',enabled:true};
  return {...harness,props,notices,changed,scheduler,retire(){active=false;controller.abort();},renderState(){return harness.render(props);}};
}
test('managed lyric response keeps song asset lyrics etag and optional AI together', () => {
  const f=fixture(); const value=f.exports.unwrapManagedLyricsAsset(data());
  assert.equal(value.song.id,'s1');assert.equal(value.etag,'one');assert.equal(value.aiCompletionEnabled,true);f.unmount();
});
test('successful shared mutation refreshes playback once and reports only after reread', async () => {
  const f=fixture(); f.renderState();await flushBackgroundAsync();
  const saved=await f.renderState().saveDocument([{text:'Edited'}],'one');
  assert.equal(saved,true);assert.equal(f.changed.length,1);assert.deepEqual(f.notices,['共享歌词已更新']);f.unmount();
});

test('one document save forwards its original baseline and optional restore or reset intent', async () => {
  const calls=[], asset={status:'ready',offsetMs:300};
  const f=fixture({saveLyricsDocument:async(...args)=>{calls.push(args);return data();}});
  f.renderState();await flushBackgroundAsync();
  await f.renderState().saveDocument([], 'initial-etag', 'receipt', 'en', {restoreAsset:asset,reset:true});
  const [songId,body]=calls[0];
  assert.equal(songId,'s1');assert.equal(body.etag,'initial-etag');assert.equal(body.aiReceipt,'receipt');
  assert.equal(body.translationLanguage,'en');assert.equal(body.restoreAsset,asset);assert.equal(body.reset,true);f.unmount();
});
test('mutation completion after retirement cannot toast refresh playback or start polling', async () => {
  const delayed=deferred();const f=fixture({completeLyricsTranslation:()=>delayed.promise});f.renderState();await flushBackgroundAsync();
  const result=f.renderState().completeTranslation();f.retire();f.unmount();delayed.resolve(data());
  assert.equal(await result,false);assert.deepEqual(f.changed,[]);assert.deepEqual(f.notices,[]);assert.equal(f.scheduler.timeouts.size,0);
});
test('a stale read cannot replace the state of a different selected song', async () => {
  const delayed=deferred();const f=fixture({getLyrics:()=>delayed.promise});f.renderState();
  f.props.songId='s2';f.props.api={getLyrics:async()=>({data:{song:{id:'s2'},etag:'new'}})};f.renderState();await flushBackgroundAsync();
  delayed.resolve(data('old'));await flushBackgroundAsync();
  assert.equal(f.renderState().song.id,'s2');assert.equal(f.renderState().etag,'new');f.unmount();
});
test('conflict reloads latest etag and polling releases timers on disposal', async () => {
  let read=0;const f=fixture({getLyrics:async()=>data(++read===1?'old':'new'),saveLyricsDocument:async()=>{throw Object.assign(new Error('Conflict'),{status:409,code:'LYRIC_ASSET_CONFLICT'});}});
  f.renderState();await flushBackgroundAsync();assert.equal(await f.renderState().saveDocument([], 'old'),'conflict');
  assert.equal(f.renderState().etag,'new');
  assert.equal(f.renderState().error,'共享歌词已在别处更新，草稿已保留。');
  assert.equal(f.notices.at(-1),'共享歌词已在别处更新，草稿已保留。');
  await f.renderState().completeTranslation();assert.equal(f.scheduler.timeouts.size,1);f.unmount();assert.equal(f.scheduler.timeouts.size,0);
});

test('legacy mutations retain their existing conflict recovery message', async () => {
  const f=fixture({shiftLyricsTimeline:async()=>{throw Object.assign(new Error('Conflict'),{status:409,code:'LYRIC_ASSET_CONFLICT'});}});
  f.renderState();await flushBackgroundAsync();assert.equal(await f.renderState().shiftTimeline(50),false);
  assert.equal(f.renderState().error,'歌词文件已在别处更新，已回读最新内容，请重试。');
  assert.equal(f.notices.at(-1),'歌词文件已在别处更新，已回读最新内容，请重试。');f.unmount();
});
test('removing optional Gateway stops polling while the workbench remains available', async () => {
  const f=fixture(); let ai=true; f.props.host.features={isAvailable:()=>ai};
  f.renderState();await flushBackgroundAsync();await f.renderState().completeTranslation();
  assert.equal(f.scheduler.timeouts.size,1);ai=false;f.scheduler.expire(1800);await flushBackgroundAsync();
  assert.equal(f.scheduler.timeouts.size,0);assert.equal(f.renderState().isAiCompleting,false);f.unmount();
});

test('legacy pending completion waits through the 180-second retry budget and stops after 210 seconds', async () => {
  let now=1_000_000,reads=0;
  const f=fixture({getLyrics:async()=>{reads++;const value=data();value.data.asset.aiCompletion={status:'pending'};return value;}},
    {Date:{now:()=>now}});
  f.renderState();await flushBackgroundAsync();f.renderState();
  assert.equal(f.scheduler.timeouts.size,1);assert.equal(reads,1);
  now+=180000;f.scheduler.expire(1800);await flushBackgroundAsync();
  assert.equal(f.renderState().isAiCompleting,true);assert.equal(f.renderState().error,'');assert.equal(reads,2);
  now+=30001;f.scheduler.expire(1800);await flushBackgroundAsync();
  assert.equal(f.renderState().isAiCompleting,false);assert.equal(f.scheduler.timeouts.size,0);
  assert.equal(f.renderState().error,'AI 补全仍未完成，请稍后刷新或重试。');assert.equal(reads,2);f.unmount();
});
test('refresh keeps the successful lyric snapshot through waiting and failure then accepts a newer result', async () => {
  const pending=deferred();let read=0;
  const f=fixture({getLyrics:()=>++read===1?Promise.resolve(data('one')):read===2?pending.promise:Promise.resolve(data('two'))});
  f.renderState();await flushBackgroundAsync();
  const refresh=f.renderState().load();let state=f.renderState();
  assert.equal(state.loading,false);assert.equal(state.refreshing,true);assert.equal(state.etag,'one');assert.equal(state.lyrics.lines[0].text,'Hello');
  pending.reject(new Error('network failure'));await refresh;state=f.renderState();
  assert.equal(state.loading,false);assert.equal(state.refreshing,false);assert.equal(state.etag,'one');assert.equal(state.error,'network failure');
  await state.load();state=f.renderState();assert.equal(state.etag,'two');assert.equal(state.error,'');f.unmount();
});
test('failed first load remains unloaded and cannot borrow the previous song snapshot', async () => {
  const f=fixture();f.renderState();await flushBackgroundAsync();
  assert.equal(f.renderState().etag,'one');
  f.props.songId='s2';f.props.api={getLyrics:async()=>{throw new Error('unavailable');}};
  f.renderState();await flushBackgroundAsync();const state=f.renderState();
  assert.equal(state.asset,null);assert.equal(state.lyrics,null);assert.equal(state.etag,null);assert.equal(state.error,'unavailable');f.unmount();
});
test('a retired host cannot restore its successful snapshot over a new identity', async () => {
  const pending=deferred();let reads=0;const f=fixture({getLyrics:()=>++reads===1?Promise.resolve(data('private-one')):pending.promise});
  f.renderState();await flushBackgroundAsync();const oldRefresh=f.renderState().load();
  f.props.host={...f.props.host,isCurrent:()=>true};f.props.api={getLyrics:async()=>({data:{song:{id:'s1'},asset:null,lyrics:null,etag:'public-two'}})};
  f.renderState();await flushBackgroundAsync();pending.reject(new Error('old failure'));await oldRefresh;
  const state=f.renderState();assert.equal(state.etag,'public-two');assert.equal(state.asset,null);assert.equal(state.error,'');f.unmount();
});
