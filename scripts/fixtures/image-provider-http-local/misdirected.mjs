import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Agent, getGlobalDispatcher } from 'undici';
import ts from 'typescript';
const root = process.cwd(), calls = [], sockets = new Set();
const server = createServer((request, response) => {
  const call = { method: request.method, bodyBytes: 0 }; calls.push(call);
  request.on('data', chunk => call.bodyBytes += chunk.length); request.on('error', () => {});
  request.on('end', () => { response.writeHead(421); response.end('misdirected'); });
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const source = readFileSync(path.join(root, 'src/lib/server/image-provider-http.ts'), 'utf8');
const module = { exports: {} }, globalBefore = getGlobalDispatcher();
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module, exports: module.exports, Error, Number, String, AbortSignal,
    fetch: (input, init) => { assert.equal(new URL(typeof input === 'string' ? input : input.url).origin, origin); return fetch(input, init); },
    require: id => id === 'server-only' ? {} : id === 'undici' ? { Agent } : assert.fail('Unexpected import ' + id) });
const auditPath = 'src/lib/image-provider-request-audit.ts';
const auditSource = readFileSync(path.join(root, auditPath), 'utf8');
const auditModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(auditSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: auditModule, exports: auditModule.exports, Error, Number, String, Request, URL, Uint8Array, TextDecoder,
    require: id => id === 'node:crypto' ? { createHash, randomUUID } : assert.fail('Unexpected audit import ' + id) });
const sha = value => createHash('sha256').update(value).digest('hex');
const results = [];
try {
  for (const kind of ['string', 'Request']) {
    const before = calls.length;
    const input = kind === 'string' ? origin + '/single' : (await auditModule.exports.prepareImageProviderRequest({
      url: origin + '/single', init: { method: 'POST', body: 'fixture', headers: { 'Content-Type': 'application/json' } },
      providerProtocol: 'images_generations', projection: { userPromptSha256: sha('fixture'), effectivePromptSha256: sha('fixture'), modelIdSha256: sha('fixture'), aspectRatio: '3:4', resolution: '2K', imageCount: 1, referenceCount: 0 },
    })).request;
    const init = kind === 'string' ? { method: 'POST', body: 'fixture' } : {};
    await assert.rejects(module.exports.fetchSynchronousImageProvider(input, init, 1200), /fetch failed|dispatch|replay|retry/i);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(calls.slice(before), [{ method: 'POST', bodyBytes: 7 }], 'HTTP 421 must not dispatch POST headers or body again');
    for (let attempt = 0; attempt < 80 && sockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sockets.size, 0);
    results.push({ inputKind: kind === 'Request' ? 'audited prepared Request' : kind, originalResponseStatus: 421, upstreamPosts: 1, bodyBytes: 7, socketsRemaining: 0, rejected: true });
  }
  assert.equal(getGlobalDispatcher(), globalBefore);
  assert.equal(readFileSync(path.join(root, auditPath), 'utf8'), auditSource);
  assert.equal(readFileSync(path.join(root, 'src/lib/server/image-provider-http.ts'), 'utf8'), source);
  const report = { passed: true, sourceSha256: createHash('sha256').update(source).digest('hex'), localOnly: true, localHttpRequests: calls.length, externalProviderCalls: 0, liveDatabaseCalls: 0, globalDispatcherUnchanged: true, results };
  console.log(JSON.stringify(report, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

