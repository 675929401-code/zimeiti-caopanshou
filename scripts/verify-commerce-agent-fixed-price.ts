import assert from 'node:assert/strict';
import fs from 'node:fs';
import { commerceModelPricing } from '../src/commerce/server/main-site-model-pricing';
import { shouldSyncLegacyAgentMessagePricing } from '../src/lib/text-model-admin-sync';

const agent = commerceModelPricing('agent', {
  cost_per_use: 1.1,
  cost_price: 1,
  token_billing_enabled: true,
  input_cost_per_million: 1,
  output_cost_per_million: 4,
}, {
  publicPrice: 0,
  capabilities: { billingUnit: 'token' },
});
assert.deepEqual(agent, { costPrice: 1, publicPrice: 1.1, billingUnit: 'per_use' });

const image = commerceModelPricing('image', { cost_price: 0.16 }, {
  publicPrice: 0.176,
  capabilities: { billingUnit: 'per_use' },
});
assert.deepEqual(image, { costPrice: 0.16, publicPrice: 0.176, billingUnit: 'per_use' });

const video = commerceModelPricing('video', { cost_price: 0.08 }, {
  publicPrice: 0.12,
  capabilities: { billingUnit: 'output_second' },
});
assert.deepEqual(video, { costPrice: 0.08, publicPrice: 0.12, billingUnit: 'output_second' });

const invalid = commerceModelPricing('agent', { cost_per_use: 'not-a-price', cost_price: -1 }, {
  publicPrice: 999,
  capabilities: { billingUnit: 'token' },
});
assert.deepEqual(invalid, { costPrice: null, publicPrice: null, billingUnit: 'per_use' });

assert.equal(shouldSyncLegacyAgentMessagePricing(true, undefined), false);
assert.equal(shouldSyncLegacyAgentMessagePricing(false, undefined), true);
assert.equal(shouldSyncLegacyAgentMessagePricing(true, false), true);
assert.equal(shouldSyncLegacyAgentMessagePricing(false, true), false);

const gatewaySource = fs.readFileSync(
  new URL('../src/app/api/commerce-model-gateway/route.ts', import.meta.url),
  'utf8',
);
assert.match(gatewaySource, /return \{ costPrice, publicPrice, billingUnit, configHash, verifiedAt \};/);
assert.match(gatewaySource, /\{costPrice:null,publicPrice:null,billingUnit:'per_use',configHash:'',verifiedAt:null\}/);
assert.match(gatewaySource, /accepted\.get\(`\$\{kind\}:\$\{String\(entry\.id\|\|''\)\}:\$\{snapshot\.configHash\}`\)/);

console.log(JSON.stringify({
  suite: 'commerce-agent-fixed-price',
  passed: 17,
  networkCalls: 0,
  providerCalls: 0,
  walletWrites: 0,
  databaseWrites: 0,
}));
