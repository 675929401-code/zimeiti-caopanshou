#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const stepUpToken = String(process.env.LOCAL_ADMIN_STEP_UP_TOKEN || "").trim();
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence/lconai-workbook-onboarding-20261005/admin-model-persistence-browser", runId);
const headers = {
  Authorization: `Bearer ${token}`,
  "x-admin-step-up": stepUpToken,
  "Content-Type": "application/json",
};
const targetAgentId = "agent-1786633444187-594spj";
const targetModelName = "claude-opus-5-5";

assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
assert.ok(token && stepUpToken && identity?.user?.id, "LOCAL_ADMIN_STEP_UP_BROWSER_CONTEXT_REQUIRED");

async function api(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname}:HTTP_${response.status}:${body.code || "UNKNOWN"}:${body.error || "unknown"}`);
  return body;
}

async function readAgent() {
  const body = await api("/api/admin/agents?include_configuration=1");
  return body.agents?.find((entry) => String(entry.id) === targetAgentId) || null;
}

async function readModels() {
  const body = await api("/api/admin/models");
  return Array.isArray(body.models) ? body.models : [];
}

async function publishOrder(modelType, orders) {
  const staged = await api("/api/admin/models", {
    method: "PATCH",
    body: JSON.stringify({ model_type: modelType, orders }),
  });
  const releaseId = String(staged.result?.release?.id || "");
  assert.ok(releaseId, "MODEL_ORDER_RELEASE_ID_REQUIRED");
  await api("/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  });
  const preview = await api(`/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, "MODEL_ORDER_PREVIEW_SHA_REQUIRED");
  await api("/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
}

async function pageState(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const bodyText = String(document.body?.innerText || "").replace(/\s+/gu, " ").trim();
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflowPx: Math.max(0, root.scrollWidth - root.clientWidth),
      textLength: bodyText.length,
      sample: bodyText.slice(0, 240),
      replacementCharacters: (bodyText.match(/\uFFFD/gu) || []).length,
    };
  });
}

async function openAdmin(page, tab) {
  const response = await page.goto(`${origin}/admin?tab=${tab}&view=overview`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200, `${tab}:PAGE_HTTP_200_REQUIRED`);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  const state = await pageState(page);
  assert.equal(state.viewport.width, 1440, `${tab}:DESKTOP_WIDTH_REQUIRED`);
  assert.equal(state.viewport.height, 900, `${tab}:DESKTOP_HEIGHT_REQUIRED`);
  assert.ok(state.textLength > 100, `${tab}:VISIBLE_CONTENT_REQUIRED`);
  assert.equal(state.horizontalOverflowPx, 0, `${tab}:HORIZONTAL_OVERFLOW`);
  assert.equal(state.replacementCharacters, 0, `${tab}:REPLACEMENT_CHARACTER_FORBIDDEN`);
  return state;
}

async function editAgentBinding(page, agentName, modelId) {
  await openAdmin(page, "agents");
  const row = page.locator("tr").filter({ hasText: agentName }).first();
  await row.waitFor({ state: "visible", timeout: 20_000 });
  await row.getByRole("button", { name: "编辑", exact: true }).click();
  const selector = page.locator('[data-testid="admin-agent-model-select"]');
  await selector.waitFor({ state: "visible", timeout: 20_000 });
  await selector.selectOption(modelId);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByText("智能体更新成功", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await selector.waitFor({ state: "hidden", timeout: 20_000 });
}

await fs.mkdir(evidenceDir, { recursive: true });
const originalAgent = await readAgent();
assert.ok(originalAgent?.model_id, "BOUND_AGENT_REQUIRED");
const initialModels = await readModels();
const targetModel = initialModels.find((entry) => entry.model_type === "text" && entry.model_name === targetModelName);
assert.ok(targetModel?.id, "TARGET_TEXT_MODEL_REQUIRED");
assert.notEqual(String(originalAgent.model_id), String(targetModel.id), "ALTERNATE_MODEL_REQUIRED");
const originalTextModels = initialModels
  .filter((entry) => entry.model_type === "text")
  .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || String(left.id).localeCompare(String(right.id)));
assert.ok(originalTextModels.length >= 2, "TWO_TEXT_MODELS_REQUIRED");
const originalOrderIds = originalTextModels.map((entry) => String(entry.id));
const originalOrders = originalTextModels.map((entry, index) => ({ id: String(entry.id), sort_order: Number(entry.sort_order ?? ((index + 1) * 10)) }));
const originalFirst = originalTextModels[0];
const targetFirst = originalTextModels[1];

const report = {
  schemaVersion: 1,
  passed: false,
  checkedAt: "",
  origin,
  viewport: { width: 1440, height: 900 },
  runtime: await api("/api/version"),
  agent: {
    id: originalAgent.id,
    name: originalAgent.name,
    originalModelId: originalAgent.model_id,
    targetModelId: targetModel.id,
    targetModelName,
    changedReadback: null,
    restoredReadback: null,
  },
  order: {
    modelType: "text",
    originalFirstId: originalFirst.id,
    targetFirstId: targetFirst.id,
    changedFirstId: null,
    refreshedFirstId: null,
    restoredFirstId: null,
  },
  pages: [],
  pageErrors: [],
  consoleErrors: [],
  failedResponses: [],
  dialogs: [],
  screenshots: [],
  cleanup: { agentRestored: false, orderRestored: false },
};

let browser;
let agentChanged = false;
let orderChanged = false;
const responseBodyReads = [];
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: report.viewport,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    serviceWorkers: "block",
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      "x-admin-step-up": stepUpToken,
    },
  });
  await context.addInitScript(({ sessionToken, user }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    try {
      const url = new URL(request.url());
      if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
        await route.abort("blockedbyclient");
        return;
      }
    } catch { /* Non-HTTP browser resources are allowed. */ }
    await route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => report.pageErrors.push(String(error?.message || error).slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_BLOCKED_BY_CLIENT")) report.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on("dialog", (dialog) => {
    report.dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 1000) });
    void dialog.accept();
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      const entry = { status: response.status(), method: response.request().method(), path: new URL(response.url()).pathname, code: "", error: "" };
      report.failedResponses.push(entry);
      responseBodyReads.push(response.json().then((body) => {
        entry.code = String(body?.code || "").slice(0, 160);
        entry.error = String(body?.error || "").slice(0, 1000);
      }).catch(() => undefined));
    }
  });

  await editAgentBinding(page, originalAgent.name, String(targetModel.id));
  agentChanged = true;
  const changedAgent = await readAgent();
  report.agent.changedReadback = { model_id: changedAgent?.model_id, model: changedAgent?.model };
  assert.equal(String(changedAgent?.model_id), String(targetModel.id), "AGENT_MODEL_CHANGE_READBACK_FAILED");
  const agentScreenshot = path.join(evidenceDir, "agents-model-changed.png");
  await openAdmin(page, "agents");
  await page.screenshot({ path: agentScreenshot, fullPage: true });
  report.screenshots.push(path.relative(process.cwd(), agentScreenshot));

  await editAgentBinding(page, originalAgent.name, String(originalAgent.model_id));
  const restoredAgent = await readAgent();
  report.agent.restoredReadback = { model_id: restoredAgent?.model_id, model: restoredAgent?.model };
  assert.equal(String(restoredAgent?.model_id), String(originalAgent.model_id), "AGENT_MODEL_RESTORE_READBACK_FAILED");
  agentChanged = false;
  report.cleanup.agentRestored = true;

  report.pages.push(await openAdmin(page, "models"));
  await page.getByRole("button", { name: /对话模型/u }).click();
  const targetCard = page.locator(`[data-model-id="${targetFirst.id}"]`);
  await targetCard.waitFor({ state: "visible" });
  await targetCard.locator('button[title^="置顶"]').click();
  await page.getByText(/排序已修改，尚未保存/u).waitFor({ state: "visible" });
  const dirtyScreenshot = path.join(evidenceDir, "models-order-dirty.png");
  await page.screenshot({ path: dirtyScreenshot, fullPage: true });
  report.screenshots.push(path.relative(process.cwd(), dirtyScreenshot));
  await page.locator('[data-testid="save-model-order"]').click();
  orderChanged = true;
  await page.getByText("排序已发布，刷新页面仍会保持", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const changedModels = await readModels();
  report.order.changedFirstId = changedModels.filter((entry) => entry.model_type === "text")
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || String(left.id).localeCompare(String(right.id)))[0]?.id || null;
  assert.equal(String(report.order.changedFirstId), String(targetFirst.id), "MODEL_ORDER_PUBLISH_READBACK_FAILED");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /对话模型/u }).click();
  report.order.refreshedFirstId = await page.locator("[data-model-card]").first().getAttribute("data-model-id");
  assert.equal(String(report.order.refreshedFirstId), String(targetFirst.id), "MODEL_ORDER_REFRESH_PERSISTENCE_FAILED");
  const persistedScreenshot = path.join(evidenceDir, "models-order-after-refresh.png");
  await page.screenshot({ path: persistedScreenshot, fullPage: true });
  report.screenshots.push(path.relative(process.cwd(), persistedScreenshot));

  const originalCard = page.locator(`[data-model-id="${originalFirst.id}"]`);
  await originalCard.locator('button[title^="置顶"]').click();
  await page.locator('[data-testid="save-model-order"]').click();
  await page.getByText("排序已发布，刷新页面仍会保持", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /对话模型/u }).click();
  report.order.restoredFirstId = await page.locator("[data-model-card]").first().getAttribute("data-model-id");
  const restoredModels = await readModels();
  const restoredOrderIds = restoredModels.filter((entry) => entry.model_type === "text")
    .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || String(left.id).localeCompare(String(right.id)))
    .map((entry) => String(entry.id));
  assert.deepEqual(restoredOrderIds, originalOrderIds, "MODEL_ORDER_RESTORE_FAILED");
  orderChanged = false;
  report.cleanup.orderRestored = true;

  report.pages.push(await openAdmin(page, "connection"));
  report.pages.push(await openAdmin(page, "workspace-models"));
  for (const tab of ["connection", "workspace-models"]) {
    const screenshot = path.join(evidenceDir, `${tab}-regression.png`);
    await openAdmin(page, tab);
    await page.screenshot({ path: screenshot, fullPage: true });
    report.screenshots.push(path.relative(process.cwd(), screenshot));
  }

  assert.equal(report.pageErrors.length, 0, "BROWSER_PAGE_ERRORS_FORBIDDEN");
  await Promise.allSettled(responseBodyReads);
  assert.equal(report.failedResponses.length, 0, "FAILED_SAME_ORIGIN_RESPONSES_FORBIDDEN");
  report.passed = true;
} finally {
  if (agentChanged) {
    await api("/api/admin/agents", {
      method: "PUT",
      body: JSON.stringify({ agentId: originalAgent.id, model_id: originalAgent.model_id }),
    }).catch(() => undefined);
    report.cleanup.agentRestored = String((await readAgent().catch(() => null))?.model_id || "") === String(originalAgent.model_id);
  }
  if (orderChanged) {
    await publishOrder("text", originalOrders).catch(() => undefined);
    const cleanupModels = await readModels().catch(() => []);
    const cleanupIds = cleanupModels.filter((entry) => entry.model_type === "text")
      .sort((left, right) => Number(left.sort_order || 0) - Number(right.sort_order || 0) || String(left.id).localeCompare(String(right.id)))
      .map((entry) => String(entry.id));
    report.cleanup.orderRestored = JSON.stringify(cleanupIds) === JSON.stringify(originalOrderIds);
  }
  await browser?.close().catch(() => undefined);
  await Promise.allSettled(responseBodyReads);
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

assert.equal(report.cleanup.agentRestored, true, "AGENT_CLEANUP_REQUIRED");
assert.equal(report.cleanup.orderRestored, true, "ORDER_CLEANUP_REQUIRED");
assert.equal(report.passed, true, "BROWSER_ACCEPTANCE_NOT_PASSED");
console.log(JSON.stringify(report, null, 2));
