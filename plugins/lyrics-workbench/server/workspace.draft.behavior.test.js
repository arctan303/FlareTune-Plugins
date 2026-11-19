import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LYRIC_AI_CONFIG } from './policy.js';
import { createLyricDraftReceipt } from './draftReceipt.js';

const hostFile = path => fileURLToPath(new URL('../../../../server/server/src/' + path, import.meta.url)).replaceAll('\\', '/');
// Parse, normalize, project and enforce byte limits with the real host code.
// Only source/provider access and authorization plumbing are bounded fixtures.
const capabilities = `
export * from ${JSON.stringify(hostFile('services/lyricAssetWorkflow.js'))};
export * from ${JSON.stringify(hostFile('services/lyricArtifactStore.js'))};
export * from ${JSON.stringify(hostFile('utils/lyricDocument.js'))};
export * from ${JSON.stringify(hostFile('utils/lyricsParsing.js'))};
export * from ${JSON.stringify(hostFile('services/storeAuthority.js'))};
export { applyLyricOffset } from ${JSON.stringify(hostFile('services/lyricResolution.js'))};
export { readBoundedJson } from ${JSON.stringify(hostFile('instance/httpSecurity.js'))};
export { jsonTaskResponse } from ${JSON.stringify(hostFile('services/jsonTaskResponse.js'))};
export class AuthError extends Error {}
export class LyricSourceError extends Error {}
export class LyricCandidateInspectionError extends Error {}
const unused = () => { throw Error('Unexpected provider/model capability'); };
export const fetchLyricsDocumentWithFallback = unused, fetchUncachedSourceLyricsDocument = unused,
  createSourceCandidateInspectionSnapshot = unused, listSourceLyricCandidates = unused,
  listLyricsResolutionCandidates = unused, lyricSourceLoaderForDb = unused, inspectLyricCandidates = unused,
  createPluginServiceLease = unused, createSubsonicPluginServiceLease = unused, createAiGatewayClient = unused;
export const isPluginServiceLease = () => false;
export const guardExternalLyricStore = value => value;
export const lyricSongStillExists = async () => true;
export const resolveLyricSong = async (_db, _id, deps) => deps.song;
export const storedLyricTranslationLanguage = value => value?.language;
export const isLyricSourceId = value => ['lrclib', 'custom_krc', 'custom_lrc'].includes(value);
export const LYRIC_CANDIDATE_INSPECTION_LIMITS = { maxCandidates: 12, maxResponseBytes: 2097152 };
export const pluginFail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
`;
const bundled = await build({ stdin: { contents: `export * from './workspace.js'; export * from '@flaretune/plugin-sdk/server/lyric-workflow';
  export * from '@flaretune/plugin-sdk/server/lyric-assets';`, resolveDir: fileURLToPath(new URL('.', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'node',
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});` },
  plugins: [{ name: 'workspace-host-capabilities', setup(api) {
    api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
    api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)) }));
  } }] });
let runtime;
try { runtime = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64')); }
catch (error) { error.stack = `${error.name}: ${error.message}`; throw error; }
const { handleLyricsWorkbenchRoute, buildReadyLyricArtifact, validateLyricArtifact, MAX_LYRIC_ARTIFACT_BYTES } = runtime;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const song = { id: 'library-song', title: 'Fixture', artist: 'Singer', language: 'en' };
const env = { SETUP_SECRET: 'workspace-draft-fixture-secret-at-least-thirty-two-characters' };
async function assetFor(lines = [{ time: 1, text: 'Original verse' }], { offsetMs = 0 } = {}) {
  const built = await buildReadyLyricArtifact(song, { source: 'lrclib', format: 'lrc', lines });
  return { ...built.artifact, offsetMs, provenance: { originalSource: 'lrclib', providerLyricId: 'fixture', quality: 'good' } };
}
async function fixture({ asset = undefined, settings: overrides = {}, language = song.language, completeDraft, beginCompletion } = {}) {
  let current = asset === undefined ? await assetFor() : structuredClone(asset), revision = 1;
  const calls = { reads: 0, writes: 0, sqlWrites: 0, ai: 0, authority: 0, draft: 0, begin: 0 };
  const settings = { ...DEFAULT_LYRIC_AI_CONFIG, cleanDirtyLyrics: false, targetLanguage: 'zh', completionEnabled: false, ...overrides };
  const read = () => current ? { state: 'found', artifact: structuredClone(current), etag: 'v' + revision } : { state: 'missing', etag: null };
  const store = { get: async () => { calls.reads++; return read(); },
    putIfMatch: async (_id, next, etag) => {
      if (etag !== 'v' + revision) return { state: 'conflict' };
      current = structuredClone(next); revision++; calls.writes++; return { ...read(), state: 'updated' };
    }, createIfAbsent: async (_id, next) => {
      if (current) return { state: 'conflict' };
      current = structuredClone(next); revision++; calls.writes++; return { ...read(), state: 'created' };
    } };
  const db = { prepare: sql => {
    if (/^\s*(?:UPDATE|INSERT|DELETE)/iu.test(sql)) { calls.sqlWrites++; assert.fail('Workspace never writes catalog/configuration metadata'); }
    return { first: async () => ({ policy_json: JSON.stringify(settings) }) };
  } };
  const aiAccess = { db, lease: {}, config: settings, client: { assertCurrent: async () => {}, ask: () => { calls.ai++; assert.fail('No real model'); } } };
  const deps = { song: { ...song, language }, store, aiAvailable: async () => true,
    context: { requireRoles: async () => { calls.authority++; } },
    aiDeps: { loadLyricAiConfig: async () => settings, aiAccess },
    completeDraft: async input => { calls.draft++; return completeDraft ? completeDraft(input, { store, read }) : { status: 'ready', lines: input.lines }; },
    beginCompletion: async input => { calls.begin++; return beginCompletion ? beginCompletion(input, { store, read }) : { state: 'not_needed' }; } };
  const request = async (action, method, body, { role = 'member', signal } = {}) => {
    const url = new URL('https://test.invalid/api/lyrics/workspace/' + song.id + (action ? '/' + action : ''));
    const req = new Request(url, { method, signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return handleLyricsWorkbenchRoute(req, url, db, {}, { mode: 'normal', account: { accountId: 'owner', role } }, env, deps);
  };
  return { request, calls, read, store, settings };
}
const linesOf = asset => asset.original.lines.map((line, index) => ({ ...line,
  ...(asset.translation?.lines[index] ? { tlyric: asset.translation.lines[index] } : {}) }));

for (const role of ['member', 'admin']) test(`${role} previews LRC and backup locally without a file or model operation`, async () => {
  const f = await fixture({ settings: { onlineEnabled: false } });
  const lrc = await f.request('preview', 'POST', { lrc: '[00:02.000]A draft verse' }, { role });
  assert.equal(lrc.status, 200); const parsed = await lrc.json();
  assert.equal(parsed.data.asset.original.lines[0].text, 'A draft verse'); assert.equal(parsed.data.asset.offsetMs, 0);
  const backup = await assetFor(undefined, { offsetMs: 500 });
  const response = await f.request('preview', 'POST', { asset: backup }, { role }); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.data.asset.original.lines[0].time, 1);
  assert.equal(body.data.asset.offsetMs, 500); assert.equal(body.data.lyrics.lines[0].time, 1.5);
  assert.equal(body.data.asset.original.source, 'lrclib'); assert.equal(body.data.etag, null);
  assert.equal(f.calls.reads, 0); assert.equal(f.calls.writes, 0); assert.equal(f.calls.ai, 0); assert.equal(f.calls.sqlWrites, 0);
});

test('preview accepts exactly one field and rejects empty, foreign-song or invalid assets', async () => {
  const f = await fixture();
  for (const body of [{}, { lrc: 'text', asset: await assetFor() }, { lrc: 2 }, { lrc: 'text', etag: 'v1' }]) {
    assert.equal((await f.request('preview', 'POST', body)).status, 400);
  }
  for (const body of [{ lrc: '' }, { asset: { ...await assetFor(), songId: 'another-song' } }, { asset: {} }]) {
    assert.equal((await f.request('preview', 'POST', body)).status, 422);
  }
  assert.equal(f.calls.writes, 0); assert.equal(f.calls.ai, 0);
});

for (const role of ['member', 'admin']) test(`${role} edits restored raw rows continuously while preserving the one backup offset and provenance`, async () => {
  const f = await fixture(), backup = await assetFor(undefined, { offsetMs: 500 });
  const first = await f.request('document', 'PUT', { etag: 'v1', restoreAsset: backup,
    lines: [{ time: 2, text: 'Edited after preview' }] }, { role });
  assert.equal(first.status, 200); const saved = (await first.json()).data.asset;
  assert.equal(saved.original.lines[0].time, 2); assert.equal(saved.offsetMs, 500);
  assert.equal(saved.original.source, 'lrclib'); assert.equal(saved.provenance.originalSource, 'lrclib');
  assert.equal(saved.provenance.providerLyricId, 'fixture'); assert.equal(saved.provenance.evaluation, 'manual');
  assert.notEqual(saved.textHash, backup.textHash);
  const next = await f.request('document', 'PUT', { etag: f.read().etag, restoreAsset: backup,
    lines: [{ time: 3, text: 'A second edit still wins' }] }, { role });
  assert.equal(next.status, 200); const body = await next.json();
  assert.equal(body.data.asset.original.lines[0].text, 'A second edit still wins');
  assert.equal(body.data.asset.original.lines[0].time, 3); assert.equal(body.data.asset.offsetMs, 500);
  assert.equal(body.data.lyrics.lines[0].time, 3.5); assert.equal(f.calls.writes, 2); assert.equal(f.calls.sqlWrites, 0);
});

test('restore and ordinary saves retain ETag conflicts; only explicit reset accepts empty rows', async () => {
  const f = await fixture(), original = f.read();
  assert.equal((await f.request('document', 'PUT', { etag: 'stale', restoreAsset: await assetFor(), lines: [{ text: 'new' }] })).status, 409);
  assert.deepEqual(f.read(), original); assert.equal(f.calls.writes, 0);
  for (const body of [{ etag: 'v1', lines: [] }, { etag: 'v1', lines: [], reset: false }, { etag: 'v1', lines: [{ text: 'new' }], reset: true }]) {
    assert.equal((await f.request('document', 'PUT', body)).status, 400);
  }
  const response = await f.request('document', 'PUT', { etag: 'v1', lines: [], reset: true });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.status, 'missing');
  assert.equal(f.read().artifact.status, 'reset'); assert.equal(f.calls.writes, 1);
});

test('a valid draft receipt saves its decision bound to the current catalog tag without any Songs write', async () => {
  const f = await fixture({ language: null }), lines = [{ time: 1, text: 'We sing together', tlyric: '我们一起歌唱' }];
  const draft = await runtime.buildEditedLyricArtifact({ ...song, language: null }, lines, { targetLanguage: 'zh' });
  const receipt = await createLyricDraftReceipt(env, { songId: song.id, accountId: 'owner', etag: 'v1', textHash: draft.textHash,
    language: 'en', decision: { status: 'translated', sourceLanguage: 'en', targetLanguage: 'zh', basis: 'ai', policyVersion: 2 } });
  const response = await f.request('document', 'PUT', { etag: 'v1', lines, aiReceipt: receipt, translationLanguage: 'zh' });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.data.asset.translationDecision.songLanguage, null); assert.equal(body.data.asset.translationDecision.sourceLanguage, 'en');
  assert.deepEqual(body.data.lyrics.translation.lines, ['我们一起歌唱']);
  assert.equal(Object.hasOwn(body.data, 'languageUpdateFailed'), false); assert.equal(f.calls.sqlWrites, 0); assert.equal(f.calls.writes, 1);
});

test('a roughly 3.9MB backup plus edited rows fits the request while the final asset keeps its 4MiB limit', async () => {
  const original = Array.from({ length: 1000 }, (_, index) => ({ time: index, text: 'A'.repeat(1950) }));
  const backup = await assetFor(original);
  backup.translation = { source: 'manual', originalTextHash: backup.textHash, language: 'zh',
    lines: original.map(() => '风'.repeat(640)), updatedAt: backup.updatedAt };
  assert.equal(validateLyricArtifact(backup).valid, true);
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) > 3_800_000);
  const f = await fixture();
  const body = { etag: 'v1', restoreAsset: backup, translationLanguage: 'zh', lines: linesOf(backup) };
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 7_600_000);
  const accepted = await f.request('document', 'PUT', body); assert.equal(accepted.status, 200, (await accepted.clone().text()).slice(0, 500));
  assert.ok(validateLyricArtifact(f.read().artifact).byteLength <= MAX_LYRIC_ARTIFACT_BYTES);
  const tooLarge = { ...body, etag: f.read().etag, lines: body.lines.map(line => ({ ...line, tlyric: '风'.repeat(750) })) };
  const rejected = await f.request('document', 'PUT', tooLarge); assert.equal(rejected.status, 422);
  assert.equal(f.calls.writes, 1);
});

test('draft AI validates ETag before streaming, keeps the response open, forwards cancellation scope and never writes', async () => {
  const release = deferred(); let receivedSignal;
  const f = await fixture({ settings: { completionEnabled: true }, completeDraft: async input => {
    receivedSignal = input.deps.signal; await release.promise; return { status: 'ready', lines: input.lines };
  } });
  assert.equal((await f.request('draft-ai', 'POST', { etag: 'stale', lines: [{ text: 'new' }] })).status, 409);
  assert.equal(f.calls.draft, 0);
  const response = await f.request('draft-ai', 'POST', { etag: 'v1', lines: [{ text: 'new' }] });
  const reader = response.body.getReader(); const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).trim(), '');
  await new Promise(resolve => setImmediate(resolve)); assert.ok(receivedSignal instanceof AbortSignal);
  let ended = false; const rest = reader.read().then(value => { ended = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false); assert.equal(f.calls.writes, 0);
  release.resolve(); const value = await rest;
  assert.equal(JSON.parse(new TextDecoder().decode(value.value)).data.status, 'ready');
  assert.equal((await reader.read()).done, true); assert.equal(f.calls.writes, 0);
});

test('shared completion is held until its task finishes and returns the completed file instead of pending waitUntil work', async () => {
  const release = deferred(); let receivedSignal;
  const f = await fixture({ settings: { completionEnabled: true }, beginCompletion: async (input, state) => {
    receivedSignal = input.deps.signal;
    return { state: 'started', task: release.promise.then(async () => {
      const current = state.read();
      return input.store.putIfMatch(song.id, { ...current.artifact,
        translation: { source: 'ai', originalTextHash: current.artifact.textHash, language: 'zh', lines: ['新的完整译文'], updatedAt: current.artifact.updatedAt },
        aiCompletion: { status: 'completed', updatedAt: current.artifact.updatedAt } }, current.etag);
    }) };
  } });
  const response = await f.request('ai-completion', 'POST', {});
  const body = response.json(); let finished = false; body.then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.ok(receivedSignal instanceof AbortSignal);
  release.resolve(); const result = await body;
  assert.equal(result.ok, true); assert.equal(result.data.status, 'completed');
  assert.deepEqual(result.data.asset.translation.lines, ['新的完整译文']); assert.equal(result.data.asset.aiCompletion.status, 'completed');
});

test('late streamed AI failures use the established JSON error envelope without modifying lyrics', async () => {
  const f = await fixture({ settings: { completionEnabled: true }, completeDraft: async () => ({ status: 'failed', errorCode: 'invalid_output' }) });
  const response = await f.request('draft-ai', 'POST', { etag: 'v1', lines: [{ text: 'new' }] });
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.ok, false); assert.equal(body.code, 503); assert.equal(body.error, 'LYRIC_AI_FAILED'); assert.equal(f.calls.writes, 0);
});

test('canceling a draft response aborts its model scope and never writes a shared file', async () => {
  let receivedSignal; const release = deferred();
  const f = await fixture({ settings: { completionEnabled: true }, completeDraft: async input => {
    receivedSignal = input.deps.signal; await release.promise; return { status: 'ready', lines: input.lines };
  } });
  const response = await f.request('draft-ai', 'POST', { etag: 'v1', lines: [{ text: 'new' }] });
  const reader = response.body.getReader(); await reader.read();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(receivedSignal.aborted, false);
  await reader.cancel(); assert.equal(receivedSignal.aborted, true); release.resolve();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.writes, 0);
});

test('a shared task that cannot start is an error rather than a false completed result', async () => {
  const f = await fixture({ settings: { completionEnabled: true }, beginCompletion: async () => ({ state: 'started', task: Promise.resolve({ state: 'unavailable' }) }) });
  const response = await f.request('ai-completion', 'POST', {}); const body = await response.json();
  assert.equal(body.ok, false); assert.equal(body.code, 503); assert.equal(f.calls.writes, 0);
});

test('restoring unchanged hidden translation bytes does not discard them or promote them into the displayed target', async () => {
  const f = await fixture({ settings: { targetLanguage: 'en' } });
  const backup = await assetFor(); backup.translation = { source: 'manual', language: 'en', originalTextHash: backup.textHash,
    lines: ['A preserved previous layer'], updatedAt: backup.updatedAt };
  const response = await f.request('document', 'PUT', { etag: 'v1', restoreAsset: backup, lines: linesOf(backup), translationLanguage: 'en' });
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.data.asset.translation, { ...backup.translation, updatedAt: body.data.asset.updatedAt });
  assert.equal(body.data.lyrics.translationAvailable, false);
});
