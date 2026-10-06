#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";

const markupPercent = 20;
const backendProfitMarginPercent = (markupPercent / (100 + markupPercent)) * 100;
const workbookRows = [
  { model: "gpt-6.1-sol", base: [4, 15, 5], multiplier: 2.5, costs: [10, 37.5, 12.5], sales: [12, 45, 15] },
  { model: "claude-opus-5-5", base: [4, 20, 8], multiplier: 1.8, costs: [7.2, 36, 14.4], sales: [8.64, 43.2, 17.28] },
  { model: "claude-sonnet-5-5", base: [8, 0, 0], multiplier: 4, costs: [32, 0, 0], sales: [38.4, 0, 0] },
];

function nearlyEqual(left, right, tolerance = 1e-9) {
  return Math.abs(Number(left) - Number(right)) <= tolerance;
}

for (const row of workbookRows) {
  row.costs.forEach((cost, index) => {
    assert.ok(nearlyEqual(row.base[index] * row.multiplier, cost), `${row.model}:COST_MULTIPLIER_MISMATCH:${index}`);
    assert.ok(nearlyEqual(cost * 1.2, row.sales[index]), `${row.model}:COST_MARKUP_MISMATCH:${index}`);
    assert.ok(
      nearlyEqual(cost / (1 - backendProfitMarginPercent / 100), row.sales[index]),
      `${row.model}:BACKEND_PROFIT_MARGIN_MAPPING_MISMATCH:${index}`,
    );
  });
}

assert.ok(nearlyEqual(backendProfitMarginPercent, 100 / 6), "BACKEND_PROFIT_MARGIN_MUST_EQUAL_ONE_SIXTH");

const onboarding = await fs.readFile("scripts/onboard-lconai-workbook-models-local.mjs", "utf8");
const pricingRepair = await fs.readFile("scripts/apply-lconai-text-pricing-markup-fix-local.mjs", "utf8");
const claudeProtocol = await fs.readFile("scripts/apply-lconai-claude-protocol-fix-local.mjs", "utf8");
const gptProtocol = await fs.readFile("scripts/apply-lconai-gpt61-protocol-fix-local.mjs", "utf8");
const claudeCanary = await fs.readFile("scripts/verify-lconai-claude-model-live.mjs", "utf8");

assert.match(onboarding, /WORKBOOK_COST_MARKUP_PERCENT\s*=\s*20/u);
assert.match(onboarding, /BACKEND_PROFIT_MARGIN_PERCENT\s*=\s*\(WORKBOOK_COST_MARKUP_PERCENT\s*\/\s*\(100\s*\+\s*WORKBOOK_COST_MARKUP_PERCENT\)\)\s*\*\s*100/u);
assert.doesNotMatch(onboarding, /margin:\s*20\b/u);
assert.match(onboarding, /modelName:\s*"claude-sonnet-5-5"/u);
assert.match(onboarding, /const blockedModels = \[\];/u);
assert.match(pricingRepair, /基础单价 4\/15\/5 × 渠道倍率 2\.5 = 真实成本 10\/37\.5\/12\.5/u);
assert.match(pricingRepair, /基础单价 4\/20\/8 × 渠道倍率 1\.8 = 真实成本 7\.2\/36\/14\.4/u);
assert.match(pricingRepair, /基础单价 8\/0\/0 × 渠道倍率 4 = 真实成本 32\/0\/0/u);
assert.match(claudeProtocol, /用户售价按真实成本加价 20%/u);
assert.match(gptProtocol, /用户售价按真实成本加价 20%/u);
assert.match(claudeCanary, /replace\(\/\\\/\+\$\/u, ""\)/u);

console.log(JSON.stringify({
  passed: true,
  providerCalls: 0,
  workbookRows,
  markupPercent,
  backendProfitMarginPercent,
}, null, 2));
