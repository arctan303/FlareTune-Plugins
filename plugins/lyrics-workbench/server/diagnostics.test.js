import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { completionCapabilities, loadTestModule } from './translation.fixture.js';

const runtime = await loadTestModule(new URL('./translation.js', import.meta.url), { workflow: true });
const { completeLyricDraft } = await loadTestModule(new URL('./draftAi.js', import.meta.url));
const secret = 'PRIVATE_MODEL_BODY_key_https://private.invalid/lyrics';
const config = { provider: 'deepseek', model: 'deepseek-flash', targetLanguage: 'zh', completionEnabled: true,
  translateLyrics: true, detectLanguage: true, cleanDirtyLyrics: false };
const song = { id: 'yt:abcdefghijk', title: 'Fixture', artist: 'Singer', language: 'en' };

async function bundleWithCapabilities(entry, capabilities) {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'diagnostic-capabilities', setup(api) {
      api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
      api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js' }));
    } }] });
  return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
}

async function runFixture({ texts = ['The morning comes again'], ask, settings = config, module = runtime } = {}) {
  let artifact = (await runtime.buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: texts.map((text, index) => ({ text, time: index + 1 })) })).artifact;
  const original = structuredClone(artifact.original);
  const startedAt = new Date().toISOString();
  artifact.aiCompletion = { status: 'pending', updatedAt: startedAt };
  let revision = 0, calls = 0;
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: String(revision) });
  const store = { get: async () => read(), putIfMatch: async (_id, next, etag) => {
    if (etag !== String(revision)) return { state: 'conflict' };
    artifact = structuredClone(next); revision++; return { ...read(), state: 'updated' };
  } };
  const result = await module.runLyricAssetAiCompletion({ env: {}, db: {}, song, store,
    startedAt, textHash: artifact.textHash, deps: { reserveDailyQuota: async () => true,
      aiAccess: { db: {}, lease: {}, config: settings, client: { assertCurrent: async () => {},
        ask: async (...args) => { calls++; return ask(...args); } } } } });
  return { result, artifact, original, calls };
}

function assertArtifactFailure(f, errorCode = 'invalid_output') {
  assert.equal(f.result.state, 'updated');
  assert.equal(f.artifact.aiCompletion.status, 'failed');
  assert.equal(f.artifact.aiCompletion.errorCode, errorCode);
  assert.deepEqual(Object.keys(f.artifact.aiCompletion).sort(), ['errorCode', 'status', 'updatedAt']);
  assert.deepEqual(f.artifact.original, f.original);
  assert.equal(f.artifact.translation, null);
  assert.equal(f.artifact.diagnostic, undefined);
  assert.equal(f.artifact.validationCode, undefined);
  assert.equal(f.artifact.translationDecision, undefined);
}

test('local response validation returns a bounded diagnostic without changing the failed artifact', async () => {
  const f = await runFixture({ ask: async () => ({ songLanguage: 'en',
    translations: [{ unitId: 99, text: secret }] }) });
  assertArtifactFailure(f);
  assert.deepEqual(f.result.diagnostic, { validationCode: 'INVALID_TRANSLATION_INDEX', stage: 'validation', batchIndex: 0 });
  assert.equal(JSON.stringify(f.result.diagnostic).includes(secret), false);
});

test('validation reports the actual later batch rather than the first successful batch', async () => {
  const f = await runFixture({ texts: Array.from({ length: 21 }, (_, i) => `We sing verse ${i}`), ask: async messages => {
    const { units } = JSON.parse(messages.at(-1).content);
    return { songLanguage: 'en', translations: units.map(unit => ({ unitId: unit.unitId === 20 ? 999 : unit.unitId, text: '我们一起歌唱' })) };
  } });
  assertArtifactFailure(f);
  assert.equal(f.calls, 2);
  assert.deepEqual(f.result.diagnostic, { validationCode: 'INVALID_TRANSLATION_INDEX', stage: 'validation', batchIndex: 1 });
});

test('setup validation is identified without inventing a batch', async () => {
  const f = await runFixture({ texts: ['♪'], ask: () => assert.fail('No generation for empty completion units') });
  assertArtifactFailure(f);
  assert.deepEqual(f.result.diagnostic, { validationCode: 'NO_TRANSLATABLE_LINES', stage: 'setup' });
});

test('batch construction validation reports setup and preserves its public error code', async () => {
  const f = await runFixture({ settings: { ...config, targetLanguage: 'unknown-target' },
    ask: () => assert.fail('No generation for invalid target') });
  assertArtifactFailure(f);
  assert.deepEqual(f.result.diagnostic, { validationCode: 'INVALID_TARGET_LANGUAGE', stage: 'setup' });
});

const finalizationRuntime = await bundleWithCapabilities('./translation.js', completionCapabilities
  .replace('export const projectLyricArtifact =', 'const baseProjectLyricArtifact =')
  + '\nexport const projectLyricArtifact = () => ({translation:null,translationAvailable:false});');
test('the final storage-boundary validation has a distinct safe stage', async () => {
  const f = await runFixture({ module: finalizationRuntime, ask: async () => ({ songLanguage: 'en',
    translations: [{ unitId: 0, text: '清晨再次来临' }] }) });
  assertArtifactFailure(f);
  assert.deepEqual(f.result.diagnostic, { validationCode: 'INVALID_TRANSLATION_OUTPUT', stage: 'finalization' });
});

test('upstream errors cannot impersonate an internal validation diagnostic', async () => {
  for (const message of ['INVALID_COVERAGE', secret, `INVALID_JSON ${secret}`]) {
    const f = await runFixture({ ask: async () => { throw new Error(message); } });
    assertArtifactFailure(f, message.startsWith('INVALID_') ? 'invalid_output' : 'completion_failed');
    assert.equal(f.result.diagnostic, undefined);
    assert.equal(JSON.stringify(f.artifact.aiCompletion).includes(secret), false);
  }
});

test('an upstream failure after the JSON retry cannot inherit the previous validation diagnostic', async () => {
  let count = 0;
  const f = await runFixture({ ask: async () => { if (count++ === 0) return secret; throw new Error(secret); } });
  assertArtifactFailure(f, 'completion_failed');
  assert.equal(f.calls, 2);
  assert.equal(f.result.diagnostic, undefined);
});

test('draft failures carry only the bounded diagnostic and the established error code', async () => {
  const result = await completeLyricDraft({ env: {}, db: {}, song, lines: [{ time: 1, text: 'The morning comes again' }],
    etag: 'v1', translationLanguage: 'zh', actorAccountId: 'owner', deps: { reserveDailyQuota: async () => true,
      aiAccess: { db: {}, lease: {}, config, client: { assertCurrent: async () => {}, ask: async () => ({ songLanguage: 'en',
        translations: [{ unitId: 99, text: secret }] }) } } } });
  assert.deepEqual(result, { status: 'failed', errorCode: 'invalid_output',
    diagnostic: { validationCode: 'INVALID_TRANSLATION_INDEX', stage: 'validation', batchIndex: 0 } });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

const workspaceCapabilities = completionCapabilities + String.raw`
export const LYRIC_TRANSLATION_POLICY_VERSION = 1;
export class LyricSourceError extends Error {}
export class LyricArtifactStoreError extends Error {}
export class LyricCandidateInspectionError extends Error {}
export class AuthError extends Error {}
const unused = () => {throw Error('Unexpected workspace capability')};
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
export const LYRIC_CANDIDATE_INSPECTION_LIMITS = {maxResponseBytes:100000,maxCandidates:10};
export const readBoundedJson = request => request.json();
export const guardExternalLyricStore = x => x;
export const isExternalLyricSongId = x => x.startsWith('yt:');
export const lyricSongStillExists = async () => true;
export const resolveLyricSong = async (_db,_id,deps) => deps.song;
export const storedLyricTranslationLanguage = x => x?.language;
export const isLyricSourceId = x => ['manual','netease'].includes(x);
export const pluginFail = unused;
`;
const { handleLyricsWorkbenchRoute } = await bundleWithCapabilities('./workspace.js', workspaceCapabilities);
async function workspaceFailure({ result, role = 'admin', actualDraft = false } = {}) {
  const url = new URL(`https://app.invalid/api/lyrics/workspace/${encodeURIComponent(song.id)}/draft-ai`);
  let draftCalls = 0, writes = 0;
  const store = { get: async () => ({ state: 'found', etag: 'v1', artifact: { status: 'ready', translation: null } }),
    putIfMatch: async () => { writes++; assert.fail('Draft route must not write shared lyrics'); } };
  const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: [{ time: 1, text: 'The morning comes again' }], etag: 'v1' }) });
  const response = await handleLyricsWorkbenchRoute(request, url, { prepare() {} }, {},
    { mode: 'normal', account: { accountId: 'owner', role } }, {}, { song, store,
      context: { requireRoles: async () => {} }, aiAvailable: async () => true,
      ...(actualDraft ? {} : { completeDraft: async () => { draftCalls++; return result; } }),
      aiDeps: { loadLyricAiConfig: async () => config, reserveDailyQuota: async () => true,
        aiAccess: { db: {}, lease: {}, config, client: { assertCurrent: async () => {}, ask: async () => ({ songLanguage: 'en',
          translations: [{ unitId: 99, text: secret }] }) } } } });
  return { response, payload: await response.json(), draftCalls, writes };
}

test('the admin draft route exposes a safe diagnostic while retaining its existing HTTP failure contract', async () => {
  const f = await workspaceFailure({ actualDraft: true });
  assert.equal(f.response.status, 503);
  assert.deepEqual(f.payload, { ok: false, code: 503, error: 'LYRIC_AI_FAILED', message: 'invalid_output',
    data: { diagnostic: { code: 'INVALID_TRANSLATION_INDEX', stage: 'validation', batch: 0 } } });
  assert.equal(f.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(f.writes, 0);
  assert.equal(JSON.stringify(f.payload).includes(secret), false);
});

test('draft route revalidates diagnostics and strips every unapproved field', async () => {
  const f = await workspaceFailure({ result: { status: 'failed', errorCode: 'invalid_output', diagnostic: {
    validationCode: 'INVALID_COVERAGE', stage: 'validation', batchIndex: 1,
    original: secret, response: secret, message: secret, url: secret,
  } } });
  assert.deepEqual(f.payload.data, { diagnostic: { code: 'INVALID_COVERAGE', stage: 'validation', batch: 1 } });
  assert.equal(JSON.stringify(f.payload).includes(secret), false);
  for (const diagnostic of [
    { validationCode: secret, stage: 'validation', batchIndex: 0 },
    { validationCode: 'INVALID_COVERAGE', stage: secret, batchIndex: 0 },
    { validationCode: 'INVALID_COVERAGE', stage: 'validation', batchIndex: -1 },
    { validationCode: 'INVALID_COVERAGE', stage: 'validation', batchIndex: secret },
  ]) {
    const rejected = await workspaceFailure({ result: { status: 'failed', errorCode: 'invalid_output', diagnostic } });
    assert.deepEqual(rejected.payload, { ok: false, code: 503, error: 'LYRIC_AI_FAILED', message: 'invalid_output' });
  }
});

test('nonvalidation draft failures retain the original response without diagnostic data', async () => {
  const f = await workspaceFailure({ result: { status: 'failed', errorCode: 'upstream_unavailable' } });
  assert.deepEqual(f.payload, { ok: false, code: 503, error: 'LYRIC_AI_FAILED', message: 'upstream_unavailable' });
});

test('the diagnostic change preserves the admin-only draft mutation gate', async () => {
  const f = await workspaceFailure({ role: 'member', result: { status: 'failed', errorCode: 'invalid_output',
    diagnostic: { validationCode: 'INVALID_COVERAGE', stage: 'validation', batchIndex: 0 } } });
  assert.equal(f.response.status, 403);
  assert.equal(f.payload.error, 'FORBIDDEN');
  assert.equal(f.payload.data, undefined);
  assert.equal(f.draftCalls, 0);
  assert.equal(f.writes, 0);
});
