import assert from "node:assert/strict";
import { chromium, request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const taskId = process.env.VIDEO_PLAYBACK_TASK_ID;

assert.ok(taskId, "请通过 VIDEO_PLAYBACK_TASK_ID 提供一条已完成的视频任务");
const completedTaskId = taskId!;

async function main() {
  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addCookies([{ name: "auth_token", value: session.token!, url: baseUrl }]);
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);

    const mediaUrl = `${baseUrl}/api/video/storage/${encodeURIComponent(completedTaskId)}`;
    const rangeResponse = await context.request.get(mediaUrl, {
      headers: { Range: "bytes=0-2047" },
      timeout: 45_000,
    });
    assert.equal(rangeResponse.status(), 206, `视频 Range 请求返回 ${rangeResponse.status()}`);
    assert.match(rangeResponse.headers()["content-type"] || "", /^video\//i, "视频代理没有返回 video/* MIME");
    assert.match((await rangeResponse.body()).subarray(0, 32).toString("latin1"), /ftyp|webm/i, "返回内容不是可识别的视频容器");

    const page = await context.newPage();
    const response = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    assert.ok(response?.ok(), `站点返回 ${response?.status()}`);
    const metadata = await page.evaluate(async (src) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.muted = true;
      video.playsInline = true;
      document.body.appendChild(video);
      try {
        return await new Promise<{ duration: number; readyState: number }>((resolve, reject) => {
          const timer = window.setTimeout(() => reject(new Error("加载视频元数据超时")), 45_000);
          video.addEventListener("loadedmetadata", () => {
            window.clearTimeout(timer);
            resolve({ duration: video.duration, readyState: video.readyState });
          }, { once: true });
          video.addEventListener("error", () => {
            window.clearTimeout(timer);
            reject(new Error(`媒体错误 ${video.error?.code || "unknown"}`));
          }, { once: true });
          video.src = src;
          video.load();
        });
      } finally {
        video.remove();
      }
    }, mediaUrl);

    assert.ok(Number.isFinite(metadata.duration) && metadata.duration > 0, `无效视频时长：${metadata.duration}`);
    assert.ok(metadata.readyState >= 1, `视频 readyState 异常：${metadata.readyState}`);
    console.log(`Video playback proxy verification passed: duration=${metadata.duration.toFixed(2)}s, readyState=${metadata.readyState}.`);
  } finally {
    await browser.close();
  }
}

void main();
