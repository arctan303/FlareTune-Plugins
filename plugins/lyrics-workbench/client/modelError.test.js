import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '@flaretune/plugin-sdk';
import { modelErrorMessage } from './modelError.js';
import { createLyricsWorkspaceApi } from './api.js';
test('all five locales explain model initialization and gateway failures', () => {
  const seen = new Set();
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
    setUiLanguage(locale); seen.add(modelErrorMessage({ code: 'PLUGIN_UPDATE_REQUIRED' }));
    for (const code of ['AI_PROVIDER_MISSING', 'AI_PROVIDER_UNCONFIGURED', 'AI_CONFIG_INVALID', 'PLUGIN_SERVICE_INCOMPATIBLE']) assert.ok(modelErrorMessage({ code }));
  }
  assert.equal(seen.size, 5); setUiLanguage('zh');
});
test('missing gateway prevents only AI calls while ordinary lyric reads and edits still reach the host', async () => {
  const calls = [], host = { isCurrent: () => true, session: { get: () => ({ user: { role: 'admin' } }) },
    features: { isAvailable: () => false }, request: async (...args) => { calls.push(args); return { ok: true }; } };
  const api = createLyricsWorkspaceApi(host);
  await api.getLyrics('song'); await api.saveLyricsDocument('song', { lines: [{ time: 0, text: 'Keep this text' }], etag: 'e' });
  assert.equal(calls.length, 2);
  await assert.rejects(api.completeLyricsTranslation('song'), error => error.code === 'PLUGIN_DEPENDENCY_UNAVAILABLE'
    && error.message === modelErrorMessage({ code: error.code }));
  assert.equal(calls.length, 2);
});
