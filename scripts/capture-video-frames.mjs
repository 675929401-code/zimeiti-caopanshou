import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const taskId = process.env.VIDEO_TASK_ID || "";
const outputDir = path.resolve(process.env.OUTPUT_DIR || `.tmp-e2e/video-frames-${taskId}`);
assert.ok(taskId, "缺少 VIDEO_TASK_ID");

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const videoUrl = `${baseUrl}/api/video/storage/${encodeURIComponent(taskId)}?token=${encodeURIComponent(session.token)}`;

await page.setContent(`<video controls muted playsinline preload="auto" style="width:960px;height:540px;object-fit:contain;background:#05070c" src="${videoUrl}"></video>`);
const video = page.locator("video");
await video.evaluate((element) => new Promise((resolve, reject) => {
  if (element.readyState >= 2 && Number.isFinite(element.duration)) return resolve();
  element.addEventListener("loadeddata", resolve, { once: true });
  element.addEventListener("error", () => reject(new Error("视频无法解码")), { once: true });
}));

const duration = await video.evaluate((element) => element.duration);
assert.ok(Number.isFinite(duration) && duration > 0, "未读取到视频时长");
const times = Array.from({ length: 10 }, (_, index) => Math.min(duration - 0.05, index + 0.5));
await video.evaluate((element) => element.play());
for (let index = 0; index < times.length; index += 1) {
  const time = times[index];
  await page.waitForFunction((nextTime) => {
    const element = document.querySelector("video");
    return element && element.currentTime >= nextTime;
  }, time, { timeout: 20_000 });
  await video.evaluate((element) => element.pause());
  await video.screenshot({ path: path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${time.toFixed(1)}s.png`) });
  if (index < times.length - 1) await video.evaluate((element) => element.play());
}

console.log(JSON.stringify({ taskId, duration, videoUrl, outputDir, frames: times.length }, null, 2));
await browser.close();
