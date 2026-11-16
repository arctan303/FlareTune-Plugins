import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const loader = fileURLToPath(new URL('./test-register.mjs', import.meta.url));

async function fixture(t, { dependency, optionalDependency, specifier = '@flaretune/plugin-service/provider/server/value.js' } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'flaretune-test-register-'));
  const temporaryRoot = resolve(temporary);
  t.after(async () => {
    if (!temporaryRoot.startsWith(resolve(tmpdir()) + sep)) throw new Error('Fixture cleanup escaped its temporary directory');
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  // Exercise a real ESM import beneath the same nested "plugins" directory
  // shape as the local multi-repository workspace and its isolated worktrees.
  const root = join(temporary, 'outer', 'plugins', 'checkout');
  await mkdir(join(root, 'tooling'), { recursive: true });
  await mkdir(join(root, 'plugins', 'consumer', 'client'), { recursive: true });
  await mkdir(join(root, 'plugins', 'consumer', 'server'), { recursive: true });
  await mkdir(join(root, 'plugins', 'provider', 'server'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(root, 'tooling', 'test-register.mjs'), await readFile(loader));
  await writeFile(join(root, 'tooling', 'test-sdk.mjs'), 'export const fixture = true;\n');
  await writeFile(join(root, 'plugins', 'consumer', 'manifest.json'), JSON.stringify({ id: 'consumer',
    ...(dependency ? { dependencies: { provider: {} } } : {}),
    ...(optionalDependency ? { optionalDependencies: { provider: {} } } : {}) }));
  await writeFile(join(root, 'plugins', 'provider', 'server', 'value.js'), "export const value = 'provided';\n");
  await writeFile(join(root, 'plugins', 'consumer', 'server', 'value.js'), "export const value = 'self';\n");
  const entry = join(root, 'plugins', 'consumer', 'client', 'entry.js');
  await writeFile(entry, `import { value } from ${JSON.stringify(specifier)}; console.log(value);\n`);
  return () => run(process.execPath, ['--import', pathToFileURL(join(root, 'tooling', 'test-register.mjs')).href,
    '--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(entry).href)});`],
  { cwd: root, windowsHide: true });
}

test('a nested workspace path cannot replace the declared consuming-plugin identity', async t => {
  const execute = await fixture(t, { dependency: true });
  assert.equal((await execute()).stdout.trim(), 'provided');
});

test('optional service dependencies still work beneath an outer plugins directory', async t => {
  const execute = await fixture(t, { optionalDependency: true });
  assert.equal((await execute()).stdout.trim(), 'provided');
});

test('the actual consumer must declare a cross-plugin service dependency', async t => {
  const execute = await fixture(t);
  await assert.rejects(execute(), error => error.stderr.includes('Undeclared test service') && !error.stderr.includes('ENOENT'));
});

test('same-plugin service imports keep their owner without an extra dependency', async t => {
  const execute = await fixture(t, { specifier: '@flaretune/plugin-service/consumer/server/value.js' });
  assert.equal((await execute()).stdout.trim(), 'self');
});

test('declared dependencies do not permit escaping the provider package', async t => {
  const execute = await fixture(t, { dependency: true,
    specifier: '@flaretune/plugin-service/provider/../../consumer/server/value.js' });
  await assert.rejects(execute(), error => error.stderr.includes('Invalid test service path'));
});
