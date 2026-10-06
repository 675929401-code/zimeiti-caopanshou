import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function load(transcripts, old = false) {
  const calls = { parse: 0, transcription: 0, charges: [], otherProviders: 0 };
  const plugin = { role: 'extract_text_third_party', type: 'third_party', price_per_use: 0.02, config: { api_base_url: 'https://ppt6-fixture.invalid/parse', response_format: 'ppt6', client_id: 'fixture', client_secret_key: 'fixture' } };
  const db = { from(table) {
    const filters = {};
    const value = () => ({ data: table === 'users' ? { cash_balance: 10 } : table === 'plugins' ? (filters.role === plugin.role ? plugin : null) : [], error: null });
    const query = { select() { return query; }, eq(k,v) { filters[k] = v; return query; }, in(k,v) { if (k === 'role' && v.includes(plugin.role)) filters.role = plugin.role; return query; }, limit() { return query; }, maybeSingle: async () => value(), single: async () => value(), then: resolve => Promise.resolve(value()).then(resolve) };
    return query;
  } };
  const modules = {
    'next/server': { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/auth': { verifyToken: async () => ({ userId: 'fixture', role: 'student' }) },
    '@/storage/database/supabase-client': { getSupabaseClient: () => db },
    '@/lib/billing': { deductCash: async (_id, value) => { calls.charges.push(value); return { success: true }; } },
    '@/lib/revenue': { recordRevenue: async () => {} },
    '@/lib/extraction-exactly-once': { withExtractionExactlyOnce: (_kind, handler) => handler },
    'coze-coding-dev-sdk': {}, '@/lib/cyanlis-client': { getCyanlisConfig: async () => null },
    '@/lib/extract-download-signature': {}, '@/lib/extract-local-video-cache': {},
    '@/lib/extract-provider-get-once': { ExtractionProviderGetError: class extends Error {}, fetchExtractionProviderGetOnce: () => { throw Error('Video helper is not used by the text fixture'); } },
  };
  const globals = { Request, Response, Headers, URL, AbortSignal, process: { env: {} }, console: { log() {}, error() {}, warn() {} },
    async fetch(url) { if (new URL(url).hostname !== 'ppt6-fixture.invalid') { calls.otherProviders++; throw new Error('No fallback allowed'); } calls.parse++; return Response.json({ code: 200, data: { title: 'This is only a title', desc: 'Only metadata', video_url: 'https://media.invalid/video.mp4' } }); },
    __fixtureTranscribe: async () => transcripts[calls.transcription++] || { transcript: null, method: 'none' },
  };
  function evaluate(file, append = '') { const compiledModule = { exports: {} }; runInNewContext(compile(readFileSync(file, 'utf8')) + append, { ...globals, exports: compiledModule.exports, module: compiledModule, require(id) { assert.ok(id in modules, `Unstubbed ${id}`); return modules[id]; } }); return compiledModule.exports; }
  modules['@/lib/extract-pricing'] = evaluate('src/lib/extract-pricing.ts');
  modules['@/lib/extract-transcript'] = evaluate('src/lib/extract-transcript.ts');
  modules['@/lib/extract-distinct-links'] = evaluate('src/lib/extract-distinct-links.ts');
  const route = evaluate(old ? '.codex-backups/20260902-223535-extract-transcript-only/src/app/api/extract/route.ts' : 'src/app/api/extract/route.ts', '\ntranscribeVideo = __fixtureTranscribe;');
  return { calls, async submit(count = 1) { const response = await route.POST(new Request('http://fixture.invalid/api/extract', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Idempotency-Key': 'fixture-transcript-only' }, body: JSON.stringify({ links: Array.from({ length: count }, (_, index) => `https://www.douyin.com/video/123456789012345678${index}`), extraction_mode: 'text', client_request_id: 'fixture-transcript-only' }) })); return { status: response.status, body: await response.json() }; } };
}
const old = load([{ transcript: null, method: 'none' }], true);
const oldResult = await old.submit();
assert.equal(oldResult.body.success, true);
assert.equal(oldResult.body.texts[0].content, 'Only metadata\nThis is only a title');
assert.deepEqual(old.calls.charges, [0.02]);
let cases = 1;
for (const missing of [null, '', '   ']) {
  const test = load([{ transcript: missing, method: 'none' }]);
  const { body } = await test.submit();
  assert.equal(body.success, false); assert.equal(body.texts[0].success, false);
  assert.equal(body.texts[0].content, ''); assert.equal(body.charged, false);
  assert.equal(test.calls.otherProviders, 0); assert.equal(test.calls.charges.length, 0); cases++;
}
for (const method of ['asr', 'llm', 'llm_fallback']) {
  const test = load([{ transcript: '  这是音频里真正说出来的正文。\n下一句话也应保留。  ', method }]);
  const { body } = await test.submit();
  assert.equal(body.success, true); assert.equal(body.texts[0].content, '这是音频里真正说出来的正文。\n下一句话也应保留。');
  assert.equal(body.texts[0].source, 'asr_llm'); assert.equal(body.texts[0].transcriptMethod, method);
  assert.deepEqual(test.calls.charges, [0.02]); cases++;
}
const mixed = load([{ transcript: null, method: 'none' }, { transcript: '真实的第二条口播正文。', method: 'asr' }]);
const mixedResult = await mixed.submit(2);
assert.equal(mixedResult.body.texts.length, 2); assert.equal(mixedResult.body.texts[0].success, false); assert.equal(mixedResult.body.texts[1].success, true);
assert.deepEqual(mixed.calls.charges, [0.02]); assert.equal(mixed.calls.otherProviders, 0); cases++;
const evidence = { passed: true, cases, actualHandler: true, actualTranscriptHelper: true, transcriptionDependencyIsolated: true, originalMetadataFalseSuccessReproduced: true, realProviderCalls: 0, realDatabaseWrites: 0 };
mkdirSync('.codex-evidence/toolbox-real-e2e-20260902', { recursive: true });
writeFileSync('.codex-evidence/toolbox-real-e2e-20260902/transcript-only-fixture.json', JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
