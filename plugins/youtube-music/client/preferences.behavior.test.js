import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundModuleHarness,flushBackgroundAsync} from '../../../tests/fullscreenBackgroundHarness.js';
import {youtubeMessage} from '../shared/messages.js';
const nodes=tree=>tree&&typeof tree==='object'?[tree,...[tree.props?.action,...(tree.props?.children||[])].flat(Infinity).flatMap(nodes)]:[];
const text=node=>typeof node==='string'?node:(node?.props?.children||[]).flat(Infinity).map(text).join('');
const saved={metadataLanguage:'en',region:'US',lyricsEnabled:true,translationEnabled:true,translationLanguage:'zh-CN'};
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&text(n)===label);
function fixture({locale='zh',currentSongId='yt:fixture-song',put}={}){
  const calls=[],changes=[],notices=[];let current=true,value={...saved},revision=7;
  const host={isCurrent:()=>current,player:{getSnapshot:()=>({currentSong:{id:currentSongId}})},lyrics:{changed:id=>changes.push(id)},notify:message=>notices.push(message),request:async(path,options)=>{
    calls.push({path,options});if(options?.method==='PUT'){if(put)return put(options);value={...options.body.value};revision++;}return{setting:{value:{...value},revision}};
  }};
  const view=createBackgroundModuleHarness({file:new URL('./YouTubePreferences.jsx',import.meta.url),modules:{'@flaretune/plugin-sdk':{
    t:key=>key,useLocale:()=>locale,SelectControl:'select',SettingsSection:'section',SettingsEditDialog:'dialog',SettingsActions:'actions',SettingsButton:'button',SettingsToggle:'toggle',SettingsSkeleton:'skeleton',
  }},globals:{}});
  return{...view,calls,changes,notices,retire:()=>{current=false},renderSettings:()=>view.render({host}),open(){button(view.render({host}),'编辑').props.onClick()}};
}
const select=(tree,name)=>nodes(tree).find(n=>n.type==='select'&&n.props['aria-label']===name);
test('the five YouTube preferences stay behind one editor and cancel never saves or invalidates lyrics',async()=>{
  const f=fixture();f.renderSettings();await flushBackgroundAsync();let tree=f.renderSettings();
  assert.equal(nodes(tree).some(n=>['form','select','toggle'].includes(n.type)),false);assert.match(text(tree),/资料语言英语/);assert.match(text(tree),/简体中文/);
  f.open();tree=f.renderSettings();assert.equal(nodes(tree).filter(n=>n.type==='select').length,3);assert.equal(nodes(tree).filter(n=>n.type==='toggle').length,2);
  select(tree,'资料语言').props.onChange({target:{value:'ja'}});select(tree,'地区').props.onChange({target:{value:'JP'}});select(tree,'译文语言').props.onChange({target:{value:'ko'}});tree=f.renderSettings();
  assert.equal(button(tree,'取消').props.closeDialog,true);nodes(tree).find(n=>n.type==='dialog').props.onClose();tree=f.renderSettings();
  assert.equal(f.calls.some(c=>c.options?.method==='PUT'),false);assert.equal(f.changes.length,0);assert.equal(nodes(tree).some(n=>n.type==='form'),false);
  f.open();tree=f.renderSettings();assert.equal(select(tree,'资料语言').props.value,'en');assert.equal(select(tree,'地区').props.value,'US');assert.equal(select(tree,'译文语言').props.value,'zh-CN');f.unmount();
});
test('preference dependencies disable translation controls without erasing the saved target or switch',async()=>{
  const f=fixture();f.renderSettings();await flushBackgroundAsync();f.open();let tree=f.renderSettings();
  nodes(tree).find(n=>n.type==='toggle'&&n.props.label==='提供歌词').props.onChange({target:{checked:false}});tree=f.renderSettings();
  const translation=nodes(tree).find(n=>n.type==='toggle'&&n.props.label==='获取 YouTube 歌词翻译');assert.equal(translation.props.disabled,true);assert.equal(translation.props.checked,true);
  assert.equal(select(tree,'译文语言').props.disabled,true);assert.equal(select(tree,'译文语言').props.value,'zh-CN');
  nodes(tree).find(n=>n.type==='toggle'&&n.props.label==='提供歌词').props.onChange({target:{checked:true}});tree=f.renderSettings();assert.equal(select(tree,'译文语言').props.disabled,false);f.unmount();
});
test('successful saves retain both independent language choices and invalidate only the current YT lyric result',async()=>{
  const f=fixture();f.renderSettings();await flushBackgroundAsync();f.open();let tree=f.renderSettings();
  select(tree,'资料语言').props.onChange({target:{value:'ja'}});select(tree,'译文语言').props.onChange({target:{value:'ko'}});tree=f.renderSettings();
  nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flushBackgroundAsync();tree=f.renderSettings();
  const request=f.calls.find(c=>c.options?.method==='PUT');assert.equal(request.options.body.expectedRevision,7);
  assert.equal(request.options.body.value.metadataLanguage,'ja');assert.equal(request.options.body.value.translationLanguage,'ko');assert.equal(request.options.body.value.region,'US');
  assert.deepEqual(f.changes,['yt:fixture-song']);assert.equal(f.notices.length,1);assert.equal(nodes(tree).some(n=>n.type==='dialog'),false);
  assert.match(text(tree),/资料语言日语/);assert.match(text(tree),/译文语言韩语/);f.unmount();
});
test('a pending save blocks duplicate submissions and close, then updates the summary only on success',async()=>{
  let finish;const pending=new Promise(resolve=>finish=resolve),f=fixture({put:()=>pending});f.renderSettings();await flushBackgroundAsync();f.open();let tree=f.renderSettings();
  select(tree,'资料语言').props.onChange({target:{value:'ko'}});tree=f.renderSettings();const submit=nodes(tree).find(n=>n.type==='form').props.onSubmit;
  submit({preventDefault(){}});submit({preventDefault(){}});tree=f.renderSettings();assert.equal(f.calls.filter(c=>c.options?.method==='PUT').length,1);
  assert.equal(nodes(tree).find(n=>n.type==='dialog').props.busy,true);nodes(tree).find(n=>n.type==='dialog').props.onClose();assert.ok(nodes(f.renderSettings()).some(n=>n.type==='dialog'));
  assert.match(text(nodes(tree).find(n=>n.type==='section')),/资料语言英语/);
  finish({setting:{value:{...saved,metadataLanguage:'ko'},revision:8}});await flushBackgroundAsync();tree=f.renderSettings();assert.equal(nodes(tree).some(n=>n.type==='dialog'),false);assert.match(text(tree),/资料语言韩语/);f.unmount();
});
test('a failed preference save retains its draft and does not invalidate or notify',async()=>{
  const f=fixture({put:()=>{throw Error('network')}});f.renderSettings();await flushBackgroundAsync();f.open();let tree=f.renderSettings();select(tree,'译文语言').props.onChange({target:{value:'ja'}});tree=f.renderSettings();
  nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flushBackgroundAsync();tree=f.renderSettings();
  assert.equal(select(tree,'译文语言').props.value,'ja');assert.ok(nodes(tree).find(n=>n.type==='dialog').props.message);assert.equal(f.changes.length,0);assert.equal(f.notices.length,0);f.unmount();
});
test('saving a non-YT song setting does not invalidate that unrelated lyric asset',async()=>{
  const f=fixture({currentSongId:'local-song'});f.renderSettings();await flushBackgroundAsync();f.open();let tree=f.renderSettings();select(tree,'地区').props.onChange({target:{value:'JP'}});tree=f.renderSettings();nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});await flushBackgroundAsync();assert.equal(f.changes.length,0);f.unmount();
});
test('all five UI languages retain the same five editable fields and stored values',async()=>{
  for(const locale of ['zh','zh-Hant','en','ja','ko']){
    const f=fixture({locale});f.renderSettings();await flushBackgroundAsync();f.open();const tree=f.renderSettings(),tr=key=>youtubeMessage(key,locale);
    assert.equal(select(tree,tr('metadataLanguage')).props.value,'en');assert.equal(select(tree,tr('translationLanguage')).props.value,'zh-CN');
    assert.equal(nodes(tree).filter(n=>n.type==='toggle').length,2);assert.equal(select(tree,tr('translationLanguage')).props.children.flat().length,5);f.unmount();
  }
});
