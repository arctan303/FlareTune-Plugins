// Local review-only hook/event harness. No browser, network or persistence.
// It proves component state transitions; use a real browser for DOM/focus/layout.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const flushAsync = () => new Promise(resolve => setImmediate(resolve));
export const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' && tree.props ? [tree, ...nodes(tree.props.children)] : [];
export const text = tree => Array.isArray(tree) ? tree.map(text).join('')
  : tree && typeof tree === 'object' && tree.props ? text(tree.props.children)
    : tree === false || tree === true || tree == null ? '' : String(tree);
export function button(tree, label) {
  const node = nodes(tree).find(item => item.type === 'button' && text(item) === label);
  if (!node) throw new Error(`Missing button: ${label}`);
  return node;
}

// modules may be a function(requireId) or an object keyed by exact import string.
// supply actual pure draft helpers and mock network/store/child-component imports.
export function hookComponent({ file, exportName = 'default', modules, globals = {} }) {
  const slots = [];
  let cursor = 0, effects = [], dirty = false, lastProps;
  const dependenciesChanged = (before, after) => !before || !after
    || after.length !== before.length || after.some((item, i) => !Object.is(item, before[i]));
  const effect = (fn, deps) => {
    const i = cursor++, previous = slots[i];
    if (dependenciesChanged(previous?.deps, deps)) effects.push(() => {
      previous?.cleanup?.();
      slots[i] = { kind: 'effect', deps, cleanup: fn() };
    });
  };
  const memo = (fn, deps) => {
    const i = cursor++, previous = slots[i];
    if (!previous || dependenciesChanged(previous.deps, deps)) slots[i] = { kind: 'memo', deps, value: fn() };
    return slots[i].value;
  };
  const react = {
    Fragment: 'review-fragment',
    createElement(type, props, ...children) {
      // Minimal refs allow effects to run. This is not a DOM emulation.
      if (props?.ref && typeof props.ref === 'object' && !props.ref.current) {
        props.ref.current = { open: false, isConnected: true,
          showModal() { this.open = true; }, close() { this.open = false; },
          focus() {}, querySelector() { return null; } };
      }
      return { type, props: { ...props, children } };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { kind: 'state', value: typeof init === 'function' ? init() : init };
      return [slots[i].value, next => {
        const value = typeof next === 'function' ? next(slots[i].value) : next;
        if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; }
      }];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { kind: 'ref', value: { current: init } };
      return slots[i].value;
    },
    useEffect: effect, useLayoutEffect: effect,
    useMemo: memo, useCallback: (fn, deps) => memo(() => fn, deps),
    useId: () => memo(() => `review-id-${cursor}`, []),
  };
  const localModule = { exports: {} };
  const requireMock = id => {
    if (id === 'react') return react;
    const value = typeof modules === 'function' ? modules(id) : modules?.[id];
    if (value == null) throw new Error(`Unmocked import: ${id}`);
    return value;
  };
  let source = readFileSync(file, 'utf8');
  if (exportName !== 'default') source += `\nexport { ${exportName} };`;
  const code = transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
  const opener = { isConnected: true, focus() {} };
  vm.runInNewContext(code, { module: localModule, exports: localModule.exports,
    require: requireMock, console, queueMicrotask, setTimeout, clearTimeout,
    document: { activeElement: opener }, ...globals }, { filename: file });
  const component = localModule.exports[exportName];
  if (typeof component !== 'function') throw new Error(`Missing component export: ${exportName}`);
  return {
    render(props = lastProps) {
      lastProps = props;
      for (let iteration = 0; iteration < 20; iteration++) {
        cursor = 0; effects = []; dirty = false;
        const tree = component(props);
        effects.forEach(run => run());
        if (!dirty) return tree;
      }
      throw new Error('Hook harness did not settle after 20 effect renders');
    },
    unmount() { slots.forEach(slot => { if (slot?.kind === 'effect') slot.cleanup?.(); }); },
  };
}
