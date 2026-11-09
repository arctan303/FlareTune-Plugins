import test from 'node:test';
import assert from 'node:assert/strict';
import * as icons from 'lucide-react';
import { createBackgroundModuleHarness } from '../../../tests/fullscreenBackgroundHarness.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.props?.children || []).flat(Infinity).flatMap(nodes)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.props?.children || []).flat(Infinity).map(text).join('');
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label);
function fixture() {
  const changes = [], navigations = [], notices = [];
  let toggles = 0, retries = 0;
  const harness = createBackgroundModuleHarness({ file: new URL('./RoamOverview.jsx', import.meta.url),
    modules: { '@flaretune/plugin-sdk': { t: key => key, useLocale: () => 'zh', getLocale: () => 'zh' }, 'lucide-react': icons }, globals: {} });
  const props = { randomRoam: { available: true, enabled: false, language: 'all', batchSize: 10, status: 'idle' },
    items: [{ key: 'zh', label: '中文歌曲', gradient: '' }],
    onToggleRoam: () => { toggles++; }, onRetry: () => { retries++; },
    setRandomRoamLanguage: value => { changes.push(['language', value]); return true; },
    setRandomRoamBatchSize: value => { changes.push(['batch', value]); return true; },
    onOpenLanguage: item => navigations.push(item.key), showToast: message => notices.push(message) };
  return { harness, props, changes, navigations, notices, get toggles() { return toggles; }, get retries() { return retries; } };
}

test('roam plugin view emits controlled preferences and navigation without owning host stores', () => {
  const view = fixture(), tree = view.harness.render(view.props);
  assert.equal(tree.props.className, 'roam-page pb-16');
  assert.equal(nodes(tree).some(node => node.type === 'h1' || node.type === 'header'), false);
  assert.ok(nodes(tree).some(node => node.type === 'h2' && text(node) === '私人电台'));
  button(tree, '开启').props.onClick(); assert.equal(view.toggles, 1);
  button(tree, '中文').props.onClick();
  button(tree, '20').props.onClick();
  assert.deepEqual(view.changes, [['language', 'en,ja,ko,instrumental,other'], ['batch', 20]]);
  button(tree, '中文歌曲').props.onClick(); assert.deepEqual(view.navigations, ['zh']);
  assert.equal(view.notices.length, 2);
});

test('rejected preference actions never announce successful changes', () => {
  const view = fixture();
  view.props.setRandomRoamLanguage = value => { view.changes.push(['language', value]); return false; };
  view.props.setRandomRoamBatchSize = value => { view.changes.push(['batch', value]); return false; };
  let tree = view.harness.render(view.props);
  button(tree, '中文').props.onClick();
  button(tree, '仅中文').props.onClick();
  button(tree, '20').props.onClick();
  view.props.randomRoam = { ...view.props.randomRoam, language: 'zh' };
  tree = view.harness.render(view.props);
  button(tree, '全选').props.onClick();
  assert.deepEqual(view.changes, [['language', 'en,ja,ko,instrumental,other'], ['language', 'zh'], ['batch', 20], ['language', 'all']]);
  assert.deepEqual(view.notices, []);
});

test('accepted language and batch actions use the latest toast callback', () => {
  for (const [language, label] of [['all', '中文'], ['all', '仅中文'], ['zh', '全选'], ['all', '20']]) {
    const view = fixture(), latestNotices = [];
    view.props.randomRoam = { ...view.props.randomRoam, language };
    view.harness.render(view.props);
    view.props.showToast = message => latestNotices.push(message);
    const tree = view.harness.render(view.props);
    button(tree, label).props.onClick();
    assert.equal(latestNotices.length, 1, label);
    assert.deepEqual(view.notices, [], label);
  }
});

test('roam plugin view exposes retry and disables all controls when retired', () => {
  const view = fixture(); view.props.randomRoam = { ...view.props.randomRoam, status: 'error', error: '续播加载失败，请重试' };
  let tree = view.harness.render(view.props);
  assert.ok(nodes(tree).some(node => node.props?.role === 'alert'));
  button(tree, '重试').props.onClick(); assert.equal(view.retries, 1);
  view.props.randomRoam = { ...view.props.randomRoam, available: false };
  tree = view.harness.render(view.props);
  assert.ok(nodes(tree).filter(node => node.type === 'button').every(node => node.props.disabled));
});
