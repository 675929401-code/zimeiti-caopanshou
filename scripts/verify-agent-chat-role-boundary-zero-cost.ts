import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasExplicitChatModelSelection,
  shouldRejectOrdinaryChatModelOverride,
} from "../src/lib/chat-model-access-policy";

const root = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const ordinary = {
  authenticated: true,
  isAdmin: false,
  isCanvasInternalWorkflow: false,
};

assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, requestedModelId: "pm_chat_demo" }), true);
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, requestedModel: "internal-model" }), true);
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, requestedModelOverridden: true }), true);
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary }), false);
assert.equal(shouldRejectOrdinaryChatModelOverride({ ...ordinary, isAdmin: true, requestedModelId: "pm_chat_demo" }), false);
assert.equal(shouldRejectOrdinaryChatModelOverride({
  ...ordinary,
  isCanvasInternalWorkflow: true,
  requestedModelId: "pm_chat_demo",
}), false);
assert.equal(hasExplicitChatModelSelection({ ...ordinary, requestedModelId: "   " }), false);

const sidebar = read("src/components/app-sidebar.tsx");
assert.match(sidebar, /const handleNewConversation = \(\) => \{/u);
assert.match(sidebar, /startFreeChat\(\)/u);
assert.match(sidebar, /onClick=\{handleNewConversation\}/u);
const newChatButton = sidebar.slice(sidebar.indexOf("{/* 新建对话："), sidebar.indexOf("{/* 🔒 新建对话按钮 — 锁定区域结束 */}"));
assert.ok(!newChatButton.includes("{isAdmin && ("), "ordinary users must see the new conversation button");
assert.match(sidebar, /handleSelectConversation\(conv\.id\)/u);

const marketplace = read("src/components/agent-marketplace.tsx");
assert.match(marketplace, /const handleSelectAgent = \(agentId: string\) =>/u);
assert.match(marketplace, /startConversation\(agentId\)/u);
assert.match(marketplace, /const \{ state, dispatch, startChat,/u);
assert.match(marketplace, /const newConvId = startChat\(agentId(?:,\s*requestedConversationId)?\)/u);
assert.doesNotMatch(marketplace, /type: "ADD_CONVERSATION"/u, "marketplace must use the canonical pending-conversation path");

const appContextSource = read("src/contexts/app-context.tsx");
assert.match(appContextSource, /rememberPendingLocalConversation\(conversation\);\s*dispatch\(\{ type: "START_CONVERSATION", payload: conversation \}\);\s*return conversation\.id;/u);

const genericChat = read("src/components/chat-view.tsx");
assert.doesNotMatch(genericChat, /\/api\/chat-models|切换对话模型|选择对话模型/u);
assert.doesNotMatch(genericChat, /selectedPublicModelId|retryModelName/u);
assert.match(genericChat, /FREE_CHAT_DEEP_THINKING_TYPE/u);
assert.match(genericChat, /shouldAutoEnableWebSearch/u);

const officialAgent = read("src/features/official-core-routes/official-agent-route.tsx");
assert.match(officialAgent, /const canSelectModel = state\.auth\.user\?\.role === "admin"/u);
assert.match(officialAgent, /\{canSelectModel \? \(\s*<label className=\{styles\.modelSelect\}>/u);
assert.match(officialAgent, /const requestModelId = canSelectModel \? selectedModelId : undefined/g);
assert.match(officialAgent, /modelId: requestModelId/g);
assert.match(officialAgent, /if \(canSelectModel\) \{\s*stored = sessionStorage\.getItem\(MODEL_STORAGE_KEY\)/u);
assert.match(officialAgent, /sessionStorage\.removeItem\(MODEL_STORAGE_KEY\)/u);

const llmRoute = read("src/app/api/llm/route.ts");
const rejectionIndex = llmRoute.indexOf("shouldRejectOrdinaryChatModelOverride(modelAccessInput)");
assert.ok(rejectionIndex > 0, "server route must enforce the shared model access policy");
assert.ok(rejectionIndex < llmRoute.indexOf("runSecurityChecks("), "model override must fail before security/database/provider work");
assert.ok(rejectionIndex < llmRoute.indexOf("llmRequestAttemptStore.claim"), "model override must fail before request claim");
assert.match(llmRoute, /code: "MODEL_OVERRIDE_ADMIN_ONLY"/u);
assert.doesNotMatch(llmRoute, /FREE_CHAT_ADMIN_ONLY/u);
assert.match(llmRoute, /FREE_CHAT_DEFAULT_MODEL_KEY/u);
assert.match(llmRoute, /agentDeepThinkingType = FREE_CHAT_DEEP_THINKING_TYPE/u);
assert.ok(!llmRoute.slice(rejectionIndex - 800, rejectionIndex).includes("!isAllowedVirtualAgentId(agentId)"));
assert.match(llmRoute, /if \(_preIsAdmin\) \{[\s\S]*?const adminPublicId =/u);
assert.match(llmRoute, /publicModelId = adminPublicId;[\s\S]*?model_overridden = true;/u);

const historyRoute = read("src/app/api/conversations/history/route.ts");
assert.match(historyRoute, /authorizeCurrentApiUser\(request\)/u);
assert.match(historyRoute, /\.eq\("id", singleConvId\)\s*\.eq\("user_id", userId\)/u);
assert.match(historyRoute, /\.eq\("user_id", userId\)\s*\.gt\("updated_at", retentionCutoff\)\s*\.order\("updated_at", \{ ascending: false \}\)/u);
assert.match(historyRoute, /Cache-Control", "private, no-store"/u);

const appContext = read("src/contexts/app-context.tsx");
assert.match(appContext, /fetch\(`\/api\/conversations\/history\?id=/u);
assert.match(appContext, /modelId: modelOverride \|\| undefined/u);
assert.match(appContext, /model_overridden: !!modelOverride/u);

console.log("agent chat role boundary zero-cost contract: PASS");
console.log("network_calls=0 database_writes=0 model_calls=0");
