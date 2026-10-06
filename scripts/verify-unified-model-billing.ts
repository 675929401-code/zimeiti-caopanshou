import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

const paths = {
  billing: resolve(ROOT, "src", "lib", "billing.ts"),
  executor: resolve(ROOT, "src", "lib", "billing-executor.ts"),
  llmRoute: resolve(ROOT, "src", "app", "api", "llm", "route.ts"),
  llmBilling: resolve(ROOT, "src", "lib", "llm-billing.ts"),
  imageRoute: resolve(ROOT, "src", "app", "api", "image", "generate", "route.ts"),
  imageBridge: resolve(ROOT, "src", "app", "api", "bridge", "image", "generate", "route.ts"),
  videoRoute: resolve(ROOT, "src", "app", "api", "video", "generate", "route.ts"),
  videoFinalizer: resolve(ROOT, "src", "lib", "video-terminal-finalizer.ts"),
  videoBridge: resolve(ROOT, "src", "app", "api", "bridge", "video", "generate", "route.ts"),
  voiceRoute: resolve(ROOT, "src", "app", "api", "voice", "tts", "route.ts"),
  voicePricing: resolve(ROOT, "src", "lib", "vs", "pricing.ts"),
  extractionRoute: resolve(ROOT, "src", "app", "api", "extract", "route.ts"),
  digitalHumanLongCreate: resolve(ROOT, "src", "lib", "digital-human-long-create.ts"),
  videoPage: resolve(ROOT, "src", "app", "video", "page.tsx"),
  digitalHumanSpeech: resolve(ROOT, "src", "features", "digital-human", "SpeechComposer.tsx"),
  commerceModelCanary: resolve(ROOT, "src", "commerce", "server", "model-canary.ts"),
  commerceCardCanary: resolve(ROOT, "src", "commerce", "server", "card-canary.ts"),
  commerceAdmin: resolve(ROOT, "src", "components", "admin", "CommerceAgentAdminTab.tsx"),
  dramaRoute: resolve(ROOT, "src", "app", "api", "short-drama", "script", "route.ts"),
  uploadRoute: resolve(ROOT, "src", "app", "api", "short-drama", "upload-script", "standardize", "route.ts"),
};

const source = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [name, readFileSync(path, "utf8")]),
) as Record<keyof typeof paths, string>;

type Check = { name: string; run: () => void };
const checks: Check[] = [];

function check(name: string, run: () => void): void {
  checks.push({ name, run });
}

function containsAll(value: string, markers: readonly string[]): void {
  for (const marker of markers) assert.ok(value.includes(marker), `missing marker: ${marker}`);
}

check("recharge exchange rate has one shared source", () => {
  containsAll(source.billing, [
    'creditsPerYuan: get("credits_per_yuan", 50)',
    "export async function getBillingConfig()",
  ]);
});

check("credit and cash mutations share the atomic wallet executor", () => {
  containsAll(source.executor, [
    "applyAtomicWalletOperation",
    "operationKind: 'credit_charge'",
    "operationKind: 'cash_charge'",
    "idempotencyKey: params.idempotencyKey",
    "public_model_id: params.publicModelId || null",
    "price_snapshot: params.priceSnapshot || null",
  ]);
  assert.doesNotMatch(source.executor, /\.from\(['"]users['"]\)\.update\(/u);
});

check("text and virtual Agent settle the selected published model", () => {
  containsAll(source.llmRoute, [
    "findModelByPublicId(\"chat\"",
    "findModelByPublicId(\"llm\"",
    "getSelectedModelBillingSnapshot(",
    "selectedModelBillingSnapshot",
    'request.headers.get("idempotency-key")',
    "body.client_request_id",
  ]);
  containsAll(source.llmBilling, [
    "getSelectedModelBillingSnapshot",
    "resolveSelectedModelBillingConfig",
    "settleLlmUsage",
    "deductCreditsWithAgentBilling",
    "options.billingSnapshot.config",
  ]);
  containsAll(source.billing, [
    "export async function deductCreditsWithAgentBilling(",
    "applyAtomicWalletOperation({",
  ]);
});

check("image generation uses the selected public model price and pre-provider cash reservation", () => {
  containsAll(source.imageRoute, [
    "findModelByPublicId(",
    'resolveImageResolutionPrice(modelConfig!, effectiveResolution, "cost")',
    'resolveImageResolutionPrice(modelConfig!, effectiveResolution, "selling")',
    "selectedBillingPublicModelId",
    "executeCashDeduction({",
    'idempotencyKey: billingReferenceId',
    'phase: "image_provider_reservation"',
    "publicModelId: selectedBillingPublicModelId",
    "requested_public_model_id: selectedBillingPublicModelId",
    "selectedModelId: result.selectedModelId",
    "selectedCostPrice: result.selectedCostPrice",
    "costPrice = selectedCostPrice",
    "price_yuan: sellingPrice",
    "quoted_cost_price_yuan: costPrice",
    "actualCostPriceYuan: String(costPrice)",
    'code: "IMAGE_PRICE_NOT_CONFIGURED"',
  ]);
  assert.doesNotMatch(source.imageRoute, /\bdeductCash\s*\(/u);
  assert.match(source.imageBridge, /export \{ POST \} from ["']@\/app\/api\/image\/generate\/route["']/u);
});

check("video generation freezes model duration resolution pricing and charges once at terminal state", () => {
  containsAll(source.videoRoute, [
    "findModelByPublicId(",
    "requireVideoPriceSnapshot(selectedModel, selectedResolution, videoTiming.target)",
    "client_request_id",
  ]);
  containsAll(source.videoFinalizer, [
    "executeCashDeduction({",
    'phase: "video_terminal"',
    'publicModelId: toPublicModelId("video", modelId)',
    'requested_public_model_id: toPublicModelId("video", modelId)',
    "cost_price_yuan: costPriceYuan",
    "resolution: task.resolution || null",
    "duration_seconds: task.duration_seconds || null",
    "VIDEO_BILLING_IDEMPOTENCY_KEY_MISSING",
    "finalize_video_generation_task_atomic",
    'state: "billing_pending"',
  ]);
  containsAll(source.videoBridge, ["/api/video/generate", "authorization"]);
});

check("voice and audio use active Voice Studio model cost profit and shared exchange rate", () => {
  containsAll(source.voicePricing, [
    "FROM ModelConfig WHERE modelId = ? AND isActive = 1",
    "pricing.costPrice",
    "pricing.profitMargin",
  ]);
  containsAll(source.voiceRoute, [
    "getBillingConfig",
    "resolveVoiceBillingQuote(",
    "VOICE_PRICE_NOT_CONFIGURED",
    "beginVoiceGenerationAtomic",
    "finalizeVoiceGenerationAtomic",
    "refundVoiceGenerationAtomic",
    "operation.creditsPerYuan",
    "Idempotency-Key",
    "client_request_id",
  ]);
  assert.doesNotMatch(source.voiceRoute, /\bCREDITS_PER_YUAN\b/u);
  assert.match(source.voiceRoute, /本次未调用上游、未扣费/u);
});

check("short-drama server routes delegate model settlement to the main LLM endpoint", () => {
  for (const value of [source.dramaRoute, source.uploadRoute]) {
    containsAll(value, [
      "/api/llm",
      "Idempotency-Key",
      "client_request_id",
    ]);
  }
});

check("generation settlement contains no Manju-specific wallet or fixed sale rate", () => {
  for (const value of [source.llmRoute, source.llmBilling, source.imageRoute, source.videoRoute, source.videoFinalizer, source.voiceRoute]) {
    assert.doesNotMatch(value, /manju_(?:price|wallet|credits|cash)|漫剧(?:固定|独立)(?:价格|钱包|费率)/iu);
  }
});

check("administrator privileges never create a role-based billing exemption", () => {
  containsAll(source.llmBilling, [
    "Role controls administration, never price.",
    "void isAdmin;",
    "deductCreditsWithAgentBilling(",
  ]);
  containsAll(source.imageRoute, [
    "billingExempt: sellingPrice === 0",
    "if (sellingPrice > 0)",
  ]);
  containsAll(source.videoRoute, ["const billingExempt = false"]);
  containsAll(source.voiceRoute, [
    "const effectiveExemption = quotedAmount <= 0",
    "billingExempt: effectiveExemption",
  ]);
  containsAll(source.extractionRoute, ["const billingExempt = false"]);
  containsAll(source.digitalHumanLongCreate, [
    "billingExempt: false",
    "const lockedPriceYuan = quote.lockedTotalYuan",
    "if (wallet.balance + 0.0001 < lockedPriceYuan)",
  ]);
  assert.doesNotMatch(source.digitalHumanLongCreate, /input\.admin\s*\?\s*0\s*:\s*quote\.lockedTotalYuan/u);
  assert.doesNotMatch(source.digitalHumanLongCreate, /if\s*\(\s*!input\.admin\s*&&\s*wallet\.balance/u);
  for (const value of [source.commerceModelCanary, source.commerceCardCanary]) {
    containsAll(value, ["adminWalletCharge:value.ordinaryUserPrice"]);
    assert.doesNotMatch(value, /adminWalletCharge\s*:\s*0/u);
  }
  containsAll(source.commerceAdmin, [
    "adminWalletCharge:number",
    "管理员钱包将扣 ¥${quoted.quote.adminWalletCharge.toFixed(4)}",
    "管理员与普通用户执行同一钱包扣费规则",
  ]);
  assert.doesNotMatch(source.commerceAdmin, /管理员钱包扣费(?:为|\s*)\s*¥?0/u);
  containsAll(source.videoPage, ["{cashBalance < selectedPrice && ("]);
  assert.doesNotMatch(source.videoPage, /!isAdmin\s*&&\s*cashBalance\s*<\s*selectedPrice/u);
  containsAll(source.digitalHumanSpeech, ["(credits ?? 0) < quote"]);
  assert.doesNotMatch(source.digitalHumanSpeech, /!admin\s*&&\s*\(credits\s*\?\?\s*0\)\s*<\s*quote/u);
  for (const value of [
    source.llmBilling,
    source.imageRoute,
    source.videoRoute,
    source.voiceRoute,
    source.extractionRoute,
    source.digitalHumanLongCreate,
  ]) {
    assert.doesNotMatch(value, /billing(?:Exempt|_exempt)\s*[:=]\s*(?:user\.)?role\s*===?\s*["']admin["']/u);
  }
});

const passed: string[] = [];
for (const item of checks) {
  try {
    item.run();
    passed.push(item.name);
  } catch (error) {
    console.error(`FAIL: ${item.name}`);
    throw error;
  }
}

console.log(JSON.stringify({
  ok: true,
  paidModelCalls: 0,
  networkCalls: 0,
  checks: passed.length,
  passed,
  pricingContract: {
    recharge: "platform_settings.credits_per_yuan",
    text: "published public model token cost and profit margin",
    image: "published cover model selling_price and cost_price",
    video: "published video model duration and resolution price snapshot",
    voice: "active Voice Studio ModelConfig costPrice and profitMargin",
  },
  walletContract: "shared atomic credit/cash wallet and ledger",
}, null, 2));
