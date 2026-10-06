import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

async function main() {
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
  await video.evaluate((element) => new Promise<void>((resolve, reject) => {
    const media = element as HTMLVideoElement;
    if (media.readyState >= 2 && Number.isFinite(media.duration)) return resolve();
    media.addEventListener("loadeddata", () => resolve(), { once: true });
    media.addEventListener("error", () => reject(new Error("local video decode failed")), { once: true });
  }));
  const duration = await video.evaluate((element) => (element as HTMLVideoElement).duration);
  assert.ok(duration >= 9.5 && duration <= 10.5, `unexpected duration ${duration}`);
  const times = Array.from({ length: 20 }, (_, index) => Math.min(duration - 0.05, 0.25 + index * 0.5));
  for (let index = 0; index < times.length; index += 1) {
    const time = times[index];
    await video.evaluate(async (element, target) => {
      const media = element as HTMLVideoElement;
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        media.addEventListener("seeked", done, { once: true });
        media.currentTime = target;
      });
    }, time);
    await video.screenshot({ path: path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${time.toFixed(2)}s.png`) });
  }
  console.log(JSON.stringify({ videoPath, duration, outputDir, frameCount: times.length }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
