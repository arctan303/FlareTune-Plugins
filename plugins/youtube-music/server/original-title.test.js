import test from 'node:test';
import assert from 'node:assert/strict';
import { createOriginalTitleResolver } from './original-title.js';

const idOf = number => String(number).padStart(11, '0');
const song = (number = 1, overrides = {}) => ({ id: 'yt:' + idOf(number), source: 'youtube', kind: 'song',
  title: '愛♡スクリ～ム！ - AI SCREAM!', artist: 'AiScReam', album: 'AI SCREAM!', duration: 263,
  language: null, audio_url: '/media/youtube/audio/' + idOf(number), ...overrides });
const reply = title => Response.json({ provider_name: 'YouTube', type: 'video', title });
const defer = () => { let resolve; return { promise: new Promise(yes => { resolve = yes; }), resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const noDisplay = ({ displayTitle, ...rest }) => rest;
const resolver = options => createOriginalTitleResolver({ cache: new Map(), ...options });

test('publisher title changes display only and the exact fixed public endpoint carries no credentials', async () => {
  const original = Object.freeze(song());
  const enrich = resolver({ fetchImpl: async (url, init) => {
    assert.equal(url.origin, 'https://www.youtube.com');
    assert.equal(url.pathname, '/oembed');
    assert.equal(url.searchParams.get('url'), 'https://www.youtube.com/watch?v=' + idOf(1));
    assert.equal(url.searchParams.get('format'), 'json');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['format', 'url']);
    assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return reply('愛♡スクリ～ム！');
  } });
  const [result] = await enrich([original]);
  assert.equal(result.displayTitle, '愛♡スクリ～ム！');
  assert.deepEqual(noDisplay(result), original);
  assert.equal(original.displayTitle, undefined);
});

test('local, non-song and invalid external identities neither change nor make requests', async () => {
  const input = [song(1, { source: 'local' }), song(2, { kind: 'album' }), song(3, { id: 'yt:../../other' }),
    song(4, { id: 'https://other.test/watch?v=00000000004' }), { title: 'local' }];
  const result = await resolver({ fetchImpl: async () => assert.fail('No request') })(input);
  input.forEach((item, index) => assert.equal(result[index], item));
});

test('redirects, HTTP errors, network errors and invalid publisher data preserve existing names', async () => {
  const bad = [async () => new Response(null, { status: 302 }), async () => new Response(null, { status: 404 }),
    async () => { throw Error('network error with private diagnostic'); }, async () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }),
    async () => Response.json({ provider_name: 'Other', type: 'video', title: 'Wrong' }),
    async () => Response.json({ provider_name: 'YouTube', type: 'photo', title: 'Wrong' }),
    async () => reply(' '), async () => reply(2), async () => reply('a'.repeat(1001)), async () => reply('bad\u0000name'),
    async () => new Response(JSON.stringify({ provider_name: 'YouTube', type: 'video', title: 'wrong type' }), { headers: { 'Content-Type': 'text/html' } })];
  for (const fetchImpl of bad) {
    const original = song(); assert.equal((await resolver({ fetchImpl })([original]))[0], original);
  }
});

test('declared and streamed oversized responses are canceled and cannot publish titles', async () => {
  for (const declared of [true, false]) {
    let canceled = false;
    const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { canceled = true; } });
    const original = song();
    const result = await resolver({ fetchImpl: async () => new Response(body, { headers: {
      'Content-Type': 'application/json', ...(declared ? { 'Content-Length': '65537' } : {}),
    } }) })([original]);
    assert.equal(result[0], original); await tick(); assert.equal(canceled, true);
  }
});

test('a fetch ignoring AbortSignal still ends within the whole enrichment deadline', async () => {
  const cache = new Map(); let calls = 0;
  const input = Array.from({ length: 25 }, (_, n) => song(n + 1));
  const started = performance.now();
  const result = await createOriginalTitleResolver({ cache, timeoutMs: 15, fetchImpl: () => {
    calls++; return new Promise(() => {});
  } })(input);
  assert.ok(performance.now() - started < 500);
  assert.deepEqual(result, input); assert.equal(calls, 4); assert.equal(cache.size, 0);
});

test('a stalled response body ignoring cancellation cannot outlive the whole deadline', async () => {
  const cache = new Map(); let canceled = false;
  const body = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { canceled = true; return new Promise(() => {}); } });
  const started = performance.now(), original = song();
  const [result] = await createOriginalTitleResolver({ cache, timeoutMs: 15,
    fetchImpl: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) })([original]);
  assert.ok(performance.now() - started < 500);
  assert.equal(result, original); assert.equal(canceled, true); assert.equal(cache.size, 0);
});

test('out-of-order completion retains membership, exact order and all business fields with four-request concurrency', async () => {
  let active = 0, peak = 0;
  const input = Array.from({ length: 12 }, (_, n) => song(n + 1));
  const result = await resolver({ fetchImpl: async url => {
    active++; peak = Math.max(peak, active);
    const number = Number(url.searchParams.get('url').slice(-11));
    await new Promise(resolve => setTimeout(resolve, number % 3));
    active--; return reply('Original ' + number);
  } })(input);
  assert.equal(peak, 4); assert.deepEqual(result.map(noDisplay), input);
  assert.deepEqual(result.map(x => x.displayTitle), input.map((_, n) => 'Original ' + (n + 1)));
});

test('duplicate IDs coalesce within a resolver and later resolvers use completed values only', async () => {
  const cache = new Map(), gate = defer(); let calls = 0;
  const first = createOriginalTitleResolver({ cache, fetchImpl: async () => { calls++; await gate.promise; return reply('older'); } });
  const owner = first([song(), song()]); await tick(); assert.equal(calls, 1);
  const second = createOriginalTitleResolver({ cache, fetchImpl: async () => { calls++; return reply('newer'); } });
  assert.equal((await second([song()]))[0].displayTitle, 'newer');
  assert.equal(calls, 2);
  gate.resolve(); assert.deepEqual((await owner).map(x => x.displayTitle), ['older', 'older']);
  assert.equal((await createOriginalTitleResolver({ cache, fetchImpl: () => assert.fail('Use completed newer value') })([song()]))[0].displayTitle, 'newer');
});

test('caller cancellation abandons pending work without negative-caching or poisoning a fresh resolver', async () => {
  const cache = new Map(), canceled = new AbortController(), gate = defer();
  const owner = createOriginalTitleResolver({ cache, fetchImpl: async () => { await gate.promise; return reply('late'); } })([song()], { signal: canceled.signal });
  await tick(); canceled.abort();
  assert.equal((await owner)[0].displayTitle, undefined); assert.equal(cache.size, 0);
  const fresh = createOriginalTitleResolver({ cache, fetchImpl: async () => reply('fresh') });
  assert.equal((await fresh([song()]))[0].displayTitle, 'fresh');
  gate.resolve(); await tick();
  assert.equal((await fresh([song()]))[0].displayTitle, 'fresh');
});

test('canceling one subscriber leaves another same-request subscriber able to complete', async () => {
  const cache = new Map(), gate = defer(), canceled = new AbortController(); let calls = 0;
  const enrich = createOriginalTitleResolver({ cache, fetchImpl: async () => { calls++; await gate.promise; return reply('kept'); } });
  const first = enrich([song()], { signal: canceled.signal }), second = enrich([song()]);
  await tick(); canceled.abort(); assert.equal((await first)[0].displayTitle, undefined);
  gate.resolve(); assert.equal((await second)[0].displayTitle, 'kept'); assert.equal(calls, 1);
});

test('concurrent enrichment calls in one resolver still share a four-request ceiling', async () => {
  let active = 0, peak = 0;
  const enrich = resolver({ fetchImpl: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return reply('name');
  } });
  const results = await Promise.all([enrich(Array.from({ length: 8 }, (_, n) => song(n + 1))),
    enrich(Array.from({ length: 8 }, (_, n) => song(n + 9)))]);
  assert.equal(peak, 4); assert.equal(results.flat().filter(x => x.displayTitle).length, 16);
});

test('a canceled request does not leave pending work or reserved slots blocking a same-resolver retry', async () => {
  const canceled = new AbortController(); let calls = 0;
  const enrich = resolver({ fetchImpl: async () => ++calls === 1 ? new Promise(() => {}) : reply('retry') });
  const first = enrich([song()], { signal: canceled.signal });
  await tick(); canceled.abort(); await first;
  assert.equal((await enrich([song()]))[0].displayTitle, 'retry'); assert.equal(calls, 2);
});

test('positive and negative cache TTLs do not slide on reads and successful names can refresh after expiry', async () => {
  const cache = new Map(); let clock = 1000, calls = 0;
  const enrich = createOriginalTitleResolver({ cache, now: () => clock,
    fetchImpl: async () => { calls++; return calls === 1 ? new Response(null, { status: 404 }) : reply('name ' + calls); } });
  assert.equal((await enrich([song()]))[0].displayTitle, undefined);
  clock += 29999; await enrich([song()]); assert.equal(calls, 1);
  clock++; assert.equal((await enrich([song()]))[0].displayTitle, 'name 2');
  clock += 599999; await enrich([song()]); assert.equal(calls, 2);
  clock++; assert.equal((await enrich([song()]))[0].displayTitle, 'name 3');
});

test('twenty-request cold budget retains overflow while cache hits do not consume the next invocation budget', async () => {
  const cache = new Map(); let calls = 0;
  const enrich = createOriginalTitleResolver({ cache, fetchImpl: async () => { calls++; return reply('name'); } });
  const input = Array.from({ length: 25 }, (_, n) => song(n + 1));
  const result = await enrich(input);
  assert.equal(calls, 20); assert.equal(result.filter(x => x.displayTitle).length, 20);
  result.slice(20).forEach((value, n) => assert.equal(value, input[n + 20]));
  assert.equal((await enrich(input)).filter(x => x.displayTitle).length, 25); assert.equal(calls, 25);
});

test('completed cache is bounded at five hundred entries', async () => {
  const cache = new Map();
  const enrich = createOriginalTitleResolver({ cache, fetchImpl: async () => reply('name') });
  for (let start = 1; start <= 501; start += 20) await enrich(Array.from({ length: Math.min(20, 502 - start) }, (_, n) => song(start + n)));
  assert.equal(cache.size, 500); assert.equal(cache.has(idOf(1)), false); assert.equal(cache.has(idOf(501)), true);
});

test('publisher feat, Live, language-version and bilingual titles are displayed verbatim rather than heuristically stripped', async () => {
  const titles = ["We Don't Talk Anymore (feat. Selena Gomez)", 'Idol - Live at Tokyo Dome', 'Into The Night (English Version)', '原名 - Official Alias'];
  for (const title of titles) assert.equal((await resolver({ fetchImpl: async () => reply(title) })([song()]))[0].displayTitle, title);
});
