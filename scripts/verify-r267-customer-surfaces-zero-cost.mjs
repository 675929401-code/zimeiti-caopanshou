#!/usr/bin/env node

import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = String(process.env.BASE_URL || process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const parsedBaseUrl = new URL(baseUrl);
assert.ok(
  parsedBaseUrl.protocol === "http:"
    && ["127.0.0.1", "localhost"].includes(parsedBaseUrl.hostname)
    && parsedBaseUrl.pathname === "/",
  "R267_LOCAL_APP_ORIGIN_REQUIRED",
);

const customerToken = String(
  process.env.R267_CUSTOMER_TOKEN
    || process.env.LOCAL_NAV_USER_TOKEN
    || process.env.LOCAL_NAV_SECOND_TOKEN
    || "",
).trim();

if (!customerToken) {
  throw new Error(
    "R267_CUSTOMER_AUTH_REQUIRED: provide an existing ordinary-customer token in "
      + "R267_CUSTOMER_TOKEN or LOCAL_NAV_USER_TOKEN; the verifier will not create, mutate, or impersonate an account",
  );
}

const forbiddenStorageKeys = new Set([
  "provider",
  "storage_provider",
  "storage_key",
  "user_id",
  "meta",
]);

function responseUser(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.user && typeof payload.user === "object") return payload.user;
  if (payload.data?.user && typeof payload.data.user === "object") return payload.data.user;
  return null;
}

async function realCustomerGet(pathname) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "GET",
    headers: { Authorization: `Bearer ${customerToken}` },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`R267_CUSTOMER_GET_INVALID_JSON: ${pathname} returned ${response.status}`);
  }
  return { response, payload };
}

function findForbiddenStorageKeys(value, currentPath = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenStorageKeys(item, `${currentPath}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${currentPath}.${key}`;
    if (forbiddenStorageKeys.has(key)) found.push(nextPath);
    findForbiddenStorageKeys(child, nextPath, found);
  }
  return found;
}

const identityRead = await realCustomerGet("/api/auth/me");
assert.equal(identityRead.response.status, 200, "R267_CUSTOMER_AUTH_UNAVAILABLE: /api/auth/me did not accept the supplied token");
const customer = responseUser(identityRead.payload);
assert.ok(customer?.id, "R267_CUSTOMER_AUTH_INVALID: /api/auth/me did not return a user identity");
assert.equal(
  customer.role,
  "student",
  `R267_ORDINARY_CUSTOMER_REQUIRED: expected role=student, received ${String(customer.role || "missing")}`,
);

const storageRead = await realCustomerGet("/api/storage/files?limit=1&offset=0&quota=true");
assert.equal(storageRead.response.status, 200, "R267_STORAGE_FILES_GET_FAILED");
assert.ok(Array.isArray(storageRead.payload?.files), "R267_STORAGE_FILES_INVALID: files must be an array");
const leakedStorageKeys = findForbiddenStorageKeys(storageRead.payload);
assert.deepEqual(
  leakedStorageKeys,
  [],
  `R267_STORAGE_FILES_PRIVATE_FIELDS_EXPOSED: ${leakedStorageKeys.join(", ")}`,
);

const [videoCatalogRead, storyboardVideoCatalogRead, storyboardImageCatalogRead] = await Promise.all([
  realCustomerGet("/api/video/models?surface=video-page"),
  realCustomerGet("/api/video/models?surface=storyboard-workbench"),
  realCustomerGet("/api/cover-models?surface=storyboard-workbench"),
]);
for (const [label, read] of [
  ["video", videoCatalogRead],
  ["storyboard-video", storyboardVideoCatalogRead],
  ["storyboard-image", storyboardImageCatalogRead],
]) {
  assert.equal(read.response.status, 200, `R267_${String(label).toUpperCase()}_CATALOG_GET_FAILED`);
  assert.ok(Array.isArray(read.payload?.models), `R267_${String(label).toUpperCase()}_CATALOG_INVALID`);
}
const liveVideoModels = videoCatalogRead.payload.models;
const liveStoryboardVideoModels = storyboardVideoCatalogRead.payload.models;
const liveStoryboardImageModels = storyboardImageCatalogRead.payload.models;
const availableLiveVideoModels = liveVideoModels.filter((model) => model?.capabilities?.available === true);
const availableLiveStoryboardVideoModels = liveStoryboardVideoModels.filter((model) => model?.capabilities?.available === true);
const availableLiveStoryboardImageModels = liveStoryboardImageModels.filter((model) => model?.capabilities?.available === true);
assert.ok(liveVideoModels.length > 0 && availableLiveVideoModels.length > 0, "R267_VIDEO_CATALOG_HAS_NO_SELECTABLE_MODEL");
assert.ok(availableLiveStoryboardVideoModels.length > 0, "R267_STORYBOARD_VIDEO_CATALOG_HAS_NO_SELECTABLE_MODEL");
assert.ok(availableLiveStoryboardImageModels.length > 0, "R267_STORYBOARD_IMAGE_CATALOG_HAS_NO_SELECTABLE_MODEL");
assert.equal(new Set(liveVideoModels.map((model) => model.id)).size, liveVideoModels.length, "R267_VIDEO_MODEL_IDS_NOT_UNIQUE");

const browserUser = {
  id: String(customer.id),
  username: String(customer.username || customer.email || "r267-customer"),
  displayName: String(customer.displayName || customer.display_name || customer.username || "普通用户"),
  role: "student",
};

const imageModel = {
  id: "pm_r267_image_fixture",
  displayName: "R267 生图模型",
  variantLabel: "零付费验收",
  publicPrice: 0.2,
  capabilities: {
    available: true,
    priceReady: true,
    family: "gpt",
    defaultResolution: "1K",
    resolutionOptions: ["1K"],
    resolutionPrices: { "1K": 0.2 },
    aspectRatios: ["16:9", "9:16", "1:1"],
    supportsReferenceInput: true,
    maxReferenceImages: 1,
  },
};

const videoModel = {
  id: "pm_r267_video_fixture",
  displayName: "R267 图生视频模型",
  variantLabel: "零付费验收",
  publicPrice: 0.4,
  capabilities: {
    available: true,
    priceReady: true,
    supportsImageInput: true,
    requiresImage: true,
    requiresSourceVideo: false,
    requiresFirstFrame: false,
    requiresLastFrame: false,
    supportsAudioInput: false,
    workflowInputMode: "first_frame",
    workspaceSurfaces: ["storyboard"],
    aspectRatios: ["16:9", "9:16"],
    durationMode: "fixed",
    durationSeconds: 10,
    defaultDuration: 10,
    nativeDurations: [10],
    resolutionOptions: ["720p"],
    defaultResolution: "720p",
  },
};

function jsonFixture(route, status, payload) {
  return route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(payload),
  });
}

async function createScenarioPage(browser, name, handler) {
  const audit = {
    name,
    nonGetRequests: [],
    commerceRequests: [],
    externalRequests: [],
    pageErrors: [],
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, serviceWorkers: "block" });
  await context.addInitScript(({ token, user }) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("auth_token", token);
    localStorage.setItem("auth_user", JSON.stringify(user));
    sessionStorage.setItem("entered_app", "1");
  }, { token: customerToken, user: browserUser });

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
    if (url.origin !== parsedBaseUrl.origin) {
      audit.externalRequests.push({ method, url: url.href, reason: "external-origin" });
      await route.abort("blockedbyclient");
      return;
    }
    if (/^\/(?:api\/)?commerce(?:\/|$)/iu.test(url.pathname)) {
      audit.commerceRequests.push({ method, path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      audit.nonGetRequests.push({ method, path: url.pathname });
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await jsonFixture(route, 200, { user: browserUser });
      return;
    }
    if (await handler({ route, request, url, audit })) return;
    await route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", (error) => audit.pageErrors.push({ name: error.name, message: error.message }));
  return { context, page, audit };
}

function assertScenarioBoundary(audit) {
  assert.deepEqual(audit.nonGetRequests, [], `${audit.name} attempted a non-GET request`);
  assert.deepEqual(audit.commerceRequests, [], `${audit.name} attempted a Commerce request`);
  assert.deepEqual(audit.externalRequests, [], `${audit.name} attempted an external request`);
  assert.deepEqual(audit.pageErrors, [], `${audit.name} raised a page error`);
}

async function closeScenario(scenario) {
  await scenario.context.close();
  assertScenarioBoundary(scenario.audit);
}

const browser = await chromium.launch({ headless: true });
const results = {};
try {
  {
    const scenario = await createScenarioPage(browser, "live-video-storyboard-catalogs", async () => false);
    try {
      const videoResponse = await scenario.page.goto(`${baseUrl}/video`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(videoResponse?.status(), 200);
      const videoModelTrigger = scenario.page.getByRole("combobox", { name: "视频模型", exact: true });
      await videoModelTrigger.waitFor({ state: "visible", timeout: 20_000 });
      await videoModelTrigger.click();
      await scenario.page.waitForFunction(
        (expected) => document.querySelectorAll('[role="option"]').length === expected,
        liveVideoModels.length,
        { timeout: 20_000 },
      );
      const renderedVideoOptions = scenario.page.getByRole("option");
      assert.equal(await renderedVideoOptions.count(), liveVideoModels.length, "video page did not render the complete public catalog");
      assert.equal(
        await scenario.page.locator('[role="option"][aria-disabled="true"]').count(),
        liveVideoModels.length - availableLiveVideoModels.length,
        "video page disabled-model count differs from the public catalog",
      );
      await scenario.page.keyboard.press("Escape");

      const storyboardResponse = await scenario.page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(storyboardResponse?.status(), 200);
      const storyboardImageButtons = scenario.page.locator(".sbw-image-model-list button");
      const storyboardVideoButtons = scenario.page.locator(".sbw-video-model-list button");
      await storyboardImageButtons.first().waitFor({ state: "visible", timeout: 20_000 });
      await storyboardVideoButtons.first().waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await storyboardImageButtons.count(), availableLiveStoryboardImageModels.length);
      assert.equal(await storyboardVideoButtons.count(), availableLiveStoryboardVideoModels.length);

      const segmenterResponse = await scenario.page.goto(`${baseUrl}/segmenter`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(segmenterResponse?.status(), 200);
      const segmenterText = await scenario.page.locator("body").innerText();
      for (const forbidden of ["当前通道", "管理员免费", "管理员免扣费", "管理员免收", "模型："]) {
        assert.equal(segmenterText.includes(forbidden), false, `segmenter exposed customer-inappropriate text: ${forbidden}`);
      }

      results.liveCatalogs = {
        video: {
          total: liveVideoModels.length,
          selectable: availableLiveVideoModels.length,
          disabled: liveVideoModels.length - availableLiveVideoModels.length,
        },
        storyboard: {
          imageSelectable: availableLiveStoryboardImageModels.length,
          videoSelectable: availableLiveStoryboardVideoModels.length,
        },
        segmenterInternalCopyHidden: true,
      };
    } finally {
      await closeScenario(scenario);
    }
  }

  {
    let quoteReads = 0;
    const scenario = await createScenarioPage(browser, "voice-imitate-503-retry-200", async ({ route, url }) => {
      if (url.pathname === "/api/voice/imitation-quote") {
        quoteReads += 1;
        if (quoteReads === 1) {
          await jsonFixture(route, 503, { message: "音色模仿价格暂时无法读取" });
        } else {
          await jsonFixture(route, 200, { data: { unitPrice: 0.6, reserveCredits: 12 } });
        }
        return true;
      }
      if (url.pathname === "/api/voice/status") {
        await jsonFixture(route, 200, { data: { available: true, canSubmit: true, upstreamCalls: 0, creditsCharged: 0 } });
        return true;
      }
      if (url.pathname === "/api/voice/history") {
        await jsonFixture(route, 200, { data: { items: [], total: 0 } });
        return true;
      }
      return false;
    });
    try {
      const response = await scenario.page.goto(`${baseUrl}/voice-studio/imitate`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200);
      const alert = scenario.page.getByRole("alert").filter({ hasText: "已关闭提交" });
      await alert.waitFor({ state: "visible", timeout: 20_000 });
      const generationButton = scenario.page.getByRole("button", { name: /请先输入文案|请先选择参考音源|开始模仿/u });
      await generationButton.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await generationButton.isDisabled(), true, "voice imitation must fail closed after a quote 503");
      await alert.getByRole("button", { name: "重新读取价格", exact: true }).click();
      await scenario.page.getByText(/当前模型：Seed-Audio 1\.0 · ¥0\.6\/分钟/u).waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await alert.count(), 0, "voice quote error must clear after the successful retry");
      assert.equal(quoteReads, 2, "voice quote retry must perform exactly one new GET");
      results.voiceImitate = { quoteStatuses: [503, 200], quoteReads };
    } finally {
      await closeScenario(scenario);
    }
  }

  {
    let historyReads = 0;
    const scenario = await createScenarioPage(browser, "media-history-error-empty-exclusive", async ({ route, url }) => {
      if (url.pathname === "/api/media-history") {
        historyReads += 1;
        if (historyReads === 1) {
          await jsonFixture(route, 503, { error: "媒体历史加载失败，请稍后重试" });
        } else {
          await jsonFixture(route, 200, {
            items: [],
            totalCount: 0,
            sourceFailures: [],
            pagination: { hasMore: false, nextOffset: null },
          });
        }
        return true;
      }
      return false;
    });
    try {
      const response = await scenario.page.goto(`${baseUrl}/media-history`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200);
      await scenario.page.getByText("媒体历史暂时无法读取", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await scenario.page.getByText("暂无媒体记录", { exact: true }).count(), 0, "media error state must not stack the empty state");
      await scenario.page.getByRole("button", { name: "重新加载", exact: true }).click();
      await scenario.page.getByText("暂无媒体记录", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await scenario.page.getByText("媒体历史暂时无法读取", { exact: true }).count(), 0, "media empty state must not retain the error state");
      assert.equal(historyReads, 2, "media history retry must perform exactly one new GET");
      results.mediaHistory = { historyStatuses: [503, 200], historyReads, mutuallyExclusive: true };
    } finally {
      await closeScenario(scenario);
    }
  }

  async function storyboardScenario(name, catalogMode) {
    const reads = { image: 0, video: 0 };
    const scenario = await createScenarioPage(browser, name, async ({ route, url }) => {
      if (url.pathname === "/api/storyboard/projects") {
        await jsonFixture(route, 200, { projects: [], nextOffset: null });
        return true;
      }
      if (url.pathname === "/api/cover-models") {
        reads.image += 1;
        if (catalogMode === "recovery" && reads.image === 1) {
          await jsonFixture(route, 503, { error: "生图模型暂时无法读取" });
        } else {
          await jsonFixture(route, 200, { models: catalogMode === "empty" ? [] : [imageModel] });
        }
        return true;
      }
      if (url.pathname === "/api/video/models") {
        reads.video += 1;
        if (catalogMode === "recovery" && reads.video === 1) {
          await jsonFixture(route, 503, { error: "视频模型暂时无法读取" });
        } else {
          await jsonFixture(route, 200, { models: catalogMode === "empty" ? [] : [videoModel] });
        }
        return true;
      }
      return false;
    });
    try {
      const response = await scenario.page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200);
      if (catalogMode === "normal") {
        await scenario.page.locator(".sbw-image-model-list button").waitFor({ state: "visible", timeout: 20_000 });
        await scenario.page.locator(".sbw-video-model-list button").waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await scenario.page.locator(".sbw-image-model-list button").count(), 1);
        assert.equal(await scenario.page.locator(".sbw-video-model-list button").count(), 1);
      } else if (catalogMode === "empty") {
        await scenario.page.getByText("当前暂无可用生图模型", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
        await scenario.page.getByText("当前暂无可用视频模型", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await scenario.page.getByText("生图模型暂时无法读取", { exact: true }).count(), 0);
        assert.equal(await scenario.page.getByText("视频模型暂时无法读取", { exact: true }).count(), 0);
      } else {
        await scenario.page.getByText("生图模型暂时无法读取", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
        await scenario.page.getByText("视频模型暂时无法读取", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await scenario.page.getByText("当前暂无可用生图模型", { exact: true }).count(), 0);
        assert.equal(await scenario.page.getByText("当前暂无可用视频模型", { exact: true }).count(), 0);
        await scenario.page.getByRole("button", { name: "重新加载", exact: true }).first().click();
        await scenario.page.locator(".sbw-image-model-list button").waitFor({ state: "visible", timeout: 20_000 });
        await scenario.page.locator(".sbw-video-model-list button").waitFor({ state: "visible", timeout: 20_000 });
        assert.equal(await scenario.page.getByText("生图模型暂时无法读取", { exact: true }).count(), 0);
        assert.equal(await scenario.page.getByText("视频模型暂时无法读取", { exact: true }).count(), 0);
        assert.deepEqual(reads, { image: 2, video: 2 }, "one storyboard reload must re-read both catalogs exactly once");
      }
      return reads;
    } finally {
      await closeScenario(scenario);
    }
  }

  results.storyboard = {
    normal: await storyboardScenario("storyboard-catalog-normal", "normal"),
    empty: await storyboardScenario("storyboard-catalog-empty", "empty"),
    recovery: await storyboardScenario("storyboard-catalog-503-retry-200", "recovery"),
  };

  {
    const scenario = await createScenarioPage(browser, "cover-empty-brief-actions-disabled", async ({ route, url }) => {
      if (url.pathname === "/api/cover-models") {
        await jsonFixture(route, 200, { models: [imageModel] });
        return true;
      }
      if (url.pathname === "/api/cash/balance") {
        await jsonFixture(route, 200, { balance: 100 });
        return true;
      }
      if (url.pathname === "/api/cover/history") {
        await jsonFixture(route, 200, {
          records: [],
          nextPage: null,
          failureHistory: { ready: true, message: "" },
        });
        return true;
      }
      return false;
    });
    try {
      const response = await scenario.page.goto(`${baseUrl}/cover`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      assert.equal(response?.status(), 200);
      const brief = scenario.page.getByRole("textbox", { name: "输入文案", exact: true });
      await brief.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await brief.inputValue(), "");
      const analyze = scenario.page.getByRole("button", { name: "分析并生成封面方案", exact: true });
      const generate = scenario.page.getByRole("button", { name: "生成新封面", exact: true });
      await analyze.waitFor({ state: "visible", timeout: 20_000 });
      await generate.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await analyze.isDisabled(), true, "cover analysis action must be disabled for an empty brief");
      assert.equal(await generate.isDisabled(), true, "cover generation action must be disabled for an empty brief");
      results.cover = { emptyBrief: true, analyzeDisabled: true, generateDisabled: true };
    } finally {
      await closeScenario(scenario);
    }
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({
  verifier: "r267-customer-surfaces-zero-cost",
  passed: true,
  baseUrl,
  customer: { id: browserUser.id, role: browserUser.role },
  storageFiles: {
    status: storageRead.response.status,
    returned: storageRead.payload.files.length,
    forbiddenKeys: [...forbiddenStorageKeys],
    leakedKeys: leakedStorageKeys,
  },
  boundaries: {
    allowedMethods: ["GET", "HEAD", "OPTIONS"],
    realPostRequests: 0,
    providerGenerationRequests: 0,
    paidRequests: 0,
    commerceRequests: 0,
    externalRequests: 0,
    databaseWrites: 0,
  },
  results,
}, null, 2));
