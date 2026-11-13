import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifact, createCatalog, buildArtifacts, normalizeText, prebundleYoutubeWorker } from './publish.mjs';

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'flaretune-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = resolve(root, 'plugins/sample');
  await mkdir(resolve(base, 'client'), { recursive: true });
  await mkdir(resolve(base, 'server/vendor'), { recursive: true });
  await writeFile(resolve(root, 'LICENSE'), 'Synthetic MIT license notice\n');
  await writeFile(resolve(base, 'manifest.json'), JSON.stringify({ id: 'sample', version: '0.1.0', hostApiVersion: 2, apiVersion: 1, name: 'Sample', description: 'Synthetic publisher fixture', icon: 'puzzle', pages: [], entries: [] }));
  await writeFile(resolve(base, 'client/index.jsx'), "import './view.css';\r\nexport default function View() { return null; }\r\n");
  await writeFile(resolve(base, 'client/view.css'), '.sample { color: red; }\r\n');
  await writeFile(resolve(base, 'client/ignored.test.js'), 'this must never ship');
  await writeFile(resolve(base, 'client/credentials.json'), '{"synthetic":"must not ship"}');
  await writeFile(resolve(base, 'server/index.js'), "export { value } from './value.js';\nexport function createHandler(){return {}}\n");
  await writeFile(resolve(base, 'server/value.js'), 'export const value = 7;\n');
  return { root, base };
}

test('artifacts are deterministic, LF-normalized and content-addressed', async t => {
  const { root, base } = await fixture(t);
  const first = await createArtifact('sample', { root });
  await writeFile(resolve(base, 'client/index.jsx'), "import './view.css';\nexport default function View() { return null; }\n");
  const second = await createArtifact('sample', { root });
  assert.equal(first.digest, second.digest);
  assert.equal(first.digest, createHash('sha256').update(first.bytes).digest('hex'));
  assert.ok(first.path.endsWith(`${first.digest}.json`));
  assert.equal(first.artifact.exports['client/index.jsx'], 'client/index.js');
  assert.ok(Object.keys(first.artifact.files).every(path => !/test|credential/.test(path)));
  assert.ok(Object.values(first.artifact.files).every(text => !text.includes('\r') && !text.includes(root)));
  assert.ok(first.artifact.files['client/index.js'].includes('./index.css'));
  assert.equal(normalizeText('\uFEFFa\r\nb\rc'), 'a\nb\nc');
  await buildArtifacts({ root });
  assert.deepEqual(await readFile(resolve(root, first.path)), first.bytes);
});

test('catalog requires an immutable commit and points directly to matching artifact bytes', async t => {
  const { root } = await fixture(t);
  const artifact = await createArtifact('sample', { root });
  for (const ref of ['main', 'v0.1.0', 'a'.repeat(39), 'a'.repeat(41)]) assert.throws(() => createCatalog([artifact], ref), { code: 'PUBLISH_IMMUTABLE_REF_REQUIRED' });
  const ref = 'b'.repeat(40);
  const catalog = createCatalog([artifact], ref);
  assert.equal(catalog.plugins[0].artifact.sha256, artifact.digest);
  assert.equal(catalog.plugins[0].artifact.url, `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/${ref}/${artifact.path}`);
});

test('relative imports cannot escape the plugin package', async t => {
  const { root, base } = await fixture(t);
  await writeFile(resolve(root, 'outside.js'), 'export default 1');
  await writeFile(resolve(base, 'client/index.jsx'), "import outside from '../../../outside.js'; export default outside;");
  await assert.rejects(createArtifact('sample', { root }));
});

test('invalid assets are rejected before publication', async t => {
  const { root, base } = await fixture(t);
  await writeFile(resolve(base, 'client/payload.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_ASSET_INVALID' });
});
test('server WASM remains a digest-checked asset with valid chunk-relative imports', async t => {
  const { root, base } = await fixture(t);
  const vendor = resolve(root, 'node_modules/@jitl/quickjs-wasmfile-release-sync');
  await mkdir(vendor, { recursive: true });
  await writeFile(resolve(vendor, 'package.json'), JSON.stringify({ name: '@jitl/quickjs-wasmfile-release-sync', version: '0.32.0', license: 'MIT' }));
  await writeFile(resolve(vendor, 'LICENSE'), 'Synthetic vendor license notice');
  const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
  await writeFile(resolve(base, 'server/vendor/test.wasm'), wasm);
  await writeFile(resolve(base, 'server/value.js'), "import wasm from './vendor/test.wasm'; export const value = wasm;");
  const { artifact } = await createArtifact('sample', { root });
  const asset = artifact.assets['server/vendor/test.wasm'];
  assert.equal(asset.size, wasm.length);
  assert.equal(asset.sha256, createHash('sha256').update(wasm).digest('hex'));
  assert.deepEqual(Buffer.from(asset.data, 'base64'), wasm);
  let imports = 0;
  for (const [path, source] of Object.entries(artifact.files)) {
    for (const match of source.matchAll(/["']([^"']+\.wasm)["']/g)) {
      imports++;
      assert.ok(Object.hasOwn(artifact.assets, posix.normalize(posix.join(posix.dirname(path), match[1]))));
    }
  }
  assert.ok(imports > 0);
});
test('excluded credential and fixture files cannot enter through transitive imports', async t => {
  const { root, base } = await fixture(t);
  await writeFile(resolve(base, 'client/index.jsx'), "import hidden from './credentials.json'; export default hidden;");
  await assert.rejects(createArtifact('sample', { root }));
});

test('generated chunks stay within their execution side and retain public keys', async t => {
  const { root, base } = await fixture(t);
  await mkdir(resolve(base, 'shared'), { recursive: true });
  await writeFile(resolve(base, 'shared/common.js'), 'export function common(value) { return value + 17; }');
  for (const side of ['client', 'server']) {
    await writeFile(resolve(base, side, 'first.js'), "import { common } from '../shared/common.js'; export const first = common(1);");
    await writeFile(resolve(base, side, 'second.js'), "import { common } from '../shared/common.js'; export const second = common(2);");
  }
  const { artifact } = await createArtifact('sample', { root });
  const paths = Object.keys(artifact.files);
  assert.ok(paths.every(path => /^(?:client|server|shared)\//.test(path)));
  assert.ok(paths.some(path => path.startsWith('client/_chunks/')));
  assert.ok(paths.some(path => path.startsWith('server/_chunks/')));
  assert.equal(artifact.exports['shared/common.js'], 'shared/common.js');
  assert.equal(artifact.exports['client/index.jsx'], 'client/index.js');
  for (const [path, code] of Object.entries(artifact.files).filter(([path]) => path.endsWith('.js'))) {
    for (const match of code.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      if (!match[1].startsWith('.')) continue;
      const target = posix.normalize(posix.join(posix.dirname(path), match[1]));
      assert.ok(Object.hasOwn(artifact.files, target), path + ' -> ' + target);
      const side = path.split('/')[0];
      assert.ok(target.startsWith(side + '/') || target.startsWith('shared/'), path + ' -> ' + target);
    }
  }
});

for (const [from, to] of [['client', 'server'], ['server', 'client'], ['shared', 'server'], ['shared', 'client']]) {
  test(from + ' source cannot import ' + to + ' source', async t => {
    const { root, base } = await fixture(t);
    await mkdir(resolve(base, from), { recursive: true });
    await writeFile(resolve(base, to, 'side-value.js'), 'export const value = 7;');
    await writeFile(resolve(base, from, 'side-escape.js'), "export { value } from '../" + to + "/side-value.js';");
    await assert.rejects(createArtifact('sample', { root }), /PUBLISH_SIDE_IMPORT_INVALID/);
  });
}

test('a shared source cannot hide a server WASM dependency', async t => {
  const { root, base } = await fixture(t);
  await mkdir(resolve(base, 'shared'), { recursive: true });
  await writeFile(resolve(base, 'server/vendor/test.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(resolve(base, 'shared/wasm.js'), "import wasm from '../server/vendor/test.wasm'; export default wasm;");
  await writeFile(resolve(base, 'server/value.js'), "export { default as value } from '../shared/wasm.js';");
  await assert.rejects(createArtifact('sample', { root }), /PUBLISH_ASSET_INVALID/);
});


test('the text limit applies to raw public JSON files', async t => {
  const { root, base } = await fixture(t);
  await mkdir(resolve(base, 'shared'), { recursive: true });
  await writeFile(resolve(base, 'shared/large.json'), JSON.stringify('x'.repeat(2 * 1024 * 1024)));
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_TEXT_TOO_LARGE' });
});

test('the artifact limit includes JSON wire escaping', async t => {
  const { root, base } = await fixture(t);
  await mkdir(resolve(base, 'shared'), { recursive: true });
  // Each text file is below 2 MiB; escaping its backslashes on the wire pushes
  // the complete JSON package beyond 4 MiB.
  for (const name of ['first', 'second']) await writeFile(resolve(base, 'shared', name + '.json'), JSON.stringify('\\'.repeat(640 * 1024)));
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_ARTIFACT_TOO_LARGE' });
});

test('oversized server WASM is rejected even when its header is valid', async t => {
  const { root, base } = await fixture(t);
  const wasm = Buffer.alloc(2 * 1024 * 1024 + 1);
  Buffer.from([0,97,115,109,1,0,0,0]).copy(wasm);
  await writeFile(resolve(base, 'server/vendor/large.wasm'), wasm);
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_ASSET_INVALID' });
});


test('an npm release with omitted license files uses only its exact reviewed license copies', async t => {
  const { root, base } = await fixture(t);
  const vendor = resolve(root, 'node_modules/@bufbuild/protobuf');
  const saved = resolve(root, 'tooling/licenses/bufbuild-protobuf-2.17.0');
  await mkdir(vendor, { recursive: true });
  await mkdir(saved, { recursive: true });
  const pkg = { name: '@bufbuild/protobuf', version: '2.17.0', license: '(Apache-2.0 AND BSD-3-Clause)', main: 'index.js' };
  await writeFile(resolve(vendor, 'package.json'), JSON.stringify(pkg));
  await writeFile(resolve(vendor, 'index.js'), 'export const value = 7;');
  await writeFile(resolve(base, 'server/value.js'), "export { value } from '@bufbuild/protobuf';");
  for (const file of ['LICENSE-APACHE.txt', 'LICENSE-BSD.txt']) await writeFile(resolve(saved, file), await readFile(new URL('./licenses/bufbuild-protobuf-2.17.0/' + file, import.meta.url)));
  const { artifact } = await createArtifact('sample', { root });
  const notice = JSON.parse(artifact.files['shared/NOTICE.json']).dependencies.find(value => value.name === pkg.name);
  assert.deepEqual(Object.keys(notice.licenses).sort(), ['LICENSE-APACHE.txt', 'LICENSE-BSD.txt']);
  await writeFile(resolve(saved, 'LICENSE-BSD.txt'), 'Edited license');
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_DEPENDENCY_LICENSE_DIGEST_MISMATCH' });
  await writeFile(resolve(vendor, 'package.json'), JSON.stringify({ ...pkg, version: '2.17.1' }));
  await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_DEPENDENCY_LICENSE_MISSING' });
});


test('public CSS and JSON source keys map to preserved text files', async t => {
  const { root, base } = await fixture(t);
  await mkdir(resolve(base, 'shared'), { recursive: true });
  await writeFile(resolve(base, 'shared/defaults.json'), '{"enabled":true}\r\n');
  const { artifact } = await createArtifact('sample', { root });
  assert.equal(artifact.exports['client/view.css'], 'client/view.css');
  assert.equal(artifact.files[artifact.exports['client/view.css']], '.sample { color: red; }\n');
  assert.equal(artifact.exports['shared/defaults.json'], 'shared/defaults.json');
  assert.deepEqual(JSON.parse(artifact.files[artifact.exports['shared/defaults.json']]), { enabled: true });
  assert.ok(!Object.hasOwn(artifact.exports, 'client/credentials.json'));
  assert.ok(!Object.hasOwn(artifact.exports, 'shared/NOTICE.json'));
});


test('the locked YouTube worker vendor initializes before derived live-chat classes', async () => {
  const { code, metafile } = await prebundleYoutubeWorker();
  assert.ok(Object.keys(metafile.inputs).some(path => path.includes('node_modules/youtubei.js/')));
  const vendor = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  assert.equal(typeof vendor.Innertube, 'function');
  assert.equal(typeof vendor.YTNodes.LiveChat, 'function');
});

test('SDK3 packages retain schema2 and keep internal resolvers outside public exports', async t => {
  const { root, base } = await fixture(t);
  const manifestPath = resolve(base, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.hostApiVersion = 3;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(resolve(base, 'server/_private'), { recursive: true });
  await writeFile(resolve(base, 'server/_private/value.js'), 'export const internalValue = 93;');
  await writeFile(resolve(base, 'server/value.js'), "import { internalValue } from './_private/value.js'; export const value = internalValue;");
  const { artifact } = await createArtifact('sample', { root });
  assert.equal(artifact.schemaVersion, 2);
  assert.equal(artifact.manifest.hostApiVersion, 3);
  assert.ok(Object.hasOwn(artifact.files, 'server/_private/value.js'));
  assert.ok(Object.keys(artifact.exports).every(key => !key.split('/').includes('_private')));
  assert.ok(Object.values(artifact.exports).every(path => !path.split('/').includes('_private')));
});

test('consumer imports cannot name a provider private credential module', async t => {
  const { root, base } = await fixture(t);
  await writeFile(resolve(base, 'server/value.js'), "import { secret } from '@flaretune/plugin-service/provider/server/_private/secrets.js'; export const value = secret;");
  await assert.rejects(createArtifact('sample', { root }));
});

for (const hostApiVersion of [2, 3, 4, 5]) {
  test('schema-2 publisher preserves the minimum host API requirement: ' + hostApiVersion, async t => {
    const { root, base } = await fixture(t);
    const file = resolve(base, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...manifest, hostApiVersion }));
    const built = await createArtifact('sample', { root });
    assert.equal(built.artifact.schemaVersion, 2);
    assert.equal(built.artifact.manifest.hostApiVersion, hostApiVersion);
    assert.equal(built.digest, createHash('sha256').update(built.bytes).digest('hex'));
    assert.equal(JSON.parse(built.bytes).manifest.hostApiVersion, hostApiVersion);
  });
}

test('publisher rejects unsupported minimum host API values without reinterpreting old artifact schemas', async t => {
  const { root, base } = await fixture(t);
  const file = resolve(base, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  for (const hostApiVersion of [0, 1, 6, '2', '3', '4', '5', null]) {
    await writeFile(file, JSON.stringify({ ...manifest, hostApiVersion }));
    await assert.rejects(createArtifact('sample', { root }), { code: 'PUBLISH_MANIFEST_INVALID' });
  }
});
