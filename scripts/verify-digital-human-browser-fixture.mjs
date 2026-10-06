import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Current-page browser acceptance with isolated API fixtures. Upload,
// generation, polling, history, preview and download requests never leave the
// browser context, so this proves UI/runtime contracts without a provider call,
// database write or charge.
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_ORIGIN_REQUIRED");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
assert.ok(token, "NORMAL_SESSION_REQUIRED");
const identity = JSON.parse(String(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}"));
assert.ok(identity?.user?.id && identity?.user?.role === "admin", "LOCAL_ADMIN_IDENTITY_REQUIRED");

const outputDir = path.resolve(
  ".codex-evidence",
  "digital-human-browser-fixture-20260930",
  new Date().toISOString().replace(/[:.]/gu, "-"),
);
await mkdir(outputDir, { recursive: true });

const personId = "11111111-1111-4111-8111-111111111111";
const audioId = "22222222-2222-4222-8222-222222222222";
const model = {
  id: "fixture-photo-human-current",
  displayName: "验收照片数字人",
  publicPrice: 0.1,
  capabilities: {
    available: true,
    generationReady: true,
    requiresSourceVideo: false,
    defaultResolution: "480p",
    resolutionOptions: ["480p"],
    billingUnit: "output_second",
    durationMode: "range",
    minDuration: 1,
    maxDuration: 120,
    defaultDuration: 4,
    durationStep: 0.1,
    supportsVideoExtension: false,
  },
};
const personAsset = {
  id: personId,
  category: "image",
  url: "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%232f6f73'/%3E%3Ccircle cx='320' cy='250' r='120' fill='%23f4d5bd'/%3E%3C/svg%3E",
  duration: 0,
  width: 640,
  height: 640,
  size: 1024,
};
const audioAsset = {
  id: audioId,
  category: "audio",
  url: "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
  duration: 2.5,
  width: 0,
  height: 0,
  size: 44,
};
const failedHistory = {
  id: "fixture-failed-business",
  clientRequestId: "digital-fixture-failed",
  taskIdExternal: "fixture-failed-task",
  publicModelId: model.id,
  modelName: model.displayName,
  taskLabel: "digital-human:photo",
  status: "failed",
  errorMessage: "验收失败：人物素材未通过生成检查，本次未扣费",
  createdAt: "2026-09-30T01:00:00.000Z",
  resolution: "480p",
  durationSeconds: 2.5,
  priceCharged: 0,
  videoUrl: "",
  canRetry: true,
  retrySource: { personAssetId: personId, audioAssetId: audioId, durationChoice: "" },
};

const report = {
  checkedAt: new Date().toISOString(),
  origin,
  scope: "real current page with isolated API fixtures",
  fixtureMutations: [],
  escapedMutations: [],
  generationBodies: [],
  statusReads: 0,
  historyReads: 0,
  previewReads: 0,
  downloadReads: 0,
  pageErrors: [],
  providerRequests: 0,
  databaseWrites: 0,
  paidRequests: 0,
  passed: false,
};

let historyReady = false;
let generatedRequestId = "";
const completedHistory = () => ({
  id: "fixture-completed-business",
  clientRequestId: generatedRequestId,
  taskIdExternal: "fixture-completed-task",
  publicModelId: model.id,
  modelName: model.displayName,
  taskLabel: "digital-human:photo",
  status: "completed",
  errorMessage: "",
  createdAt: new Date().toISOString(),
  resolution: "480p",
  durationSeconds: 2.5,
  priceCharged: 0.25,
  videoUrl: "/fixture/digital-human-result.mp4",
  canRetry: false,
});

const json = (route, value, status = 200, headers = {}) => route.fulfill({
  status,
  contentType: "application/json",
  headers,
  body: JSON.stringify(value),
});

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: "block" });
  await context.addCookies([{ name: "auth_token", value: token, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await context.addInitScript(({ sessionToken, account }) => {
    localStorage.setItem("auth_token", sessionToken);
    localStorage.setItem("auth_user", JSON.stringify(account));
    sessionStorage.setItem("entered_app", "1");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("digital-human:")) localStorage.removeItem(key);
    }
  }, { sessionToken: token, account: identity.user });

  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method().toUpperCase();
    if (url.origin !== origin) return route.abort("blockedbyclient");

    if (url.pathname === "/api/video/models" && url.searchParams.get("surface") === "digital-human") {
      return json(route, { models: [model] });
    }
    if (url.pathname === "/api/cash/balance") return json(route, { balance: 88.88 });
    if (url.pathname === "/api/video/history" && method === "GET") {
      report.historyReads += 1;
      return json(route, { tasks: historyReady ? [completedHistory(), failedHistory] : [failedHistory], nextOffset: null });
    }
    if (url.pathname === "/api/digital-human/long-history" && method === "GET") {
      report.historyReads += 1;
      return json(route, { tasks: [], nextOffset: null });
    }
    if (url.pathname === "/api/digital-human/upload-ticket" && method === "POST") {
      const body = request.postDataJSON();
      const asset = body.category === "audio" ? audioAsset : personAsset;
      report.fixtureMutations.push({ path: url.pathname, category: body.category, mode: "completed" });
      return json(route, { mode: "completed", asset });
    }
    if (url.pathname === "/api/digital-human/generate" && method === "POST") {
      const body = request.postDataJSON();
      generatedRequestId = String(body.clientRequestId || "");
      historyReady = true;
      report.generationBodies.push(body);
      report.fixtureMutations.push({ path: url.pathname, requestId: generatedRequestId });
      return json(route, {
        task_id: "fixture-completed-task",
        business_task_id: "fixture-completed-business",
        status: "queued",
      });
    }
    if (url.pathname === "/api/video/status" && method === "GET") {
      report.statusReads += 1;
      return json(route, {
        status: "completed",
        priceCharged: 0.25,
        videoUrl: "/fixture/digital-human-result.mp4",
      });
    }
    if (url.pathname === "/api/digital-human/assets" && method === "GET") {
      return json(route, { assets: [personAsset, audioAsset] });
    }
    if (url.pathname === "/api/video/access-ticket" && method === "GET") {
      report.downloadReads += 1;
      return json(route, { url: "/fixture/digital-human-download.mp4" });
    }
    if (url.pathname === "/fixture/digital-human-result.mp4") {
      report.previewReads += 1;
      return route.fulfill({ status: 200, contentType: "video/mp4", body: Buffer.from("fixture-preview") });
    }
    if (url.pathname === "/fixture/digital-human-download.mp4") {
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        headers: { "Content-Disposition": "attachment; filename=digital-human-fixture.mp4" },
        body: Buffer.from("fixture-download"),
      });
    }
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      report.escapedMutations.push({ method, path: url.pathname });
      return json(route, { error: "Fixture blocks real mutation" }, 503);
    }
    return route.continue();
  });

  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));
  const response = await page.goto(`${origin}/digital-human`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  assert.equal(response?.status(), 200, "DIGITAL_HUMAN_PAGE_HTTP_FAILED");
  await page.getByLabel("数字人工作区").waitFor({ state: "visible", timeout: 30_000 });
  await page.getByRole("tab", { name: /照片说话/ }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector('select[aria-label="数字人模型"]')?.value === "fixture-photo-human-current");
  assert.equal(await page.getByRole("tab", { name: /照片说话/ }).getAttribute("aria-selected"), "true");

  await page.getByLabel("上传人物照片").setInputFiles({
    name: "fixture-person.png",
    mimeType: "image/png",
    buffer: Buffer.from("89504e470d0a1a0a", "hex"),
  });
  await page.getByAltText("已上传的人物照片").waitFor({ state: "visible" });
  await page.getByRole("tab", { name: "上传现成音频", exact: true }).click();
  await page.getByLabel("上传配音音频").setInputFiles({
    name: "fixture-voice.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from("524946462400000057415645666d7420", "hex"),
  });
  await page.getByLabel("试听上传配音").waitFor({ state: "attached" });
  assert.equal(await page.getByLabel("数字人模型").inputValue(), model.id);
  assert.equal(await page.getByLabel("数字人画质").inputValue(), "480p");

  const submit = page.getByRole("button", { name: "生成数字人视频", exact: true });
  await submit.waitFor({ state: "visible" });
  assert.equal(await submit.isEnabled(), true, "READY_DIGITAL_HUMAN_SUBMIT_DISABLED");
  await page.screenshot({ path: path.join(outputDir, "digital-human-input-ready.png"), fullPage: true });
  await submit.click();
  await page.waitForFunction(() => document.body.innerText.includes("已完成"), undefined, { timeout: 20_000 });
  assert.equal(report.generationBodies.length, 1, "GENERATION_MUST_SUBMIT_ONCE");
  assert.deepEqual(
    {
      mode: report.generationBodies[0].mode,
      modelId: report.generationBodies[0].modelId,
      resolution: report.generationBodies[0].resolution,
      personAssetId: report.generationBodies[0].personAssetId,
      audioAssetId: report.generationBodies[0].audioAssetId,
    },
    { mode: "photo", modelId: model.id, resolution: "480p", personAssetId: personId, audioAssetId: audioId },
  );
  assert.match(String(report.generationBodies[0].clientRequestId), /^digital-/u);
  assert.ok(report.statusReads >= 1, "TERMINAL_STATUS_WAS_NOT_POLLED");

  const completed = page.getByLabel("数字人生成记录").locator("article").filter({ hasText: "已完成" }).first();
  await completed.waitFor({ state: "visible" });
  await completed.getByRole("button", { name: `加载并播放${model.displayName}生成视频` }).click();
  await completed.getByLabel(`${model.displayName}生成视频`).waitFor({ state: "attached" });
  const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
  await completed.getByRole("button", { name: "下载视频", exact: true }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /digital-human-fixture\.mp4|照片说话-\d{4}-\d{2}-\d{2}\.mp4/u);
  await page.screenshot({ path: path.join(outputDir, "digital-human-output-history.png"), fullPage: true });

  const failed = page.getByLabel("数字人生成记录").locator("article").filter({ hasText: "验收失败：人物素材未通过生成检查" });
  await failed.waitFor({ state: "visible" });
  await failed.getByRole("button", { name: "载入原参数", exact: true }).click();
  await page.getByText(/已重新核验并载入原模型、画质和本人素材/u).waitFor({ state: "visible" });
  assert.equal(report.generationBodies.length, 1, "FAILURE_RESTORE_MUST_NOT_RESUBMIT");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `DIGITAL_HUMAN_HORIZONTAL_OVERFLOW_${overflow}`);
  assert.equal(report.escapedMutations.length, 0, `REAL_MUTATION_ESCAPED_FIXTURE: ${JSON.stringify(report.escapedMutations)}`);
  assert.deepEqual(report.pageErrors, [], "DIGITAL_HUMAN_PAGE_ERRORS");
  assert.equal(report.fixtureMutations.filter(item => item.path === "/api/digital-human/upload-ticket").length, 2);
  assert.equal(report.downloadReads, 1);
  await page.screenshot({ path: path.join(outputDir, "digital-human-complete-and-failure.png"), fullPage: true });

  report.passed = true;
  report.result = {
    uploads: 2,
    generationSubmissions: 1,
    terminalPolls: report.statusReads,
    historyReads: report.historyReads,
    previewVisible: true,
    downloadVerified: true,
    failureRestoreWithoutSubmit: true,
    horizontalOverflow: overflow,
  };
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ passed: true, evidenceDir: outputDir, ...report.result }));
  await context.close();
} finally {
  await browser.close();
}
