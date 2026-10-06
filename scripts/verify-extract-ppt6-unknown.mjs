import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Actual route + actual exactly-once wrapper, with mandatory isolated DB/provider
// fixtures. No runtime environment, real provider or real wallet is reachable.
const compile = file => ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const next = { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } };
const authorizeExtractionRequest = async () => ({ ok: true, userId: 'fixture-user', role: 'student' });
const link = 'https://www.douyin.com/video/1234567890123456789';
const fallbackResult = { code: 200, data: { aweme_detail: {
  aweme_id: '1234567890123456789', desc: 'fixture fallback',
  video: { play_addr: { url_list: ['https://media.invalid/fallback.mp4'] } },
} } };
class FixturePreflightError extends Error { constructor() { super('EXTRACTION_PROVIDER_TARGET_UNAVAILABLE'); this.code = 'EXTRACTION_PROVIDER_TARGET_UNAVAILABLE'; this.requestDispatched = false; } }

function load(fixture) {
  const calls = { ppt6: 0, otherProviders: 0, charges: 0, revenue: 0, finalize: 0, checkpoints: 0, cache: 0, logs: [], walletKeys: [] };
  let record;
  const pricedSettlementFixture = fixture === 'billing-fail-once' || fixture === 'revenue-fail-once';
  const plugin = {
    role: 'extract_video', type: 'third_party', price_per_use: pricedSettlementFixture ? 0.02 : 0, cost_price: pricedSettlementFixture ? 0.01 : 0,
    config: { api_base_url: 'https://ppt6-fixture.invalid/parse', response_format: 'ppt6', provider: 'ppt6', client_id: 'fixture-id', client_secret_key: 'fixture-key' },
  };
  const db = {
    from(table) {
      const filters = {};
      const result = () => ({ data: table === 'users' ? { cash_balance: 10 }
        : table === 'plugins' ? (!filters.role || filters.role === plugin.role ? plugin : null) : [], error: null });
      const query = {
        select() { return query; }, eq(key, value) { filters[key] = value; return query; },
        in() { return query; }, limit() { return query; },
        single: async () => result(), maybeSingle: async () => result(),
        then: resolve => Promise.resolve(result()).then(resolve),
      };
      return query;
    },
    async rpc(name, args) {
      if (name === 'claim_extraction_attempt_atomic') {
        if (!record && fixture === 'legacy-coze') {
          record = {
            record_id: args.p_record_id, user_id: args.p_user_id, client_request_id: args.p_client_request_id,
            request_kind: args.p_request_kind, payload_fingerprint: args.p_payload_fingerprint,
            state: 'running', request_snapshot: {}, provider_checkpoint: { result: {
              schema: 'coze_video_provider_result.v1',
              videos: [{ row: 0, col: 0, platform: 'douyin', success: true, url: 'https://media.invalid/legacy.mp4', download_url: 'https://media.invalid/legacy.mp4' }],
              providerTasks: [{ task_id: 'legacy-task' }], unitPrice: 0, costPrice: 0,
              billingExempt: false, userRole: 'student',
            } }, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
          };
          return { data: { created: false, record }, error: null };
        }
        if (record) {
          assert.equal(args.p_payload_fingerprint, record.payload_fingerprint);
          return { data: { created: false, record }, error: null };
        }
        record = {
          record_id: args.p_record_id, user_id: args.p_user_id, client_request_id: args.p_client_request_id,
          request_kind: args.p_request_kind, payload_fingerprint: args.p_payload_fingerprint,
          state: 'running', request_snapshot: {}, provider_checkpoint: {}, created_at: '2026-09-02T00:00:00Z', updated_at: '2026-09-02T00:00:00Z',
        };
        return { data: { created: true, record }, error: null };
      }
      if (name === 'checkpoint_extraction_request_atomic') {
        record = { ...record, request_snapshot: args.p_request_snapshot };
        return { data: { record }, error: null };
      }
      if (name === 'checkpoint_extraction_provider_atomic') {
        calls.checkpoints++;
        record = { ...record, provider_checkpoint: { result: args.p_provider_result }, provider_task_id: args.p_provider_task_id || null };
        return { data: { record }, error: null };
      }
      assert.equal(name, 'finalize_extraction_attempt_atomic'); calls.finalize++;
      record = { ...record, state: args.p_state, http_status: args.p_http_status,
        response: args.p_response, provider_evidence: args.p_provider_evidence, billing_evidence: args.p_billing_evidence,
        error_code: args.p_error_code, error_message: args.p_error_message };
      return { data: { record }, error: null };
    },
  };
  const globals = {
    Request, Response, Headers, URL, URLSearchParams, AbortSignal, Buffer,
    process: { env: {} }, console: { log(...args) { calls.logs.push(args.join(' ')); }, warn() {}, error(...args) { calls.logs.push(args.join(' ')); } },
    setTimeout(callback) { callback(); return 0; }, clearTimeout() {},
    async fetch(rawUrl) {
      if (new URL(rawUrl).hostname === 'ppt6-fixture.invalid') {
        calls.ppt6++;
        if (fixture === 'lost') throw new TypeError('fixture acknowledgement lost');
        if (fixture === 'malformed') return new Response('<html>fixture error</html>');
        if (fixture === 'preflight-second' || fixture === 'cache-fail-once' || pricedSettlementFixture) return Response.json({ code: 200, data: { video_mp4: 'https://media.invalid/one.mp4' } });
        if (fixture === 'unsafe-provider-message') return Response.json(calls.ppt6 === 1 ? { code: 200, data: { video_mp4: 'https://media.invalid/one.mp4' } } : { code: 108, msg: 'fixture-secret-in-message https://private.invalid/?key=fixture-secret-in-message' });
        if (typeof fixture === 'number') return new Response('fixture rejected', { status: fixture });
        return Response.json(fixture);
      }
      calls.otherProviders++;
      return Response.json(fallbackResult);
    },
  };
  const modules = {
    'next/server': next, 'node:crypto': { createHash }, 'node:async_hooks': { AsyncLocalStorage },
    '@/lib/extraction-auth': { authorizeExtractionRequest },
    '@/lib/extraction-history': { sanitizeOwnedExtractionResponse: value => value },
    '@/lib/coze-workflow-client': { runCozeCaptionWorkflow: async () => { throw new Error('coze must not run for video'); }, detectCozeCaptionMode: () => 'single_video' },
    '@/lib/coze-extraction-result': { cozeCaptionResults: () => [], parseCozeWorkflowResult: () => ({}), CozeWorkflowExecutionError: class extends Error {}, cozeWorkflowFailure: () => ({}) },
    '@/storage/database/supabase-client': { getSupabaseClient: () => db, getSupabaseAdminClient: () => db },
    '@/lib/billing': { deductCash: async (_userId, _amount, _description, key) => {
      calls.charges++; calls.walletKeys.push(key);
      if (fixture === 'billing-fail-once' && calls.charges === 1) return { success: false };
      return { success: true, alreadyFulfilled: calls.charges > 1 };
    } },
    '@/lib/revenue': { recordRevenue: async () => {
      calls.revenue++;
      if (fixture === 'revenue-fail-once' && calls.revenue === 1) throw new Error('fixture revenue unavailable');
    } },
    'coze-coding-dev-sdk': {}, '@/lib/cyanlis-client': { getDouyinVideoDetail: async () => ({ success: false }), getDouyinVideoToText: async () => ({ success: false }) },
    '@/lib/extract-download-signature': {}, '@/lib/extraction-provider-error': {
      extractionProviderProblem: () => undefined,
      sanitizeExtractionErrorFields: value => value,
    },
    '@/lib/extract-local-video-cache': {
      cacheExtractVideoForProvider: async () => null,
      cacheExtractVideoForTemporaryOwner: async () => {
        calls.cache++;
        if (fixture === 'cache-fail-once' && calls.cache === 1) throw new Error('fixture cache unavailable');
        return { fileHash: 'fixture-file', temporaryUrl: '/api/extract/local-video?fixture=1', expiresAt: Date.now() + 60_000 };
      },
    },
    '@/lib/extract-provider-get-once': { ExtractionProviderGetError: FixturePreflightError, fetchExtractionProviderGetOnce: rawUrl => {
      if (fixture === 'preflight' || (fixture === 'preflight-second' && calls.ppt6 === 1)) throw new FixturePreflightError();
      return globals.fetch(rawUrl);
    } },
  };
  function moduleExports(file) {
    const compiledModule = { exports: {} };
    runInNewContext(compile(file), { ...globals, module: compiledModule, exports: compiledModule.exports,
      require(id) { assert.ok(id in modules, `unstubbed module ${id}`); return modules[id]; },
    });
    return compiledModule.exports;
  }
  modules['@/lib/extract-pricing'] = moduleExports('src/lib/extract-pricing.ts');
  modules['@/lib/extract-transcript'] = moduleExports('src/lib/extract-transcript.ts');
  modules['@/lib/extract-distinct-links'] = moduleExports('src/lib/extract-distinct-links.ts');
  modules['@/lib/extraction-exactly-once'] = moduleExports('src/lib/extraction-exactly-once.ts');
  const route = moduleExports('src/app/api/extract/route.ts');
  return {
    calls, record: () => record,
    async submit(links = [link]) {
      const response = await route.POST(new Request('http://fixture.invalid/api/extract', {
        method: 'POST', headers: { authorization: 'Bearer fixture-session', 'Idempotency-Key': 'fixture-ppt6-unknown-1' },
        body: JSON.stringify({ links, extraction_mode: 'video', client_request_id: 'fixture-ppt6-unknown-1' }),
      }));
      return { status: response.status, body: await response.json(), replayed: response.headers.get('X-Extraction-Replayed') };
    },
  };
}

const unknowns = ['lost', 'malformed', 408, 409, 429, 500, 503, { code: 113 }, { code: 999 }, { code: 200, data: {} }, null,
  { code: null, data: { video_mp4: 'https://media.invalid/untrusted.mp4' } },
  { code: '', data: { video_mp4: 'https://media.invalid/untrusted.mp4' } },
  { code: false, data: { video_mp4: 'https://media.invalid/untrusted.mp4' } },
  { code: [], data: { video_mp4: 'https://media.invalid/untrusted.mp4' } }];
for (const fixture of unknowns) {
  const actual = load(fixture);
  const response = await actual.submit();
  assert.equal(response.status, 409, 'outer wrapper exposes a durable unresolved attempt');
  assert.equal(response.body.charged, false); assert.equal(response.body.retry_safe, false);
  assert.equal(actual.record().state, 'failed_unknown'); assert.equal(actual.record().response, null);
  assert.equal(actual.calls.ppt6, 1, 'unknown remains bound to the single durable item');
  assert.equal(actual.calls.otherProviders, 0); assert.equal(actual.calls.cache, 0); assert.equal(actual.calls.charges, 0); assert.equal(actual.calls.revenue, 0);
  const replay = await actual.submit();
  assert.equal(replay.status, 409); assert.equal(actual.calls.ppt6, 1);
  assert.equal(actual.calls.finalize, 1);
}
for (const fixture of [400, 403, { code: 103 }, { code: 104 }, { code: 108 }, { code: 110 }, { code: 115 }]) {
  const actual = load(fixture);
  const rejected = await actual.submit();
  assert.equal(rejected.status, 422);
  assert.equal(rejected.body.charged, false); assert.equal(rejected.body.retry_safe, true);
  assert.equal(actual.calls.otherProviders, 0, 'video never falls back to a text or local provider');
  assert.equal(actual.record().state, 'failed');
}
const success = load({ code: 200, data: { video_mp4: 'https://media.invalid/success.mp4' } });
const result = await success.submit();
assert.equal(result.status, 200); assert.equal(result.body.price, 0); assert.equal(result.body.charged, false);
assert.equal(result.body.source, 'ppt6'); assert.equal(result.body.videos[0].temporary_url, '/api/extract/local-video?fixture=1');
assert.equal(result.body.videos[0].url, undefined); assert.equal(result.body.videos[0].download_url, undefined);
assert.equal(success.calls.otherProviders, 0); assert.equal(success.calls.checkpoints, 1); assert.equal(success.record().state, 'succeeded');
assert.equal((await success.submit()).replayed, 'true'); assert.equal(success.calls.ppt6, 1);
const preflight = load('preflight'); const localFailure = await preflight.submit();
assert.equal(localFailure.status, 503); assert.equal(localFailure.body.provider_call_started, false); assert.equal(localFailure.body.charged, false);
assert.equal(preflight.record().state, 'failed'); assert.equal(preflight.calls.ppt6, 0); assert.equal(preflight.calls.otherProviders, 0);
assert.equal((await preflight.submit()).replayed, 'true'); assert.equal(preflight.calls.ppt6, 0);
const multiLink = load({ code: 200, data: { video_mp4: 'https://media.invalid/never-called.mp4' } });
const multiRejected = await multiLink.submit([link, link.replace(/9$/u, '0')]);
assert.equal(multiRejected.status, 400); assert.equal(multiRejected.body.error_code, 'EXTRACTION_VIDEO_SINGLE_LINK_REQUIRED');
assert.equal(multiRejected.body.provider_call_started, false); assert.equal(multiLink.calls.ppt6, 0);
const unsafeMessage = load({ code: 108, msg: 'fixture-secret-in-message https://private.invalid/?key=fixture-secret-in-message' });
const safeRejected = await unsafeMessage.submit();
assert.equal(safeRejected.status, 422); assert.equal(safeRejected.body.videos[0].error, '视频提取服务认证失败，请联系管理员'); assert.ok(!JSON.stringify(safeRejected).includes('fixture-secret-in-message'));
const unsafeCode = load({ code: 'fixture-secret-in-code', msg: 'fixture-secret-in-message' }); await unsafeCode.submit();
assert.ok(!unsafeCode.calls.logs.join('\n').includes('fixture-secret-in-code')); assert.ok(!unsafeCode.calls.logs.join('\n').includes('fixture-secret-in-message'));
const cacheRecovery = load('cache-fail-once');
const pendingCache = await cacheRecovery.submit();
assert.equal(pendingCache.status, 503); assert.equal(pendingCache.body.recovery_pending, true); assert.equal(cacheRecovery.record().state, 'running');
const recoveredCache = await cacheRecovery.submit();
assert.equal(recoveredCache.status, 200); assert.equal(recoveredCache.body.source, 'ppt6');
assert.equal(cacheRecovery.calls.ppt6, 1); assert.equal(cacheRecovery.calls.checkpoints, 1); assert.equal(cacheRecovery.calls.cache, 2);
for (const settlementFixture of ['billing-fail-once', 'revenue-fail-once']) {
  const settlementRecovery = load(settlementFixture);
  const pendingSettlement = await settlementRecovery.submit();
  assert.equal(pendingSettlement.status, 503); assert.equal(pendingSettlement.body.recovery_pending, true);
  assert.equal(settlementRecovery.record().state, 'running');
  const recoveredSettlement = await settlementRecovery.submit();
  assert.equal(recoveredSettlement.status, 200); assert.equal(settlementRecovery.record().state, 'succeeded');
  assert.equal(settlementRecovery.calls.ppt6, 1); assert.equal(settlementRecovery.calls.checkpoints, 1);
  assert.equal(new Set(settlementRecovery.calls.walletKeys).size, 1);
  const replayedSettlement = await settlementRecovery.submit();
  assert.equal(replayedSettlement.replayed, 'true'); assert.equal(settlementRecovery.calls.ppt6, 1);
}
const legacy = load('legacy-coze'); const recoveredLegacy = await legacy.submit();
assert.equal(recoveredLegacy.status, 200); assert.equal(recoveredLegacy.body.source, 'coze_workflow');
assert.equal(legacy.calls.ppt6, 0); assert.equal(legacy.calls.checkpoints, 0);
console.log(JSON.stringify({ passed: true, scenarios: 32, unknownScenarios: 16, ppt6CheckpointRecovery: true, singleRequestBoundary: true, settlementCheckpointRecovery: true, legacyCozeCheckpointRecovery: true, actualHandlerAndWrapper: true, realNetworkCalls: 0, realDatabaseWrites: 0 }));
