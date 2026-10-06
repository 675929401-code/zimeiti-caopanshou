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
    modelId?: string;
    outputUrl?: string;
    taskId?: string;
    status?: string;
    playbackStatus?: string;
    error?: string;
  };
};

type CloudTask = {
  id?: string;
  modelId?: string;
  taskLabel?: string;
  createdAt?: string;
  completedAt?: string;
  status?: string;
};

function cloudTaskCreatedAt(task: CloudTask) {
  const fromId = /^vt_(\d+)_/u.exec(task.id || "")?.[1];
  if (fromId) return Number(fromId);
  return new Date(task.createdAt || task.completedAt || 0).getTime();
}

async function main() {
  await mkdir(videoDirectory, { recursive: true });
  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

  const cloudResponse = await authRequest.get(`${baseUrl}/api/bridge/video/active-tasks`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const cloud = await cloudResponse.json() as { activeTasks?: CloudTask[]; recentlyCompleted?: CloudTask[] };
  await authRequest.dispose();
  const runTasks = [...(cloud.activeTasks || []), ...(cloud.recentlyCompleted || [])]
    .filter((task) => task.modelId === "grok-imagine-video-1-5-fast-chA")
    .filter((task) => /分镜\d+.*关键帧生成视频/u.test(task.taskLabel || ""))
    .filter((task) => cloudTaskCreatedAt(task) >= new Date("2026-08-12T22:14:00+08:00").getTime())
    .sort((left, right) => cloudTaskCreatedAt(left) - cloudTaskCreatedAt(right));
  assert.equal(runTasks.length, 11, `本轮云端视频任务应为 11 条，当前 ${runTasks.length}`);
  const submittedAt = runTasks.map(cloudTaskCreatedAt);
  // These timestamps are written after the provider returns a task id, so they
  // measure cloud-record creation rather than browser request start times.
  const cloudRecordIntervals = submittedAt.slice(1).map((timestamp, index) => timestamp - submittedAt[index]);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, storageState: storageStatePath });
  await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/free-canvas?resume=benchmark-v9-cloud-recovery`, { waitUntil: "networkidle", timeout: 90_000 });
    await page.waitForFunction(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      const videos = (graph?.nodes || []).filter((node) => node.data.kind === "video");
      return videos.length === 11
        && videos.every((node) => node.data.status === "succeeded" && Boolean(node.data.outputUrl))
        && videos.every((node) => node.data.playbackStatus === "ready");
    }, undefined, { timeout: 5 * 60_000 });

    const videos = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      return (graph?.nodes || []).filter((node) => node.data.kind === "video");
    });
    assert.equal(videos.length, 11);
    assert.ok(videos.every((node) => node.data.modelId === "grok-imagine-video-1-5-fast-chA"));
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator(".free-pro-panel").waitFor({ state: "visible" });
    await page.screenshot({ path: `${outputDirectory}/06-final-full-flow-complete.png`, fullPage: true });
    await context.storageState({ path: storageStatePath });

    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];
      const outputUrl = video.data.outputUrl || "";
      const requestUrl = outputUrl.startsWith("http") ? outputUrl : `${baseUrl}${outputUrl}`;
      const mediaResponse = await context.request.get(requestUrl, {
        headers: { Authorization: `Bearer ${session.token}` },
        timeout: 120_000,
      });
      assert.ok(mediaResponse.ok(), `${video.data.title} 下载失败：HTTP ${mediaResponse.status()}`);
      await writeFile(`${videoDirectory}/shot-${String(index + 1).padStart(2, "0")}.mp4`, await mediaResponse.body());
    }

    await writeFile(`${outputDirectory}/final-video-generation-report.json`, `${JSON.stringify({
      videoGenerateRequests: runTasks.length,
      clientSubmitIntervalMs: 8_000,
      cloudRecordIntervalsMs: cloudRecordIntervals,
      cloudCompleted: runTasks.filter((task) => task.status === "completed").length,
      canvasRecovered: videos.length,
      playable: videos.filter((node) => node.data.playbackStatus === "ready").length,
      videos: videos.map((node) => ({
        title: node.data.title,
        modelId: node.data.modelId,
        outputUrl: node.data.outputUrl,
        status: node.data.status,
        playbackStatus: node.data.playbackStatus,
      })),
    }, null, 2)}\n`, "utf8");
    console.log("云端 11/11 完成，画布恢复 11/11，可播放 11/11；客户端按 8000ms 调度提交。");
  } finally {
    await context.close();
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
