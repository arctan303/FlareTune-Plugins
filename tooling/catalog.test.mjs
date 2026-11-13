import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const publishedEntryHashes={
  'ai-gateway@0.1.0':'d9f82bbcd322b1cd2cb300d4f01fe97e9e4bcbf0c1628ada206bafe34d37eed4',
  'assistant@0.1.0':'1fa3ce3cbd50eeb5c1e4dfd1c21487ba5e378bfd3b0adb3c4f07ecc789acc51d',
  'lyrics-workbench@0.1.0':'1edf5e5816c3d40ca21e9f2699c4dcb165dc56713c49827a4b7d06fbdcf178ea',
  'roam@0.1.1':'a70a364f376c2943557e452d5d3b037aac3d38f17bfbb83ab3fe698307e0e119',
  'xiaomi-speaker@1.1.0':'60c0aa2f08f582e6c55cb91d4c951c794f63fc3d77614d8763e482126fde27d3',
  'youtube-music@0.1.0':'8e11bf6ff8229c024292df68719620028a16fca63145660e1dfcbca2be8772ec',
};
const readCatalog=async file=>JSON.parse(await readFile(resolve(root,file),'utf8'));
const key=row=>`${row.manifest.id}@${row.manifest.version}`;

async function validateArtifacts(catalog) {
  assert.equal(catalog.schemaVersion,1);
  assert.equal(new Set(catalog.plugins.map(key)).size,catalog.plugins.length);
  for(const row of catalog.plugins) {
    const url=new URL(row.artifact.url);
    const match=url.pathname.match(/^\/arctan303\/FlareTune-Plugins\/([a-f0-9]{40})\/(artifacts\/([^/]+)\/([^/]+)\/([a-f0-9]{64})\.json)$/);
    assert.equal(url.origin,'https://raw.githubusercontent.com');
    assert.ok(match,`immutable artifact URL: ${key(row)}`);
    assert.equal(url.search,''); assert.equal(url.hash,'');
    assert.equal(match[3],row.manifest.id); assert.equal(match[4],row.manifest.version);
    assert.equal(match[5],row.artifact.sha256);
    const bytes=await readFile(resolve(root,match[2]));
    assert.equal(sha(bytes),row.artifact.sha256,`artifact bytes: ${key(row)}`);
    const artifact=JSON.parse(bytes);
    assert.equal(artifact.schemaVersion,2);
    assert.deepEqual(artifact.manifest,row.manifest,`manifest: ${key(row)}`);
  }
}

test('stable catalog preserves every previously published entry, including its manifest and immutable URL',async()=>{
  const catalog=await readCatalog('repository.json');
  for(const [identity,digest] of Object.entries(publishedEntryHashes)) {
    const row=catalog.plugins.find(row=>key(row)===identity);
    assert.ok(row,identity);
    assert.equal(sha(JSON.stringify(canonical(row))),digest,identity);
  }
});

test('stable catalog retains every baseline identity and its explicitly declared additions',async()=>{
  const catalog=await readCatalog('repository.json');
  const baseline=await readCatalog('tooling/catalog-baselines.json');
  const additions=baseline.stableAdditions || ['youtube-music@0.2.4'];
  assert.equal(catalog.plugins.length,Object.keys(baseline.stable).length+additions.length);
  for(const [identity,digest] of Object.entries(baseline.stable)) {
    assert.equal(sha(JSON.stringify(canonical(catalog.plugins.find(row=>key(row)===identity)))),digest,identity);
  }
  for(const identity of additions) assert.ok(catalog.plugins.some(row=>key(row)===identity),identity);
  assert.deepEqual([...new Set(catalog.plugins.map(row=>row.manifest.hostApiVersion))].sort(),
    additions.includes('lyrics-workbench@1.0.0') ? [2,3,4,5] : [2,3,4]);
  for(const [id,version] of Object.entries({'ai-gateway':'0.2.1',assistant:'0.2.0','lyrics-workbench':'0.2.1',roam:'0.1.1','xiaomi-speaker':'1.1.1','youtube-music':'0.1.1'})) {
    assert.ok(catalog.plugins.some(row=>row.manifest.id===id&&row.manifest.version===version));
  }
  assert.equal(catalog.plugins.find(row=>key(row)==='youtube-music@0.2.4').manifest.hostApiVersion,4);
  assert.ok(!catalog.plugins.some(row=>row.manifest.id==='lyrics-workbench'&&row.manifest.version.startsWith('0.3.')));
  await validateArtifacts(catalog);
});

test('development catalog preserves every previous entry and its explicitly added API4 releases',async()=>{
  let catalog;
  try {catalog=await readCatalog('catalogs/development.json');} catch(error){if(error.code==='ENOENT')return;throw error;}
  const baseline=await readCatalog('tooling/catalog-baselines.json');
  assert.equal(catalog.plugins.length,Object.keys(baseline.development).length+baseline.developmentAdditions.length);
  for(const [identity,digest] of Object.entries(baseline.development)) {
    assert.equal(sha(JSON.stringify(canonical(catalog.plugins.find(row=>key(row)===identity)))),digest,identity);
  }
  for(const identity of baseline.developmentAdditions) {
    assert.equal(catalog.plugins.find(row=>key(row)===identity).manifest.hostApiVersion,
      ['lyrics-workbench@0.9.0','lyrics-workbench@0.9.1','lyrics-workbench@1.0.0'].includes(identity) ? 5 : 4);
  }
  assert.ok(catalog.plugins.some(row=>key(row)==='lyrics-workbench@0.3.1'));
  assert.ok(catalog.plugins.some(row=>key(row)==='youtube-music@0.2.1'));
  await validateArtifacts(catalog);
});
