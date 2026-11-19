import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { completionCapabilities } from './translation.fixture.js';

const capabilities = completionCapabilities + `export { jsonTaskResponse } from ${JSON.stringify(fileURLToPath(new URL('../../../../server/server/src/services/jsonTaskResponse.js', import.meta.url)).replaceAll('\\', '/'))};\n` + String.raw`
export const LYRIC_TRANSLATION_POLICY_VERSION = 2;
export class LyricSourceError extends Error {}
export class LyricArtifactStoreError extends Error {}
export class LyricCandidateInspectionError extends Error {}
export class AuthError extends Error {}
const unused = () => { throw Error('Unexpected cleanup test capability'); };
export const fetchLyricsDocumentWithFallback = unused;
export const fetchUncachedSourceLyricsDocument = unused;
export const createSourceCandidateInspectionSnapshot = unused;
export const listSourceLyricCandidates = unused;
export const applyLyricOffset = unused;
export const listLyricsResolutionCandidates = unused;
export const parseLrcDocument = unused;
export const buildLyricArtifactMarker = unused;
export const normalizeLyricArtifactSongId = x => x;
export const validateLyricArtifact = x => x;
export const lyricArtifactStoreForEnv = unused;
export const lyricSourceLoaderForDb = unused;
export const inspectLyricCandidates = unused;
export const LYRIC_CANDIDATE_INSPECTION_LIMITS = { maxResponseBytes: 100000, maxCandidates: 10 };
export const readBoundedJson = request => request.json();
export const MAX_LYRIC_ARTIFACT_BYTES = 4 * 1024 * 1024;
export const guardExternalLyricStore = x => x;
export const isExternalLyricSongId = x => x.startsWith('yt:');
export const lyricSongStillExists = async () => true;
export const resolveLyricSong = async (_db, _id, deps) => deps.song;
export const storedLyricTranslationLanguage = x => x?.language;
export const isLyricSourceId = x => ['manual','netease'].includes(x);
export const pluginFail = unused;
`;
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./workspace.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'cleanup-consent-capabilities', setup(api) {
    api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
    api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js', resolveDir: fileURLToPath(new URL('.', import.meta.url)) }));
  } }] });
const { handleLyricsWorkbenchRoute } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const song = { id: 'yt:abcdefghijk', title: 'Fixture', artist: 'Singer', language: 'en' };
const settings = { onlineEnabled: true, lyricPreference: 'word', provider: 'deepseek', model: 'fixture',
  temperature: 0.2, styleRules: '', targetLanguage: 'zh', cleanDirtyLyrics: true, translateLyrics: true,
  detectLanguage: true, referenceExistingTranslation: false, completionEnabled: true, automaticCompletionEnabled: true };

async function requestFixture({ role = 'admin', action = 'draft-ai', body, review = false, completion = null, draftFailure } = {}) {
  const original = { source: 'manual', format: 'lrc', syncMode: 'line',
    lines: [{ time: 1, text: 'Lyrics by Fixture' }, { time: 2, text: 'The morning comes again' }] };
  let asset = { schemaVersion: 1, songId: song.id, status: 'ready', textHash: 'a'.repeat(64), original,
    translation: null, aiCompletion: completion || (review ? { status: 'review', candidateIndices: [0], reviewAccountId: 'owner' } : null),
    offsetMs: 0, provenance: {}, updatedAt: new Date().toISOString() };
  let writes = 0, called;
  const store = { get: async () => ({ state: 'found', artifact: structuredClone(asset), etag: 'v1' }),
    putIfMatch: async (_songId, next) => { writes++; asset = structuredClone(next); return { state: 'updated', artifact: asset, etag: 'v2' }; } };
  const path = action ? `/${action}` : '';
  const url = new URL(`https://app.invalid/api/lyrics/workspace/${encodeURIComponent(song.id)}${path}`);
  const method = action ? 'POST' : 'GET';
  const request = new Request(url, { method, ...(action ? { headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? (action === 'draft-ai' ? { lines: original.lines, etag: 'v1' } : {})) } : {}) });
  const db = { prepare: () => ({ first: async () => ({ policy_json: JSON.stringify(settings) }) }) };
  const result = await handleLyricsWorkbenchRoute(request, url, db, {},
    { mode: 'normal', account: { accountId: 'owner', role } }, {}, { song, store,
      context: { requireRoles: async () => {} }, aiAvailable: async () => true,
      beginCompletion: async options => { called = options; return { state: 'not_needed' }; },
      completeDraft: async options => { called = options; return draftFailure ? { status: 'failed', errorCode: draftFailure } : { status: 'ready', lines: options.lines }; },
      aiDeps: { loadLyricAiConfig: async () => settings,
        aiAccess: { db, lease: {}, config: { ...settings }, client: { assertCurrent: async () => {},
          ask: () => assert.fail('Consent probes must never call a model') } } } });
  return { response: result, payload: await result.json(), called, writes, asset, original };
}

for (const role of ['member', 'admin']) {
  test(`${role} ordinary translation disables cleanup in both policy and resolved AI access`, async () => {
    const f = await requestFixture({ role, action: 'ai-completion' });
    assert.equal(f.response.status, 200);
    assert.equal(f.called.deps.lyricConfig.cleanDirtyLyrics, false);
    assert.equal(f.called.deps.aiAccess.config.cleanDirtyLyrics, false);
    assert.equal(f.writes, 0);
  });
}

test('workspace asset and draft failure responses hide internal budget scopes without rewriting the stored asset', async () => {
  for (const errorCode of ['request_budget_exhausted_' + 'a'.repeat(32), 'request_budget_retry_exhausted_' + 'b'.repeat(32)]) {
    for (const role of ['member', 'admin']) {
      const f = await requestFixture({ role, action: '', completion: { status: 'failed', errorCode, updatedAt: new Date().toISOString() } });
      assert.equal(f.response.status, 200); assert.equal(f.payload.data.asset.aiCompletion.errorCode, 'request_budget_exhausted');
      assert.doesNotMatch(JSON.stringify(f.payload), /request_budget_(?:retry_)?exhausted_[a-f0-9]{32}/u);
      assert.equal(f.asset.aiCompletion.errorCode, errorCode); assert.equal(f.writes, 0);
    }
    const draft = await requestFixture({ draftFailure: errorCode });
    assert.equal(draft.response.status, 200); assert.equal(draft.payload.code, 503); assert.equal(draft.payload.message, 'request_budget_exhausted');
    assert.doesNotMatch(JSON.stringify(draft.payload), /request_budget_(?:retry_)?exhausted_[a-f0-9]{32}/u);
  }
});
test('admin draft defaults to translation without cleanup even when legacy policy enabled cleanup', async () => {
  const f = await requestFixture();
  assert.equal(f.response.status, 200);
  assert.equal(f.called.deps.lyricConfig.cleanDirtyLyrics, false);
  assert.equal(f.called.deps.aiAccess.config.cleanDirtyLyrics, false);
  assert.equal(f.writes, 0);
});
test('admin may explicitly request cleanup for this draft without writing shared lyrics', async () => {
  const f = await requestFixture({ body: { lines: [{ text: 'Hello', time: 1 }], etag: 'v1', cleanDirtyLyrics: true } });
  assert.equal(f.response.status, 200);
  assert.equal(f.called.deps.lyricConfig.cleanDirtyLyrics, true);
  assert.equal(f.called.deps.aiAccess.config.cleanDirtyLyrics, true);
  assert.equal(f.writes, 0);
});
test('invalid cleanup consent is rejected while a member can explicitly process a draft', async () => {
  for (const cleanDirtyLyrics of ['true', 1, null, {}]) {
    const f = await requestFixture({ body: { lines: [{ text: 'Hello' }], etag: 'v1', cleanDirtyLyrics } });
    assert.equal(f.response.status, 400); assert.equal(f.called, undefined); assert.equal(f.writes, 0);
  }
  const f = await requestFixture({ role: 'member', body: { lines: [{ text: 'Hello' }], etag: 'v1', cleanDirtyLyrics: true } });
  assert.equal(f.response.status, 200); assert.equal(f.called.deps.lyricConfig.cleanDirtyLyrics, true); assert.equal(f.writes, 0);
});
for (const role of ['member', 'admin']) {
  test(`${role} reading an old cleanup review never applies its proposed deletions`, async () => {
    const f = await requestFixture({ role, action: '', review: true });
    assert.equal(f.response.status, 200); assert.equal(f.writes, 0);
    assert.deepEqual(f.asset.original, f.original); assert.equal(f.asset.original.lines.length, 2);
    assert.deepEqual(f.asset.aiCompletion.candidateIndices, [0]);
  });
}
