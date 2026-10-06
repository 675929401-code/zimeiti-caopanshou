import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = process.env.REVIEW_ID || "storyboard-v50-live-fixed";
const reviewPath = path.resolve("public/storyboard-reviews", `${reviewId}.json`);
const screenshotDir = path.resolve(".codex-screenshots");
await mkdir(screenshotDir, { recursive: true });

const archive = JSON.parse(await readFile(reviewPath, "utf8"));
const card = archive.run?.cards?.[0];
assert.equal(card?.imageStatus, "done", "归档图片尚未完成");
assert.equal(card?.videoStatus, "done", "归档视频尚未完成");
assert.match(card.videoUrl || "", /^(?:https?:\/\/|\/api\/video\/)/u, "归档没有可播放视频地址");

function withoutToken(url) {
  if (!url) return url;
  const parsed = new URL(url, baseUrl);
  parsed.searchParams.delete("token");
  return url.startsWith("/")
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : parsed.toString();
}

const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
  headers: { "x-local-workbench": "ai-creation-studio-local" },
});
const session = await sessionResponse.json();
assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const browserErrors = [];
const consoleErrors = [];
page.on("pageerror", (error) => browserErrors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

await page.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
await page.goto(`${baseUrl}/storyboard-workbench?review=${encodeURIComponent(reviewId)}`, { waitUntil: "networkidle" });
const firstCard = page.locator(".sbw-shot-card").first();
await firstCard.waitFor({ timeout: 30_000 });
const video = firstCard.locator("video");
await video.waitFor({ timeout: 30_000 });
await video.evaluate(async (element) => {
  if (element.readyState >= 2) return;
  await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("视频元数据加载超时")), 60_000);
    element.addEventListener("loadeddata", () => {
      window.clearTimeout(timeout);
      resolve(undefined);
    }, { once: true });
    element.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error(element.error?.message || "视频解码失败"));
    }, { once: true });
    element.load();
  });
});

const media = await video.evaluate((element) => ({
  src: element.getAttribute("src"),
  currentSrc: element.currentSrc,
  duration: element.duration,
  width: element.videoWidth,
  height: element.videoHeight,
  readyState: element.readyState,
  networkState: element.networkState,
}));
assert.ok(Number.isFinite(media.duration) && media.duration > 0, "视频时长无效");
assert.ok(media.width > 0 && media.height > 0, "视频画面没有成功解码");

const frameCount = 10;
const frames = [];
for (let index = 0; index < frameCount; index += 1) {
  const at = Math.min(media.duration - 0.08, Math.max(0.08, ((index + 0.5) / frameCount) * media.duration));
  await video.evaluate(async (element, timestamp) => {
    if (Math.abs(element.currentTime - timestamp) < 0.03) return;
    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`跳转 ${timestamp.toFixed(2)}s 超时`)), 30_000);
      element.addEventListener("seeked", () => {
        window.clearTimeout(timeout);
        resolve(undefined);
      }, { once: true });
      element.currentTime = timestamp;
    });
  }, at);
  await page.waitForTimeout(120);
  frames.push({
    at,
    data: (await video.screenshot({ type: "jpeg", quality: 88 })).toString("base64"),
  });
}

await page.screenshot({
  path: path.join(screenshotDir, `${reviewId}-review.png`),
  fullPage: true,
});
await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;background:#0d1018;color:#fff;font:18px system-ui;padding:12px}
  main{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.frame{background:#171c28;border:1px solid #343c51;padding:6px}
  img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}.label{padding:6px 2px 0;color:#b8c1d6;font-variant-numeric:tabular-nums}
</style></head><body><main>${frames.map((frame, index) => `<div class="frame"><img src="data:image/jpeg;base64,${frame.data}"><div class="label">${index + 1} · ${frame.at.toFixed(2)}s</div></div>`).join("")}</main></body></html>`);
await page.screenshot({
  path: path.join(screenshotDir, `${reviewId}-contact.png`),
  fullPage: true,
});

archive.status = "passed";
archive.phase = "video-playback-verified";
archive.error = null;
archive.testedAt = new Date().toISOString();
archive.previousBrowserErrors = archive.browserErrors || [];
archive.previousConsoleErrors = archive.consoleErrors || [];
archive.browserErrors = browserErrors;
archive.consoleErrors = consoleErrors;
archive.playback = {
  ...media,
  src: withoutToken(media.src),
  currentSrc: withoutToken(media.currentSrc),
  frameTimestamps: frames.map((frame) => Number(frame.at.toFixed(2))),
  reviewScreenshot: `.codex-screenshots/${reviewId}-review.png`,
  contactSheet: `.codex-screenshots/${reviewId}-contact.png`,
};
await writeFile(reviewPath, JSON.stringify(archive, null, 2), "utf8");
await writeFile(".tmp-e2e/storyboard-v50-live-result.json", JSON.stringify(archive, null, 2), "utf8");

console.log(JSON.stringify({
  passed: true,
  reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
  media,
  browserErrors,
  consoleErrors,
  contactSheet: path.join(screenshotDir, `${reviewId}-contact.png`),
}, null, 2));

await context.close();
await browser.close();
