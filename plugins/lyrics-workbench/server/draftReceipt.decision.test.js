import test from 'node:test';
import assert from 'node:assert/strict';
import { createLyricDraftReceipt, verifyLyricDraftReceipt, verifyLyricDraftReceiptData } from './draftReceipt.js';

const env = { SETUP_SECRET: 'fixture-secret-for-lyric-draft-at-least-32-characters' };
const context = { songId: 'yt:abcdefghijk', accountId: 'owner', etag: 'v1', textHash: 'a'.repeat(64), now: 1_800_000_000_000 };
const decision = { status: 'not_needed', targetLanguage: 'zh', sourceLanguage: 'zh', basis: 'ai', policyVersion: 1 };
test('the opaque draft receipt carries a signed decision without changing language verification', async () => {
  const token = await createLyricDraftReceipt(env, { ...context, language: 'zh', decision });
  assert.equal(await verifyLyricDraftReceipt(env, token, context), 'zh');
  assert.deepEqual(await verifyLyricDraftReceiptData(env, token, context), { language: 'zh', decision });
});
test('a draft decision cannot be moved to another account, song, body or ETag', async () => {
  const token = await createLyricDraftReceipt(env, { ...context, language: 'zh', decision });
  for (const changed of [{ songId: 'other' }, { accountId: 'other' }, { etag: 'v2' }, { textHash: 'b'.repeat(64) },
    { now: context.now + 16 * 60_000 }]) assert.equal(await verifyLyricDraftReceiptData(env, token, { ...context, ...changed }), null);
});
test('editing the signed decision invalidates the receipt', async () => {
  const token = await createLyricDraftReceipt(env, { ...context, language: 'zh', decision });
  const [payload, signature] = token.split('.');
  const json = JSON.parse(Buffer.from(payload, 'base64url').toString());
  json.decision.targetLanguage = 'en';
  assert.equal(await verifyLyricDraftReceiptData(env, Buffer.from(JSON.stringify(json)).toString('base64url') + '.' + signature, context), null);
});
