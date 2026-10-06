import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = fs.readFileSync('src/features/official-inspiration/admin-uploaded-inspiration.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const loadedModule = { exports: {} };
vm.runInNewContext(compiled, { exports: loadedModule.exports, module: loadedModule, fetch, AbortSignal, URL, Date, Number, Object, Set, Error });
const { mapAdminUploadedInspiration: map, loadAdminUploadedInspiration: load } = loadedModule.exports;
const item = (id = 'manju-123456789', type = 'image') => ({ id, url: `/api/youcai/public-assets/${id}`, origin: 'admin-upload', type, category: 'image', metadata: { title: '测试几何图', summary: '本地自绘素材', imageRatio: 'square' }, prompt: '自绘圆形', createdAt: '2026-09-02T12:00:00Z', author: { nickname: '漫剧工作台' }, likes: 0 });
const response = (data, total = data.length, totalPages = Math.ceil(total / 100)) => Response.json({ success: true, data, pagination: { total, totalPages } });
const signal = new AbortController().signal;
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('image preserves title, public route, prompt and date', () => {
  const mapped = map(item());
  assert.equal(mapped.mediaType, '图片'); assert.equal(mapped.imagePath, item().url); assert.equal(mapped.prompt, item().prompt); assert.equal(mapped.title, item().metadata.title);
});
await test('video/audio keep playable media with a real image cover', () => {
  for (const type of ['video', 'audio']) { const mapped = map(item(undefined, type)); assert.equal(mapped.mediaPath, item().url); assert.equal(mapped.imagePath, '/official-home/hero-eye-original.png'); assert.notEqual(mapped.imagePath, mapped.mediaPath); }
});
await test('static curated entries are not duplicated by the upload feed', () => assert.equal(map({ ...item(), origin: 'local' }), null));
await test('cross-origin and mismatched asset routes are rejected', () => {
  for (const url of ['https://example.com/private', '//example.com/x', '/api/youcai/public-assets/manju-other123']) assert.throws(() => map({ ...item(), url }), /FORMAT_INVALID/u);
});
await test('bad title, date and media type do not become broken cards', () => {
  for (const input of [{ ...item(), metadata: {} }, { ...item(), createdAt: 'invalid' }, { ...item(), type: 'html' }]) assert.throws(() => map(input), /FORMAT_INVALID/u);
});
await test('empty registry is a successful empty response', async () => assert.equal((await load(signal, async () => response([]))).length, 0));
await test('all pages are read with the caller signal and fresh GETs', async () => {
  const requests = [];
  const result = await load(signal, async (url, options) => { requests.push(url); assert.equal(options.signal, signal); assert.equal(options.cache, 'no-store'); return response([item(`manju-12345678${requests.length}`)], 2, 2); });
  assert.equal(result.length, 2); assert.equal(requests.length, 2); assert.match(requests[1], /page=2/u); assert.match(requests[0], /search=manju-admin-upload/u);
});
await test('a failure on later pages does not return a partial registry', async () => {
  let calls = 0; await assert.rejects(load(signal, async () => ++calls === 1 ? response([item()], 2, 2) : new Response('', { status: 503 })), /UNAVAILABLE/u);
});
await test('registry count changes require a fresh retry', async () => {
  let calls = 0; await assert.rejects(load(signal, async () => response([item(`manju-12345678${++calls}`)], calls === 1 ? 2 : 3, 2)), /CHANGED/u);
});
await test('duplicate IDs and incomplete pagination fail explicitly', async () => {
  await assert.rejects(load(signal, async () => response([item(), item()])), /DUPLICATE/u);
  await assert.rejects(load(signal, async () => response([item()], 2, 1)), /INCOMPLETE/u);
});
await test('invalid pagination is rejected instead of unbounded loading', async () => await assert.rejects(load(signal, async () => response([], 0, 101)), /FORMAT_INVALID/u));
await test('abort rejection is not converted into stale successful data', async () => await assert.rejects(load(signal, async () => { throw new DOMException('aborted', 'AbortError'); }), (error) => error.name === 'AbortError'));
console.log(JSON.stringify({ passed, failed: 0, upstreamCalls: 0, databaseWrites: 0 }));
