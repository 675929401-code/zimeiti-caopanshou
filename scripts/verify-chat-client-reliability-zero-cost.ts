import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { enrichHistoryMessageIdentity, mapHistoryMessages } from "@/contexts/history-message-mapper";
import { releaseConversationSend, tryAcquireConversationSend } from "@/contexts/pending-send-lock";
import { initialState, reducer } from "@/contexts/chat-reducer";
import { classifyError } from "@/lib/chat-pipeline";
import { knownChatFailureMessage } from "@/lib/chat-customer-failure";

const root = process.cwd();
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

async function verifySynchronousSendLock() {
  const lock = new Set<string>();
  let providerCalls = 0;
  let unblock!: () => void;
  const gate = new Promise<void>((resolveGate) => { unblock = resolveGate; });

  const submit = async () => {
    const conversationId = "conversation-double-click";
    if (!tryAcquireConversationSend(lock, conversationId)) return false;
    try {
      providerCalls += 1;
      await gate;
      return true;
    } finally {
      releaseConversationSend(lock, conversationId);
    }
  };

  const first = submit();
  const second = await submit();
  assert.equal(second, false, "a same-tick second send must be rejected before any await");
  assert.equal(providerCalls, 1);
  unblock();
  assert.equal(await first, true);
  assert.equal(lock.size, 0, "the send lock must be released in finally");
}

function verifyHistoryMapping() {
  const createdAt = "2026-09-16T08:00:00.000Z";
  const [message] = mapHistoryMessages([{
    id: "history-message-1",
    role: "assistant",
    content: "恢复正文",
    reasoning_content: "恢复推理",
    agent_id: "agent-1",
    agent_name: "恢复智能体",
    agent_icon_url: "/agent.png",
    created_at: createdAt,
  }]);
  assert.equal(message.reasoningContent, "恢复推理");
  assert.equal(message.agentId, "agent-1");
  assert.equal(message.agentName, "恢复智能体");
  assert.equal(message.agentIconUrl, "/agent.png");
  assert.equal(message.timestamp, Date.parse(createdAt));

  const [gallery] = mapHistoryMessages([{
    id: "history-gallery-1",
    role: "assistant",
    content: JSON.stringify({ type: "image_gallery", prompt: "夕阳", images: [{ url: "/owned.png" }] }),
    created_at: createdAt,
  }]);
  assert.equal(gallery.generatedImages?.length, 1);
  assert.match(gallery.content, /图片生成记录/u);

  const apiShaped = mapHistoryMessages([{
    id: "history-message-agent-id-only",
    role: "assistant",
    content: "只有 agent_id 的历史正文",
    agent_id: "agent-1",
    created_at: createdAt,
  }]);
  const enriched = enrichHistoryMessageIdentity(apiShaped, [{
    id: "agent-1",
    botId: "bot-1",
    name: "恢复智能体",
    iconUrl: "/agent.png",
  }]);
  assert.equal(enriched[0]?.agentName, "恢复智能体");
  assert.equal(enriched[0]?.agentIconUrl, "/agent.png");
  assert.notEqual(enriched, apiShaped, "missing history identity must create an enriched message list");
  assert.equal(
    enrichHistoryMessageIdentity(enriched, [{ id: "agent-1", botId: "bot-1", name: "恢复智能体", iconUrl: "/agent.png" }]),
    enriched,
    "a fully enriched list must keep its reference so the effect cannot dispatch forever",
  );
}

function verifyRetryPreservesUserMessage() {
  const state = {
    ...initialState,
    conversations: [{
      id: "conversation-retry",
      agentId: "agent-1",
      agentName: "测试智能体",
      agentIconUrl: "",
      botId: null,
      title: "重试",
      lastMessage: "",
      lastMessageTime: 1,
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: "user-retry", role: "user", content: "请保留我", timestamp: 1, error: "发送失败" }],
    }],
  } as typeof initialState;
  const next = reducer(state, {
    type: "CLEAR_MESSAGE_ERROR",
    payload: { conversationId: "conversation-retry", messageId: "user-retry" },
  });
  const message = next.conversations[0]?.messages[0];
  assert.equal(message?.content, "请保留我");
  assert.equal(Object.prototype.hasOwnProperty.call(message || {}, "error"), false);
}

function verifyAmbiguousNetworkFailureBlocksDuplicateSubmit() {
  const classified = classifyError(new TypeError("Failed to fetch"));
  assert.equal(classified.class, "network");
  assert.equal(classified.retryable, false, "an ambiguous POST transport failure must not be treated as safe to retry");
  assert.match(classified.userMessage, /最终结果暂未确认/u);
  assert.match(classified.userMessage, /请勿重复发送/u);
}

function verifyLocalBuildDrainIsTruthfulAndRetrySafe() {
  const message = knownChatFailureMessage({
    code: "LOCAL_BUILD_DRAINING",
    error: "本地版本正在更新",
    retry_safe: true,
    provider_call_started: false,
    charged: false,
  });
  assert.match(message || "", /未调用模型或扣费/u);
  assert.match(message || "", /可安全重新发送/u);
  assert.doesNotMatch(message || "", /网络连接异常/u);
  assert.equal(knownChatFailureMessage({
    code: "LOCAL_BUILD_DRAINING",
    retry_safe: true,
    provider_call_started: true,
    charged: false,
  }), null, "a provider-dispatched request must never be presented as safe to resend");
}

async function main() {
  await verifySynchronousSendLock();
  verifyHistoryMapping();
  verifyRetryPreservesUserMessage();
  verifyAmbiguousNetworkFailureBlocksDuplicateSubmit();
  verifyLocalBuildDrainIsTruthfulAndRetrySafe();

  const sidebar = source("src/components/app-sidebar.tsx");
  const sidebarConversationStart = sidebar.indexOf("const createConversationAndChat");
  const sidebarConversationEnd = sidebar.indexOf("const handleNewConversation", sidebarConversationStart);
  const sidebarConversationSlice = sidebar.slice(sidebarConversationStart, sidebarConversationEnd);
  assert.match(sidebarConversationSlice, /const conversationId = startChat\(agentId\)/u);
  assert.match(sidebarConversationSlice, /setPendingPresetMessage\(\{ convId: conversationId, content: formattedMessage \}\)/u);
  assert.doesNotMatch(sidebarConversationSlice, /ADD_CONVERSATION|setTimeout|sendMessage/u);
  const presetSkipStart = sidebar.indexOf("const handlePresetSkip");
  const presetSkipEnd = sidebar.indexOf("const handlePresetClose", presetSkipStart);
  assert.match(sidebar.slice(presetSkipStart, presetSkipEnd), /createConversationAndChat\(presetAgent\.id\)/u);
  for (const route of ["/cover", "/commerce", "/storyboard-workbench", "/media-history"]) {
    assert.ok(sidebar.includes(`link_value: "${route}"`), `missing fixed shortcut ${route}`);
  }

  const appContext = source("src/contexts/app-context.tsx");
  assert.equal(appContext.split("mapHistoryMessages(").length - 1, 3, "all three history hydration paths must share one mapper");
  const sendStart = appContext.indexOf("const sendMessage = useCallback");
  const sendEnd = appContext.indexOf("// ---- Abort ongoing stream", sendStart);
  const sendSlice = appContext.slice(sendStart, sendEnd);
  const acquireIndex = sendSlice.indexOf("tryAcquireConversationSend");
  const firstAwaitIndex = sendSlice.indexOf("await ");
  assert.ok(acquireIndex > 0 && acquireIndex < firstAwaitIndex, "send lock must be acquired before the first await");
  assert.match(sendSlice, /finally \{\s*releaseConversationSend/u);

  const abortStart = appContext.indexOf("const abortCurrentStream = useCallback");
  const abortEnd = appContext.indexOf("// ---- Send message via LLM API", abortStart);
  const abortSlice = appContext.slice(abortStart, abortEnd);
  assert.match(abortSlice, /if \(ctrl && !ctrl\.signal\.aborted\) \{[\s\S]*userAbortedSet\.current\.add\(convId\)/u,
    "a user stop marker requires a live controller");
  assert.doesNotMatch(abortSlice, /controllers\.clear\(\)/u, "abort must leave controller ownership to stream finally");
  assert.match(appContext, /userAbortedSet\.current\.delete\(convId\);\s*watchdogAbortedSet\.current\.delete\(convId\);\s*abortControllerMap\.current\.set\(convId, new AbortController\(\)\)/u,
    "a new controller must start with clean abort markers");
  assert.match(appContext, /if \(abortControllerMap\.current\.get\(convId\) !== controller\) return;[\s\S]*userAbortedSet\.current\.delete\(convId\);[\s\S]*watchdogAbortedSet\.current\.delete\(convId\)/u,
    "stream finally must clean markers without deleting a newer controller");
  assert.match(appContext, /continueAfterDisconnect[\s\S]*?最终结果暂未确认[\s\S]*?请勿重复发送/u,
    "a paid/background-capable stream disconnect must remain an unknown outcome without a resend action");

  const chatView = source("src/components/chat-view.tsx");
  const messageItem = source("src/components/chat/message-item.tsx");
  const streamHandler = source("src/app/api/llm/handle-stream.ts");
  const userRetryStart = chatView.indexOf('} else if (msg.role === "user" && msg.error)');
  const userRetryEnd = chatView.indexOf("onContinue=", userRetryStart);
  const userRetrySlice = chatView.slice(userRetryStart, userRetryEnd);
  assert.match(userRetrySlice, /CLEAR_MESSAGE_ERROR/u);
  assert.match(userRetrySlice, /true, msg\.id\)/u);
  assert.doesNotMatch(userRetrySlice, /DELETE_MESSAGE/u);
  assert.match(streamHandler, /type:\s*"generation_progress"[\s\S]*?received_chars:\s*receivedChars/u,
    "buffered paid streams must emit visible progress without exposing unsettled output");
  assert.match(appContext, /data\.type === "generation_progress"[\s\S]*?streamStatus:/u,
    "the browser must consume generation progress separately from final message text");
  assert.match(appContext, /data\.type === "stream_delivery"[\s\S]*?已连接，模型思考中/u,
    "a live stream must acknowledge the connected thinking phase before the first text delta");
  assert.match(appContext, /if \(!visibleContentStarted\)[\s\S]*?streamStatus: "正在生成"/u,
    "the first visible delta must advance the status without dispatching it for every chunk");
  assert.match(messageItem, /message\.streamStatus \|\| "正在生成"/u,
    "the chat status row must render long-running generation progress");

  // The retired client-side model picker no longer owns or persists a model
  // override. When an approved surface supplies one, the shared transport
  // forwards only the public ID and the server resolves the pm_* identifier.
  assert.match(appContext, /modelId:\s*modelOverride \|\| undefined/u,
    "approved model overrides must be forwarded as public IDs");
  assert.doesNotMatch(chatView, /MODEL_OVERRIDE_PREFIX|model_override_/u,
    "the chat view must not restore legacy per-conversation model names");
  const llmRoute = source("src/app/api/llm/route.ts");
  assert.match(llmRoute, /requestedModelId\.startsWith\("pm_"\)/u,
    "the server must resolve explicit public model IDs");
  assert.doesNotMatch(chatView, /modelName|model_name/u, "the browser must not receive internal model names");

  console.log(JSON.stringify({
    verifier: "chat-client-reliability-zero-cost",
    passed: true,
    realNetworkCalls: 0,
    databaseWrites: 0,
    providerCalls: 0,
    checks: {
      canonicalConversationStart: "passed",
      presetSkipCreatesConversation: "passed",
      sameTickDuplicateSendBlocked: "passed",
      retryPreservesUserMessage: "passed",
      ambiguousNetworkFailureBlocksDuplicateSubmit: "passed",
      localBuildDrainTruthfulAndRetrySafe: "passed",
      bufferedPaidStreamProgressVisible: "passed",
      historyRowsNormalized: "passed",
      historyAvatarIdentityEnriched: "passed",
      fixedNavigationEntrypoints: "passed",
      abortReasonGenerationSafe: "passed",
      legacyInternalModelFallback: "passed",
    },
  }, null, 2));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
