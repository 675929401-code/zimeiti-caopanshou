#!/usr/bin/env node
// Executes the real response wrapper with isolated streams and an in-memory store.
// No .env, provider, JWT, remote database, or business writes are used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const encoder = new TextEncoder();
const cases = [];
const execution = { record: { recordId: 'fixture-record', attemptNo: 1 }, leaseOwner: 'fixture-owner', leaseToken: 1 };
const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
const markerText = frame({ choices: [{ delta: { content: '普通文字 [DONE] 后面还要继续输出中文😀' } }] });
const billing = frame({ billing_complete: true });
const done = 'data: [DONE]\n\n';

function loadWrapper(sourcePath) {
  const compiledModule = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    module: compiledModule, exports: compiledModule.exports, Response, Headers, ReadableStream,
    TextEncoder, TextDecoder, Buffer, setTimeout,
    fetch() { throw new Error('Network is forbidden in this regression'); },
    require(name) {
      if (name === 'node:crypto') return require(name);
      if (name === '@/storage/database/supabase-client') return { getSupabaseAdminClient() { throw new Error('Database is forbidden in this regression'); } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }, { filename: 'isolated-llm-response-wrapper.js' });
  return compiledModule.exports.completeLlmAttemptResponse;
}

function gate() {
  let resolve;
  const promise = new Promise(accept => { resolve = accept; });
  return { promise, resolve };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Isolated stream timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function remaining(reader) {
  const decoder = new TextDecoder();
  let output = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    output += decoder.decode(part.value, { stream: true });
  }
  return output + decoder.decode();
}

async function firstFrameWhileOpen(wrapper) {
  let upstream;
  const saved = [];
  const source = new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await wrapper({ async finalize(input) { saved.push(input); return execution.record; } }, execution, source);
  const reader = response.body.getReader();
  upstream.enqueue(encoder.encode(markerText));
  let first;
  const read = reader.read().then(result => { first = result; return result; });
  await new Promise(resolve => setTimeout(resolve, 80));
  const streamedWhileOpen = first !== undefined;
  assert.equal(saved.length, 0, 'The upstream is still open, so persistence cannot have finished');
  upstream.enqueue(encoder.encode(billing + done));
  upstream.close();
  const firstResult = await within(read);
  const output = new TextDecoder().decode(firstResult.value) + await within(remaining(reader));
  return { streamedWhileOpen, output, saved };
}

const wrapper = loadWrapper(path.join(root, 'src/lib/llm-request-idempotency.ts'));
const beforeArg = process.argv.find(argument => argument.startsWith('--before='));
assert.ok(beforeArg, 'Provide the actual before-edit snapshot for regression proof');
const beforePath = path.resolve(root, beforeArg.slice('--before='.length));
assert.ok(beforePath.startsWith(`${path.join(root, '.codex-backups')}${path.sep}`));
const before = await firstFrameWhileOpen(loadWrapper(beforePath));
assert.equal(before.streamedWhileOpen, false, 'The old source delays ordinary content containing [DONE]');
const after = await firstFrameWhileOpen(wrapper);
assert.equal(after.streamedWhileOpen, true, 'Ordinary model text must reach the client before the upstream closes');
assert.equal(after.output, markerText + billing + done);
assert.equal(after.saved[0].state, 'succeeded');
cases.push('actual before/after source: literal marker text streams immediately');

{
  const persistEntered = gate();
  const allowPersist = gate();
  let upstream;
  const source = new Response(new ReadableStream({ start(controller) { upstream = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  const saved = [];
  const response = await wrapper({ async finalize(input) {
    saved.push(input); persistEntered.resolve(); await allowPersist.promise; return execution.record;
  } }, execution, source);
  const reader = response.body.getReader();
  upstream.enqueue(encoder.encode(markerText));
  assert.equal(new TextDecoder().decode((await within(reader.read())).value), markerText);
  let terminalDelivered = false;
  const tail = remaining(reader).then(output => { terminalDelivered = true; return output; });
  upstream.enqueue(encoder.encode(billing + done)); upstream.close();
  await within(persistEntered.promise);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminalDelivered, false, 'Completion must wait for durable persistence');
  allowPersist.resolve();
  assert.equal(await within(tail), billing + done);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].responseBody, markerText + billing + done);
  cases.push('real completion waits for durable persistence; content does not');
}

async function runWire(raw, chunks = [encoder.encode(raw)]) {
  const saved = [];
  const source = new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await wrapper({ async finalize(input) { saved.push(input); return execution.record; } }, execution, source);
  const output = await within(response.text());
  assert.equal(saved.length, 1);
  return { output, saved: saved[0] };
}

for (const [name, raw, state] of [
  ['comment cannot supply a DONE marker', ': data: [DONE]\n\n' + billing, 'failed_unknown'],
  ['DONE prefix is ordinary text', 'data: [DONE] is an example\n\n' + billing, 'failed_unknown'],
  ['comment cannot supply billing success', ': "billing_complete": true\n\n' + done, 'failed_unknown'],
  ['nested payload cannot supply billing success', frame({ choices: [{ billing_complete: true }] }) + done, 'failed_unknown'],
  ['nested error code is ordinary model data', frame({ choices: [{ code: 'LLM_BILLING_FAILED' }] }), 'failed_unknown'],
  ['billing failure is recognized', frame({ code: 'LLM_BILLING_FAILED' }), 'reconciliation_required'],
  ['empty response is recognized', frame({ code: 'LLM_EMPTY_RESPONSE' }), 'failed'],
  ['explicit billing failure cannot be masked by completion', billing + frame({ code: 'LLM_BILLING_FAILED' }) + done, 'reconciliation_required'],
]) {
  const result = await runWire(raw);
  assert.equal(result.saved.state, state, name);
  assert.equal(result.output.includes('\ndata: [DONE]\n\n'), false, 'Unsafe completion is not released');
  cases.push(name);
}

{
  const raw = markerText + 'event: conversation.chat.completed\ndata: {\ndata: "billing_complete": true\ndata: }\n\n';
  const result = await runWire(raw);
  assert.equal(result.saved.state, 'succeeded');
  assert.equal(result.output, raw + done, 'A model-text marker cannot suppress the real final signal');
  assert.equal(result.saved.responseBody, result.output);
  cases.push('multiline JSON completion emits and persists one real DONE signal');
}

{
  const raw = (markerText + billing + done).replaceAll('\n', '\r\n');
  const bytes = encoder.encode(raw);
  const result = await runWire(raw, Array.from(bytes, byte => Uint8Array.of(byte)));
  assert.equal(result.saved.state, 'succeeded');
  assert.equal(result.output, raw);
  assert.equal(result.saved.responseBody, raw);
  cases.push('every-byte UTF-8 and CRLF chunk boundaries preserve content and replay');
}

{
  const savedStates = [];
  const source = new Response(markerText + billing + done, { headers: { 'content-type': 'text/event-stream' } });
  const response = await wrapper({ async finalize(input) {
    savedStates.push(input.state);
    if (input.state === 'succeeded') throw new Error('Synthetic persistence failure');
    return execution.record;
  } }, execution, source);
  const output = await within(response.text());
  assert.equal(savedStates.at(-1), 'failed_unknown');
  assert.ok(output.startsWith(markerText));
  assert.ok(output.includes('LLM_ATTEMPT_RECONCILIATION_REQUIRED'));
  assert.equal(output.includes(done), false);
  assert.equal(output.includes(billing), false);
  cases.push('persistence failure releases no success or billing-complete signal');
}

const evidenceDir = path.join(root, '.codex-evidence/llm-sse-control-20260902');
fs.mkdirSync(evidenceDir, { recursive: true });
const result = { checkedAt: new Date().toISOString(), passed: true, cases, caseCount: cases.length, networkCalls: 0, databaseWrites: 0, realProviderGeneration: false, beforeSnapshot: path.relative(root, beforePath) };
fs.writeFileSync(path.join(evidenceDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
