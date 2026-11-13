import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { pagedSearch, pagedArtist } from './pagination.js';

const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function completes(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('A fresh request inherited unfinished work')), 1000);
  })]); } finally { clearTimeout(timer); }
}
let moduleId = 0;
async function productionSessionPath() {
  const entry = fileURLToPath(new URL('./service.js', import.meta.url)).replaceAll('\\', '/');
  const upstream = fileURLToPath(new URL('./upstream.js', import.meta.url)).replaceAll('\\', '/');
  const sdk = `
    export const Log={setLevel(){},Level:{NONE:0}};
    export const YTNodes={Tab:class{}};
    export const control={created:0,refreshed:0,songs:0,onCreate:async()=>{},onRefresh:async()=>{},onSong:async()=>{}};
    export const Innertube={async create(options){
      const id=++control.created;await control.onCreate(options,id);
      const session={context:{client:{hl:options.lang,gl:options.location}},on(){},
        oauth:{async refreshAccessToken(){const id=++control.refreshed;await control.onRefresh(id);this.oauth2_tokens={access_token:'synthetic-'+id,expiry_date:new Date(Date.now()+3600000).toISOString()};}},
        async signIn(tokens){this.oauth.oauth2_tokens=tokens;}};
      return{id,session,music:{async getUpNext(){const id=++control.songs;await control.onSong(id);return{contents:[{video_id:'localmeta01',title:'Synthetic metadata'}]};}}};
    }};`;
  const bundled = await build({ stdin: { resolveDir: fileURLToPath(new URL('./', import.meta.url)), contents: `export {createYouTubeService} from ${JSON.stringify(entry)};
    export {createSessionManager} from ${JSON.stringify(upstream)};export {control} from 'youtubei.js/cf-worker';` },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'sdk-boundary-only', setup(plugin) {
      plugin.onResolve({ filter: /^youtubei\.js\/cf-worker$/ }, () => ({ path: 'sdk', namespace: 'lifecycle-test' }));
      plugin.onResolve({ filter: /^\.\/player\.js$/ }, () => ({ path: 'player', namespace: 'lifecycle-test' }));
      plugin.onResolve({ filter: /^@flaretune\/plugin-sdk\/server\/lyric-document$/ }, () => ({ path: 'document', namespace: 'lifecycle-test' }));
      plugin.onLoad({ filter: /.*/, namespace: 'lifecycle-test' }, args => ({ contents: args.path === 'sdk' ? sdk : args.path === 'player'
        ? 'export const createPlayer=()=>({});' : 'export const createLyricDocument=value=>value;', loader: 'js' }));
    } }] });
  // Innertube is replaced at its import boundary. createSession is never
  // injected: the production sdkCreate identity/cache branch must run.
  return import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64') + '#case-' + moduleId++);
}
const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' };
function environment() {
  const values = new Map();
  return { YTM_KV: { get: async key => values.has(key) ? JSON.parse(values.get(key)) : null,
    put: async (key, value) => { values.set(key, value); } } };
}

test('default SDK guest work is shared within one manager, independent across requests, and cached only after completion', async () => {
  const { createSessionManager, control } = await productionSessionPath();
  const gate = deferred();
  control.onCreate = async (_options, id) => { if (id === 1) await gate.promise; };
  const first = createSessionManager({}), second = createSessionManager({});
  const owner = first.guest(), sameRequest = first.guest();
  try {
    await tick();
    assert.equal((await completes(second.guest())).id, 2);
    assert.equal(control.created, 2);
    gate.resolve();
    assert.equal((await owner).id, 1); assert.equal((await sameRequest).id, 1);
    assert.equal((await createSessionManager({}).guest()).id, 1);
    assert.equal(control.created, 2);
  } finally { gate.resolve(); }
});

for (const client of ['musicMobile', 'musicIos']) test(`${client} never shares another request's pending initialization`, async () => {
  const { createSessionManager, control } = await productionSessionPath();
  const gate = deferred(); let mobile = 0;
  control.onCreate = async options => { if (options.generate_session_locally && ++mobile === 1) await gate.promise; };
  const first = createSessionManager({}), second = createSessionManager({});
  const owner = first[client](); const sameRequest = first[client]();
  try {
    await tick();
    const follower = await completes(second[client]());
    assert.equal(mobile, 2);
    gate.resolve();
    assert.equal((await owner).id, (await sameRequest).id);
    assert.notEqual((await owner).id, follower.id);
    await createSessionManager({})[client](); assert.equal(mobile, 2);
  } finally { gate.resolve(); }
});

test('OAuth refresh work is request-local while completed KV tokens remain reusable', async () => {
  const { createSessionManager, control } = await productionSessionPath();
  const gate = deferred(), began = deferred(), env = environment();
  control.onRefresh = async id => { if (id === 1) { began.resolve(); await gate.promise; } };
  const options = { env, credentials, epoch: 1 };
  const first = createSessionManager(options);
  const owner = first.tv(), sameRequest = first.tv();
  try {
    await began.promise;
    assert.equal((await completes(createSessionManager(options).tv())).session.oauth.oauth2_tokens.access_token, 'synthetic-2');
    assert.equal(control.refreshed, 2);
    await createSessionManager(options).tv(); assert.equal(control.refreshed, 2);
    gate.resolve(); await Promise.all([owner, sameRequest]); assert.equal(control.refreshed, 2);
  } finally { gate.resolve(); }
});

test('song resolution pending work stays in its service; completed normalized metadata remains reusable', async () => {
  const { createYouTubeService, control } = await productionSessionPath();
  const gate = deferred(), began = deferred();
  control.onSong = async id => { if (id === 1) { began.resolve(); await gate.promise; } };
  const create = () => createYouTubeService({ services: { player: {} } });
  const first = create(), owner = first.song('localmeta01'), sameRequest = first.song('localmeta01');
  try {
    await began.promise;
    assert.equal((await completes(create().song('localmeta01'))).title, 'Synthetic metadata');
    assert.equal(control.songs, 2); gate.resolve(); await Promise.all([owner, sameRequest]);
    await create().song('localmeta01'); assert.equal(control.songs, 2);
  } finally { gate.resolve(); }
});

const row = number => ({ video_id: String(number).padStart(11, '0'), title: 'Fixture ' + number });
function searchPage(number, next) {
  return { contents: [{ title: 'Songs', contents: [row(number)] }], has_continuation: number < 8,
    getContinuation: async () => { await next(number); return searchPage(number + 1, next); } };
}
test('a request advancing search continuation never publishes pending work or mutates another request cursor', async () => {
  const gate = deferred(), began = deferred(); let calls = 0, searches = 0;
  const next = async () => { if (++calls === 1) { began.resolve(); await gate.promise; } };
  const yt = { music: { search: async () => { searches++; return searchPage(1, next); } } };
  const options = { hl: 'en', filter: 'song', limit: 1, cacheNamespace: 'lifecycle-continuation' };
  await pagedSearch(yt, 'fixture', options);
  const owner = pagedSearch(yt, 'fixture', { ...options, limit: 2 });
  try {
    await began.promise;
    const follower = await completes(pagedSearch(yt, 'fixture', { ...options, limit: 2 }));
    assert.equal(follower.items.length, 2); assert.equal(calls, 2); assert.equal(searches, 1);
    gate.resolve(); await owner;
    const cached = await pagedSearch(yt, 'fixture', { ...options, limit: 2 });
    assert.equal(cached.items.length, 2); assert.equal(calls, 2);
  } finally { gate.resolve(); }
});

test('completed pagination progress survives separate calls beyond the per-request three-page allowance', async () => {
  let searches = 0, continuations = 0;
  const yt = { music: { search: async () => { searches++; return searchPage(1, async () => { continuations++; }); } } };
  const options = { hl: 'en', filter: 'song', cacheNamespace: 'lifecycle-progress' };
  assert.equal((await pagedSearch(yt, 'progress', { ...options, limit: 4 })).items.length, 4);
  assert.equal((await pagedSearch(yt, 'progress', { ...options, offset: 4, limit: 4 })).items.length, 7);
  assert.equal((await pagedSearch(yt, 'progress', { ...options, offset: 7, limit: 1 })).items.length, 8);
  assert.equal(searches, 1); assert.equal(continuations, 7);
});

test('an artist initial fetch does not lend its unfinished SDK task to another request', async () => {
  const gate = deferred(), began = deferred(); let calls = 0;
  const yt = { music: { getArtist: async () => {
    if (++calls === 1) { began.resolve(); await gate.promise; }
    return { header: { title: 'Fixture artist' }, getAllSongs: async () => ({ contents: [row(1)] }) };
  } } };
  const options = { hl: 'en', limit: 1, cacheNamespace: 'lifecycle-artist' };
  const owner = pagedArtist(yt, 'UCfixture', options);
  try {
    await began.promise;
    assert.equal((await completes(pagedArtist(yt, 'UCfixture', options))).songs.length, 1);
    assert.equal(calls, 2); gate.resolve(); await owner;
    await pagedArtist(yt, 'UCfixture', options); assert.equal(calls, 2);
  } finally { gate.resolve(); }
});

for (const kind of ['search', 'artist']) test(`${kind} empty continuation pages keep the furthest completed cursor when an older owner finishes late`, async () => {
  const gate = deferred(), began = deferred(); let blocked = false, initialCalls = 0;
  const advancedFrom = [];
  const contents = number => number === 1 ? [row(1)] : number === 8 ? [row(2)]
    : number % 2 ? [] : [{ video_id: 'filtered', title: 'Unsupported item' }];
  const advance = async number => {
    advancedFrom.push(number);
    if (number === 1 && !blocked) { blocked = true; began.resolve(); await gate.promise; }
  };
  const page = number => ({ contents: [{ title: 'Songs', contents: contents(number) }], has_continuation: number < 8,
    async getContinuation() { await advance(number); return page(number + 1); } });
  const yt = { music: {
    async search() { initialCalls++; return page(1); },
    async getArtist() { initialCalls++; return { header: { title: 'Empty-page fixture' },
      getAllSongs: async () => ({ contents: contents(1), continuation: '2' }) }; },
  }, actions: { async execute(_path, { continuation }) {
    const number = Number(continuation); await advance(number - 1);
    return { continuation_contents: { contents: contents(number), continuation: number < 8 ? String(number + 1) : null } };
  } } };
  const base = { hl: 'en', filter: 'song', cacheNamespace: 'empty-pages-late-' + kind };
  const read = options => kind === 'search' ? pagedSearch(yt, 'empty-page fixture', { ...base, ...options })
    : pagedArtist(yt, 'UCemptyPages', { ...base, ...options });
  const count = value => (kind === 'search' ? value.items : value.songs).length;
  assert.equal(count(await read({ limit: 1 })), 1);
  const owner = read({ limit: 2 });
  try {
    await began.promise;
    assert.equal(count(await read({ limit: 2 })), 1); // B completes page 4.
    assert.equal(count(await read({ limit: 2 })), 1); // C completes page 7.
    gate.resolve(); await owner; // A completes only page 4, with the same item count.
    const before = advancedFrom.length;
    const next = await read({ offset: 1, limit: 1 });
    assert.equal(count(next), 2);
    assert.deepEqual(advancedFrom.slice(before), [7]); // Reuse page 7, fetch page 8 once.
    assert.equal(initialCalls, 1);
  } finally { gate.resolve(); }
});

for (const kind of ['search', 'artist']) test(`${kind} cache expiry starts a new generation that late old pages cannot replace`, async t => {
  let clock = 1_000_000, initialCalls = 0, blocked = false;
  t.mock.method(Date, 'now', () => clock);
  const gate = deferred(), began = deferred();
  const advance = async () => { if (!blocked) { blocked = true; began.resolve(); await gate.promise; } };
  const page = (generation, number = 1) => ({
    contents: [{ title: 'Songs', contents: number === 1 ? [{ ...row(1), title: 'Generation ' + generation }] : [] }],
    has_continuation: true,
    async getContinuation() { await advance(); return page(generation, number + 1); },
  });
  const yt = { music: {
    async search() { return page(++initialCalls); },
    async getArtist() { const generation = ++initialCalls; return { header: { title: 'Expiry fixture' },
      getAllSongs: async () => ({ contents: [{ ...row(1), title: 'Generation ' + generation }], continuation: '2' }) }; },
  }, actions: { async execute(_path, { continuation }) {
    await advance(); return { continuation_contents: { contents: [], continuation: String(Number(continuation) + 1) } };
  } } };
  const base = { hl: 'en', filter: 'song', cacheNamespace: 'cache-expiry-late-' + kind };
  const read = limit => kind === 'search' ? pagedSearch(yt, 'expiry fixture', { ...base, limit })
    : pagedArtist(yt, 'UCexpiryPages', { ...base, limit });
  const title = value => (kind === 'search' ? value.items : value.songs)[0].title;
  assert.equal(title(await read(1)), 'Generation 1');
  const owner = read(2);
  try {
    await began.promise;
    clock += 299_999;
    assert.equal(title(await read(1)), 'Generation 1'); assert.equal(initialCalls, 1);
    clock += 2; // A hit above must not slide the five-minute TTL.
    assert.equal(title(await read(1)), 'Generation 2'); assert.equal(initialCalls, 2);
    gate.resolve(); await owner;
    assert.equal(title(await read(1)), 'Generation 2'); assert.equal(initialCalls, 2);
  } finally { gate.resolve(); }
});
