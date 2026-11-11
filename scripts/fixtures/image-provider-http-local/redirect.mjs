import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Agent, getGlobalDispatcher } from 'undici';
import ts from 'typescript';
const root = process.cwd(), calls = [], sockets = new Set();
const server = createServer(async (request, response) => {
  for await (const chunk of request) void chunk;
  calls.push({ method: request.method, path: request.url });
  const status = Number(request.url.slice('/redirect'.length));
  if ([307, 308].includes(status)) { response.writeHead(status, { location: '/target' }); response.end(); }
  else response.end('unexpected redirected request');
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const source = readFileSync(path.join(root, 'src/lib/server/image-provider-http.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} }, dispatcherBefore = getGlobalDispatcher();
vm.runInNewContext(output, { module, exports: module.exports, Error, Number, String, AbortSignal,
  fetch: (input, init) => { assert.equal(new URL(typeof input === 'string' ? input : input.url).origin, origin); return fetch(input, init); },
  require: id => id === 'server-only' ? {} : id === 'undici' ? { Agent } : assert.fail('Unexpected import ' + id) });
const results = [];
try {
  for (const status of [307, 308]) for (const inputKind of ['string', 'Request']) {
    const before = calls.length;
    const input = inputKind === 'string' ? origin + '/redirect' + status : new Request(origin + '/redirect' + status, { method: 'POST', body: 'fixture', redirect: 'follow' });
    const init = inputKind === 'string' ? { method: 'POST', body: 'fixture', redirect: 'follow' } : { redirect: 'follow' };
    await assert.rejects(module.exports.fetchSynchronousImageProvider(input, init, 1200), /fetch failed|redirect/i);
    assert.deepEqual(calls.slice(before), [{ method: 'POST', path: '/redirect' + status }]);
    for (let attempt = 0; attempt < 80 && sockets.size; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(sockets.size, 0);
    results.push({ status, inputKind, posts: 1, targetPosts: 0, socketsRemaining: 0, rejected: true });
  }
  assert.equal(getGlobalDispatcher(), dispatcherBefore);
  assert.equal(readFileSync(path.join(root, 'src/lib/server/image-provider-http.ts'), 'utf8'), source);
  const report = { passed: true, sourceSha256: createHash('sha256').update(source).digest('hex'), localOnly: true, localHttpRequests: calls.length, externalProviderCalls: 0, liveDatabaseCalls: 0, globalDispatcherUnchanged: true, results };
  console.log(JSON.stringify(report, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
