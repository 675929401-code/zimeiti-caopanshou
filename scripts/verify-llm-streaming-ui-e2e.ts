import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";

const baseUrl = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const baseOrigin = new URL(baseUrl).origin;
const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence", "llm-streaming-ui-e2e-20260902", runStamp);
const appContextPath = path.resolve("src", "contexts", "app-context.tsx");
const standaloneBuildIdPath = path.resolve(".next", "standalone", ".next", "BUILD_ID");
const selectedModelId = "22222222-2222-4222-8222-222222222222";
const networkPrompt = "LLM_UI_FIXTURE_NETWORK_UNKNOWN：模拟请求已到达服务端后浏览器连接中断。";
const successPrompt = [
  "LLM_UI_FIXTURE_SUCCESS：请用结构化格式说明流式输出、稳定请求键和成功重放。",
  ...Array.from({ length: 36 }, (_, index) => `补充上下文 ${index + 1}：这是一段用于制造真实聊天滚动距离的零费用浏览器夹具文本。`),
].join("\n");
const frozenPrompt = "LLM_UI_FIXTURE_UNKNOWN：模拟上游终态不明。";
const fixtureChunks = [
  "## 流式交付状态\n\n",
  "- 首批文字尽早显示，等待过程可感知。\n",
  "- 网络错误后仅由用户点击继续回复，不能自动重发。\n",
  "- 手动重试作为新的用户操作，使用新的稳定请求键。\n\n",
  "| 验收项 | 结果 |\n| --- | --- |\n| 流式增长 | 通过 |\n| 刷新恢复 | 通过 |\n\n",
  "```json\n{\"streaming\":true,\"replayed\":true}\n```\n\n",
  "刷新页面后，本地会话仍应恢复已完成消息和用户选择的模型。",
];
const fixtureAnswer = fixtureChunks.join("");

const fixtureUser = {
  id: "fixture-admin-user",
  username: "fixture_admin",
  displayName: "零费用浏览器验收管理员",
  role: "admin" as const,
  credits: 999999,
  cashBalance: 0,
};

const fixtureModels = [
  { id: "11111111-1111-4111-8111-111111111111", displayName: "Fixture Model A", variantLabel: "稳定", avatarUrl: "" },
  { id: selectedModelId, displayName: "Fixture Model B", variantLabel: "流式", avatarUrl: "" },
];

const fixtureAgent = {
  id: "fixture-llm-agent",
  bot_id: "fixture-llm-agent",
  bot_name: "零费用 LLM Fixture",
  name: "零费用 LLM Fixture",
  description: "仅供浏览器拦截验收",
  category: "通用",
  source: "llm",
  model: "fixture-model-a",
  is_active: true,
  user_access: "available",
  max_reply_tokens: 2048,
  timeout: 30,
};

type LlmRequestEvidence = {
  requestNo: number;
  idempotencyKey: string;
  bodyClientRequestId: string;
  modelId: string;
  modelOverridden: boolean;
  prompt: string;
  outcome: "network_abort" | "new_send_success" | "frozen_unknown";
};

type ResponseEvidence = {
  status: number;
  contentType: string;
  replayed: string;
};

type HistoryRequestEvidence = {
  method: string;
  conversationId: string;
  serverConversationAvailable: boolean;
};

function assertRefreshRestoreSourceContract(appContextSource: string) {
  assert.match(
    appContextSource,
    /const activeConversationIsServerPersisted = serverConvs\.some\([\s\S]*?if \(isLocalConvId\(savedActiveId\) && !activeConversationIsServerPersisted\)/u,
    "source must skip history only for client-only local_/conv_ conversations",
  );
  assert.match(
    appContextSource,
    /if \(state\.auth\.isAuthenticated && !initialLoadDone\.current\)[\s\S]*?void loadFromServer\(controller\.signal\)[\s\S]*?\}, \[state\.auth\.isAuthenticated\]\);/u,
    "history restore must remain gated to one authenticated lifecycle instead of reacting to conversation mutations",
  );
  assert.match(
    appContextSource,
    /fetchWithRetry\("\/api\/llm",[\s\S]*?\}, 0\);/u,
    "LLM transport failures must be surfaced for explicit user retry, never automatically re-sent",
  );

  const shouldSkipServerHistory = (conversationId: string, serverConversationIds: ReadonlySet<string>) => (
    /^(?:local_|conv_)/u.test(conversationId) && !serverConversationIds.has(conversationId)
  );
  assert.equal(shouldSkipServerHistory("local_persisted", new Set(["local_persisted"])), false);
  assert.equal(shouldSkipServerHistory("conv_persisted", new Set(["conv_persisted"])), false);
  assert.equal(shouldSkipServerHistory("local_browser_only", new Set()), true);
  assert.equal(shouldSkipServerHistory("server_uuid", new Set()), false);
}

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  };
}

function extractPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
  const last = [...messages].reverse().find((message) => message.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (!Array.isArray(last.content)) return "";
  return last.content
    .map((part) => typeof part === "object" && part && "text" in part ? String((part as { text?: unknown }).text || "") : "")
    .join("");
}

function fixtureSseBody(): string {
  return [
    ...fixtureChunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`),
    `data: ${JSON.stringify({ billing_complete: true, operation_id: "fixture:llm:response" })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

async function installZeroCostFixtures(page: Page, evidence: {
  llmRequests: LlmRequestEvidence[];
  historyRequests: HistoryRequestEvidence[];
  unexpectedApis: string[];
  externalRequests: string[];
}) {
  let persistedConversation: {
    id: string;
    agentId: string;
    createdAt: string;
    messages: Array<Record<string, unknown>>;
  } | null = null;

  await page.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseOrigin) {
      evidence.externalRequests.push(request.url());
      await route.abort("blockedbyclient");
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (url.pathname === "/api/auth/me") {
      await route.fulfill(jsonResponse({ user: fixtureUser }));
      return;
    }
    if (url.pathname === "/api/bots") {
      await route.fulfill(jsonResponse({
        agents: [fixtureAgent],
        navigationKeys: ["通用", "商业IP定位", "task:影像编导", "task:文案创作", "task:获客转化", "自用"],
      }));
      return;
    }
    if (url.pathname === "/api/member-permissions") {
      await route.fulfill(jsonResponse({ permission: {
        userId: fixtureUser.id,
        role: fixtureUser.role,
        featureNavigationKeys: ["marketplace", "toolbox", "storyboard_workbench", "image_workbench", "create", "voice", "cover", "youcai", "commerce_agent"],
        agentNavigationKeys: ["通用", "商业IP定位", "task:影像编导", "task:文案创作", "task:获客转化", "自用"],
        revision: 1,
        checksum: "fixture-llm-streaming",
        sourceProfileKey: null,
        sourceProfileVersion: null,
        updatedAt: new Date().toISOString(),
        updatedBy: fixtureUser.id,
        reason: "zero-cost-streaming-browser-fixture",
        integrityValid: true,
        authorityStatus: "admin",
      } }));
      return;
    }
    if (url.pathname === "/api/chat-models") {
      await route.fulfill(jsonResponse({ models: fixtureModels }));
      return;
    }
    if (url.pathname === "/api/conversations/history") {
      evidence.historyRequests.push({
        method: request.method(),
        conversationId: url.searchParams.get("id") || "",
        serverConversationAvailable: persistedConversation !== null,
      });
      if (request.method() !== "GET") {
        await route.fulfill(jsonResponse({ success: true }));
        return;
      }
      if (!persistedConversation) {
        await route.fulfill(jsonResponse({ conversations: [], messages: [] }));
        return;
      }
      if (url.searchParams.get("id")) {
        await route.fulfill(jsonResponse({
          conversation: {
            id: persistedConversation.id,
            agent_id: persistedConversation.agentId,
            title: "LLM UI fixture conversation",
            source: "llm",
            created_at: persistedConversation.createdAt,
            updated_at: persistedConversation.createdAt,
            messages: persistedConversation.messages,
          },
        }));
        return;
      }
      await route.fulfill(jsonResponse({ conversations: [{
        id: persistedConversation.id,
        agent_id: persistedConversation.agentId,
        title: "LLM UI fixture conversation",
        source: "llm",
        last_message: fixtureAnswer,
        created_at: persistedConversation.createdAt,
        updated_at: persistedConversation.createdAt,
      }] }));
      return;
    }
    if (url.pathname === "/api/credits") {
      await route.fulfill(jsonResponse({ credits: fixtureUser.credits, cash_balance: 0 }));
      return;
    }
    if (url.pathname === "/api/settings/ui-preferences") {
      await route.fulfill(jsonResponse({ preferences: {} }));
      return;
    }
    if (url.pathname === "/api/settings") {
      await route.fulfill(jsonResponse({ settings: {} }));
      return;
    }
    if (url.pathname === "/api/settings/appearance") {
      await route.fulfill(jsonResponse({
        settings: { theme: "soft-white", theme_mode: "light" },
        authority: { source: "safe_default", authoritative: false, publishedAt: null },
      }));
      return;
    }
    if (url.pathname === "/api/settings/layout") {
      await route.fulfill(jsonResponse({ layout: null }));
      return;
    }
    if (url.pathname === "/api/branding") {
      await route.fulfill(jsonResponse({ branding: {
        source: "legacy",
        generation: 0,
        revisionId: null,
        revisionVersion: null,
        publishedAt: null,
        brand: {
          schema: "platform-brand/v1",
          name: "自媒体操盘手",
          shortName: "操盘手",
          slogan: "AI 内容经营系统",
          welcomeMessage: "欢迎回到内容工作台",
          description: "零费用浏览器验收品牌夹具",
          seo: { title: "自媒体操盘手", description: "AI 内容经营系统" },
          colors: { primary: "#168D7A", accent: "#2F80FF" },
          assetIds: {},
        },
        assets: {},
      } }));
      return;
    }
    if (url.pathname === "/api/product-usage/events" && request.method() === "POST") {
      await route.fulfill(jsonResponse({ success: true, fixture: true }));
      return;
    }
    if (url.pathname === "/api/categories") {
      await route.fulfill(jsonResponse({ categories: [{ name: "通用" }] }));
      return;
    }
    if (url.pathname === "/api/agent-favorites" && request.method() === "GET") {
      await route.fulfill(jsonResponse({ favorites: [] }));
      return;
    }
    if (url.pathname === "/api/nav-items") {
      await route.fulfill(jsonResponse({ items: [] }));
      return;
    }
    if (url.pathname === "/api/shortcuts") {
      await route.fulfill(jsonResponse({ shortcuts: [] }));
      return;
    }
    if (url.pathname === "/api/version") {
      await route.fulfill(jsonResponse({ hash: "fixture-build", version: "fixture-build" }));
      return;
    }
    if (url.pathname === "/api/announcements") {
      await route.fulfill(jsonResponse({ announcements: [] }));
      return;
    }
    if (url.pathname === "/api/announcements/inbox" && request.method() === "GET") {
      await route.fulfill(jsonResponse({ announcements: [], items: [], unread: [] }));
      return;
    }
    if (url.pathname === "/api/notifications/user" && request.method() === "GET") {
      await route.fulfill(jsonResponse({ notifications: [], items: [], unreadCount: 0 }));
      return;
    }
    if (url.pathname === "/api/operation-events" && request.method() === "POST") {
      await route.fulfill(jsonResponse({ success: true, fixture: true }));
      return;
    }
    if (url.pathname === "/api/diagnostic-logs") {
      await route.fulfill(jsonResponse({ success: true }));
      return;
    }
    if (url.pathname === "/api/llm") {
      const body = JSON.parse(request.postData() || "{}") as Record<string, unknown>;
      const headers = await request.allHeaders();
      const prompt = extractPrompt(body);
      const common = {
        requestNo: evidence.llmRequests.length + 1,
        idempotencyKey: String(headers["idempotency-key"] || ""),
        bodyClientRequestId: String(body.client_request_id || ""),
        modelId: String(body.modelId || ""),
        modelOverridden: body.model_overridden === true,
        prompt,
      };

      if (prompt.includes("LLM_UI_FIXTURE_UNKNOWN")) {
        evidence.llmRequests.push({ ...common, outcome: "frozen_unknown" });
        await route.fulfill(jsonResponse({
          error: "该对话请求终态不明，禁止重复提交，必须先对账",
          code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED",
          retryable: false,
          retry_safe: false,
          attempt_id: "fixture-attempt-unknown",
        }, 503));
        return;
      }

      if (prompt.includes("LLM_UI_FIXTURE_NETWORK_UNKNOWN")) {
        evidence.llmRequests.push({ ...common, outcome: "network_abort" });
        await route.abort("failed");
        return;
      }

      evidence.llmRequests.push({ ...common, outcome: "new_send_success" });
      const createdAt = new Date().toISOString();
      persistedConversation = {
        id: String(body.conversationId || "fixture-conversation"),
        agentId: String(body.agentId || "__free_chat__"),
        createdAt,
        messages: [
          { id: "fixture-user-message", role: "user", content: successPrompt, created_at: createdAt },
          { id: "fixture-assistant-message", role: "assistant", content: fixtureAnswer, created_at: createdAt },
        ],
      };
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "X-LLM-Replayed": "false",
          "X-LLM-Attempt-Id": "fixture-attempt-success",
          "X-LLM-Result-Reference": "llm-result:fixture-attempt-success:1:fixture-hash",
        },
        body: fixtureSseBody(),
      });
      return;
    }

    evidence.unexpectedApis.push(`${request.method()} ${url.pathname}`);
    await route.fulfill(jsonResponse({ fixture: true }));
  });
}

async function waitForChat(page: Page) {
  await page.getByRole("button", { name: /新建对话/u }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByRole("button", { name: /新建对话/u }).click();
  await page.waitForFunction(() => localStorage.getItem("active_view") === "chat", null, { timeout: 10_000 });
  const textbox = page.locator("textarea:visible").last();
  await textbox.waitFor({ state: "visible", timeout: 15_000 });
  return textbox;
}

async function sampleTypewriter(page: Page, startedAt: number) {
  const assistant = page.locator(".chat-message-bubble-assistant").last();
  await assistant.waitFor({ state: "visible", timeout: 15_000 });
  const samples: Array<{ elapsedMs: number; length: number }> = [];
  let stableRounds = 0;
  let previousLength = -1;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    const visibleText = (await assistant.innerText()).trim();
    const length = visibleText.length;
    samples.push({ elapsedMs: Date.now() - startedAt, length });
    stableRounds = length > 0 && length === previousLength ? stableRounds + 1 : 0;
    previousLength = length;
    if (visibleText.includes("刷新页面后") && stableRounds >= 5) break;
  }
  return { assistant, samples };
}

async function closeBrowser(browser: Browser): Promise<boolean> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    browser.close().then(() => false),
    new Promise<boolean>((resolve) => {
      timeoutId = setTimeout(() => resolve(true), 5_000);
    }),
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return timedOut;
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const appContextSource = fs.readFileSync(appContextPath, "utf8");
  assertRefreshRestoreSourceContract(appContextSource);
  const workspaceBuildId = fs.readFileSync(path.resolve(".next", "BUILD_ID"), "utf8").trim();
  const standaloneBuildId = fs.readFileSync(standaloneBuildIdPath, "utf8").trim();
  assert.equal(workspaceBuildId, standaloneBuildId, "workspace and standalone BUILD_ID differ");
  const sourceModifiedAt = fs.statSync(appContextPath).mtime;
  const standaloneBuildModifiedAt = fs.statSync(standaloneBuildIdPath).mtime;

  const browser = await chromium.launch({ headless: true });
  let browserCloseTimedOut = false;
  const consoleErrors: string[] = [];
  const streamLogs: string[] = [];
  const llmResponses: ResponseEvidence[] = [];
  const failedResponses: Array<{ status: number; url: string }> = [];
  const requestFailures: Array<{ url: string; failure: string }> = [];
  const pageErrors: string[] = [];
  const llmRequests: LlmRequestEvidence[] = [];
  const historyRequests: HistoryRequestEvidence[] = [];
  const unexpectedApis: string[] = [];
  const externalRequests: string[] = [];
  let report: Record<string, unknown> | null = null;

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      baseURL: baseUrl,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addInitScript(({ user }) => {
      if (!localStorage.getItem("auth_token")) localStorage.setItem("auth_token", "fixture-token-no-network");
      if (!localStorage.getItem("auth_user")) localStorage.setItem("auth_user", JSON.stringify(user));
      if (!sessionStorage.getItem("entered_app")) sessionStorage.setItem("entered_app", "1");
      if (!localStorage.getItem("active_view")) localStorage.setItem("active_view", "marketplace");
      localStorage.setItem("debug_stream", "1");
    }, { user: fixtureUser });

    const page = await context.newPage();
    await installZeroCostFixtures(page, { llmRequests, historyRequests, unexpectedApis, externalRequests });
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" && !/favicon|ResizeObserver/iu.test(text)) consoleErrors.push(text.slice(0, 500));
      if (/stream-perf|sendLLMMessage|fetchWithRetry|FETCH RETURNED|SSE chunk/iu.test(text)) {
        streamLogs.push(`[${message.type()}] ${text.slice(0, 500)}`);
      }
    });
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() >= 400 && !/favicon/iu.test(url)) failedResponses.push({ status: response.status(), url });
      if (!url.includes("/api/llm")) return;
      llmResponses.push({
        status: response.status(),
        contentType: response.headers()["content-type"] || "",
        replayed: response.headers()["x-llm-replayed"] || "",
      });
    });
    page.on("requestfailed", (request) => {
      if (/favicon/iu.test(request.url())) return;
      requestFailures.push({ url: request.url(), failure: request.failure()?.errorText || "requestfailed" });
    });
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 500)));

    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const textbox = await waitForChat(page);
    assert.equal(await page.getByTitle("切换对话模型").count(), 0, "ordinary chat must not expose a model switcher");

    await textbox.fill(networkPrompt);
    await textbox.evaluate((element) => {
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
      element.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });

    const networkErrorStatus = page.getByTestId("chat-message-status").filter({ hasText: "结果待确认，请勿重复发送" }).last();
    await networkErrorStatus.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await networkErrorStatus.getAttribute("role"), "alert", "network failure must be announced as an alert");
    assert.equal(await networkErrorStatus.getAttribute("data-state"), "unknown");
    assert.equal(await networkErrorStatus.getByRole("button", { name: /重新发送|重新生成|继续回复/u }).count(), 0,
      "an ambiguous network outcome must not expose a duplicate-submit action");
    const refreshStatus = networkErrorStatus.getByRole("button", { name: "刷新状态" });
    await refreshStatus.waitFor({ state: "visible", timeout: 10_000 });
    const networkErrorMetrics = await networkErrorStatus.evaluate((node) => {
      const action = node.querySelector("button");
      if (!(action instanceof HTMLButtonElement)) throw new Error("NETWORK_REFRESH_ACTION_MISSING");
      const statusStyle = getComputedStyle(node);
      const buttonBox = action.getBoundingClientRect();
      return {
        fontSize: Number.parseFloat(statusStyle.fontSize),
        lineHeight: Number.parseFloat(statusStyle.lineHeight),
        statusHeight: node.getBoundingClientRect().height,
        actionWidth: buttonBox.width,
        actionHeight: buttonBox.height,
      };
    });
    assert.ok(networkErrorMetrics.statusHeight >= 40, `network error status is too small: ${JSON.stringify(networkErrorMetrics)}`);
    assert.ok(networkErrorMetrics.actionHeight >= 43.5, `network refresh target is too short: ${JSON.stringify(networkErrorMetrics)}`);
    assert.equal(llmRequests.length, 1, "network failure must not automatically re-send /api/llm");
    const networkUnknownScreenshot = path.join(outputDir, "00-network-outcome-unknown-no-resubmit.png");
    await page.screenshot({ path: networkUnknownScreenshot, fullPage: false });
    await page.evaluate(`(() => {
      const probe = {
        stop: false,
        frameCount: 0,
        maxFrameGapMs: 0,
        lastFrameAt: performance.now(),
        lengths: [],
        lastLength: -1,
        lengthDrops: 0,
        caretFrames: 0,
        caretIds: [],
        caretNodeReplacements: 0,
        lastCaret: null,
        railOpacities: [],
        contentOpacities: [],
      };
      window.__codexTypewriterProbe = probe;
      const capture = (now) => {
        probe.frameCount += 1;
        probe.maxFrameGapMs = Math.max(probe.maxFrameGapMs, now - probe.lastFrameAt);
        probe.lastFrameAt = now;
        const bubble = document.querySelector(".chat-message-bubble-assistant.chat-message-bubble-streaming");
        const layer = bubble?.querySelector(".render-layer-streaming-typewriter");
        if (bubble instanceof HTMLElement && layer instanceof HTMLElement) {
          const length = layer.innerText.length;
          if (probe.lastLength >= 0 && length < probe.lastLength) probe.lengthDrops += 1;
          if (length !== probe.lastLength) probe.lengths.push(length);
          probe.lastLength = length;
          const caret = layer.querySelector(".streaming-typewriter-caret");
          if (caret) {
            probe.caretFrames += 1;
            if (caret.id && !probe.caretIds.includes(caret.id)) probe.caretIds.push(caret.id);
            if (probe.lastCaret && probe.lastCaret !== caret) probe.caretNodeReplacements += 1;
            probe.lastCaret = caret;
          }
          const railOpacity = getComputedStyle(bubble, "::after").opacity;
          const contentOpacity = getComputedStyle(layer).opacity;
          if (!probe.railOpacities.includes(railOpacity)) probe.railOpacities.push(railOpacity);
          if (!probe.contentOpacities.includes(contentOpacity)) probe.contentOpacities.push(contentOpacity);
        }
        if (!probe.stop) requestAnimationFrame(capture);
      };
      requestAnimationFrame(capture);
    })()`);
    // The visible unknown-state notice is dispatched just before the per-conversation
    // send guard is released. Wait one short task boundary so the next, distinct
    // user message is not mistaken for a same-tick duplicate.
    await page.waitForTimeout(250);
    const sendStartedAt = Date.now();
    await textbox.fill(successPrompt);
    await textbox.press("Enter");

    const liveAssistant = page.locator(".chat-message-bubble-assistant").last();
    await liveAssistant.waitFor({ state: "visible", timeout: 10_000 });
    const liveOutputStatus = liveAssistant.getByTestId("chat-output-status");
    await liveOutputStatus.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await liveOutputStatus.getAttribute("data-state"), "streaming", "new assistant output must announce its streaming state");
    assert.match((await liveOutputStatus.innerText()).trim(), /正在生成/u, "streaming output status copy is missing");
    const inputResponsiveness = await textbox.evaluate(async (element) => {
      if (!(element instanceof HTMLTextAreaElement)) throw new Error("CHAT_COMPOSER_TEXTAREA_MISSING");
      element.focus();
      const startedAt = performance.now();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        focused: document.activeElement === element,
        disabled: element.disabled,
        frameLatencyMs: performance.now() - startedAt,
      };
    });
    assert.equal(inputResponsiveness.disabled, false, "composer became disabled while the typewriter was running");
    assert.equal(inputResponsiveness.focused, true, "composer could not receive focus while the typewriter was running");
    assert.ok(inputResponsiveness.frameLatencyMs < 160, `streaming blocked the next paint: ${JSON.stringify(inputResponsiveness)}`);
    const chatScroll = page.locator(".chat-scroll").last();
    await chatScroll.evaluate((element) => { element.scrollTop = 0; });
    const latestButton = page.getByTestId("chat-scroll-to-latest");
    await latestButton.waitFor({ state: "visible", timeout: 5_000 });
    const streamingIndicator = page.getByTestId("chat-streaming-latest-indicator");
    await streamingIndicator.waitFor({ state: "visible", timeout: 5_000 });
    const latestArrow = page.getByTestId("chat-latest-arrow");
    const restingLocatorState = await page.evaluate(() => {
      const dots = document.querySelector('[data-testid="chat-streaming-latest-indicator"]');
      const arrow = document.querySelector('[data-testid="chat-latest-arrow"]');
      if (!(dots instanceof HTMLElement) || !(arrow instanceof SVGElement)) throw new Error("LATEST_LOCATOR_PARTS_MISSING");
      return { dotsOpacity: Number(getComputedStyle(dots).opacity), arrowOpacity: Number(getComputedStyle(arrow).opacity) };
    });
    assert.ok(restingLocatorState.dotsOpacity >= 0.9, "streaming locator must expose its live-content badge");
    assert.ok(restingLocatorState.arrowOpacity >= 0.9, "streaming locator must keep the down arrow visible");
    const latestButtonBox = await latestButton.boundingBox();
    const dockBox = await page.locator(".chat-input-dock").boundingBox();
    const composerBox = await page.locator(".chat-composer-rail").boundingBox();
    assert.ok(latestButtonBox && dockBox && composerBox, "scroll-to-latest control and composer need measurable boxes");
    assert.ok(latestButtonBox.width >= 44 && latestButtonBox.height >= 44, `scroll-to-latest target is too small: ${JSON.stringify(latestButtonBox)}`);
    assert.ok(latestButtonBox.y + latestButtonBox.height <= dockBox.y + 1, "scroll-to-latest control is covered by the composer");
    assert.ok(
      Math.abs((latestButtonBox.x + latestButtonBox.width / 2) - (composerBox.x + composerBox.width / 2)) <= 1,
      "scroll-to-latest control is not centered over the composer",
    );
    const streamingLocatorScreenshot = path.join(outputDir, "00-streaming-scroll-locator.png");
    await page.screenshot({ path: streamingLocatorScreenshot, fullPage: false });
    await latestButton.hover();
    await page.waitForTimeout(220);
    const hoveredLocatorState = await page.evaluate(() => {
      const dots = document.querySelector('[data-testid="chat-streaming-latest-indicator"]');
      const arrow = document.querySelector('[data-testid="chat-latest-arrow"]');
      if (!(dots instanceof HTMLElement) || !(arrow instanceof SVGElement)) throw new Error("LATEST_LOCATOR_PARTS_MISSING");
      return { dotsOpacity: Number(getComputedStyle(dots).opacity), arrowOpacity: Number(getComputedStyle(arrow).opacity) };
    });
    assert.ok(hoveredLocatorState.dotsOpacity >= 0.9, "hover must preserve the live-content badge");
    assert.ok(hoveredLocatorState.arrowOpacity >= 0.9, "hover must reveal the down arrow");
    await latestArrow.waitFor({ state: "visible" });
    const streamingHoverScreenshot = path.join(outputDir, "00-streaming-scroll-locator-hover.png");
    await page.screenshot({ path: streamingHoverScreenshot, fullPage: false });
    await latestButton.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const element = document.querySelector(".chat-scroll");
      return element instanceof HTMLElement
        && element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
    }, null, { timeout: 2_000 });
    const distanceAfterLatestClick = await chatScroll.evaluate((element) => (
      element.scrollHeight - element.scrollTop - element.clientHeight
    ));
    assert.ok(distanceAfterLatestClick <= 80, `scroll-to-latest stopped ${distanceAfterLatestClick}px from the bottom`);

    const { assistant, samples } = await sampleTypewriter(page, sendStartedAt);
    const deliveredText = (await assistant.innerText()).trim();
    const increasingSteps = samples.filter((sample, index) => index > 0 && sample.length > samples[index - 1].length);
    const firstNonzero = samples.find((sample) => sample.length > 0) || null;
    const firstContent = samples.find((sample) => sample.length > 4) || null;
    const paintedLengths = [...new Set(streamLogs.flatMap((entry) => {
      const match = entry.match(/painted=(\d+)\//u);
      return match ? [Number(match[1])] : [];
    }))];
    const typewriterVisualProbe = await page.evaluate(() => {
      type TypewriterVisualProbe = {
        stop: boolean;
        frameCount: number;
        maxFrameGapMs: number;
        lengths: number[];
        lengthDrops: number;
        caretFrames: number;
        caretIds: string[];
        caretNodeReplacements: number;
        railOpacities: string[];
        contentOpacities: string[];
      };
      const probe = (globalThis as typeof globalThis & { __codexTypewriterProbe?: TypewriterVisualProbe }).__codexTypewriterProbe;
      if (!probe) throw new Error("TYPEWRITER_VISUAL_PROBE_MISSING");
      probe.stop = true;
      return {
        frameCount: probe.frameCount,
        maxFrameGapMs: probe.maxFrameGapMs,
        lengths: probe.lengths,
        lengthDrops: probe.lengthDrops,
        caretFrames: probe.caretFrames,
        caretIds: probe.caretIds,
        caretNodeReplacements: probe.caretNodeReplacements,
        railOpacities: probe.railOpacities,
        contentOpacities: probe.contentOpacities,
      };
    });
    for (const phrase of ["流式交付状态", "首批文字尽早显示", "流式增长", "streaming", "刷新页面后"]) {
      assert.match(deliveredText, new RegExp(phrase, "u"), `streamed assistant output lost semantic content: ${phrase}`);
    }
    assert.ok(firstNonzero, "assistant text never appeared");
    assert.ok(firstContent, "assistant content never replaced the loading placeholder");
    assert.ok(
      increasingSteps.length >= 2 || paintedLengths.length >= 3,
      `typewriter text did not visibly grow: samples=${JSON.stringify(samples)}, paints=${JSON.stringify(paintedLengths)}`,
    );
    assert.ok(typewriterVisualProbe.caretFrames >= 2, `premium caret was not continuously visible: ${JSON.stringify(typewriterVisualProbe)}`);
    assert.equal(typewriterVisualProbe.caretIds.length, 1, `streaming caret identity changed: ${JSON.stringify(typewriterVisualProbe.caretIds)}`);
    assert.equal(typewriterVisualProbe.caretNodeReplacements, 0, "morphing replaced the keyed caret and can cause flicker");
    assert.equal(typewriterVisualProbe.lengthDrops, 0, `streaming text flashed backwards: ${JSON.stringify(typewriterVisualProbe.lengths)}`);
    assert.ok(typewriterVisualProbe.railOpacities.length <= 1, `stream rail opacity flashed: ${JSON.stringify(typewriterVisualProbe.railOpacities)}`);
    assert.ok(typewriterVisualProbe.contentOpacities.length <= 1, `stream content opacity flashed: ${JSON.stringify(typewriterVisualProbe.contentOpacities)}`);
    assert.ok(typewriterVisualProbe.maxFrameGapMs < 240, `streaming produced a blocking frame gap: ${typewriterVisualProbe.maxFrameGapMs}ms`);
    const completedOutputStatus = assistant.getByTestId("chat-output-status");
    const completedOutputStatusHandle = await completedOutputStatus.elementHandle();
    assert.ok(completedOutputStatusHandle, "completed output status must remain mounted");
    await page.waitForFunction((node) => node.getAttribute("data-state") === "completed", completedOutputStatusHandle, { timeout: 5_000 });
    assert.match((await completedOutputStatus.innerText()).trim(), /已完成/u, "completed output status copy is missing");
    const assistantRow = assistant.locator("xpath=..");
    const actionLabels = await assistantRow.locator("button").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent || ""));
    assert.ok(actionLabels.some((label) => label.includes("复制 Markdown 源码")), `completed output lost its Markdown copy control: ${JSON.stringify(actionLabels)}`);
    const markdownCopy = assistantRow.locator('button[aria-label="复制 Markdown 源码"]');
    await markdownCopy.click();
    const markdownCopyHandle = await markdownCopy.elementHandle();
    assert.ok(markdownCopyHandle, "Markdown copy control must remain mounted after click");
    await page.waitForFunction((node) => node.getAttribute("aria-label") === "已复制 Markdown 源码", markdownCopyHandle, { timeout: 2_000 });

    const renderedMarkdown = {
      heading: assistant.locator(".markdown-body h2"),
      list: assistant.locator(".markdown-body ul"),
      table: assistant.locator(".markdown-body .table-wrapper table"),
      code: assistant.locator(".markdown-body .code-block-wrapper pre"),
    };
    for (const [kind, locator] of Object.entries(renderedMarkdown)) {
      await locator.waitFor({ state: "visible", timeout: 8_000 });
      assert.equal(await locator.count(), 1, `streamed Markdown ${kind} block count changed`);
    }
    const markdownComputedStyle = await assistant.locator(".markdown-body").evaluate((root) => {
      const heading = root.querySelector("h2");
      const paragraph = root.querySelector("p");
      const table = root.querySelector("table");
      const code = root.querySelector("pre");
      if (!heading || !paragraph || !table || !code) throw new Error("MARKDOWN_STRUCTURE_INCOMPLETE");
      return {
        bodyFontSize: Number.parseFloat(getComputedStyle(root).fontSize),
        bodyLineHeight: Number.parseFloat(getComputedStyle(root).lineHeight),
        headingFontSize: Number.parseFloat(getComputedStyle(heading).fontSize),
        headingWeight: Number.parseInt(getComputedStyle(heading).fontWeight, 10),
        tableOverflowContainer: getComputedStyle(table.parentElement || table).overflowX,
        codeWhiteSpace: getComputedStyle(code).whiteSpace,
      };
    });
    assert.ok(markdownComputedStyle.headingFontSize > markdownComputedStyle.bodyFontSize, "Markdown heading lacks a visible size hierarchy");
    assert.ok(markdownComputedStyle.headingWeight >= 600, "Markdown heading weight is too weak");
    assert.ok(markdownComputedStyle.bodyLineHeight > markdownComputedStyle.bodyFontSize, "Markdown prose line height is too tight");
    assert.match(markdownComputedStyle.tableOverflowContainer, /auto|scroll/u, "Markdown table lacks a safe horizontal overflow container");
    assert.match(markdownComputedStyle.codeWhiteSpace, /pre/u, "Markdown code block lost preformatted whitespace");

    assert.equal(llmRequests.length, 2, "the blocked unknown outcome plus one new user send are the only /api/llm requests");
    const [abortedAttempt, successfulAttempt] = llmRequests;
    assert.equal(abortedAttempt.outcome, "network_abort");
    assert.equal(successfulAttempt.outcome, "new_send_success");
    assert.match(abortedAttempt.idempotencyKey, /^llm_[0-9a-f-]{36}$/iu, "missing stable LLM request key");
    assert.notEqual(abortedAttempt.idempotencyKey, successfulAttempt.idempotencyKey, "a new user send must use a distinct stable request key");
    assert.equal(abortedAttempt.bodyClientRequestId, abortedAttempt.idempotencyKey, "header/body request IDs differ");
    assert.equal(successfulAttempt.bodyClientRequestId, successfulAttempt.idempotencyKey, "successful send header/body request IDs differ");
    assert.equal(llmResponses.filter((response) => response.status === 200).length, 1);
    assert.equal(llmResponses.find((response) => response.status === 200)?.replayed, "false", "successful response was unexpectedly marked as a replay");
    const userMessageCardCountBeforeRefresh = await page.locator(".chat-message-bubble-user").count();
    const assistantMessageCardCountBeforeRefresh = await page.locator(".chat-message-bubble-assistant").count();
    assert.equal(userMessageCardCountBeforeRefresh, 2, "double Enter duplicated either logical user message card");
    assert.equal(assistantMessageCardCountBeforeRefresh, 1, "the new successful send duplicated the assistant message card");

    const streamingScreenshot = path.join(outputDir, "01-streaming-new-send-success.png");
    await page.screenshot({ path: streamingScreenshot, fullPage: false });

    const identityBeforeRefresh = await page.evaluate(() => {
      const avatar = document.querySelector('[data-testid="chat-agent-avatar"]');
      return {
        name: document.querySelector('[data-testid="chat-agent-name"]')?.textContent?.trim() || "",
        avatarSrc: avatar?.querySelector("img")?.getAttribute("src") || "",
        avatarFallback: avatar?.textContent?.trim() || "",
        conversationId: localStorage.getItem("active_conversation_id") || "",
      };
    });
    assert.ok(identityBeforeRefresh.name, "chat identity was empty before refresh");
    assert.ok(identityBeforeRefresh.conversationId, "active conversation identity was empty before refresh");

    const llmCountBeforeRefresh = llmRequests.length;
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const restoredAssistant = page.locator(".chat-message-bubble-assistant").last();
    let refreshRestored = false;
    let refreshDiagnostic: Record<string, unknown> = {};
    try {
      await restoredAssistant.waitFor({ state: "visible", timeout: 8_000 });
      refreshRestored = (await restoredAssistant.innerText()).trim() === deliveredText;
    } catch (error) {
      const activeConversationId = await page.evaluate(() => localStorage.getItem("active_conversation_id"));
      const automaticMessageFetchesBeforeProbe = historyRequests.filter((request) => (
        request.method === "GET" && request.conversationId === activeConversationId
      )).length;
      const directHistoryProbe = await page.evaluate(async (conversationId) => {
        const response = await fetch(`/api/conversations/history?id=${encodeURIComponent(conversationId || "")}`);
        return { status: response.status, body: await response.json() };
      }, activeConversationId);
      refreshDiagnostic = {
        error: error instanceof Error ? error.message : String(error),
        activeConversationId,
        activeView: await page.evaluate(() => localStorage.getItem("active_view")),
        browserConversationCache: await page.evaluate(() => localStorage.getItem("conv_cache")),
        automaticMessageFetchesBeforeProbe,
        directHistoryProbe,
        bodyText: (await page.locator("body").innerText()).slice(0, 1600),
      };
    }
    assert.equal(llmRequests.length, llmCountBeforeRefresh, "refresh resubmitted /api/llm");
    const restoredConversationId = await page.evaluate(() => localStorage.getItem("active_conversation_id"));
    const automaticMessageFetchCount = historyRequests.filter((request) => (
      request.method === "GET" && request.conversationId === restoredConversationId
    )).length - (refreshRestored ? 0 : 1);
    const userMessageCardCountAfterRefresh = await page.locator(".chat-message-bubble-user").count();
    const assistantMessageCardCountAfterRefresh = await page.locator(".chat-message-bubble-assistant").count();
    assert.equal(userMessageCardCountAfterRefresh, 1, "refresh duplicated the persisted user message card");
    assert.equal(assistantMessageCardCountAfterRefresh, 1, "refresh duplicated the persisted assistant message card");
    const refreshScreenshot = path.join(outputDir, refreshRestored ? "02-refresh-restored.png" : "02-refresh-history-missing.png");
    await page.screenshot({ path: refreshScreenshot, fullPage: false });
    const identityAfterRefresh = await page.evaluate(() => {
      const avatar = document.querySelector('[data-testid="chat-agent-avatar"]');
      return {
        name: document.querySelector('[data-testid="chat-agent-name"]')?.textContent?.trim() || "",
        avatarSrc: avatar?.querySelector("img")?.getAttribute("src") || "",
        avatarFallback: avatar?.textContent?.trim() || "",
        conversationId: localStorage.getItem("active_conversation_id") || "",
      };
    });
    assert.deepEqual(identityAfterRefresh, identityBeforeRefresh, `refresh changed the selected agent identity: ${JSON.stringify({ identityBeforeRefresh, identityAfterRefresh })}`);

    const refreshedTextbox = page.locator("textarea:visible").last();
    await refreshedTextbox.fill(frozenPrompt);
    await page.keyboard.press("Enter");
    const unknownStatus = page.getByTestId("chat-message-status").filter({ hasText: "结果待确认，请勿重复发送" }).last();
    await unknownStatus.waitFor({ state: "visible", timeout: 12_000 });
    assert.equal(await unknownStatus.getAttribute("role"), "alert", "unknown outcome must be announced as an alert");
    assert.equal(await unknownStatus.getAttribute("data-state"), "unknown");
    assert.equal(await unknownStatus.getByRole("button", { name: /重新发送|重新生成|继续回复/u }).count(), 0, "unknown outcome must not expose a resubmit action");
    await unknownStatus.getByRole("button", { name: "刷新状态" }).waitFor({ state: "visible", timeout: 5_000 });
    const unknownMetrics = await unknownStatus.evaluate((node) => {
      const action = node.querySelector("button");
      if (!(action instanceof HTMLButtonElement)) throw new Error("UNKNOWN_REFRESH_ACTION_MISSING");
      const box = action.getBoundingClientRect();
      return { statusHeight: node.getBoundingClientRect().height, actionWidth: box.width, actionHeight: box.height };
    });
    assert.ok(unknownMetrics.statusHeight >= 40, `unknown status is too small: ${JSON.stringify(unknownMetrics)}`);
    assert.ok(unknownMetrics.actionHeight >= 40, `unknown refresh target is too short: ${JSON.stringify(unknownMetrics)}`);
    await page.waitForTimeout(600);
    assert.equal(llmRequests.length, 3, "HTTP 503 frozen attempt must not be automatically retried");
    const frozenAttempt = llmRequests[2];
    assert.equal(frozenAttempt.outcome, "frozen_unknown");
    assert.notEqual(frozenAttempt.idempotencyKey, successfulAttempt.idempotencyKey, "new logical send reused the previous request key");
    const errorScreenshot = path.join(outputDir, "03-frozen-unknown-error.png");
    await page.screenshot({ path: errorScreenshot, fullPage: false });

    const allowedConsoleErrors = /最终结果暂未确认|终态不明|LLM_ATTEMPT_RECONCILIATION_REQUIRED|发送消息失败|sendLLMMessage|net::ERR_FAILED|net::ERR_BLOCKED_BY_CLIENT|status of 503/iu;
    const unexpectedConsoleErrors = consoleErrors.filter((entry) => !allowedConsoleErrors.test(entry));
    assert.deepEqual(unexpectedConsoleErrors, [], `unexpected browser console errors: ${unexpectedConsoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);
    const unexpectedExternalRequests = externalRequests.filter((url) => !url.startsWith("https://fonts.googleapis.cn/"));
    assert.deepEqual(unexpectedExternalRequests, [], `unexpected external browser requests attempted: ${unexpectedExternalRequests.join(" | ")}`);
    assert.deepEqual(unexpectedApis, [], `unfixture API requests: ${unexpectedApis.join(" | ")}`);

    report = {
      ok: refreshRestored,
      baseUrl,
      buildId: standaloneBuildId,
      runtimeActivation: {
        sourceModifiedAt: sourceModifiedAt.toISOString(),
        standaloneBuildModifiedAt: standaloneBuildModifiedAt.toISOString(),
        sourceIsNewerThanStandaloneBuild: sourceModifiedAt.getTime() > standaloneBuildModifiedAt.getTime(),
      },
      networkPolicy: "same-origin static assets only; every /api/* fulfilled or aborted in Playwright",
      externalNetworkCompleted: 0,
      blockedExternalStaticRequests: externalRequests,
      paidProviderCalls: 0,
      databaseReads: 0,
      databaseWrites: 0,
      checks: {
        persistedLocalIdSourceGate: "PASS",
        browserOnlyLocalIdFallbackSourceGate: "PASS",
        restoreEffectSingleAuthLifecycleGate: "PASS",
        userModelSwitcherHidden: "PASS",
        networkFailureIsUnknownWithoutResubmit: "PASS",
        newUserSendUsesNewStableKey: "PASS",
        sameEventLoopDoubleEnterNoSecondLogicalSubmit: "PASS",
        sameEventLoopDoubleEnterNoDuplicateUiCards: "PASS",
        newUserSendSseSuccess: "PASS",
        typewriterVisibleGrowth: "PASS",
        typewriterPremiumCaretStable: "PASS",
        typewriterNoFlashNoBlocking: "PASS",
        refreshRestoresConversationWithoutResubmit: refreshRestored ? "PASS" : "FAIL",
        refreshRestoresWithoutDuplicateUiCards: "PASS",
        refreshRestoresAgentIdentity: "PASS",
        frozenUnknownShowsErrorWithoutRetry: "PASS",
      },
      refreshDiagnostic,
      identityRestore: { before: identityBeforeRefresh, after: identityAfterRefresh },
      errorStates: { network: networkErrorMetrics, unknown: unknownMetrics },
      historyRequests,
      automaticMessageFetchCount,
      uiCardCounts: {
        beforeRefresh: {
          user: userMessageCardCountBeforeRefresh,
          assistant: assistantMessageCardCountBeforeRefresh,
        },
        afterRefresh: {
          user: userMessageCardCountAfterRefresh,
          assistant: assistantMessageCardCountAfterRefresh,
        },
      },
      failureRootCause: refreshRestored
        ? null
        : "the running standalone browser bundle predates the source fix and still skips GET history messages for persisted conv_/local_ IDs",
      streaming: {
        firstNonzeroMs: firstNonzero?.elapsedMs ?? null,
        firstContentMs: firstContent?.elapsedMs ?? null,
        finalMs: samples[samples.length - 1]?.elapsedMs ?? null,
        finalLength: deliveredText.length,
        increasingSteps: increasingSteps.length,
        paintedLengths,
        sampleCount: samples.length,
        samples,
        inputResponsiveness,
        visualProbe: typewriterVisualProbe,
      },
      chatScrollLocator: {
        streamingIndicatorVisible: true,
        restingLocatorState,
        hoveredLocatorState,
        buttonAboveComposer: true,
        distanceAfterLatestClick,
        screenshots: [streamingLocatorScreenshot, streamingHoverScreenshot],
      },
      markdownComputedStyle,
      llmRequests,
      llmResponses,
      failedResponses,
      requestFailures,
      consoleErrors,
      streamLogs: streamLogs.slice(-30),
      screenshots: [networkUnknownScreenshot, streamingLocatorScreenshot, streamingHoverScreenshot, streamingScreenshot, refreshScreenshot, errorScreenshot],
    };
  } finally {
    browserCloseTimedOut = await closeBrowser(browser);
  }

  assert.ok(report, "browser test did not produce a report");
  report.browserCloseTimedOut = browserCloseTimedOut;
  fs.writeFileSync(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ...report, evidenceDir: outputDir }, null, 2)}\n`);
  assert.equal(report.ok, true, `LLM browser E2E failed; evidence: ${path.join(outputDir, "report.json")}`);
}

void main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  },
);
