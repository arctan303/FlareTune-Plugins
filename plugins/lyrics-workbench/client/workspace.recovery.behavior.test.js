import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes=tree=>tree&&typeof tree==='object'?[tree,...(tree.props?.children||[]).flat(Infinity).flatMap(nodes)]:[];
const text=tree=>typeof tree==='string'?tree:(tree?.props?.children||[]).flat(Infinity).map(text).join('');
function fixture(value) {
  let loads=0,managed=value;
  const player={currentSong:{id:'one',title:'One'},currentTime:0,duration:100};
  const host={isCurrent:()=>true,notify(){},session:{get:()=>({authenticated:true,user:{role:'admin'}})},beforeLeave:{register:()=>()=>{}}};
  const view=createBackgroundModuleHarness({file:new URL('./LyricsPluginPage.jsx',import.meta.url),
    render:(module,props)=>{const element=module.default(props);return element.type(element.props);},modules:{
      '@flaretune/plugin-sdk':{t:key=>key,useLocale:()=> 'zh',useSettingsReadOnly:()=>false,SettingsInput:'input',SettingsToggle:'toggle',ProgressBar:'progress',PageBackButton:'back'},
      'lucide-react':{},'./workspace.css':{},'./LyricsSettings.jsx':'settings','./LyricsCandidatePanel.jsx':'candidates',
      './useHostPlayer.js':{useHostPlayer:()=>player},'./api.js':{createLyricsWorkspaceApi:()=>({})},
      './useManagedLyricsAsset.js':{useManagedLyricsAsset:()=>({...managed,load(){loads++;}})}},
    globals:{window:{addEventListener(){},removeEventListener(){}}}});
  return{...view,renderWorkspace:()=>view.render({host,pageId:'current'}),set:value=>{managed=value;},loads:()=>loads};
}
test('lyric refresh and refresh error keep the usable preview visible with a local retry',()=>{
  const ready={asset:{status:'ready'},lyrics:{lines:[{text:'Known lyric'}]},refreshing:true};
  const f=fixture(ready);let tree=f.renderWorkspace();
  assert.ok(nodes(tree).some(n=>n.props.className?.includes('lyric-studio__preview-frame')));
  assert.ok(nodes(tree).some(n=>n.props.role==='status'&&text(n)==='正在更新歌词…'));
  f.set({...ready,refreshing:false,error:'offline'});tree=f.renderWorkspace();
  assert.ok(nodes(tree).some(n=>n.props.className?.includes('lyric-studio__preview-frame')));
  assert.ok(!text(tree).includes('这首歌还没有歌词'));
  nodes(tree).find(n=>n.type==='button'&&text(n)==='重试').props.onClick();assert.equal(f.loads(),1);f.unmount();
});
test('a first lyric read failure shows recovery rather than a false no-lyrics state',()=>{
  const f=fixture({asset:null,lyrics:null,error:'offline'});const tree=f.renderWorkspace();
  assert.ok(nodes(tree).some(n=>n.props.role==='alert'&&text(n).includes('offline')));
  assert.ok(!text(tree).includes('这首歌还没有歌词'));
  assert.ok(nodes(tree).some(n=>n.type==='button'&&text(n)==='重试'));f.unmount();
});
