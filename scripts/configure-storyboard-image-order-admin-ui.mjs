#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9)
  || new Date().toISOString().replace(/[:.]/gu, "-");
const outputDir = path.resolve(".codex-evidence/storyboard-image-order", runId);
const target = [
  { id: "gpt-image-25-sunburst-chA", name: "GPT-Image-2.5 Sunburst · 渠道A" },
  { id: "gpt-image-2-chA-1", name: "GPT-Image-2 · 渠道A pro" },
  { id: "gpt-image-25-flare-chA", name: "GPT-Image-2.5 Flare · 渠道A" },
  { id: "gemini-3-1-flash-image-chA", name: "Nano Banana 2 · 渠道A" },
  { id: "gemini-3-0-pro-image-chA", name: "Gemini 3.0 Pro Image · 渠道A" },
  { id: "cover-model-seedream-5-pro", name: "豆包 Seedream 5.0 Pro" },
];

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "RUN_ID_INVALID");
await fs.mkdir(outputDir, { recursive: true });

const sessionResponse = await fetch(`${origin}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
  signal: AbortSignal.timeout(20_000),
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "LOCAL_ADMIN_SESSION_REQUIRED");
const identityResponse = await fetch(`${origin}/api/auth/me`, {
  headers: { Authorization: `Bearer ${session.token}` },
  signal: AbortSignal.timeout(20_000),
});
const identity = await identityResponse.json();
assert.equal(identityResponse.status, 200, identity.error || "ADMIN_IDENTITY_FAILED");
assert.equal(identity.user?.role, "admin", "ADMIN_ROLE_REQUIRED");

const writes = [];
const blocked = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1720, height: 1050 }, serviceWorkers: "block" });
  await context.addInitScript(({ token, user }) => {
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: session.token, user: identity.user });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["GET", "HEAD", "OPTIONS"].includes(request.method()) || url.origin !== origin) {
      await route.continue();
      return;
    }
    if (request.method() === "POST" && url.pathname === "/api/admin/workspace-models") {
      const body = request.postDataJSON();
      assert.equal(body?.action, "reorder", "ONLY_REORDER_MUTATION_ALLOWED");
      assert.equal(body?.kind, "image", "ONLY_IMAGE_REORDER_ALLOWED");
      assert.equal(body?.surface, "storyboard-image", "ONLY_STORYBOARD_IMAGE_REORDER_ALLOWED");
      assert.deepEqual(new Set(body?.modelIds || []), new Set(target.map((model) => model.id)), "REORDER_MODEL_SET_MISMATCH");
      writes.push({ action: body.action, surface: body.surface, modelIds: body.modelIds });
      await route.continue();
      return;
    }
    blocked.push({ method: request.method(), path: url.pathname });
    await route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  const response = await page.goto(`${origin}/admin?tab=workspace-models&project=storyboard`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.equal(response?.status(), 200, "ADMIN_WORKSPACE_PAGE_FAILED");
  await page.locator('[data-workspace-project="storyboard"]').waitFor({ state: "visible", timeout: 45_000 });
  await page.getByText("6 已添加 / 8 资源池", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });

  const currentOrder = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('tbody tr input[type="checkbox"]')]
      .filter((input) => input instanceof HTMLInputElement && input.checked).length === 6, null, { timeout: 30_000 });
    const rows = page.locator("tbody tr");
    const result = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const checkbox = row.locator('input[type="checkbox"]');
      if (await checkbox.count() && await checkbox.isChecked()) {
        const text = await row.innerText();
        const matched = target.find((model) => text.includes(model.name));
        if (matched) result.push(matched.id);
      }
    }
    return result;
  };

  for (let destination = 0; destination < target.length; destination += 1) {
    let order = await currentOrder();
    let source = order.indexOf(target[destination].id);
    assert.ok(source >= destination, `TARGET_ORDER_SOURCE_INVALID:${target[destination].id}:${source}:${destination}`);
    while (source > destination) {
      const row = page.locator("tbody tr").filter({ hasText: target[destination].name }).first();
      const writeResponse = page.waitForResponse((candidate) => candidate.request().method() === "POST"
        && new URL(candidate.url()).pathname === "/api/admin/workspace-models", { timeout: 30_000 });
      const readback = page.waitForResponse((candidate) => candidate.request().method() === "GET"
        && new URL(candidate.url()).pathname === "/api/admin/workspace-models", { timeout: 30_000 });
      await row.getByTitle("上移", { exact: true }).click();
      assert.equal((await writeResponse).status(), 200, `ORDER_WRITE_FAILED:${target[destination].id}`);
      assert.equal((await readback).status(), 200, `ORDER_READBACK_FAILED:${target[destination].id}`);
      source -= 1;
      order = await currentOrder();
      assert.equal(order[source], target[destination].id, `ORDER_STEP_MISMATCH:${target[destination].id}`);
    }
  }

  const finalOrder = await currentOrder();
  assert.deepEqual(finalOrder, target.map((model) => model.id), "FINAL_STORYBOARD_IMAGE_ORDER_MISMATCH");
  await page.screenshot({ path: path.join(outputDir, "storyboard-image-ordered.png"), fullPage: true });

  const apiRead = await context.request.get(`${origin}/api/admin/workspace-models`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  assert.ok(apiRead.ok(), "ADMIN_WORKSPACE_READBACK_FAILED");
  const catalog = await apiRead.json();
  const surface = catalog.surfaces?.find((entry) => entry.id === "storyboard-image");
  const apiOrder = surface?.models?.filter((model) => model.assigned).map((model) => model.id) || [];
  assert.deepEqual(apiOrder, finalOrder, "API_STORYBOARD_IMAGE_ORDER_MISMATCH");
  assert.deepEqual(blocked, [], "UNEXPECTED_MUTATION_BLOCKED");

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    administratorUi: true,
    writes,
    providerGenerationRequests: 0,
    finalOrder,
    finalNames: target.map((model) => model.name),
  };
  await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, outputDir, ...report }, null, 2));
} finally {
  await browser.close();
}
