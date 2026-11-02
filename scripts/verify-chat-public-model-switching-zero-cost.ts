import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldRejectOrdinaryChatModelOverride, shouldRejectOrdinaryUnpublishedChatModel } from "../src/lib/chat-model-access-policy";
import { canSelectPublicChatModel, isValidPublicChatModelId } from "../src/lib/chat-model-switching-policy";
import { STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, STORY_DIRECTOR_MOVIE_AGENT_ID } from "../src/lib/story-director-overtime-gate";
import { FREE_CHAT_AGENT_ID, CANVAS_STORYBOARD_COMPILER_AGENT_ID, MANGA_WORKBENCH_AGENT_ID } from "../src/lib/virtual-agent-policy";
import { ConversationNotFoundError, ensureConversationOwnership } from "../src/lib/conversation-ownership";

const ordinary = { authenticated: true, isAdmin: false, isCanvasInternalWorkflow: false };
const publicId = `pm_${"A0_-".repeat(6)}`;
const otherPublicId = `pm_${"b".repeat(24)}`;
assert.equal(isValidPublicChatModelId(publicId), true);
for (const selection of [
  { requestedModelId: publicId },
  { requestedModel: publicId },
  { requestedModelId: publicId, requestedModel: publicId, requestedModelOverridden: true },
  {},
]) assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, ...selection }), false);
for (const selection of [
  { requestedModelId: publicId, requestedModel: otherPublicId },
  { requestedModelId: publicId, requestedModel: "internal-name" },
  { requestedModelId: "internal-id" },
  { requestedModel: "upstream/model" },
  { requestedModelId: "pm_short" },
  { requestedModelId: `${publicId} ` },
  { requestedModelId: `${publicId}\n` },
  { requestedModelId: 42 },
  { requestedModelId: { id: publicId } },
  { requestedModelOverridden: true },
]) assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, ...selection }), true, JSON.stringify(selection));
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, isAdmin: true, requestedModelId: "internal-id" }), false);
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, isCanvasInternalWorkflow: true, requestedModelId: "internal-id" }), false);

assert.equal(canSelectPublicChatModel(FREE_CHAT_AGENT_ID, null), true);
assert.equal(canSelectPublicChatModel(MANGA_WORKBENCH_AGENT_ID, null), true,
  "the existing official manga route must retain public-model selection");
assert.equal(canSelectPublicChatModel("saved-llm", { source: "llm" }), true);
for (const [id, row] of [
  ["saved-coze", { source: "coze" }],
  ["saved-coding", { source: "coze_coding" }],
  ["missing", null],
  [undefined, { source: "llm" }],
  [STORY_DIRECTOR_MOVIE_AGENT_ID, { source: "llm" }],
  [STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID, { source: "llm" }],
  [CANVAS_STORYBOARD_COMPILER_AGENT_ID, { source: "llm" }],
  ["__unknown_virtual__", null],
] as const) assert.equal(canSelectPublicChatModel(id, row), false, String(id));

const published = { id: "row-id", name: "Published chat", model_name: "chat-model", category: "text", is_active: true,
  is_hidden: false, user_access: "available", token_billing_enabled: true, input_cost_per_million: 1,
  output_cost_per_million: 4, cached_cost_per_million: 0.1, profit_margin: 30, token_rounding_unit: 0 };
assert.equal(shouldRejectOrdinaryUnpublishedChatModel({ isAdmin: false, modelRow: published }), false);
for (const patch of [{ is_active: false }, { is_hidden: true }, { user_access: "hidden" },
  { user_access: "pending_model_activation" }, { output_cost_per_million: null }, { category: "video" }]) {
  assert.equal(shouldRejectOrdinaryUnpublishedChatModel({ isAdmin: false, modelRow: { ...published, ...patch } }), true);
}

const route = readFileSync(resolve(process.cwd(), "src/app/api/llm/route.ts"), "utf8");
const selectionGate = route.indexOf("shouldRejectOrdinaryChatModelOverride(modelAccessInput)");
const sourceGate = route.indexOf("!canSelectPublicChatModel(agentId, agentRow)");
assert.ok(selectionGate > 0 && selectionGate < route.indexOf("runSecurityChecks("));
assert.ok(sourceGate > route.indexOf("const agentRow = agentResult?.data"));
for (const marker of ["await recoverLlmCreditReservations", "await llmRequestAttemptStore.claim", "await reserveLlmStreamCredits", "await llmRequestAttemptStore.markProviderCallStarted"]) {
  assert.ok(route.indexOf(marker) > sourceGate, `source rejection must precede ${marker}`);
}
assert.match(route, /if \(!publicModelId && model && \(!llmModelRow \|\| isRetiredYunwuModel\(llmModelRow\)\)\)/u,
  "an exact public selection cannot silently change to a same-name row");
assert.match(route, /authorizeAdminCapability\(capabilityRequest, "models.manage", \{\s*requireStepUp: true/u);
assert.match(route, /if \(clientProxyUrl\.trim\(\) \|\| adminInternalModelRequested \|\| adminSecurityBypassRequested\)/u);
assert.match(route, /await ensureConversationOwnership\(/u);
assert.match(route, /await readMemberPermissionSnapshot\(verifiedUserId/u);
assert.match(route, /shouldRejectOrdinaryUnpublishedChatModel\(\{/u);
assert.match(route, /assertQuoteExpectation\(body\.quote_expectation,preparedQuote\.expectation\)/u);

async function verifyOwnership() {
  let creates = 0;
  const store = { getOwner: async () => "owner-a", create: async () => { creates++; return "created" as const; } };
  await ensureConversationOwnership(store, "existing-conversation", "owner-a");
  await assert.rejects(() => ensureConversationOwnership(store, "existing-conversation", "owner-b"), ConversationNotFoundError);
  assert.equal(creates, 0, "foreign history must be rejected without creating a conversation");
  console.log(JSON.stringify({ verifier: "chat-public-model-switching-zero-cost", result: "PASS", networkCalls: 0,
    databaseWrites: 0, providerCalls: 0, walletWrites: 0, attemptWrites: 0 }));
}
verifyOwnership().catch((error) => { console.error(error); process.exitCode = 1; });
