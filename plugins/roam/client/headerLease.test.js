import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

function fixture() {
  const modules = new Map(), captures = [];
  const sdk = { t: key => key, useLocale: () => 'zh', getLocale: () => 'zh' };
  function RadioProbe(props) { captures.push(props); return React.createElement('div', { 'data-available': props.randomRoam.available }); }
  function load(file) {
    if (modules.has(file.href)) return modules.get(file.href).exports;
    const module = { exports: {} }; modules.set(file.href, module);
    vm.runInNewContext(transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code, {
      module, exports: module.exports, console, AbortController, setTimeout, clearTimeout, queueMicrotask,
      require(id) {
        if (id === 'react') return React;
        if (id === 'lucide-react') return icons;
        if (['@flaretune/plugin-sdk', '@flaretune/plugin-sdk/client/i18n'].includes(id)) return sdk;
        if (id === './RoamOverview.jsx') return RadioProbe;
        if (id.startsWith('.')) { const url = new URL(id, file); return load(existsSync(url) ? url : new URL(id + '.js', file)); }
        throw new Error('Unexpected test dependency: ' + id);
      },
    }, { filename: file.href });
    return module.exports;
  }
  const runtime = load(new URL('./runtime.js', import.meta.url));
  const state = load(new URL('./state.js', import.meta.url));
  const Page = load(new URL('./RoamPluginPage.jsx', import.meta.url)).default;
  const leases = load(new URL('./pageLease.js', import.meta.url));
  function host(account, role = 'member') {
    const abort = new AbortController(), slots = new Map(), listeners = new Set(), sessionListeners = new Set(), operations = [];
    let current = true, continuation = null;
    const snapshot = { queue: [{ id: 'song', audio_url: '/media/song.mp3' }], currentSong: { id: 'song' }, isPlaying: true, playMode: 'sequence', revision: 1, ready: true };
    return { pluginId: 'roam', version: '0.1.1', slots, listeners, operations, signal: abort.signal, isCurrent: () => current,
      session: { get: () => current ? { authenticated: true, user: { accountId: account, role } } : null,
        subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); } },
      expire(abortSignal = false) { current = false; for (const listener of [...sessionListeners]) listener(); if (abortSignal) abort.abort(); },
      notify(message) { operations.push(['notify', message]); },
      request() { throw new Error('No request should survive synchronous test cleanup'); },
      catalog: new Proxy({}, { get() { throw new Error('Radio cannot read host catalog'); } }),
      queue: { getSnapshot: () => snapshot, getLegacyPreferences: () => ({ language: 'ja', batchSize: 15 }),
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        registerContinuation(value) { continuation = value; return () => { if (continuation === value) continuation = null; }; },
        setSequence() { operations.push(['sequence']); }, trimAfterCurrent() { operations.push(['trim']); },
      },
      contributions: { register(slot, definition) { const entry = { definition }; slots.set(slot, entry); return () => { if (slots.get(slot) === entry) slots.delete(slot); }; } },
      get continuation() { return continuation; },
    };
  }
  const render = element => { renderToStaticMarkup(element); return captures.at(-1); };
  function header(value) {
    const Header = value.slots.get('browse-header').definition.getSnapshot().renderers.header;
    const element = Header();
    assert.ok(React.isValidElement(element));
    return { Header, element, lease: element.props.lease, props: render(React.createElement(Header)) };
  }
  return { runtime, state, Page, leases, host, render, header };
}
function rejected(props) {
  assert.equal(props.onToggleRoam(), false);
  assert.equal(props.setRandomRoamLanguage('zh'), false);
  assert.equal(props.setRandomRoamBatchSize(23), false);
  assert.equal(props.onRetry(), false);
}
function primeCurrent(host) {
  const actions = host.slots.get('queue-controls').definition.actions;
  assert.equal(actions.setRandomRoamLanguage('ko'), true);
  assert.equal(actions.setRandomRoamBatchSize(17), true);
  assert.equal(actions.setRandomRoamEnabled(true), true);
  assert.equal(actions.retryRandomRoam(), true);
  return actions;
}

for (const nextAccount of ['next-account', 'same-account']) test('retired real React header cannot read or change ' + nextAccount + ' runtime', () => {
  const f = fixture(), oldHost = f.host('same-account');
  const stopOld = f.runtime.startRoamRuntime(oldHost), old = f.header(oldHost);
  stopOld();
  const nextHost = f.host(nextAccount), stopNext = f.runtime.startRoamRuntime(nextHost);
  try {
    primeCurrent(nextHost);
    const before = f.state.getRoamState(), operations = nextHost.operations.length;
    rejected(old.props);
    assert.equal(f.state.getRoamState(), before);
    assert.equal(nextHost.operations.length, operations);
    assert.equal(old.lease.getSnapshot().available, false);
    assert.equal(old.lease.getSnapshot().language, 'all');
    assert.equal(old.lease.getSnapshot().batchSize, 10);
    const stale = f.render(React.createElement(old.Header));
    assert.equal(stale.randomRoam.available, false);
    assert.equal(stale.randomRoam.language, 'all');
    assert.notEqual(stale.randomRoam.batchSize, before.batchSize);
    rejected(stale);
    assert.equal(f.state.getRoamState(), before);
  } finally { stopNext(); stopOld(); }
});

test('host currentness loss rejects old actions and snapshots before runtime cleanup', () => {
  const f = fixture(), host = f.host('account'), stop = f.runtime.startRoamRuntime(host);
  try {
    const old = f.header(host), before = f.state.getRoamState();
    host.expire();
    rejected(old.props);
    assert.equal(old.lease.getSnapshot().available, false);
    assert.equal(f.render(React.createElement(old.Header)).randomRoam.available, false);
    assert.equal(f.state.getRoamState(), before);
    assert.equal(before.available, true);
  } finally { stop(); }
});

test('same-host replacement invalidates the old lease before its delayed cleanup', () => {
  const f = fixture(), host = f.host('account'), stopOld = f.runtime.startRoamRuntime(host);
  const old = f.header(host), oldQueue = host.slots.get('queue-controls').definition.actions;
  const stopNext = f.runtime.startRoamRuntime(host);
  try {
    primeCurrent(host);
    const before = f.state.getRoamState();
    rejected(old.props);
    assert.equal(oldQueue.toggleFromQueue(), false);
    assert.equal(oldQueue.appendFromQueue(), false);
    assert.equal(oldQueue.toggleFromCatalog({ songs: [] }), false);
    assert.equal(f.state.getRoamState(), before);
    assert.equal(old.lease.getSnapshot().available, false);
    stopOld();
    assert.ok(host.slots.has('browse-header'));
    assert.ok(host.slots.has('queue-controls'));
    assert.ok(host.continuation);
    assert.equal(host.slots.get('queue-controls').definition.actions.setRandomRoamBatchSize(19), true);
    assert.equal(f.header(host).props.randomRoam.batchSize, 19);
  } finally { stopNext(); stopOld(); }
});

test('independent Page uses a distinct valid facade, and its view lease expires independently', () => {
  const f = fixture(), runtimeHost = f.host('account'), stop = f.runtime.startRoamRuntime(runtimeHost), pageHost = f.host('account');
  assert.notEqual(pageHost, runtimeHost);
  try {
    const page = f.render(React.createElement(f.Page, { host: pageHost }));
    assert.equal(page.randomRoam.available, true);
    assert.equal(page.setRandomRoamBatchSize(23), true);
    assert.equal(f.state.getRoamState().batchSize, 23);
    pageHost.expire();
    rejected(page);
    assert.equal(f.render(React.createElement(f.Page, { host: pageHost })).randomRoam.available, false);
    assert.equal(runtimeHost.slots.get('queue-controls').definition.actions.setRandomRoamBatchSize(24), true);
  } finally { stop(); }
});

test('independent Page old callbacks do not follow a same-account restarted controller', () => {
  const f = fixture(), oldHost = f.host('account'), pageHost = f.host('account'), stopOld = f.runtime.startRoamRuntime(oldHost);
  const old = f.render(React.createElement(f.Page, { host: pageHost }));
  stopOld();
  const nextHost = f.host('account'), stopNext = f.runtime.startRoamRuntime(nextHost);
  try {
    const before = f.state.getRoamState();
    rejected(old);
    assert.equal(f.state.getRoamState(), before);
    const current = f.render(React.createElement(f.Page, { host: f.host('account') }));
    assert.equal(current.setRandomRoamBatchSize(21), true);
  } finally { stopNext(); stopOld(); }
});

test('unbound account and role pages get stable inactive snapshots, then matching late binding becomes usable', () => {
  const f = fixture(), owner = f.host('account'), stop = f.runtime.startRoamRuntime(owner);
  try {
    primeCurrent(owner);
    const before = f.state.getRoamState();
    for (const host of [f.host('other'), f.host('account', 'admin')]) {
      const page = f.render(React.createElement(f.Page, { host }));
      assert.equal(page.randomRoam.available, false);
      assert.equal(page.randomRoam.language, 'all');
      rejected(page);
    }
    assert.equal(f.state.getRoamState(), before);
    const waitingPageHost = f.host('late'), notices = [];
    assert.equal(f.render(React.createElement(f.Page, { host: waitingPageHost })).randomRoam.available, false);
    const unsubscribe = f.leases.subscribeRoamPageLeases(waitingPageHost, () => notices.push('changed'));
    const stopLate = f.runtime.startRoamRuntime(f.host('late'));
    try {
      assert.equal(notices.length, 1);
      const page = f.render(React.createElement(f.Page, { host: waitingPageHost }));
      assert.equal(page.randomRoam.available, true);
      assert.equal(page.setRandomRoamBatchSize(22), true);
    } finally { stopLate(); unsubscribe(); }
  } finally { stop(); }
});
