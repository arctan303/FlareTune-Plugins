import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { beginLyricAssetAiCompletion, buildReadyLyricArtifact, projectLyricArtifact } = await loadTestModule(new URL('./translation.js', import.meta.url), { workflow: true });

async function fixture({ language = 'other', targetLanguage = 'zh', texts = ['风吹过窗前'], ask,
  id = 'yt:abcdefghijk', updateSongLanguage, metadataLanguage, title = 'Fixture',
  beginCompletion = beginLyricAssetAiCompletion } = {}) {
  const song = { id, title, artist: 'Singer', language };
  let artifact = (await buildReadyLyricArtifact(song, { source: 'manual', format: 'lrc',
    lines: texts.map((text, index) => ({ text, time: index + 1 })) })).artifact;
  let revision = 1;
  const calls = { ai: 0, quota: 0 };
  const read = () => ({ state: 'found', artifact: structuredClone(artifact), etag: String(revision) });
  const store = { get: async () => read(), putIfMatch: async (_id, next, etag) => {
    if (etag !== String(revision)) return { state: 'conflict' };
    artifact = structuredClone(next); revision++; return { ...read(), state: 'updated' };
  } };
  const config = { targetLanguage, provider: 'openai', model: 'fixture', completionEnabled: true, automaticCompletionEnabled: true,
    translateLyrics: true, detectLanguage: false, cleanDirtyLyrics: false, referenceExistingTranslation: false };
  const start = (options = {}) => beginCompletion({ env: {}, db: {}, song, store, force: options.force,
    targetLanguage: config.targetLanguage, deps: { aiAccess: { config, db: metadataLanguage ? {
      prepare: () => ({ bind() { return this; }, first: async () => ({ language: metadataLanguage }) }),
    } : {}, lease: {}, client: {
      assertCurrent: async () => {}, ask: async (...args) => { calls.ai++; return ask(...args); },
    } }, updateSongLanguage, reserveDailyQuota: async () => { calls.quota++; return true; } } });
  return { song, store, config, calls, start };
}

test('unknown Chinese paraphrase settles to a persistent no-op reused even by force', async () => {
  const f = await fixture({ ask: async () => ({ songLanguage: 'zh', translations: [{ unitId: 0, text: '清风拂过窗边' }] }) });
  const first = await f.start(); await first.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translation, null);
  assert.equal(saved.translationDecision.status, 'not_needed');
  assert.equal(saved.translationDecision.sourceLanguage, 'zh');
  assert.equal(saved.aiCompletion.status, 'completed');
  assert.equal(projectLyricArtifact(saved, { song: f.song, targetLanguage: 'zh' }).translationAvailable, false);
  for (const force of [false, true]) {
    const next = await f.start({ force }); assert.equal(next.state, 'not_needed'); assert.equal(next.task, null);
  }
  assert.deepEqual(f.calls, { ai: 1, quota: 1 });
});

test('force does not bypass a reliable same-target catalog tag', async () => {
  const f = await fixture({ language: 'en', targetLanguage: 'en', texts: ['We sing together'], ask: () => assert.fail('No AI needed') });
  const started = await f.start({ force: true });
  assert.equal(started.state, 'not_needed'); assert.equal(started.task, null);
  assert.deepEqual(f.calls, { ai: 0, quota: 0 });
});

test('unknown or contradictory no-op responses remain failed and never cache not_needed', async () => {
  for (const response of [{ notNeeded: true }, { notNeeded: true, songLanguage: 'other' },
    { notNeeded: true, songLanguage: 'en' }, { notNeeded: true, songLanguage: 'zh', translations: [] }]) {
    const f = await fixture({ ask: async () => response });
    const started = await f.start(); await started.task;
    const saved = (await f.store.get()).artifact;
    assert.equal(saved.aiCompletion.status, 'failed');
    assert.equal(saved.aiCompletion.errorCode, 'invalid_output');
    assert.equal(saved.translationDecision, undefined);
    assert.equal(saved.translation, null);
  }
});

test('a mixed Chinese and English body stores only the foreign row and its language evidence', async () => {
  const f = await fixture({ language: 'zh', texts: ['风吹过窗前', 'I will wait for you'], ask: async () => ({ songLanguage: 'zh',
    unitLanguages: [{ unitId: 0, language: 'zh' }, { unitId: 1, language: 'en' }],
    translations: [{ unitId: 0, text: '清风拂过窗边' }, { unitId: 1, text: '我会等你' }],
  }) });
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.original.lines.map(line => line.text), ['风吹过窗前', 'I will wait for you']);
  assert.deepEqual(saved.translation?.lines, ['', '我会等你']);
  assert.equal(saved.translationDecision.status, 'translated');
  assert.equal(saved.translationDecision.hasForeignPassages, true);
});

test('a changed translation target invalidates the old no-op without deleting the original', async () => {
  const f = await fixture({ ask: async () => f.config.targetLanguage === 'zh' ? { notNeeded: true, songLanguage: 'zh' }
    : { songLanguage: 'zh', translations: [{ unitId: 0, text: 'The wind blows past the window' }] } });
  const first = await f.start(); await first.task;
  f.config.targetLanguage = 'en';
  const second = await f.start(); await second.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(f.calls.ai, 2);
  assert.deepEqual(saved.original.lines.map(line => line.text), ['风吹过窗前']);
  assert.equal(saved.translationDecision.status, 'translated');
  assert.equal(saved.translation.language, 'en');
});

test('a concurrent edit wins over the completion and cannot receive its decision marker', async () => {
  let resolve;
  const waiting = new Promise(accept => { resolve = accept; });
  const f = await fixture({ ask: () => waiting });
  const started = await f.start();
  while (!f.calls.ai) await new Promise(accept => setTimeout(accept, 0));
  const current = await f.store.get();
  const edit = (await buildReadyLyricArtifact(f.song, { source: 'manual', format: 'lrc', lines: [{ time: 1, text: 'A newer edit' }] })).artifact;
  await f.store.putIfMatch(f.song.id, edit, current.etag);
  resolve({ notNeeded: true, songLanguage: 'zh' }); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.original, edit.original);
  assert.equal(saved.translationDecision, undefined);
  assert.equal(saved.aiCompletion, null);
});

test('a failed catalog-language write revokes the new decision instead of caching a failed no-op', async () => {
  const f = await fixture({ id: 'library-song', ask: async () => ({ notNeeded: true, songLanguage: 'zh' }),
    updateSongLanguage: async () => { throw Error('Database write failed'); } });
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision, undefined);
  assert.equal(saved.aiCompletion.status, 'failed');
  assert.equal(saved.aiCompletion.errorCode, 'language_update_failed');
  assert.equal(saved.translation, null);
});

test('a successful local-language update binds translated evidence to the final tag for later reads', async () => {
  const f = await fixture({ id: 'library-song', texts: ['风吹过窗前', 'I will wait for you'],
    updateSongLanguage: async () => ({ meta: { changes: 1 } }), ask: async () => ({ songLanguage: 'zh',
      unitLanguages: [{ unitId: 0, language: 'zh' }, { unitId: 1, language: 'en' }],
      translations: [{ unitId: 0, text: '清风拂过窗边' }, { unitId: 1, text: '我会等你' }],
    }) });
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision.songLanguage, 'zh');
  f.song.language = 'zh';
  assert.equal(projectLyricArtifact(saved, { song: f.song, targetLanguage: 'zh' }).translationAvailable, true);
  const next = await f.start(); assert.equal(next.state, 'already_translated');
  assert.equal(f.calls.ai, 1);
});

test('a lost metadata CAS cannot publish a decision bound to a language that was not committed', async () => {
  const f = await fixture({ id: 'library-song', updateSongLanguage: async () => ({ meta: { changes: 0 } }),
    metadataLanguage: 'fr', ask: async () => ({ notNeeded: true, songLanguage: 'zh' }) });
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.translationDecision, undefined);
  assert.equal(saved.aiCompletion.status, 'failed');
  assert.equal(saved.aiCompletion.errorCode, 'language_update_failed');
});

test('later foreign batches do not force earlier target-language batches to generate rewrites', async () => {
  const texts = [...Array.from({ length: 20 }, (_, index) => '风吹过窗前' + index), 'I will wait for you'];
  const f = await fixture({ texts, ask: async messages => {
    const { units } = JSON.parse(messages.at(-1).content);
    return units[0].unitId === 0 ? { notNeeded: true, songLanguage: 'zh' }
      : { songLanguage: 'en', translations: units.map(unit => ({ unitId: unit.unitId, text: '我会等你' })) };
  } });
  f.config.provider = 'deepseek'; f.config.model = 'deepseek-flash';
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.deepEqual(saved.translation?.lines, [...Array(20).fill(''), '我会等你']);
  assert.equal(saved.translationDecision.hasForeignPassages, true);
  assert.equal(f.calls.ai, 2);
});

test('same-row mixed-language evidence reaches the write gate with only its foreign phrase translated', async () => {
  const f = await fixture({ language: 'zh', texts: ['我轻声说 I love you'], ask: async () => ({ songLanguage: 'zh',
    unitLanguages: [{ unitId: 0, languages: ['zh', 'en'], segments: [
      { text: '我轻声说 ', language: 'zh' }, { text: 'I love you', language: 'en', translation: '我爱你' },
    ] }], translations: [{ unitId: 0, text: '我爱你' }],
  }) });
  const started = await f.start(); await started.task;
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.original.lines[0].text, '我轻声说 I love you');
  assert.deepEqual(saved.translation?.lines, ['我爱你']);
  assert.equal(saved.translationDecision.status, 'translated');
  assert.equal(saved.translationDecision.hasForeignPassages, true);
});

test('a plain title lyric remains a translation unit even when excluded from language analysis', async () => {
  const metadataModule = await loadTestModule(new URL('./translation.js', import.meta.url), { workflow: true, leadingTitleMetadata: true });
  let seenIds, sample;
  const f = await fixture({ language: 'en', title: 'Yesterday', texts: ['Yesterday', 'The morning comes again'],
    beginCompletion: metadataModule.beginLyricAssetAiCompletion, ask: async messages => {
      const payload = JSON.parse(messages.at(-1).content);
      seenIds = payload.units.map(unit => unit.unitId); sample = payload.languageSample;
      return { songLanguage: 'en', translations: payload.units.map(unit => ({ unitId: unit.unitId,
        text: unit.unitId === 0 ? '昨天' : '清晨再次来临' })) };
    } });
  const before = await f.store.get();
  before.artifact.original.lines[0].time = 10;
  await f.store.putIfMatch(f.song.id, before.artifact, before.etag);
  const started = await f.start(); await started.task;
  assert.deepEqual(seenIds, [0, 1]);
  assert.doesNotMatch(sample, /Yesterday/u);
  const saved = (await f.store.get()).artifact;
  assert.equal(saved.original.lines[0].time, 10);
  assert.deepEqual(saved.translation.lines, ['昨天', '清晨再次来临']);
});
