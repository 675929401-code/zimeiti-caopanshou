#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const targets = new Map([
  ["cover-model-seedream-5", "豆包 Seedream 5.0"],
  ["qwen-image-2512-hq-selfhost-pro6000", "Qwen Image 2512 HQ"],
]);
const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice(9)
  || new Date().toISOString().replace(/[:.]/gu, "-");
const execute = process.argv.includes("--execute");

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.match(runId, /^[A-Za-z0-9_-]{8,100}$/u, "RUN_ID_INVALID");

const evidenceDir = path.resolve(".codex-evidence/image-catalog-admin-selection", runId);
await fs.mkdir(evidenceDir, { recursive: true });

if (!execute) {
  console.log(JSON.stringify({ mode: "plan", targetIds: [...targets.keys()], maximumAdminWrites: 2, evidenceDir }));
  process.exit(0);
}

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
    if (request.method() === "PUT" && url.pathname === "/api/admin/models") {
      const body = request.postDataJSON();
      assert.equal(body?.model_type, "drawing", "ONLY_DRAWING_MODEL_MUTATION_ALLOWED");
      assert.equal(body?.is_hidden, true, "ONLY_HIDE_MUTATION_ALLOWED");
      assert.ok(targets.has(String(body?.id || "")), "UNEXPECTED_IMAGE_MODEL_MUTATION");
      writes.push({ method: request.method(), path: url.pathname, id: body.id, isHidden: body.is_hidden });
      await route.continue();
      return;
    }
    blocked.push({ method: request.method(), path: url.pathname });
    await route.abort("blockedbyclient");
  });

  const page = await context.newPage();
  const response = await page.goto(`${origin}/admin?tab=models`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, "ADMIN_MODELS_PAGE_FAILED");
  await page.getByRole("heading", { name: "模型资源池", exact: true }).waitFor({ state: "visible", timeout: 45_000 });
  await page.getByRole("button", { name: /绘图模型/u }).click();

  for (const [id, label] of targets) {
    const card = page.locator(`[data-model-card][data-model-id="${id}"]`);
    await card.waitFor({ state: "visible", timeout: 45_000 });
    const hiddenBadge = card.getByText("已隐藏", { exact: true });
    if (await hiddenBadge.count()) continue;
    const responsePromise = page.waitForResponse(async (candidate) => {
      if (candidate.request().method() !== "PUT" || new URL(candidate.url()).pathname !== "/api/admin/models") return false;
      return candidate.request().postDataJSON()?.id === id;
    }, { timeout: 30_000 });
    await card.getByRole("button", { name: "隐藏", exact: true }).click();
    const updateResponse = await responsePromise;
    const updateBody = await updateResponse.json().catch(() => ({}));
    assert.ok(updateResponse.ok(), updateBody.error || `${label} HIDE_FAILED_${updateResponse.status()}`);
    await card.getByText("已隐藏", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  }

  await page.screenshot({ path: path.join(evidenceDir, "admin-image-model-selection.png"), fullPage: true });
  const headers = { Authorization: `Bearer ${session.token}` };
  const [adminRead, catalogRead] = await Promise.all([
    context.request.get(`${origin}/api/admin/models`, { headers }),
    context.request.get(`${origin}/api/cover-models?surface=storyboard-workbench`, { headers }),
  ]);
  assert.ok(adminRead.ok(), "ADMIN_MODELS_READBACK_FAILED");
  assert.ok(catalogRead.ok(), "IMAGE_CATALOG_READBACK_FAILED");
  const adminPayload = await adminRead.json();
  const catalogPayload = await catalogRead.json();
  const drawing = (adminPayload.models || []).filter((model) => model.model_type === "drawing");
  for (const id of targets.keys()) {
    assert.equal(drawing.find((model) => model.id === id)?.is_hidden, true, `ADMIN_HIDE_NOT_PERSISTED:${id}`);
  }
  const visibleNames = (catalogPayload.models || []).map((model) => String(model.displayName || ""));
  assert.equal(visibleNames.length, 6, `VISIBLE_IMAGE_MODEL_COUNT_MISMATCH:${visibleNames.length}`);
  assert.equal(visibleNames.some((name) => /Qwen|GLM/u.test(name)), false, "REMOVED_IMAGE_MODEL_STILL_VISIBLE");
  assert.equal(visibleNames.filter((name) => /Seedream/u.test(name)).length, 1, "SEEDREAM_VISIBLE_COUNT_MISMATCH");
  assert.ok(visibleNames.some((name) => name === "豆包 Seedream 5.0 Pro"), "SEEDREAM_5_PRO_MISSING");

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    administratorUi: true,
    writes,
    blocked,
    providerGenerationRequests: 0,
    visibleImageModelCount: visibleNames.length,
    visibleImageModels: visibleNames,
    hiddenModelIds: [...targets.keys()],
    glmPresentInImageCatalog: visibleNames.some((name) => /GLM/u.test(name)),
    qwenPresentInImageCatalog: visibleNames.some((name) => /Qwen/u.test(name)),
    seedreamVisibleCount: visibleNames.filter((name) => /Seedream/u.test(name)).length,
  };
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ success: true, evidenceDir, ...report }, null, 2));
} finally {
  await browser.close();
}
