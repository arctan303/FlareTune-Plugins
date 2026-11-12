import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

const find = (tree, type) => tree && typeof tree === 'object'
  ? tree.type === type ? tree : (tree.props?.children || []).flat(Infinity).map(child => find(child, type)).find(Boolean) : null;

test('confirming an IME candidate does not send and a later ordinary Enter still sends', () => {
  let sent = 0, prevented = 0;
  const f = createBackgroundModuleHarness({ file: new URL('./Composer.jsx', import.meta.url), exportName: 'AiReviewComposer',
    modules: { '@flaretune/plugin-sdk/client/i18n': { t: key => key }, 'lucide-react': {} },
    globals: { window: { addEventListener() {}, removeEventListener() {} } } });
  const tree = f.render({ authenticated: true, phase: 'ready', inputText: '正在组词', textareaRef: { current: null },
    onKeyDown: event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sent++; } } });
  const textarea = find(tree, 'textarea');
  const enter = values => ({ key: 'Enter', preventDefault() { prevented++; }, ...values });
  textarea.props.onCompositionStart?.();
  textarea.props.onKeyDown(enter());
  textarea.props.onCompositionEnd?.();
  textarea.props.onKeyDown(enter({ nativeEvent: { keyCode: 229 } }));
  textarea.props.onKeyDown(enter({ nativeEvent: { isComposing: true } }));
  textarea.props.onKeyDown(enter({ isComposing: true }));
  assert.equal(sent, 0);
  assert.equal(prevented, 0, 'composition retains the browser input method default');
  textarea.props.onKeyDown(enter({ shiftKey: true }));
  assert.equal(sent, 0, 'Shift+Enter retains a line break');
  textarea.props.onKeyDown(enter());
  assert.equal(sent, 1);
  assert.equal(prevented, 1);
  f.unmount();
});
