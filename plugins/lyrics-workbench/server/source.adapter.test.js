import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Exercise the production adapter and real dominant-language helper together.
// Storage, gateway and the generation engine remain explicit capabilities; no
// provider or host checkout is required by the standalone plugin test suite.
const capabilities = `
export const createLyricDocument = x => structuredClone(x);
export const storedLyricTranslationLanguage = value => value?.language
  || (['custom_krc','custom_lrc','kugou','netease','ai'].includes(value?.source) ? 'zh' : null);
export const isLeadingProviderMetadata = () => false;
export const isSingableLineText = x => /[\\p{L}\\p{N}]/u.test(x || '');
export const getCurrentLyricTranslationDecision = (artifact,song,{targetLanguage}) => {
  const d=artifact.translationDecision;
  return d?.policyVersion===2 && d.textHash===artifact.textHash && d.targetLanguage===targetLanguage ? d : null;
};
export const hasCurrentLyricNoTranslationDecision = (a,s,o) => getCurrentLyricTranslationDecision(a,s,o)?.status==='not_needed';
export const guardStoreAuthority = x => x;
export const storeAuthorityGuard = Symbol('storeAuthorityGuard');
export const guardExternalLyricStore = x => x;
export const computeHash = async x => String(x);
const unused = () => {throw new Error('Unexpected host capability');};
export const lyricArtifactStoreForEnv=unused, buildReadyLyricArtifact=unused, projectLyricArtifact=unused,
  preferredAutomaticDocument=unused, reliableAutomaticMatch=unused, fetchLyricsDocumentWithFallback=unused,
  loadLyricSources=unused, lyricSourceLoaderForDb=unused, resolveLyricSong=unused, createPluginOperationLease=unused;
`;
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./source.js', import.meta.url))], bundle: true,
  write: false, format: 'esm', platform: 'node', plugins: [{ name: 'source-capabilities', setup(api) {
    api.onResolve({ filter: /^@flaretune\/plugin-sdk\// }, args => ({ path: args.path, namespace: 'capabilities' }));
    api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: capabilities, loader: 'js' }));
    api.onResolve({ filter: /^\.\/(translation|config|aiAccess)\.js$/ }, args => args.importer.endsWith('source.js')
      ? { path: args.path, namespace: 'operations' } : null);
    api.onLoad({ filter: /.*/, namespace: 'operations' }, () => ({ contents: `
      const unused=()=>{throw new Error('Unexpected model or settings fallback');};
      export const beginLyricAssetAiCompletion=unused,prepareLyricLanguage=unused,
        loadLyricAiConfig=unused,loadLyricPolicySnapshot=unused,createLyricsAiLease=unused,createLyricsAiAccess=unused;`, loader: 'js' }));
  } }] });
const { createLyricSource } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

function fixture(language, text, decision = null) {
  const song = { id: 'yt:abcdefghijk', title: 'Song', artist: 'Singer', duration: 100, language };
  let artifact = { schemaVersion: 1, status: 'ready', songId: song.id, textHash: 'a'.repeat(64),
    original: { source: 'manual', format: 'lrc', syncMode: 'line', lines: [{ text, time: 1 }] },
    translation: null, aiCompletion: null, provenance: {}, updatedAt: new Date().toISOString(), offsetMs: 0,
    ...(decision ? { translationDecision: { textHash: 'a'.repeat(64), targetLanguage: 'zh', policyVersion: 2, ...decision } } : {}) };
  let revision = 1;
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: `v${revision}` });
  const store = { get: async () => read(), putIfMatch: async (_id, next, etag) => {
    if (etag !== `v${revision}`) return { state: 'conflict' };
    artifact = structuredClone(next); revision++; return { ...read(), state: 'updated' };
  } };
  const calls = { lease: 0, prepared: 0, generated: 0 };
  const config = { onlineEnabled: false, targetLanguage: 'zh', lyricPreference: 'line', completionEnabled: true };
  const source = createLyricSource({ env: {}, db: {}, session: { account: { accountId: 'a' } }, dependencies: {
    store, assertCurrent: async () => {}, loadSettings: async () => config, loadLyricAiConfig: async () => config,
    aiDeps: { aiAccess: { config, client: { assertCurrent: async () => {} } } },
    createDocument: value => structuredClone(value), project: value => ({ translation: value.translation,
      translationState: value.aiCompletion?.status === 'pending' ? 'pending' : 'missing' }),
    createAiLease: async () => { calls.lease++; return { assertCurrent: async () => {} }; },
    prepareLanguage: async input => {
      calls.prepared++;
      const need = (input.song.language === 'zh' || input.deps.initialRead.artifact.translationDecision?.sourceLanguage === 'zh')
        ? 'not_needed' : 'needed';
      const current = input.deps.initialRead;
      const updated = await store.putIfMatch(song.id, { ...current.artifact,
        translationDecision: { status: need, sourceLanguage: input.song.language, textHash: current.artifact.textHash,
          targetLanguage: 'zh', policyVersion: 2 } }, current.etag);
      return { read: updated, song: input.song, need };
    },
    beginCompletion: async input => {
      calls.generated++;
      const current = await store.get(song.id);
      return store.putIfMatch(song.id, { ...current.artifact,
        aiCompletion: { status: 'pending', updatedAt: new Date().toISOString() } }, current.etag);
    },
  } });
  return { song, source, calls };
}

test('the adapter passes a complete original to dominant-language policy for a tagged foreign song', async () => {
  const f = fixture('en', 'Hello world');
  const selected = await f.source.resolve(f.song);
  assert.equal(selected.translation.state, 'idle'); assert.equal(selected.translation.supported, true);
  const adopted = await selected.onAdopt();
  assert.equal(adopted.translation.state, 'pending');
  assert.equal(f.calls.prepared, 0, 'idle tasks delegate the synchronous preparation and handoff to begin');
  assert.equal(f.calls.generated, 1);
});

test('the adapter treats a Chinese tag with foreign inserts as no translation without acquiring a model lease', async () => {
  const f = fixture('zh', '听着歌想念一个人 SHOW HA');
  const selected = await f.source.resolve(f.song);
  assert.equal(selected.translation.state, 'not_needed');
  const adopted = await selected.onAdopt();
  assert.equal(adopted.translation.supported, false); assert.equal(f.calls.prepared, 1);
  assert.equal(f.calls.lease, 0); assert.equal(f.calls.generated, 0);
});

test('the adapter passes the assessment cache when virtual song metadata has no language', async () => {
  const f = fixture('other', '君に会いたい', { status: 'needed', sourceLanguage: 'ja' });
  const selected = await f.source.resolve(f.song);
  assert.equal(selected.translation.state, 'idle'); assert.equal(selected.translation.supported, true);
  const adopted = await selected.onAdopt();
  assert.equal(adopted.translation.state, 'pending'); assert.equal(f.calls.generated, 1);
});
