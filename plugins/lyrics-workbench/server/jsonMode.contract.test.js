import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { completionCapabilities } from './translation.fixture.js';

// Exercise the real gateway transport, not a mock of client.ask. DeepSeek
// rejects JSON mode when the actual messages do not mention JSON explicitly.
const bundled = await build({
  stdin: { contents: `
    export { askAI } from '../../ai-gateway/server/ai.js';
    export * from './translationFormat.js';
    export * from './languageAssessment.js';
    export * from './translation.js';
    export { buildReadyLyricArtifact } from '@flaretune/plugin-sdk/server/lyric-workflow';
  `, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'public-lyric-capabilities', setup(api) {
    api.onResolve({ filter: /^@flaretune\// }, args => ({ path: args.path, namespace: 'capabilities' }));
    api.onLoad({ filter: /.*/, namespace: 'capabilities' }, () => ({ contents: completionCapabilities, loader: 'js' }));
  } }],
});
const runtime = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const config = { provider: 'deepseek', source: 'deepseek', protocol: 'chat_completions',
  model: 'deepseek-flash', exactModel: true, targetLanguage: 'zh',
  completionEnabled: true, translateLyrics: true, cleanDirtyLyrics: false };
const env = { DEEPSEEK_API_KEY: 'synthetic-test-key' };

function strictDeepSeek(t, answer) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input?.url || input));
    assert.equal(url.origin, 'https://api.deepseek.com', 'No external fetch is permitted by this fixture');
    assert.equal(url.pathname, '/chat/completions');
    const request = JSON.parse(options.body);
    const hasJson = request.messages.some(message => /json/i.test(String(message.content)));
    const payload = JSON.parse(request.messages.find(message => message.role === 'user').content);
    calls.push({ model: request.model, format: request.response_format?.type, hasJson,
      units: payload.units?.length || 0, cleanup: Array.isArray(payload.cleanupUnits) });
    if (request.response_format?.type === 'json_object' && !hasJson) {
      // Deliberately generic: a provider rejection must never echo lyric data.
      return Response.json({ error: { message: 'JSON mode requires an explicit JSON instruction',
        type: 'invalid_request_error' } }, { status: 400 });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify(answer(payload)),
    } }] });
  });
  return calls;
}

function assertOneJsonCall(calls, units, cleanup = false) {
  assert.equal(calls.length, 1, 'A valid first response must not need a repair request');
  assert.deepEqual(calls[0], { model: 'deepseek-flash', format: 'json_object', hasJson: true, units, cleanup });
}

test('25-unit translation succeeds on the first real gateway JSON-mode request', async t => {
  const units = Array.from({ length: 25 }, (_, unitId) => ({ unitId, text: `I wait beside the window ${unitId}` }));
  const calls = strictDeepSeek(t, data => ({ translations: data.units.map(({ unitId }) => ({ unitId, text: `我在窗边等你第${unitId}次` })) }));
  const response = await runtime.askAI(runtime.buildTranslationPrompt(units, 'Fixture', 'Singer', { targetLanguage: 'zh' }), config, env)
    .then(value => ({ value }), error => ({ code: error.message }));
  assertOneJsonCall(calls, 25);
  assert.equal(response.code, undefined, 'The strict provider must accept the original translation request');
  const translated = runtime.parseTranslationResponse(response.value, units, { targetLanguage: 'zh' });
  assert.equal(translated.length, 25);
  assert.deepEqual(translated.map(row => row.unitId), units.map(row => row.unitId));
});

test('dominant-language classification already satisfies the real gateway JSON contract', async t => {
  const calls = strictDeepSeek(t, () => ({ language: 'en', match: 0.99 }));
  const original = { lines: [{ time: 1, text: 'I wait beside the window' }, { time: 4, text: 'I will see you again' }] };
  const response = await runtime.askAI(runtime.buildLanguageAssessmentPrompt(original, { title: 'Fixture' }), config, env);
  assertOneJsonCall(calls, 2);
  assert.deepEqual(runtime.parseLanguageAssessmentResponse(response), { language: 'en', match: 0.99 });
});

test('explicit cleanup-only completes through the real gateway on its first JSON-mode request', async t => {
  const calls = strictDeepSeek(t, () => ({ discardLineIndices: [0] }));
  const song = { id: 'json-mode-fixture', title: 'Fixture', artist: 'Singer', language: 'en' };
  const kept = { time: 1.0006, endTime: 4.0006, text: 'I wait beside the window',
    words: [{ text: 'I wait beside the window', startTime: 1.0006, endTime: 4.0006 }] };
  let artifact = (await runtime.buildReadyLyricArtifact(song, { source: 'manual', format: 'lyricsfile',
    syncMode: 'word', lines: [{ time: 0, text: 'Lyrics by Fixture' }, kept] })).artifact;
  const startedAt = new Date().toISOString();
  artifact.aiCompletion = { status: 'pending', updatedAt: startedAt };
  let revision = 1;
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: `v${revision}` });
  const store = { get: async () => read(), putIfMatch: async (_id, value, etag) => {
    if (etag !== `v${revision}`) return { state: 'conflict' };
    artifact = structuredClone(value); revision++;
    return { ...read(), state: 'updated' };
  } };
  const cleanupConfig = { ...config, translateLyrics: false, cleanDirtyLyrics: true };
  const access = { config: cleanupConfig, db: {}, lease: {}, client: {
    assertCurrent: async () => {}, ask: (messages, _options, timeout) => runtime.askAI(messages, cleanupConfig, env, timeout),
  } };
  const result = await runtime.runLyricAssetAiCompletion({ env, db: {}, song, store, startedAt,
    textHash: artifact.textHash, deps: { aiAccess: access, reserveDailyQuota: async () => true } });
  assertOneJsonCall(calls, 0, true);
  assert.equal(result.state, 'updated');
  assert.equal(artifact.aiCompletion.status, 'completed');
  assert.deepEqual(artifact.original.lines, [kept], 'Explicit cleanup preserves the retained sung text and word timing');
  assert.equal(artifact.translation, null);
  assert.equal(artifact.translationDecision.status, 'needed', 'Cleanup does not claim the foreign song needs no translation');
});
