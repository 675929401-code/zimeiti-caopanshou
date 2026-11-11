import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import { Agent, getGlobalDispatcher } from 'undici';
import ts from 'typescript';
const root = process.cwd();
const sourcePath = 'src/lib/server/image-provider-http.ts';
const source = readFileSync(path.join(root, sourcePath), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const agentEvents = [];
class ObservedAgent extends Agent {
  constructor(options) { super(options); this.record = { options, closeCalled: false, closeSettled: false, destroyCalled: false }; agentEvents.push(this.record); }
  close(...args) { this.record.closeCalled = true; const value = super.close(...args); value?.then(() => { this.record.closeSettled = true; }, () => { this.record.closeSettled = true; }); return value; }
  destroy(...args) { this.record.destroyCalled = true; return super.destroy(...args); }
}
const requests = [], sockets = new Set();
const server = createServer(async (request, response) => {
  for await (const part of request) void part;
  requests.push({ method: request.method, path: request.url });
  const timers = [];
  response.on('close', () => timers.forEach(timer => { clearTimeout(timer); clearInterval(timer); }));
  if (request.url === '/headers-timeout') { timers.push(setTimeout(() => response.end('too-late'), 700)); return; }
  if (request.url === '/success') {
    timers.push(setTimeout(() => { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('first:'); timers.push(setTimeout(() => response.end('last'), 220)); }, 120));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }); response.write('first:');
  timers.push(setInterval(() => response.write('chunk:'), 80));
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
let fetchCalls = 0;
const module = { exports: {} };
const globalDispatcherBefore = getGlobalDispatcher();
vm.runInNewContext(compiled, { module, exports: module.exports, Error, Number, String, AbortSignal,
  fetch: (input, init) => { assert.equal(new URL(typeof input === 'string' ? input : input.url).origin, origin); fetchCalls++; return fetch(input, init); },
  require: id => id === 'server-only' ? {} : id === 'undici' ? { Agent: ObservedAgent } : assert.fail('Unexpected import ' + id),
});
const { fetchSynchronousImageProvider: send, synchronousImageProviderTimeoutMs: policy } = module.exports;
const results = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connectionsClosed() { for (let attempt = 0; attempt < 80 && sockets.size; attempt++) await sleep(25); assert.equal(sockets.size, 0); }
async function scenario(name, action) {
  const beforeRequests = requests.length, beforeFetch = fetchCalls, beforeAgent = agentEvents.length;
  const start = performance.now();
  await action();
  await connectionsClosed();
  assert.equal(fetchCalls - beforeFetch, 1); assert.equal(requests.length - beforeRequests, 1); assert.equal(requests.at(-1).method, 'POST');
  const agent = agentEvents[beforeAgent];
  assert.equal(agentEvents.length - beforeAgent, 1);
  assert.ok(agent.closeSettled || agent.destroyCalled, 'Per-call agent must finish closing or be destroyed');
  results.push({ scenario: name, elapsedMs: Math.round(performance.now() - start), posts: 1, socketsRemaining: sockets.size, agent });
}
try {
  assert.equal(policy('images_generations'), 600000); assert.equal(policy('images_edits'), 600000); assert.equal(policy('chat_completions'), 600000); assert.equal(policy('google_generate_content'), 720000);
  for (const protocol of ['images_generations_async', 'cover_workflow', 'poll', undefined]) assert.equal(policy(protocol), undefined);
  await scenario('Delayed headers and delayed body complete after graceful close begins', async () => {
    const response = await send(origin + '/success', { method: 'POST', body: 'fixture' }, 1200);
    assert.equal(agentEvents.at(-1).closeCalled, true); assert.equal(await response.text(), 'first:last');
  });
  await scenario('Header wait exceeds absolute deadline', async () => {
    await assert.rejects(send(origin + '/headers-timeout', { method: 'POST', body: 'fixture' }, 250), /timeout|aborted|fetch failed/i);
    assert.equal(agentEvents.at(-1).destroyCalled, true);
  });
  await scenario('Continually arriving body still ends at absolute deadline', async () => {
    const response = await send(origin + '/body', { method: 'POST', body: 'fixture' }, 350);
    await assert.rejects(response.text(), /timeout|aborted|terminated/i);
  });
  await scenario('Request.signal cancellation remains effective during body read', async () => {
    const controller = new AbortController();
    const request = new Request(origin + '/request-signal', { method: 'POST', body: 'fixture', signal: controller.signal });
    const response = await send(request, {}, 1200);
    const timer = setTimeout(() => controller.abort(new Error('request-cancelled')), 140);
    try { await assert.rejects(response.text(), /request-cancelled|aborted|terminated/i); } finally { clearTimeout(timer); }
  });
  await scenario('init.signal cancellation remains effective during body read', async () => {
    const controller = new AbortController();
    const response = await send(origin + '/init-signal', { method: 'POST', body: 'fixture', signal: controller.signal }, 1200);
    const timer = setTimeout(() => controller.abort(new Error('init-cancelled')), 140);
    try { await assert.rejects(response.text(), /init-cancelled|aborted|terminated/i); } finally { clearTimeout(timer); }
  });
  await scenario('Caller body cancellation releases the closing dispatcher', async () => {
    const response = await send(origin + '/body-cancel', { method: 'POST', body: 'fixture' }, 1200);
    await response.body.cancel('fixture stop');
  });
  assert.equal(getGlobalDispatcher(), globalDispatcherBefore);
  assert.equal(readFileSync(path.join(root, sourcePath), 'utf8'), source, 'Source changed during tests');
  const report = { passed: true, runtime: process.version, bundledUndici: process.versions.undici, dispatcherUndici: '7.28.0', sourceSha256: createHash('sha256').update(source).digest('hex'), localHttpRequests: requests.length, localOnly: true, externalProviderCalls: 0, liveDatabaseCalls: 0, globalDispatcherUnchanged: true, results };
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
