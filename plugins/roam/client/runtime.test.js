import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';

// Execute the real runtime, controller, state, page and radio. Only public host
// capabilities are supplied by the fixture; React owns the page hook lifecycle.
function fixture() {
  const modules = new Map();
  const sdk = { t: (key, values = {}) => String(key).replace(/\{([^}]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match), useLocale: () => 'zh', getLocale: () => 'zh' };
  function load(file) {
    if (modules.has(file.href)) return modules.get(file.href).exports;
    const module = { exports: {} }; modules.set(file.href, module);
    const code = transformSync(readFileSync(file, 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
    vm.runInNewContext(code, { module, exports: module.exports, console, AbortController, setTimeout, clearTimeout, queueMicrotask,
      require(id) {
        if (id === 'react') return React;
        if (id === 'lucide-react') return icons;
        if (['@flaretune/plugin-sdk', '@flaretune/plugin-sdk/client/i18n'].includes(id)) return sdk;
        if (id.startsWith('.')) { const url = new URL(id, file); return load(existsSync(url) ? url : new URL(id + '.js', file)); }
        throw new Error('Unexpected runtime dependency: ' + id);
      },
    }, { filename: file.href });
    return module.exports;
  }
  const runtime = load(new URL('./runtime.js', import.meta.url));
  const state = load(new URL('./state.js', import.meta.url));
  const slots = new Map(), listeners = new Set();
  let continuation = null;
  const snapshot = { queue: [{ id: 'song', audio_url: '/media/song.mp3' }], currentSong: { id: 'song' }, isPlaying: true, playMode: 'sequence', revision: 1, ready: true };
  const host = {
    isCurrent: () => true,
    signal: new AbortController().signal,
    session: { get: () => ({ user: { accountId: 'radio-test' } }) },
    notify() {},
    request() { throw new Error('Disabled radio must not request songs'); },
    catalog: new Proxy({}, { get(_target, name) { throw new Error('Radio must not read host catalog: ' + String(name)); } }),
    queue: { getSnapshot: () => snapshot, getLegacyPreferences: () => ({ language: 'ja', batchSize: 15, enabled: true }),
      subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
      registerContinuation(value) { continuation = value; return () => { continuation = null; }; },
    },
    contributions: { register(slot, definition) {
      const entry = { definition }; slots.set(slot, entry);
      return () => { if (slots.get(slot) === entry) slots.delete(slot); };
    } },
  };
  return { runtime, state, host, slots, listeners, get continuation() { return continuation; } };
}

test('runtime mounts a stable browse header and existing queue footer, then removes both on retirement', () => {
  const f = fixture();
  const cleanup = f.runtime.startRoamRuntime(f.host);
  try {
    assert.deepEqual([...f.slots.keys()].sort(), ['browse-header', 'queue-controls']);
    const headerSource = f.slots.get('browse-header').definition;
    const Header = headerSource.getSnapshot().renderers.header;
    assert.equal(typeof Header, 'function');
    // A host can obtain the component element without directly invoking the
    // hook-bearing RoamPluginPage function.
    const element = Header();
    assert.ok(React.isValidElement(element));
    assert.equal(element.props.host, f.host);
    assert.equal(typeof element.type, 'function');
    assert.equal(headerSource.getSnapshot().renderers.header, Header);
    const html = renderToStaticMarkup(React.createElement(Header));
    assert.match(html, /私人电台/);
    assert.match(html, /roam-radio__panel/);
    assert.match(html, /from-\[#0c4a6e\]/);
    assert.match(html, /aria-label="开启漫游电台"/);
    assert.doesNotMatch(html, /roam-explore-grid|roam-explore-title|曲库探索|\/categories\//);
    const queue = f.slots.get('queue-controls').definition;
    assert.equal(typeof queue.getSnapshot().renderers.footer, 'function');
    assert.equal(typeof queue.actions.toggleFromQueue, 'function');
    assert.equal(typeof queue.actions.appendFromQueue, 'function');
    assert.equal(f.state.getRoamState().enabled, false);
    assert.equal(f.state.getRoamState().language, 'ja');
    assert.equal(f.state.getRoamState().batchSize, 15);
    assert.ok(f.continuation);
    assert.equal(f.listeners.size, 1);
  } finally { cleanup(); }
  assert.equal(f.slots.size, 0);
  assert.equal(f.continuation, null);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.state.getRoamState().available, false);
});

test('browse header observes radio preferences through its real state hook without changing component identity', () => {
  const f = fixture(), cleanup = f.runtime.startRoamRuntime(f.host);
  try {
    const definition = f.slots.get('browse-header').definition;
    const Header = definition.getSnapshot().renderers.header;
    const queue = f.slots.get('queue-controls').definition;
    assert.equal(queue.actions.setRandomRoamBatchSize(20), true);
    assert.equal(queue.actions.setRandomRoamLanguage('zh'), true);
    assert.equal(f.state.getRoamState().batchSize, 20);
    assert.equal(f.state.getRoamState().language, 'zh');
    assert.equal(definition.getSnapshot().renderers.header, Header);
    const html = renderToStaticMarkup(React.createElement(Header));
    assert.match(html, /aria-pressed="true"[^>]*>20<\/button>/);
    assert.equal((html.match(/id="roam-console-title"/g) || []).length, 1);
    assert.doesNotMatch(html, /roam-explore-grid|曲库探索/);
  } finally { cleanup(); }
});

test('roam 0.1.1 keeps its service page while host navigation owns the primary entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, '0.1.1');
  assert.ok(manifest.pages.some(page => page.id === 'browse' && page.kind === 'service'));
  assert.equal(manifest.entries.some(entry => entry.slot === 'sidebar.primary'), false);
  assert.equal(manifest.hostApiVersion, 2);
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.dataVersion, 0);
});
