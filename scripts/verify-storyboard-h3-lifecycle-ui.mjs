import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const selfhostId = "pm_tabUjazl2a7DJ2POEriC-Ogo";
const taskId = "h3q_0123456789abcdef";
let instancePhase = "idle";
let lifecycleRequests = 0;

const review = {
  reviewId: "h3-lifecycle-zero-network",
  run: {
    id: "h3-lifecycle-zero-network",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ratio: "16:9",
    imageResolution: "2K",
    videoResolution: "2K",
    videoDuration: 10,
    imageModelId: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
    videoModelId: selfhostId,
    videoContract: { modelId: selfhostId, resolution: "2K", duration: 10, ratio: "16:9" },
    title: "H3生命周期零网络验收",
    cards: [{
      id: "shot-1",
      order: 1,
      narration: "零网络生命周期验收",
      imagePrompt: "test",
      videoPrompt: "test",
      referenceImageUrls: [],
      imageStatus: "done",
      imageUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      imageValidatedAt: Date.now(),
      videoStatus: "done",
      videoTaskId: taskId,
      videoTaskModelId: selfhostId,
      videoStartedAt: Date.now() - 20_000,
      videoStatusDetail: "不应展示的旧详情",
    }],
  },
};

const imageModels = [{
  id: "pm_HabdJ5rvD_L3-HUkfMUmGsrm",
  displayName: "GPT-Image-2 · 渠道A pro",
  publicPrice: 0.2,
  capabilities: {
    family: "gpt",
    resolutionOptions: ["2K"],
    defaultResolution: "2K",
    aspectRatios: ["16:9"],
    supportsReferenceInput: true,
    maxReferenceImages: 5,
  },
}];

const videoModels = [{
  id: selfhostId,
  displayName: "MiniMax H3 Turbo · 自租实例",
  publicPrice: 0,
  capabilities: {
    supportsImageInput: true,
    requiresImage: true,
    requiresSourceVideo: false,
    workspaceSurfaces: ["storyboard"],
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
}];

function lifecycle() {
  const poweredOff = instancePhase === "off";
  return {
    taskId,
    taskState: "SUCCEEDED",
    taskLabel: "视频生成成功",
    instanceState: poweredOff ? "OFF" : "IDLE_GRACE",
    instanceLabel: poweredOff ? "实例已关机" : "空闲倒计时 04:30",
    headline: poweredOff ? "视频生成成功 · 实例已关机" : "视频生成成功 · 空闲倒计时 04:30",
    detail: poweredOff ? "AutoDL 已确认实例处于关机状态" : "当前无排队、生成或转存任务",
    tone: poweredOff ? "muted" : "warning",
    progress: null,
    idleGraceSeconds: 300,
    idleRemainingSeconds: poweredOff ? null : 270,
    taskTerminal: true,
    monitorComplete: poweredOff,
    observedAt: new Date().toISOString(),
  };
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  const paidRequests = [];
  const externalRequests = [];
  const browserErrors = [];
  const failedResponses = [];

  await page.addInitScript(() => localStorage.setItem("auth_token", "zero-network-test-token"));
  page.on("request", (request) => {
    if (request.url().includes("/api/video/generate")) paidRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push({ url: response.url(), status: response.status() });
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol === "data:") {
      await route.continue();
      return;
    }
    if (url.origin !== new URL(baseUrl).origin) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    if (url.pathname === "/api/cover-models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: imageModels }) });
      return;
    }
    if (url.pathname === "/api/auth/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "zero-network-user", role: "admin" } }),
      });
      return;
    }
    if (url.pathname === "/api/credits") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ credits: 0, cashBalance: 0, transactions: [] }),
      });
      return;
    }
    if (url.pathname === "/api/conversations/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ conversations: [] }) });
      return;
    }
    if (url.pathname === "/api/video/models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: videoModels }) });
      return;
    }
    if (url.pathname === "/api/video/history") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ tasks: [] }) });
      return;
    }
    if (url.pathname === "/api/video/h3-lifecycle") {
      lifecycleRequests += 1;
      assert.equal(url.searchParams.get("taskId"), taskId);
      assert.match(route.request().headers().authorization || "", /^Bearer /u);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ lifecycle: lifecycle() }) });
      return;
    }
    if (url.pathname === "/storyboard-reviews/h3-lifecycle-zero-network.json") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(review) });
      return;
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/storyboard-workbench?review=h3-lifecycle-zero-network`, {
    waitUntil: "networkidle",
    timeout: 60_000,
  });
  const lifecyclePanel = page.locator(".sbw-h3-lifecycle");
  await lifecyclePanel.getByText("自租 H3 全链路", { exact: true }).waitFor();
  await lifecyclePanel.getByText("视频生成成功 · 空闲倒计时 04:30", { exact: true }).waitFor({
    state: "visible",
    timeout: 15_000,
  });
  assert.equal(await lifecyclePanel.getAttribute("data-task-state"), "SUCCEEDED");
  assert.equal(await lifecyclePanel.getAttribute("data-instance-state"), "IDLE_GRACE");
  assert.equal((await lifecyclePanel.textContent())?.includes("95%"), false, "legacy 95% placeholder must not render");

  instancePhase = "off";
  await lifecyclePanel.getByText("视频生成成功 · 实例已关机", { exact: true }).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  assert.equal(await lifecyclePanel.getAttribute("data-instance-state"), "OFF");
  const requestCountAtOff = lifecycleRequests;
  await page.waitForTimeout(2_500);
  assert.equal(lifecycleRequests, requestCountAtOff, "monitor must stop after task terminal + instance OFF");

  assert.equal(paidRequests.length, 0);
  assert.equal(externalRequests.length, 0);
  assert.deepEqual(browserErrors, [], `browser errors: ${browserErrors.join(" | ")}; failed responses: ${JSON.stringify(failedResponses)}`);
  console.log(JSON.stringify({
    status: "passed",
    idleCountdownVisible: true,
    poweredOffVisible: true,
    monitorStoppedAtOff: true,
    fake95PercentVisible: false,
    paidCalls: 0,
    externalRequests: 0,
    lifecycleRequests,
  }));
} finally {
  await browser.close();
}
