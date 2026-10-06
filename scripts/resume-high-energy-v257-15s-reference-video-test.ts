import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { chromium } from "playwright";

config({ path: ".env.local", quiet: true });

type Json = Record<string, any>;

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const checkpointId = "high-energy-v257-15s-five-ab-1786941961675";
const reviewId = `${checkpointId}-reference-video-ab`;
const runId = `${reviewId}-run`;
const checkpointPath = path.resolve(".tmp-e2e", `${checkpointId}-agent-checkpoint.json`);
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const imagePublicId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const videoModels = [
  {
    key: "h3",
    publicId: "pm_uWPP2c8a5PdRFT0kpRRjRuJ2",
    label: "MiniMax H3 15秒",
    resolution: "1080p",
  },
  {
    key: "grok-preview",
    publicId: "pm_eY5Mkb2Yon-w3uzwnuSdyY7R",
    label: "Grok Imagine Video 1.5 Preview 15秒",
    resolution: "",
  },
];

const negativePrompt = [
  "photorealistic live action",
  "real human face",
  "semi-realistic commercial CGI",
  "split screen final video",
  "storyboard grid in final video",
  "panel border in final video",
  "caption strip",
  "Frame label",
  "director annotation visible",
  "tiny UI text",
  "garbled characters",
  "subtitle",
  "narration voice",
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
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "图片不是PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function imageDataUrl(bytes: Buffer) {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

async function persistImage(token: string, bytesOrUrl: Buffer | string, index: number) {
  const source = Buffer.isBuffer(bytesOrUrl) ? imageDataUrl(bytesOrUrl) : bytesOrUrl;
  const persisted = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
    method: "POST",
    body: JSON.stringify({ url: source, index }),
    signal: AbortSignal.timeout(180_000),
  });
  assert.ok(
    persisted.response.ok && /^https?:\/\//u.test(String(persisted.data.url || "")),
    persisted.data.error || `第${index}张参考图持久化失败`,
  );
  return String(persisted.data.url);
}

async function ensureStoryboardImage(segment: Json, token: string) {
  await mkdir(outDir, { recursive: true });
  const publicFilename = `${checkpointId}-segment-${segment.order}.png`;
  const publicPath = path.resolve("public", "storyboard-reviews", publicFilename);
  const localPath = path.join(outDir, `segment-${segment.order}-gpt-image-2-pro-2k.png`);

  try {
    const existing = await readFile(publicPath);
    const dimensions = pngDimensions(existing);
    await writeFile(localPath, existing);
    const persistedUrl = await persistImage(token, existing, segment.order);
    return {
      status: "done",
      source: "existing",
      localPath,
      publicReviewUrl: `/storyboard-reviews/${publicFilename}`,
      persistedUrl,
      dimensions,
      bytes: existing.length,
      sha256: sha256(existing),
    };
  } catch {
    // Existing public image is optional; generate only missing segments.
  }

  console.log(JSON.stringify({ phase: "image-submit", segment: segment.order, model: imagePublicId, resolution: "2K" }));
  const generated = await requestJson(`${baseUrl}/api/image/generate`, token, {
    method: "POST",
    body: JSON.stringify({
      prompt: segment.imagePrompt,
      mode: "local",
      modelId: imagePublicId,
      style: "",
      aspectRatio: "16:9",
      resolution: "2K",
      coverText: "",
      referenceImageUrls: [],
      referenceUsage: "general",
      clientTraceId: randomUUID(),
      clientNodeId: `${runId}-segment-${segment.order}`,
      clientNodeTitle: `15秒高能参考图${segment.order}`,
    }),
    signal: AbortSignal.timeout(420_000),
  });
  const generatedUrl = (generated.data.images as Array<{ url?: string }> | undefined)?.[0]?.url;
  if (!generated.response.ok || !generatedUrl) {
    return {
      status: "failed",
      source: "generated",
      error: generated.data.error || `生图提交失败(${generated.response.status})`,
    };
  }
  const download = await fetch(generatedUrl, { signal: AbortSignal.timeout(180_000) });
  assert.ok(download.ok, `第${segment.order}张原图下载失败(${download.status})`);
  const bytes = Buffer.from(await download.arrayBuffer());
  const dimensions = pngDimensions(bytes);
  await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);
  const persistedUrl = await persistImage(token, generatedUrl, segment.order);
  console.log(JSON.stringify({ phase: "image-complete", segment: segment.order, dimensions, bytes: bytes.length }));
  return {
    status: "done",
    source: "generated",
    generatedUrl,
    localPath,
    publicReviewUrl: `/storyboard-reviews/${publicFilename}`,
    persistedUrl,
    dimensions,
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

async function downloadVideo(token: string, taskId: string, name: string) {
  const ticket = await requestJson(
    `${baseUrl}/api/video/access-ticket?taskId=${encodeURIComponent(taskId)}&scope=download&name=${encodeURIComponent(name)}`,
    token,
  );
  assert.ok(ticket.response.ok && ticket.data.url, ticket.data.error || `视频下载票据失败：${taskId}`);
  const download = await fetch(new URL(String(ticket.data.url), baseUrl), { signal: AbortSignal.timeout(300_000) });
  assert.ok(download.ok, `视频下载失败(${download.status})：${taskId}`);
  return Buffer.from(await download.arrayBuffer());
}

async function pollVideo(token: string, card: Json, modelId: string) {
  if (card.status !== "running") return;
  let terminal = card.submitResponse;
  for (let poll = 1; poll <= 150; poll += 1) {
    if (poll > 1) await sleep(8_000);
    const params = new URLSearchParams({
      taskId: card.taskId,
      modelId,
      contentUrl: card.contentUrl || "",
      targetDuration: "15",
    });
    const status = await requestJson(`${baseUrl}/api/video/status?${params.toString()}`, token, {
      signal: AbortSignal.timeout(90_000),
      cache: "no-store",
    });
    if (!status.response.ok) {
      card.pollErrors = [...(card.pollErrors || []), {
        poll,
        status: status.response.status,
        error: status.data.error || status.data.errorMessage,
      }];
      if (card.pollErrors.length >= 5) break;
      continue;
    }
    terminal = status.data;
    card.pollCount = poll;
    card.progress = terminal.progress ?? null;
    card.lastStatus = terminal.status;
    if (poll === 1 || poll % 4 === 0) {
      console.log(JSON.stringify({
        phase: "video-poll",
        segment: card.segmentOrder,
        model: card.modelKey,
        poll,
        status: terminal.status,
        progress: terminal.progress ?? null,
      }));
    }
    if (terminal.status === "completed" && (terminal.videoUrl || terminal.video_url)) break;
    if (["failed", "cancelled"].includes(String(terminal.status))) break;
  }
  const terminalStatus = String(terminal?.status || "");
  const terminalVideoUrl = String(terminal?.videoUrl || terminal?.video_url || "");
  if (!(terminalStatus === "completed" && terminalVideoUrl)) {
    card.status = "failed";
    card.error = terminal?.errorMessage || terminal?.error || `video terminal status: ${terminalStatus || "unknown"}`;
    card.terminalResponse = terminal;
    return;
  }
  card.status = "completed";
  card.playbackUrl = terminalVideoUrl;
  card.terminalResponse = terminal;
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
      const target = Math.min(duration - 0.15, 0.3 + (index * Math.max(0.2, duration - 0.6)) / 15);
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
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Json;
  assert.equal(checkpoint.reviewId, checkpointId);
  assert.equal(checkpoint.promptPassed, true, "checkpoint提示词门禁未通过，停止测试");
  const segmentLimit = Math.min(
    checkpoint.parsed.length,
    Number(process.env.SEGMENT_LIMIT || checkpoint.parsed.length) || checkpoint.parsed.length,
  );
  const selectedSegments = checkpoint.parsed.slice(0, segmentLimit);

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse);
  assert.ok(sessionResponse.ok && session.token, session.error || "本地测试会话不可用");
  const token = String(session.token);

  const modelList = await requestJson(`${baseUrl}/api/video/models`, token);
  assert.ok(modelList.response.ok, modelList.data.error || "视频模型列表不可用");
  const publicModels = modelList.data.models as Json[];
  for (const model of videoModels) {
    assert.ok(publicModels.some((item) => item.id === model.publicId), `视频模型不可用：${model.label}`);
  }

  const state: Json = {
    schema: "high_energy_v257_15s_reference_video_ab.v1",
    checkpointId,
    reviewId,
    startedAt: new Date().toISOString(),
    segmentLimit,
    modelRoutes: videoModels,
    imageModelId: imagePublicId,
    images: [],
    videos: [],
  };

  for (const segment of selectedSegments) {
    const image = await ensureStoryboardImage(segment, token);
    state.images.push({ segmentOrder: segment.order, ...image });
    await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (image.status !== "done") continue;

    for (const model of videoModels) {
      const card: Json = {
        segmentOrder: segment.order,
        modelKey: model.key,
        modelLabel: model.label,
        modelId: model.publicId,
        status: "submitting",
        submittedAt: new Date().toISOString(),
        promptSha256: sha256(segment.videoPrompt),
        imageUrl: image.publicReviewUrl,
        persistedImageUrl: image.persistedUrl,
        negativePrompt,
      };
      state.videos.push(card);
      await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ phase: "video-submit", segment: segment.order, model: model.label, duration: 15 }));
      const submitted = await requestJson(`${baseUrl}/api/video/generate`, token, {
        method: "POST",
        body: JSON.stringify({
          model_id: model.publicId,
          prompt: segment.videoPrompt,
          image_url: image.persistedUrl,
          duration: 15,
          aspect_ratio: "16:9",
          resolution_tier: model.resolution,
          negative_prompt: negativePrompt,
          task_label: `15秒高能参考图测试｜段${segment.order}｜${model.label}`,
          batch_id: runId,
          batch_topic: "storyboard-workbench",
          card_index: Number(`${segment.order}${model.key === "h3" ? 1 : 2}`),
        }),
        signal: AbortSignal.timeout(240_000),
      });
      card.submitHttpStatus = submitted.response.status;
      card.submitResponse = submitted.data;
      if (!submitted.response.ok || (!submitted.data.task_id && !submitted.data.video_url)) {
        card.status = "failed";
        card.error = submitted.data.error || `视频提交失败(${submitted.response.status})`;
        await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
        console.log(JSON.stringify({ phase: "video-failed", segment: segment.order, model: model.key, error: card.error }));
        continue;
      }
      card.taskId = String(submitted.data.task_id || "");
      card.contentUrl = String(submitted.data.content_url || "");
      card.status = submitted.data.status === "completed" && submitted.data.video_url ? "completed" : "running";
      if (card.status === "completed") card.playbackUrl = String(submitted.data.video_url);
      await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
      await pollVideo(token, card, model.publicId);
      if (card.status !== "completed") {
        await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
        console.log(JSON.stringify({ phase: "video-failed", segment: segment.order, model: model.key, error: card.error }));
        continue;
      }
      const bytes = await downloadVideo(token, card.taskId, `segment-${segment.order}-${model.key}.mp4`);
      const publicFilename = `${reviewId}-segment-${segment.order}-${model.key}.mp4`;
      const localPath = path.join(outDir, `segment-${segment.order}-${model.key}.mp4`);
      const publicPath = path.resolve("public", "storyboard-reviews", publicFilename);
      await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);
      card.status = "done";
      card.localPath = localPath;
      card.publicReviewUrl = `/storyboard-reviews/${publicFilename}`;
      card.bytes = bytes.length;
      card.sha256 = sha256(bytes);
      const frameDir = path.join(outDir, `segment-${segment.order}-${model.key}-frames`);
      const capture = await captureFrames(localPath, frameDir);
      const sheetPublicFilename = `${reviewId}-segment-${segment.order}-${model.key}-contact-sheet.png`;
      const sheetLocalPath = path.join(outDir, `segment-${segment.order}-${model.key}-contact-sheet.png`);
      await makeContactSheet(frameDir, sheetLocalPath);
      await writeFile(path.resolve("public", "storyboard-reviews", sheetPublicFilename), await readFile(sheetLocalPath));
      card.frameDir = frameDir;
      card.contactSheetUrl = `/storyboard-reviews/${sheetPublicFilename}`;
      card.duration = capture.duration;
      card.captures = capture.captures;
      console.log(JSON.stringify({ phase: "video-complete", segment: segment.order, model: model.key, duration: capture.duration, bytes: bytes.length }));
      await writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }
  }

  const now = Date.now();
  const cards = state.videos.map((video: Json, index: number) => {
    const segment = selectedSegments.find((item: Json) => Number(item.order) === Number(video.segmentOrder));
    const image = state.images.find((item: Json) => Number(item.segmentOrder) === Number(video.segmentOrder));
    return {
      id: `${runId}-card-${index + 1}`,
      order: index + 1,
      label: `段${video.segmentOrder}｜${video.modelLabel}`,
      narration: segment?.narration || "",
      imagePrompt: segment?.imagePrompt || "",
      videoPrompt: segment?.videoPrompt || "",
      referenceImageUrls: [image?.publicReviewUrl].filter(Boolean),
      imageStatus: image?.status === "done" ? "done" : "failed",
      imageUrl: image?.publicReviewUrl,
      imageValidatedAt: now,
      imageModelIdUsed: imagePublicId,
      videoStatus: video.status === "done" ? "done" : "failed",
      videoUrl: video.publicReviewUrl,
      videoError: video.error,
      videoTaskId: video.taskId,
      videoTaskModelId: video.modelId,
      videoProgress: video.status === "done" ? 100 : video.progress,
      videoStatusDetail: video.status === "done" ? "15秒真实参考图视频已生成，待人工质检" : video.error,
      contactSheetUrl: video.contactSheetUrl,
    };
  });

  const review = {
    reviewId,
    generatedAt: new Date().toISOString(),
    sourceCheckpoint: checkpointId,
    status: state.videos.every((video: Json) => video.status === "done") ? "MEDIA_GENERATED_AWAITING_VISUAL_EVALUATION" : "MEDIA_GENERATED_WITH_FAILURES",
    run: {
      id: runId,
      title: "高能v2.5.7｜15秒参考图视频A/B测试",
      createdAt: now,
      updatedAt: now,
      script: checkpoint.segments.slice(0, segmentLimit).join("\n"),
      ratio: "16:9",
      panelMode: "图文导演注释版完整故事板参考图",
      style: "对标皮克斯式高能3D宠物科普动画",
      imageModelId: imagePublicId,
      videoModelId: videoModels.map((model) => model.publicId).join(","),
      cards,
    },
    promptGate: {
      promptPassed: checkpoint.promptPassed,
      checks: checkpoint.checks,
      note: "本轮视频直接使用智能体原始15秒图生视频Prompt，未套用旧单首帧运行时guard。",
    },
    state,
  };
  await Promise.all([
    writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8"),
    writeFile(path.join(outDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8"),
  ]);

  console.log(JSON.stringify({
    passed: state.videos.some((video: Json) => video.status === "done"),
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    reviewPath,
    images: state.images.map((image: Json) => ({ segment: image.segmentOrder, status: image.status, url: image.publicReviewUrl })),
    videos: state.videos.map((video: Json) => ({
      segment: video.segmentOrder,
      model: video.modelKey,
      status: video.status,
      url: video.publicReviewUrl,
      contactSheet: video.contactSheetUrl,
      error: video.error,
    })),
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
