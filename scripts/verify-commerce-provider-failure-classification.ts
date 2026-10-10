import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  classifyProviderFailure,
  confirmedFailureProviderCost,
  isExplicitProviderRejection,
} from '../src/commerce/server/provider-failure-classification';

const balanceDetail = 'UPSTREAM_BALANCE_EXHAUSTED: 上游账户余额不足 (429): {"error":{"code":"1113","message":"余额不足或无可用资源包"}}';
const legacyWrappedBalance = `PROVIDER_RESULT_UNCONFIRMED: ${balanceDetail}`;

assert.deepEqual(classifyProviderFailure(new Error(balanceDetail)), {
  status: 'failed',
  error: 'UPSTREAM_BALANCE_EXHAUSTED',
});
assert.deepEqual(classifyProviderFailure(new Error(legacyWrappedBalance)), {
  status: 'failed',
  error: 'UPSTREAM_BALANCE_EXHAUSTED',
});
assert.equal(isExplicitProviderRejection(legacyWrappedBalance), true);
assert.equal(confirmedFailureProviderCost(legacyWrappedBalance, 0.002), 0);

assert.deepEqual(classifyProviderFailure(new Error('IMAGE_PROVIDER_HTTP_429: private upstream body')), {
  status: 'failed',
  error: 'IMAGE_PROVIDER_HTTP_429',
});
assert.deepEqual(classifyProviderFailure(new Error('模型桥接返回 HTTP 413')), {
  status: 'failed',
  error: 'MODEL_GATEWAY_HTTP_413',
});
assert.deepEqual(classifyProviderFailure(new Error('TEXT_STREAM_INCOMPLETE')), {
  status: 'failed',
  error: 'TEXT_STREAM_INCOMPLETE',
});

assert.deepEqual(classifyProviderFailure(new Error('IMAGE_PROVIDER_HTTP_500')), {
  status: 'unknown',
  error: 'IMAGE_PROVIDER_HTTP_500',
});
assert.deepEqual(classifyProviderFailure(new Error('provider timeout after dispatch: token=secret-value')), {
  status: 'unknown',
  error: 'PROVIDER_RESULT_UNCONFIRMED',
});
assert.deepEqual(classifyProviderFailure(new Error('MODEL_CONFIGURATION_CHANGED')), {
  status: 'unknown',
  error: 'MODEL_CONFIGURATION_CHANGED',
});

const sanitized = classifyProviderFailure(new Error(balanceDetail)).error;
assert.doesNotMatch(sanitized, /1113|余额|error|message|\{/u);

const gatewayRoute = fs.readFileSync(path.resolve('src/app/api/commerce-model-gateway/route.ts'), 'utf8');
assert.match(gatewayRoute, /const failure=classifyProviderFailure\(error\)/u);
assert.match(
  gatewayRoute,
  /const candidate:Receipt=requestMayHaveReachedProvider&&!explicitProviderResponse[\s\S]*?status:'manual_reconciliation'[\s\S]*?error:failure\.error[\s\S]*?:\{\.\.\.receipt,status:'failed'[\s\S]*?error:failure\.error/u,
  "ambiguous post-dispatch failures must reconcile while definitive failures remain terminal",
);
assert.match(gatewayRoute, /commitReceiptObservation\(receipt\.id,receipt\.revision,candidate\)/u);
assert.doesNotMatch(gatewayRoute, /rawDetail|finalError|\[1-5\]dd/u);

// Dry-run only for the persisted legacy task. This test never opens its SQLite
// database, calls refreshJob, writes a receipt, or reaches a provider.
const legacyTaskDryRun = classifyProviderFailure(new Error(legacyWrappedBalance));
assert.deepEqual(legacyTaskDryRun, { status: 'failed', error: 'UPSTREAM_BALANCE_EXHAUSTED' });

console.log(JSON.stringify({
  passed: 15,
  networkCalls: 0,
  paidCalls: 0,
  databaseReads: 0,
  databaseWrites: 0,
  legacyTask: {
    id: '1c6b4dac-c5a8-4508-b0eb-bee020a68dbb',
    mode: 'dry-run-classification-only',
    wouldBecome: legacyTaskDryRun.status,
  },
  checks: [
    'balance-terminal',
    'legacy-wrapped-balance-terminal',
    'legacy-explicit-classifier',
    'legacy-zero-provider-cost',
    'image-429-terminal-and-sanitized',
    'gateway-413-terminal-and-sanitized',
    'text-incomplete-terminal',
    'image-500-unknown',
    'timeout-unknown-and-sanitized',
    'safe-unknown-code-preserved',
    'balance-detail-redacted',
    'gateway-route-uses-shared-classifier',
    'gateway-route-persists-disposition',
    'legacy-broken-regex-removed',
    'legacy-task-dry-run-only',
  ],
}));
