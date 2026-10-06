#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) || "";
const taskId = argument("task-id");
const modelId = argument("model-id");
const outputDir = path.resolve(argument("output"));
const sequentialPlayback = process.argv.includes("--sequential-playback");
const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_ONLY_ORIGIN_REQUIRED");
assert.match(taskId, /^vt_[A-Za-z0-9]{8,100}$/u, "VIDEO_TASK_ID_REQUIRED");
assert.ok(modelId, "VIDEO_MODEL_ID_REQUIRED");
assert.ok(token, "LOCAL_ADMIN_SESSION_REQUIRED");
assert.ok(outputDir.startsWith(`${path.resolve(".codex-evidence")}${path.sep}`), "EVIDENCE_OUTPUT_REQUIRED");

const headers = { Authorization: `Bearer ${token}` };
const statusUrl = new URL("/api/video/status", origin);
statusUrl.searchParams.set("taskId", taskId);
statusUrl.searchParams.set("modelId", modelId);
const statusResponse = await fetch(statusUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(60_000) });
const status = await statusResponse.json().catch(() => ({}));
assert.ok(statusResponse.ok && status.status === "completed", `VIDEO_STATUS_${statusResponse.status}_${status.status || "UNKNOWN"}`);
const playbackPath = String(status.videoUrl || status.storageUrl || "");
assert.ok(playbackPath, "VIDEO_PLAYBACK_URL_REQUIRED");
const playbackUrl = new URL(playbackPath, origin);
assert.equal(playbackUrl.origin, origin, "PLATFORM_PLAYBACK_PROXY_REQUIRED");

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = {
  schema: "completed_video_frame_inspection.v1",
  checkedAt: new Date().toISOString(),
  taskId,
  modelId,
  noProviderSubmission: true,
  playbackUrlSha256: createHash("sha256").update(playbackPath).digest("hex"),
  media: null,
  frames: [],
};
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: headers,
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  // Establish the local origin on a script-free endpoint so application
  // hydration cannot replace the isolated inspection DOM while the video loads.
  await page.goto(`${origin}/api/version`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.setContent(`<main style="margin:0;background:#111;width:1200px;padding:20px"><video id="target" muted playsinline controls style="display:block;width:1160px;background:#000"></video></main>`);
  await page.locator("#target").evaluate((video, url) => {
    video.src = String(url);
    video.load();
  }, playbackUrl.toString());
  await page.waitForFunction(() => {
    const video = document.querySelector("#target");
    return video instanceof HTMLVideoElement && video.readyState >= 2 && Number.isFinite(video.duration) && video.duration > 0;
  }, null, { timeout: 90_000 });
  const media = await page.locator("#target").evaluate((video) => ({
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    readyState: video.readyState,
  }));
  assert.ok(media.width > 0 && media.height > 0 && media.duration > 0, "VIDEO_METADATA_INVALID");
  report.media = media;
  const requested = [0.5, 2, 4, 6, 8, Math.max(0.5, media.duration - 0.5)];
  const timestamps = [...new Set(requested.map((value) => Math.min(Math.max(0, value), Math.max(0, media.duration - 0.05)).toFixed(3)))].map(Number);
  if (sequentialPlayback) await page.locator("#target").evaluate(async (video) => { video.currentTime = 0; await video.play(); });
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    if (sequentialPlayback) {
      await page.waitForFunction((time) => {
        const video = document.querySelector("#target");
        return video instanceof HTMLVideoElement && (video.currentTime >= Number(time) - 0.04 || video.ended);
      }, timestamp, { timeout: 40_000 });
    } else await page.locator("#target").evaluate(async (video, time) => {
      if (Math.abs(video.currentTime - Number(time)) > 0.02) {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("VIDEO_SEEK_TIMEOUT")), 15_000);
            video.addEventListener("seeked", () => { clearTimeout(timer); resolve(); }, { once: true });
            video.currentTime = Number(time);
          });
        } catch {
          // Some authenticated provider proxies expose a playable MP4 but do
          // not satisfy every random byte-range seek promptly. Fall back to
          // muted forward playback from the last decoded frame; this remains a
          // read-only delivery check and does not call the generation API.
          await video.play();
          await new Promise((resolve, reject) => {
            const started = Date.now();
            const check = () => {
              if (video.currentTime >= Number(time) - 0.04 || video.ended) return resolve();
              if (Date.now() - started > 30_000) return reject(new Error("VIDEO_PLAYBACK_ADVANCE_TIMEOUT"));
              setTimeout(check, 100);
            };
            check();
          });
          video.pause();
        }
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, timestamp);
    const file = `frame-${String(index + 1).padStart(2, "0")}-${timestamp.toFixed(3).replace(".", "_")}s.png`;
    await page.locator("#target").screenshot({ path: path.join(outputDir, file) });
    report.frames.push({ timestamp, file });
  }
  if (sequentialPlayback) await page.locator("#target").evaluate((video) => video.pause());
  await context.close();
} finally {
  await browser.close();
}
await fs.writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report, null, 2));
