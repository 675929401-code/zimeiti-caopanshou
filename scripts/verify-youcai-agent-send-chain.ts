import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMangaAgentModelCatalog,
  MANGA_AGENT_MODEL_POLICY_VERSION,
} from "@/lib/manga-agent-model-policy";
import {
  detectMangaCreativeAgentSkill,
} from "@/lib/manga-creative-agent-prompt";
import { MANGA_CREATIVE_AGENT_SYSTEM_PROMPT } from "@/lib/server/manga-creative-agent-system-prompt.data";
import { containsForbiddenPublicModelKey } from "@/lib/public-model-dto";
import { hasImageInput, isImageParsingEnabled } from "@/lib/llm-input-capability";
import {
  createVirtualChatAgent,
  MANGA_WORKBENCH_AGENT_ID,
} from "@/lib/virtual-chat-agents";

const ROOT = process.cwd();
const source = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

const officialAgent = source("src/features/official-core-routes/official-agent-route.tsx");
const officialAgentCss = source("src/features/official-core-routes/official-agent-route.module.css");
const appContext = source("src/contexts/app-context.tsx");
const messageItem = source("src/components/chat/message-item.tsx");
const historyRoute = source("src/app/api/conversations/history/route.ts");
const attachmentMigration = source("supabase/migrations/20260825130000_conversation_message_attachments.sql");
const attachmentRollback = source("supabase/rollbacks/20260825130000_conversation_message_attachments.rollback.sql");
const modelRoute = source("src/app/api/youcai/chat-models/route.ts");
const llmRoute = source("src/app/api/llm/route.ts");

for (const value of [true, 1, "1", "true", "reverse", "gpt_vision", "global", " TRUE "]) {
  assert.equal(isImageParsingEnabled(value), true, `expected image capability to be enabled: ${String(value)}`);
}
for (const value of [false, 0, -1, 2, "", "none", "false", "0", "off", "disabled", "no", "null", "undefined", "unknown", null, undefined]) {
  assert.equal(isImageParsingEnabled(value), false, `expected image capability to fail closed: ${String(value)}`);
}
assert.equal(hasImageInput([{ role: "user", content: "image_url is plain text" }]), false);
assert.equal(hasImageInput([{ role: "user", content: [{ type: "text", text: "image_url" }] }]), false);
assert.equal(hasImageInput([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }]), true);

const fixtureSecrets = {
  firstId: "internal-text-model-001",
  secondId: "internal-text-model-002",
  modelName: "provider-private-model-slug",
  endpoint: "https://private-provider.invalid/v1",
  apiKey: "fixture-secret-key-must-not-leak",
};

const catalog = buildMangaAgentModelCatalog([
  {
    id: fixtureSecrets.secondId,
    name: "长文写作 · 渠道 B",
    model_name: "text-model-secondary",
    description: "通用文案与剧本",
    category: "text",
    image_parsing: "none",
    file_parsing: "none",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 20,
    token_billing_enabled: true,
    input_cost_per_million: 1,
    output_cost_per_million: 4,
    cached_cost_per_million: 0.5,
    profit_margin: 30,
  },
  {
    id: fixtureSecrets.firstId,
    name: "文案创作 · 渠道 A",
    model_name: fixtureSecrets.modelName,
    description: "短文案、脚本与策划",
    category: "llm",
    icon_url: "/fixture/text.png",
    cost_per_use: 3,
    deep_thinking_type: 1,
    enable_web_search: true,
    image_parsing: true,
    file_parsing: true,
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 10,
    token_billing_enabled: true,
    input_cost_per_million: 2,
    output_cost_per_million: 8,
    cached_cost_per_million: 1,
    profit_margin: 40,
    api_endpoint: fixtureSecrets.endpoint,
    api_key: fixtureSecrets.apiKey,
  },
  {
    id: "internal-unpriced-text-model",
    name: "未配置价格的文案模型",
    model_name: "unpriced-text",
    category: "text",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 15,
  },
  {
    id: "internal-image-model",
    name: "Seedream 生图",
    model_name: "seedream-image",
    category: "image",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 1,
  },
  {
    id: "internal-video-model",
    name: "视频生成",
    model_name: "video-generator",
    category: "video",
    is_active: true,
    is_hidden: false,
    user_access: "available",
    sort_order: 2,
  },
  {
    id: "internal-pending-model",
    name: "待验收文案模型",
    model_name: "pending-text",
    category: "text",
    is_active: true,
    is_hidden: false,
    user_access: "pending_model_activation",
    sort_order: 3,
  },
  {
    id: "internal-hidden-model",
    name: "隐藏文案模型",
    model_name: "hidden-text",
    category: "text",
    is_active: true,
    is_hidden: true,
    user_access: "available",
    sort_order: 4,
  },
  {
    id: "internal-inactive-model",
    name: "未发布文案模型",
    model_name: "inactive-text",
    category: "text",
    is_active: false,
    is_hidden: false,
    user_access: "available",
    sort_order: 5,
  },
]);

assert.equal(catalog.models.length, 2, "only published, visible text-compatible models may be listed");
assert.equal(catalog.unavailableModels.length, 1, "published models without explicit token pricing must be disclosed as unavailable");
assert.equal(catalog.policy.version, MANGA_AGENT_MODEL_POLICY_VERSION);
assert.equal(catalog.policy.defaultModelId, catalog.models[0]?.id, "the current first published compatible row is the default");
assert.equal(catalog.policy.selection, "published-visible-text-compatible");
assert.equal(catalog.policy.fallback, "block-send-no-compatible-model");
assert.equal(catalog.models[0]?.capabilities.imageParsing, true);
assert.equal(catalog.models[0]?.capabilities.fileParsing, true);
assert.equal(catalog.models[1]?.capabilities.imageParsing, false, 'the string "none" must not be reported as supported');
assert.equal(catalog.models[1]?.capabilities.fileParsing, false, 'the string "none" must not be reported as supported');
assert.equal(catalog.models.every((model) => model.capabilities.billingUnit === "token"), true);
assert.equal(catalog.models.every((model) => model.capabilities.pricingMode === "token_usage"), true);
assert.equal(catalog.models.every((model) => model.capabilities.explicitlyFree === false), true);
assert.equal(catalog.models.every((model) => model.capabilities.priceReady === true), true);
assert.equal(catalog.models.every((model) => model.capabilities.available === true), true);
assert.equal(catalog.unavailableModels[0]?.capabilities.priceReady, false);
assert.equal(catalog.unavailableModels[0]?.capabilities.available, false);
assert.match(String(catalog.unavailableModels[0]?.capabilities.availabilityMessage || ""), /计费|Token/u);
assert.match(catalog.models[0]?.id || "", /^pm_[A-Za-z0-9_-]{24}$/u);
assert.notEqual(catalog.models[0]?.id, fixtureSecrets.firstId);
assert.equal(containsForbiddenPublicModelKey(catalog), false);

const serializedCatalog = JSON.stringify(catalog);
for (const secret of Object.values(fixtureSecrets)) {
  assert.equal(serializedCatalog.includes(secret), false, `public model response leaked fixture value: ${secret}`);
}

const emptyCatalog = buildMangaAgentModelCatalog([]);
assert.equal(emptyCatalog.policy.defaultModelId, null);
assert.equal(emptyCatalog.policy.fallback, "block-send-no-compatible-model");
assert.match(emptyCatalog.policy.unavailableMessage, /阻止发送/u);

const virtualAgent = createVirtualChatAgent(MANGA_WORKBENCH_AGENT_ID);
assert.ok(virtualAgent);
assert.equal(virtualAgent.source, "llm");
assert.equal(virtualAgent.model, undefined);
assert.equal(virtualAgent.systemPrompt, "");
for (const marker of [
  "用户明确要求真实媒体且运行时提供相应工具时，再调用工具",
  "如果运行时没有相应媒体工具",
  "不能假装已经生成",
  "只有运行时明确提供工具且用户要求真实生成时才提交工具",
]) {
  assert.ok(MANGA_CREATIVE_AGENT_SYSTEM_PROMPT.includes(marker), `missing conditional media-tool policy: ${marker}`);
}
assert.doesNotMatch(
  MANGA_CREATIVE_AGENT_SYSTEM_PROMPT,
  /不在对话中发起生成/u,
  "do not restore the obsolete never-generate contract",
);

assert.equal(detectMangaCreativeAgentSkill("帮我写一段宠物口播文案"), "chat");
assert.equal(detectMangaCreativeAgentSkill("生成一张宠物角色图"), "image");
assert.equal(detectMangaCreativeAgentSkill("生成 5 秒雨夜推镜视频"), "video");
assert.equal(detectMangaCreativeAgentSkill("视频"), "video");
assert.equal(detectMangaCreativeAgentSkill("图片"), "image");
assert.equal(detectMangaCreativeAgentSkill("音乐"), "music");
assert.equal(detectMangaCreativeAgentSkill("创作一首治愈歌曲"), "music");

for (const marker of [
  'messages.push({ role: "system", content: agent.systemPrompt })',
  'fetchWithRetry("/api/llm"',
  "modelId: modelOverride || undefined",
  "agentId: agent.id",
  "conversationId: convId",
  'type: "MARK_MESSAGE_ERROR"',
  "await settleTypewriterUpdate",
  'type: "SET_MESSAGE_STREAMING"',
  "SAFE_INLINE_CHAT_IMAGE",
  ".map(toLlmImageUrl)",
]) {
  assert.ok(appContext.includes(marker), `missing LLM send-chain marker: ${marker}`);
}

for (const marker of [
  'conversation.agentId === MANGA_WORKBENCH_AGENT_ID',
  'fetch("/api/youcai/chat-models"',
  "queuedPrompt.requiredConversationId",
  "queuedPrompt.waitForRemovedMessageId",
  "task.imageUrls",
  "task.apiContent",
  "activeConversation.agentId !== MANGA_WORKBENCH_AGENT_ID",
  "message.error",
  "retryFailedMessage",
  "apiContent: message.content",
  "imageUrls: originalImages",
  "materializeRetryImages",
  "retryAssetIds.length !== originalImageUrls.length",
  "retryModel.capabilities?.imageParsing !== true",
  "persistOwnedImageAttachmentHistory",
  'const canSelectModel = state.auth.user?.role === "admin"',
  "const requestModelId = canSelectModel ? selectedModelId : undefined",
  "modelId: requestModelId",
  "sessionStorage.removeItem(MODEL_STORAGE_KEY)",
  "attachmentAssetIds",
  'aria-label="关闭命令与创作技能"',
  'aria-label="关闭提示词库"',
  "当前 Agent 链路尚未将视频/音频内容传给模型",
  'type: "DELETE_MESSAGE"',
  "openCommandMenu",
  "openPromptLibrary",
  "openAssetPicker",
  "selectedAssets",
  "materializeImagePayloads",
  "imagePayloadAssetIds",
  "payload.dataUrl",
  "selectedModel.capabilities?.imageParsing !== true",
  "unreadableMedia.length > 0",
  "imagePayloads.length !== imageAttachments.length",
  "本次已阻止发送和扣费",
  'role="listbox"',
  'aria-label="提示词库"',
  'aria-label="引用个人图片"',
  'aria-label="引用个人视频"',
  'aria-label="引用个人音频"',
  'title="引用个人图片"',
  'title="引用个人视频"',
  'title="引用个人音频"',
  '/api/storage/files?category=${assetPickerKind}',
  '/api/storage/files/${encodeURIComponent(candidate.id)}/content',
  "requiresAuth: true",
  'data-intent={composerSkill}',
]) {
  assert.ok(officialAgent.includes(marker), `missing Agent state-machine marker: ${marker}`);
}
const submitPromptSource = officialAgent.slice(officialAgent.indexOf("async function submitPrompt"));
const directSendIndex = submitPromptSource.indexOf("void sendMessage(");
const queuedSendIndex = submitPromptSource.indexOf("setQueuedPrompt({");
assert.ok(directSendIndex > 0, "submitPrompt must retain the direct send path");
assert.ok(queuedSendIndex > 0, "submitPrompt must retain the new-conversation queue path");
for (const gate of [
  "unreadableMedia.length > 0",
  "selectedModel.capabilities?.imageParsing !== true",
  "imagePayloads.length !== imageAttachments.length",
]) {
  const gateIndex = submitPromptSource.indexOf(gate);
  assert.ok(gateIndex > 0, `missing fail-closed gate: ${gate}`);
  assert.ok(gateIndex < directSendIndex, `${gate} must run before the direct model request`);
  assert.ok(gateIndex < queuedSendIndex, `${gate} must run before a queued model request`);
}
assert.equal(officialAgent.includes("<strong>你</strong>"), false, "do not restore the duplicate user label");
assert.equal(officialAgent.includes("buildCompleteWorkbenchHandoff"), false, "public Agent replies must remain in Agent");
assert.equal(officialAgent.includes("handoffMessageToWorkbench"), false, "public Agent must not expose a main-site media handoff");
assert.equal(officialAgent.includes("YOUCAI_AGENT_WORKBENCH_ROUTES"), true, "public Agent must retain the audited internal workbench route allowlist");
assert.equal(officialAgent.includes("resolveProposalDestination"), true, "tool proposals must resolve through the audited internal route allowlist");
assert.equal(officialAgent.includes("OFFICIAL_INSPIRATION_ITEMS"), false, "account asset pickers must not mix public inspiration cards");
assert.equal(officialAgent.includes("assetSource"), false, "account asset pickers must not restore the removed source toggle");
assert.equal(
  /fetch\(["'`]\/api\/(?:image|video|audio|music)/u.test(officialAgent),
  false,
  "Agent UI must not bypass the runtime media-tool gate with hard-coded media endpoint calls",
);
assert.equal(officialAgent.includes('fetch("/api/chat-models"'), false, "the branch must not fall back to the generic model list");
assert.match(
  officialAgent,
  /\{canSelectModel \? \(\s*<label className=\{styles\.modelSelect\}>/u,
  "only administrators may see the official Agent model selector",
);
assert.ok(messageItem.includes("function MessageImage"), "chat history must render validated inline image data directly");
assert.ok(messageItem.includes("SAFE_INLINE_CHAT_IMAGE"), "chat history must reject arbitrary inline image URLs");

for (const marker of [
  'const ATTACHMENT_TABLE = "conversation_message_attachments"',
  'from("user_files")',
  '.eq("user_id", userId)',
  '.eq("file_category", "image")',
  "attachment_asset_ids: assetIds",
  "images: assetIds.map(ownedAssetContentPath)",
  "storedUserText(item.content) === messageContent",
  "content: storedUserText(message.content)",
  'code: "ATTACHMENT_MIGRATION_NOT_READY"',
  'code: "ATTACHMENT_MESSAGE_NOT_READY"',
]) {
  assert.ok(historyRoute.includes(marker), `missing owned attachment history marker: ${marker}`);
}
assert.ok(attachmentMigration.includes("CREATE TABLE IF NOT EXISTS conversation_message_attachments"));
assert.ok(attachmentMigration.includes("UNIQUE(message_id, asset_id)"));
assert.ok(attachmentMigration.includes("ENABLE ROW LEVEL SECURITY"));
assert.ok(attachmentRollback.includes("DROP TABLE IF EXISTS conversation_message_attachments"));
for (const marker of [
  "shouldRejectOrdinaryChatModelOverride(modelAccessInput)",
  'code: "MODEL_OVERRIDE_ADMIN_ONLY"',
  "hasImageInput(messages)",
  "isImageParsingEnabled(llmModelRow?.image_parsing)",
  "MODEL_IMAGE_INPUT_UNSUPPORTED",
  "本次未调用模型也未扣费",
]) {
  assert.ok(llmRoute.includes(marker), `missing server-side image capability gate: ${marker}`);
}
const serverImageGateIndex = llmRoute.indexOf("MODEL_IMAGE_INPUT_UNSUPPORTED");
assert.ok(serverImageGateIndex > llmRoute.indexOf("llmModelByNameConfig = llmModelRow"), "server image gate must run after final public model resolution");
for (const laterSideEffect of [
  "rateInfo.count++",
  "const selectedModelBillingSnapshot = await getSelectedModelBillingSnapshot",
  "const creditsCheck = await checkCreditsBalance",
  "const finalMessages = await prepareContext",
  "await llmRequestAttemptStore.claim",
  "const chatRequest: ChatRequest",
]) {
  const laterIndex = llmRoute.indexOf(laterSideEffect);
  assert.ok(laterIndex > serverImageGateIndex, `server image gate must precede ${laterSideEffect}`);
}

for (const marker of [
  "color-scheme: light",
  "height: 100dvh",
  ".messageError",
  "scrollbar-color",
  "focus-visible",
  ".commandMenu",
  ".promptPopover",
  ".assetDialog",
  ".attachmentStrip",
]) {
  assert.ok(officialAgentCss.includes(marker), `missing light/responsive UI marker: ${marker}`);
}

assert.ok(modelRoute.includes("buildMangaAgentModelCatalog"));
assert.ok(modelRoute.includes('Cache-Control": "private, no-store"'));
assert.equal(modelRoute.includes("api_key"), false);
assert.equal(modelRoute.includes("api_endpoint"), false);
assert.equal(modelRoute.includes("proxy_url"), false);

console.log(JSON.stringify({
  verifier: "youcai-agent-send-chain",
  cost: 0,
  networkCalls: 0,
  checks: {
    publicModelPolicy: "passed",
    noSecretModelDto: "passed",
    systemPromptToLlmChain: "passed",
    newExistingRetryStreamingVisibility: "passed",
    ownedAttachmentHistoryAndRetry: "passed",
    personalAssetReferencesStayInAgent: "passed",
    noMainSiteWorkbenchHandoff: "passed",
    explicitComposerPanelClose: "passed",
    lightResponsiveUiContract: "passed",
  },
}, null, 2));
