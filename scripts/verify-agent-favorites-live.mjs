#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
const outputRoot = path.resolve(process.env.AGENT_FAVORITES_EVIDENCE_DIR || ".codex-evidence/agent-favorites-additive-20261006/browser");
const requestedRunId = process.env.AGENT_FAVORITES_EVIDENCE_RUN_ID?.trim();
const runId = requestedRunId || `${new Date().toISOString().replace(/[:.]/gu, "-")}-${process.pid}-${randomBytes(4).toString("hex")}`;
assert.match(runId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, "INVALID_EVIDENCE_RUN_ID");
const output = path.join(outputRoot, runId);
await fs.mkdir(outputRoot, { recursive: true });
try { await fs.mkdir(output); } catch (error) {
  if (error?.code === "EEXIST") throw new Error(`EVIDENCE_RUN_DIRECTORY_EXISTS:${output}`);
  throw error;
}
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const paidPattern = /\/api\/(?:chat|llm|image\/generate|video\/generate)(?:\?|$)/u;

async function jsonApi(pathname, init = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const identityResult = await jsonApi("/api/auth/me");
assert.equal(identityResult.response.ok, true, "LOCAL_IDENTITY_REQUIRED");
const beforeResult = await jsonApi("/api/agent-favorites");
assert.equal(beforeResult.response.ok, true, "FAVORITES_READ_REQUIRED");
const botsResult = await jsonApi("/api/bots?shape=agents");
assert.equal(botsResult.response.ok, true, "AGENT_CATALOG_REQUIRED");
const beforeIds = new Set((beforeResult.body.favorites || []).map((item) => String(item.agent_id)));
const agentsById = new Map((botsResult.body.agents || []).map((agent) => [String(agent.id || ""), agent]));

const report = {
  checkedAt: new Date().toISOString(),
  runId,
  outputRoot,
  evidenceDirectory: output,
  candidate: null,
  initialFavoriteCount: beforeIds.size,
  categoryInvariant: null,
  pages: [],
  writes: [],
  paidRequests: [],
  serverErrors: [],
  pageErrors: [],
  consoleErrors: [],
  interceptedOptionalTelemetry: [],
  restoration: null,
};

function attachDiagnostics(page, viewport) {
  page.on("pageerror", (error) => report.pageErrors.push({ viewport, message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push({ viewport, message: message.text() });
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (paidPattern.test(url.pathname)) report.paidRequests.push({ viewport, path: url.pathname });
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      report.writes.push({ viewport, method: request.method(), path: url.pathname });
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      report.serverErrors.push({ viewport, status: response.status(), path: new URL(response.url()).pathname });
    }
  });
}

async function createContext(browser, viewport, theme) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ sessionToken, user, themeId }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    localStorage.setItem("active_view", "marketplace");
    localStorage.setItem("user_theme_preference", themeId);
    sessionStorage.setItem("entered_app", "1");
  }, { sessionToken: token, user: identityResult.body.user, themeId: theme });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.route("**/api/auth/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ user: { ...identityResult.body.user, themePreference: theme, theme_preference: theme } }),
  }));
  await context.route("**/api/product-usage/events", (route) => {
    report.interceptedOptionalTelemetry.push({
      viewport: `${viewport.width}x${viewport.height}`,
      method: route.request().method(),
      path: new URL(route.request().url()).pathname,
      reason: "local product-usage policy is not configured and is outside this favorite-state acceptance scope",
    });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: false, reason: "acceptance_scope_excluded" }),
    });
  });
  await context.route("**/api/diagnostic-logs", (route) => {
    report.interceptedOptionalTelemetry.push({
      viewport: `${viewport.width}x${viewport.height}`,
      method: route.request().method(),
      path: new URL(route.request().url()).pathname,
      reason: "diagnostic telemetry is outside favorite-state acceptance and must not persist test-only observations",
    });
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: false, reason: "acceptance_scope_excluded" }),
    });
  });
  return context;
}

async function dismissAnnouncement(page) {
  const close = page.getByRole("button", { name: "关闭", exact: true });
  try {
    await close.last().waitFor({ state: "visible", timeout: 3_500 });
  } catch {}
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await close.count() && await close.last().isVisible()) {
      await close.last().click();
      await page.waitForTimeout(350);
    }
  }
  assert.equal(await close.count() > 0 && await close.last().isVisible(), false, "ANNOUNCEMENT_OVERLAY_STILL_VISIBLE");
  await page.waitForTimeout(800);
}

async function openMarketplace(page) {
  const response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200);
  await page.locator(".marketplace-category-bar").waitFor({ state: "visible", timeout: 30_000 });
  await dismissAnnouncement(page);
  await page.locator('[data-agent-category="favorites"]').waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("[data-agent-card-id]").first().waitFor({ state: "visible", timeout: 30_000 });
}

async function visibleCardIds(page) {
  return page.locator("[data-agent-card-id]").evaluateAll((cards) =>
    cards
      .filter((card) => {
        const rect = card.getBoundingClientRect();
        const style = window.getComputedStyle(card);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((card) => card.getAttribute("data-agent-card-id") || "")
      .filter(Boolean),
  );
}

async function favoriteCount(page) {
  const label = await page.locator('[data-agent-category="favorites"] [aria-label^="已收藏 "]').getAttribute("aria-label");
  const match = String(label || "").match(/已收藏\s+(\d+)\s+个智能体/u);
  assert.ok(match, `FAVORITE_COUNT_LABEL_MISSING:${label}`);
  return Number(match[1]);
}

async function waitForPressed(page, agentId, pressed) {
  await page.waitForFunction(({ id, expected }) => {
    const button = document.querySelector(`[data-agent-favorite-toggle="${id}"]`);
    return button?.getAttribute("aria-pressed") === expected;
  }, { id: agentId, expected: String(pressed) }, { timeout: 15_000 });
}

let candidateId = "";
let candidateCategory = "";
const browser = await chromium.launch({ headless: true });
try {
  const desktopContext = await createContext(browser, { width: 1600, height: 1000 }, "soft-white");
  const desktop = await desktopContext.newPage();
  attachDiagnostics(desktop, "desktop-1600x1000");
  await openMarketplace(desktop);

  const cards = desktop.locator("[data-agent-card-id]");
  const cardCount = await cards.count();
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    const id = String(await card.getAttribute("data-agent-card-id") || "");
    const category = String(await card.getAttribute("data-agent-display-category") || "");
    if (!id || !category || beforeIds.has(id)) continue;
    if (await desktop.locator(`[data-agent-category="${category}"]`).count() === 0) continue;
    candidateId = id;
    candidateCategory = category;
    break;
  }
  assert.ok(candidateId && candidateCategory, "UNFAVORITED_AGENT_WITH_VISIBLE_CATEGORY_REQUIRED");
  const candidate = agentsById.get(candidateId) || {};
  report.candidate = { id: candidateId, name: candidate.name || candidateId, category: candidateCategory };

  const favoriteTab = desktop.locator('[data-agent-category="favorites"]');
  assert.match((await favoriteTab.innerText()).replace(/\s+/gu, ""), /^我的收藏\d*$/u);
  assert.equal(await favoriteCount(desktop), beforeIds.size, "INITIAL_FAVORITE_COUNT_MISMATCH");

  const originalCategoryTab = desktop.locator(`[data-agent-category="${candidateCategory}"]`);
  await originalCategoryTab.click();
  const originalCard = desktop.locator(`[data-agent-card-id="${candidateId}"]`);
  await originalCard.waitFor({ state: "visible", timeout: 15_000 });
  const categoryIdsBefore = await visibleCardIds(desktop);
  const toggle = originalCard.locator(`[data-agent-favorite-toggle="${candidateId}"]`);
  const toggleBox = await toggle.boundingBox();
  assert.ok(toggleBox && toggleBox.width >= 30 && toggleBox.height >= 30, "FAVORITE_TARGET_TOO_SMALL");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await desktop.screenshot({ path: path.join(output, "original-category-before.png"), fullPage: false });

  const postWait = desktop.waitForResponse((response) => response.url().includes("/api/agent-favorites") && response.request().method() === "POST");
  await toggle.click();
  assert.equal((await postWait).ok(), true, "FAVORITE_POST_FAILED");
  await waitForPressed(desktop, candidateId, true);
  await originalCard.waitFor({ state: "visible", timeout: 15_000 });
  const categoryIdsAfterFavorite = await visibleCardIds(desktop);
  assert.deepEqual(categoryIdsAfterFavorite, categoryIdsBefore, "ORIGINAL_CATEGORY_CHANGED_AFTER_FAVORITE");
  assert.equal(await favoriteCount(desktop), beforeIds.size + 1, "FAVORITE_COUNT_DID_NOT_INCREMENT");
  await desktop.screenshot({ path: path.join(output, "original-category-after-favorite.png"), fullPage: false });

  await favoriteTab.click();
  const favoriteCard = desktop.locator(`[data-agent-card-id="${candidateId}"]`);
  await favoriteCard.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await favoriteCard.locator(`[data-agent-favorite-toggle="${candidateId}"]`).getAttribute("aria-pressed"), "true");
  await desktop.screenshot({ path: path.join(output, "my-favorites-with-candidate.png"), fullPage: false });

  await originalCategoryTab.click();
  await originalCard.waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await visibleCardIds(desktop), categoryIdsBefore, "ORIGINAL_CATEGORY_CHANGED_AFTER_TAB_ROUND_TRIP");

  await desktop.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await openMarketplace(desktop);
  await desktop.locator(`[data-agent-card-id="${candidateId}"]`).waitFor({ state: "visible", timeout: 15_000 });
  await desktop.locator(`[data-agent-category="${candidateCategory}"]`).click();
  await desktop.locator(`[data-agent-card-id="${candidateId}"]`).waitFor({ state: "visible", timeout: 15_000 });
  assert.deepEqual(await visibleCardIds(desktop), categoryIdsBefore, "ORIGINAL_CATEGORY_CHANGED_AFTER_RELOAD");
  await desktop.locator('[data-agent-category="favorites"]').click();
  await desktop.locator(`[data-agent-card-id="${candidateId}"]`).waitFor({ state: "visible", timeout: 15_000 });

  const persisted = await jsonApi("/api/agent-favorites");
  assert.ok((persisted.body.favorites || []).some((item) => String(item.agent_id) === candidateId), "FAVORITE_NOT_PERSISTED");

  const deleteWait = desktop.waitForResponse((response) => response.url().includes("/api/agent-favorites") && response.request().method() === "DELETE");
  await desktop.locator(`[data-agent-favorite-toggle="${candidateId}"]`).click();
  assert.equal((await deleteWait).ok(), true, "FAVORITE_DELETE_FAILED");
  await desktop.locator(`[data-agent-card-id="${candidateId}"]`).waitFor({ state: "detached", timeout: 15_000 });
  assert.equal(await favoriteCount(desktop), beforeIds.size, "FAVORITE_COUNT_DID_NOT_RESTORE");

  await desktop.locator(`[data-agent-category="${candidateCategory}"]`).click();
  const restoredOriginalCard = desktop.locator(`[data-agent-card-id="${candidateId}"]`);
  await restoredOriginalCard.waitFor({ state: "visible", timeout: 15_000 });
  assert.equal(await restoredOriginalCard.locator(`[data-agent-favorite-toggle="${candidateId}"]`).getAttribute("aria-pressed"), "false");
  assert.deepEqual(await visibleCardIds(desktop), categoryIdsBefore, "ORIGINAL_CATEGORY_CHANGED_AFTER_UNFAVORITE");
  await desktop.screenshot({ path: path.join(output, "original-category-after-unfavorite.png"), fullPage: false });

  const desktopOverflow = await desktop.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(desktopOverflow <= 1, `DESKTOP_OVERFLOW:${desktopOverflow}`);
  report.categoryInvariant = {
    key: candidateCategory,
    beforeCount: categoryIdsBefore.length,
    afterFavoriteCount: categoryIdsAfterFavorite.length,
    afterUnfavoriteCount: (await visibleCardIds(desktop)).length,
    cardIdsUnchanged: true,
    persistedAfterReload: true,
  };
  report.pages.push({ viewport: "desktop-1600x1000", pathname: "/", theme: "soft-white", overflow: desktopOverflow, targetSize: toggleBox });
  await desktopContext.close();

  const adjacentContext = await createContext(browser, { width: 1440, height: 900 }, "soft-white");
  const adjacent = await adjacentContext.newPage();
  attachDiagnostics(adjacent, "adjacent-1440x900");
  for (const pathname of ["/video", "/tools"]) {
    const response = await adjacent.goto(`${origin}${pathname}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.equal(response?.status(), 200);
    await adjacent.waitForTimeout(700);
    const overflow = await adjacent.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `${pathname}_OVERFLOW:${overflow}`);
    report.pages.push({ viewport: "adjacent-1440x900", pathname, overflow });
  }
  await adjacentContext.close();
} finally {
  await browser.close();
  if (candidateId && !beforeIds.has(candidateId)) {
    await jsonApi(`/api/agent-favorites?agent_id=${encodeURIComponent(candidateId)}`, { method: "DELETE" }).catch(() => null);
  }
  const finalState = await jsonApi("/api/agent-favorites").catch(() => null);
  const finalIds = new Set((finalState?.body?.favorites || []).map((item) => String(item.agent_id)));
  report.restoration = {
    restored: Boolean(finalState?.response?.ok && finalIds.size === beforeIds.size && [...beforeIds].every((id) => finalIds.has(id))),
    initialCount: beforeIds.size,
    finalCount: finalIds.size,
  };
}

await fs.writeFile(path.join(output, "failure-report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
assert.deepEqual(report.pageErrors, []);
assert.deepEqual(report.consoleErrors, []);
assert.deepEqual(report.serverErrors, []);
assert.deepEqual(report.paidRequests, []);
assert.equal(report.restoration?.restored, true, "FAVORITE_FIXTURE_NOT_RESTORED");
const allowedWrites = report.writes.every((item) =>
  (item.path === "/api/agent-favorites" && ["POST", "DELETE"].includes(item.method))
  || (item.path === "/api/announcements/events" && item.method === "POST")
  || (item.path === "/api/product-usage/events" && item.method === "POST")
  || (item.path === "/api/diagnostic-logs" && item.method === "POST")
  || (item.path === "/api/operation-events" && item.method === "POST"));
assert.equal(allowedWrites, true, `UNEXPECTED_WRITES:${JSON.stringify(report.writes)}`);
report.passed = true;
report.productionWrites = 0;
report.paidGenerationRequests = 0;
await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ passed: true, categoryInvariant: report.categoryInvariant, pages: report.pages.length, restored: true }));
