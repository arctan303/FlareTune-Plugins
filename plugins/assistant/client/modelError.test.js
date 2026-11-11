import test from 'node:test';
import assert from 'node:assert/strict';
import { setUiLanguage } from '@flaretune/plugin-sdk';
import { modelErrorMessage } from './modelError.js';
import { assistantFailureMessage } from './failure.js';
test('model handoff and missing-provider errors have explicit copy in all five languages', () => {
  const seen = new Set();
  for (const locale of ['zh', 'zh-Hant', 'en', 'ja', 'ko']) {
    setUiLanguage(locale);
    const update = modelErrorMessage({ code: 'PLUGIN_UPDATE_REQUIRED' });
    seen.add(update); assert.ok(update); assert.doesNotMatch(update, /PLUGIN_UPDATE_REQUIRED/);
    for (const code of ['AI_PROVIDER_MISSING', 'AI_PROVIDER_UNCONFIGURED', 'AI_CONFIG_INVALID', 'PLUGIN_SERVICE_INCOMPATIBLE']) {
      assert.ok(modelErrorMessage({ code })); assert.equal(assistantFailureMessage({ code }), modelErrorMessage({ code }));
    }
  }
  assert.equal(seen.size, 5); setUiLanguage('zh');
});
