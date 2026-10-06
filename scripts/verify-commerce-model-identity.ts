import assert from 'node:assert/strict';
import { ModelChangedBeforeDispatch, modelIdentity } from '../src/commerce/server/model-identity';
import type { Model } from '../src/commerce/server/models';

const base: Model = {
  id: 'identity-fixture',
  displayName: 'Identity Fixture',
  kind: 'video',
  source: 'custom',
  protocol: 'secure-video',
  endpoint: 'https://example.invalid/v1',
  modelName: 'video-fixture-v1',
  publicPrice: 1.1,
  costPrice: 1,
  billingUnit: 'per_use',
  configHash: 'fixture-config-v1',
  capabilities: { durationOptions: [4, 8], resolutionOptions: ['720p'], nested: { b: 2, a: 1 } },
  enabled: true,
  secret: 'secret-one',
};

const reordered: Model = {
  ...base,
  capabilities: { nested: { a: 1, b: 2 }, resolutionOptions: ['720p'], durationOptions: [4, 8] },
  secret: 'secret-two',
};

const original = modelIdentity(base);
assert.equal(modelIdentity(reordered), original);

for (const changed of [
  { ...base, publicPrice: 1.2 },
  { ...base, costPrice: 0.9 },
  { ...base, billingUnit: 'output_second' as const },
  { ...base, protocol: 'volc-video' },
  { ...base, endpoint: 'https://example.invalid/v2' },
  { ...base, modelName: 'video-fixture-v2' },
  { ...base, configHash: 'fixture-config-v2' },
  { ...base, capabilities: { ...base.capabilities, durationOptions: [4, 8, 12] } },
]) assert.notEqual(modelIdentity(changed), original);

assert.match(new ModelChangedBeforeDispatch().message, /模型配置或费用已经变更/);
console.log(JSON.stringify({
  passed: 10,
  networkCalls: 0,
  paidCalls: 0,
  checks: ['canonical-order', 'secret-excluded', 'price', 'cost', 'billing-unit', 'protocol', 'endpoint', 'model-name', 'config-hash', 'capabilities'],
}));
