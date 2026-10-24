/**
 * 管理员对话模型热切换 · 真实浏览器验收（1440×900）
 *
 * 运行：
 * node ./scripts/with-local-admin-session.mjs scripts/verify-chat-model-switcher-live.mjs
 *
 * - 使用真实 127.0.0.1:5000 构建与真实侧边栏/聊天组件；
 * - /api/llm 写请求被拦截并回放最小 SSE 夹具，不调用上游、不扣费、不写库；
 * - 只读校验下拉分组、按会话记忆、发送 payload 与相邻页面回归。
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const EVIDENCE_DIR = path.join(process.cwd(), ".codex-evidence", "chat-model-switcher-20261022");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveScreenshot(page, name) {
  const target = path.join(EVIDENCE_DIR, name);
  await page.screenshot({ path: target, fullPage: false });
  return target;
}

async function readModelLabel(page) {
  return page.$eval('[data-testid="chat-model-label"]', (element) => String(element.textContent || "").trim());
}

async function ensureModelMenuOpen(page) {
  const alreadyOpen = await page.evaluate(() => {
    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    return Boolean(content && content.getAttribute("data-state") !== "closed");
  });
  if (alreadyOpen) return;
  await page.click('[data-testid="chat-model-trigger"]');
  await page.waitForSelector('[data-slot="dropdown-menu-content"]', { visible: true, timeout: 10_000 });
  // 等待 Radix 淡入动画结束，避免截图出现半透明叠层。
  await sleep(250);
}

async function openModelMenu(page) {
  await ensureModelMenuOpen(page);
}

async function snapshotModelMenu(page) {
  return page.evaluate(() => {
    const content = document.querySelector('[data-slot="dropdown-menu-content"]');
    if (!content) return { labels: [], items: [] };
    return {
      labels: [...content.querySelectorAll('[data-slot="dropdown-menu-label"]')]
        .map((element) => String(element.textContent || "").trim()),
      items: [...content.querySelectorAll('[data-slot="dropdown-menu-item"]')]
        .map((element) => ({
          id: element.getAttribute("data-model-id") || "",
          label: String(element.textContent || "").trim(),
          active: element.getAttribute("data-active") === "true",
        })),
    };
  });
}

async function chooseModel(page, label) {
  await openModelMenu(page);
  const snapshot = await snapshotModelMenu(page);
  const item = snapshot.items.find((entry) => entry.label === label);
  assert.ok(item, `下拉列表缺少模型「${label}」：${snapshot.items.map((entry) => entry.label).join(" / ")}`);
  await page.click(`[data-slot="dropdown-menu-item"][data-model-id="${item.id}"]`);
  await page.waitForFunction(
    (expected) => String(document.querySelector('[data-testid="chat-model-label"]')?.textContent || "").trim() === expected,
    { timeout: 10_000 },
    label,
  );
  return item;
}

async function waitForStableNewChat(page) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const present = await page.evaluate(() => Boolean(document.querySelector("button.new-chat-btn")));
    if (present) {
      // 侧边栏会先渲染占位壳层再渲染真实入口，必须确认按钮在重渲染后仍然存在。
      await sleep(1_200);
      const stable = await page.evaluate(() => Boolean(document.querySelector("button.new-chat-btn")));
      if (stable) return;
    } else {
      await sleep(250);
    }
  }
  throw new Error("新建对话按钮未稳定出现");
}

async function startNewChat(page) {
  await waitForStableNewChat(page);
  await dismissOverlays(page);
  await page.click("button.new-chat-btn");
  await page.waitForSelector('[data-testid="chat-model-trigger"]', { timeout: 30_000 });
  await sleep(350);
  const conversationId = await page.evaluate(() => localStorage.getItem("active_conversation_id"));
  assert.ok(conversationId, "新建对话后 active_conversation_id 必须可读取");
  return conversationId;
}

async function dismissOverlays(page) {
  const closeSelectors = [
    '[data-testid="announcement-close"]',
    '[aria-label="关闭系统公告"]',
  ];
  for (const selector of closeSelectors) {
    const element = await page.$(selector);
    if (!element) continue;
    await element.click().catch(() => undefined);
    await sleep(150);
  }
}

async function selectConversation(page, conversationId) {
  const selector = `[data-testid="sidebar-history-avatar-${conversationId}"]`;
  await page.waitForSelector(selector, { timeout: 10_000 });
  await page.click(selector);
  await sleep(350);
}

async function sendWithFixture(page, text, expectedRequestCount, llmRequests) {
  const textarea = await page.waitForSelector('textarea[aria-label^="向 "]', { timeout: 10_000 });
  const replyMarker = "模型切换验收占位回复";
  const repliesBefore = await page.evaluate(
    (marker) => String(document.body.textContent || "").split(marker).length - 1,
    replyMarker,
  );
  await textarea.click();
  await page.type('textarea[aria-label^="向 "]', text);
  await page.keyboard.press("Enter");
  const deadline = Date.now() + 20_000;
  while (llmRequests.length < expectedRequestCount && Date.now() < deadline) {
    await sleep(100);
  }
  assert.equal(llmRequests.length, expectedRequestCount, "发送后必须命中 /api/llm");
  await page.waitForFunction(
    (input) => String(document.body.textContent || "").split(input.marker).length - 1 > input.before,
    { timeout: 20_000 },
    { marker: replyMarker, before: repliesBefore },
  );
  await page.waitForFunction(
    () => !document.querySelector(".chat-canvas")?.classList.contains("chat-streaming"),
    { timeout: 20_000 },
  );
  await sleep(500);
}

function buildFixtureStream() {
  return [
    `data: ${JSON.stringify({
      id: "fixture-chat-model-switcher",
      model: "fixture",
      choices: [{ index: 0, delta: { role: "assistant", content: "模型切换验收占位回复。" } }],
    })}`,
    "",
    `data: ${JSON.stringify({
      id: "fixture-chat-model-switcher",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

/**
 * 零成本服务端合同：管理员携带 pm_ 标识 + model_overridden 时，
 * 必须先通过管理员覆盖门禁，再进入模型能力门禁；两种路径都不调用上游。
 */
async function verifyAdminOverrideContract() {
  const catalogResponse = await fetch(`${ORIGIN}/api/chat-models`, { cache: "no-store" });
  assert.equal(catalogResponse.status, 200, "公开模型目录必须可读");
  const catalog = await catalogResponse.json();
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  const nonVision = models.find((model) => model?.capabilities?.imageParsing === false);
  const requestId = `llm_contract_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const messages = nonVision
    ? [{
      role: "user",
      content: [
        { type: "text", text: "模型切换合同验证，不调用上游" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==",
          },
        },
      ],
    }]
    : [{ role: "user", content: "模型切换合同验证，不调用上游" }];
  const response = await fetch(`${ORIGIN}/api/llm`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      "Idempotency-Key": requestId,
    },
    body: JSON.stringify({
      client_request_id: requestId,
      messages,
      modelId: nonVision ? nonVision.id : "pm_contract_probe_unavailable",
      model_overridden: true,
      stream: true,
      agentId: "__free_chat__",
      maxReplyTokens: 1,
      timeout: 5,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  const expectedCode = nonVision ? "MODEL_IMAGE_INPUT_UNSUPPORTED" : "MODEL_NOT_AVAILABLE";
  assert.equal(response.status === 422 || response.status === 404, true, `覆盖门禁探针返回了意外状态：HTTP ${response.status}`);
  assert.equal(payload.code, expectedCode, `管理员 pm_ 覆盖未按预期进入零成本门禁：${JSON.stringify(payload)}`);
  return {
    status: response.status,
    code: payload.code,
    modelId: nonVision ? nonVision.id : null,
    modelLabel: nonVision ? nonVision.displayName : null,
  };
}

async function waitForFeaturePage(page) {
  await page.waitForFunction(() => {
    const text = String(document.body.textContent || "");
    return !text.includes("正在核对会员功能权限")
      && !text.includes("此功能尚未开通")
      && text.trim().length > 120;
  }, { timeout: 30_000 });
  await sleep(1_200);
}

async function readHeaderMetrics(page) {
  return page.evaluate(() => {
    const trigger = document.querySelector('[data-testid="chat-model-trigger"]');
    const header = trigger?.closest(".chat-stage-header");
    const credits = [...document.querySelectorAll("div")].find((element) => {
      const text = String(element.textContent || "").trim();
      return /^[\d.,]+\s*积分$/u.test(text) && element.children.length <= 2;
    });
    const rect = trigger?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const creditsRect = credits?.getBoundingClientRect();
    const style = trigger ? getComputedStyle(trigger) : null;
    return {
      trigger: rect ? {
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      } : null,
      headerHeight: headerRect ? Math.round(headerRect.height) : null,
      creditsLeft: creditsRect ? Math.round(creditsRect.left) : null,
      fontSize: style?.fontSize || null,
      color: style?.color || null,
      borderColor: style?.borderColor || null,
      overflowRight: rect && headerRect ? Math.round((rect.right - (headerRect.right - 12)) * 10) / 10 : null,
    };
  });
}

export async function main() {
  assert.ok(TOKEN, "需要以 scripts/with-local-admin-session.mjs 启动，提供管理员会话");
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const serverContract = await verifyAdminOverrideContract();

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"],
  });
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));

  const llmRequests = [];
  let interceptionReady = false;

  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.evaluate((token) => {
      localStorage.clear();
      localStorage.setItem("auth_token", token);
      localStorage.setItem("active_view", "chat");
      localStorage.setItem("sidebar_collapsed", "false");
      // 入口守卫使用 sessionStorage；刷新保留，关闭标签页清除。
      sessionStorage.setItem("entered_app", "1");
    }, TOKEN);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });

    await page.waitForSelector("button.new-chat-btn", { timeout: 60_000 });
    await waitForStableNewChat(page);
    const initialView = await page.evaluate(() => document.querySelector('[data-testid="chat-model-trigger"]') !== null);

    // 第一次新建对话：确认默认模型与下拉分组
    const conversationA = await startNewChat(page);
    const defaultLabel = await readModelLabel(page);
    assert.match(defaultLabel, /^(?:GPT|Claude)/u, `默认模型标签异常：${defaultLabel}`);
    assert.equal(defaultLabel, "GPT-5.6-Terra", "自由对话默认应展示 GPT-5.6-Terra");
    await saveScreenshot(page, "01-new-chat-default-model.png");

    await openModelMenu(page);
    const menu = await snapshotModelMenu(page);
    assert.deepEqual(menu.labels.slice(0, 2), ["本对话模型 · 仅管理员可切换", "GPT 系列"], "下拉应包含标题与 GPT 分组");
    assert.ok(menu.labels.includes("Claude 系列"), "下拉应包含 Claude 分组");
    assert.ok(menu.items.length >= 6, `可切换模型过少：${menu.items.length}`);
    const activeItem = menu.items.find((item) => item.active);
    assert.equal(activeItem?.label, "GPT-5.6-Terra", "默认模型在列表中应标记为选中且与头部一致");
    assert.ok(menu.items.some((item) => item.label.startsWith("Claude ")), "下拉应包含 Claude 模型");
    await saveScreenshot(page, "02-model-menu-open.png");

    const claudeItem = await chooseModel(page, "Claude Opus 5.5");
    await sleep(250);
    const storedForA = await page.evaluate((conversationId) => ({
      perConversation: localStorage.getItem(`model_override_${conversationId}`),
      lastUsed: localStorage.getItem("last_used_model"),
    }), conversationA);
    assert.equal(storedForA.perConversation, claudeItem.id, "按会话记忆必须写入当前对话键");
    assert.equal(storedForA.lastUsed, claudeItem.id, "最近使用模型必须写入 last_used_model");
    await saveScreenshot(page, "03-claude-selected.png");

    // 拦截 /api/llm：回放最小 SSE 夹具，验证真实发送 payload，不调用上游、不扣费。
    await page.setRequestInterception(true);
    interceptionReady = true;
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/llm") && request.method() === "POST") {
        let body = {};
        try {
          body = JSON.parse(request.postData() || "{}");
        } catch {
          body = {};
        }
        llmRequests.push({
          modelId: typeof body.modelId === "string" ? body.modelId : null,
          modelOverridden: body.model_overridden === true,
          conversationId: typeof body.conversationId === "string" ? body.conversationId : null,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
        });
        void request.respond({
          status: 200,
          headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store" },
          body: buildFixtureStream(),
        });
        return;
      }
      void request.continue();
    });

    // 会话 A 的第一条消息使用 Claude
    await sendWithFixture(page, "第一次：Claude 验收", 1, llmRequests);
    assert.equal(llmRequests.length, 1, "第一次发送必须命中 /api/llm");
    assert.equal(llmRequests[0].modelId, claudeItem.id, "第一次发送应携带 Claude 的 pm_ 标识");
    assert.equal(llmRequests[0].modelOverridden, true, "管理员显式选择必须携带 model_overridden");
    assert.equal(llmRequests[0].conversationId, conversationA, "第一次发送应属于会话 A");

    // 第二次新建对话：继承最近使用，再切回 GPT
    const conversationB = await startNewChat(page);
    assert.equal(await readModelLabel(page), "Claude Opus 5.5", "新对话应继承最近使用的模型");
    const gptItem = await chooseModel(page, "GPT-5.6-Terra");
    await sendWithFixture(page, "第二次：GPT 验收", 2, llmRequests);
    assert.equal(llmRequests.length, 2, "第二次发送必须命中 /api/llm");
    assert.equal(llmRequests[1].modelId, gptItem.id, "第二次发送应携带 GPT 的 pm_ 标识");
    assert.equal(llmRequests[1].modelOverridden, true, "GPT 显式选择必须携带 model_overridden");
    assert.equal(llmRequests[1].conversationId, conversationB, "第二次发送应属于会话 B");

    // 两条对话都已产生助手回复，侧边栏可见；切回 A 应恢复 Claude，回到 B 应显示 GPT
    await selectConversation(page, conversationA);
    assert.equal(await readModelLabel(page), "Claude Opus 5.5", "切回旧会话应恢复该会话的模型");
    await selectConversation(page, conversationB);
    assert.equal(await readModelLabel(page), "GPT-5.6-Terra", "切回另一个会话应恢复它自己的模型");

    // 同一会话内热切换：下一条消息立即使用 Claude
    await chooseModel(page, "Claude Opus 5.5");
    await sendWithFixture(page, "第三次：Claude 热切换验收", 3, llmRequests);
    assert.equal(llmRequests.length, 3, "第三次发送必须命中 /api/llm");
    assert.equal(llmRequests[2].modelId, claudeItem.id, "热切换后下一条消息应携带 Claude 的 pm_ 标识");
    assert.equal(llmRequests[2].modelOverridden, true, "热切换同样需要 model_overridden");
    assert.equal(llmRequests[2].conversationId, conversationB, "热切换必须发生在同一对话内");
    // 等切换提示消失后再留证，避免 toast 遮住头部模型徽标。
    await sleep(4_500);
    await saveScreenshot(page, "04-hot-switch-replies.png");

    const metrics = await readHeaderMetrics(page);
    assert.ok(metrics.trigger, "验收时模型切换器必须存在");
    assert.ok(metrics.trigger.height >= 20 && metrics.trigger.height <= 30, `切换器高度异常：${metrics.trigger.height}`);
    assert.ok(metrics.headerHeight && metrics.headerHeight <= 64, `头部高度异常：${metrics.headerHeight}`);
    if (metrics.creditsLeft) {
      assert.ok(metrics.trigger.right < metrics.creditsLeft, "模型切换器不得与右侧积分区重叠");
    }

    // 相邻页面回归：封面导演台 + 工具中心
    await page.goto(`${ORIGIN}/cover`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForFeaturePage(page);
    const coverShot = await saveScreenshot(page, "05-regression-cover.png");

    await page.goto(`${ORIGIN}/tools`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForFeaturePage(page);
    const toolsShot = await saveScreenshot(page, "06-regression-tools.png");

    const report = {
      ok: true,
      origin: ORIGIN,
      viewport: VIEWPORT,
      serverContract,
      initialChatTriggerPresent: initialView,
      conversationA,
      conversationB,
      defaultLabel,
      menuLabels: menu.labels,
      menuItems: menu.items,
      selected: { gpt: gptItem, claude: claudeItem },
      storedForA,
      llmRequests,
      metrics,
      screenshots: [coverShot, toolsShot],
      consoleErrors,
      pageErrors,
    };
    await fs.writeFile(path.join(EVIDENCE_DIR, "report.json"), JSON.stringify(report, null, 2), "utf8");
    assert.deepEqual(pageErrors, [], `页面脚本错误：${pageErrors.join(" | ")}`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (interceptionReady) {
      try {
        await page.setRequestInterception(false);
      } catch {
        // ignore
      }
    }
    await browser.close();
  }
}
