#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { computeLocalBuildFingerprint } from "./local-build-fingerprint.mjs";

const sourceOnly = process.argv.includes("--source-only");
if (sourceOnly) {
  const component = await fs.readFile(path.resolve("src/components/demo/experience-flow-demo.tsx"), "utf8");
  const css = await fs.readFile(path.resolve("src/components/demo/experience-flow-demo.module.css"), "utf8");
  assert.match(component, /data-task-id=\{item\.id\}/u, "每个任务 ID 必须暴露稳定交互定位");
  assert.match(component, /aria-label=\{`复制任务 ID \$\{item\.id\}`\}/u, "复制按钮必须有可访问名称");
  assert.match(component, /navigator\.clipboard\.writeText\(taskId\)/u, "任务 ID 必须调用剪贴板复制");
  assert.match(component, /document\.execCommand\("copy"\)/u, "剪贴板不可用时必须有本地回退");
  assert.match(component, /role="status" aria-live="polite"/u, "复制结果必须向辅助技术播报");
  for (const status of ["已确定", "模拟验收", "待真实链路"]) {
    assert.match(component, new RegExp(`status: "${status}"`, "u"), `缺少任务状态:${status}`);
    assert.match(css, new RegExp(`data-status="${status}"`, "u"), `状态缺少独立样式:${status}`);
  }
  assert.match(css, /\.taskIdButton:focus-visible/u, "键盘用户必须看到任务 ID 焦点");
  assert.doesNotMatch(component, /fetch\s*\(|\/api\//u, "Demo 组件不得调用 API");
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "source-only", checks: 12, apiCalls: 0, backendWrites: 0 }, null, 2)}\n`);
  process.exit(0);
}

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
assert.match(origin, /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u, "LOCAL_ONLY_ORIGIN_REQUIRED");

const runStamp = new Date().toISOString().replace(/[:.]/gu, "-");
const evidenceDir = path.resolve(".codex-evidence", "local-experience-demo", runStamp);
await fs.mkdir(evidenceDir, { recursive: true });

const [versionResponse, receipt, diskBuildId, currentFingerprint] = await Promise.all([
  fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(15_000) }),
  fs.readFile(path.resolve(".next", "local-source-fingerprint.v1.json"), "utf8").then(JSON.parse),
  fs.readFile(path.resolve(".next", "BUILD_ID"), "utf8").then((value) => value.trim()),
  Promise.resolve(computeLocalBuildFingerprint(process.cwd())),
]);
assert.equal(versionResponse.ok, true, `VERSION_HTTP_${versionResponse.status}`);
const version = await versionResponse.json();
const servedBuildId = version.buildId || version.version || "";
const runningLatest = receipt?.fingerprint === currentFingerprint.fingerprint
  && receipt?.fileCount === currentFingerprint.fileCount
  && receipt?.buildId === diskBuildId
  && servedBuildId === diskBuildId;
assert.equal(runningLatest, true, "RUNTIME_NOT_LATEST");

const report = {
  ok: false,
  checkedAt: new Date().toISOString(),
  origin,
  sourceVersion: version.sourceVersion || null,
  buildId: version.buildId || version.version || null,
  runningLatest,
  firstTokenMs: null,
  streamSamples: [],
  observedVideoStages: [],
  copiedTaskIds: [],
  apiRequests: [],
  writeRequests: [],
  externalRequests: [],
  consoleErrors: [],
  pageErrors: [],
  paidCalls: 0,
  productionWrites: 0,
};

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await context.addInitScript(() => {
    window.__demoFullscreenTarget = null;
    window.__demoCopiedTaskIds = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value) => { window.__demoCopiedTaskIds.push(String(value)); } },
    });
    Element.prototype.requestFullscreen = async function requestFullscreenForDemoTest() {
      window.__demoFullscreenTarget = this.tagName;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.pageErrors.push(error.message.slice(0, 500)));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|ResizeObserver/iu.test(message.text())) {
      report.consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(origin).origin) report.externalRequests.push(request.url());
    if (url.pathname.startsWith("/api/")) report.apiRequests.push(`${request.method()} ${url.pathname}`);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      report.writeRequests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto(`${origin}/demo/experience`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByTestId("experience-flow-demo").waitFor({ state: "visible", timeout: 30_000 });
  const taskIdButtons = page.locator("[data-task-id]");
  assert.equal(await taskIdButtons.count(), 5, "TASK_ID_BUTTON_COUNT_MISMATCH");
  for (let index = 0; index < await taskIdButtons.count(); index += 1) {
    const button = taskIdButtons.nth(index);
    const taskId = await button.getAttribute("data-task-id");
    assert.ok(taskId, `TASK_ID_MISSING:${index}`);
    await button.click();
    await page.getByRole("status").filter({ hasText: `${taskId} 已复制` }).waitFor({ state: "visible" });
  }
  report.copiedTaskIds = await page.evaluate(() => window.__demoCopiedTaskIds);
  assert.deepEqual(report.copiedTaskIds, ["CHAT-STREAM-01", "CHAT-STREAM-02", "VIDEO-LIVE-01", "VIDEO-LIVE-02", "VIDEO-HISTORY-01"]);
  const accessibleStatuses = await page.locator('[aria-label^="状态："]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  assert.deepEqual([...new Set(accessibleStatuses)].sort(), ["状态：已确定", "状态：待真实链路", "状态：模拟验收"].sort());
  await page.screenshot({ path: path.join(evidenceDir, "01-stream-idle-1440x900.png"), fullPage: false });

  const streamButton = page.getByTestId("start-stream-demo");
  const output = page.getByTestId("stream-demo-output");
  const submittedAt = Date.now();
  await streamButton.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stream-demo-output"]')?.textContent?.startsWith("已"), null, { timeout: 1_000 });
  report.firstTokenMs = Date.now() - submittedAt;
  assert.ok(report.firstTokenMs <= 500, `DEMO_FIRST_TOKEN_TOO_SLOW:${report.firstTokenMs}`);

  let previousLength = 0;
  for (let index = 0; index < 8; index += 1) {
    await page.waitForTimeout(90);
    const length = (await output.textContent() || "").replace(/\s+/gu, "").length;
    report.streamSamples.push(length);
    assert.ok(length >= previousLength, `STREAM_TEXT_REGRESSED:${previousLength}->${length}`);
    previousLength = length;
  }
  assert.ok(new Set(report.streamSamples).size >= 4, `STREAM_NOT_PROGRESSIVE:${report.streamSamples.join(",")}`);
  await page.screenshot({ path: path.join(evidenceDir, "02-stream-progress-1440x900.png"), fullPage: false });

  await page.getByRole("tab", { name: "视频生成与历史" }).click();
  await page.getByTestId("start-video-demo").click();
  const stageLocator = page.locator('[data-ready]');
  for (const expected of ["任务已提交", "上游生成中", "正在确认结果", "可实时预览"]) {
    await page.waitForFunction((label) => Array.from(document.querySelectorAll("[data-ready]")).some((node) => node.textContent?.includes(label)), expected, { timeout: 3_000 });
    report.observedVideoStages.push(expected);
  }
  await page.getByTestId("demo-video-preview").click();
  const lightbox = page.getByTestId("demo-video-lightbox");
  await lightbox.waitFor({ state: "visible", timeout: 5_000 });
  assert.equal(await lightbox.evaluate((node) => node.parentElement === document.body), true, "LIGHTBOX_NOT_PORTALED_TO_BODY");
  const video = lightbox.locator("video");
  await page.waitForFunction(() => document.querySelector('[data-testid="demo-video-lightbox"] video')?.currentSrc.includes("hero-pipeline-loop-v1"), null, { timeout: 10_000 });
  await lightbox.getByRole("button", { name: "放大" }).click();
  assert.match(await video.getAttribute("style") || "", /scale\(1\.1\)/u, "ZOOM_CONTROL_NOT_APPLIED");
  await lightbox.getByRole("button", { name: "全屏" }).click();
  assert.equal(await page.evaluate(() => window.__demoFullscreenTarget), "VIDEO", "FULLSCREEN_NOT_REQUESTED_ON_VIDEO");
  await page.screenshot({ path: path.join(evidenceDir, "03-video-lightbox-1440x900.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await lightbox.waitFor({ state: "detached", timeout: 3_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "demo-video-preview", null, { timeout: 1_000 });
  assert.equal(await page.getByTestId("demo-video-preview").evaluate((node) => document.activeElement === node), true, "PREVIEW_FOCUS_NOT_RESTORED");

  const forbiddenBusinessApi = report.apiRequests.filter((entry) => /\/(?:llm|chat|video|image|wallet|orders|billing|storyboard)(?:\/|$)/iu.test(entry));
  assert.deepEqual(forbiddenBusinessApi, [], `DEMO_CALLED_BUSINESS_API:${forbiddenBusinessApi.join(",")}`);
  assert.deepEqual(report.writeRequests, [], `DEMO_ATTEMPTED_WRITE:${report.writeRequests.join(",")}`);
  assert.deepEqual(report.externalRequests, [], `DEMO_CALLED_EXTERNAL_ORIGIN:${report.externalRequests.join(",")}`);
  assert.deepEqual(report.consoleErrors, [], `DEMO_CONSOLE_ERRORS:${report.consoleErrors.join(" | ")}`);
  assert.deepEqual(report.pageErrors, [], `DEMO_PAGE_ERRORS:${report.pageErrors.join(" | ")}`);

  report.ok = true;
  await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, evidenceDir, firstTokenMs: report.firstTokenMs, paidCalls: 0, productionWrites: 0 }, null, 2)}\n`);
} finally {
  await browser.close();
}
