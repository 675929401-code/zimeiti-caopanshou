#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
const outputDir = path.resolve(".codex-evidence/workspace-model-admin-live-20260920");

async function api(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, body.error || `${pathname} returned ${response.status}`);
  return body;
}

async function post(body) {
  return api("/api/admin/workspace-models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function surface(catalog, id) {
  const found = catalog.surfaces?.find((item) => item.id === id);
  assert.ok(found, `MISSING_SURFACE:${id}`);
  return found;
}

function assignedIds(catalog, id) {
  return surface(catalog, id).models.filter((model) => model.assigned).map((model) => model.id);
}

function priceTiers(labels) {
  return labels.map((label) => {
    const match = String(label).match(/^(1K|2K|4K) 售 ¥(\d+(?:\.\d+)?)$/u);
    assert.ok(match, `INVALID_PRICE_LABEL:${label}`);
    return { resolution: match[1], price: Number(match[2]) };
  });
}

function workspaceReadback(page) {
  return page.waitForResponse((response) => response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/admin/workspace-models");
}

export async function main() {
  assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
  assert.ok(token, "LOCAL_NAV_ADMIN_TOKEN_REQUIRED");
  await fs.mkdir(outputDir, { recursive: true });
  const identity = await api("/api/auth/me");
  assert.equal(identity?.user?.role, "admin", "ADMIN_ROLE_REQUIRED");
  const initialCatalog = await api("/api/admin/workspace-models");
  assert.equal(initialCatalog.surfaces?.length, 9, "NINE_WORKSPACE_MODEL_SURFACES_REQUIRED");
  assert.doesNotMatch(JSON.stringify(initialCatalog), /api_key|secret:\/\/|sk-[A-Za-z0-9]/u, "ADMIN_ROUTING_CATALOG_EXPOSED_A_SECRET");

  const pendingGptImage2Ids = [
    "pending-cover-model-gpt-image-2-image-2-1k",
    "pending-cover-model-gpt-image-2-official",
    "pending-cover-model-gpt-image-2-adobe-mid",
  ];
  const gptImage2ById = new Map();
  for (const surfaceId of ["image-workbench", "cover-studio", "storyboard-image"]) {
    const models = surface(initialCatalog, surfaceId).models;
    for (const modelId of pendingGptImage2Ids) {
      const model = models.find((entry) => entry.id === modelId);
      assert.ok(model, `GPT_IMAGE_2_GROUP_MISSING_FROM_ADMIN:${surfaceId}:${modelId}`);
      assert.equal(model.assigned, true, `GPT_IMAGE_2_GROUP_NOT_ASSIGNED:${surfaceId}:${modelId}`);
      assert.equal(model.providerHost, "token.secure-skill.com", `GPT_IMAGE_2_PROVIDER_HOST_MISMATCH:${modelId}`);
      assert.equal(model.visibleNow, true, `GPT_IMAGE_2_GROUP_NOT_LISTED:${surfaceId}:${modelId}`);
      assert.equal(model.catalogDisplayable, true, `GPT_IMAGE_2_GROUP_NOT_CATALOG_DISPLAYABLE:${surfaceId}:${modelId}`);
      if (modelId !== "pending-cover-model-gpt-image-2-official") {
        assert.equal(model.publishable, true, `PUBLIC_GPT_IMAGE_2_GROUP_NOT_SUBMITTABLE:${modelId}`);
        assert.equal(model.active, true, `PUBLIC_GPT_IMAGE_2_GROUP_INACTIVE:${modelId}`);
        assert.equal(model.hidden, false, `PUBLIC_GPT_IMAGE_2_GROUP_HIDDEN:${modelId}`);
      } else {
        assert.equal(model.publishable, false, `PAUSED_GPT_IMAGE_2_GROUP_UNEXPECTEDLY_PUBLISHABLE:${modelId}`);
        assert.equal(model.active, false, `PAUSED_GPT_IMAGE_2_GROUP_UNEXPECTEDLY_ACTIVE:${modelId}`);
        assert.match(model.availabilityMessage, /上游.*无可用兼容账户/u,
          `GPT_IMAGE_2_GATE_REASON_MISSING:${modelId}`);
      }
      if (surfaceId === "image-workbench") gptImage2ById.set(modelId, model);
      assert.deepEqual(priceTiers(model.priceLabels), modelId === "pending-cover-model-gpt-image-2-image-2-1k"
        ? [{ resolution: "1K", price: 0.1 }]
        : modelId === "pending-cover-model-gpt-image-2-official"
          ? [{ resolution: "1K", price: 0.2 }, { resolution: "2K", price: 0.2 }, { resolution: "4K", price: 0.3 }]
          : [{ resolution: "1K", price: 0.1 }, { resolution: "2K", price: 0.1 }],
      `GPT_IMAGE_2_PRICE_TIERS_MISMATCH:${modelId}`);
    }
  }
  const publicStoryboardImages = await api("/api/cover-models?surface=storyboard-workbench");
  const publicImageWorkbench = await api("/api/cover-models?surface=image-workbench");
  for (const modelId of pendingGptImage2Ids) {
    const adminModel = gptImage2ById.get(modelId);
    const storyboardModel = publicStoryboardImages.models.find((entry) => entry.displayName === adminModel.name);
    const imageWorkbenchModel = publicImageWorkbench.models.find((entry) => entry.displayName === adminModel.name);
    assert.ok(storyboardModel, `STORYBOARD_GPT_IMAGE_2_GROUP_NOT_LISTED:${modelId}`);
    assert.ok(imageWorkbenchModel, `IMAGE_WORKBENCH_GPT_IMAGE_2_GROUP_NOT_LISTED:${modelId}`);
    const expectedAvailable = modelId !== "pending-cover-model-gpt-image-2-official";
    assert.equal(storyboardModel.capabilities.available, expectedAvailable, `STORYBOARD_GPT_IMAGE_2_AVAILABILITY_MISMATCH:${modelId}`);
    assert.equal(imageWorkbenchModel.capabilities.available, expectedAvailable, `IMAGE_WORKBENCH_GPT_IMAGE_2_AVAILABILITY_MISMATCH:${modelId}`);
  }

  const storyboardVideo = surface(initialCatalog, "storyboard-video");
  const originalOrder = storyboardVideo.models.filter((model) => model.assigned).map((model) => model.id);
  assert.ok(originalOrder.length >= 2, "TWO_ASSIGNED_STORYBOARD_VIDEO_MODELS_REQUIRED");
  const reorderTarget = storyboardVideo.models.find((model) => model.id === originalOrder[0]);
  const assignmentTarget = storyboardVideo.models.find((model) => model.assigned && model.publishable && model.visibleNow);
  assert.ok(reorderTarget && assignmentTarget, "WRITABLE_STORYBOARD_MODELS_REQUIRED");
  const swappedOrder = [...originalOrder];
  [swappedOrder[0], swappedOrder[1]] = [swappedOrder[1], swappedOrder[0]];

  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    surfaces: initialCatalog.surfaces.map((item) => ({
      id: item.id,
      assigned: item.models.filter((model) => model.assigned).length,
      publishable: item.models.filter((model) => model.assigned && model.publishable).length,
    })),
    writes: [],
    paidGenerationRequests: 0,
    externalProviderRequests: 0,
    pageErrors: [],
    consoleErrors: [],
    restored: false,
  };

  let assignmentRemoved = false;
  let orderChanged = false;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text().slice(0, 500));
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /^\/api\/(?:image|video)\/generate$/u.test(url.pathname)) report.paidGenerationRequests += 1;
      if (url.origin !== origin) report.externalProviderRequests += 1;
    });

    await page.goto(`${origin}/admin?tab=workspace-models&project=storyboard`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('[data-workspace-project="storyboard"]').waitFor({ state: "visible", timeout: 45_000 });
    for (const label of ["图片创作", "封面制作", "AI 分镜工作台", "AI 视频创作", "无限画布", "影视工坊", "智音工坊", "带货 Agent", "漫剧工作台", "内容工具箱"]) {
      assert.equal(await page.getByRole("button", { name: new RegExp(`^${label}`) }).count(), 1, `ADMIN_NAV_ITEM_MISSING:${label}`);
    }
    assert.equal(await page.locator('[data-workspace-project-button="digital-human"]').count(), 0, "RETIRED_DIGITAL_HUMAN_PROJECT_REMAINS");
    await page.locator('[data-workspace-project-button="storyboard"]').click();
    await page.getByRole("button", { name: "生视频模型", exact: true }).click();
    await page.getByRole("heading", { name: "分镜工作台 · 生视频", exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: path.join(outputDir, "desktop-before.png"), fullPage: true });

    const reorderRow = page.locator("tbody tr").filter({ hasText: reorderTarget.name }).first();
    await reorderRow.waitFor({ state: "visible" });
    const downResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/admin/workspace-models");
    const downReadback = workspaceReadback(page);
    await reorderRow.getByTitle("下移", { exact: true }).click();
    assert.equal((await downResponse).status(), 200, "UI_REORDER_FAILED");
    assert.equal((await downReadback).status(), 200, "UI_REORDER_READBACK_REFRESH_FAILED");
    orderChanged = true;
    report.writes.push("reorder-down");
    assert.deepEqual(assignedIds(await api("/api/admin/workspace-models"), "storyboard-video"), swappedOrder,
      "UI_REORDER_READBACK_MISMATCH");

    const restoredRow = page.locator("tbody tr").filter({ hasText: reorderTarget.name }).first();
    const upResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/admin/workspace-models");
    const upReadback = workspaceReadback(page);
    await restoredRow.getByTitle("上移", { exact: true }).click();
    assert.equal((await upResponse).status(), 200, "UI_REORDER_RESTORE_FAILED");
    assert.equal((await upReadback).status(), 200, "UI_REORDER_RESTORE_REFRESH_FAILED");
    orderChanged = false;
    report.writes.push("reorder-restore");
    assert.deepEqual(assignedIds(await api("/api/admin/workspace-models"), "storyboard-video"), originalOrder,
      "UI_REORDER_RESTORE_READBACK_MISMATCH");

    const publicBefore = await api("/api/video/models?surface=storyboard-workbench");
    const targetRow = page.locator("tbody tr").filter({ hasText: assignmentTarget.name }).first();
    const checkbox = targetRow.locator('input[type="checkbox"]');
    assert.equal(await checkbox.isChecked(), true, "ASSIGNMENT_TARGET_NOT_CHECKED");
    const removeResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/admin/workspace-models");
    const removeReadback = workspaceReadback(page);
    await checkbox.click();
    assert.equal((await removeResponse).status(), 200, "UI_ASSIGNMENT_REMOVE_FAILED");
    assert.equal((await removeReadback).status(), 200, "UI_ASSIGNMENT_REMOVE_REFRESH_FAILED");
    assignmentRemoved = true;
    report.writes.push("assignment-remove");
    const afterRemoveCatalog = await api("/api/admin/workspace-models");
    assert.equal(surface(afterRemoveCatalog, "storyboard-video").models.find((model) => model.id === assignmentTarget.id)?.assigned,
      false, "ASSIGNMENT_REMOVE_READBACK_MISMATCH");
    const publicRemoved = await api("/api/video/models?surface=storyboard-workbench");
    assert.equal(publicRemoved.models.length, publicBefore.models.length - 1, "PUBLIC_CATALOG_DID_NOT_REMOVE_MODEL");

    const reloadedTargetRow = page.locator("tbody tr").filter({ hasText: assignmentTarget.name }).first();
    const restoreAssignmentResponse = page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/admin/workspace-models");
    const restoreAssignmentReadback = workspaceReadback(page);
    await reloadedTargetRow.locator('input[type="checkbox"]').click();
    assert.equal((await restoreAssignmentResponse).status(), 200, "UI_ASSIGNMENT_RESTORE_FAILED");
    assert.equal((await restoreAssignmentReadback).status(), 200, "UI_ASSIGNMENT_RESTORE_REFRESH_FAILED");
    assignmentRemoved = false;
    report.writes.push("assignment-restore");
    const restoredCatalog = await api("/api/admin/workspace-models");
    const restoredTarget = surface(restoredCatalog, "storyboard-video").models.find((model) => model.id === assignmentTarget.id);
    assert.equal(restoredTarget?.assigned, true, "ASSIGNMENT_RESTORE_READBACK_MISMATCH");
    assert.equal(restoredTarget?.publishable, true, "WORKSPACE_ASSIGNMENT_INVALIDATED_ACCEPTANCE");
    const publicRestored = await api("/api/video/models?surface=storyboard-workbench");
    assert.equal(publicRestored.models.length, publicBefore.models.length, "PUBLIC_CATALOG_DID_NOT_RESTORE_MODEL");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(outputDir, "mobile-restored.png"), fullPage: true });
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(viewport.scrollWidth <= viewport.width + 1, `ADMIN_PAGE_HORIZONTAL_OVERFLOW:${JSON.stringify(viewport)}`);
    assert.equal(report.paidGenerationRequests, 0, "ADMIN_TEST_ATTEMPTED_PAID_GENERATION");
    assert.equal(report.externalProviderRequests, 0, "ADMIN_TEST_CALLED_AN_EXTERNAL_PROVIDER");
    assert.deepEqual(report.pageErrors, [], "ADMIN_PAGE_ERRORS");
    report.restored = true;
  } finally {
    try {
      const current = await api("/api/admin/workspace-models");
      if (assignmentRemoved || !surface(current, "storyboard-video").models.find((model) => model.id === assignmentTarget.id)?.assigned) {
        await post({ action: "assign", kind: "video", surface: "storyboard-video", modelId: assignmentTarget.id, enabled: true });
      }
      const restoredAssignmentCatalog = await api("/api/admin/workspace-models");
      assert.equal(surface(restoredAssignmentCatalog, "storyboard-video").models.find((model) => model.id === assignmentTarget.id)?.assigned,
        true, "ADMIN_E2E_ASSIGNMENT_CLEANUP_FAILED");
      if (orderChanged || JSON.stringify(assignedIds(restoredAssignmentCatalog, "storyboard-video")) !== JSON.stringify(originalOrder)) {
        await post({ action: "reorder", kind: "video", surface: "storyboard-video", modelIds: originalOrder });
      }
      report.restored = JSON.stringify(assignedIds(await api("/api/admin/workspace-models"), "storyboard-video")) === JSON.stringify(originalOrder);
    } finally {
      await browser.close();
      await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    }
  }
  assert.equal(report.restored, true, "ADMIN_E2E_DID_NOT_RESTORE_ORIGINAL_CONFIGURATION");
  console.log(JSON.stringify({ passed: true, writes: report.writes, restored: report.restored, paidGenerationRequests: 0, providerCalls: 0, outputDir }));
}

if (import.meta.url === new URL(`file://${process.argv[1].replace(/\\/gu, "/")}`).href) await main();
