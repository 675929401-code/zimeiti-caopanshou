import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compile = (source) => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(file, imports = {}) {
  const compiledModule = { exports: {} };
  runInNewContext(compile(readFileSync(file, 'utf8')), { module: compiledModule, exports: compiledModule.exports, process: { env: {} }, Buffer, URL, setTimeout,
    require: name => { assert.ok(imports[name], `Unexpected import ${name}`); return imports[name]; } });
  return compiledModule.exports;
}
const core = load('src/lib/segmenter-core.ts');
const endpoints = load('src/lib/api-endpoints.ts');
class FixtureSafeError extends Error {
  constructor(code, requestDispatched, upstreamStatus) { super(code); Object.assign(this, { code, requestDispatched, upstreamStatus }); }
}
const defaultText = '清晨我打开窗户深深呼吸新鲜空气然后给阳台上的花草浇水整理好桌上的书本准备认真开始今天的工作。傍晚我沿着河边慢慢散步看看落日与晚霞听听风吹过树叶的声音让疲惫的心情在这段安静的时间里放松。';

async function run({ endpoint = 'https://fixture.invalid/v1/chat/completions', error, student = false, invalidKey = false, truncated = false, text = defaultText, duration = 8 } = {}) {
  const calls = [], wallet = [];
  const imports = {
    '@/lib/billing': { calculateCredits: () => ({ creditsCharged: 1, actualCostRmb: 0.01, sellPriceRmb: 0.02 }), applyAtomicWalletOperation: async input => { wallet.push(input); return { success: true, operationId: input.idempotencyKey, balanceAfter: 10 }; } },
    '@/lib/llm-billing': { getSelectedModelBillingSnapshot: async () => ({ config: {}, priceSnapshot: {} }) },
    '@/lib/public-model-dto': { toPublicModelId: () => 'public-fixture' },
    '@/lib/revenue': { recordRevenue: async () => {} },
    '@/lib/api-endpoints': endpoints,
    '@/lib/provider-secret': { resolveProviderSecret: value => { assert.equal(value, 'fixture-reference'); if (invalidKey) throw new Error('invalid reference'); return 'resolved-fixture-key'; } },
    '@/lib/segmenter-core': core,
    '@/storage/database/supabase-client': { getSupabaseAdminClient: () => ({ from: table => {
      const query = { select: () => query, in: () => query, eq: () => query, order: () => query,
        then: resolve => resolve({ data: table === 'platform_settings' ? [] : [{ id: 'fixture-model', model_name: 'deepseek-v4-flash', api_endpoint: endpoint, api_key: 'fixture-reference' }], error: null }) };
      return query;
    } }) },
    '@/lib/safe-fetch': { SafeFetchError: FixtureSafeError, safeFetchJsonPost: async (url, body, options) => {
      calls.push({ url, body, options });
      assert.equal(url, endpoints.buildOpenAIEndpoint(endpoint, 'chat/completions'));
      assert.equal(options.authorization.origin, new URL(endpoint).origin);
      assert.equal(options.authorization.value, 'Bearer resolved-fixture-key');
      assert.equal(options.maxBytes, 2 * 1024 * 1024);
      assert.equal(JSON.parse(body).stream, false);
      assert.equal(JSON.parse(body).thinking?.type, new URL(endpoint).hostname === 'api.deepseek.com' ? 'disabled' : undefined);
      if (error) throw error;
      return { json: { id: 'fixture-response', choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: truncated ? '' : JSON.stringify({ groups: [[0], [1]] }) } }], usage: { prompt_tokens: 90, completion_tokens: 12 } } };
    } },
  };
  const actual = load('src/lib/semantic-segmentation-service.ts', imports);
  const result = await actual.runBillableSemanticSegmentation({ text, duration, userId: 'owner', userRole: student ? 'student' : 'admin', clientRequestId: 'fixture-request' });
  return { result, calls, wallet };
}
let count = 0;
for (const endpoint of ['https://fixture.invalid', 'https://fixture.invalid/v1', 'https://fixture.invalid/v1/chat/completions', 'https://api.deepseek.com/v1/chat/completions']) {
  const r = await run({ endpoint });
  assert.equal(r.calls.length, 1);
  assert.equal(r.result.body.upstream_completed, true);
  assert.equal(r.result.body.semantic_status, 'succeeded');
  assert.equal(r.wallet.length, 1);
  assert.equal(r.wallet[0].operationKind, 'credit_charge');
  count++;
}
for (const student of [false, true]) {
  for (const [code, dispatched, upstreamStatus] of [['IP_FORBIDDEN', false], ['FETCH_FAILED', true], ['UPSTREAM_STATUS', true, 401]]) {
    const r = await run({ student, error: new FixtureSafeError(code, dispatched, upstreamStatus) });
    assert.equal(r.calls.length, 1, 'never retry with a second provider');
    assert.equal(r.result.body.provider_call_started, dispatched);
    assert.equal(r.result.body.provider_error_code, code);
    assert.equal(r.result.body.provider_http_status, upstreamStatus);
    assert.equal(r.result.body.charged, false);
    assert.equal(r.result.body.success, false);
    assert.equal(r.result.body.fallback_delivered, true);
    assert.equal(r.result.body.retry_safe, true);
    assert.equal(r.wallet.length, 2);
    assert.equal(r.wallet[0].operationKind, 'credit_charge');
    assert.equal(r.wallet[1].operationKind, 'credit_refund');
    count++;
  }
}
const missing = await run({ invalidKey: true });
assert.equal(missing.calls.length, 0);
assert.equal(missing.wallet.length, 0);
assert.equal(missing.result.body.provider_call_started, false);
assert.equal(missing.result.body.error_code, 'SEMANTIC_MODEL_NOT_READY');
const incomplete = await run({ truncated: true });
assert.equal(incomplete.result.body.semantic_validation.finish_reason, 'length');
assert.equal(incomplete.result.body.semantic_validation.has_final_content, false);
assert.equal(incomplete.result.body.semantic_status, 'invalid_result_refunded');
assert.equal(incomplete.result.body.result.note.includes('完整的分组 JSON'), true);
assert.equal(incomplete.result.body.success, false);
assert.equal(incomplete.result.body.fallback_delivered, true);
assert.equal(incomplete.result.body.retry_safe, true);

const oneSegmentWithManyUnits = '验收4b0d0a0a：开头看似只是一次普通尝试，但真正的问题很快出现。随后我们改变方法，保留原文顺序，并在结尾核对每一段是否完整。';
assert.ok(core.buildSegmentUnits(oneSegmentWithManyUnits).length > 1);
assert.equal(core.segmentTextRule(oneSegmentWithManyUnits, 10).segments.length, 1);
const noCallNeeded = await run({ student: true, text: oneSegmentWithManyUnits, duration: 10 });
assert.equal(noCallNeeded.calls.length, 0);
assert.equal(noCallNeeded.wallet.length, 0);
assert.equal(noCallNeeded.result.body.semantic_status, 'not_required');
assert.equal(noCallNeeded.result.body.success, true);
assert.equal(noCallNeeded.result.body.provider_call_started, false);
assert.equal(noCallNeeded.result.body.result.method, 'rule');

assert.ok(core.segmentTextRule(defaultText, 8).segments.length > 1);
const realMultiSegment = await run();
assert.equal(realMultiSegment.calls.length, 1);
assert.equal(realMultiSegment.result.body.semantic_status, 'succeeded');
assert.equal(realMultiSegment.result.body.success, true);

console.log(JSON.stringify({ passed: true, cases: count + 4, providerCalls: 0, realWalletWrites: 0 }));
