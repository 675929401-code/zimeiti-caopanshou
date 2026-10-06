import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BillingConfig } from "@/lib/billing";
import { resolveSelectedModelBillingConfig } from "@/lib/llm-billing";
import { buildMangaAgentModelCatalog } from "@/lib/manga-agent-model-policy";
import { containsForbiddenPublicModelKey, toPublicModelDto } from "@/lib/public-model-dto";
import {
  inspectTextModelPricing,
  publicTextModelBillingCapabilities,
} from "@/lib/text-model-pricing";

process.env.PUBLIC_MODEL_ID_SECRET ||= "text-price-readiness-zero-cost-fixture";

const globalBilling: BillingConfig = {
  inputCostPerMillion: 9001,
  outputCostPerMillion: 9002,
  cachedCostPerMillion: 9003,
  profitMargin: 90,
  creditsPerYuan: 50,
  tokenRoundingEnabled: false,
  tokenRoundingUnit: 0,
  tokenRoundingMin: 100,
  tokenRoundingMax: 10_000,
};

const readyModel: Record<string, unknown> = {
  id: "ready-text-model",
  name: "公开文案模型 · 渠道 A",
  model_name: "private-provider-model-name",
  description: "文本对话",
  category: "text",
  is_active: true,
  is_hidden: false,
  user_access: "available",
  sort_order: 1,
  token_billing_enabled: true,
  input_cost_per_million: 0,
  output_cost_per_million: 8,
  cached_cost_per_million: 0,
  profit_margin: 0,
  token_rounding_unit: 100,
  cost_per_use: 7777,
  api_key: "fixture-key-must-not-leak",
  api_endpoint: "https://provider-private.invalid/v1",
};

const readiness = inspectTextModelPricing(readyModel);
assert.equal(readiness.priceReady, true, "explicit zero costs and zero margin are valid model-owned prices");
assert.deepEqual(resolveSelectedModelBillingConfig(readyModel, globalBilling), {
  inputCostPerMillion: 0,
  outputCostPerMillion: 8,
  cachedCostPerMillion: 0,
  profitMargin: 0,
  creditsPerYuan: 50,
  tokenRoundingEnabled: true,
  tokenRoundingUnit: 100,
  tokenRoundingMin: 100,
  tokenRoundingMax: 10_000,
});

for (const field of [
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
] as const) {
  const missing = { ...readyModel };
  delete missing[field];
  assert.equal(inspectTextModelPricing(missing).priceReady, false, `${field} is mandatory`);
  assert.equal(resolveSelectedModelBillingConfig(missing, globalBilling), undefined, `${field} must not inherit a global value`);
}

for (const invalid of [
  { ...readyModel, token_billing_enabled: false },
  { ...readyModel, input_cost_per_million: -1 },
  { ...readyModel, output_cost_per_million: "NaN" },
  { ...readyModel, cached_cost_per_million: true },
  { ...readyModel, profit_margin: " " },
  { ...readyModel, profit_margin: 100 },
  { ...readyModel, token_rounding_unit: -1 },
]) {
  assert.equal(inspectTextModelPricing(invalid).priceReady, false);
  assert.equal(resolveSelectedModelBillingConfig(invalid, globalBilling), undefined);
}

assert.deepEqual(publicTextModelBillingCapabilities(readyModel), {
  billingUnit: "token",
  pricingMode: "token_usage",
  explicitlyFree: false,
  priceReady: true,
  available: true,
  availabilityMessage: "按实际 Token 用量结算",
});
const explicitlyFreeModel = {
  ...readyModel,
  input_cost_per_million: 0,
  output_cost_per_million: 0,
  cached_cost_per_million: 0,
};
assert.equal(publicTextModelBillingCapabilities(explicitlyFreeModel).explicitlyFree, true);
assert.equal(
  publicTextModelBillingCapabilities({ ...explicitlyFreeModel, token_billing_enabled: false }).explicitlyFree,
  false,
  "zero cost fields are not an explicit-free contract unless token billing and every required field are valid",
);
assert.equal(
  toPublicModelDto("chat", { id: "cost-only", cost_per_use: 7777 }, 0).publicPrice,
  0,
  "an internal cost must never be projected as a public price",
);
assert.equal(
  toPublicModelDto("chat", { id: "sale-price", price_per_use: 2.5, cost_per_use: 7777 }, 0).publicPrice,
  2.5,
  "an explicit public sale price remains supported",
);

const unavailableModel: Record<string, unknown> = { ...readyModel, id: "unpriced-text-model" };
delete unavailableModel.profit_margin;
const catalog = buildMangaAgentModelCatalog([readyModel, unavailableModel]);
assert.equal(catalog.models.length, 1);
assert.equal(catalog.unavailableModels.length, 1);
assert.equal(catalog.unavailableModels[0]?.capabilities.billingUnit, "token");
assert.equal(catalog.unavailableModels[0]?.capabilities.priceReady, false);
assert.equal(catalog.unavailableModels[0]?.capabilities.available, false);
assert.match(String(catalog.unavailableModels[0]?.capabilities.availabilityMessage || ""), /计费/u);
assert.equal(catalog.models[0]?.publicPrice, 0, "token catalogs must not reinterpret an internal per-use cost as a public price");
assert.equal(catalog.unavailableModels[0]?.publicPrice, 0, "an unavailable model must carry readiness state instead of presenting cost as a free/public rate");
assert.equal(catalog.models[0]?.capabilities.pricingMode, "token_usage");
assert.equal(catalog.models[0]?.capabilities.explicitlyFree, false, "publicPrice=0 alone must never mark a paid token model as free");
assert.equal(catalog.unavailableModels[0]?.capabilities.explicitlyFree, false);
assert.equal(containsForbiddenPublicModelKey(catalog), false);
const serializedCatalog = JSON.stringify(catalog);
for (const forbidden of [
  "fixture-key-must-not-leak",
  "https://provider-private.invalid/v1",
  "private-provider-model-name",
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
  "7777",
]) {
  assert.equal(serializedCatalog.includes(forbidden), false, `public catalog leaked ${forbidden}`);
}

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
for (const route of [
  "src/app/api/chat-models/route.ts",
  "src/app/api/llm-models/route.ts",
  "src/app/api/youcai/chat-models/route.ts",
]) {
  const routeSource = source(route);
  for (const field of [
    "token_billing_enabled",
    "input_cost_per_million",
    "output_cost_per_million",
    "cached_cost_per_million",
    "profit_margin",
  ]) assert.ok(routeSource.includes(field), `${route} must select ${field}`);
}

const auditSource = source("scripts/audit-navigation-models-readonly.ts");
assert.ok(auditSource.includes("运行目录与共享云配置差异"));
assert.equal(auditSource.includes("运行目录与当前源码配置差异"), false);
assert.ok(auditSource.includes("kind !== 'chat' && publicModel"), "token models must not compare a per-use DTO placeholder with legacy per-use prices");

const llmRoute = source("src/app/api/llm/route.ts");
const llmPriceGate = llmRoute.indexOf("const selectedModelBillingSnapshot = await getSelectedModelBillingSnapshot");
assert.ok(llmPriceGate > 0);
assert.ok(llmRoute.indexOf("searchClient.webSearch") > llmPriceGate, "web search must not start before price validation");
assert.ok(llmRoute.indexOf("await llmRequestAttemptStore.markProviderCallStarted") > llmPriceGate);
assert.ok(llmRoute.indexOf("handleStreamResponse(streamCtx, chatRequest, proxy)") > llmPriceGate);
assert.ok(llmRoute.indexOf("await handleNonStreamResponse(streamCtx, chatRequest, proxy)") > llmPriceGate);
assert.ok(llmRoute.includes('code: "MODEL_TOKEN_PRICING_NOT_READY"'));

const cozeRoute = source("src/app/api/chat/route.ts");
const cozePriceGate = cozeRoute.indexOf("const rawBillingSnapshot = await getSelectedModelBillingSnapshot");
assert.ok(cozePriceGate > 0);
assert.ok(cozeRoute.indexOf("const response = await streamChat(") > cozePriceGate);
assert.ok(cozeRoute.includes('code: "COZE_MODEL_TOKEN_PRICING_NOT_READY"'));

console.log(JSON.stringify({
  verifier: "text-model-price-readiness",
  cost: 0,
  networkCalls: 0,
  databaseWrites: 0,
  checks: {
    explicitModelPriceRequired: "passed",
    noGlobalPriceInheritance: "passed",
    publicCatalogReadinessAndRedaction: "passed",
    llmProviderPreflightGate: "passed",
    cozeProviderPreflightGate: "passed",
  },
}, null, 2));
