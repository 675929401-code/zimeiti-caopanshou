import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldRejectOrdinaryUnpublishedChatModel } from "@/lib/chat-model-access-policy";
import { isPublishedTextBillingModel } from "@/lib/text-model-eligibility";
import { modelProbeFailure } from "@/lib/model-probe-result";

const publishedModel = {
  id: "fixture-published-text-model",
  name: "已发布文案模型",
  model_name: "fixture-chat-model",
  description: "文本对话与文案",
  category: "text",
  is_active: true,
  is_hidden: false,
  user_access: "available",
  token_billing_enabled: true,
  input_cost_per_million: 1,
  output_cost_per_million: 4,
  cached_cost_per_million: 0.1,
  profit_margin: 30,
  token_rounding_unit: 0,
};

assert.equal(isPublishedTextBillingModel(publishedModel), true);
assert.equal(shouldRejectOrdinaryUnpublishedChatModel({ isAdmin: false, modelRow: publishedModel }), false,
  "a valid published default model must remain available to an ordinary user");

for (const [label, modelRow] of [
  ["hidden", { ...publishedModel, is_hidden: true }],
  ["inactive", { ...publishedModel, is_active: false }],
  ["hidden-access", { ...publishedModel, user_access: "hidden" }],
  ["pending-activation", { ...publishedModel, user_access: "pending_model_activation" }],
  ["price-incomplete", { ...publishedModel, output_cost_per_million: null }],
  ["media-only", { ...publishedModel, category: "video", description: "视频生成" }],
] as const) {
  assert.equal(isPublishedTextBillingModel(modelRow), false, `${label} must not be published`);
  assert.equal(
    shouldRejectOrdinaryUnpublishedChatModel({ isAdmin: false, modelRow }),
    true,
    `${label} binding must fail closed for an ordinary user`,
  );
}

assert.equal(shouldRejectOrdinaryUnpublishedChatModel({
  isAdmin: true,
  modelRow: { ...publishedModel, is_hidden: true },
}), false, "the new publication gate must preserve administrator custom-model authority");

for (const [status, detail] of [
  [402, "Arrearage: insufficient balance"],
  [403, "余额不足"],
  [429, "insufficient quota"],
] as const) {
  assert.deepEqual(modelProbeFailure(status, detail), {
    diagnosticCode: "UPSTREAM_BALANCE",
    message: "上游余额或额度不足；保留模型配置，不能据此判定密钥失效",
  });
}

const route = readFileSync(resolve(process.cwd(), "src/app/api/llm/route.ts"), "utf8");
const finalModelIndex = route.search(/\b(?:const|let) billingModelRow =/u);
const publicationGateIndex = route.indexOf("shouldRejectOrdinaryUnpublishedChatModel({");
const billingSnapshotIndex = route.indexOf("const selectedModelBillingSnapshot = await getSelectedModelBillingSnapshot");
const walletRecoveryIndex = route.indexOf("await recoverLlmCreditReservations");
const attemptClaimIndex = route.indexOf("await llmRequestAttemptStore.claim");
const walletReserveIndex = route.indexOf("await reserveLlmStreamCredits");
const providerStartIndex = route.indexOf("await llmRequestAttemptStore.markProviderCallStarted");

assert.ok(finalModelIndex > 0 && publicationGateIndex > finalModelIndex,
  "the publication gate must inspect the final billingModelRow");
assert.ok(billingSnapshotIndex > publicationGateIndex,
  "the publication gate must run before constructing a billable snapshot");
for (const [label, sideEffectIndex] of [
  ["wallet recovery", walletRecoveryIndex],
  ["durable attempt claim", attemptClaimIndex],
  ["wallet reservation", walletReserveIndex],
  ["provider start", providerStartIndex],
] as const) {
  assert.ok(sideEffectIndex > publicationGateIndex, `the publication gate must precede ${label}`);
}
assert.match(route.slice(publicationGateIndex, billingSnapshotIndex), /isAdmin: userRole === "admin"/u);
assert.match(route.slice(publicationGateIndex, billingSnapshotIndex), /modelRow: billingModelRow/u,
  "the gate must inspect the actual final admitted billing row");
assert.match(route.slice(publicationGateIndex, billingSnapshotIndex), /code: "MODEL_NOT_PUBLISHED"/u);
assert.match(route.slice(publicationGateIndex, billingSnapshotIndex), /status: 503/u);

console.log(JSON.stringify({
  verifier: "chat-published-model-gate-zero-cost",
  cost: 0,
  networkCalls: 0,
  databaseWrites: 0,
  providerCalls: 0,
  walletWrites: 0,
  attemptWrites: 0,
  checks: {
    hiddenOrUnpublishedOrdinaryBinding: "rejected",
    publishedDefaultOrdinaryBinding: "allowed",
    administratorCustomModelAuthority: "preserved",
    balanceProbeKeepsPublishedConfiguration: "passed",
    gateBeforeBillingWalletAttemptAndProvider: "passed",
  },
}, null, 2));
