import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTestModule } from './translation.fixture.js';
const { dominantLyricTranslationNeed } = await loadTestModule(new URL('./languageAssessment.js', import.meta.url));
test('a Chinese-tagged song remains no-translation with foreign inserts and vocal sounds', () => {
  const artifact = { status: 'ready', textHash: 'a'.repeat(64), original: { lines: [
    { text: '我在窗前等候' }, { text: 'A Ha' }, { text: 'Stay here beside me' }, { text: '我在舞台SHOW HA' },
  ] } };
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'zh' }, { targetLanguage: 'zh' }).state, 'not_needed');
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'zh' }, { targetLanguage: 'en' }).state, 'needed');
});
test('foreign writing never guesses a language for an untagged song', () => {
  const artifact = { status: 'ready', textHash: 'a'.repeat(64), original: { lines: [{ text: 'A Ha' }, { text: '我在窗前等候' }] } };
  assert.equal(dominantLyricTranslationNeed(artifact, { language: 'other' }, { targetLanguage: 'zh' }).state, 'unknown');
});
// Per-line vocalization and mixed-segment exception machinery is intentionally
// replaced by whole-song predominant language. No special SHOW/HA song rule.
