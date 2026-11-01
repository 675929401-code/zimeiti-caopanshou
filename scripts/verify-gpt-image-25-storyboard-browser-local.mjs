#!/usr/bin/env node

import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  cache: "no-store",
  signal: AbortSignal.timeout(20_000),
});
const identity = await identityResponse.json();
assert.equal(identityResponse.status, 200, identity.error || "LOCAL_ADMIN_IDENTITY_FAILED");

const evidenceDir = path.resolve(".codex-evidence/gpt-image-25-workspace-restore");
await mkdir(evidenceDir, { recursive: true });
const screenshot = path.join(evidenceDir, "storyboard-workbench-gpt-image-25.png");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
await context.addInitScript(({ sessionToken, user }) => {
  localStorage.setItem("auth_token", sessionToken);
  localStorage.setItem("auth_user", JSON.stringify(user));
  sessionStorage.setItem("entered_app", "1");
}, { sessionToken: token, user: identity.user });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const failedResponses = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("request", (request) => { if (new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push({ status: response.status(), url: response.url() }); });
await page.route(`${origin}/api/product-usage/events`, (route) => route.fulfill({
  status: 204,
  headers: { "Cache-Control": "no-store" },
  body: "",
}));

try {
  const response = await page.goto(`${origin}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, "STORYBOARD_PAGE_HTTP_FAILED");
  await page.locator(".sbw-model-section").first().waitFor({ state: "visible", timeout: 45_000 });
  await page.locator(".sbw-image-model-list [data-model-id]").first().waitFor({ state: "visible", timeout: 45_000 });
  const models = await page.locator(".sbw-image-model-list [data-model-id]").evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute("data-model-id"),
    text: node.textContent?.replace(/\s+/gu, " ").trim() || "",
    selectable: node.getAttribute("data-model-selectable"),
    active: node.classList.contains("is-active"),
  })));
  const sunburst = models.find((model) => model.text.includes("GPT-Image-2.5 Sunburst"));
  const flare = models.find((model) => model.text.includes("GPT-Image-2.5 Flare"));
  assert.ok(sunburst, "GPT_IMAGE_25_SUNBURST_NOT_VISIBLE_IN_BROWSER");
  assert.ok(flare, "GPT_IMAGE_25_FLARE_NOT_VISIBLE_IN_BROWSER");
  assert.equal(sunburst.selectable, "true", "GPT_IMAGE_25_SUNBURST_NOT_SELECTABLE");
  assert.equal(flare.selectable, "true", "GPT_IMAGE_25_FLARE_NOT_SELECTABLE");
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(pageErrors, [], "STORYBOARD_PAGE_ERRORS");
  assert.deepEqual(consoleErrors, [], `STORYBOARD_CONSOLE_ERRORS:${JSON.stringify(failedResponses)}`);
  assert.deepEqual(externalRequests, [], "STORYBOARD_EXTERNAL_REQUESTS");
  console.log(JSON.stringify({
    passed: true,
    origin,
    route: "/storyboard-workbench",
    imageModelCount: models.length,
    gptImage25: { sunburst, flare },
    pageErrors,
    consoleErrors,
    failedResponses,
    externalRequests,
    screenshot,
    providerRequests: 0,
    paidGenerationRequests: 0,
  }, null, 2));
} finally {
  await context.close();
  await browser.close();
}
