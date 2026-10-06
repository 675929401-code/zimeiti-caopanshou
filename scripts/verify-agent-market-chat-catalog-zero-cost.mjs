#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const targetAgentName = "3D故事导演｜高能版";
const outputDir = path.resolve(".tmp-e2e/agent-market-chat-catalog-zero-cost");
const simulateTransientModelFailure = process.argv.includes("--simulate-first-model-failure");

assert.ok(["http://127.0.0.1:5000", "http://127.0.0.1:5002"].includes(origin), "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
await fs.mkdir(outputDir, { recursive: true });

const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(10_000),
});
const identity = await identityResponse.json();
assert.ok(identityResponse.ok && identity.user?.role === "admin", "ACTIVE_LOCAL_ADMIN_REQUIRED");

const authorizedHeaders = { Authorization: `Bearer ${token}` };
const [agentsResponse, chatCatalogResponse] = await Promise.all([
  fetch(`${origin}/api/bots?shape=agents`, { headers: authorizedHeaders, signal: AbortSignal.timeout(10_000) }),
  fetch(`${origin}/api/chat-models`, { headers: authorizedHeaders, signal: AbortSignal.timeout(10_000) }),
]);
const [agentsPayload, chatCatalogPayload] = await Promise.all([agentsResponse.json(), chatCatalogResponse.json()]);
assert.ok(agentsResponse.ok, "AGENT_CATALOG_PREFLIGHT_FAILED");
assert.ok(chatCatalogResponse.ok, "CHAT_MODEL_CATALOG_PREFLIGHT_FAILED");
const chatModelIds = new Set((chatCatalogPayload.models || []).map((model) => model.id));
const llmAgents = (agentsPayload.agents || []).filter((agent) => agent.source === "llm");
const invalidAgentBindings = llmAgents
  .filter((agent) => !agent.model_id || !agent.model_public_id || !chatModelIds.has(agent.model_public_id))
  .map((agent) => ({ id: agent.id, name: agent.name, model: agent.model, model_id: agent.model_id, model_public_id: agent.model_public_id }));

const browser = await chromium.launch({ headless: true });
let blockedWrites = 0;
let simulatedModelCatalogFailures = 0;
const apiResponses = [];
const consoleErrors = [];
const pageErrors = [];

try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const method = route.request().method();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      blockedWrites += 1;
      await route.abort("blockedbyclient");
      return;
    }
    if (
      simulateTransientModelFailure
      && method === "GET"
      && new URL(route.request().url()).pathname === "/api/chat-models"
      && simulatedModelCatalogFailures === 0
    ) {
      simulatedModelCatalogFailures += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "simulated transient catalog outage" }) });
      return;
    }
    await route.continue();
  });
  await context.addInitScript(({ localToken, user }) => {
    localStorage.setItem("auth_token", localToken);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { localToken: token, user: identity.user });

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (["/api/bots", "/api/chat-models"].includes(pathname)) {
      apiResponses.push({ pathname, status: response.status() });
    }
  });

  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const cards = page.locator('[aria-label^="打开智能体："]');
  await cards.first().waitFor({ state: "visible", timeout: 30_000 });
  const cardCount = await cards.count();
  for (let index = 0; index < cardCount; index += 1) {
    await cards.nth(index).scrollIntoViewIfNeeded();
  }
  await page.waitForTimeout(800);

  const avatarRows = await cards.evaluateAll((agentCards) => agentCards.map((card) => {
    const image = card.querySelector(".marketplace-agent-avatar img");
    return {
      alt: image?.getAttribute("alt") || card.getAttribute("aria-label") || "",
      src: image instanceof HTMLImageElement ? new URL(image.currentSrc || image.src, location.href).pathname : "",
      naturalWidth: image instanceof HTMLImageElement ? image.naturalWidth : 0,
      naturalHeight: image instanceof HTMLImageElement ? image.naturalHeight : 0,
      display: image instanceof HTMLImageElement ? getComputedStyle(image).display : "missing",
      semanticFallback: image instanceof HTMLImageElement ? image.dataset.semanticFallback || "" : "",
    };
  }));
  const brokenAvatars = avatarRows.filter((row) => row.naturalWidth < 1 || row.naturalHeight < 1 || row.display === "none");

  const targetCard = page.getByRole("button", { name: `打开智能体：${targetAgentName}`, exact: true });
  await targetCard.scrollIntoViewIfNeeded();
  await targetCard.click();
  const skipButton = page.getByRole("button", { name: "跳过", exact: true });
  if (await skipButton.isVisible().catch(() => false)) await skipButton.click();

  const modelSwitcher = page.getByTitle("切换对话模型");
  await modelSwitcher.waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('button[title="切换对话模型"]');
    return button && !String(button.textContent || "").includes("读取模型中");
  }, undefined, { timeout: 15_000 });
  const modelSwitcherText = (await modelSwitcher.innerText()).trim();
  await modelSwitcher.click();
  await page.getByText("选择对话模型", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
  const modelCatalogText = await page.locator("body").innerText();

  const report = {
    origin,
    targetAgentName,
    cardCount,
    avatarImageCount: avatarRows.length,
    brokenAvatarCount: brokenAvatars.length,
    brokenAvatars,
    semanticFallbackCount: avatarRows.filter((row) => row.semanticFallback === "1").length,
    modelSwitcherText,
    modelCatalogVisible: modelCatalogText.includes("选择对话模型"),
    modelBindingAudit: { llmAgents: llmAgents.length, chatModels: chatModelIds.size, invalidBindings: invalidAgentBindings.length, invalidAgentBindings },
    apiResponses,
    simulateTransientModelFailure,
    simulatedModelCatalogFailures,
    blockedWrites,
    paidGenerationRequests: 0,
    executedBusinessWrites: 0,
    consoleErrors,
    pageErrors,
  };
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await page.screenshot({ path: path.join(outputDir, "market-chat.png"), fullPage: true });

  assert.equal(brokenAvatars.length, 0, "MARKETPLACE_AVATAR_RENDER_FAILURE");
  assert.ok(avatarRows.length >= cardCount, "EVERY_AGENT_CARD_REQUIRES_AN_AVATAR");
  assert.equal(invalidAgentBindings.length, 0, "LLM_AGENT_MODEL_BINDING_INVALID");
  assert.ok(apiResponses.some((item) => item.pathname === "/api/bots" && item.status === 200), "AGENT_CATALOG_REQUEST_FAILED");
  assert.ok(apiResponses.some((item) => item.pathname === "/api/chat-models" && item.status === 200), "CHAT_MODEL_CATALOG_REQUEST_FAILED");
  assert.doesNotMatch(modelSwitcherText, /选择可用模型|原模型不可用|暂不可用/u, "AGENT_DEFAULT_MODEL_BINDING_MISSING");
  assert.equal(report.modelCatalogVisible, true, "CHAT_MODEL_SELECTOR_NOT_RENDERED");
  if (simulateTransientModelFailure) assert.equal(simulatedModelCatalogFailures, 1, "TRANSIENT_MODEL_CATALOG_FAILURE_NOT_SIMULATED");

  console.log(JSON.stringify(report, null, 2));
  await context.close();
} finally {
  await browser.close();
}
