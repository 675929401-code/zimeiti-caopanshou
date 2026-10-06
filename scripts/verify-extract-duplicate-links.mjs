import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import ts from 'typescript';

const cases = [], link = 'https://v.douyin.com/public-example/', key = 'fixture-batch-dedup-unique-key';
const oldRoute = '.codex-backups/20260903-013300-toolbox-format-batch/src__app__api__extract__route.ts';
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function fixture({ before = false, lost = false, failSecond = false } = {}) {
  const calls = { provider: 0, fallback: 0, chargeAmounts: [], revenue: 0, providerBodies: [], cache: 0 }; let record;
  const plugin = { role: 'extract_video', type: 'third_party', price_per_use: 0.02, cost_price: 0,
    config: { api_base_url: 'https://ppt6-fixture.invalid/parse', response_format: 'ppt6', provider: 'ppt6', client_id: 'fixture-id', client_secret_key: 'fixture-key' } };
  const fakeFetch = async (raw, init) => {
    if (new URL(raw).hostname !== 'ppt6-fixture.invalid') { calls.fallback++; throw Error('fallback forbidden'); }
    assert.equal(init.method, 'GET'); calls.provider++; calls.providerBodies.push({ url: new URL(raw).searchParams.get('url') });
    if (lost) throw Error('fixture response lost');
    if (failSecond && calls.provider === 2) return Response.json({ code: 104, msg: 'unsupported second input' });
    return Response.json({ code: 200, data: { video_mp4: `https://media.invalid/output-${calls.provider}.mp4` } });
  };
  const db = { from(table) { const filters = {}; const result = () => ({ data: table === 'users' ? { cash_balance: 10 } : table === 'plugins' ? (!filters.role || filters.role === plugin.role ? plugin : null) : [], error: null });
    const query = { select() { return this; }, eq(k, v) { filters[k] = v; return this; }, in() { return this; }, limit() { return this; }, single: async () => result(), maybeSingle: async () => result(), then: resolve => Promise.resolve(result()).then(resolve) }; return query; },
    async rpc(name, args) {
      if (name === 'claim_extraction_attempt_atomic') {
        if (record) { if (record.payload_fingerprint !== args.p_payload_fingerprint) return { data: null, error: { code: 'P0001', message: 'fixture payload conflict' } }; return { data: { created: false, record }, error: null }; }
        record = { record_id: args.p_record_id, user_id: args.p_user_id, client_request_id: args.p_client_request_id, request_kind: args.p_request_kind, payload_fingerprint: args.p_payload_fingerprint, state: 'running', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        return { data: { created: true, record }, error: null };
      }
      if (name === 'checkpoint_extraction_request_atomic') {
        record = { ...record, request_snapshot: args.p_request_snapshot, provider_checkpoint: record.provider_checkpoint || {}, provider_evidence: {}, billing_evidence: {} };
        return { data: { record }, error: null };
      }
      if (name === 'checkpoint_extraction_provider_atomic') {
        record = { ...record, provider_checkpoint: { result: args.p_provider_result }, provider_task_id: args.p_provider_task_id || null };
        return { data: { record }, error: null };
      }
      assert.equal(name, 'finalize_extraction_attempt_atomic');
      record = { ...record, state: args.p_state, http_status: args.p_http_status, response: args.p_response, provider_evidence: args.p_provider_evidence, billing_evidence: args.p_billing_evidence, error_code: args.p_error_code, error_message: args.p_error_message };
      return { data: { record }, error: null };
    } };
  const modules = { 'next/server': { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } },
    'node:async_hooks': { AsyncLocalStorage },
    '@/lib/auth': { verifyToken: async () => ({ userId: 'fixture-user', role: 'student' }) }, 'node:crypto': { createHash },
    '@/lib/extraction-auth': { authorizeExtractionRequest: async () => ({ ok: true, userId: 'fixture-user', role: 'student' }) },
    '@/lib/extraction-history': { sanitizeOwnedExtractionResponse: value => value },
    '@/lib/coze-workflow-client': { runCozeCaptionWorkflow: async () => { throw new Error('coze must not run for video'); }, detectCozeCaptionMode: input => String(input).includes('/user/') ? 'creator_home' : 'single_video' },
    '@/lib/coze-extraction-result': { cozeCaptionResults: () => [], parseCozeWorkflowResult: () => ({}), CozeWorkflowExecutionError: class extends Error {}, cozeWorkflowFailure: () => ({}) },
    '@/storage/database/supabase-client': { getSupabaseClient: () => db, getSupabaseAdminClient: () => db },
    '@/lib/billing': { deductCash: async (_user, amount) => { calls.chargeAmounts.push(amount); return { success: true }; } },
    '@/lib/revenue': { recordRevenue: async () => { calls.revenue++; } }, 'coze-coding-dev-sdk': {},
    '@/lib/extract-provider-get-once': { ExtractionProviderGetError: class extends Error {}, fetchExtractionProviderGetOnce: raw => fakeFetch(raw, { method: 'GET' }) },
    '@/lib/cyanlis-client': { getCyanlisConfig: async () => null, getDouyinVideoDetail: async () => ({ success: false }), getDouyinVideoToText: async () => ({ success: false }) },
    '@/lib/extraction-provider-error': {
      extractionProviderProblem: () => undefined,
      sanitizeExtractionErrorFields: value => value,
    },
    '@/lib/extract-download-signature': {}, '@/lib/extract-local-video-cache': {
      cacheExtractVideoForProvider: async () => null,
      cacheExtractVideoForTemporaryOwner: async () => {
        calls.cache++;
        return { fileHash: `fixture-file-${calls.cache}`, temporaryUrl: `/api/extract/local-video?fixture=${calls.cache}`, expiresAt: Date.now() + 60_000 };
      },
    } };
  function load(file) { const compiledModule = { exports: {} }; vm.runInNewContext(compile(file), { module: compiledModule, exports: compiledModule.exports,
    require: id => { assert.ok(id in modules, `UNSTUBBED_${id}`); return modules[id]; },
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, Buffer, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    setTimeout(callback) { callback(); return 0; }, clearTimeout() {},
    fetch: fakeFetch,
  }); return compiledModule.exports; }
  modules['@/lib/extract-pricing'] = load('src/lib/extract-pricing.ts');
  modules['@/lib/extract-transcript'] = load('src/lib/extract-transcript.ts');
  modules['@/lib/extraction-exactly-once'] = load('src/lib/extraction-exactly-once.ts');
  modules['@/lib/extract-distinct-links'] = load('src/lib/extract-distinct-links.ts');
  const route = load(before ? oldRoute : 'src/app/api/extract/route.ts');
  return { calls, record: () => record, helper: modules['@/lib/extract-distinct-links'], fingerprint: modules['@/lib/extraction-exactly-once'].extractionPayloadFingerprint,
    async submit(links, mode = 'video', shareText) { const response = await route.POST(new Request('http://fixture.invalid/api/extract', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Idempotency-Key': key }, body: JSON.stringify({ links, extraction_mode: mode, client_request_id: key, ...(shareText ? { douyin_share_text: shareText } : {}) }) })); return { status: response.status, body: await response.json(), replayed: response.headers.get('X-Extraction-Replayed') }; } };
}
const before = fixture({ before: true });
const old = await before.submit([link, link]);
assert.equal(old.status, 200); assert.equal(before.calls.provider, 2); assert.deepEqual(before.calls.chargeAmounts, [0.04]);
cases.push('legacy batch illustrates duplicate supplier execution and duplicate charging');

const multi = fixture();
const deduplicated = await multi.submit([link, link]);
assert.equal(deduplicated.status, 200);
assert.equal(multi.calls.provider, 1); assert.deepEqual(multi.calls.chargeAmounts, [0.02]);
assert.equal(deduplicated.body.videos.length, 2);
assert.equal(deduplicated.body.videos[1].duplicate_of, 0);
assert.equal(deduplicated.body.videos[0].temporary_url, deduplicated.body.videos[1].temporary_url);
cases.push('identical input rows share one supplier and settlement boundary before ordered expansion');

const distinctMulti = fixture();
const rejected = await distinctMulti.submit([link, 'https://v.douyin.com/another-video/']);
assert.equal(rejected.status, 400);
assert.equal(rejected.body.error_code, 'EXTRACTION_VIDEO_SINGLE_LINK_REQUIRED');
assert.equal(rejected.body.provider_call_started, false);
assert.equal(distinctMulti.calls.provider, 0); assert.deepEqual(distinctMulti.calls.chargeAmounts, []);
cases.push('current route rejects multiple distinct video links before supplier and wallet work');

const current = fixture();
const response = await current.submit([link]);
assert.equal(response.status, 200); assert.equal(current.calls.provider, 1); assert.deepEqual(current.calls.chargeAmounts, [0.02]);
assert.equal(response.body.videos.length, 1);
assert.equal(current.record().client_request_id, key);
assert.equal(current.record().payload_fingerprint, current.fingerprint('single', { links: [link], extraction_mode: 'video', client_request_id: key }));
cases.push('one URL owns one exactly-once provider and settlement boundary');

assert.equal((await current.submit([link])).replayed, 'true');
assert.equal(current.calls.provider, 1); assert.deepEqual(current.calls.chargeAmounts, [0.02]);
cases.push('same single-link request replays without supplier or wallet work');

assert.notEqual((await current.submit([`${link}?different=1`])).status, 200);
assert.equal(current.calls.provider, 1);
cases.push('same idempotency key with a different link is refused before supplier work');

const otherLink = 'https://v.douyin.com/another-video/';
const plannerCases = [
  ['identical links collapse', [link, link], 1],
  ['different video paths stay distinct', [link, otherLink], 2],
  ['meaningful query values stay distinct', [`${link}?id=1`, `${link}?id=2`], 2],
  ['query order stays distinct', [`${link}?a=1&b=2`, `${link}?b=2&a=1`], 2],
  ['host case and default TLS port canonicalize', [link, 'https://V.DOUYIN.COM:443/public-example/'], 1],
];
for (const [name, inputs, expected] of plannerCases) {
  assert.equal(current.helper.planDistinctExtractionLinks(inputs).uniqueLinks.length, expected);
  cases.push(name);
}

for (const share of [otherLink, `这是分享句子 ${link}`]) {
  const f = fixture(); const textResponse = await f.submit([link, link], 'text', share);
  assert.equal(textResponse.status, 400); assert.equal(textResponse.body.error_code, 'EXTRACTION_BATCH_SHARE_INPUT_AMBIGUOUS');
  assert.equal(textResponse.body.provider_call_started, false); assert.equal(f.calls.provider, 0);
  cases.push('ambiguous text batch share input is rejected before provider work');
}

const unknown = fixture({ lost: true });
assert.equal((await unknown.submit([link])).status, 409);
assert.equal(unknown.record().state, 'failed_unknown'); assert.equal(unknown.calls.provider, 1); assert.equal(unknown.calls.fallback, 0);
assert.equal((await unknown.submit([link])).status, 409); assert.equal(unknown.calls.provider, 1);
cases.push('unknown single-link outcome replays without another supplier call');

let directCalls = 0;
const wrapped = current.helper.withDistinctExtractionLinks(async () => {
  directCalls++;
  return Response.json({ success: true, videos: [{ success: true }, { success: true }] });
}, () => true);
const badMapping = await wrapped(new Request('http://fixture.invalid/api/extract', {
  method: 'POST',
  body: JSON.stringify({ links: [link, link], extraction_mode: 'video', client_request_id: key }),
}));
assert.equal(badMapping.status, 503); assert.equal((await badMapping.json()).retry_safe, false); assert.equal(directCalls, 1);
cases.push('unexpected deduplicated result cardinality remains fail-closed');
const report = { passed: true, scenarios: cases.length, cases, actualRouteAndExactlyOnce: true, realNetworkRequests: 0, realDatabaseWrites: 0 };
const out = path.resolve('.codex-evidence/toolbox-batch-20260903/deduplication-fixture.json'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
