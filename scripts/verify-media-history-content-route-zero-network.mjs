import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const gallerySandbox = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync('src/lib/media-history-gallery.ts', 'utf8')), gallerySandbox);
const { parseMediaHistoryGallery } = gallerySandbox.exports;

// All dependencies are replaced by in-memory fixtures; this loads and invokes
// the complete production GET handler, with no sockets, credentials or database.
class TestNextResponse extends Response {
  static json(data, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    return new TestNextResponse(JSON.stringify(data), { ...init, headers });
  }
}
const userA = 'user-a', userB = 'user-b';
const ids = Array.from({ length: 44 }, (_, index) => `a-${index}`);
const assetUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gallery = [null, ...ids.map((id, index) => ({ url: `untrusted-${index}`, assetId: id, storageKey: `key-${index}` })), {}];
const records = {
  conversation_messages: [
    { id: 'gallery', user_id: userA, role: 'assistant', content: JSON.stringify({ type: 'image_gallery', images: gallery }) },
    { id: 'foreign-message', user_id: userB, role: 'assistant', content: JSON.stringify({ type: 'image_gallery', images: gallery }) },
    { id: 'foreign-asset', user_id: userA, role: 'assistant', content: JSON.stringify({ type: 'image_gallery', images: [{ url: 'x', assetId: 'owned-by-b', storageKey: 'foreign-key' }] }) },
    { id: 'wrong-key', user_id: userA, role: 'assistant', content: JSON.stringify({ type: 'image_gallery', images: [{ url: 'x', assetId: 'a-0', storageKey: 'not-key-0' }] }) },
    { id: 'user-message', user_id: userA, role: 'user', content: JSON.stringify({ type: 'image_gallery', images: gallery }) },
  ],
  user_files: [
    ...ids.map((id, index) => ({ id, user_id: userA, storage_key: `key-${index}`, storage_provider: 'local', file_name: `picture-${index}.png`, file_size: 7, content_type: 'image/png' })),
    { id: 'owned-by-b', user_id: userB, storage_key: 'foreign-key', storage_provider: 'local', file_name: 'foreign.png', file_size: 7, content_type: 'image/png' },
    { id: assetUuid, user_id: userA, storage_key: 'direct-key', storage_provider: 'local', file_name: 'direct.png', file_size: 7, content_type: 'image/png' },
  ],
  image_generation_requests: [
    { record_id: 'provider-a', user_id: userA, state: 'completed', delivery_state: 'delivered', response: { deliveryMode: 'provider_url', providerUrl: 'fixture-private-provider' } },
    { record_id: 'provider-b', user_id: userB, state: 'completed', delivery_state: 'delivered', response: { deliveryMode: 'provider_url', providerUrl: 'fixture-private-provider' } },
    { record_id: 'pending', user_id: userA, state: 'running', delivery_state: 'pending', response: { deliveryMode: 'provider_url', providerUrl: 'fixture-private-provider' } },
    { record_id: 'expired', user_id: userA, state: 'completed', delivery_state: 'delivered', response: { deliveryMode: 'provider_url', sourceExpiredAt: '2020-01-01T00:00:00Z' } },
  ],
};
let currentUser = userA;
const reads = [], queries = [], providerReads = [];
const db = { from(table) {
  assert.ok(Object.hasOwn(records, table), `unexpected table ${table}`);
  const filters = {};
  const query = {
    select() { return query; },
    eq(field, value) { filters[field] = value; return query; },
    async maybeSingle() {
      queries.push({ table, filters: { ...filters } });
      const data = records[table].find(row => Object.entries(filters).every(([field, value]) => row[field] === value)) || null;
      return { data, error: null };
    },
  };
  return query;
} };
const mocks = {
  'next/server': { NextResponse: TestNextResponse },
  '@/lib/current-api-user': { authorizeCurrentApiUser: async () => currentUser
    ? { ok: true, user: { userId: currentUser } }
    : { ok: false, response: TestNextResponse.json({ error: 'unauthorized' }, { status: 401 }) } },
  '@/storage/database/supabase-client': { getSupabaseClient: () => db },
  '@/storage/object': { storageManager: { read: async (key, provider) => {
    reads.push({ key, provider });
    return Buffer.from(key);
  } } },
  '@/lib/image-provider-delivery': {
    confirmedImageSourceExpiry: () => false,
    markImageProviderSourceExpired: async () => { throw new Error('unexpected write'); },
    readProviderImage: async (_delivery, _unused, scope) => {
      providerReads.push(scope);
      return { buffer: Buffer.from('provider-fixture'), contentType: 'image/png' };
    },
  },
  '@/lib/media-history-gallery': { parseMediaHistoryGallery },
};
const sandbox = { exports: {}, Buffer, Response, Headers, URL, URLSearchParams,
  require(name) { assert.ok(Object.hasOwn(mocks, name), `unexpected import: ${name}`); return mocks[name]; },
};
vm.runInNewContext(compile(fs.readFileSync('src/app/api/media-history/content/route.ts', 'utf8')), sandbox);
const { GET } = sandbox.exports;
assert.equal(typeof GET, 'function');
async function request(query) {
  return GET({ nextUrl: new URL(`http://fixture.invalid/api/media-history/content?${query}`) });
}
async function verifyImage(query, expectedKey) {
  const response = await request(query);
  assert.equal(response.status, 200, query);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), expectedKey);
  assert.equal(reads.at(-1).key, expectedKey);
}

await verifyImage('id=gallery&index=0', 'key-0');
await verifyImage('id=gallery&index=1', 'key-1');
await verifyImage('id=gallery&index=41', 'key-41'); // The 42nd validated image.
await verifyImage('id=gallery&index=43&download=1', 'key-43');
const download = await request('id=gallery&index=41&download=1');
assert.match(download.headers.get('content-disposition'), /^attachment;/u);
assert.equal((await request('id=gallery&index=44')).status, 410);
for (const invalid of ['-1', '1.5', '9007199254740992', 'NaN']) {
  assert.equal((await request(`id=gallery&index=${invalid}`)).status, 400, `invalid index ${invalid}`);
}
assert.equal((await request('id=foreign-message&index=0')).status, 404);
assert.equal((await request('id=user-message&index=0')).status, 404);
assert.equal((await request('id=foreign-asset&index=0')).status, 404);
assert.equal((await request('id=wrong-key&index=0')).status, 404);
await verifyImage(`assetId=${assetUuid}`, 'direct-key');
assert.equal((await request('assetId=not-a-uuid')).status, 400);
currentUser = userB;
assert.equal((await request(`assetId=${assetUuid}`)).status, 404);
assert.equal((await request('id=gallery&index=0')).status, 404);
assert.equal((await request('recordId=provider-a')).status, 404);
currentUser = userA;
assert.equal((await request('recordId=pending')).status, 404);
assert.equal((await request('recordId=expired')).status, 410);
const provider = await request('recordId=provider-a&download=1');
assert.equal(provider.status, 200);
assert.equal(await provider.text(), 'provider-fixture');
assert.equal(provider.headers.get('content-disposition'), 'attachment; filename="generated-image"');
assert.deepEqual(JSON.parse(JSON.stringify(providerReads)), [{ recordId: 'provider-a', userId: userA }]);
currentUser = null;
const beforeUnauthorized = queries.length;
assert.equal((await request('id=gallery&index=0')).status, 401);
assert.equal(queries.length, beforeUnauthorized, 'unauthenticated request never queries');
assert.ok(queries.every(({ filters }) => typeof filters.user_id === 'string'), 'all data reads include the current user filter');
console.log('PASS: full media content GET in memory: validated gallery indexing, 42nd image and download, invalid index, owner/message/asset/key checks, login, direct asset and provider records; no network or database');
