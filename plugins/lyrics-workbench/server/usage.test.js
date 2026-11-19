import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveDailyQuota } from './usage.js';
import { loadTestModule } from './translation.fixture.js';
const { getDailyLyricCompletionLimit } = await loadTestModule(new URL('./translation.js', import.meta.url));

test('only explicitly configured instance limits are enforced; invalid values fail closed', () => {
  assert.equal(getDailyLyricCompletionLimit({}), null);
  assert.equal(getDailyLyricCompletionLimit({ AI_TRANSLATION_DAILY_LIMIT: '0' }), 0);
  assert.equal(getDailyLyricCompletionLimit({ AI_TRANSLATION_DAILY_LIMIT: '51' }), 51);
  assert.equal(getDailyLyricCompletionLimit({ AI_TRANSLATION_DAILY_LIMIT: '1000' }), 1000);
  assert.throws(() => getDailyLyricCompletionLimit({ AI_TRANSLATION_DAILY_LIMIT: 'invalid' }), /AI_CONFIG_INVALID/u);
});
test('daily usage is one statistics write without a default hard limit', async () => {
  let writes = 0;
  const db = { prepare: sql => { assert.equal(sql.includes('WHERE AI_Daily_Usage'), false);
    return { bind: (...args) => { assert.deepEqual(args, ['2026-11-19', 123]); return {
      run: async () => { writes++; return { results: [{ generation_count: 500 }] }; } }; } }; } };
  assert.equal(await reserveDailyQuota(db, '2026-11-19', null, 123), true); assert.equal(writes, 1);
});
test('explicit finite limits, including zero, retain their instance-owned meaning', async () => {
  let writes = 0;
  const db = { prepare: sql => { assert.ok(sql.includes('WHERE AI_Daily_Usage.generation_count < ?'));
    return { bind: (...args) => { assert.deepEqual(args, ['2026-11-19', 123, 2]); return {
      run: async () => { writes++; return { results: [] }; } }; } }; } };
  assert.equal(await reserveDailyQuota(db, '2026-11-19', 0, 123), false); assert.equal(writes, 0);
  assert.equal(await reserveDailyQuota(db, '2026-11-19', 2, 123), false); assert.equal(writes, 1);
});
