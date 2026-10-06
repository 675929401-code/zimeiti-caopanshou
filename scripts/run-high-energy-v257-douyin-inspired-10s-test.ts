import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

type Json = Record<string, any>;

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = `high-energy-v257-douyin-sos-10s-${Date.now()}`;
const runId = `${reviewId}-run`;
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const imageModelId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const videoModelId = "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
const script = "狗狗突然弓背发抖、躲角落，还不吃零食，不一定是闹脾气。先看牙龈是否发白、呼吸是否急、肚子是否硬胀；站不稳还哼叫，立刻去医院。";
const style = "对标皮克斯式高能3D宠物科普动画；图文导演注释版：一图5格，每格下方保留Frame导演说明条，只写camera + core action + reaction + effect trigger；视频成片不保留说明条。";
const negativePrompt = [
  "photorealistic",
  "live action",
  "real human face",
  "semi-realistic",
  "storyboard grid in final video",
  "panel borders in final video",
  "caption strip",
  "Frame label",
  "director annotation visible",
  "tiny unreadable text",
  "garbled characters",
  "subtitle",
  "voiceover",
  "dialogue",
  "lip sync speech",
  "background music",
  "watermark",
].join(", ");

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 800)}` };
  }
}

async function requestJson(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...(init.headers || {}),
    },
  });
  return { response, data: await readJson(response) };
}

function pngDimensions(bytes: Buffer) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "生成图片不是PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function persistImage(token: string, url: string, index: number) {
  const persisted = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
    method: "POST",
    body: JSON.stringify({ url, index }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(
    persisted.response.ok && /^https?:\/\//u.test(String(persisted.data.url || "")),
    persisted.data.error || "参考图持久化失败",
  );
  return String(persisted.data.url);
}

async function pollVideo(token: string, taskId: string, contentUrl: string) {
  let terminal: Json = {};
  for (let poll = 1; poll <= 110; poll += 1) {
    if (poll > 1) await sleep(8_000);
    const params = new URLSearchParams({
      taskId,
      modelId: videoModelId,
      contentUrl,
      targetDuration: "10",
    });
    const status = await requestJson(`${baseUrl}/api/video/status?${params.toString()}`, token, {
      signal: AbortSignal.timeout(90_000),
      cache: "no-store",
    });
    if (!status.response.ok) {
      terminal = { status: "failed", error: status.data.error || status.data.errorMessage || `status ${status.response.status}` };
      continue;
    }
    terminal = status.data;
    if (poll === 1 || poll % 4 === 0) {
      console.log(JSON.stringify({ phase: "video-poll", poll, status: terminal.status, progress: terminal.progress ?? null }));
    }
    if (terminal.status === "completed" && (terminal.videoUrl || terminal.video_url)) return terminal;
    if (["failed", "cancelled"].includes(String(terminal.status))) return terminal;
  }
  return terminal;
}

async function downloadVideo(token: string, taskId: string) {
  const ticket = await requestJson(
    `${baseUrl}/api/video/access-ticket?taskId=${encodeURIComponent(taskId)}&scope=download&name=${encodeURIComponent("douyin-sos-10s.mp4")}`,
    token,
  );
  assert.ok(ticket.response.ok && ticket.data.url, ticket.data.error || "视频下载票据失败");
  const download = await fetch(new URL(String(ticket.data.url), baseUrl), { signal: AbortSignal.timeout(300_000) });
  assert.ok(download.ok, `视频下载失败(${download.status})`);
  return Buffer.from(await download.arrayBuffer());
}

async function captureFrames(videoPath: string, outputDir: string) {
  await mkdir(outputDir, { recursive: true });
  const htmlPath = path.join(outputDir, "viewer.html");
  await writeFile(
    htmlPath,
    `<!doctype html><video muted playsinline preload="auto" src="${pathToFileURL(videoPath).href}" style="width:960px;height:540px;object-fit:contain;background:#000"></video>`,
    "utf8",
  );
  const browser = await chromium.launch({ headless: true, args: ["--allow-file-access-from-files"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 580 } });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load", timeout: 30_000 });
    const video = page.locator("video");
    await page.waitForFunction(() => {
      const element = document.querySelector("video");
      return element && element.readyState >= 2 && Number.isFinite(element.duration);
    }, undefined, { timeout: 30_000 });
    const duration = await video.evaluate((element) => (element as HTMLVideoElement).duration);
    const captures: number[] = [];
    for (let index = 0; index < 16; index += 1) {
      const target = Math.min(duration - 0.12, 0.25 + (index * Math.max(0.2, duration - 0.5)) / 15);
      await video.evaluate((element, currentTime) => { (element as HTMLVideoElement).currentTime = currentTime; }, target);
      await page.waitForTimeout(450);
      const current = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
      captures.push(current);
      await video.screenshot({ path: path.join(outputDir, `${String(index + 1).padStart(2, "0")}-${current.toFixed(2)}s.png`) });
    }
    return { duration, captures };
  } finally {
    await browser.close();
  }
}

async function makeContactSheet(frameDir: string, outputPath: string) {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir(frameDir)).filter((name) => name.endsWith(".png")).sort().slice(0, 16);
  assert.equal(files.length, 16, `expected 16 frames, got ${files.length}`);
  const cells = files.map((name) => `<figure><img src="${pathToFileURL(path.join(frameDir, name)).href}"><figcaption>${name.replace(/^\d+-/, "")}</figcaption></figure>`).join("");
  const htmlPath = path.join(frameDir, "contact-sheet.html");
  await writeFile(htmlPath, `<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#111;color:#fff;font:18px Arial}.grid{display:grid;grid-template-columns:repeat(4,480px);gap:6px;padding:6px}figure{margin:0;background:#222}img{display:block;width:480px;height:270px;object-fit:cover}figcaption{height:30px;padding:4px 8px}</style><div class="grid">${cells}</div>`, "utf8");
  const browser = await chromium.launch({ headless: true, args: ["--allow-file-access-from-files"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1944, height: 1230 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.screenshot({ path: outputPath, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse);
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");
  const token = String(session.token);

  console.log(JSON.stringify({ phase: "agent-compile", script }));
  const compiled = await requestJson(`${baseUrl}/api/storyboard/compile`, token, {
    method: "POST",
    body: JSON.stringify({
      script,
      style,
      ratio: "16:9",
      panelMode: "fixed-5",
      model: "glm-5.1",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(compiled.response.ok && compiled.data.project, compiled.data.error || "智能体编译失败");
  const project = compiled.data.project as Json;
  await writeFile(path.join(outDir, "compiled-project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");
  assert.equal(project.segments.length, 1, "10秒测试应只生成一个分段");
  const segment = project.segments[0];
  assert.equal(segment.narration, script, "智能体改写了测试文案");

  const promptAudit = {
    hasStoryboardImagePrompt: String(segment.storyboardImagePrompt || "").length > 500,
    hasVideoPrompt: String(segment.videoPrompt || "").length > 300,
    imageHasAnnotationMode: /Frame|说明条|导演说明|每格下方|分镜说明/u.test(String(segment.storyboardImagePrompt || "")),
    imageHasHighEnergyPackaging: /红黑|金色|警示|爆炸|速度线|光/u.test(String(segment.storyboardImagePrompt || "")),
    videoNoNarrationLeak: !String(segment.videoPrompt || "").includes("口播") && !String(segment.videoPrompt || "").includes("旁白"),
    videoHasSceneSound: /环境声|动作音|现场声|摩擦|脚步|呼吸/u.test(String(segment.videoPrompt || "")),
  };
  assert.ok(Object.values(promptAudit).every(Boolean), `提示词门禁失败：${JSON.stringify(promptAudit)}`);

  console.log(JSON.stringify({ phase: "image-submit", model: imageModelId }));
  const imageResult = await requestJson(`${baseUrl}/api/image/generate`, token, {
    method: "POST",
    body: JSON.stringify({
      prompt: segment.storyboardImagePrompt,
      mode: "local",
      modelId: imageModelId,
      style: "",
      aspectRatio: "16:9",
      resolution: "2K",
      coverText: "",
      referenceImageUrls: [],
      referenceUsage: "general",
      clientTraceId: randomUUID(),
      clientNodeId: `${runId}-segment-1`,
      clientNodeTitle: "抖音爆款选题10秒高能参考图",
    }),
    signal: AbortSignal.timeout(420_000),
  });
  const generatedUrl = (imageResult.data.images as Array<{ url?: string }> | undefined)?.[0]?.url;
  assert.ok(imageResult.response.ok && generatedUrl, imageResult.data.error || "生图失败");
  const imageDownload = await fetch(generatedUrl, { signal: AbortSignal.timeout(180_000) });
  assert.ok(imageDownload.ok, `图片下载失败(${imageDownload.status})`);
  const imageBytes = Buffer.from(await imageDownload.arrayBuffer());
  const dimensions = pngDimensions(imageBytes);
  const imageLocalPath = path.join(outDir, "segment-1-gpt-image-2-pro-2k.png");
  const imagePublicFilename = `${reviewId}-segment-1.png`;
  const imagePublicPath = path.resolve("public", "storyboard-reviews", imagePublicFilename);
  await Promise.all([writeFile(imageLocalPath, imageBytes), writeFile(imagePublicPath, imageBytes)]);
  const persistedImageUrl = await persistImage(token, generatedUrl, 1);
  console.log(JSON.stringify({ phase: "image-complete", dimensions, bytes: imageBytes.length }));

  console.log(JSON.stringify({ phase: "video-submit", model: videoModelId, duration: 10 }));
  const videoResult = await requestJson(`${baseUrl}/api/video/generate`, token, {
    method: "POST",
    body: JSON.stringify({
      model_id: videoModelId,
      prompt: segment.videoPrompt,
      image_url: persistedImageUrl,
      duration: 10,
      aspect_ratio: "16:9",
      resolution_tier: "1080p",
      negative_prompt: negativePrompt,
      task_label: "抖音爆款选题10秒高能视频测试",
      batch_id: runId,
      batch_topic: "storyboard-workbench",
      card_index: 1,
    }),
    signal: AbortSignal.timeout(240_000),
  });
  assert.ok(videoResult.response.ok && (videoResult.data.task_id || videoResult.data.video_url), videoResult.data.error || "视频提交失败");
  const taskId = String(videoResult.data.task_id || "");
  const contentUrl = String(videoResult.data.content_url || "");
  let terminal = videoResult.data;
  if (!(terminal.status === "completed" && terminal.video_url)) {
    terminal = await pollVideo(token, taskId, contentUrl);
  }
  assert.ok(
    terminal.status === "completed" && (terminal.videoUrl || terminal.video_url),
    terminal.errorMessage || terminal.error || `视频未完成：${terminal.status}`,
  );
  const videoBytes = await downloadVideo(token, taskId);
  assert.ok(videoBytes.length > 100_000, "视频文件过小");
  const videoLocalPath = path.join(outDir, "segment-1-omni-flash-10s-1080p.mp4");
  const videoPublicFilename = `${reviewId}-segment-1.mp4`;
  await Promise.all([
    writeFile(videoLocalPath, videoBytes),
    writeFile(path.resolve("public", "storyboard-reviews", videoPublicFilename), videoBytes),
  ]);
  const frameDir = path.join(outDir, "segment-1-frames");
  const capture = await captureFrames(videoLocalPath, frameDir);
  const sheetLocalPath = path.join(outDir, "segment-1-contact-sheet.png");
  const sheetPublicFilename = `${reviewId}-segment-1-contact-sheet.png`;
  await makeContactSheet(frameDir, sheetLocalPath);
  await writeFile(path.resolve("public", "storyboard-reviews", sheetPublicFilename), await readFile(sheetLocalPath));

  const now = Date.now();
  const review = {
    reviewId,
    generatedAt: new Date().toISOString(),
    sourceTopic: "Douyin-inspired pet health SOS hook, original rewritten test copy",
    status: "MEDIA_GENERATED_AWAITING_VISUAL_EVALUATION",
    run: {
      id: runId,
      title: "10秒高能包装测试｜狗狗求救信号",
      createdAt: now,
      updatedAt: now,
      script,
      ratio: "16:9",
      panelMode: "fixed-5 annotation storyboard",
      style,
      llmModel: "glm-5.1",
      imageModelId,
      videoModelId,
      cards: [{
        id: `${runId}-card-1`,
        order: 1,
        label: `10秒测试｜${script}`,
        narration: script,
        imagePrompt: segment.storyboardImagePrompt,
        videoPrompt: segment.videoPrompt,
        referenceImageUrls: [`/storyboard-reviews/${imagePublicFilename}`],
        imageStatus: "done",
        imageUrl: `/storyboard-reviews/${imagePublicFilename}`,
        imageValidatedAt: now,
        imageModelIdUsed: imageModelId,
        videoStatus: "done",
        videoUrl: `/storyboard-reviews/${videoPublicFilename}`,
        videoTaskId: taskId,
        videoTaskModelId: videoModelId,
        videoProgress: 100,
        videoStatusDetail: "真实10秒参考图视频已生成，待人工质检",
        contactSheetUrl: `/storyboard-reviews/${sheetPublicFilename}`,
      }],
    },
    promptAudit,
    localArtifacts: [{
      segmentNumber: 1,
      image: imageLocalPath,
      video: videoLocalPath,
      contactSheet: sheetLocalPath,
      frames: frameDir,
    }],
    media: {
      image: {
        localPath: imageLocalPath,
        publicUrl: `/storyboard-reviews/${imagePublicFilename}`,
        persistedImageUrl,
        dimensions,
        bytes: imageBytes.length,
        sha256: sha256(imageBytes),
      },
      video: {
        localPath: videoLocalPath,
        publicUrl: `/storyboard-reviews/${videoPublicFilename}`,
        contactSheetUrl: `/storyboard-reviews/${sheetPublicFilename}`,
        taskId,
        bytes: videoBytes.length,
        sha256: sha256(videoBytes),
        duration: capture.duration,
        captures: capture.captures,
      },
    },
    project,
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1100 } });
    await context.addInitScript((authToken) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.removeItem("storyboard_prompt_workbench_current_v2");
      localStorage.removeItem("storyboard_prompt_workbench_history_v2");
    }, token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/storyboard-workbench?review=${reviewId}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `review页面打开失败(${response?.status()})`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(outDir, "review-page.png"), fullPage: true });
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    passed: true,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    script,
    image: `/storyboard-reviews/${imagePublicFilename}`,
    video: `/storyboard-reviews/${videoPublicFilename}`,
    contactSheet: `/storyboard-reviews/${sheetPublicFilename}`,
    promptAudit,
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : JSON.stringify(error),
  };
  await writeFile(path.join(outDir, "fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
