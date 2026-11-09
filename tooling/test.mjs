import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] || 'all';
if (!['all', 'plugins'].includes(mode)) throw new Error('PLUGIN_TEST_MODE_INVALID');
const tests = [];
async function visit(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ['node_modules', 'fixtures', '__fixtures__'].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('PLUGIN_TEST_SYMLINK_UNSUPPORTED');
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (/\.test\.(?:js|jsx|mjs|cjs)$/.test(entry.name)) tests.push(file);
  }
}
async function run(files, extra = []) {
  if (!files.length) throw new Error('PLUGIN_TEST_FILES_MISSING');
  const child = spawn(process.execPath, [...extra, '--test', ...files], { cwd: root, stdio: 'inherit', shell: false, windowsHide: true });
  return new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('PLUGIN_TEST_PROCESS_FAILED')));
    child.once('exit', code => accept(code ?? 1));
  });
}
if (mode === 'all') {
  const publisher = (await readdir(resolve(root, 'tooling'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(root, 'tooling', name));
  const result = await run(publisher);
  if (result !== 0) { process.exitCode = result; }
}
if (!process.exitCode) {
  for (const plugin of (await readdir(resolve(root, 'plugins'), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (plugin.isSymbolicLink()) throw new Error('PLUGIN_TEST_SYMLINK_UNSUPPORTED');
    if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue;
    for (const side of ['client', 'server', 'shared']) await visit(resolve(root, 'plugins', plugin.name, side));
  }
  process.exitCode = await run(tests, ['--import', pathToFileURL(resolve(root, 'tooling/test-register.mjs')).href]);
}
