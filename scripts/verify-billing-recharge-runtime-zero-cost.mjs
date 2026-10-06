#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const ORIGIN = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const TOKEN = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const parsedOrigin = new URL(ORIGIN);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002", "http://127.0.0.1:5010"].includes(ORIGIN), "LOCAL_ZERO_COST_ORIGIN_REQUIRED");
assert.ok(TOKEN, "LOCAL_ADMIN_TOKEN_REQUIRED: run through scripts/with-local-admin-session.mjs");

async function getJson(pathname, { auth = false } = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    headers: {
      "User-Agent": BROWSER_UA,
      ...(auth ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, 200, `${pathname} returned HTTP ${response.status}`);
  return payload;
}

function assertPublicModelCatalog(payload, label, { allowUnavailable = false } = {}) {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  assert.ok(models.length > 0, `${label} catalog is empty`);
  const selectable = models.filter((model) => model?.capabilities?.available === true);
  assert.ok(selectable.length > 0, `${label} catalog has no selectable model`);
  for (const model of selectable) {
    assert.equal(model.capabilities?.priceReady, true, `${label} selectable model is not price ready`);
    assert.ok(Number.isFinite(Number(model.publicPrice)) && Number(model.publicPrice) >= 0, `${label} public price is invalid`);
  }
  const serialized = JSON.stringify(payload);
  for (const forbidden of ["api_key", "api_endpoint", "credential_ref", "proxy_url"]) {
    assert.equal(serialized.includes(forbidden), false, `${label} catalog leaked ${forbidden}`);
  }
  if (!allowUnavailable) assert.equal(selectable.length, models.length, `${label} unexpectedly returned unavailable models`);
  return { total: models.length, selectable: selectable.length };
}

const [identity, appearancePayload, methodsPayload, rulesPayload, chatPayload, imagePayload, videoPayload, voicePayload] = await Promise.all([
  getJson("/api/auth/me", { auth: true }),
  getJson("/api/settings/appearance"),
  getJson("/api/payment/methods"),
  getJson("/api/credits/rules"),
  getJson("/api/chat-models"),
  getJson("/api/cover-models?surface=image-workbench"),
  getJson("/api/video/models?surface=video-page"),
  getJson("/api/voice/pricing"),
]);

const user = identity?.user;
assert.ok(user?.id && user?.role === "admin", "local administrator identity is required");
assert.equal(appearancePayload?.settings?.theme, "soft-white", "authoritative platform theme is not soft-white");
assert.equal(appearancePayload?.settings?.theme_mode, "light", "authoritative platform mode is not light");
assert.equal(appearancePayload?.authority?.authoritative, true, "platform appearance is not authoritative");
const methods = Array.isArray(methodsPayload?.methods) ? methodsPayload.methods : [];
assert.ok(methods.length > 0, "no active payment method is configured");
for (const method of methods) {
  assert.ok(method?.is_active !== false && String(method?.code || "").trim(), "payment method is not active or has no code");
  assert.ok(["xunhupay", "epay"].includes(String(method?.provider || "").toLowerCase()), "payment method provider is unsupported");
}
const creditsPerYuan = Number(rulesPayload?.creditsPerYuan ?? rulesPayload?.rules?.creditsPerYuan);
assert.ok(Number.isFinite(creditsPerYuan) && creditsPerYuan > 0, "credit exchange rate is invalid");
const catalogSummary = {
  text: assertPublicModelCatalog(chatPayload, "text"),
  image: assertPublicModelCatalog(imagePayload, "image", { allowUnavailable: true }),
  video: assertPublicModelCatalog(videoPayload, "video", { allowUnavailable: true }),
};
const voicePrices = Array.isArray(voicePayload?.data) ? voicePayload.data : [];
assert.ok(voicePrices.length > 0, "voice pricing catalog is empty");
assert.ok(voicePrices.every((item) => String(item?.modelId || "").trim() && Number(item?.sellPrice) >= 0), "voice pricing contains an invalid row");

async function edgeRequest(pathname, init = {}) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    ...init,
    headers: { "User-Agent": BROWSER_UA, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

const boundary = {};
boundary.anonymousStatus = (await edgeRequest("/api/payment/status?order=PAY_ZERO_COST_UNKNOWN")).status;
assert.equal(boundary.anonymousStatus, 401, "anonymous payment status read must be rejected before lookup");
boundary.authenticatedMissingOrder = (await edgeRequest("/api/payment/status", {
  headers: { Authorization: `Bearer ${TOKEN}` },
})).status;
assert.equal(boundary.authenticatedMissingOrder, 400, "missing order must be rejected before database/provider work");
const activeMethod = methods[0];
boundary.invalidRecharge = (await edgeRequest("/api/payment/create", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/recharge`,
    "Sec-Fetch-Site": "same-origin",
  },
  body: JSON.stringify({ type: "cash", amount: 9, paymentMethod: activeMethod.code, provider: activeMethod.provider }),
})).status;
assert.equal(boundary.invalidRecharge, 400, "below-minimum recharge must fail before method/provider/database work");

const browser = await chromium.launch({ headless: true });
const evidenceDirectory = path.resolve(".codex-evidence", "billing-recharge-runtime-zero-cost-20260929");
await fs.mkdir(evidenceDirectory, { recursive: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
const audit = {
  createRequests: [],
  statusOrders: [],
  telemetryRequests: [],
  unexpectedMutations: [],
  externalRequests: [],
  commerceOrManjuRequests: [],
  authMeReads: 0,
  pageErrors: [],
  consoleErrors: [],
};
let paymentStatusMode = "pending";

await context.addInitScript(({ token, authUser }) => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem("auth_token", token);
  localStorage.setItem("auth_user", JSON.stringify(authUser));
  sessionStorage.setItem("entered_app", "1");
}, {
  token: TOKEN,
  authUser: {
    id: String(user.id),
    username: String(user.username || "local-admin"),
    displayName: String(user.displayName || user.display_name || user.username || "本地管理员"),
    role: "admin",
    credits: Number(user.credits || 0),
  },
});

await context.route("**/*", async (route) => {
  const request = route.request();
  const method = request.method().toUpperCase();
  let url;
  try {
    url = new URL(request.url());
  } catch {
    audit.externalRequests.push({ method, url: request.url(), reason: "invalid-url" });
    await route.abort("blockedbyclient");
    return;
  }
  if (["data:", "blob:"].includes(url.protocol)) {
    await route.continue();
    return;
  }
  if (url.origin !== parsedOrigin.origin) {
    audit.externalRequests.push({ method, host: url.hostname, path: url.pathname });
    await route.abort("blockedbyclient");
    return;
  }
  if (/^\/(?:api\/)?(?:commerce|youcai|manju)(?:\/|$)/iu.test(url.pathname)) {
    audit.commerceOrManjuRequests.push({ method, path: url.pathname });
    await route.abort("blockedbyclient");
    return;
  }
  if (url.pathname === "/api/auth/me" && method === "GET") {
    audit.authMeReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...identity,
        user: {
          ...user,
          themePreference: null,
          theme_preference: null,
          themeModePreference: null,
          theme_mode_preference: null,
          themePreferenceExpiresAt: null,
          themePreferenceStatus: "none",
        },
      }),
    });
    return;
  }
  if (url.pathname === "/api/announcements/inbox") {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ announcements: [], unreadCount: 0 }) });
    return;
  }
  if (url.pathname === "/api/payment/create" && method === "POST") {
    const body = request.postDataJSON();
    audit.createRequests.push(body);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        tradeOrderId: "PAY_ZERO_COST_FIXTURE",
        paymentUrl: "https://pay.example.invalid/zero-cost-fixture",
        qrcodeUrl: "",
        provider: body.provider,
        creditsAmount: body.type === "credits" ? Number(body.amount) * creditsPerYuan : null,
      }),
    });
    return;
  }
  if (url.pathname === "/api/payment/status" && method === "GET") {
    const order = String(url.searchParams.get("order") || "");
    audit.statusOrders.push(order);
    const reconciliation = paymentStatusMode === "reconciliation";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        success: true,
        order: {
          trade_order_id: order,
          status: reconciliation ? "reconciliation_required" : "pending",
          recorded_status: reconciliation ? "paid" : "pending",
          settlement_status: reconciliation ? "reconciliation_required" : "awaiting_payment",
          balance_credited: false,
          amount: 10,
          type: "cash",
        },
      }),
    });
    return;
  }
  if (["/api/product-usage/events", "/api/operation-events"].includes(url.pathname) && method === "POST") {
    const rawBody = request.postData() || "";
    audit.telemetryRequests.push({
      path: url.pathname,
      containsToken: rawBody.includes(TOKEN),
      containsProviderUrl: rawBody.includes("pay.example.invalid"),
    });
    await route.fulfill({
      status: url.pathname === "/api/product-usage/events" ? 202 : 201,
      contentType: "application/json",
      body: JSON.stringify(url.pathname === "/api/product-usage/events"
        ? { ok: true, code: "PRODUCT_USAGE_ACCEPTED", receivedCount: 1 }
        : { accepted: true, duplicate: false }),
    });
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    audit.unexpectedMutations.push({ method, path: url.pathname });
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "ZERO_COST_VERIFIER_BLOCKED_MUTATION" }) });
    return;
  }
  await route.continue();
});

const page = await context.newPage();
page.on("pageerror", (error) => audit.pageErrors.push({ name: error.name, message: error.message }));
page.on("console", (message) => {
  if (message.type() === "error") audit.consoleErrors.push(message.text());
});

const ui = {};
try {
  const authenticatedAppearanceReady = page.waitForResponse((candidate) => {
    try {
      return new URL(candidate.url()).pathname === "/api/auth/me" && candidate.status() === 200;
    } catch {
      return false;
    }
  }, { timeout: 20_000 });
  const response = await page.goto(`${ORIGIN}/recharge`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  assert.equal(response?.status(), 200, "recharge page did not load");
  await page.getByRole("heading", { name: "沿用主站真实支付与积分链路", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await authenticatedAppearanceReady;
  await page.waitForTimeout(100);
  ui.theme = await page.evaluate(() => {
    const root = document.documentElement;
    const bodyStyle = getComputedStyle(document.body);
    return {
      selection: root.getAttribute("data-theme-selection"),
      theme: root.getAttribute("data-theme"),
      mode: root.getAttribute("data-mode"),
      bodyBackground: bodyStyle.backgroundColor,
      colorScheme: bodyStyle.colorScheme,
    };
  });
  assert.deepEqual(ui.theme, {
    selection: "soft-white",
    theme: "soft-white",
    mode: "light",
    bodyBackground: "rgb(243, 244, 239)",
    colorScheme: "light",
  }, "authenticated recharge page did not apply the authoritative soft-white theme");
  const launch = page.getByRole("button", { name: /进入充值|打开支付组件/u }).first();
  await launch.waitFor({ state: "visible", timeout: 20_000 });
  await launch.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "充值中心", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await dialog.getByText(`100元 = ${(100 * creditsPerYuan).toLocaleString("zh-CN")}积分`, { exact: false }).waitFor({ state: "visible" });
  assert.equal(audit.createRequests.length, 0, "opening the recharge dialog created an order");

  const amountInput = dialog.getByPlaceholder("输入金额（元）");
  await amountInput.fill("99");
  await dialog.getByText("最低100元起充", { exact: true }).last().waitFor({ state: "visible" });
  assert.equal(await dialog.getByRole("button", { name: /立即充值|选择充值金额/u }).isDisabled(), true, "below-minimum credits must disable checkout");
  await dialog.getByRole("button", { name: /¥100 →/u }).click();
  await dialog.getByRole("button", { name: "立即充值 ¥100.00", exact: true }).waitFor({ state: "visible" });

  await dialog.getByRole("button", { name: "现金充值", exact: true }).click();
  await amountInput.fill("9");
  await dialog.getByText("最低10元起充", { exact: true }).last().waitFor({ state: "visible" });
  assert.equal(await dialog.getByRole("button", { name: /立即充值|选择充值金额/u }).isDisabled(), true, "below-minimum cash must disable checkout");
  await dialog.getByRole("button", { name: "¥10", exact: true }).click();
  const submit = dialog.getByRole("button", { name: "立即充值 ¥10.00", exact: true });
  await submit.waitFor({ state: "visible" });
  await submit.evaluate((button) => { button.click(); button.click(); });

  await dialog.getByText("¥10.00", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await dialog.getByText("等待支付确认中...", { exact: true }).waitFor({ state: "visible" });
  ui.dialogTheme = await dialog.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      backgroundColor: style.backgroundColor,
      colorScheme: style.colorScheme,
      backgroundToken: style.getPropertyValue("--background").trim(),
      foregroundToken: style.getPropertyValue("--foreground").trim(),
      className: node.className,
      parentClassName: node.parentElement?.className || "",
      parentTheme: node.parentElement?.getAttribute("data-theme"),
    };
  });
  assert.equal(ui.dialogTheme.backgroundToken, "#f3f4ef", `recharge dialog inherited a non-soft-white background token: ${JSON.stringify(ui.dialogTheme)}`);
  assert.equal(ui.dialogTheme.foregroundToken, "#17201d", `recharge dialog inherited a non-soft-white foreground token: ${JSON.stringify(ui.dialogTheme)}`);
  assert.equal(ui.dialogTheme.colorScheme, "light", "recharge dialog did not use a light color scheme");
  ui.screenshot = path.join(evidenceDirectory, "recharge-softwhite-1440x900.png");
  await page.screenshot({ path: ui.screenshot, fullPage: false });
  assert.equal(audit.createRequests.length, 1, "same-frame double click created more than one order");
  assert.deepEqual(audit.createRequests[0], {
    type: "cash",
    amount: 10,
    paymentMethodId: String(activeMethod.id),
    paymentMethod: String(activeMethod.code),
    provider: String(activeMethod.provider),
  }, "checkout payload differs from selected live method and amount");

  await page.waitForTimeout(2_250);
  assert.ok(audit.statusOrders.length >= 1, "QR view did not poll the current order");
  assert.ok(audit.statusOrders.every((order) => order === "PAY_ZERO_COST_FIXTURE"), "status polling changed order identity");
  const beforeManual = audit.statusOrders.length;
  paymentStatusMode = "reconciliation";
  await dialog.getByRole("button", { name: "刷新支付结果", exact: true }).click();
  await page.waitForFunction((count) => window.__never__ || count < 0, beforeManual, { timeout: 100 }).catch(() => undefined);
  await page.waitForTimeout(250);
  assert.ok(audit.statusOrders.length > beforeManual, "manual refresh did not query the same order");
  assert.ok(audit.statusOrders.every((order) => order === "PAY_ZERO_COST_FIXTURE"), "manual refresh queried a different order");
  await dialog.getByText("支付记录已收到，但到账证据仍在核对，请勿重复支付", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await dialog.getByText("余额已自动到账，即将返回主页面...", { exact: true }).count(), 0, "reconciliation was incorrectly treated as paid");
  ui.reconciliationScreenshot = path.join(evidenceDirectory, "recharge-reconciliation-1440x900.png");
  await page.screenshot({ path: ui.reconciliationScreenshot, fullPage: false });
  ui.rechargeViewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(ui.rechargeViewport.scrollWidth <= ui.rechargeViewport.innerWidth + 1, "recharge page overflows horizontally at 1440px");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });

  const paymentResultResponse = await page.goto(`${ORIGIN}/payment/result?order=PAY_ZERO_COST_FIXTURE`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  assert.equal(paymentResultResponse?.status(), 200, "payment result page did not load");
  await page.getByRole("heading", { name: "到账核对中", exact: true }).waitFor({ state: "visible", timeout: 20_000 });
  await page.getByText("请勿重复支付，管理员会按供应商回执与钱包账本核对", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.getByRole("heading", { name: "充值成功", exact: true }).count(), 0, "payment result displayed false success");
  assert.equal(await page.getByText("余额已自动到账", { exact: true }).count(), 0, "payment result displayed false credit");
  ui.paymentResultViewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(ui.paymentResultViewport.scrollWidth <= ui.paymentResultViewport.innerWidth + 1, "payment result page overflows horizontally at 1440px");
  ui.paymentResultScreenshot = path.join(evidenceDirectory, "payment-result-reconciliation-1440x900.png");
  await page.screenshot({ path: ui.paymentResultScreenshot, fullPage: false });

  ui.neighborRoutes = [];
  for (const pathname of ["/profile", "/"]) {
    const neighborResponse = await page.goto(`${ORIGIN}${pathname}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    assert.equal(neighborResponse?.status(), 200, `${pathname} neighbor page did not load`);
    await page.waitForTimeout(250);
    const layout = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    assert.ok(layout.scrollWidth <= layout.innerWidth + 1, `${pathname} neighbor page overflows horizontally`);
    ui.neighborRoutes.push({ pathname, status: neighborResponse?.status(), layout });
  }

  const viewport = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  assert.ok(viewport.scrollWidth <= viewport.innerWidth + 1, "final neighbor page overflows horizontally at 1440px");
  ui.viewport = viewport;
  ui.checkoutPayload = audit.createRequests[0];
  ui.pollCount = audit.statusOrders.length;
} finally {
  await context.close();
  await browser.close();
}

assert.deepEqual(audit.unexpectedMutations, [], "recharge UI attempted an unexpected mutation");
assert.ok(audit.telemetryRequests.every((request) => !request.containsToken && !request.containsProviderUrl), "recharge telemetry leaked a token or provider URL");
const allowedStaticExternalHosts = new Set([
  "ai-agent-main-storage-1434868362.cos.ap-guangzhou.myqcloud.com",
  "coze-coding-project.tos.coze.site",
  "fonts.googleapis.cn",
]);
assert.equal(
  audit.externalRequests.every((request) => request.method === "GET" && allowedStaticExternalHosts.has(request.host)),
  true,
  "recharge UI attempted a non-static external request",
);
assert.deepEqual(audit.commerceOrManjuRequests, [], "excluded product family was requested");
assert.deepEqual(audit.pageErrors, [], "recharge page raised a JavaScript error");
const unexpectedConsoleErrors = audit.consoleErrors.filter((message) => !message.includes("ERR_BLOCKED_BY_CLIENT.Inspector"));
assert.deepEqual(unexpectedConsoleErrors, [], "recharge page logged an unexpected console error");

const report = {
  verifier: "billing-recharge-runtime-zero-cost",
  localOnly: true,
  origin: ORIGIN,
  actor: { role: "admin" },
  platformAppearance: {
    theme: appearancePayload.settings.theme,
    mode: appearancePayload.settings.theme_mode,
    authoritative: appearancePayload.authority.authoritative,
    publishedAt: appearancePayload.authority.publishedAt || null,
    authenticatedFixturePreference: "none_inherits_platform",
    authMeReads: audit.authMeReads,
  },
  paymentConfiguration: { activeMethods: methods.length, creditsPerYuan },
  catalogs: { ...catalogSummary, voice: { priced: voicePrices.length } },
  boundary,
  ui,
  guarantees: {
    realPaymentOrdersCreated: 0,
    realPaymentStatusLookups: 0,
    providerCalls: 0,
    walletWrites: 0,
    databaseWrites: 0,
    commerceRequests: 0,
    manjuOrYoucaiRequests: 0,
    falsePaidSuccessDisplays: 0,
  },
};

await fs.writeFile(path.join(evidenceDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
