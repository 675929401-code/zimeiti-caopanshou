import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { resolve } from "node:path";
import ts from "typescript";
import { NextResponse } from "next/server";
import { calculateCredits, type BillingConfig } from "@/lib/billing";
import { publicTextModelBillingCapabilities, toSelectedModelBillingConfig } from "@/lib/text-model-pricing";
import * as publicBilling from "@/lib/public-billing-explanation";
import { findModelByPublicId, publicModelDisplayName, toPublicModelDto, toPublicModelId } from "@/lib/public-model-dto";
import { isPublishedTextModelEligible } from "@/lib/text-model-eligibility";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TransactionBillingExplanation } from "@/components/transaction-billing-explanation";

async function main() {
assert.equal(process.versions.node, "24.19.0", "Use the project-controlled runtime");
process.env.PUBLIC_MODEL_ID_SECRET ||= "public-billing-zero-network-fixture";
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
const checks: string[] = [];
const globalConfig: BillingConfig = {
  inputCostPerMillion: 9001, outputCostPerMillion: 9002, cachedCostPerMillion: 9003,
  profitMargin: 90, creditsPerYuan: 50, tokenRoundingEnabled: true, tokenRoundingUnit: 1000,
  tokenRoundingMin: 100, tokenRoundingMax: 10000,
};
const model: Record<string, unknown> = {
  id: "fixture-private-model", name: "文案模型 · 渠道 A", model_name: "fixture-private-provider",
  category: "text", is_active: true, is_hidden: false, user_access: "available",
  token_billing_enabled: true, input_cost_per_million: 10, output_cost_per_million: 20,
  cached_cost_per_million: 2, profit_margin: 50, token_rounding_unit: 0,
};
const config = toSelectedModelBillingConfig(model, globalConfig)!;
const rules = publicBilling.buildPublicBillingRules(globalConfig, model);
assert.equal(rules.price?.tokenRoundingUnit, 0);
assert.equal(rules.price?.inputCreditsPerMillion, 1000);
assert.equal(rules.price?.outputCreditsPerMillion, 2000);
assert.equal(rules.price?.cachedCreditsPerMillion, 200);
assert.match(rules.roundingDescription, /不取整/u);
const actual = calculateCredits(config, 1200, 300, 200);
assert.equal(actual.creditsCharged, 1.64, "Cached tokens are removed from ordinary input before charging");
assert.equal(actual.rounding, undefined);
assert.equal(publicBilling.toPublicTokenPrice(config)?.cachedCreditsPerMillion, 200);
checks.push("model-owned-prices-cache-and-explicit-zero-rounding-override-global");

const generic = publicBilling.buildPublicBillingRules(globalConfig);
assert.equal(generic.creditsPerYuan, 50);
assert.equal(generic.priceReady, null);
assert.equal("price" in generic, false);
assert.equal("inputCreditsPer1k" in generic, false);
assert.equal("profitMargin" in generic, false);
assert.match(generic.historyDescription, /不使用当前价格倒算/u);
checks.push("generic-rules-preserve-recharge-rate-without-fabricated-model-prices");

const rounded = { ...config, tokenRoundingEnabled: true, tokenRoundingUnit: 1000 };
assert.match(publicBilling.toPublicTokenPrice(rounded)!.roundingDescription, /60%/u);
assert.equal(calculateCredits(rounded, 1500, 0, 0).rounding?.roundedInputTokens, 1000);
assert.equal(calculateCredits(rounded, 1600, 0, 0).rounding?.roundedInputTokens, 2000);
assert.equal(calculateCredits(rounded, 1, 0, 0).rounding?.roundedInputTokens, 1000);
assert.equal(publicBilling.toPublicTokenPrice({ ...rounded, tokenRoundingUnit: 1 })?.tokenRoundingUnit, 100);
assert.equal(publicBilling.toPublicTokenPrice({ ...rounded, tokenRoundingUnit: 20000 })?.tokenRoundingUnit, 10000);
checks.push("rounding-description-matches-actual-sixty-percent-and-effective-unit");

const snapshot = { schemaVersion: "llm_public_model_price.v1", ...config,
  internalModelId: "fixture-private-model", modelName: "fixture-private-provider", baseFeeCredits: 3 };
const metadata = { price_snapshot: snapshot, wallet_operation_id: "101", prompt_tokens: 1200,
  completion_tokens: 0, cached_tokens: 200, agent_name: "测试智能体", actual_cost_rmb: 7, profit_rmb: 99,
  profit_margin: 50, api_key: "fixture-secret-marker", api_endpoint: "https://fixture-private.invalid",
  internalModelId: "fixture-private-model", model: "fixture-private-provider", unrelated: { token: "fixture-secret-marker" } };
const explanation = publicBilling.buildPublicTransactionBillingExplanation(metadata, "credits");
assert.equal(explanation.status, "snapshot");
assert.equal(explanation.walletLink.status, "linked");
assert.equal(explanation.price?.outputCreditsPerMillion, 2000);
assert.equal(explanation.baseFeeCredits, 3);
const publicMetadata = publicBilling.toPublicTransactionMetadata(metadata);
assert.deepEqual(publicMetadata, { agent_name: "测试智能体", prompt_tokens: 1200, completion_tokens: 0, cached_tokens: 200 });
for (const forbidden of ["fixture-private", "fixture-secret", "profit", "CostPerMillion", "api_key", "price_snapshot", "internalModelId", "wallet_operation_id"]) {
  assert.equal(JSON.stringify({ explanation, metadata: publicMetadata }).includes(forbidden), false, forbidden);
}
assert.equal(publicBilling.buildPublicTransactionBillingExplanation({}, "credits").status, "missing_snapshot");
assert.equal(publicBilling.buildPublicTransactionBillingExplanation({ price_snapshot: {} }, "credits").status, "invalid_snapshot");
assert.equal(publicBilling.buildPublicTransactionBillingExplanation({ price_snapshot: { ...snapshot, cachedCostPerMillion: null } }, "credits").status, "invalid_snapshot");
assert.equal(publicBilling.buildPublicTransactionBillingExplanation({ price_snapshot: { ...snapshot, schemaVersion: "unknown.v99" } }, "credits").status, "invalid_snapshot");
for (const wallet_operation_id of [null, undefined, 0, "0", "invalid", -1, "", {}]) {
  assert.equal(publicBilling.buildPublicTransactionBillingExplanation({ wallet_operation_id }, "credits").walletLink.status, "unlinked");
}
checks.push("historical-snapshot-only-missing-and-invalid-evidence-explicit-no-private-fields");

const markup = renderToStaticMarkup(createElement(TransactionBillingExplanation, { explanation, metadata: publicMetadata }));
assert.match(markup, /输入（含缓存）/u);
assert.match(markup, /输出 0 Token/u);
assert.match(markup, /缓存输入/u);
assert.match(markup, /不代表已完成账务对账/u);
assert.equal(markup.includes("fixture-private"), false);
assert.equal(markup.includes("成本"), false);
const missingMarkup = renderToStaticMarkup(createElement(TransactionBillingExplanation, {
  explanation: publicBilling.buildPublicTransactionBillingExplanation({}, "credits"),
}));
assert.match(missingMarkup, /无法还原当时单价/u);
assert.match(missingMarkup, /未记录钱包操作关联/u);
checks.push("actual-component-renders-zero-usage-cache-and-evidence-gaps");

const source = readFileSync(resolve("src/app/api/credits/rules/route.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const publicId = toPublicModelId("llm", String(model.id));
const hiddenModel = { ...model, id: "fixture-private-hidden", is_hidden: true };
const pendingModel = { ...model, id: "fixture-private-pending", user_access: "pending_model_activation" };
const incompleteModel = { ...model, id: "fixture-private-incomplete", cached_cost_per_million: null };
const models = [model, hiddenModel, pendingModel, incompleteModel];
let modelReads = 0;
let failModelRead = false;
const dependencies: Record<string, unknown> = {
  "next/server": { NextResponse },
  "@/lib/billing": { getBillingConfig: async () => globalConfig },
  "@/lib/public-billing-explanation": publicBilling,
  "@/lib/public-model-dto": { findModelByPublicId, publicModelDisplayName, toPublicModelDto },
  "@/lib/text-model-pricing": { publicTextModelBillingCapabilities },
  "@/lib/text-model-eligibility": { isPublishedTextModelEligible },
  "@/lib/server/admin-governance-authority": { authorizeAdminCapability() { throw new Error("ADMIN_READ_FORBIDDEN"); } },
  "@/storage/database/supabase-client": { getSupabaseClient: () => ({ from(table: string) {
    modelReads++;
    assert.equal(table, "llm_models");
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const query = {
      select(columns: string) {
        assert.equal(columns.includes("*"), false);
        assert.equal(columns.includes("public_name"), false, "Use only existing catalog columns");
        return query;
      },
      eq(column: string, value: unknown) { filters.push(row => row[column] === value); return query; },
      neq(column: string, value: unknown) { filters.push(row => row[column] !== value); return query; },
      order() { return query; },
      then(resolveResult: (value: unknown) => void) {
        resolveResult({ data: models.filter(row => filters.every(filter => filter(row))), error: failModelRead ? { message: "fixture-private-db-error" } : null });
      },
    };
    return query;
  } }) },
};
const vmModule = { exports: {} as { GET: (request: Request) => Promise<Response> } };
runInNewContext(compiled, { module: vmModule, exports: vmModule.exports, URL,
  require(name: string) { assert.ok(name in dependencies, `UNMOCKED_DEPENDENCY:${name}`); return dependencies[name]; },
  fetch: globalThis.fetch, console: { error() {} },
});
async function runRules(query = "") {
  const response = await vmModule.exports.GET(new Request(`http://fixture.invalid/api/credits/rules${query}`));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return { status: response.status, body: await response.json() };
}
const genericRoute = await runRules();
assert.equal(genericRoute.status, 200);
assert.equal(genericRoute.body.creditsPerYuan, 50);
assert.equal(modelReads, 0);
// Execute the shipped catalog routes with their actual shared DTO/ID generation.
// Hand their IDs straight to the actual rules route, as the product does.
for (const [catalogPath, namespace] of [["chat-models", "chat"], ["llm-models", "llm"]] as const) {
  const catalogSource = readFileSync(resolve(`src/app/api/${catalogPath}/route.ts`), "utf8");
  const catalogCompiled = ts.transpileModule(catalogSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const catalogModule = { exports: {} as { GET: (request: Request) => Promise<Response> } };
  runInNewContext(catalogCompiled, { module: catalogModule, exports: catalogModule.exports, URL, Request,
    require(name: string) { assert.ok(name in dependencies, `UNMOCKED_CATALOG_DEPENDENCY:${name}`); return dependencies[name]; },
    fetch: globalThis.fetch, console: { error() {} },
  });
  const response = await catalogModule.exports.GET(new Request(`http://fixture.invalid/api/${catalogPath}`));
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.unavailableModels.length, 1);
  const catalogId = catalog.models[0].id;
  assert.equal(catalogId, toPublicModelId(namespace, String(model.id)));
  const result = await runRules(`?modelId=${catalogId}`);
  assert.equal(result.status, 200, `${catalogPath} catalog ID must resolve in pricing rules`);
  assert.equal(result.body.modelId, catalogId);
  assert.deepEqual(result.body.price, currentPublicPrice());
  const unavailablePrice = await runRules(`?modelId=${catalog.unavailableModels[0].id}`);
  assert.equal(unavailablePrice.status, 200);
  assert.equal(unavailablePrice.body.priceReady, false);
  assert.equal("price" in unavailablePrice.body, false);
  for (const hidden of [hiddenModel, pendingModel]) {
    assert.equal((await runRules(`?modelId=${toPublicModelDto(namespace, hidden, 0).id}`)).status, 404);
  }
}
function currentPublicPrice() { return JSON.parse(JSON.stringify(rules.price)); }
checks.push("actual-chat-and-llm-catalog-routes-to-rules-share-public-id-generation-and-publication-gates");
const currentRoute = await runRules(`?modelId=${publicId}`);
assert.equal(currentRoute.status, 200);
assert.equal(currentRoute.body.price.tokenRoundingUnit, 0);
assert.equal(currentRoute.body.price.cachedCreditsPerMillion, 200);
assert.equal(JSON.stringify(currentRoute.body).includes("fixture-private"), false);
assert.equal(JSON.stringify(currentRoute.body).includes("profit"), false);
assert.equal((await runRules("?modelId=private-internal-id")).status, 400);
for (const row of [hiddenModel, pendingModel]) {
  assert.equal((await runRules(`?modelId=${toPublicModelId("llm", row.id)}`)).status, 404);
}
const incomplete = await runRules(`?modelId=${toPublicModelId("llm", incompleteModel.id)}`);
assert.equal(incomplete.status, 200);
assert.equal(incomplete.body.priceReady, false);
assert.equal("price" in incomplete.body, false);
failModelRead = true;
const unavailable = await runRules(`?modelId=${publicId}`);
assert.equal(unavailable.status, 503);
assert.equal(JSON.stringify(unavailable.body).includes("fixture-private-db-error"), false);
checks.push("actual-rules-route-public-id-visibility-incomplete-price-and-error-boundaries");

assert.equal(networkCalls, 0);
const fixtureOutput = process.argv.find(value => value.startsWith("--browser-fixture-out="))?.split("=").slice(1).join("=");
if (fixtureOutput) {
  const usageMetadata = { ...metadata, completion_tokens: 300 };
  const oldMetadata = { agent_name: "历史消费", prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 0 };
  const data = {
    transactions: [
      { id: "fixture-credit-snapshot", category: "credits", type: "consume", amount: -4.64, balanceAfter: 0,
        description: "文案生成消费", createdAt: "2026-10-25T12:00:00Z",
        metadata: publicBilling.toPublicTransactionMetadata(usageMetadata),
        billingExplanation: publicBilling.buildPublicTransactionBillingExplanation(usageMetadata, "credits") },
      { id: "fixture-credit-legacy", category: "credits", type: "consume", amount: -2, balanceAfter: 4.64,
        description: "历史文案消费", createdAt: "2026-10-24T12:00:00Z", metadata: oldMetadata,
        billingExplanation: publicBilling.buildPublicTransactionBillingExplanation(oldMetadata, "credits") },
    ],
    summary: { totalCreditsRecharged: 6.64, totalCreditsConsumed: 6.64, creditBalance: 0,
      totalCashRecharged: 0, totalCashConsumed: 0, cashBalance: 0 },
    pagination: { page: 1, pageSize: 20, total: 2, creditTotal: 2, cashTotal: 0, videoTotal: 0, paymentTotal: 0 },
  };
  writeFileSync(resolve(fixtureOutput), JSON.stringify({
    kind: "profile-billing-readonly-browser-fixture", path: "/profile?tab=records",
    action: "默认充值；点击消费记录后，拦截transactionType=consume为consumeResponse。钱包与生成等写请求全部阻断。",
    consumeResponse: { success: true, data },
    rechargeResponse: { success: true, data: { ...data, transactions: [], pagination: { ...data.pagination, total: 0, creditTotal: 0 } } },
  }, null, 2));
}
console.log(JSON.stringify({ kind: "public-billing-explanation-zero-network", status: "PASS", checks: checks.length,
  scenarios: checks, networkCalls, dbConnections: 0, browserRuns: 0, paidPosts: 0 }));
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
