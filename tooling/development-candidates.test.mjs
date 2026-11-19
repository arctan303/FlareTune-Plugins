import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = async id => JSON.parse(await readFile(new URL(`../plugins/${id}/manifest.json`, import.meta.url), 'utf8'));

test('whole-song workbench and request-authorized gateway declare API6 without changing service or data versions', async () => {
  const workbench = await manifest('lyrics-workbench'), gateway = await manifest('ai-gateway');
  assert.equal(workbench.version, '1.1.0'); assert.equal(gateway.version, '0.2.3');
  for (const item of [workbench, gateway]) {
    assert.equal(item.hostApiVersion, 6); assert.equal(item.apiVersion, 1); assert.equal(item.dataVersion, 0);
    assert.deepEqual(item.supportedLocales, ['zh', 'zh-Hant', 'en', 'ja', 'ko']);
    assert.equal(item.pages.find(page => page.id === 'configuration').scope, 'instance');
    assert.deepEqual(item.pages.find(page => page.id === 'configuration').roles, ['admin']);
  }
  assert.deepEqual(workbench.optionalDependencies['ai-gateway'], { apiVersion: 1, version: '^0.2.3', features: ['ai'] });
  assert.deepEqual(workbench.capabilityRoles, ['admin', 'member']);
  for (const id of ['current', 'tools', 'candidates']) {
    assert.deepEqual(workbench.pages.find(page => page.id === id).roles, ['admin', 'member']);
  }
});

test('an unchanged older consumer version range still accepts gateway 0.2.3', async () => {
  const assistant = await manifest('assistant'), gateway = await manifest('ai-gateway');
  assert.equal(assistant.dependencies['ai-gateway'].apiVersion, gateway.apiVersion);
  assert.equal(assistant.dependencies['ai-gateway'].version, '^0.2.0');
  assert.equal(gateway.version, '0.2.3');
});
