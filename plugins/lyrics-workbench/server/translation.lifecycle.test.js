import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { languageDecisionCapabilities } from './translation.fixture.js';

// Exercise the package's real completion implementation with bounded public
// capabilities. Authorization itself is verified in the host lease tests.
const capabilities = `
export const createLyricDocument = x => x;
export const isSingableLineText = x => /[\\p{L}\\p{N}]/u.test(x || '');
export const isLeadingProviderMetadata = () => false;
export const computeHash = async () => 'a'.repeat(64);
export const isNonLyricText = () => false;
export const analyzeLrcLanguage = () => ({});
export const normalizeLrcForHash = x => x;
export const parseLrcLines = () => [];
export const isValidSongLanguage = x => ['en','zh','ja','ko'].includes(x);
export const shouldAiCompleteLyrics = (_document, song, options = {}) => song.language !== (options.targetLanguage || 'zh');
export const lyricTextForHash = lines => lines.map(x => x.text).join('\\n');
export const projectLyricArtifact = (artifact, {targetLanguage}) => ({ translation: artifact.translation && artifact.translation.language === targetLanguage
  && !artifact.original.lines.every((line, i) => line.text === artifact.translation.lines[i]) ? artifact.translation : null });
export const isFreshLyricAiPending = x => x?.status === 'pending' && Date.now() - Date.parse(x.updatedAt) < 30000;
export const storeAuthorityGuard = Symbol('guard');
export const guardStoreAuthority = x => x;
export const createPluginServiceLease = () => {throw Error('Unexpected external lease')};
export const isPluginServiceLease = () => false;
export const createSubsonicPluginServiceLease = createPluginServiceLease;
export const createAiGatewayClient = createPluginServiceLease;
export const getAIAssistantConfig = createPluginServiceLease;
export const createInvocationDatabase = x => x;
export const invocationBudget = () => null;
` + languageDecisionCapabilities;
const bundle = await build({ entryPoints: [fileURLToPath(new URL('./translation.js', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'completion-capabilities', setup(api) {
    api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
    api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js' }));
  } }] });
const { beginLyricAssetAiCompletion, resolveLegacyLyricCleanup } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture({ language = 'en', text = 'Hello world', quota = true, ask = async () => JSON.stringify({ translations: [{ unitId: 0, text: 'こんにちは' }] }) } = {}) {
  let revision = 1;
  let artifact = { schemaVersion: 1, status: 'ready', songId: 'song-1', textHash: 'a'.repeat(64), offsetMs: 0,
    original: { source: 'lrclib', format: 'lrc', syncMode: 'line', lines: [{ time: 1, text }] },
    translation: { source: 'manual', originalTextHash: 'a'.repeat(64), language: 'zh', lines: ['你好'], updatedAt: '2026-01-01T00:00:00.000Z' },
    aiCompletion: null, provenance: {}, updatedAt: '2026-01-01T00:00:00.000Z' };
  const initialTranslation = structuredClone(artifact.translation);
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: `v${revision}` });
  const store = { get: async () => read(), putIfMatch: async (_id, value, etag) => {
    if (etag !== `v${revision}`) return { state: 'conflict' };
    artifact = structuredClone(value); revision++; return { ...read(), state: 'updated' };
  } };
  const config = { provider: 'openai', model: 'test', targetLanguage: 'ja', completionEnabled: true,
    automaticCompletionEnabled: true, cleanDirtyLyrics: false, translateLyrics: true, detectLanguage: false, referenceExistingTranslation: true };
  const start = (extraDeps = {}) => beginLyricAssetAiCompletion({ env: {}, db: {}, song: { id: 'song-1', title: 'Example', artist: 'Singer', language }, store,
    targetLanguage: 'ja', automatic: extraDeps.automatic, deps: { aiAccess: { db: {}, config, client: { assertCurrent: async () => {}, ask }, lease: {} }, reserveDailyQuota: async () => quota, ...extraDeps } });
  return { store, start, initialTranslation, config };
}

test('changing target keeps the previous translated layer while the real completion is pending', async () => {
  let finish; const waiting = new Promise(resolve => { finish = resolve; });
  const f = fixture({ ask: () => waiting }); const started = await f.start();
  assert.equal(started.artifact.aiCompletion.status, 'pending'); assert.deepEqual(started.artifact.translation, f.initialTranslation);
  finish(JSON.stringify({ translations: [{ unitId: 0, text: 'こんにちは' }] })); await started.task;
});

test('quota failure preserves the previous target layer and reports failure', async () => {
  const f = fixture({ quota: false }); const started = await f.start(); await started.task;
  const finished = await f.store.get(); assert.equal(finished.artifact.aiCompletion.status, 'failed');
  assert.equal(finished.artifact.aiCompletion.errorCode, 'quota_exhausted'); assert.deepEqual(finished.artifact.translation, f.initialTranslation);
});

test('upstream failure preserves the previous target layer', async () => {
  const f = fixture({ ask: async () => { throw Error('AI_UPSTREAM_503'); } }); const started = await f.start(); await started.task;
  const finished = await f.store.get(); assert.equal(finished.artifact.aiCompletion.errorCode, 'upstream_unavailable');
  assert.deepEqual(finished.artifact.translation, f.initialTranslation);
});

test('only a successful completion atomically replaces the target layer', async () => {
  const f = fixture(); const started = await f.start(); await started.task;
  const finished = await f.store.get(); assert.equal(finished.artifact.translation.language, 'ja');
  assert.equal(finished.artifact.translation.kind, 'ai'); assert.deepEqual(finished.artifact.translation.lines, ['こんにちは']);
});

test('a Chinese original can be translated to a different configured target', async () => {
  const f = fixture({ language: 'zh', text: '你好世界' }); const started = await f.start(); await started.task;
  const finished = await f.store.get(); assert.equal(finished.artifact.translation.language, 'ja');
  assert.deepEqual(finished.artifact.translation.lines, ['こんにちは']);
});

test('a reused authorized snapshot still loses its pending CAS to a later edit', async () => {
  let aiCalls = 0; const f = fixture({ ask: async () => { aiCalls++; return '{}'; } });
  const initialRead = await f.store.get();
  await f.store.putIfMatch('song-1', { ...initialRead.artifact, textHash: 'b'.repeat(64), original: { ...initialRead.artifact.original, lines: [{ time: 1, text: 'Edited later' }] } }, initialRead.etag);
  const started = await f.start({ initialRead }); assert.equal(started.state, 'conflict');
  assert.equal(started.task, null); assert.equal(aiCalls, 0);
  const current = await f.store.get(); assert.equal(current.artifact.textHash, 'b'.repeat(64));
});

test('a hidden copied layer cannot short-circuit real completion startup', async () => {
  const f = fixture();
  const read = await f.store.get();
  const copied = { ...read.artifact.translation, language: 'ja', lines: [read.artifact.original.lines[0].text] };
  await f.store.putIfMatch('song-1', { ...read.artifact, translation: copied }, read.etag);
  const started = await f.start();
  assert.equal(started.state, 'started');
  assert.deepEqual(started.artifact.translation, copied, 'startup preserves saved old bytes');
  await started.task;
  const finished = await f.store.get();
  assert.deepEqual(finished.artifact.translation.lines, ['こんにちは']);
});

test('legacy cleanup reads preserve original lines, timing and review proposal without any write', async () => {
  const f = fixture();
  const before = await f.store.get();
  const review = { ...before.artifact, aiCompletion: { status: 'review', candidateIndices: [0], updatedAt: '2026-01-01T00:00:00.000Z' } };
  await f.store.putIfMatch('song-1', review, before.etag);
  const read = await f.store.get();
  let writes = 0;
  const guarded = { ...f.store, putIfMatch: async () => { writes++; assert.fail('A read must never apply a legacy cleanup proposal'); } };
  const result = await resolveLegacyLyricCleanup(guarded, { id: 'song-1' }, read);
  assert.deepEqual(result, read);
  assert.equal(writes, 0);
  assert.deepEqual((await f.store.get()).artifact, review);
});

test('a new ordinary translation retries a legacy review without applying its deletion proposal', async () => {
  const f = fixture({ ask: async messages => {
    const payload = JSON.parse(messages.at(-1).content);
    assert.equal(Object.hasOwn(payload, 'cleanupUnits'), false);
    return { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: unit.unitId ? 'こんにちは' : 'クレジット' })) };
  } });
  const read = await f.store.get();
  const original = { ...read.artifact.original, lines: [
    { time: 0.5, text: 'Lyrics by Someone' },
    { time: 1, text: 'Hello world', words: [{ text: 'Hello', start: 1, end: 1.5 }, { text: 'world', start: 1.5, end: 2 }] },
  ] };
  await f.store.putIfMatch('song-1', { ...read.artifact, original,
    aiCompletion: { status: 'review', candidateIndices: [0], updatedAt: '2026-01-01T00:00:00.000Z' } }, read.etag);
  const started = await f.start();
  assert.equal(started.state, 'started');
  assert.ok(started.task);
  await started.task;
  const finished = (await f.store.get()).artifact;
  assert.deepEqual(finished.original, original);
  assert.deepEqual(finished.translation.lines, ['クレジット', 'こんにちは']);
});

test('an explicit cleanup request can still remove a proposed non-sung row while preserving retained word timing', async () => {
  const f = fixture({ ask: async messages => {
    const payload = JSON.parse(messages.at(-1).content);
    assert.ok(payload.cleanupUnits);
    return { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: unit.unitId ? 'こんにちは' : 'クレジット' })),
      discardLineIndices: [0] };
  } });
  f.config.cleanDirtyLyrics = true;
  const read = await f.store.get();
  const kept = { time: 1, text: 'Hello world', words: [{ text: 'Hello', start: 1, end: 1.5 }, { text: 'world', start: 1.5, end: 2 }] };
  await f.store.putIfMatch('song-1', { ...read.artifact, original: { ...read.artifact.original,
    lines: [{ time: 0.5, text: 'Lyrics by Someone' }, kept] } }, read.etag);
  const started = await f.start();
  await started.task;
  const finished = (await f.store.get()).artifact;
  assert.deepEqual(finished.original.lines, [kept]);
  assert.deepEqual(finished.translation.lines, ['こんにちは']);
});

test('automatic completion ignores an inherited legacy cleanup preference', async () => {
  const f = fixture({ ask: async messages => {
    const payload = JSON.parse(messages.at(-1).content);
    assert.equal(Object.hasOwn(payload, 'cleanupUnits'), false);
    return { translations: payload.units.map(unit => ({ unitId: unit.unitId, text: unit.unitId ? 'こんにちは' : 'クレジット' })) };
  } });
  f.config.cleanDirtyLyrics = true;
  const read = await f.store.get();
  const original = { ...read.artifact.original, lines: [
    { time: 0.5, text: 'Lyrics by Someone' },
    { time: 1, text: 'Hello world', words: [{ text: 'Hello', start: 1, end: 1.5 }, { text: 'world', start: 1.5, end: 2 }] },
  ] };
  await f.store.putIfMatch('song-1', { ...read.artifact, original }, read.etag);
  const started = await f.start({ automatic: true });
  await started.task;
  assert.deepEqual((await f.store.get()).artifact.original, original);
});

test('explicit cleanup-only completes a foreign song without claiming translation is unnecessary', async () => {
  const f = fixture({ ask: async messages => {
    assert.ok(JSON.parse(messages.at(-1).content).cleanupUnits);
    return { discardLineIndices: [] };
  } });
  f.config.cleanDirtyLyrics = true;
  f.config.translateLyrics = false;
  const before = await f.store.get();
  const started = await f.start();
  await started.task;
  const saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.original, before.artifact.original);
  assert.deepEqual(saved.translation, before.artifact.translation);
  assert.equal(saved.aiCompletion.status, 'completed');
  assert.equal(saved.translationDecision.status, 'needed');
});
