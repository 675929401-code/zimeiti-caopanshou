import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/benchmark-director-v8-live";
const videoDirectory = `${outputDirectory}/final-videos`;
const storageStatePath = `${outputDirectory}/storage-state.json`;

type GraphNode = {
  id: string;
  data: {
    kind: string;
    title: string;
    outputUrl?: string;
    taskId?: string;
    status?: string;
    error?: string;
    playbackStatus?: string;
  };
};

async function main() {
  await mkdir(videoDirectory, { recursive: true });
  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: storageStatePath });
  await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
  const page = await context.newPage();
  const submittedAt: number[] = [];
  const firstFrameUrls: string[] = [];
  let statusRequests = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/bridge/video/generate") {
      submittedAt.push(Date.now());
      const payload = request.postDataJSON() as { image_url?: string };
      firstFrameUrls.push(payload.image_url || "");
    }
    if (path === "/api/bridge/video/status") statusRequests += 1;
  });

  try {
    const response = await page.goto(`${baseUrl}/free-canvas?resume=benchmark-v9-final-videos`, { waitUntil: "networkidle", timeout: 90_000 });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator(".free-pro-panel").waitFor({ state: "visible" });
    await page.waitForTimeout(2_000);
    const before = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      return (graph?.nodes || []).filter((node) => node.data.kind === "video");
    });
    assert.equal(before.length, 11, "视频节点数量错误");
    assert.ok(before.every((node) => !node.data.outputUrl && !node.data.taskId), "旧视频任务错误地覆盖了新关键帧队列");

    const videoStep = page.getByRole("button", { name: /3\s*批量视频/u });
    await videoStep.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await videoStep.isDisabled(), false, "批量视频按钮不可用");
    await videoStep.evaluate((element: HTMLButtonElement) => element.click());
    await page.waitForTimeout(5_000);
    if (submittedAt.length === 0) {
      const notice = await page.locator(".free-page-notice").innerText().catch(() => "页面没有提示");
      const blockedNodes = await page.evaluate(() => {
        const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: Array<GraphNode & { data: GraphNode["data"] & { generationBlockedReason?: string; modelId?: string } }> } | null;
        return (graph?.nodes || []).filter((node) => node.data.kind === "video").map((node) => ({
          title: node.data.title,
          modelId: node.data.modelId,
          blocked: node.data.generationBlockedReason,
          status: node.data.status,
        }));
      });
      throw new Error(`点击批量视频后没有提交任务：${notice}；${JSON.stringify(blockedNodes)}`);
    }

    await page.waitForFunction(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      const videos = (graph?.nodes || []).filter((node) => node.data.kind === "video");
      return videos.length === 11
        && videos.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl))
        && videos.every((node) => node.data.playbackStatus === "ready");
    }, undefined, { timeout: 30 * 60_000 });

    const videos = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      return (graph?.nodes || []).filter((node) => node.data.kind === "video");
    });
    await page.screenshot({ path: `${outputDirectory}/06-final-full-flow-complete.png`, fullPage: true });
    await context.storageState({ path: storageStatePath });

    assert.equal(submittedAt.length, 11, `完整视频队列应提交11条，当前${submittedAt.length}`);
    const submitIntervals = submittedAt.slice(1).map((timestamp, index) => timestamp - submittedAt[index]);
    assert.ok(submitIntervals.every((interval) => interval >= 7_500), `视频提交间隔不足8秒：${submitIntervals.join(",")}ms`);
    assert.ok(firstFrameUrls.every(Boolean), "存在未携带关键帧的视频请求");
    assert.equal(new Set(firstFrameUrls).size, 11, "11条视频没有分别绑定11张关键帧");

    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const mediaResponse = await context.request.get(`${baseUrl}${video.data.outputUrl}`, {
        headers: { Authorization: `Bearer ${session.token}` },
        timeout: 120_000,
      });
      assert.ok(mediaResponse.ok(), `${video.data.title}下载失败：HTTP ${mediaResponse.status()}`);
      await writeFile(`${videoDirectory}/shot-${String(index + 1).padStart(2, "0")}.mp4`, await mediaResponse.body());
    }
    await writeFile(`${outputDirectory}/final-video-generation-report.json`, `${JSON.stringify({
      videoGenerateRequests: submittedAt.length,
      submitIntervalsMs: submitIntervals,
      minimumSubmitIntervalMs: Math.min(...submitIntervals),
      statusRequests,
      uniqueFirstFrameUrls: new Set(firstFrameUrls).size,
      videos: videos.map((node) => ({ title: node.data.title, outputUrl: node.data.outputUrl, status: node.data.status, playbackStatus: node.data.playbackStatus })),
    }, null, 2)}\n`, "utf8");
    console.log(`全部视频11/11已完成并可播放；最短提交间隔${Math.min(...submitIntervals)}ms；状态查询${statusRequests}次`);
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
