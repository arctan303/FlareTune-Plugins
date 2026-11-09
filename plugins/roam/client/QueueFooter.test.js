import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
function fixture() {
  const state = { available: true, enabled: false, status: 'idle' }, calls = [];
  const view = createBackgroundModuleHarness({ file: new URL('./QueueFooter.jsx', import.meta.url), modules: {
    '@flaretune/plugin-sdk': { t: value => value, useLocale: () => 'zh' }, 'lucide-react': {},
    './state.js': { useRoamState: () => state },
  }, globals: {} });
  return { view, state, calls, props: { authenticated: true, actions: { toggleFromQueue: () => calls.push('toggle'), retryRandomRoam: () => calls.push('retry') } } };
}
test('queue renderer delegates the switch and retry to supplied scoped actions', () => {
  const f = fixture(); let tree = f.view.render(f.props);
  nodes(tree).find(node => node.props.role === 'switch').props.onClick(); assert.deepEqual(f.calls, ['toggle']);
  f.state.enabled = true; f.state.status = 'error'; tree = f.view.render();
  nodes(tree).find(node => node.props.title === '重试续播').props.onClick(); assert.deepEqual(f.calls, ['toggle', 'retry']);
  f.view.unmount();
});
test('retired queue renderer exposes no controls', () => {
  const f = fixture(); f.state.available = false; assert.equal(f.view.render(f.props), null); f.view.unmount();
});
