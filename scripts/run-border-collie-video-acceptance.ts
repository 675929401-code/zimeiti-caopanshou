import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, request as playwrightRequest, type Page } from "playwright";

const baseUrl = process.env.CANVAS_TEST_BASE_URL || "http://127.0.0.1:5000";
const imageStageDirectory = ".tmp-e2e/border-collie-banana-acceptance";
const outputDirectory = ".tmp-e2e/border-collie-video-acceptance";
const storageStatePath = imageStageDirectory + "/storage-state.json";
const finalStorageStatePath = outputDirectory + "/storage-state.json";
const recoveryStorageStatePath = outputDirectory + "/recovery-storage-state.json";
const liveEnabled = process.env.CANVAS_LIVE_GENERATION === "1" || process.argv.includes("--live");
const bananaModelId = "gemini-3-1-flash-image-chA";
const videoModelId = "veo-3-1-fast-chC";
const selectedShots = [1, 8];
const recoveryTaskIds: Record<number, string> = {};
if (process.env.CANVAS_RECOVER_SHOT_01_TASK_ID) recoveryTaskIds[1] = process.env.CANVAS_RECOVER_SHOT_01_TASK_ID;
if (process.env.CANVAS_RECOVER_SHOT_08_TASK_ID) recoveryTaskIds[8] = process.env.CANVAS_RECOVER_SHOT_08_TASK_ID;

type GraphNodeData = {
  title?: string;
  kind?: string;
  status?: string;
  outputUrl?: string;
  providerContentUrl?: string;
  taskId?: string;
  modelId?: string;
  durationSeconds?: number;
  playbackStatus?: string;
  playbackError?: string;
  error?: string;
  outputText?: string;
};

type RequestRecord = {
  path: string;
  method: string;
  startedAt: string;
  status?: number;
  durationMs?: number;
  modelId?: string;
  targetDuration?: number;
};

function restoreTaskOnNodes(nodes: Array<{ data?: GraphNodeData }> | undefined, order: number, taskId: string) {
  if (!nodes) return;
  const prefix = "分镜" + String(order).padStart(2, "0") + " · 关键帧生成视频";
  const target = nodes.find((node) => node.data?.title?.startsWith(prefix));
  if (!target?.data) throw new Error(prefix + "不存在，无法恢复任务");
  target.data.taskId = taskId;
  target.data.providerContentUrl = "";
  target.data.outputUrl = "";
  target.data.status = "running";
  target.data.playbackStatus = undefined;
  target.data.playbackError = undefined;
  target.data.error = undefined;
}

async function prepareRecoveryStorageState() {
  if (Object.keys(recoveryTaskIds).length === 0) return storageStatePath;
  const state = JSON.parse(await readFile(storageStatePath, "utf8")) as {
    origins?: Array<{ origin?: string; localStorage?: Array<{ name: string; value: string }> }>;
  };
  const origin = state.origins?.find((item) => item.origin === baseUrl);
  if (!origin?.localStorage) throw new Error("测试状态中没有自由画布本地数据");
  const graphEntry = origin.localStorage.find((item) => item.name === "ai-creation-studio-graph-v1");
  const sessionsEntry = origin.localStorage.find((item) => item.name === "ai-creation-studio-free-canvas-sessions-v1");
  if (!graphEntry || !sessionsEntry) throw new Error("测试状态缺少画布图或会话记录");
  const graph = JSON.parse(graphEntry.value) as { nodes?: Array<{ data?: GraphNodeData }> };
  const sessions = JSON.parse(sessionsEntry.value) as Array<{ nodes?: Array<{ data?: GraphNodeData }> }>;
  for (const [orderText, taskId] of Object.entries(recoveryTaskIds)) {
    const order = Number(orderText);
    restoreTaskOnNodes(graph.nodes, order, taskId);
    for (const session of sessions) restoreTaskOnNodes(session.nodes, order, taskId);
  }
  graphEntry.value = JSON.stringify(graph);
  sessionsEntry.value = JSON.stringify(sessions);
  await writeFile(recoveryStorageStatePath, JSON.stringify(state, null, 2), "utf8");
  return recoveryStorageStatePath;
}

function nodeCard(page: Page, title: string) {
  return page
    .locator(".react-flow__node .workflow-kind > strong")
    .filter({ hasText: title })
    .first()
    .locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' react-flow__node ')][1]");
}

async function openProPanel(page: Page) {
  const panel = page.locator(".free-pro-panel");
  if (await panel.isVisible().catch(() => false)) return;
  const toggle = page.getByRole("button", { name: "打开制作面板" });
  await toggle.waitFor({ state: "visible", timeout: 20_000 });
  await toggle.click();
  await panel.waitFor({ state: "visible", timeout: 10_000 });
}

async function selectNode(page: Page, title: string) {
  const card = nodeCard(page, title);
  await card.waitFor({ state: "attached", timeout: 30_000 });
  await card.evaluate((element: HTMLElement) => element.click());
  await card.locator(".free-node-compose").waitFor({ state: "visible", timeout: 10_000 });
  return card;
}

async function graphNode(page: Page, title: string) {
  return page.evaluate((expectedTitle) => {
    const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
      nodes?: Array<{ data?: GraphNodeData }>;
    } | null;
    return graph?.nodes?.find((node) => node.data?.title?.startsWith(expectedTitle))?.data || null;
  }, title);
}

async function waitForVideoResult(page: Page, title: string, card: ReturnType<typeof nodeCard>) {
  const started = Date.now();
  let lastProgressLog = 0;
  let continuedOnce = false;
  while (Date.now() - started < 780_000) {
    const state = await graphNode(page, title);
    if (state?.status === "failed" || state?.playbackStatus === "failed") {
      throw new Error(title + "失败：" + (state.playbackError || state.error || "未知错误"));
    }
    if (state?.outputUrl && state.playbackStatus === "ready") return state;
    const elapsed = Date.now() - started;
    if (elapsed - lastProgressLog >= 30_000) {
      console.log("[video-acceptance] " + title + " waiting " + Math.round(elapsed / 1000) + "s; status=" + (state?.status || "unknown") + "; task=" + (state?.taskId ? "received" : "pending"));
      lastProgressLog = elapsed;
    }
    if (!continuedOnce && elapsed >= 380_000 && state?.taskId && !state.outputUrl) {
      const button = card.locator(".free-parameter-row.video button").last();
      const label = (await button.textContent()) || "";
      if (/继续查询/u.test(label) && !(await button.isDisabled())) {
        await button.click();
        continuedOnce = true;
        console.log("[video-acceptance] resumed existing task polling without resubmitting");
      }
    }
    await page.waitForTimeout(5_000);
  }
  throw new Error(title + "超过13分钟仍未得到可播放结果");
}

async function inspectVideoFrame(page: Page, card: ReturnType<typeof nodeCard>, expectedUrl: string, targetDuration: number) {
  const video = card.locator(".workflow-node-preview video").first();
  await video.waitFor({ state: "visible", timeout: 30_000 });
  const metadata = await video.evaluate(async (element, input) => {
    const media = element as HTMLVideoElement;
    const expectedPath = new URL(input.expectedUrl, window.location.href).pathname;
    const currentPath = new URL(media.currentSrc || media.src, window.location.href).pathname;
    if (expectedPath !== currentPath) throw new Error("视频卡片仍在显示旧地址");
    if (media.readyState < 1 || !Number.isFinite(media.duration) || media.duration <= 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("视频元数据加载超时")), 45_000);
        media.addEventListener("loadedmetadata", () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
        media.addEventListener("error", () => {
          window.clearTimeout(timeout);
          reject(new Error("浏览器无法解码视频"));
        }, { once: true });
        media.load();
      });
    }
    const seekTo = Math.min(Math.max(0.25, input.targetDuration * 0.35), Math.max(0.25, media.duration - 0.25));
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("视频抽帧定位超时")), 30_000);
      media.addEventListener("seeked", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
      media.currentTime = seekTo;
    });
    const width = Math.max(1, media.videoWidth);
    const height = Math.max(1, media.videoHeight);
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(width, 320);
    canvas.height = Math.max(1, Math.round(height * canvas.width / width));
    const drawing = canvas.getContext("2d", { willReadFrequently: true });
    if (!drawing) throw new Error("无法创建视频像素检查画布");
    drawing.drawImage(media, 0, 0, canvas.width, canvas.height);
    const pixels = drawing.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    let sum = 0;
    let sumSquares = 0;
    const count = pixels.length / 4;
    for (let index = 0; index < pixels.length; index += 4) {
      const luminance = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      if (luminance > 10) nonBlack += 1;
      sum += luminance;
      sumSquares += luminance * luminance;
    }
    const mean = sum / count;
    return {
      currentPath,
      nativeDuration: media.duration,
      targetDuration: input.targetDuration,
      readyState: media.readyState,
      width,
      height,
      nonBlackRatio: nonBlack / count,
      luminanceVariance: sumSquares / count - mean * mean,
    };
  }, { expectedUrl, targetDuration });
  assert.ok(metadata.readyState >= 2, "视频没有达到可抽帧状态");
  assert.ok(metadata.width > 0 && metadata.height > 0, "视频没有有效尺寸");
  assert.ok(metadata.nonBlackRatio > 0.08, "视频抽帧几乎全黑");
  assert.ok(metadata.luminanceVariance > 15, "视频抽帧缺少有效画面层次");
  return { video, metadata };
}

async function main() {
  assert.ok(liveEnabled, "此脚本会产生两条真实视频费用；确认后使用 --live 运行");
  await access(storageStatePath);
  await mkdir(outputDirectory, { recursive: true });
  const preparedStorageStatePath = await prepareRecoveryStorageState();
  const report: {
    startedAt: string;
    completedAt?: string;
    imageModel: string;
    videoModel: string;
    balanceBefore?: number;
    balanceAfter?: number;
    requests: RequestRecord[];
    videos: Array<Record<string, unknown>>;
    recoveredTaskIds: Record<number, string>;
    error?: string;
  } = {
    startedAt: new Date().toISOString(),
    imageModel: bananaModelId,
    videoModel: videoModelId,
    requests: [],
    videos: [],
    recoveredTaskIds: recoveryTaskIds,
  };

  const authRequest = await playwrightRequest.newContext();
  const sessionResponse = await authRequest.get(baseUrl + "/api/auth/dev-session", {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  const session = await sessionResponse.json() as { token?: string; error?: string };
  await authRequest.dispose();
  assert.ok(sessionResponse.ok() && session.token, session.error || "本地测试会话不可用");

  const browser = await chromium.launch({ headless: process.env.CANVAS_HEADFUL !== "1" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1680, height: 1040 },
      deviceScaleFactor: 1,
      storageState: preparedStorageStatePath,
    });
    await context.addInitScript((token) => localStorage.setItem("auth_token", token), session.token);
    const balanceBeforeResponse = await context.request.get(baseUrl + "/api/bridge/balance", {
      headers: { Authorization: "Bearer " + session.token },
    });
    report.balanceBefore = Number((await balanceBeforeResponse.json() as { balance?: number }).balance || 0);
    assert.ok(report.balanceBefore >= 0.6, "余额不足，两个Veo测试镜头预计需要¥0.60");

    const page = await context.newPage();
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith("/api/bridge/video/")) return;
      let body: Record<string, unknown> = {};
      try {
        const parsed = request.postDataJSON() as unknown;
        body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
      } catch {}
      report.requests.push({
        path,
        method: request.method(),
        startedAt: new Date().toISOString(),
        modelId: typeof body.modelId === "string" ? body.modelId : typeof body.model_id === "string" ? body.model_id : undefined,
        targetDuration: typeof body.durationSeconds === "number" ? body.durationSeconds : typeof body.duration === "number" ? body.duration : undefined,
      });
    });
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      const pending = [...report.requests].reverse().find((item) => item.path === path && item.status === undefined);
      if (!pending) return;
      pending.status = response.status();
      pending.durationMs = Date.now() - Date.parse(pending.startedAt);
    });

    const response = await page.goto(baseUrl + "/free-canvas?revision=border-collie-video-acceptance&panel=production", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    assert.ok(response?.ok(), "自由画布返回 " + response?.status());
    await nodeCard(page, "分镜01 · 自动关键帧图片").waitFor({ state: "attached", timeout: 60_000 });
    await openProPanel(page);
    await page.waitForFunction(() => {
      const selects = [...document.querySelectorAll<HTMLSelectElement>(".free-global-models select")];
      return selects.length >= 3 && selects.every((select) => select.options.length > 0);
    }, undefined, { timeout: 30_000 });

    const globalSelects = page.locator(".free-global-models select");
    const trimSwitch = page.getByRole("switch", { name: "下载时精确裁剪" });
    if (!(await trimSwitch.isChecked())) await trimSwitch.check();
    const bananaOption = globalSelects.nth(0).locator(`option[value="${bananaModelId}"]`);
    const videoOption = globalSelects.nth(2).locator(`option[value="${videoModelId}"]`);
    assert.equal(await bananaOption.count(), 1, "全局模型中没有 Banana 2");
    assert.equal(await videoOption.count(), 1, "全局模型中没有 ¥0.30 Veo 3.1 Fast");
    assert.equal(await videoOption.isDisabled(), false, "Veo固定8秒模型在自动裁剪开启后仍不可选");
    await globalSelects.nth(0).selectOption(bananaModelId);
    await globalSelects.nth(2).selectOption(videoModelId);
    await page.getByRole("button", { name: /应用到当前全部图片和视频节点/u }).click();
    await page.waitForFunction((ids) => {
      const graph = JSON.parse(localStorage.getItem("ai-creation-studio-graph-v1") || "null") as {
        nodes?: Array<{ data?: GraphNodeData }>;
      } | null;
      const imagesOk = graph?.nodes?.filter((node) => node.data?.kind === "image").every((node) => node.data?.modelId === ids.image);
      const videosOk = graph?.nodes?.filter((node) => node.data?.kind === "video").every((node) => node.data?.modelId === ids.video);
      return Boolean(imagesOk && videosOk);
    }, { image: bananaModelId, video: videoModelId }, { timeout: 20_000 });
    await context.storageState({ path: finalStorageStatePath });

    for (const order of selectedShots) {
      const padded = String(order).padStart(2, "0");
      const image = await graphNode(page, "分镜" + padded + " · 自动关键帧图片");
      const prompt = await graphNode(page, "分镜" + padded + " · 视频提示词");
      const videoTitle = "分镜" + padded + " · 关键帧生成视频";
      const videoBefore = await graphNode(page, videoTitle);
      assert.ok(image?.outputUrl, "分镜" + padded + "缺少已生成参考图");
      assert.equal(image?.modelId, bananaModelId, "分镜" + padded + "参考图模型不是 Banana");
      assert.equal(videoBefore?.modelId, videoModelId, "分镜" + padded + "视频模型不是 ¥0.30 Veo");
      assert.match(prompt?.outputText || "", /动作时间轴：/u, "分镜" + padded + "缺少秒级动作");
      assert.match(prompt?.outputText || "", /音频硬约束：/u, "分镜" + padded + "缺少场景音约束");
      assert.match(prompt?.outputText || "", /完全没有背景音乐、配乐、BGM、歌曲、旁白、配音、对白/u, "分镜" + padded + "没有排除后期配音内容");

      const card = await selectNode(page, videoTitle);
      const button = card.locator(".free-parameter-row.video button").last();
      assert.equal(await button.isDisabled(), false, videoTitle + "不可生成：" + ((await button.getAttribute("title")) || "未知原因"));
      const requestCount = report.requests.length;
      const submitStarted = Date.now();
      const recoveringTask = Boolean(videoBefore?.taskId);
      if (recoveringTask) {
        assert.equal(videoBefore?.taskId, recoveryTaskIds[order], videoTitle + "恢复了错误的任务 ID");
        await button.evaluate((element: HTMLButtonElement) => element.click());
      } else {
        const submitResponsePromise = page.waitForResponse((candidate) => (
          new URL(candidate.url()).pathname === "/api/bridge/video/generate"
          && candidate.request().method() === "POST"
        ), { timeout: 180_000 });
        await button.evaluate((element: HTMLButtonElement) => element.click());
        const submitResponse = await submitResponsePromise;
        const submitPayload = await submitResponse.json().catch(() => ({})) as { error?: string };
        assert.ok(submitResponse.ok(), videoTitle + "提交失败：" + (submitPayload.error || submitResponse.status()));
      }
      const completed = await waitForVideoResult(page, videoTitle, card);
      const targetDuration = Number(completed.durationSeconds || 0);
      const inspected = await inspectVideoFrame(page, card, completed.outputUrl || "", targetDuration);
      const screenshot = outputDirectory + "/video-shot-" + padded + ".png";
      await card.screenshot({ path: screenshot });

      const downloadUrl = new URL(completed.outputUrl || "", baseUrl).toString();
      const download = await context.request.get(downloadUrl, {
        headers: { Authorization: "Bearer " + session.token },
        timeout: 180_000,
      });
      assert.ok(download.ok(), videoTitle + "源文件下载失败：" + download.status());
      const bytes = await download.body();
      const contentType = download.headers()["content-type"] || "";
      assert.match(contentType, /^video\//u, videoTitle + "下载内容不是视频：" + contentType);
      assert.ok(bytes.length > 100_000, videoTitle + "视频文件过小");
      const savedPath = outputDirectory + "/video-shot-" + padded + ".mp4";
      await writeFile(savedPath, bytes);

      const nodeRequests = report.requests.slice(requestCount);
      const submits = nodeRequests.filter((item) => item.path === "/api/bridge/video/generate");
      assert.equal(submits.length, recoveringTask ? 0 : 1, videoTitle + "发生重复提交，可能重复计费");
      if (!recoveringTask) assert.equal(submits[0]?.modelId, videoModelId, videoTitle + "实际请求未使用 ¥0.30 Veo");
      report.videos.push({
        order,
        title: videoTitle,
        targetDuration,
        nativeDuration: inspected.metadata.nativeDuration,
        width: inspected.metadata.width,
        height: inspected.metadata.height,
        nonBlackRatio: inspected.metadata.nonBlackRatio,
        luminanceVariance: inspected.metadata.luminanceVariance,
        generationDurationMs: Date.now() - submitStarted,
        statusPolls: nodeRequests.filter((item) => item.path === "/api/bridge/video/status").length,
        byteLength: bytes.length,
        contentType,
        recoveredTask: recoveringTask,
        outputUrl: completed.outputUrl,
        savedPath,
        screenshot,
      });
      await context.storageState({ path: finalStorageStatePath });
      await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
      console.log("[video-acceptance] completed shot " + padded + " in " + Math.round((Date.now() - submitStarted) / 1000) + "s");
    }

    const submits = report.requests.filter((item) => item.path === "/api/bridge/video/generate");
    assert.equal(submits.length, selectedShots.length - Object.keys(recoveryTaskIds).length, "两镜头测试的提交次数不正确");
    const balanceAfterResponse = await context.request.get(baseUrl + "/api/bridge/balance", {
      headers: { Authorization: "Bearer " + session.token },
    });
    report.balanceAfter = Number((await balanceAfterResponse.json() as { balance?: number }).balance || 0);
    report.completedAt = new Date().toISOString();
    await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
    console.log(JSON.stringify(report, null, 2));
    await context.close();
  } catch (error) {
    report.error = error instanceof Error ? error.stack || error.message : String(error);
    report.completedAt = new Date().toISOString();
    await writeFile(outputDirectory + "/report.json", JSON.stringify(report, null, 2), "utf8");
    throw error;
  } finally {
    await browser.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
