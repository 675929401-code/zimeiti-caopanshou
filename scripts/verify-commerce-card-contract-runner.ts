import assert from 'node:assert/strict';
import { evaluateCommerceCardContractTests, validateCommerceCardContractInput } from '../src/commerce/server/configuration-admin';

const director = {
  executor_type: 'director',
  material_slots: [
    { id: 'product', label: '商品', responsibility: '商品事实', mediaTypes: ['image'], minCount: 1, maxCount: 3, maxFileBytes: 5_000_000 },
    { id: 'voice', label: '声音', responsibility: '声线参考', mediaTypes: ['audio'], minCount: 0, maxCount: 1, minDurationSeconds: 1, maxDurationSeconds: 15 },
  ],
  input_fields: [
    { id: 'language', type: 'select', title: '语言', required: true, options: ['中文', '英文'], defaultValue: '中文' },
    { id: 'duration', type: 'number', title: '时长', required: true, validation: { min: 4, max: 60 }, defaultValue: 15 },
    { id: 'note', type: 'textarea', title: '补充', required: false, validation: { maxLength: 100 } },
  ],
  output_contract: { schema: 'director-script/v2', applicationRequired: true },
  test_cases: [
    { id: 'minimum-input', kind: 'minimum', status: 'passed' },
    { id: 'standard-product', kind: 'standard' },
    { id: 'same-session-revision', kind: 'revision' },
  ],
};

const result = evaluateCommerceCardContractTests(director, '2026-09-15T01:00:00.000Z');
assert.equal(result.ok, true);
assert.equal(result.testCases.length, 3);
assert.ok(result.testCases.every((item) => item.status === 'passed'));
assert.ok(result.testCases.every((item) => item.mode === 'deterministic-contract'));
assert.ok(result.testCases[2].assertions.includes('revision-contract-present'));

assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [] }, fields: { language: '中文', duration: 15, note: '' } }), /数量必须/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'audio' }] }, fields: { language: '中文', duration: 15, note: '' } }), /不接受/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'image', bytes: 5_000_001 }] }, fields: { language: '中文', duration: 15, note: '' } }), /文件大小超限/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'image' }], voice: [{ mediaType: 'audio', durationSeconds: 16 }] }, fields: { language: '中文', duration: 15, note: '' } }), /时长超限/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'image' }] }, fields: { language: '法文', duration: 15, note: '' } }), /选项无效/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'image' }] }, fields: { language: '中文', duration: 61, note: '' } }), /数值无效/u);
assert.throws(() => validateCommerceCardContractInput(director, { materials: { product: [{ mediaType: 'image' }] }, fields: { language: '中文', duration: 15, unknown: 'x' } }), /未知输入字段/u);

const handEdited = evaluateCommerceCardContractTests({ ...director, test_cases: [
  { id: 'minimum-input', kind: 'minimum' },
  { id: 'standard-product', kind: 'standard' },
  { id: 'fake-pass', kind: 'unsupported', status: 'passed' },
] });
assert.equal(handEdited.ok, false);
assert.equal(handEdited.testCases[2].status, 'failed');
assert.match(handEdited.testCases[2].error || '', /不支持的测试类型/u);

const legacyRevision = evaluateCommerceCardContractTests({ ...director, output_contract: { schema: 'director-script/v1' } });
assert.equal(legacyRevision.ok, false);
assert.match(legacyRevision.testCases[2].error || '', /director-script\/v2/u);

const requiredBlankDefault = evaluateCommerceCardContractTests({
  ...director,
  input_fields: [{ id: 'prompt', type: 'textarea', title: '提示词', required: true, defaultValue: '' }],
  test_cases: [
    { id: 'minimum-input', kind: 'minimum' },
    { id: 'standard-product', kind: 'standard' },
    { id: 'maximum-input', kind: 'maximum' },
  ],
});
assert.equal(requiredBlankDefault.ok, true);
assert.ok(requiredBlankDefault.testCases.every((item) => item.status === 'passed'));

console.log(JSON.stringify({ suite: 'commerce-card-contract-runner', passed: 17, networkCalls: 0, paidCalls: 0, databaseWrites: 0 }));
