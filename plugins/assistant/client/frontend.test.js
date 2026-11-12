import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { createBackgroundModuleHarness, createBackgroundScheduler, flushBackgroundAsync } from '../../../tests/fullscreenBackgroundHarness.js';

const t = (key, values = {}) => key.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? '');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes), ...nodes(tree.props?.action)] : [];
const text = tree => typeof tree === 'string' ? tree : (tree?.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
const ui = { t, useLocale: () => 'zh', SettingsSection: 'section', SettingsEditDialog: 'dialog', SettingsSkeleton: 'skeleton',
  SettingsActions: 'actions', SettingsButton: 'button', SettingsToggle: 'toggle', SettingsInput: 'input', SettingsTextarea: 'textarea',
  useSettingsReadOnly: () => false };
const flush = async () => { for (let i = 0; i < 6; i++) await flushBackgroundAsync(); };
function fixture() {
  let current = true;
  const notices = [], calls = [], actions = [];
  const host = { isCurrent: () => current, assertCurrent() { if (!current) throw new DOMException('Retired', 'AbortError'); },
    session: { get: () => current ? { authenticated: true, user: { accountId: 'one', role: 'admin' } } : null, expire: () => calls.push('expire') },
    notify: message => notices.push(message), player: { getSnapshot: () => ({ currentSong: null, queue: [] }), subscribe: () => () => {}, execute: action => actions.push(action) },
    request: async (...args) => { calls.push(args); return {}; }, requestResponse: async (...args) => { calls.push(args); return {}; } };
  return { host, notices, calls, actions, retire: () => { current = false; } };
}

test('assistant configuration preserves hidden provider fields and sends revision-checked scoped writes', async () => {
  const f = fixture();
  let data = { assistant: { name: 'Helper', avatar_icon: 'bot', welcome_message: 'Hi', description: 'Music', temperature: 0.7,
    provider: 'deepseek', model: 'legacy-model', persona: 'persona', system_rules: 'rules', revision: 5 },
    settings: { 'assistant.images_enabled': { value: false, revision: 2 } }, defaults: { assistant: { persona: 'default', system_rules: 'default' } } };
  f.host.request = async (path, options) => { f.calls.push([path, options]); return { ...options.body.patch, revision: 6 }; };
  const harness = createBackgroundModuleHarness({ file: new URL('./AssistantSettings.jsx', import.meta.url), modules: { '@flaretune/plugin-sdk': { ...ui,
    useSettingsResource: () => ({ data, setData: update => { data = update(data); }, refresh() {} }) } }, globals: {} });
  button(harness.render({ host: f.host }), '编辑').props.onClick();
  let tree = harness.render();
  nodes(tree).find(node => node.type === 'input' && node.props.maxLength === 80).props.onChange({ target: { value: 'Changed' } });
  tree = harness.render();
  await nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(f.calls[0][0], 'config'); assert.equal(f.calls[0][1].admin, true);
  assert.equal(f.calls[0][1].body.expectedRevision, 5); assert.equal(f.calls[0][1].body.patch.provider, 'deepseek');
  assert.equal(f.calls[0][1].body.patch.model, 'legacy-model'); assert.equal(data.assistant.name, 'Changed');
  assert.equal(f.notices.length, 1); harness.unmount();
});

test('unmounted configuration and memory mutations cannot toast or refresh after completion', async () => {
  for (const page of ['AssistantSettings', 'AssistantMemoryView']) {
    const f = fixture(), pending = deferred();
    const data = page === 'AssistantSettings' ? { assistant: { name: 'Helper' }, settings: { 'assistant.images_enabled': { value: false, revision: 2 } } }
      : { enabled: false, memories: [] };
    let changes = 0;
    f.host.request = (...args) => { f.calls.push(args); return pending.promise; };
    const harness = createBackgroundModuleHarness({ file: new URL(`./${page}.jsx`, import.meta.url), modules: { '@flaretune/plugin-sdk': { ...ui,
      useSettingsResource: () => ({ data, setData: () => { changes++; }, refresh() {} }) } }, globals: {} });
    const tree = harness.render({ host: f.host });
    const mutation = nodes(tree).find(node => node.type === 'toggle').props.onChange({ target: { checked: true } });
    harness.unmount();
    pending.resolve(page === 'AssistantSettings' ? { value: true, revision: 3 } : { enabled: true });
    await mutation; await flush();
    assert.deepEqual(f.notices, []); assert.equal(changes, 0); assert.equal(f.calls.length, 1);
  }
});

test('attachment decode finishing after unmount closes resources without upload or parent callbacks', async () => {
  const f = fixture(), decoded = deferred(), busy = [], changed = [];
  let closed = false, encoded = 0;
  const ref = { current: null };
  const harness = createBackgroundModuleHarness({ file: new URL('./AssistantAttachments.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { ...ui, decodeUserImage: () => decoded.promise, encodeUserImage: async () => { encoded++; return {}; },
      PrivateCoverImage: 'image', ImagePreviewDialog: 'preview' }, 'lucide-react': icons }, globals: {} });
  harness.render({ host: f.host, ref, session: f.host.session.get(), attachments: [], onBusy: value => busy.push(value), onChange: value => changed.push(value) });
  ref.current.addFiles([{ type: 'image/png' }]);
  harness.unmount();
  decoded.resolve({ close() { closed = true; } }); await flush();
  assert.equal(closed, true); assert.equal(encoded, 0); assert.deepEqual(f.calls, []); assert.deepEqual(changed, []); assert.deepEqual(busy, [true]);
});

test('attachments use the scoped binary endpoint and ignore a late upload response after retirement', async () => {
  for (const retire of [false, true]) {
    const f = fixture(), uploaded = deferred(), changed = [], busy = [];
    let closed = false;
    const ref = { current: null };
    f.host.requestResponse = async (...args) => { f.calls.push(args); return uploaded.promise; };
    const harness = createBackgroundModuleHarness({ file: new URL('./AssistantAttachments.jsx', import.meta.url), modules: {
      '@flaretune/plugin-sdk': { ...ui, decodeUserImage: async () => ({ close() { closed = true; } }), encodeUserImage: async () => 'encoded-bytes',
        PrivateCoverImage: 'image', ImagePreviewDialog: 'preview' }, 'lucide-react': icons }, globals: {} });
    harness.render({ host: f.host, ref, session: f.host.session.get(), attachments: [], onBusy: value => busy.push(value), onChange: value => changed.push(value) });
    ref.current.addFiles([{ type: 'image/png' }]); await flush();
    assert.equal(f.calls[0][0], 'images/upload/chat'); assert.equal(f.calls[0][1].rawBody, true);
    assert.equal(f.calls[0][1].contentType, 'image/webp');
    if (retire) f.retire();
    uploaded.resolve({ ok: true, json: async () => ({ id: 'image-one', url: '/image-one' }) }); await flush();
    assert.equal(closed, true);
    assert.equal(changed.length, retire ? 0 : 1);
    assert.deepEqual(busy, retire ? [true] : [true, false]);
    assert.equal(f.calls.length, 1, 'retirement does not start a new cleanup request through the old context');
    harness.unmount();
  }
});

test('assistant body preserves the draft between conversation and memory and aborts retired SSE without late player actions', async () => {
  const f = fixture(), scheduler = createBackgroundScheduler(), stream = deferred(), entered = deferred();
  let onEvent, signal;
  f.host.requestResponse = async (path, options) => {
    f.calls.push([path, options]);
    if (path === 'chat') { signal = options.signal; return { ok: true, body: {} }; }
    return { ok: true, json: async () => path === 'bootstrap' ? { assistant: { name: 'Helper' }, imageInput: { enabled: false } }
      : { thread: { revision: 0, messages: [] } } };
  };
  const harness = createBackgroundModuleHarness({ file: new URL('./AssistantView.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { ...ui, AiReviewConversation: 'conversation', AiReviewComposer: 'composer', ImagePreviewDialog: 'preview',
      createAiResponseTypewriter: ({ onDisplay }) => ({ append: onDisplay, reset() {}, cancel() {}, finish: async () => {} }),
      reconcileAiResponseContent: () => ({ reset: false, append: '' }),
      consumeSseJsonStream: async (_body, options) => { onEvent = options.onEvent; entered.resolve(); await stream.promise; },
      appendThoughtProcessEntry: values => values, appendToolProcessEntry: values => values, finishToolProcessEntry: values => values },
    '@flaretune/plugin-sdk/pure': { t }, 'lucide-react': icons, './AssistantMemoryView.jsx': 'memory', './AssistantAttachments.jsx': 'attachments', './AssistantConversation.jsx': { default: 'conversation' }, './Composer.jsx': { AiReviewComposer: 'composer' }, './localPlayer.js': { dispatchLocalAssistantPlayerAction: (_action) => {} } },
    globals: { ...scheduler, window: { ...scheduler, confirm: () => true }, AbortController, crypto, Intl, setTimeout, clearTimeout } });
  harness.render({ host: f.host, section: 'conversation' }); await flush();
  let tree = harness.render();
  nodes(tree).find(node => node.type === 'composer').props.onInputChange('draft');
  tree = harness.render({ host: f.host, section: 'memory' });
  assert.equal(nodes(tree).find(node => node.type === 'composer').props.inputText, 'draft');
  tree = harness.render({ host: f.host, section: 'conversation' });
  nodes(tree).find(node => node.type === 'composer').props.onSubmit({ preventDefault() {} });
  await entered.promise;
  f.retire(); harness.unmount();
  assert.equal(signal.aborted, true);
  await onEvent({ type: 'player_action', id: 'late', action: { type: 'control', action: 'play' } });
  await onEvent({ type: 'content_delta', content: 'late text' });
  stream.resolve(); await flush();
  assert.deepEqual(f.actions, []); assert.deepEqual(f.notices, []);
  assert.equal(f.calls.filter(([path]) => path === 'thread').length, 1, 'retired SSE does not restart history polling');
});

function historyHarness(f) {
  const scheduler=createBackgroundScheduler();
  return createBackgroundModuleHarness({file:new URL('./AssistantView.jsx',import.meta.url),modules:{
    '@flaretune/plugin-sdk':{...ui,ImagePreviewDialog:'preview'},'@flaretune/plugin-sdk/pure':{t},'lucide-react':icons,
    './AssistantMemoryView.jsx':'memory','./AssistantAttachments.jsx':'attachments',
    './AssistantConversation.jsx':'conversation','./Composer.jsx':{AiReviewComposer:'composer'},
    './localPlayer.js':{dispatchLocalAssistantPlayerAction(){}}},
    globals:{...scheduler,window:{...scheduler},AbortController,crypto,Intl}});
}
test('failed assistant history stays visible and retries locally without changing the input draft', async()=>{
  const f=fixture();let threadReads=0;
  f.host.requestResponse=async path=>{
    if(path==='thread'&&++threadReads===1)throw new Error('offline');
    return{ok:true,json:async()=>path==='bootstrap'?{assistant:{name:'Helper'}}:{thread:{revision:1,messages:[{id:'saved',role:'assistant',content:'Saved reply'}]}}};
  };
  const h=historyHarness(f);h.render({host:f.host});await flush();let tree=h.render();
  let conversation=nodes(tree).find(n=>n.type==='conversation'),composer=nodes(tree).find(n=>n.type==='composer');
  assert.equal(conversation.props.phase,'failed');assert.equal(conversation.props.loadError,'对话历史暂时无法载入，请重试。');
  assert.equal(composer.props.phase,'failed');assert.deepEqual(f.notices,[],'persistent error does not depend on a toast');
  composer.props.onInputChange('retained draft');await flush();tree=h.render();
  assert.equal(nodes(tree).find(n=>n.type==='conversation').props.loadError,'对话历史暂时无法载入，请重试。');
  nodes(tree).find(n=>n.type==='conversation').props.onRetryLoad();tree=h.render();
  assert.equal(nodes(tree).find(n=>n.type==='conversation').props.phase,'skeleton');
  await flush();tree=h.render();conversation=nodes(tree).find(n=>n.type==='conversation');composer=nodes(tree).find(n=>n.type==='composer');
  assert.equal(threadReads,2);assert.equal(conversation.props.phase,'ready');assert.equal(conversation.props.loadError,'');
  assert.equal(conversation.props.messages[0].content,'Saved reply');assert.equal(composer.props.inputText,'retained draft');h.unmount();
});
