import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const phone = process.env.CANVAS_TEST_PHONE;
const password = process.env.CANVAS_TEST_PASSWORD;
const reviewPath = path.resolve("public/storyboard-reviews/minimax-h3-4s-2k-live-20260815-1.json");
const outputDir = path.resolve(".codex-screenshots");
const resultPath = path.resolve(".tmp-e2e/video-channel-browser-acceptance-20260815.json");

async function main() {
  const sessionResponse = phone && password
    ? await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 Video channel browser verification",
        },
        body: JSON.stringify({ phone, password }),
      })
    : await fetch(`${baseUrl}/api/auth/dev-session`, {
        headers: { "x-local-workbench": "ai-creation-studio-local" },
      });
  const session = await sessionResponse.json();
  if (!phone && !password && sessionResponse.status === 404) {
    console.log(JSON.stringify({
      status: "skipped",
      reason: "production-mode-local-server-blocks-dev-session",
      requiredEnvironment: ["CANVAS_TEST_PHONE", "CANVAS_TEST_PASSWORD"],
      paidCalls: 0,
      providerCalls: 0,
    }, null, 2));
    return;
  }
  assert.ok(sessionResponse.ok && session.token && session.user, session.error || "本地验收会话不可用");

  await mkdir(outputDir, { recursive: true });
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.addInitScript(({ token, user, run }) => {
      localStorage.setItem("auth_token", token);
      localStorage.setItem("auth_user", JSON.stringify(user));
      localStorage.setItem("storyboard_prompt_workbench_current_v2", JSON.stringify(run));
    }, { token: session.token, user: session.user, run: review.run });

const forbidden = /Secure Skill|高瑞|蓝猫|server_error|generation failed: generate error|upstream error/iu;

await page.goto(`${baseUrl}/storyboard-workbench`, { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForTimeout(1200);
const workbenchText = await page.locator("body").innerText();
assert.match(workbenchText, /渠道服务暂时不可用|生成失败，请稍后重试/);
assert.doesNotMatch(workbenchText, forbidden);
const workbenchShot = path.join(outputDir, "video-channel-workbench-failure-safe-20260815.png");
await page.screenshot({ path: workbenchShot, fullPage: true });

await page.goto(`${baseUrl}/media-history`, { waitUntil: "networkidle", timeout: 45_000 });
await page.waitForSelector("text=媒体历史", { timeout: 20_000 });
const typeSelect = page.locator('select').filter({ has: page.locator('option[value="video"]') }).first();
if (await typeSelect.count()) await typeSelect.selectOption("video");
await page.waitForTimeout(500);
const historyText = await page.locator("body").innerText();
assert.match(historyText, /MiniMax H3 · 4-15秒 · 最高4K · A/);
assert.match(historyText, /Omni Flash · 10秒 · 1080p · C/);
assert.doesNotMatch(historyText, forbidden);

const previewButton = page.getByRole("button", { name: "加载视频预览" }).first();
assert.ok(await previewButton.count(), "媒体历史中应存在可播放的已完成视频");
await previewButton.click();
const video = page.locator('video[aria-label$="视频预览"]').first();
await video.waitFor({ state: "visible", timeout: 30_000 });
await page.waitForFunction(() => {
  const element = document.querySelector('video[aria-label$="视频预览"]');
  return element instanceof HTMLVideoElement && element.readyState >= 1;
}, { timeout: 30_000 });
const playback = await video.evaluate((element) => ({
  readyState: element.readyState,
  duration: Number.isFinite(element.duration) ? element.duration : null,
  currentSrc: element.currentSrc,
}));
assert.ok(
  playback.currentSrc.includes("/api/video/storage/") || playback.currentSrc.startsWith("blob:"),
  `视频预览应使用服务端历史地址或浏览器缓存，实际为 ${playback.currentSrc}`,
);
const historyShot = path.join(outputDir, "video-channel-history-playback-20260815.png");
await page.screenshot({ path: historyShot, fullPage: false });

await page.reload({ waitUntil: "networkidle", timeout: 45_000 });
if (await typeSelect.count()) await typeSelect.selectOption("video");
await page.waitForTimeout(500);
const refreshedHistoryText = await page.locator("body").innerText();
assert.match(refreshedHistoryText, /Omni Flash · 10秒 · 1080p · C/);
assert.doesNotMatch(refreshedHistoryText, forbidden);

const models = await page.evaluate(async () => {
  const token = localStorage.getItem("auth_token") || "";
  const response = await fetch("/api/video/models", { headers: { Authorization: `Bearer ${token}` } });
  return response.json();
});
const omni = models.models.find((model) => model.displayName === "Omni Flash · 10秒 · 1080p");
const grok = models.models.find((model) => model.displayName === "Grok Imagine 1.0 Super · 20秒");
assert.equal(omni?.id, "pm_11gMj3vJW9NhBw75h4XZNUxu");
assert.equal(omni?.variantLabel, "C");
assert.equal(grok?.variantLabel, "D");
assert.equal(models.models.some((model) => /H3/u.test(model.displayName)), false);

const result = {
  status: "passed",
  testedAt: new Date().toISOString(),
  workbenchFailureSafe: true,
  historyLabels: { h3: "A", omni1080p: "C", grok20s: "D" },
  h3SubmissionBlocked: true,
  omniPublicModelId: omni.id,
  playback,
  refreshHistoryRecovered: true,
  screenshots: [workbenchShot, historyShot],
  consoleErrors,
};
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
