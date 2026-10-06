import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const videoPath = path.resolve(process.env.VIDEO_PATH || "");
const outputDir = path.resolve(process.env.OUTPUT_DIR || `${videoPath}-frames`);
assert.ok(process.env.VIDEO_PATH, "VIDEO_PATH is required");

await mkdir(outputDir, { recursive: true });
const htmlPath = path.join(outputDir, "viewer.html");
const videoUrl = pathToFileURL(videoPath).href;
await writeFile(htmlPath, `<!doctype html><video muted playsinline preload="auto" src="${videoUrl}" style="width:960px;height:540px;object-fit:contain;background:#000"></video>`, "utf8");

const browser = await chromium.launch({ headless: true, args: ["--allow-file-access-from-files"] });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 580 } });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30_000 });
  const video = page.locator("video");
  await page.waitForFunction(() => {
    const element = document.querySelector("video");
    return element && element.readyState >= 2 && Number.isFinite(element.duration);
  }, undefined, { timeout: 30_000 });
  const duration = await video.evaluate((element) => element.duration);
  assert.ok(duration >= 9.5 && duration <= 10.5, `unexpected duration ${duration}`);
  await video.evaluate((element) => element.play());
  const capturedTimes = [];
  for (let index = 0; index < 20; index += 1) {
    await page.waitForTimeout(index === 0 ? 250 : 500);
    const time = await video.evaluate((element) => element.currentTime);
    capturedTimes.push(time);
    await video.screenshot({ path: path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${time.toFixed(2)}s.png`) });
  }
  console.log(JSON.stringify({ videoPath, duration, outputDir, frameCount: capturedTimes.length, capturedTimes }, null, 2));
} finally {
  await browser.close();
}
