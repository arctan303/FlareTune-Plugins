import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule, completionCapabilities } from './translation.fixture.js';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { verifyLyricDraftReceiptData } from './draftReceipt.js';
const { completeLyricDraft } = await loadTestModule(new URL('./draftAi.js', import.meta.url));

test('a virtual-song AI draft returns the no-op decision in its receipt without a shared write', async () => {
  const env = { SETUP_SECRET: 'fixture-secret-for-lyric-draft-at-least-32-characters' };
  let calls = 0;
  const lines = [{ time: 1, text: '风吹过窗前' }];
  const song = { id: 'yt:abcdefghijk', language: 'other', title: 'Fixture', artist: 'Singer' };
  const config = { provider: 'openai', model: 'fixture', targetLanguage: 'zh', completionEnabled: true,
    automaticCompletionEnabled: true, translateLyrics: true, detectLanguage: false, cleanDirtyLyrics: false };
  const result = await completeLyricDraft({ env, db: { prepare: () => assert.fail('No catalog writes for a virtual draft') }, song,
    lines, translationLanguage: 'zh', actorAccountId: 'owner', etag: 'v1', deps: {
      aiAccess: { db: {}, lease: {}, config, client: { assertCurrent: async () => {}, ask: async () => {
        calls++; return { language: 'zh', match: 0.95 };
      } } }, reserveDailyQuota: async () => true,
    } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.lines, lines);
  assert.equal(result.inferredLanguage, 'zh');
  assert.equal(result.translationLanguage, null);
  const textHash = (await import('node:crypto')).createHash('sha256').update('风吹过窗前').digest('hex');
  const receipt = await verifyLyricDraftReceiptData(env, result.receipt,
    { songId: song.id, accountId: 'owner', etag: 'v1', textHash });
  assert.equal(receipt.decision.status, 'not_needed');
  assert.equal(receipt.decision.targetLanguage, 'zh');
  assert.equal(calls, 1);
});

// This SDK fixture checks the public decision-scope contract. It deliberately
// does not reproduce the host's language classifier or artifact implementation.
const scopedCapabilities = completionCapabilities.replace('export const projectLyricArtifact =', 'const baseProjectLyricArtifact =') + `
export const projectLyricArtifact = (artifact, options) => {
  const result = baseProjectLyricArtifact(artifact, options);
  if (artifact.translationDecision?.status === 'translated'
    && !getCurrentLyricTranslationDecision(artifact, options.song, options)) {
    return {...result, translation:null, translationAvailable:false};
  }
  return result;
};`;
const scopedBundle = await build({ entryPoints: [fileURLToPath(new URL('./draftAi.js', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'decision-scope', setup(api) {
    api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'scope' }));
    api.onLoad({ filter: /.*/, namespace: 'scope' }, () => ({ contents: scopedCapabilities, loader: 'js' }));
  } }] });
const scopedDraft = (await import('data:text/javascript;base64,' + Buffer.from(scopedBundle.outputFiles[0].text).toString('base64'))).completeLyricDraft;
for (const id of ['library-song', 'yt:abcdefghijk']) {
  for (const inline of [false, true]) {
    test(`unknown-language draft classifies dominant Chinese without translating foreign inserts or mutating metadata: ${id}/${inline ? 'inline' : 'rows'}`, async () => {
      const env = { SETUP_SECRET: 'fixture-secret-for-mixed-draft-at-least-32-characters' };
      const song = { id, language: null, title: 'Fixture', artist: 'Singer' };
      const beforeSong = structuredClone(song);
      const lines = inline ? [{ time: 1, text: '我轻声说 I love you' }]
        : [{ time: 1, text: '风吹过窗前' }, { time: 2, text: 'I will wait for you' }];
      const response = { language: 'zh', match: 0.9 };
      const db = { prepare: () => assert.fail('Draft processing must not read or write shared catalog metadata') };
      let calls = 0;
      const config = { provider: 'openai', model: 'fixture', targetLanguage: 'zh', completionEnabled: true,
        automaticCompletionEnabled: true, translateLyrics: true, detectLanguage: true, cleanDirtyLyrics: false };
      const result = await scopedDraft({ env, db, song, lines, translationLanguage: 'zh', actorAccountId: 'owner', etag: 'v1',
        deps: { aiAccess: { db, lease: {}, config, client: { assertCurrent: async () => {}, ask: async () => { calls++; return response; } } },
          reserveDailyQuota: async () => true } });
      assert.equal(result.status, 'ready');
      assert.deepEqual(result.lines.map(line => line.tlyric || ''), inline ? [''] : ['', '']);
      assert.deepEqual(result.lines.map(({ tlyric, ...line }) => line), lines);
      assert.deepEqual(song, beforeSong);
      assert.equal(result.inferredLanguage, 'zh');
      assert.equal(result.translationLanguage, null);
      const textHash = (await import('node:crypto')).createHash('sha256').update(lines.map(line => line.text).join('\n')).digest('hex');
      const receipt = await verifyLyricDraftReceiptData(env, result.receipt,
        { songId: id, accountId: 'owner', etag: 'v1', textHash });
      assert.equal(receipt.decision.status, 'not_needed');
      assert.equal(receipt.decision.hasForeignPassages, undefined);
      assert.equal(calls, 1);
    });
  }
}
