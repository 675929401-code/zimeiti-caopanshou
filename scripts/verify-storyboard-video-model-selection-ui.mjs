import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT } from "jose";
import { chromium } from "playwright";

dotenv.config({ path: ".env.local", quiet: true });

async function closeWithTimeout(closeable, label, timeoutMs = 3_000) {
  let timer;
  await Promise.race([
    closeable.close().catch((error) => {
      console.error(`[storyboard-video-model-selection] ${label} failed: ${error instanceof Error ? error.message : String(error)}`);
    }),
    new Promise((resolve) => {
      timer = setTimeout(() => {
        console.error(`[storyboard-video-model-selection] ${label} timed out after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const selfhostId = "pm_tabUjazl2a7DJ2POEriC-Ogo";
const hostedId = "pm_jfLkovd9VRdje8VB9zaEIsgk";
const screenshotPath = path.resolve(".codex-screenshots/storyboard-video-model-selection-unlocked.png");

async function createReadOnlyLocalToken() {
  for (const name of ["JWT_SECRET", "COZE_SUPABASE_URL", "COZE_SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.ok(process.env[name], `missing ${name} for authenticated local UI verification`);
  }
  const db = createClient(process.env.COZE_SUPABASE_URL, process.env.COZE_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const result = await db
    .from("users")
    .select("id,username,email,display_name,role")
    .eq("role", "admin")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  assert.equal(result.error, null, result.error?.message || "local acceptance account lookup failed");
  assert.ok(result.data, "no active local administrator is available for read-only UI verification");
  return new SignJWT({
    userId: result.data.id,
    username: result.data.username || result.data.email || "local-acceptance",
    displayName: result.data.display_name || "本地验收",
    role: result.data.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
}

const imageModels = [{
  id: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
  displayName: "GPT-Image-2 · 渠道A pro",
  name: "GPT-Image-2 · 渠道A pro",
  model_name: "gpt-image-2",
  publicPrice: 0.2,
  capabilities: {
    family: "gpt",
    resolutionOptions: ["1K", "2K"],
    defaultResolution: "2K",
    aspectRatios: ["16:9", "9:16", "1:1"],
    supportsReferenceInput: true,
    maxReferenceImages: 5,
  },
}];

const sharedVideoCapabilities = {
  supportsImageInput: true,
  requiresImage: true,
  requiresSourceVideo: false,
  workspaceSurfaces: ["storyboard"],
  aspectRatios: ["16:9", "9:16"],
};
const videoModels = [
  {
    id: hostedId,
    displayName: "MiniMax H3 · 多图参考（AutoDL 在线）",
    publicPrice: 0.07,
    capabilities: {
      ...sharedVideoCapabilities,
      durationMode: "range",
      defaultDuration: 10,
      minDuration: 1,
      maxDuration: 10,
      resolutionOptions: ["480p", "768p", "1080p"],
      defaultResolution: "768p",
      resolutionPrices: ["480p=0.01", "768p=0.01", "1080p=0.10"],
      billingUnit: "output_second",
    },
  },
  {
    id: selfhostId,
    displayName: "MiniMax H3 Turbo · 自租实例（480p 原生 / 1080p增强 / 2K增强）",
    publicPrice: 0,
    capabilities: {
      ...sharedVideoCapabilities,
      aspectRatios: ["16:9"],
      durationMode: "discrete",
      defaultDuration: 10,
      minDuration: 5,
      maxDuration: 15,
      nativeDurations: [5, 10, 15],
      resolutionOptions: ["480p", "1080p", "2K"],
      defaultResolution: "480p",
      billingUnit: "per_use",
    },
  },
  {
    id: "fixed-15",
    displayName: "固定15秒模型",
    publicPrice: 1,
    capabilities: {
      ...sharedVideoCapabilities,
      durationMode: "fixed",
      defaultDuration: 15,
      minDuration: 15,
      maxDuration: 15,
      nativeDurations: [15],
      resolutionOptions: ["1080p"],
      defaultResolution: "1080p",
    },
  },
  {
    id: "vertical-only",
    displayName: "仅竖屏10秒模型",
    publicPrice: 1,
    capabilities: {
      ...sharedVideoCapabilities,
      aspectRatios: ["9:16"],
      durationMode: "fixed",
      defaultDuration: 10,
      minDuration: 10,
      maxDuration: 10,
      nativeDurations: [10],
      resolutionOptions: ["1080p"],
      defaultResolution: "1080p",
    },
  },
  {
    id: "source-video-only",
    displayName: "源视频编辑模型",
    publicPrice: 1,
    capabilities: {
      ...sharedVideoCapabilities,
      requiresSourceVideo: true,
      durationMode: "fixed",
      defaultDuration: 10,
      minDuration: 10,
      maxDuration: 10,
      nativeDurations: [10],
    },
  },
  {
    id: "first-last-only",
    displayName: "MiniMax H3 · 首尾帧（AutoDL 在线）",
    publicPrice: 0.01,
    capabilities: {
      ...sharedVideoCapabilities,
      durationMode: "fixed",
      defaultDuration: 10,
      minDuration: 10,
      maxDuration: 10,
      nativeDurations: [10],
      resolutionOptions: ["768p"],
      defaultResolution: "768p",
    },
  },
  {
    id: "audio-workflow-only",
    displayName: "MiniMax H3 · 多图多音频（AutoDL 在线新协议）",
    publicPrice: 0.01,
    capabilities: {
      ...sharedVideoCapabilities,
      supportsAudioInput: true,
      durationMode: "fixed",
      defaultDuration: 10,
      minDuration: 10,
      maxDuration: 10,
      nativeDurations: [10],
      resolutionOptions: ["768p"],
      defaultResolution: "768p",
    },
  },
];

const token = process.env.LOCAL_NAV_ADMIN_TOKEN?.trim() || await createReadOnlyLocalToken();
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const paidRequests = [];
  const externalRequests = [];
  const browserErrors = [];
  const interceptedStoryboardWrites = [];

  page.on("request", (request) => {
    if (request.url().includes("/api/video/generate")) paidRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseUrl).origin) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname === "/api/cover-models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: imageModels }) });
      return;
    }
    if (url.pathname === "/api/video/models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: videoModels }) });
      return;
    }
    if (url.pathname === "/api/storyboard/projects") {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projects: [], nextOffset: null }) });
        return;
      }
      interceptedStoryboardWrites.push(route.request().method());
      const requestBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          project: {
            id: requestBody?.document?.id || "storyboard-contract-e2e",
            revision: 1,
            title: requestBody?.document?.title || "分镜浏览器验收",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.addInitScript(({ selfhostId, imageModelId, tokenValue }) => {
    localStorage.setItem("auth_token", tokenValue);
    const tokenPayload = tokenValue.split(".")[1].replace(/-/gu, "+").replace(/_/gu, "/");
    const claims = JSON.parse(atob(tokenPayload.padEnd(Math.ceil(tokenPayload.length / 4) * 4, "=")));
    const currentStorageKey = `storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(claims.userId)}`;
    const now = Date.now();
    localStorage.setItem(currentStorageKey, JSON.stringify({
      id: "storyboard-draft-model-contract-e2e",
      createdAt: now,
      updatedAt: now,
      ratio: "16:9",
      imageResolution: "2K",
      videoResolution: "2K",
      videoDuration: 10,
      imageModelId,
      videoModelId: selfhostId,
      videoContract: { modelId: selfhostId, resolution: "2K", duration: 10, ratio: "16:9" },
      title: "分镜草稿模型合同验收",
      cards: [{
        id: "storyboard-draft-model-contract-card-1",
        order: 1,
        narration: "",
        imagePrompt: "",
        videoPrompt: "",
        referenceImageUrls: [],
        imageStatus: "idle",
        videoStatus: "failed",
        videoTaskId: "old-provider-task-id",
        videoTaskModelId: selfhostId,
        videoTaskModelName: "旧模型失败任务",
        videoClientRequestFingerprint: "old-request-fingerprint",
        videoError: "旧模型上游错误，不应跟随新模型",
        videoStatusDetail: "旧模型失败详情",
        videoProgress: 67,
      }],
    }));
  }, { selfhostId, imageModelId: imageModels[0].id, tokenValue: token });

  await page.goto(`${baseUrl}/storyboard-workbench`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  await page.getByText("图生视频模型", { exact: true }).waitFor({ state: "visible", timeout: 30_000 });
  const modelCountLabel = page.locator(".sbw-video-model-section header small");
  await modelCountLabel.waitFor({ state: "visible" });
  await page.waitForTimeout(1_000);
  const modelCountText = await modelCountLabel.textContent();
  const visibleModelLabels = await page.locator(".sbw-video-model-list button").evaluateAll((buttons) => (
    buttons.map((button) => button.getAttribute("aria-label") || button.textContent || "").map((value) => value.trim())
  ));
  assert.equal(
    modelCountText,
    "4 个可选",
    `unexpected storyboard model partition: ${modelCountText}; visible=${visibleModelLabels.join(" | ")}`,
  );

  const selfhost = page.getByRole("button", { name: /选择视频模型：MiniMax H3 Turbo · 自租实例/u });
  const hosted = page.getByRole("button", { name: /选择视频模型：MiniMax H3 · 多图参考/u });
  const fixed15 = page.getByRole("button", { name: /选择视频模型：固定15秒模型/u });
  const vertical = page.getByRole("button", { name: /选择视频模型：仅竖屏10秒模型/u });
  assert.equal(await selfhost.count(), 1);
  assert.equal(await hosted.count(), 1);
  assert.equal(await selfhost.isDisabled(), false);
  assert.equal(await hosted.isDisabled(), false);
  assert.equal(await fixed15.isDisabled(), false);
  assert.equal(await vertical.isDisabled(), false);
  assert.equal(await page.getByText("源视频编辑模型", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /首尾帧/u }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /多图多音频/u }).count(), 0);
  assert.ok((await selfhost.getAttribute("class"))?.includes("is-active"), "current draft must restore self-host H3");

  const resolution = page.getByLabel("视频分辨率");
  const duration = page.getByLabel("视频时长");
  assert.equal(await resolution.inputValue(), "2K", "current draft contract must restore self-host 2K");
  assert.equal(await duration.inputValue(), "10");
  assert.equal(await resolution.isDisabled(), true, "recommended preset stays fixed until a manual model switch");

  await hosted.click();
  await page.waitForTimeout(700);
  assert.ok((await hosted.getAttribute("class"))?.includes("is-active"), "hosted H3 must be manually selectable");
  assert.equal(await resolution.inputValue(), "768p", "unsupported 2K should fall back to hosted default");
  assert.equal(await resolution.isDisabled(), false, "manual alternative unlocks its resolution selector");
  assert.equal(await duration.inputValue(), "10");
  const switchedDraft = await page.evaluate(() => {
    const tokenValue = localStorage.getItem("auth_token") || "";
    const raw = tokenValue.split(".")[1]?.replace(/-/gu, "+").replace(/_/gu, "/") || "";
    const claims = JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, "=")));
    const storageKey = `storyboard_prompt_workbench_current_v2:user:${encodeURIComponent(claims.userId)}`;
    return JSON.parse(localStorage.getItem(storageKey) || "null");
  });
  const switchedCard = switchedDraft?.cards?.[0];
  assert.equal(switchedCard?.videoStatus, "idle", "switching models must return an old failed card to idle");
  assert.equal(switchedCard?.videoTaskId, undefined, "switching models must remove the old provider task id");
  assert.equal(switchedCard?.videoTaskModelId, undefined, "switching models must remove the old model binding");
  assert.equal(switchedCard?.videoClientRequestFingerprint, undefined, "switching models must remove the old request fingerprint");
  assert.equal(switchedCard?.videoError, undefined, "switching models must remove the old provider error");
  assert.equal(switchedCard?.videoStatusDetail, undefined, "switching models must remove the old failure detail");
  assert.equal(switchedCard?.videoProgress, undefined, "switching models must remove the old progress");

  await vertical.click();
  assert.equal(await page.getByRole("button", { name: "9:16" }).getAttribute("class"), "is-active", "invalid ratio must be corrected");
  assert.deepEqual(await page.locator(".sbw-control-group.is-video .sbw-fixed-param").allTextContents(), ["1080p", "固定 10 秒"]);

  await fixed15.click();
  assert.deepEqual(
    await page.locator(".sbw-control-group.is-video .sbw-fixed-param").allTextContents(),
    ["1080p", "固定 15 秒"],
    "invalid duration must be corrected to fixed capability",
  );

  await selfhost.click();
  assert.ok((await selfhost.getAttribute("class"))?.includes("is-active"), "self-host H3 must be selectable again");
  assert.equal(await resolution.inputValue(), "2K", "returning to the recommended self-host model must restore 2K, not 480p");
  assert.equal(await duration.inputValue(), "10");
  assert.equal(await resolution.isDisabled(), true);
  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: false });

  assert.deepEqual(paidRequests, [], "UI regression must never submit a video generation request");
  assert.deepEqual(externalRequests, [], `UI regression must not access external hosts: ${externalRequests.join(" | ")}`);
  assert.deepEqual(browserErrors, [], `UI regression browser errors: ${browserErrors.join(" | ")}`);
  console.log(JSON.stringify({
    status: "passed",
    defaultModel: selfhostId,
    defaultResolution: "2K",
    compatibleAlternativeSelectable: true,
    incompatibleDurationCorrected: true,
    incompatibleRatioCorrected: true,
    sourceVideoModelHidden: true,
    firstLastFrameModelHidden: true,
    audioWorkflowModelHidden: true,
    oldFailedTaskClearedOnModelSwitch: true,
    paidCalls: 0,
    persistentBusinessWrites: 0,
    interceptedStoryboardWrites: interceptedStoryboardWrites.length,
    externalRequests: 0,
    screenshot: screenshotPath,
  }));
} finally {
  await closeWithTimeout(browser, "browser.close");
}
process.exit(0);
