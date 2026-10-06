import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const outputDirectory = ".tmp-e2e/benchmark-director-v8-live";
const storageStatePath = `${outputDirectory}/storage-state.json`;
const headful = process.env.CANVAS_HEADFUL === "1";

type GraphNode = {
  id: string;
  data: {
    kind: string;
    title: string;
    status?: string;
    taskId?: string;
    outputUrl?: string;
    error?: string;
  };
};

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地验收会话不可用");

  const browser = await chromium.launch({
    headless: !headful,
    slowMo: headful ? 80 : 0,
    args: headful ? ["--start-maximized"] : [],
  });
  const report = {
    startedAt: new Date().toISOString(),
    rounds: [] as Array<{ round: number; completed: number; pending: number; failed: number }>,
    videoGenerateRequests: 0,
    statusRequests: 0,
    completedAssets: [] as Array<{ title: string; outputUrl: string }>,
    error: "",
  };

  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
      storageState: storageStatePath,
    });
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
    const page = await context.newPage();
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/bridge/video/generate") report.videoGenerateRequests += 1;
      if (path === "/api/bridge/video/status") report.statusRequests += 1;
    });

    const response = await page.goto(`${baseUrl}/free-canvas?resume=benchmark-v8`, {
      waitUntil: "networkidle",
      timeout: 90_000,
    });
    assert.ok(response?.ok(), `自由画布返回 ${response?.status()}`);
    await page.getByRole("button", { name: "打开制作面板" }).click();
    await page.locator(".free-pro-panel").waitFor({ state: "visible" });

    await page.waitForFunction(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      const nodes = graph?.nodes || [];
      const videos = nodes.filter((node) => node.data.kind === "video");
      const keyframes = nodes.filter((node) => node.data.kind === "image" && /自动关键帧/u.test(node.data.title));
      return videos.length === 11
        && videos.every((node) => Boolean(node.data.taskId || node.data.outputUrl))
        && keyframes.length === 11
        && keyframes.every((node) => Boolean(node.data.outputUrl));
    }, undefined, { timeout: 90_000 });

    for (let round = 1; round <= 12; round += 1) {
      const snapshot = await page.evaluate(() => {
        const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
        const videos = (graph?.nodes || []).filter((node) => node.data.kind === "video");
        return {
          completed: videos.filter((node) => Boolean(node.data.outputUrl)).length,
          pending: videos.filter((node) => !node.data.outputUrl && node.data.status !== "failed").length,
          failed: videos.filter((node) => node.data.status === "failed").length,
        };
      });
      report.rounds.push({ round, ...snapshot });
      console.log(`[resume] 第${round}轮前：完成${snapshot.completed}/11，待查询${snapshot.pending}，失败${snapshot.failed}`);
      if (snapshot.completed === 11) break;
      assert.equal(snapshot.failed, 0, "主站明确返回了失败任务");

      const videoStep = page.getByRole("button", { name: /3\s*批量视频/u });
      assert.equal(await videoStep.isDisabled(), false, "批量视频继续查询按钮不可用");
      await videoStep.evaluate((element: HTMLButtonElement) => element.click());
      await page.waitForTimeout(1_000);
      await page.waitForFunction(() => document.querySelectorAll(".free-canvas-actions .batch-control").length > 0, undefined, { timeout: 15_000 });
      await page.waitForFunction(() => document.querySelectorAll(".free-canvas-actions .batch-control").length === 0, undefined, { timeout: 8 * 60_000 });
      await context.storageState({ path: storageStatePath });
      await page.screenshot({ path: `${outputDirectory}/resume-round-${String(round).padStart(2, "0")}.png`, fullPage: true });
    }

    const nodes = await page.evaluate(() => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as { nodes?: GraphNode[] } | null;
      return graph?.nodes || [];
    });
    const videos = nodes.filter((node) => node.data.kind === "video");
    report.completedAssets = videos
      .filter((node) => Boolean(node.data.outputUrl))
      .map((node) => ({ title: node.data.title, outputUrl: node.data.outputUrl! }));
    assert.equal(report.videoGenerateRequests, 0, "恢复查询错误地重新提交了视频任务");
    assert.equal(report.completedAssets.length, 11, "仍有视频未完成");
    await page.screenshot({ path: `${outputDirectory}/04-videos-recovered.png`, fullPage: true });
    await context.storageState({ path: storageStatePath });
    await context.close();
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    throw error;
  } finally {
    await writeFile(`${outputDirectory}/resume-report.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await browser.close();
    console.log(JSON.stringify(report, null, 2));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
