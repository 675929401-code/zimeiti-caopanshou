import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Agent } from 'undici';
import ts from 'typescript';
const root = process.cwd(), calls = [], events = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const files = ['src/lib/server/image-provider-http.ts', 'src/app/api/image/generate/route.ts', 'src/lib/image-provider-request-audit.ts'];
const sources = Object.fromEntries(files.map(file => [file, readFileSync(path.join(root, file), 'utf8')]));
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  calls.push({ method: request.method, path: request.url, bodySha256: sha(Buffer.concat(chunks)) });
  events.push('provider-post');
  if (request.url.startsWith('/redirect')) { response.writeHead(Number(request.url.slice('/redirect'.length)), { location: '/target' }); response.end(); }
  else if (request.url === '/misdirected') { response.writeHead(421); response.end('misdirected'); }
  else if (request.url === '/network-failure') request.socket.destroy();
  else response.end('success');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
function load(source, ports) {
  const module = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Error, Number, String, AbortSignal, Request, URL, Uint8Array, TextDecoder, console, ...ports });
  return module.exports;
}
let fetchCalls = 0;
const guardedFetch = (input, init) => { assert.equal(new URL(typeof input === 'string' ? input : input.url).origin, origin); fetchCalls++; events.push('fetch'); return fetch(input, init); };
const helper = load(sources[files[0]], { fetch: guardedFetch, require: id => id === 'server-only' ? {} : id === 'undici' ? { Agent } : assert.fail('Unexpected import ' + id) });
const audit = load(sources[files[2]], { require: id => id === 'node:crypto' ? { createHash, randomUUID } : assert.fail('Unexpected import ' + id) });
const routeAst = ts.createSourceFile(files[1], sources[files[1]], ts.ScriptTarget.Latest, true);
const names = ['fetchImageUpstream', 'fetchAuditedImageProviderPost'];
const declarations = names.map(name => { const fn = routeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name); assert.ok(fn); return fn.getText(routeAst); }).join('\n');
const route = load(declarations + '\nmodule.exports={fetchAuditedImageProviderPost};', { ...helper, ...audit, fetch: guardedFetch, safeUpstreamTarget: url => new URL(url).origin,
  summarizeFetchCause: error => error.message, summarizeUpstreamImageError: text => text,
  console: { error: () => {} } });
const results = [];
try {
  for (const scenario of ['success', 'gate-reject', 'redirect307', 'redirect308', 'misdirected', 'network-failure']) {
    events.length = 0;
    const beforePosts = calls.length, beforeFetch = fetchCalls, submissions = [], dispatches = [];
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'fixture', prompt: 'fixture' }) };
    const context = {
      recordProviderDispatchReceipt: async receipt => { events.push('dispatch-record-start'); if (scenario === 'gate-reject') throw new Error('fixture-ack-rejected'); await Promise.resolve(); dispatches.push(receipt); events.push('dispatch-ack'); return receipt; },
      recordProviderSubmissionReceipt: async receipt => { submissions.push(receipt); events.push('submission-receipt'); return receipt; },
    };
    const operation = route.fetchAuditedImageProviderPost({ url: origin + '/' + scenario, init, providerProtocol: 'images_generations',
      projection: { userPromptSha256: sha('fixture'), effectivePromptSha256: sha('fixture'), modelIdSha256: sha('fixture'), aspectRatio: '3:4', resolution: '2K', imageCount: 1, referenceCount: 0 }, receiptContext: context });
    if (scenario === 'success') {
      const result = await operation; assert.equal(await result.response.text(), 'success'); assert.equal(submissions.length, 0);
    } else await assert.rejects(operation);
    if (scenario === 'gate-reject') {
      assert.equal(calls.length - beforePosts, 0); assert.equal(fetchCalls - beforeFetch, 0); assert.equal(dispatches.length, 0); assert.equal(submissions.length, 0);
    } else {
      assert.equal(calls.length - beforePosts, 1); assert.equal(fetchCalls - beforeFetch, 1); assert.equal(dispatches.length, 1);
      assert.ok(events.indexOf('dispatch-ack') < events.indexOf('fetch')); assert.ok(events.indexOf('dispatch-ack') < events.indexOf('provider-post'));
      assert.equal(dispatches[0].actualPayloadSha256, calls[beforePosts].bodySha256);
      if (scenario !== 'success') { assert.equal(submissions.length, 1); assert.equal(submissions[0].transportState, 'transport_error'); assert.equal(submissions[0].dispatchReceiptSha256, dispatches[0].receiptSha256); }
    }
    results.push({ scenario, localPosts: calls.length - beforePosts, fetchCalls: fetchCalls - beforeFetch, dispatchReceipts: dispatches.length, transportErrorReceipts: submissions.length, events: [...events] });
  }
  for (const file of files) assert.equal(readFileSync(path.join(root, file), 'utf8'), sources[file]);
  const report = { passed: true, localOnly: true, externalProviderCalls: 0, liveDatabaseCalls: 0,
    sourceHashes: files.map(file => ({ path: file, sha256: sha(sources[file]) })),
    evidence: 'Actual AST-extracted route fetch wrapper and audited POST plus complete real audit module and helper; receipt acknowledgements are in-memory fixtures. The only HTTP server binds 127.0.0.1 random port.', results };
  console.log(JSON.stringify(report, null, 2));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
