import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundModuleHarness,flushBackgroundAsync} from '../../../tests/fullscreenBackgroundHarness.js';
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...[tree.props?.action,...(tree.props?.children||[])].flat(Infinity).flatMap(nodes)]:[];
const text=node=>typeof node==='string'?node:(node?.props?.children||[]).flat(Infinity).map(text).join('');
const source={id:'fixture-source',name:'Existing source',note:'Saved note',protocol:'custom_lrc',enabled:true,searchUrl:'https://example.com/search',downloadUrl:'https://example.com/lyrics',translationLanguage:'en'};
function fixture(){
  const calls=[];let confirmed=false,setting={value:{version:2,sources:[source]},revision:4};
  const host={isCurrent:()=>true,request:async(path,options)=>{calls.push({path,options});return{setting:{value:options.body.value,revision:5}}}};
  const view=createBackgroundModuleHarness({file:new URL('./LyricSourcesSettings.jsx',import.meta.url),modules:{'@flaretune/plugin-sdk':{
    t:(key,args={})=>key.replace(/\{([^}]+)\}/g,(_,name)=>args[name]??name),DEFAULT_LYRIC_CHANNELS:{version:2,sources:[]},MAX_LYRIC_SOURCES:20,normalizeLyricChannels:value=>value,
    SettingsSection:'section',SettingsEditDialog:'dialog',InfoTip:'tip',SettingsButton:'button',SettingsActions:'actions',SettingsToggle:'toggle',SettingsInput:'input',SettingsTextarea:'textarea',useSettingsReadOnly:()=>false,SelectControl:'select',ALL_LANGUAGES:[{code:'en',label:'English'}],getLanguageLabel:()=> 'English',
  },'./LyricSourceQuickTest.jsx':'quick-test','lucide-react':{}},globals:{structuredClone,window:{confirm:()=>confirmed}}});
  return{...view,calls,confirm:()=>{confirmed=true},renderSettings:()=>view.render({setting,host,onSaved:value=>{setting=value}})};
}
test('source configuration stays hidden and cancel discards only the unsaved editor draft',()=>{
  const f=fixture();let tree=f.renderSettings();assert.equal(nodes(tree).some(n=>n.type==='input'||n.type==='form'),false);assert.equal(nodes(tree).some(n=>n.props.variant==='danger'),false);
  nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='编辑 Existing source').props.onClick();tree=f.renderSettings();
  nodes(tree).find(n=>n.type==='input').props.onChange({target:{value:'Unsaved source'}});tree=f.renderSettings();
  assert.equal(nodes(tree).find(n=>n.type==='button'&&text(n)==='取消').props.closeDialog,true);
  nodes(tree).find(n=>n.type==='dialog').props.onClose();tree=f.renderSettings();assert.equal(f.calls.length,0);
  nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='编辑 Existing source').props.onClick();tree=f.renderSettings();
  assert.equal(nodes(tree).find(n=>n.type==='input').props.value,'Existing source');f.unmount();
});
test('source removal remains explicitly confirmed and independent from form submission',async()=>{
  const f=fixture();let tree=f.renderSettings();nodes(tree).find(n=>n.type==='button'&&n.props['aria-label']==='编辑 Existing source').props.onClick();tree=f.renderSettings();
  const form=nodes(tree).find(n=>n.type==='form');assert.equal(nodes(form).some(n=>n.props.variant==='danger'),false);
  const remove=nodes(tree).find(n=>n.type==='button'&&n.props.variant==='danger');remove.props.onClick();await flushBackgroundAsync();assert.equal(f.calls.length,0);
  f.confirm();remove.props.onClick();await flushBackgroundAsync();tree=f.renderSettings();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'sources-settings');assert.equal(f.calls[0].options.body.expectedRevision,4);
  assert.equal(f.calls[0].options.body.value.sources.length,0);assert.equal(nodes(tree).some(n=>n.type==='dialog'),false);f.unmount();
});
test('the high-frequency source enable switch keeps its original immediate-save behavior',async()=>{
  const f=fixture();const tree=f.renderSettings();await nodes(tree).find(n=>n.type==='toggle').props.onChange({target:{checked:false}});await flushBackgroundAsync();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.expectedRevision,4);assert.equal(f.calls[0].options.body.value.sources[0].enabled,false);
  assert.equal(f.calls[0].options.body.value.sources[0].searchUrl,source.searchUrl);f.unmount();
});
