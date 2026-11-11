import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { AI_PROTOCOLS, AI_SOURCES } from '../shared/aiProtocols.js';
import { createBackgroundModuleHarness, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';
import {gatewayDeleteConsequence} from '../shared/settingsMessages.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' ? node : (node?.props?.children || []).flat(Infinity).map(text).join('');
test('Gateway settings show the existing key as configured and edit through their bound host', async () => {
  const calls = [];
  const host = { assertCurrent() {}, request: async (path, options) => { calls.push({ path, options }); return { id: 'two', name: 'DeepSeek', source: 'deepseek', revision: 1, hasKey: true }; } };
  const resource = { data: { ready: true, credentialReady: true,
    providers: [{ id: 'one', name: 'Saved provider', source: 'deepseek', hasKey: true, revision: 1 }],
    features: { assistant: { revision: 0 }, lyrics: { revision: 0 } } }, loading: false,
    setData: fn => { resource.data = fn(resource.data); }, refresh: async () => resource.data };
  const sdk = { t: key => key, useLocale: () => 'zh', useSettingsResource: () => resource, AI_PROTOCOLS, AI_SOURCES,
    SettingsInput: 'input', SettingsWriteButton: 'button', SettingsEditDialog: 'dialog', SettingsSkeleton: 'skeleton',
    InfoTip: 'tip', SettingsActions: 'actions', SettingsButton: 'button', SettingsToggle: 'toggle', SelectControl: 'select' };
  const view = createBackgroundModuleHarness({ file: new URL('./GatewaySettings.jsx', import.meta.url),
    modules: { '@flaretune/plugin-sdk': sdk, 'lucide-react': icons }, globals: { window: { confirm: () => true } } });
  let tree = view.render({ host });
  assert.match(text(tree), /Saved provider/); assert.match(text(tree), /密钥已配置/);
  assert.doesNotMatch(text(tree), /功能使用方案|音乐助手|歌词 AI/);
  assert.equal(nodes(tree).some(node => node.type === 'input' && node.props.type === 'password'), false);
  nodes(tree).find(node => node.type === 'button' && text(node) === '添加供应商').props.onClick();
  tree = view.render({ host });
  const password = nodes(tree).find(node => node.type === 'input' && node.props.type === 'password');
  assert.equal(password.props.value, '');
  password.props.onChange({ target: { value: 'newly-entered-private-key' } });
  tree = view.render({ host });
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(calls[0].path, 'providers'); assert.equal(calls[0].options.admin, true);
  assert.equal(calls[0].options.body.apiKey, 'newly-entered-private-key');
  tree = view.render({ host });
  assert.equal(nodes(tree).some(node => node.type === 'dialog'), false);
  assert.doesNotMatch(text(tree), /newly-entered-private-key/);
  view.unmount();
});

function editFixture(){
  const calls=[];let confirmed=false;
  const resource={data:{ready:true,credentialReady:true,providers:[{id:'one',name:'Saved provider',source:'deepseek',hasKey:true,revision:7}]},loading:false,
    setData:fn=>{resource.data=fn(resource.data)},refresh:async()=>resource.data};
  const host={assertCurrent(){},isCurrent:()=>true,request:async(path,options)=>{calls.push({path,options});return{ok:true}}};
  const sdk={t:key=>key,useLocale:()=> 'en',useSettingsResource:()=>resource,SettingsInput:'input',SettingsEditDialog:'dialog',SettingsSkeleton:'skeleton',InfoTip:'tip',SettingsActions:'actions',SettingsButton:'button',SelectControl:'select'};
  const view=createBackgroundModuleHarness({file:new URL('./GatewaySettings.jsx',import.meta.url),modules:{'@flaretune/plugin-sdk':sdk,'lucide-react':icons},globals:{window:{confirm:()=>confirmed}}});
  return{...view,host,calls,confirm:()=>{confirmed=true},renderSettings:()=>view.render({host})};
}
test('provider edits remain drafts and deletion is confined to a separate editor footer',async()=>{
  const f=editFixture();let tree=f.renderSettings();
  assert.equal(nodes(tree).some(node=>node.props.variant==='danger'),false);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='编辑').props.onClick();tree=f.renderSettings();
  const inputs=nodes(tree).filter(node=>node.type==='input');inputs[0].props.onChange({target:{value:'Unsaved provider name'}});
  nodes(tree).find(node=>node.type==='dialog').props.onClose();tree=f.renderSettings();
  assert.equal(f.calls.length,0);assert.match(text(tree),/Saved provider/);assert.doesNotMatch(text(tree),/Unsaved provider name/);
  nodes(tree).find(node=>node.type==='button'&&text(node)==='编辑').props.onClick();tree=f.renderSettings();
  assert.equal(nodes(tree).find(node=>node.type==='input').props.value,'Saved provider');
  assert.equal(nodes(tree).find(node=>node.type==='input'&&node.props.type==='password').props.value,'');
  const form=nodes(tree).find(node=>node.type==='form');assert.equal(nodes(form).some(node=>node.props.variant==='danger'),false);
  const footer=nodes(tree).find(node=>node.type==='div'&&node.props.className?.startsWith('mt-5 flex'));
  assert.match(text(footer),/Deleting removes this provider connection/);
  const remove=nodes(footer).find(node=>node.type==='button');remove.props.onClick();await flushBackgroundAsync();assert.equal(f.calls.length,0);
  f.confirm();remove.props.onClick();await flushBackgroundAsync();tree=f.renderSettings();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.method,'DELETE');assert.equal(f.calls[0].options.body.expectedRevision,7);
  assert.equal(nodes(tree).some(node=>node.type==='dialog'),false);f.unmount();
});
test('provider deletion consequences cover the five UI languages',()=>{
  const values=['zh','zh-Hant','en','ja','ko'].map(gatewayDeleteConsequence);assert.equal(new Set(values).size,5);
  assert.equal(gatewayDeleteConsequence('unsupported'),gatewayDeleteConsequence('en'));
});
