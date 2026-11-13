import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname, posix, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = path => path.replaceAll('\\', '/');
const sourceExtension = /\.(?:js|mjs|jsx|json|css)$/;
const moduleExtension = /\.(?:js|mjs|jsx)$/;
const idPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const excluded = name => name.startsWith('.') || /^(?:credentials?|secrets?|tokens?)\.json$/i.test(name) || /\.(?:test|spec|fixture)\.[cm]?[jt]sx?$/.test(name)
  || ['node_modules', 'test', 'tests', 'fixtures', '__fixtures__', '__tests__'].includes(name);
export const normalizeText = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return typeof value === 'string' ? normalizeText(value) : value;
}
export const jsonBytes = value => Buffer.from(JSON.stringify(canonical(value)) + '\n');

async function sourcePaths(root, packageRoot) {
  const paths = [];
  async function visit(path) {
    const stat = await lstat(resolve(packageRoot, path));
    if (stat.isSymbolicLink()) fail('PUBLISH_SYMLINK_UNSUPPORTED');
    if (stat.isDirectory()) {
      for (const child of (await readdir(resolve(packageRoot, path))).sort()) if (!excluded(child)) await visit(`${path}/${child}`);
    } else if (stat.isFile()) {
      if (!sourceExtension.test(path) && !path.endsWith('.wasm')) fail('PUBLISH_SOURCE_TYPE_INVALID');
      if (path.endsWith('.wasm') && !path.startsWith('server/')) fail('PUBLISH_ASSET_INVALID');
      paths.push(path);
    }
  }
  for (const section of ['client', 'server', 'shared']) {
    try { await visit(section); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!paths.length) fail('PUBLISH_SOURCE_MISSING');
  return paths.sort();
}

async function dependencyNotices(root, metafile, hasWasm) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const marker = 'node_modules/';
    const path = slash(input);
    if (!path.includes(marker)) continue;
    const tail = path.slice(path.lastIndexOf(marker) + marker.length).split('/');
    names.add(tail[0].startsWith('@') ? tail.slice(0, 2).join('/') : tail[0]);
  }
  if (hasWasm) names.add('@jitl/quickjs-wasmfile-release-sync');
  const notices = [];
  for (const name of [...names].sort()) {
    const base = resolve(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(resolve(base, 'package.json'), 'utf8'));
    const licenses = {};
    for (const path of (await readdir(base)).sort().filter(path => /^licen[cs]e(?:[.-]|$)/i.test(path))) {
      if ((await lstat(resolve(base, path))).isFile()) licenses[path] = normalizeText(await readFile(resolve(base, path), 'utf8'));
    }
    // This exact npm release omits standalone license files. Preserve both
    // declared licenses from reviewed, digest-pinned upstream copies; upgrades
    // or edited copies must be reviewed again instead of silently falling back.
    if (!Object.keys(licenses).length && name === '@bufbuild/protobuf' && pkg.version === '2.17.0'
      && pkg.license === '(Apache-2.0 AND BSD-3-Clause)') {
      const pinned = {
        'LICENSE-APACHE.txt': 'c04b4216f1cd4c5a4f7fb2f2a1b0ae70d847e9e0cac7c9dee9bf8cc03177c449',
        'LICENSE-BSD.txt': '182a1bc8985a586e8e0ca3b5a3af1ff3c28bd3475833a07f50b42b53dd7ac889',
      };
      for (const [file, digest] of Object.entries(pinned)) {
        const path = resolve(root, 'tooling/licenses/bufbuild-protobuf-2.17.0', file);
        if ((await lstat(path)).isSymbolicLink()) fail('PUBLISH_SYMLINK_UNSUPPORTED');
        const bytes = await readFile(path);
        if (sha256(bytes) !== digest) fail('PUBLISH_DEPENDENCY_LICENSE_DIGEST_MISMATCH');
        licenses[file] = normalizeText(bytes.toString('utf8'));
      }
    }
    if (!Object.keys(licenses).length) fail('PUBLISH_DEPENDENCY_LICENSE_MISSING');
    notices.push({ name: pkg.name, version: pkg.version, license: pkg.license || 'SEE LICENSE', licenses });
  }
  return { project: { name: 'FlareTune', license: 'MIT', text: normalizeText(await readFile(resolve(root, 'LICENSE'), 'utf8')) }, dependencies: notices };
}

// youtubei.js has a valid ESM cycle whose initialization order changes when
// esbuild splits its many re-exports together with plugin public entry points.
// First flatten this exact locked worker entry as one ESM module. Its complete
// dependency graph still comes from this repository's lock and contributes to
// NOTICE; the installer never resolves npm packages.
export async function prebundleYoutubeWorker({ root = repositoryRoot } = {}) {
  root = resolve(root);
  const pkg = JSON.parse(await readFile(resolve(root, 'node_modules/youtubei.js/package.json'), 'utf8'));
  if (pkg.name !== 'youtubei.js' || pkg.version !== '18.3.0') fail('PUBLISH_DEPENDENCY_VERSION_UNSUPPORTED');
  const result = await build({ absWorkingDir: root,
    stdin: { contents: "export * from 'youtubei.js/cf-worker';", resolveDir: root, sourcefile: 'flaretune-youtube-worker.js' },
    bundle: true, splitting: false, format: 'esm', platform: 'browser', conditions: ['workerd', 'browser'],
    mainFields: ['browser', 'module', 'main'], target: 'es2022', write: false, metafile: true,
    sourcemap: false, minify: true, keepNames: true, legalComments: 'eof', logLevel: 'silent',
  });
  if (result.outputFiles.length !== 1) fail('PUBLISH_OUTPUT_INVALID');
  return { code: normalizeText(result.outputFiles[0].text), metafile: result.metafile };
}

export async function createArtifact(id, { root = repositoryRoot } = {}) {
  if (!idPattern.test(id)) fail('PUBLISH_PLUGIN_ID_INVALID');
  root = resolve(root);
  const packageRoot = resolve(root, 'plugins', id);
  if ((await lstat(packageRoot)).isSymbolicLink()) fail('PUBLISH_SYMLINK_UNSUPPORTED');
  const manifestPath = resolve(packageRoot, 'manifest.json');
  if ((await lstat(manifestPath)).isSymbolicLink()) fail('PUBLISH_SYMLINK_UNSUPPORTED');
  const manifest = canonical(JSON.parse(await readFile(manifestPath, 'utf8')));
  if (manifest.id !== id || !versionPattern.test(manifest.version) || ![2, 3, 4].includes(manifest.hostApiVersion)) fail('PUBLISH_MANIFEST_INVALID');
  const sources = await sourcePaths(root, packageRoot);
  const entries = Object.fromEntries(['client', 'server'].filter(kind => sources.includes(`${kind}/index.${kind === 'client' ? 'jsx' : 'js'}`))
    .map(kind => [kind, `${kind}/index.js`]));
  if (!Object.keys(entries).length) fail('PUBLISH_ENTRY_MISSING');
  const outdir = resolve(root, '.output', id);
  const wasmPaths = sources.filter(path => path.endsWith('.wasm'));
  const sourceSet = new Set(sources);
  // Each execution side owns its generated chunks. A single splitting build
  // would place shared chunks at the artifact root or mix browser and WASM code.
  const results = [];
  let youtubeModule;
  const youtube = () => youtubeModule ||= prebundleYoutubeWorker({ root });
  for (const side of ['client', 'server', 'shared']) {
    const modules = sources.filter(path => path.startsWith(side + '/') && moduleExtension.test(path));
    if (!modules.length) continue;
    const allowedSide = target => target === side || target === 'shared';
    results.push(await build({ absWorkingDir: root,
      entryPoints: modules.map(path => ({ in: resolve(packageRoot, path), out: path.replace(moduleExtension, '') })),
      outdir, outbase: packageRoot, bundle: true, splitting: true, format: 'esm', platform: 'browser',
      conditions: ['workerd', 'browser'], mainFields: ['browser', 'module', 'main'], target: 'es2022',
      write: false, metafile: true, sourcemap: false, minify: true, keepNames: true, legalComments: 'eof',
      chunkNames: side + '/_chunks/[name]-[hash]', assetNames: side + '/_assets/[name]-[hash]', logLevel: 'silent',
      external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react', '@flaretune/plugin-sdk', '@flaretune/plugin-sdk/*', '@flaretune/plugin-service/*'],
      plugins: [{ name: 'package-boundaries', setup(bundler) {
        bundler.onResolve({ filter: /^youtubei\.js\/cf-worker$/ }, async () => {
          if (side !== 'server') fail('PUBLISH_SIDE_IMPORT_INVALID');
          await youtube();
          return { path: 'youtubei.js/cf-worker', namespace: 'flaretune-youtube-worker' };
        });
        bundler.onLoad({ filter: /.*/, namespace: 'flaretune-youtube-worker' }, async () => ({
          contents: (await youtube()).code, loader: 'js',
        }));
        bundler.onLoad({ filter: /.*/, namespace: 'file' }, args => {
          const packageRelative = slash(relative(packageRoot, args.path));
          const vendorRelative = relative(resolve(root, 'node_modules'), args.path);
          if (!packageRelative.startsWith('..') && !isAbsolute(packageRelative)) {
            if (!sourceSet.has(packageRelative)) fail('PUBLISH_EXCLUDED_IMPORT');
            if (!allowedSide(packageRelative.split('/')[0])) fail('PUBLISH_SIDE_IMPORT_INVALID');
          } else if (vendorRelative.startsWith('..') || isAbsolute(vendorRelative)) fail('PUBLISH_IMPORT_OUTSIDE_PACKAGE');
        });
        bundler.onResolve({ filter: /\.wasm$/ }, args => {
          const resolved = resolve(args.resolveDir, args.path);
          const path = slash(relative(packageRoot, resolved));
          const importer = slash(relative(packageRoot, args.importer));
          if (side !== 'server' || importer.startsWith('shared/') || !sourceSet.has(path) || !path.startsWith('server/')) fail('PUBLISH_ASSET_INVALID');
          return { path: '/__flaretune_asset__/' + path, external: true };
        });
        bundler.onResolve({ filter: /^@flaretune\/plugin-service\// }, args => {
            if (args.path.split('/').includes('_private')) fail('PUBLISH_PRIVATE_SERVICE_IMPORT');
            return { path: args.path, external: true };
          });
          bundler.onResolve({ filter: /^(?:\.|[A-Za-z]:[\\/]|\/)/ }, args => {
          const resolved = resolve(args.resolveDir, args.path);
          const packageRelative = slash(relative(packageRoot, resolved));
          const vendorRelative = relative(resolve(root, 'node_modules'), resolved);
          if (!packageRelative.startsWith('..') && !isAbsolute(packageRelative)) {
            const targetSide = packageRelative.split('/')[0];
            const importer = slash(relative(packageRoot, args.importer));
            const importerSide = importer.split('/')[0];
            if (!allowedSide(targetSide) || (importerSide === 'shared' && targetSide !== 'shared')) fail('PUBLISH_SIDE_IMPORT_INVALID');
          } else if (vendorRelative.startsWith('..') || isAbsolute(vendorRelative)) fail('PUBLISH_IMPORT_OUTSIDE_PACKAGE');
        });
      } }],
    }));
  }
  const metafile = { inputs: Object.assign({}, ...results.map(result => result.metafile.inputs), youtubeModule ? (await youtubeModule).metafile.inputs : {}) };
  const files = {};
  for (const result of results) for (const output of result.outputFiles) {
    const path = slash(relative(outdir, output.path));
    if (!sourceExtension.test(path) || !/^(?:client|server|shared)\//.test(path)) fail('PUBLISH_OUTPUT_INVALID');
    if (Object.hasOwn(files, path)) fail('PUBLISH_OUTPUT_COLLISION');
    let text = normalizeText(output.text);
    const outputMeta = result.metafile.outputs[slash(relative(root, output.path))];
    if (moduleExtension.test(path) && outputMeta?.cssBundle) {
      const cssPath = slash(relative(outdir, resolve(root, outputMeta.cssBundle)));
      const imported = posix.relative(posix.dirname(path), cssPath);
      text = `import ${JSON.stringify(imported.startsWith('.') ? imported : `./${imported}`)};\n${text}`;
    }
    text = text.replace(/(["'])\/__flaretune_asset__\/([^"']+)\1/g, (_, quote, asset) => {
      if (!wasmPaths.includes(asset)) fail('PUBLISH_ASSET_INVALID');
      const imported = posix.relative(posix.dirname(path), asset);
      return `${quote}${imported.startsWith('.') ? imported : `./${imported}`}${quote}`;
    });
    if (text.includes('/__flaretune_asset__/') || text.includes(slash(root))) fail('PUBLISH_OUTPUT_INVALID');
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail('PUBLISH_TEXT_TOO_LARGE');
    files[path] = text;
  }
  for (const path of sources.filter(path => /\.(?:json|css)$/.test(path))) {
    const text = normalizeText(await readFile(resolve(packageRoot, path), 'utf8'));
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail('PUBLISH_TEXT_TOO_LARGE');
    // CSS imported by a module is already emitted by esbuild; preserve raw public
    // paths only when they do not collide with that generated output.
    if (!Object.hasOwn(files, path)) files[path] = text;
  }
  const assets = {};
  for (const path of wasmPaths) {
    const bytes = await readFile(resolve(packageRoot, path));
    if (bytes.length > 2 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) fail('PUBLISH_ASSET_INVALID');
    assets[path] = { encoding: 'base64', data: bytes.toString('base64'), size: bytes.length, sha256: sha256(bytes) };
  }
  files['shared/NOTICE.json'] = jsonBytes(await dependencyNotices(root, metafile, wasmPaths.length > 0)).toString('utf8');
  const exports = Object.fromEntries(sources.filter(path => sourceExtension.test(path) && !path.split('/').includes('_private'))
    .map(path => [path, moduleExtension.test(path) ? path.replace(moduleExtension, '.js') : path]));
  for (const value of [...Object.values(entries), ...Object.values(exports)]) if (!Object.hasOwn(files, value)) fail('PUBLISH_OUTPUT_INVALID');
  const artifact = canonical({ schemaVersion: 2, manifest, entries, exports, files, assets });
  const bytes = jsonBytes(artifact);
  if (bytes.length > 4 * 1024 * 1024) fail('PUBLISH_ARTIFACT_TOO_LARGE');
  const digest = sha256(bytes);
  return { artifact, bytes, digest, path: `artifacts/${id}/${manifest.version}/${digest}.json` };
}

export async function buildArtifacts({ root = repositoryRoot, write = true } = {}) {
  const ids = (await readdir(resolve(root, 'plugins'))).filter(id => idPattern.test(id)).sort();
  const artifacts = [];
  for (const id of ids) {
    const result = await createArtifact(id, { root });
    if (write) {
      const path = resolve(root, result.path);
      await mkdir(dirname(path), { recursive: true });
      // Content-addressed paths are immutable, including during local rebuilds.
      try { if (!(await readFile(path)).equals(result.bytes)) fail('PUBLISH_ARTIFACT_COLLISION'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await writeFile(path, result.bytes, { flag: 'wx' }); }
    }
    artifacts.push(result);
  }
  return artifacts;
}

export function createCatalog(artifacts, artifactRef) {
  if (!/^[a-f0-9]{40}$/.test(artifactRef || '')) fail('PUBLISH_IMMUTABLE_REF_REQUIRED');
  return canonical({ schemaVersion: 1, id: 'official', name: 'FlareTune', plugins: artifacts.map(({ artifact, digest, path }) => ({
    manifest: artifact.manifest, artifact: { url: `https://raw.githubusercontent.com/arctan303/FlareTune-Plugins/${artifactRef}/${path}`, sha256: digest },
  })).sort((a, b) => a.manifest.id.localeCompare(b.manifest.id)) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'artifacts' && process.argv.length === 3) {
      const artifacts = await buildArtifacts();
      process.stdout.write(`${JSON.stringify(artifacts.map(({ artifact, digest, path, bytes }) => ({ id: artifact.manifest.id, version: artifact.manifest.version, sha256: digest, path, size: bytes.length })))}\n`);
    } else if (command === 'catalog' && process.argv[3] === '--artifact-ref' && process.argv.length === 5) {
      const artifacts = await buildArtifacts({ write: false });
      for (const result of artifacts) if (!(await readFile(resolve(repositoryRoot, result.path))).equals(result.bytes)) fail('PUBLISH_ARTIFACT_MISSING');
      const catalog = createCatalog(artifacts, process.argv[4]);
      await writeFile(resolve(repositoryRoot, 'repository.json'), jsonBytes(catalog));
      process.stdout.write(`${JSON.stringify({ plugins: artifacts.length, artifactRef: process.argv[4] })}\n`);
    } else fail('PUBLISH_COMMAND_INVALID');
  } catch (error) {
    // Do not print dependency sources, absolute paths or arbitrary network errors.
    const code = /^PUBLISH_[A-Z_]+$/.test(error.code || '') ? error.code : 'PUBLISH_FAILED';
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
