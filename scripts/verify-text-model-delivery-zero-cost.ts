import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildMangaAgentModelCatalog } from "@/lib/manga-agent-model-policy";
import { resolveSelectedModelBillingConfig } from "@/lib/llm-billing";
import { findModelByPublicId } from "@/lib/public-model-dto";
import { SseEventStreamDecoder } from "@/lib/sse-stream-decoder";
import type { BillingConfig } from "@/lib/billing";

const ROOT = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(ROOT, relativePath), "utf8");

process.env.PUBLIC_MODEL_ID_SECRET ||= "zero-cost-text-model-contract-fixture";

const modelRows = [
  {
    id: "fixture-text-channel-a",
    name: "通用文案 · 渠道 A",
    model_name: "fixture-chat-a",
    description: "文本对话与文案",
    category: "text",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 10,
    token_billing_enabled: true,
    input_cost_per_million: 2,
    output_cost_per_million: 8,
    cached_cost_per_million: 1,
    profit_margin: 40,
    token_rounding_unit: 100,
  },
  {
    id: "fixture-video-channel-a",
    name: "视频生成 · 渠道 A",
    model_name: "fixture-video-a",
    description: "视频生成",
    category: "video",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 1,
  },
];

const catalog = buildMangaAgentModelCatalog(modelRows);
assert.equal(catalog.models.length, 1, "text catalog must exclude media-only models");
assert.equal(catalog.unavailableModels.length, 0);
const selectedPublicModel = catalog.models[0];
assert.equal(selectedPublicModel.capabilities.billingUnit, "token");
assert.equal(selectedPublicModel.capabilities.pricingMode, "token_usage");
assert.equal(selectedPublicModel.capabilities.explicitlyFree, false);
assert.equal(selectedPublicModel.capabilities.priceReady, true);
assert.equal(selectedPublicModel.capabilities.available, true);
assert.match(selectedPublicModel.id, /^pm_[A-Za-z0-9_-]{24}$/u);
assert.equal(
  findModelByPublicId("chat", modelRows, selectedPublicModel.id)?.id,
  modelRows[0].id,
  "the public model selected by the browser must resolve to the same server row",
);

const globalBilling: BillingConfig = {
  inputCostPerMillion: 5,
  outputCostPerMillion: 15,
  cachedCostPerMillion: 2,
  profitMargin: 50,
  creditsPerYuan: 50,
  tokenRoundingEnabled: false,
  tokenRoundingUnit: 0,
  tokenRoundingMin: 100,
  tokenRoundingMax: 10_000,
};
const selectedBilling = resolveSelectedModelBillingConfig(modelRows[0], globalBilling);
assert.deepEqual(selectedBilling, {
  inputCostPerMillion: 2,
  outputCostPerMillion: 8,
  cachedCostPerMillion: 1,
  profitMargin: 40,
  creditsPerYuan: 50,
  tokenRoundingEnabled: true,
  tokenRoundingUnit: 100,
  tokenRoundingMin: 100,
  tokenRoundingMax: 10_000,
});
assert.equal(
  resolveSelectedModelBillingConfig({ ...modelRows[0], profit_margin: undefined }, globalBilling),
  undefined,
  "missing model profit must never inherit the global margin",
);

const fragmentedSse = new TextEncoder().encode(
  'data: {"choices":[{"delta":{"content":"首"}}]}\n\n'
  + 'data: {"choices":[{"delta":{"content":"字"}}]}\n\n'
  + 'data: [DONE]\n\n',
);
const decoder = new SseEventStreamDecoder();
const decoded = [
  ...decoder.push(fragmentedSse.slice(0, 17)),
  ...decoder.push(fragmentedSse.slice(17, 51)),
  ...decoder.push(fragmentedSse.slice(51)),
  ...decoder.finish(),
];
assert.equal(decoded.length, 3);
assert.equal(JSON.parse(decoded[0].data).choices[0].delta.content, "首");
assert.equal(JSON.parse(decoded[1].data).choices[0].delta.content, "字");
assert.equal(decoded[2].data, "[DONE]");

const officialAgent = source("src/features/official-core-routes/official-agent-route.tsx");
const appContext = source("src/contexts/app-context.tsx");
const modelCatalogRoute = source("src/app/api/youcai/chat-models/route.ts");
const llmRoute = source("src/app/api/llm/route.ts");
const streamHandler = source("src/app/api/llm/handle-stream.ts");

for (const marker of [
  'fetch("/api/youcai/chat-models"',
  "payload.policy?.defaultModelId",
  "options.some((model) => model.id === current)",
  "options.some((model) => model.id === stored)",
  "options.some((model) => model.id === policyDefault)",
  "models.find((model) => model.id === selectedModelId)",
  "selectedModelId,",
]) {
  assert.ok(officialAgent.includes(marker), `missing browser model-selection contract: ${marker}`);
}
assert.ok(modelCatalogRoute.includes("buildMangaAgentModelCatalog"));
assert.ok(modelCatalogRoute.includes('Cache-Control": "private, no-store"'));
for (const forbidden of ["api_key", "api_endpoint", "proxy_url"]) {
  assert.equal(modelCatalogRoute.includes(forbidden), false, `public model catalog leaked ${forbidden}`);
}

for (const marker of [
  "const clientRequestId = `llm_${crypto.randomUUID()}`",
  '"Idempotency-Key": clientRequestId',
  "client_request_id: clientRequestId",
  "modelId: modelOverride || undefined",
  "model_overridden: !!modelOverride",
  "stream: true",
  "new SseEventStreamDecoder()",
  "throttledDispatchUpdate",
  "await settleTypewriterUpdate",
]) {
  assert.ok(appContext.includes(marker), `missing browser streaming/idempotency contract: ${marker}`);
}

const billingIndex = llmRoute.indexOf("const selectedModelBillingSnapshot = await getSelectedModelBillingSnapshot");
const claimIndex = llmRoute.indexOf("await llmRequestAttemptStore.claim");
const providerStartIndex = llmRoute.indexOf("await llmRequestAttemptStore.markProviderCallStarted");
const searchIndex = llmRoute.indexOf("searchClient.webSearch");
const deepThinkingIndex = llmRoute.indexOf("await handleDeepThinkingType1");
const streamIndex = llmRoute.indexOf("handleStreamResponse(streamCtx, chatRequest, proxy)");
const nonStreamIndex = llmRoute.indexOf("await handleNonStreamResponse(streamCtx, chatRequest, proxy)");
assert.ok(billingIndex > 0 && claimIndex > billingIndex, "price snapshot must exist before the request claim");
for (const [name, upstreamIndex] of [
  ["pre-search", searchIndex],
  ["deep-thinking", deepThinkingIndex],
  ["stream model", streamIndex],
  ["non-stream model", nonStreamIndex],
] as const) {
  assert.ok(upstreamIndex > claimIndex, `exactly-once claim must precede ${name} upstream work`);
}
assert.ok(providerStartIndex > claimIndex && providerStartIndex < deepThinkingIndex, "durable provider-start marker must fence model submission");
assert.ok(llmRoute.includes("completeLlmAttemptResponse"), "successful model responses must pass through durable completion persistence");
assert.ok(llmRoute.includes('if (streamQuote && streamQuote.amount > 0)'));
assert.ok(llmRoute.includes('await reserveLlmStreamCredits(activeLlmAttempt!, streamQuote.amount,'));
assert.ok(llmRoute.includes('streamQuote?.amount === 0 || Boolean(streamReservation)'));
assert.ok(llmRoute.includes('streamReservation ? "reservation_authorized_live_delivery"'));
assert.ok(llmRoute.includes('? "zero_charge_quote"'));
assert.ok(llmRoute.includes(': "buffer_until_atomic_settlement"'));

for (const marker of [
  '"Content-Type": "text/event-stream"',
  '"X-Accel-Buffering": "no"',
  'encoder.encode(": heartbeat\\n\\n")',
  "if (liveDelivery)",
  "bufferedResponseChunks.push",
  "stream_delivery_reason",
  'encoder.encode("data: [DONE]\\n\\n")',
]) {
  assert.ok(streamHandler.includes(marker), `missing streaming delivery contract: ${marker}`);
}

console.log(JSON.stringify({
  verifier: "text-model-delivery-zero-cost",
  cost: 0,
  providerCalls: 0,
  checks: {
    publicModelCatalogToServerRow: "passed",
    selectedPriceSnapshot: "passed",
    browserStableRequestIdentity: "passed",
    fragmentedSseAndDone: "passed",
    claimBeforeEveryUpstreamPath: "passed",
    uniformWalletReservationAndSettlementGate: "passed",
    noProxyBufferingHeaders: "passed",
  },
}, null, 2));
