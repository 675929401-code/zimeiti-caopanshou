import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

class ValidationError extends Error { constructor(code, message) { super(message); this.code = code; } }
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, URL, AbortSignal,
    fetch() { throw Error('REAL_NETWORK_FORBIDDEN'); },
    require(name) {
      if (name.endsWith('/video-token-billing')) return load('src/lib/video-token-billing.ts');
      if (name === '@/lib/video-admin-validation') return { VideoAdminValidationError: ValidationError };
      if (name === '@/lib/video-model-capabilities') return { resolveVideoCharge: () => ({ publicPrice: 0.025, costPrice: 0.0111 }) };
      return {};
    },
  }, { filename: file });
  return module.exports;
}
const billing = load('src/lib/video-token-billing.ts');
const publication = load('src/lib/video-model-publication.ts');
const model = { id: 'fixture-token-model', api_protocol_config: {
  provider_billing_unit: 'token',
  token_sale_prices_per_million: { '720p:no_reference_video': 34.914, '720p:reference_video': 21.252 },
  token_cost_prices_per_million: { '720p:no_reference_video': 31.74, '720p:reference_video': 19.32 },
} };
const quote = billing.createVideoTokenQuote(model, { resolution: '720p', hasReferenceVideo: false,
  maxChargeYuan: 50, priceVersion: billing.getVideoTokenPublicPricing(model).priceVersion });
const usage = { schema: 'video_token_usage.v1', totalTokens: 100_000, completionTokens: 100_000,
  providerTaskId: 'provider-task', saleAmountYuan: 3.49, costAmountYuan: 3.174,
  recordedAt: '2026-10-18T12:00:00Z' };
const task = { id: 'internal-task', model_id: model.id, task_id_external: usage.providerTaskId,
  request_fingerprint: 'a'.repeat(64), resolution: '720p', duration_seconds: 6,
  billing_unit: 'token', billing_reserved_yuan: 50, billing_token_quote: quote,
  billing_token_usage: usage, billing_price_yuan: 3.49, billing_cost_price_yuan: 3.174 };
const metadata = { video_task_id: task.id, provider_task_id: task.task_id_external, phase: 'video_terminal',
  token_quote: quote, token_usage: usage, price_snapshot: { request_fingerprint: task.request_fingerprint,
    billing_unit: 'token', resolution: task.resolution, duration_seconds: task.duration_seconds,
    price_yuan: 3.49, cost_price_yuan: 3.174, token_quote: quote, token_usage: usage } };
const clone = value => JSON.parse(JSON.stringify(value));
const rejection = action => assert.throws(action, error => error.code === 'VIDEO_PUBLICATION_BILLING_INCOMPLETE');
assert.deepEqual(JSON.parse(JSON.stringify(publication.resolveVideoPublicationBilling(model, task))), { price: 3.49, cost: 3.174 });
assert.doesNotThrow(() => publication.assertVideoTokenPublicationReceipt(task, { metadata }));
assert.doesNotThrow(() => publication.resolveVideoPublicationBilling(clone(model), clone(task)), 'restart retains frozen evidence');
for (const mutate of [
  t => { t.billing_token_usage = null; },
  t => { t.billing_token_usage.completionTokens = 1; },
  t => { t.billing_token_usage.providerTaskId = 'other-provider-task'; },
  t => { t.billing_token_usage.saleAmountYuan = 0; },
  t => { t.model_id = 'other-model'; },
  t => { t.billing_reserved_yuan = 1; },
  t => { t.billing_token_quote.costYuanPerMillionTokens = 1; },
  t => { t.billing_token_quote.maxChargeYuan = 1; t.billing_reserved_yuan = 1; },
  t => { t.request_fingerprint = ''; },
]) { const altered = clone(task); mutate(altered); rejection(() => publication.resolveVideoPublicationBilling(model, altered)); }
const changedModel = clone(model); changedModel.api_protocol_config.token_sale_prices_per_million['720p:no_reference_video'] = 40;
rejection(() => publication.resolveVideoPublicationBilling(changedModel, task));
for (const mutate of [
  m => { m.provider_task_id = 'other-provider-task'; },
  m => { m.video_task_id = 'other-task'; },
  m => { m.price_snapshot.request_fingerprint = 'b'.repeat(64); },
  m => { m.token_usage.totalTokens = 1; },
  m => { m.price_snapshot.token_quote.saleYuanPerMillionTokens = 1; },
]) { const altered = clone(metadata); mutate(altered); rejection(() => publication.assertVideoTokenPublicationReceipt(task, { metadata: altered })); }
assert.deepEqual(JSON.parse(JSON.stringify(publication.resolveVideoPublicationBilling({ api_protocol_config: {} }, {}))), { price: 0.03, cost: 0.0111 });
console.log('Token publication verified: actual usage, frozen/current rates, consent, restart, provider/task/ledger binding; zero network and DB writes.');
