import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fetchWithRetry } from "../src/contexts/chat-utils";
import { canLoadVoiceHistoryForRetry } from "../src/lib/voice-history-retry";
import type { VoiceGeneration } from "../src/lib/types";

async function main() {
const root = process.cwd();
const source = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

const sidebar = source("src/components/app-sidebar.tsx");
const chatView = source("src/components/chat-view.tsx");
const appContext = source("src/contexts/app-context.tsx");
const llmRoute = source("src/app/api/llm/route.ts");
const legacyConversationRoute = source("src/app/api/conversations/route.ts");
const historyRoute = source("src/app/api/conversations/history/route.ts");
const voiceWorkspace = source("src/app/voice-studio/workspace/page.tsx");
const voiceHistory = source("src/components/vs/VoiceGenerationHistory.tsx");
const voiceHistoryRoute = source("src/app/api/voice/history/route.ts");
const voicePricingRoute = source("src/app/api/voice/pricing/route.ts");
const imitationQuoteRoute = source("src/app/api/voice/imitation-quote/route.ts");
const imitationPage = source("src/app/voice-studio/imitate/page.tsx");
const voiceStore = source("src/lib/store.ts");

assert.ok(sidebar.includes("const handleNewConversation = () =>") && sidebar.includes("onClick={handleNewConversation}"), "new conversation UI must remain available through the role-aware handler");
assert.ok(sidebar.includes("startFreeChat()"), "new conversation must expose the canonical free-chat entry");
assert.ok(!chatView.includes("/api/chat-models") && !chatView.includes("切换对话模型"), "chat header must not expose a model selector");
assert.ok(!chatView.includes("selectedPublicModelId"), "generic chat must not send a model override");
assert.ok(!llmRoute.includes("FREE_CHAT_ADMIN_ONLY"), "ordinary free chat must remain open");
assert.ok(llmRoute.includes("FREE_CHAT_DEFAULT_MODEL_KEY") && llmRoute.includes("FREE_CHAT_DEEP_THINKING_TYPE"), "free chat must use the fixed GPT-5.6 reasoning policy");
assert.ok(llmRoute.includes("MODEL_OVERRIDE_ADMIN_ONLY"), "ordinary agent model override must be rejected server-side");
assert.ok(
  legacyConversationRoute.includes('authorizeAdminCapability(request, "agents.view"')
    && legacyConversationRoute.includes('operation: "raw_conversations_read"'),
  "legacy conversation list API must remain protected by the server-side admin capability authority",
);
assert.ok(
  legacyConversationRoute.includes('authorizeAdminCapability(request, "agents.manage"')
    && legacyConversationRoute.includes('operation: "raw_conversation_create"')
    && legacyConversationRoute.includes("requireStepUp: true"),
  "legacy conversation create API must require the privileged admin capability and step-up",
);
assert.ok(historyRoute.includes('.eq("user_id", userId)') && historyRoute.includes('.order("updated_at", { ascending: false })'), "conversation history must be owner-scoped and newest-first");
assert.ok(historyRoute.includes('"Cache-Control", "private, no-store"'), "conversation history must be private and uncached");
assert.ok(chatView.includes('useState("")') && !/localStorage\.setItem\([^\n]*(?:draft|inputValue)/iu.test(chatView), "unsubmitted chat draft must start empty and stay out of storage");
assert.ok(chatView.includes("当前回复仍在生成，请先停止接收后再发送新消息"), "keyboard/click duplicate send must be blocked while streaming");
assert.ok(appContext.includes("Duplicate send blocked while conversation is streaming"), "context-level duplicate send guard is required");
assert.match(
  appContext,
  /const clientRequestId = `chat_\$\{crypto\.randomUUID\(\)\}`;[\s\S]{0,700}fetchWithRetry\("\/api\/chat"[\s\S]{0,700}"Idempotency-Key": clientRequestId/,
  "network retry must keep one logical request identity",
);
assert.match(
  appContext,
  /fetchWithRetry\("\/api\/llm"[\s\S]{0,1800}"Idempotency-Key": clientRequestId[\s\S]{0,1800}\}, 0\)/,
  "paid LLM requests must not be automatically resubmitted after an ambiguous transport failure",
);

const originalFetch = globalThis.fetch;
const observedKeys: string[] = [];
let fetchCount = 0;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  observedKeys.push(new Headers(init?.headers).get("Idempotency-Key") || "");
  fetchCount += 1;
  if (fetchCount === 1) throw new TypeError("fixture network interruption");
  return new Response("ok", { status: 200 });
}) as typeof fetch;
try {
  const response = await fetchWithRetry("/api/llm", {
    method: "POST",
    headers: { "Idempotency-Key": "llm_fixture_stable_request" },
  }, 1, 0);
  assert.equal(response.status, 200);
} finally {
  globalThis.fetch = originalFetch;
}
assert.deepEqual(observedKeys, ["llm_fixture_stable_request", "llm_fixture_stable_request"], "network retry changed logical request identity");

const failedTts: VoiceGeneration = {
  id: "tts-failed", userId: "user", voiceModelId: "seed-tts-2.0", voiceModelName: "示例音色",
  inputText: "需要重试的原文", textLength: 7, outputFormat: "mp3", speedRatio: 0, emotion: "neutral",
  engine: "volcano", cost: 0, status: "failed", terminalState: "refunded", billingState: "not_charged",
  retryEligible: true, createdAt: "2026-09-15T00:00:00.000Z",
};
assert.equal(canLoadVoiceHistoryForRetry(failedTts), true, "billing-safe ordinary failed TTS input should be loadable");
assert.equal(canLoadVoiceHistoryForRetry({ ...failedTts, retryEligible: undefined }), false, "failed history without explicit safe-retry evidence must stay blocked");
assert.equal(canLoadVoiceHistoryForRetry({ ...failedTts, voiceModelId: "seed-audio-1.0", voiceModelName: "音频生成 1.0" }), false, "seed-audio without reference snapshot must not offer unsafe retry");
assert.equal(canLoadVoiceHistoryForRetry({ ...failedTts, voiceModelId: "dual:seed-tts-2.0", voiceModelName: "双人配音" }), false, "dual history without both inputs must not offer unsafe retry");
assert.equal(canLoadVoiceHistoryForRetry({ ...failedTts, status: "success" }), false, "successful history is a result, not a failed-input retry");

const restoreStart = voiceWorkspace.indexOf("const restoreHistoryGeneration");
const submitStart = voiceWorkspace.indexOf("const submitVoiceRequest", restoreStart);
const restoreSlice = voiceWorkspace.slice(restoreStart, submitStart);
assert.ok(restoreStart > 0 && submitStart > restoreStart, "voice restore boundary missing");
assert.equal(restoreSlice.includes("fetch("), false, "loading voice history must not call an endpoint");
assert.equal(restoreSlice.includes("submitVoiceRequest("), false, "loading voice history must not auto-submit");
assert.ok(voiceWorkspace.includes("shouldReleaseVoiceAttempt") && voiceWorkspace.includes("setHistoryRefreshRevision"), "safe terminal attempts must release old browser request IDs and refresh history");
assert.ok(voiceHistory.includes("voiceHistoryRetryUnavailableReason") && voiceHistory.includes("不会自动提交"), "unsafe failed history must explain why retry is unavailable");
assert.ok(voiceStore.includes("Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '')"), "voice history must sort by submission time descending");
assert.ok(voiceHistoryRoute.includes("private, no-store"), "voice account history must be private and uncached");
assert.ok(voicePricingRoute.includes("private, no-store") && imitationQuoteRoute.includes("private, no-store"), "voice model pricing responses must not be cached");
assert.ok(!imitationPage.includes("localStorage.setItem(historyKey"), "voice imitation must not keep a browser history shadow");
assert.ok(imitationPage.includes("localStorage.removeItem(workbenchUserStorageKey('imitate_history'"), "retired voice imitation history keys must be cleaned");
assert.ok(imitationPage.includes("重新读取价格") && imitationPage.includes("已关闭提交"), "voice imitation quote failures must be visible and fail closed");
assert.ok(imitationPage.includes("当前模型：Seed-Audio 1.0"), "voice imitation must display its actual model and price context");
assert.ok(imitationPage.includes("item.status==='failed'") && imitationPage.includes("载入文案"), "failed voice imitation history must remain visible and offer input-only restore");
assert.ok(imitationPage.includes("历史载入不会自动生成") && !imitationPage.includes("localStorage.setItem(historyKey"), "voice imitation retry restore must stay manual and server-backed");

console.log(JSON.stringify({
  passed: true,
  checks: 31,
  realNetworkCalls: 0,
  realDatabaseWrites: 0,
  paidModelCalls: 0,
}, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
