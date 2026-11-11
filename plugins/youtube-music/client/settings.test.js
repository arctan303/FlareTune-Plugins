import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundModuleHarness,flushBackgroundAsync} from '../../../tests/fullscreenBackgroundHarness.js';
import {youtubeSettingsMessage} from '../shared/settingsMessages.js';

const nodes=tree=>tree&&typeof tree==='object'?[tree,...[tree.props?.action,...(tree.props?.children||[])].flat(Infinity).flatMap(nodes)]:[];
const text=node=>typeof node==='string'?node:(node?.props?.children||[]).flat(Infinity).map(text).join('');
function fixture({initial={connected:true,connectedAt:1,revision:2,cacheAvailable:true},failRead=false,disconnect}={}){
  const calls=[],events=[];let active=true,first=true;
  const host={isCurrent:()=>active,musicSources:{changed:()=>events.push('changed')},request:async(path,options)=>{
    calls.push({path,options});
    if(path==='status'){if(first&&failRead){first=false;throw Error('network');}first=false;return initial;}
    if(path==='connection/disconnect')return disconnect?disconnect():{...initial,connected:false,connectedAt:null,revision:3};
    return{...initial,connected:false,revision:3,pending:{pendingId:'fixture-pending',userCode:'ABCD-EFGH',interval:5,verificationUrl:'https://youtube.com/activate'}};
  }};
  const view=createBackgroundModuleHarness({file:new URL('./YouTubeSettings.jsx',import.meta.url),modules:{'@flaretune/plugin-sdk':{
    t:key=>key,useLocale:()=> 'en',InfoTip:'tip',SettingsSection:'section',SettingsActions:'actions',SettingsButton:'button',SettingsSkeleton:'skeleton',
  }},globals:{setTimeout:()=>1,clearTimeout(){}}});
  return{...view,host,calls,events,retire(){active=false},renderSettings(){return view.render({host})}};
}
test('YouTube connection summary exposes one primary action and separates unlink from the header',async()=>{
  const f=fixture();f.renderSettings();await flushBackgroundAsync();const tree=f.renderSettings();
  assert.equal(tree.props.title,'账号连接');assert.equal(tree.props.action.props.variant,'secondary');
  assert.equal(text(tree.props.action),'重新连接 YouTube');assert.match(text(tree),/YouTube Music 已连接/);
  assert.equal(nodes(tree).some(n=>['input','textarea','select','form'].includes(n.type)),false);
  const danger=nodes(tree).find(n=>n.type==='div'&&n.props.className?.includes('border-t'));
  assert.match(text(danger),/Disconnecting removes this site/);
  assert.ok(nodes(danger).some(n=>n.type==='button'&&n.props.variant==='danger'));
  assert.equal(f.calls.some(c=>c.options?.method==='POST'),false);f.unmount();
});
test('unlink preserves the connection until the authoritative response and passes its current revision',async()=>{
  let finish;const pending=new Promise(yes=>finish=yes),f=fixture({disconnect:()=>pending});
  f.renderSettings();await flushBackgroundAsync();let tree=f.renderSettings();
  const request=nodes(tree).find(n=>n.type==='button'&&n.props.variant==='danger').props.onClick();
  tree=f.renderSettings();assert.match(text(tree),/YouTube Music 已连接/);assert.equal(tree.props.action.props.disabled,true);
  assert.equal(f.calls.at(-1).path,'connection/disconnect');assert.equal(f.calls.at(-1).options.body.revision,2);
  finish({connected:false,connectedAt:null,revision:3,cacheAvailable:true});await request;await flushBackgroundAsync();tree=f.renderSettings();
  assert.match(text(tree),/YouTube Music 未连接/);assert.equal(nodes(tree).some(n=>n.props.variant==='danger'),false);assert.deepEqual(f.events,['changed']);f.unmount();
});
test('an unreadable status stays unknown and offers a retry without starting authorization',async()=>{
  const f=fixture({failRead:true});f.renderSettings();await flushBackgroundAsync();let tree=f.renderSettings();
  assert.doesNotMatch(text(tree),/YouTube Music 未连接/);assert.equal(tree.props.action.props.disabled,true);
  nodes(tree).find(n=>n.type==='button'&&text(n)==='重试').props.onClick();await flushBackgroundAsync();tree=f.renderSettings();
  assert.match(text(tree),/YouTube Music 已连接/);assert.equal(f.calls.length,2);assert.equal(f.calls.every(c=>c.path==='status'),true);f.unmount();
});
test('device authorization remains an explicit operation and shows the real pending code',async()=>{
  const f=fixture({initial:{connected:false,revision:2,cacheAvailable:true}});f.renderSettings();await flushBackgroundAsync();
  await f.renderSettings().props.action.props.onClick();await flushBackgroundAsync();const tree=f.renderSettings();
  assert.match(text(tree),/ABCD-EFGH/);assert.equal(f.calls.at(-1).path,'connection/start');
  assert.equal(nodes(tree).find(n=>n.type==='a').props.href,'https://youtube.com/activate');f.unmount();
});
test('YouTube unlink consequences exist in each supported language and fall back to English',()=>{
  const translations=['zh','zh-Hant','en','ja','ko'].map(locale=>youtubeSettingsMessage('disconnectConsequence',locale));
  assert.equal(new Set(translations).size,5);assert.ok(translations.every(value=>value.length>15));
  assert.equal(youtubeSettingsMessage('disconnectConsequence','unknown'),youtubeSettingsMessage('disconnectConsequence','en'));
});
