import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function load(path, mocks = {}) {
  const context = { exports: {}, Blob, URLSearchParams, fetch,
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; throw new Error(name); },
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context, { filename: path });
  return context.exports;
}
const resolutionPricing = load('src/lib/image-resolution-pricing.ts');
const helper = load('src/lib/cover-generation-attempt.ts', {
  '@/lib/image-workbench-attempt-guard': {},
  '@/lib/cover-composition': {},
  '@/lib/image-resolution-pricing': resolutionPricing,
});
const download = helper.fetchCoverResultBlob;
let calls = 0, response = new Response('fixture-image', { headers: { 'content-type': 'image/png' } });
const fetcher = async (url, options) => {
  calls += 1;
  assert.ok(url.startsWith('/api/media-history/content?') || url.startsWith('/cover-generated-samples/'));
  assert.equal(options.headers?.Authorization, url.startsWith('/api/media-history/content?') ? 'Bearer synthetic-session' : undefined);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.method, undefined);
  return response;
};
const task = { historyRecordId: 'image_workbench_synthetic', url: 'https://untrusted.example/file.png' };
assert.equal(await (await download(task, 'synthetic-session', fetcher)).text(), 'fixture-image');
assert.equal(calls, 1);
await assert.rejects(() => download(task, '', fetcher), /登录/);
await assert.rejects(() => download({ url: '//untrusted.example/file.png' }, 'synthetic-session', fetcher), /历史凭据/);
await assert.rejects(() => download({ url: '/cover-generated-samples/../api/auth/me' }, 'synthetic-session', fetcher), /历史凭据/);
assert.equal(calls, 1);
response = new Response('denied', { status: 403 });
await assert.rejects(() => download(task, 'synthetic-session', fetcher), /下载失败/);
response = new Response('<html>', { headers: { 'content-type': 'text/html' } });
await assert.rejects(() => download(task, 'synthetic-session', fetcher), /有效图片/);
response = new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(31 * 1024 * 1024) } });
await assert.rejects(() => download(task, 'synthetic-session', fetcher), /下载上限/);
response = new Response('', { headers: { 'content-type': 'image/png' } });
await assert.rejects(() => download(task, 'synthetic-session', fetcher), /大小异常/);
response = new Response('demo', { headers: { 'content-type': 'image/jpeg' } });
assert.equal(await (await download({ url: '/cover-generated-samples/demo.jpg' }, 'synthetic-session', fetcher)).text(), 'demo');
console.log(JSON.stringify({ passed: true, cases: 9, actualHelper: true, realUpstreamCalls: 0 }));
