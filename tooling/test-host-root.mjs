import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Test assembly only: CI checks out the reviewed host separately; the local
// workspace keeps its established sibling-repository layout.
export const testHostRoot = resolve(process.env.FLARETUNE_TEST_HOST_ROOT
  || fileURLToPath(new URL('../../server/', import.meta.url)));
// A separately unpacked local source tree may reuse an already-installed,
// lock-matched dependency directory through Node's standard NODE_PATH setting.
export const testHostNodePaths = [resolve(testHostRoot, 'node_modules'),
  ...(process.env.NODE_PATH || '').split(delimiter).filter(Boolean)];

export function testHostFile(path) {
  const file = resolve(testHostRoot, 'server/src', path);
  if (!existsSync(file)) throw new Error(`Missing test host source: ${file}. Set FLARETUNE_TEST_HOST_ROOT to the host repository root.`);
  return file.replaceAll('\\', '/');
}
