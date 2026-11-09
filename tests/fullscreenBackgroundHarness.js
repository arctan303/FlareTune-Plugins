// Execute the real modules with deterministic hooks and browser resource fakes.
// These tests cover lifecycle/state; DOM painting and GPU behavior need a browser.
import { existsSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { Component } from 'react';

export const flushBackgroundAsync = () => new Promise(resolve => setImmediate(resolve));

export function createVisibilityDocument() {
  const listeners = new Map();
  return {
    visibilityState: 'visible',
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name) { for (const callback of [...(listeners.get(name) || [])]) callback(); },
    setVisible(visible) { this.visibilityState = visible ? 'visible' : 'hidden'; this.dispatch('visibilitychange'); },
  };
}

export function createBackgroundScheduler() {
  let sequence = 0;
  const frames = new Map(), timeouts = new Map(), intervals = new Map();
  return {
    frames, timeouts, intervals,
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay) { const id = ++sequence; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(callback, delay) { const id = ++sequence; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    frame(timestamp = 0) {
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(timestamp);
      }
    },
    expire(delay) {
      for (const [id, timer] of [...timeouts]) {
        if (timer.delay !== delay) continue;
        timeouts.delete(id);
        timer.callback();
      }
    },
    rotate() { for (const timer of [...intervals.values()]) void timer.callback(); },
  };
}

export function createBackgroundModuleHarness({ file, exportName = 'default', modules, globals, nodes = {}, render: renderModule }) {
  const slots = [];
  let cursor = 0, effects = [], dirty = false, lastProps;
  const changed = (previous, next) => !previous || !next
    || previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const effect = (callback, dependencies) => {
    const index = cursor++, previous = slots[index];
    if (changed(previous?.dependencies, dependencies)) effects.push(() => {
      previous?.cleanup?.();
      slots[index] = { kind: 'effect', dependencies, cleanup: callback() };
    });
  };
  const memo = (callback, dependencies) => {
    const index = cursor++, previous = slots[index];
    if (!previous || changed(previous.dependencies, dependencies)) {
      slots[index] = { value: callback(), dependencies };
    }
    return slots[index].value;
  };
  const React = {
    Component,
    createElement(type, props, ...children) {
      if (props?.ref && nodes[type]) props.ref.current = nodes[type];
      return { type, props: { ...props, children } };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useCallback: (callback, dependencies) => memo(() => callback, dependencies),
    useMemo: memo,
    forwardRef: render => Object.assign((props) => render(props, props?.ref || null), { render }),
    useImperativeHandle: (ref, create, dependencies) => effect(() => {
      if (ref) ref.current = create();
      return () => { if (ref) ref.current = null; };
    }, dependencies),
  };
  const loaded = new Map();
  const load = moduleFile => {
    if (loaded.has(String(moduleFile))) return loaded.get(String(moduleFile));
    const localModule = { exports: {} };
    loaded.set(String(moduleFile), localModule);
    const code = transformSync(readFileSync(moduleFile, 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
    vm.runInNewContext(code, {
      module: localModule,
      exports: localModule.exports,
      require(id) {
        if (id === 'react') return React;
        if (['@flaretune/plugin-sdk/pure','@flaretune/plugin-sdk/client/i18n'].includes(id) && !(id in modules)) return modules['@flaretune/plugin-sdk'] || {};
        if (id in modules) return modules[id];
        if (id.startsWith('.')) {
          const relative = new URL(id, moduleFile);
          const target = existsSync(relative) ? relative : new URL(`${id}.js`, moduleFile);
          return load(target).exports;
        }
        throw new Error(`Unmocked import: ${id}`);
      },
      console,
      ...globals,
    }, { filename: String(moduleFile) });
    return localModule;
  };
  const localModule = load(file);
  return {
    exports: localModule.exports,
    render(props = lastProps) {
      lastProps = props;
      for (let iteration = 0; iteration < 20; iteration++) {
        cursor = 0; effects = []; dirty = false;
        const result = renderModule ? renderModule(localModule.exports, props) : localModule.exports[exportName](props);
        effects.forEach(run => run());
        if (!dirty) return result;
      }
      throw new Error('Background hook did not settle');
    },
    unmount() { slots.forEach(slot => { if (slot.kind === 'effect') slot.cleanup?.(); }); },
  };
}

export function createArtistPhotoHarness() {
  const scheduler = createBackgroundScheduler();
  const document = createVisibilityDocument();
  const images = new Map(), requests = new Map();
  const fetches = new Map();
  class MockImage {
    set src(url) {
      images.set(url, this);
      requests.set(url, (requests.get(url) || 0) + 1);
    }
    decode() { return Promise.resolve(); }
  }
  const hook = createBackgroundModuleHarness({
    file: new URL('../hooks/useArtistPhotos.js', import.meta.url),
    exportName: 'useArtistPhotos',
    modules: {
      '../services/apiBase.js': { getApiBaseUrl: () => '' },
      '../services/authenticatedFetch.js': {
        authenticatedFetch: url => new Promise(resolve => { fetches.set(url, resolve); }),
      },
      '../store/useUIStore.js': { useUIStore: selector => selector({ authSession: { authenticated: true } }) },
    },
    globals: { Image: MockImage, document, ...scheduler },
  });
  return {
    ...hook, scheduler, images, requests, fetches, document,
    cache(artist, urls) { hook.exports.ARTIST_PHOTO_CACHE.set(artist, urls.map(url => ({ url }))); },
    async succeed(url) { await images.get(url).onload(); await flushBackgroundAsync(); },
    async fail(url) { images.get(url).onerror(); await flushBackgroundAsync(); },
    async answer(artist, urls) {
      fetches.get(`/api/artist-photo?name=${encodeURIComponent(artist)}`)({
        json: async () => ({ data: { photos: urls.map(url => ({ url })) } }),
      });
      await flushBackgroundAsync();
    },
  };
}

export function createAppleFluidHarness({ registry } = {}) {
  const scheduler = createBackgroundScheduler();
  const document = createVisibilityDocument();
  document.createElement = () => ({ getContext: () => ({ drawImage() {} }) });
  const images = new Map(), listeners = new Map(), uniforms = new Map();
  const draws = [];
  let rect = { width: 1000, height: 600 }, now = 0, uniformLookups = 0;
  let boundFramebuffer = null;
  const gl = new Proxy({
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    createShader: () => ({}), createProgram: () => ({}),
    createTexture: () => ({}), createBuffer: () => ({}),
    createFramebuffer: () => ({}),
    bindFramebuffer: (_target, fb) => { boundFramebuffer = fb; },
    getUniformLocation: (_program, name) => { uniformLookups++; return name; },
    uniform1f: (name, value) => uniforms.set(name, value),
    drawArrays: () => {
      if (boundFramebuffer === null) {
        draws.push(Object.fromEntries(uniforms));
      }
    },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const canvas = { width: 0, height: 0, getContext: () => gl, getBoundingClientRect: () => rect };
  class MockImage { set src(url) { images.set(url, this); } }
  const hook = createBackgroundModuleHarness({
    file: new URL('../components/fullscreen/AppleFluidCanvas.jsx', import.meta.url),
    nodes: { canvas },
    modules: {
      '../../utils/imageLoadRegistry.js': { imageLoadRegistry: registry || {
        isPrivateMediaUrl: () => false, shouldLoadPrivately: () => false,
      } },
      '../../hooks/usePrivateMediaRouteRevision.js': { usePrivateMediaRouteRevision: () => 0 },
      '../../utils/privateTextureAuthorization.js': { isTextureAuthorized: () => true },
    },
    globals: {
      ...scheduler,
      Image: MockImage,
      document,
      performance: { now: () => now },
      window: {
        devicePixelRatio: 1,
        addEventListener: (name, callback) => listeners.set(name, callback),
        removeEventListener: name => listeners.delete(name),
      },
    },
  });
  return {
    ...hook, scheduler, canvas, draws, images, document,
    get uniformLookups() { return uniformLookups; },
    frame(delta = 1000 / 60) { now += delta; scheduler.frame(now); },
    resize(width, height) { rect = { width, height }; listeners.get('resize')(); },
  };
}
