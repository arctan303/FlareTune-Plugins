import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { hookComponent, deferred, flushAsync, nodes, text, button } from '../../../tests/lyricCandidateHarness.js';
import * as state from './candidates.js';

const song = { id: 's1', title: 'Night Song', artist: 'Singer' };
const candidate = (index, source = 'custom_krc') => ({ source, providerLyricId: `${source}-${index}`,
  matchedTitle: song.title, matchedArtist: song.artist, score: 200 - index, durationDelta: 0 });
const ready = (item, mode = 'line', translated = false) => ({ ...item, state: 'ready', syncMode: mode,
  translationAvailable: translated, lyrics: { lines: [{ time: 1, text: 'Hello' }] } });
const translate = (value, values) => value.replace(/\{(\w+)\}/g, (_, key) => String(values?.[key] ?? `{${key}}`));
function setup(api, songValue = song, translator = translate, globals = {}) {
  const imports = [];
  const component = hookComponent({ file: fileURLToPath(new URL('./LyricsCandidatePanel.jsx', import.meta.url)),
    modules: { 'lucide-react': { Loader2: 'Loader2', Search: 'Search' },
      '@flaretune/plugin-sdk': { t: translator, SelectControl: 'SelectControl' },
      '../services/localLyricsWorkspaceApi.js': { lyricsWorkspaceApi: { getSources: async () => ({data:{sources:['custom_krc','custom_lrc','lrclib']}}), ...api } },
      './candidates.js': state }, globals: { AbortController, setInterval, clearInterval, ...globals } });
  const props = { api: { getSources: async () => ({data:{sources:['custom_krc','custom_lrc','lrclib']}}), ...api }, song: songValue, authenticated: true, isAdmin: true, saving: false, active: true,
    Preview: 'Preview', onImport: inspection => imports.push(inspection) };
  return { component, props, imports, render: () => component.render(props) };
}
const cards = tree => nodes(tree).filter(node => node.type === 'button' && node.props.className?.startsWith('lyric-studio__candidate'));
const filter = (tree, label, value) => nodes(tree).find(node => node.type === 'SelectControl' && node.props['aria-label'] === label)
  .props.onChange({ target: { value } });
function retryClock() {
  let now = 1_000_000;
  const callbacks = new Set();
  return { callbacks, globals: { Date: { now: () => now },
    setInterval: callback => { callbacks.add(callback); return callback; },
    clearInterval: callback => callbacks.delete(callback) },
  advance(ms) { now += ms; for (const callback of [...callbacks]) callback(); } };
}
async function settle(subject) { subject.render(); await flushAsync(); subject.render(); await flushAsync(); return subject.render(); }
async function search(subject) {
  nodes(subject.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  return settle(subject);
}

test('configured source names distinguish same-protocol candidates and filters without translating user names', async () => {
  const id='lyric_'+'1'.repeat(32), name='My account lyrics';
  const s=setup({getSources:async()=>({data:{sources:[id],details:[{id,name}]}}),
    getLyricsCandidates:async()=>({data:{candidates:[candidate(1,id)]}}),
    inspectLyricsCandidates:async(_,items)=>({data:{results:items.map(item=>ready(item))}})});
  const tree=await search(s);
  assert.ok(text(cards(tree)[0]).includes(name));
  const select=nodes(tree).find(node=>node.type==='SelectControl'&&node.props['aria-label']==='歌词来源');
  assert.ok(text(select).includes(name));
  s.component.unmount();
});

test('source warnings localize default names and reasons while preserving a named source', async () => {
  const id = 'lyric_' + '2'.repeat(32), customName = '自定义逐字源';
  const dictionary = { '自定义逐字源': 'Custom word source', '自定义逐行源': 'Custom line source',
    '请求超时': 'Request timed out', '网络异常': 'Network error', '{source}：{reason}': '{source}: {reason}' };
  const translator = (key, values) => translate(dictionary[key] || key, values);
  const s = setup({ getSources: async () => ({ data: { sources: ['custom_lrc', id],
    details: [{ id: 'custom_lrc', name: '自定义逐行源' }, { id, name: customName }] } }),
    getLyricsCandidates: async () => ({ data: { candidates: [], warnings: [
      { source: 'custom_lrc', code: 'timeout' }, { source: id, code: 'network' },
      { source: 'custom_lrc', code: 'timeout' },
    ] } }) }, song, translator);
  const tree = await search(s);
  const warning = nodes(tree).find(node => node.props.className === 'lyric-studio__warning');
  const messages = nodes(warning).filter(node => node.type === 'span').map(text);
  assert.deepEqual(messages, ['Custom line source: Request timed out', '自定义逐字源: Network error']);
  const select = nodes(tree).find(node => node.type === 'SelectControl' && node.props['aria-label'] === '歌词来源');
  assert.equal(text(select).includes('Custom line source'), true);
  assert.equal(text(select).includes(customName), true, 'user names stay unchanged even when they resemble a system label');
  s.component.unmount();
});

test('candidate search displays localized server errors', async () => {
  const s = setup({ getLyricsCandidates: async () => { throw Error('查找歌词失败'); } }, song,
    key => key === '查找歌词失败' ? 'Could not find lyrics' : key);
  const tree = await search(s);
  assert.equal(text(nodes(tree).find(node => node.props.role === 'alert')), 'Could not find lyrics');
  s.component.unmount();
});

test('all candidate summaries remain reachable while default inspection reads only four nearby bodies', async () => {
  const all = [...Array.from({ length: 12 }, (_, i) => candidate(i)), candidate(13, 'custom_lrc')];
  const inspections = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: all } }),
    inspectLyricsCandidates: async (_, items) => { inspections.push(items); return { data: { results: items.map(item => ready(item)) } }; } });
  const tree = await search(s);
  assert.equal(cards(tree).length, 13);
  assert.ok(text(cards(tree).at(-1)).includes('自定义逐行源'));
  assert.deepEqual(inspections.map(items => items.length), [4]);
  s.component.unmount();
});

test('unsubmitted field edits do not change an in-flight inspection query or discard its response', async () => {
  const pending = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items, options) => { calls.push({ items, options }); return pending.promise; } });
  let tree = await search(s);
  nodes(tree).filter(node => node.type === 'input')[1].props.onChange({ target: { value: 'unsubmitted artist' } });
  s.render();
  pending.resolve({ data: { results: [ready(candidate(1))] } });
  tree = await settle(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.artist, song.artist);
  assert.equal(calls[0].options.signal.aborted, false);
  assert.ok(text(tree).includes('逐行'));
  button(tree, '导入当前歌词草稿').props.onClick();
  assert.equal(s.imports.length, 1);
  assert.equal(s.imports[0].state, 'ready');
  s.component.unmount();
});

test('source selection restarts actual search using the submitted query and ignores an older response', async () => {
  const pending = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async (_, options) => {
    calls.push(options); return calls.length === 1 ? pending.promise : { data: { candidates: [candidate(1, 'custom_lrc')] } };
  }, inspectLyricsCandidates: async (_, items) => ({ data: { results: items.map(item => ready(item)) } }) });
  let tree = await search(s);
  nodes(tree).filter(node => node.type === 'input')[0].props.onChange({ target: { value: 'unsubmitted title' } });
  tree = s.render(); filter(tree, '歌词来源', 'custom_lrc'); tree = await settle(s);
  pending.resolve({ data: { candidates: [candidate(2)] } }); tree = await settle(s);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1].title, song.title);
  assert.equal(calls[1].source, 'custom_lrc');
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('自定义逐行源'));
  s.component.unmount();
});

test('type filtering distinguishes unknown results and checks bounded batches only when continued', async () => {
  const all = Array.from({ length: 13 }, (_, i) => candidate(i)); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: all } }),
    inspectLyricsCandidates: async (_, items) => {
      calls.push(items); return { data: { results: items.map(item => ready(item, item.providerLyricId === 'custom_krc-12' ? 'word' : 'line')) } };
    } });
  let tree = await search(s);
  filter(tree, '同步类型', 'word'); tree = await settle(s);
  assert.deepEqual(calls.map(items => items.length), [4, 4]);
  assert.equal(cards(tree).length, 0);
  assert.ok(text(tree).includes('尚无已确认的匹配'));
  assert.ok(text(tree).includes('还有 5 份候选未检查'));
  button(tree, '继续检查').props.onClick(); tree = await settle(s);
  button(tree, '继续检查').props.onClick(); tree = await settle(s);
  assert.deepEqual(calls.map(items => items.length), [4, 4, 4, 1]);
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('逐字'));
  assert.equal(text(tree).includes('继续检查'), false);
  s.component.unmount();
});

test('a failed preview can be explicitly retried and errors are not treated as absent lyrics', async () => {
  let attempts = 0;
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items) => {
      attempts += 1; if (attempts === 1) throw Error('temporary');
      return { data: { results: items.map(item => ready(item, 'word')) } };
    } });
  let tree = await search(s);
  assert.ok(text(tree).includes('候选预览失败。'));
  button(tree, '重试预览').props.onClick(); tree = await settle(s);
  assert.equal(attempts, 2);
  assert.ok(text(tree).includes('逐字'));
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  s.component.unmount();
});

test('custom candidates display, select, and inspect before higher-scored LRCLIB results', async () => {
  const custom = Array.from({ length: 5 }, (_, i) => candidate(i));
  const lrclib = { ...candidate(1, 'lrclib'), score: 1000 };
  const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [lrclib, ...custom] } }),
    inspectLyricsCandidates: async (_, items) => {
      calls.push(items); return { data: { results: items.map(item => ready(item)) } };
    } });
  let tree = await search(s);
  assert.ok(text(cards(tree)[0]).includes('自定义逐字源'));
  assert.ok(text(cards(tree).at(-1)).includes('LRCLIB'));
  assert.deepEqual(calls[0].map(item => item.source), Array(4).fill('custom_krc'));
  button(tree, '导入当前歌词草稿').props.onClick();
  assert.equal(s.imports[0].source, 'custom_krc');
  cards(tree).at(-1).props.onClick(); tree = await settle(s);
  assert.equal(calls.at(-1)[0].source, 'lrclib');
  button(tree, '导入当前歌词草稿').props.onClick();
  assert.equal(s.imports.at(-1).source, 'lrclib');
  s.component.unmount();
});

test('preview explains a safe upstream search error in the selected language and permits retry', async () => {
  let attempts = 0;
  const dictionary = { '候选预览失败。': 'Candidate preview failed.', '搜索': 'Search',
    '上游异常': 'Upstream error', '{source}：{reason}': '{source}: {reason}' };
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1, 'lrclib')] } }),
    inspectLyricsCandidates: async (_, items) => ({ data: { results: ++attempts === 1
      ? items.map(item => ({ ...item, state: 'error', error: { code: 'search_upstream', message: 'private upstream URL' } }))
      : items.map(item => ready(item)) } }) }, song, (key, values) => translate(dictionary[key] || key, values));
  let tree = await search(s);
  assert.ok(text(tree).includes('Candidate preview failed. Search: Upstream error'));
  assert.equal(text(tree).includes('private upstream URL'), false);
  button(tree, '重试预览').props.onClick(); tree = await settle(s);
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  assert.equal(text(tree).includes('Upstream error'), false);
  assert.equal(state.projectCandidateInspectionError({ code: 'search_private_host' }), null);
  assert.equal(state.projectCandidateInspectionError({ code: 'search_toString' }), null);
  s.component.unmount();
});

test('switching songs unmounts and aborts old search without leaving the new song busy', async () => {
  const pending = deferred(); let signal;
  const old = setup({ getLyricsCandidates: async (_, options) => { signal = options.signal; return pending.promise; } });
  await search(old); old.component.unmount();
  const fresh = setup({ getLyricsCandidates: async () => ({ data: { candidates: [] } }) }, { ...song, id: 's2' });
  pending.resolve({ data: { candidates: [candidate(1)] } }); await flushAsync();
  assert.equal(signal.aborted, true);
  assert.equal(button(fresh.render(), '查找候选').props.disabled, false);
  assert.equal(cards(fresh.render()).length, 0);
  fresh.component.unmount();
});

test('filter changes cancel stale inspection results and keep the new filter progress authoritative', async () => {
  const first = deferred(); const calls = [];
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1)] } }),
    inspectLyricsCandidates: async (_, items, options) => {
      calls.push(options); return calls.length === 1 ? first.promise : { data: { results: items.map(item => ready(item, 'word', true)) } };
    } });
  let tree = await search(s); filter(tree, '译文', 'yes'); tree = await settle(s);
  first.resolve({ data: { results: [ready(candidate(1), 'line', false)] } }); tree = await settle(s);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(cards(tree).length, 1);
  assert.ok(text(cards(tree)[0]).includes('有翻译'));
  s.component.unmount();
});

test('match reliability and metadata outrank precision; unknown candidates remain discoverable', () => {
  const exact = { ...candidate(1), providerLyricId: 'exact', score: 170 };
  const wrong = { ...candidate(2), providerLyricId: 'wrong', score: 180, versionMismatch: true };
  const short = { ...candidate(3), providerLyricId: 'short', score: 190, durationDelta: 60 };
  const unknown = { ...candidate(4), providerLyricId: 'unknown', score: 175 };
  const inspections = { 'custom_krc:exact': ready(exact), 'custom_krc:wrong': ready(wrong, 'word'), 'custom_krc:short': ready(short, 'word') };
  assert.deepEqual(state.sortLyricsCandidates([wrong, short, exact, unknown], inspections).map(item => item.providerLyricId), ['unknown', 'exact', 'short', 'wrong']);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'word', 'no'), [wrong]);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'line', 'no'), [exact]);
  assert.deepEqual(state.filterLyricsCandidates([exact, wrong, unknown], inspections, 'all', 'yes'), []);
});

test('source cooldown enables an explicit retry without automatic requests or losing other previews', async () => {
  const time = retryClock(), pending = deferred(), queries = [], reads = [];
  const s = setup({ getLyricsCandidates: async (_, query) => {
    queries.push(query);
    return queries.length > 1 ? pending.promise : { data: { candidates: [candidate(1)], warnings: [
      { source: 'lrclib', code: 'rate_limited', retryAfterSeconds: 2 },
      { source: 'custom_lrc', code: 'network' },
    ] } };
  }, inspectLyricsCandidates: async (_, items) => {
    reads.push(items); return { data: { results: items.map(item => ready(item)) } };
  } }, song, translate, time.globals);
  let tree = await search(s);
  const retry = () => nodes(tree).find(node => node.props['aria-label'] === '重试 LRCLIB');
  assert.equal(text(retry()), '2 秒后可重试');
  assert.equal(retry().props.disabled, true);
  retry().props.onClick(); await settle(s);
  assert.equal(queries.length, 1, 'handler also blocks an early retry');
  time.advance(2000); tree = await settle(s);
  assert.equal(queries.length, 1, 'cooldown expiry alone sends no request');
  assert.equal(retry().props.disabled, false);
  nodes(tree).filter(node => node.type === 'input')[0].props.onChange({ target: { value: 'unsubmitted edit' } });
  tree = s.render(); retry().props.onClick(); tree = await settle(s);
  assert.equal(queries[1].source, 'lrclib');
  assert.equal(queries[1].title, song.title);
  assert.equal(cards(tree).length, 1);
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  pending.resolve({ data: { candidates: [candidate(2, 'lrclib')], warnings: [] } });
  tree = await settle(s);
  assert.equal(cards(tree).length, 2);
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  assert.equal(reads.flat().filter(item => item.source === 'custom_krc').length, 1, 'existing custom preview is retained');
  assert.equal(text(tree).includes('网络异常'), true, 'another source warning is retained');
  assert.equal(text(tree).includes('上游暂时限制'), false);
  s.component.unmount();
  assert.equal(time.callbacks.size, 0);
});

test('a failed source retry preserves candidates and remains available for another explicit attempt', async () => {
  const time = retryClock(); let calls = 0;
  const s = setup({ getLyricsCandidates: async () => {
    if (++calls > 1) throw Error('查找歌词失败');
    return { data: { candidates: [candidate(1)], warnings: [{ source: 'lrclib', code: 'network' }] } };
  }, inspectLyricsCandidates: async (_, items) => ({ data: { results: items.map(item => ready(item)) } }) }, song, translate, time.globals);
  let tree = await search(s);
  nodes(tree).find(node => node.props['aria-label'] === '重试 LRCLIB').props.onClick();
  tree = await settle(s);
  assert.equal(calls, 2);
  assert.equal(cards(tree).length, 1);
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  assert.equal(text(tree).includes('查找歌词失败'), true);
  assert.equal(nodes(tree).find(node => node.props['aria-label'] === '重试 LRCLIB').props.disabled, false);
  s.component.unmount();
});

test('inspection rate limits explain the wait and prevent preview and batch retries until expiry', async () => {
  const time = retryClock(); let calls = 0;
  const s = setup({ getLyricsCandidates: async () => ({ data: { candidates: [candidate(1, 'lrclib')] } }),
    inspectLyricsCandidates: async (_, items) => ({ data: { results: ++calls === 1
      ? items.map(item => ({ ...item, state: 'error', error: { code: 'search_rate_limited', retryAfterSeconds: 3 } }))
      : items.map(item => ready(item)) } }) }, song, translate, time.globals);
  let tree = await search(s);
  assert.equal(text(tree).includes('上游暂时限制了请求，请稍后重试。'), true);
  assert.equal(button(tree, '3 秒后可重试').props.disabled, true);
  assert.equal(button(tree, '重试失败项').props.disabled, true);
  button(tree, '3 秒后可重试').props.onClick(); tree = await settle(s);
  assert.equal(calls, 1);
  time.advance(3000); tree = await settle(s);
  assert.equal(calls, 1);
  assert.equal(button(tree, '重试预览').props.disabled, false);
  button(tree, '重试预览').props.onClick(); tree = await settle(s);
  assert.equal(calls, 2);
  assert.equal(button(tree, '导入当前歌词草稿').props.disabled, false);
  s.component.unmount();
  assert.equal(time.callbacks.size, 0);
});

test('internal request budgets and upstream cooldowns have distinct safe explanations', () => {
  const warnings = state.projectProviderWarnings([
    { source: 'custom_krc', code: 'request_budget_exceeded', retryAfterSeconds: 99 },
    { source: 'lrclib', code: 'rate_limited', retryAfterSeconds: 2 },
  ], 1000);
  assert.ok(warnings[0].reason.includes('本次检索'));
  assert.equal(warnings[0].retryAt, undefined);
  assert.equal(warnings[1].retryAt, 3000);
  assert.ok(state.projectCandidateInspectionError({ code: 'search_request_budget_exceeded' }).reason.includes('本次检索'));
  assert.equal(state.lyricRetryAt({ code: 'rate_limited', retryAfterSeconds: -1 }, 1000), 31000);
  assert.equal(state.projectProviderWarnings(Array.from({ length: 9 }, (_, i) => ({ source: `source-${i}`, code: 'timeout' }))).length, 9);
});
