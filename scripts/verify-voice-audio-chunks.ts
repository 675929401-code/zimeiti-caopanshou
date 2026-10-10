import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import ts from 'typescript';

// Execute the actual production module with only provider configuration and HTTP
// replaced. No credentials, network requests, storage, billing, or database writes.
const source = fs.readFileSync('src/lib/vs/volcengine.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
let responseBody = '';
let responseStatus = 200;
let fixtureCalls = 0;
type AudioResult = { audioUrl: string; duration: number };
const moduleExports: Record<string, (params: Record<string, unknown>) => Promise<AudioResult>> = {};
const context = vm.createContext({
  exports: moduleExports, Buffer, crypto, process: { env: {} }, AbortSignal, console,
  require(specifier: string) {
    if (specifier === '@/lib/server/voice-provider-config') return { loadVolcanoVoiceProviderConfig: async () => ({ apiKey: 'fixture-only' }) };
    if (specifier === '@/lib/voice-provider-concurrency') {
      return { withVoiceProviderSlot: async (_providerIdentity: string, operation: () => Promise<unknown>) => operation() };
    }
    throw new Error(`Unexpected dependency: ${specifier}`);
  },
  fetch: async () => {
    fixtureCalls += 1;
    return new Response(responseBody, { status: responseStatus, headers: { 'content-type': 'application/x-ndjson' } });
  },
});
vm.runInContext(js, context, { filename: 'actual-volcengine.cjs' });
const bytes = Buffer.from([73, 68, 51, 0, 255, 129, 64, 10, 22, 244, 61, 0, 128, 7, 9]);
const cases: Array<{ name: string; passed: boolean; detail: string }> = [];
async function check(name: string, action: () => Promise<void>) {
  try { await action(); cases.push({ name, passed: true, detail: 'pass' }); }
  catch (error) { cases.push({ name, passed: false, detail: error instanceof Error ? error.message : 'failed' }); }
}
const synthesizers = [
  { name: 'single', run: () => moduleExports.synthesizeSpeech({ text: '隔离验证', speaker: 'fixture-speaker' }) },
  { name: 'mix', run: () => moduleExports.synthesizeMixSpeech({ text: '隔离验证', speakers: [{ sourceSpeaker: 'fixture-a', mixFactor: 0.5 }, { sourceSpeaker: 'fixture-b', mixFactor: 0.5 }] }) },
];
async function main() {
for (const synthesizer of synthesizers) {
  for (const chunkSize of [1, 2, 3, 4, 5, 7, 8, 15]) {
    await check(`${synthesizer.name}:binary-chunks:${chunkSize}`, async () => {
      const events: Array<{ code: number; data?: string; duration?: number }> = [{ code: 0 }];
      for (let index = 0; index < bytes.length; index += chunkSize) events.push({ code: 0, data: bytes.subarray(index, index + chunkSize).toString('base64') });
      events.push({ code: 20000000, duration: 1250 });
      responseBody = events.map(event => JSON.stringify(event)).join('\r\n');
      responseStatus = 200;
      const result = await synthesizer.run();
      const decoded = Buffer.from(result.audioUrl.split(',')[1], 'base64');
      assert.equal(decoded.length, bytes.length, `decoded ${decoded.length} bytes; expected ${bytes.length}`);
      assert.deepEqual(decoded, bytes);
      assert.equal(result.duration, 1250);
    });
  }
  await check(`${synthesizer.name}:single-json`, async () => {
    responseBody = JSON.stringify({ code: 0, data: bytes.toString('base64'), duration: 1250 });
    responseStatus = 200;
    const result = await synthesizer.run();
    assert.deepEqual(Buffer.from(result.audioUrl.split(',')[1], 'base64'), bytes);
  });
  await check(`${synthesizer.name}:provider-error-after-audio`, async () => {
    responseBody = `${JSON.stringify({ code: 0, data: bytes.toString('base64') })}\n${JSON.stringify({ code: 55000000, message: 'fixture failure' })}`;
    responseStatus = 200;
    await assert.rejects(synthesizer.run, /55000000/u);
  });
  await check(`${synthesizer.name}:http-error`, async () => {
    responseBody = JSON.stringify({ code: 0, data: bytes.toString('base64') });
    responseStatus = 503;
    await assert.rejects(synthesizer.run);
  });
}
console.log(JSON.stringify({ source: 'ACTUAL_MODULE_WITH_ISOLATED_HTTP_FIXTURES', cases, fixtureCalls, realUpstreamCalls: 0, databaseWrites: 0 }, null, 2));
if (cases.some(test => !test.passed)) process.exitCode = 1;
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
