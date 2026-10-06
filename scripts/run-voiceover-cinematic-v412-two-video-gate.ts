import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";
import { buildStoryboardVideoPrompt } from "../src/lib/storyboard-video-prompt";

config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = "voiceover-cinematic-random-two-segments-v412-fullchain-pro2k-omni10-20260817";
const runId = `${reviewId}-run`;
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const imageStatePath = path.join(outDir, "image-gate-state.json");
const statePath = path.join(outDir, "video-gate-state.json");
const agentId = "agent-1786633444187-594spj";
const expectedSchema = "storyboard_director_output_style.v4.1.2";
const expectedPromptSha = "a3cff0f42e0bb11bd492e72dee5ade3210d661decf8b8e14ebae855f8634cf9a";
const videoPublicId = "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
const videoDbId = "omni-flash-10s-720p-ch3";
const negativePrompt = "storyboard grid, panel borders, panel numbers, caption strips, collage, split screen, duplicated subjects, style drift, dialogue, lip sync, subtitles, text, brand, watermark, background music, laser, scan, magic";

type Json = Record<string, any>;

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return { error: `non-JSON response (${response.status}): ${raw.slice(0, 500)}` };
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

async function cropTopLeftPanel(page: Page, sourceBytes: Buffer) {
  const sourceUrl = `data:image/png;base64,${sourceBytes.toString("base64")}`;
  const dataUrl = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = Math.floor(image.naturalWidth / 2);
    const height = Math.floor(image.naturalHeight / 2);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(image, 0, 0, width, height, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  }, sourceUrl);
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  return { dataUrl, bytes, width: 1280, height: 720 };
}

async function pollVideo(card: Json, token: string, state: Json) {
  if (card.video.status !== "running") return;
  let terminal = card.video.submitResponse;
  const startedAt = Date.parse(card.video.submittedAt);
  for (let poll = 1; poll <= 110; poll += 1) {
    if (poll > 1) await sleep(8_000);
    const params = new URLSearchParams({
      taskId: card.video.taskId,
      modelId: videoPublicId,
      contentUrl: card.video.contentUrl || "",
      targetDuration: "10",
    });
    const status = await requestJson(`${baseUrl}/api/video/status?${params.toString()}`, token, {
      signal: AbortSignal.timeout(90_000),
      cache: "no-store",
    });
    if (!status.response.ok) {
      card.video.pollErrors = [...(card.video.pollErrors || []), {
        poll,
        status: status.response.status,
        error: status.data.error || status.data.errorMessage,
      }];
      if (card.video.pollErrors.length >= 5) break;
      continue;
    }
    terminal = status.data;
    card.video.pollCount = poll;
    card.video.progress = terminal.progress ?? null;
    card.video.lastStatus = terminal.status;
    if (poll === 1 || poll % 4 === 0) {
      console.log(JSON.stringify({ phase: "video-poll", card: card.order, poll, status: terminal.status, progress: terminal.progress ?? null }));
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    if (terminal.status === "completed" && (terminal.videoUrl || terminal.video_url)) break;
    if (["failed", "cancelled"].includes(String(terminal.status))) break;
  }

  const terminalStatus = String(terminal?.status || "");
  const terminalVideoUrl = String(terminal?.videoUrl || terminal?.video_url || "");
  if (!(terminalStatus === "completed" && terminalVideoUrl)) {
    card.video.status = "failed";
    card.video.error = terminal?.errorMessage || terminal?.error || `video terminal status: ${terminalStatus || "unknown"}`;
    card.video.terminalResponse = terminal;
    card.video.elapsedMs = Date.now() - startedAt;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
    return;
  }

  const ticket = await requestJson(
    `${baseUrl}/api/video/access-ticket?taskId=${encodeURIComponent(card.video.taskId)}&scope=download&name=${encodeURIComponent(`segment-${card.order}.mp4`)}`,
    token,
  );
  assert.ok(ticket.response.ok && ticket.data.url, ticket.data.error || `card ${card.order} access ticket failed`);
  const download = await fetch(new URL(ticket.data.url, baseUrl), { signal: AbortSignal.timeout(240_000) });
  assert.ok(download.ok, `card ${card.order} video download failed (${download.status})`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.ok(bytes.length > 100_000, `card ${card.order} video file is too small`);
  const localPath = path.join(outDir, `segment-${card.order}-omni-flash-10s-1080p.mp4`);
  const publicFilename = `${reviewId}-segment-${card.order}.mp4`;
  const publicPath = path.resolve("public", "storyboard-reviews", publicFilename);
  await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);
  card.video = {
    ...card.video,
    status: "done",
    completedAt: new Date().toISOString(),
    terminalResponse: terminal,
    playbackUrl: terminalVideoUrl,
    localOriginalPath: localPath,
    publicReviewUrl: `/storyboard-reviews/${publicFilename}`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    elapsedMs: Date.now() - startedAt,
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ phase: "video-complete", card: card.order, taskId: card.video.taskId, bytes: bytes.length }));
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const review = JSON.parse(await readFile(reviewPath, "utf8")) as Json;
  const imageState = JSON.parse(await readFile(imageStatePath, "utf8")) as Json;
  assert.equal(review.schemaVersion, expectedSchema);
  assert.equal(review.promptSha256, expectedPromptSha);
  assert.equal(review.run.cards.length, 2);
  assert.equal(imageState.submissions.length, 2);
  assert.ok(imageState.submissions.every((item: Json) => item.status === "done" && item.localOriginalPath));
  assert.ok(review.run.cards.every((card: Json) => card.imageStatus === "done" && card.videoStatus === "idle"));

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse);
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "local dev session unavailable");
  const token = String(session.token);

  const [agents, videoModels] = await Promise.all([
    requestJson(`${baseUrl}/api/admin/agents`, token),
    requestJson(`${baseUrl}/api/video/models`, token),
  ]);
  const onlineAgent = agents.data.agents?.find((agent: Json) => agent.id === agentId);
  assert.ok(onlineAgent?.system_prompt, "online cinematic agent missing");
  assert.equal(onlineAgent.output_style?.schema_version, expectedSchema, "online schema changed; stop before paid video");
  assert.equal(sha256(onlineAgent.system_prompt), expectedPromptSha, "online prompt SHA changed; stop before paid video");
  const publicVideoModel = videoModels.data.models?.find((model: Json) => model.id === videoPublicId);
  assert.ok(videoModels.response.ok && publicVideoModel, "public Omni 10s route missing");

  const dbUrl = process.env.COZE_SUPABASE_URL;
  const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  assert.ok(dbUrl && dbKey, "database configuration missing");
  const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const videoRowResult = await db.from("video_models")
    .select("id,name,model_name,price_per_use,is_active,is_hidden,supports_image_input,duration_seconds")
    .eq("id", videoDbId)
    .single();
  if (videoRowResult.error) throw videoRowResult.error;
  const videoRow = videoRowResult.data;
  assert.equal(videoRow.model_name, "omni_flash_10s");
  assert.equal(videoRow.is_active, true);
  assert.equal(videoRow.is_hidden, false);
  assert.equal(videoRow.supports_image_input, true);
  assert.equal(Number(videoRow.duration_seconds), 10);
  assert.equal(Number(videoRow.price_per_use), 0.55);

  const state: Json = {
    schema: "voiceover_cinematic_v412_video_gate.v1",
    reviewId,
    startedAt: new Date().toISOString(),
    conversationId: review.conversationId,
    imageGate: {
      verdict: "PASS",
      approvedForVideo: true,
      hardFailures: 0,
      notes: [
        "Heat scene uses an external text-free editorial cooling inset while the dog body remains intact.",
        "Sofa-ball scene preserves one ball, failed reach, owner entry, one release, pickup, and run-away order.",
        "The two segments use distinct indoor room families: study/work area and living/sofa area.",
      ],
    },
    modelRoute: {
      publicId: videoPublicId,
      dbId: videoDbId,
      name: videoRow.name,
      upstreamModel: videoRow.model_name,
      durationSeconds: 10,
      resolution: "1080p",
      priceCny: Number(videoRow.price_per_use),
    },
    retryPolicy: { paidVideoRetries: 0, submissionsPerCard: 1, submitIntervalMs: 8_000 },
    cards: review.run.cards.map((card: Json, index: number) => ({
      order: card.order,
      narration: card.narration,
      originalImagePrompt: card.imagePrompt,
      originalVideoPrompt: card.videoPrompt,
      image: imageState.submissions[index],
      video: { status: "preparing", apiAttempts: 0 },
    })),
  };
  const browser = await chromium.launch({ headless: true });
  const cropPage = await browser.newPage();
  try {
    for (const card of state.cards) {
      const sourceBytes = await readFile(card.image.localOriginalPath);
      const crop = await cropTopLeftPanel(cropPage, sourceBytes);
      const cropFilename = `segment-${card.order}-frame1-crop-1280x720.png`;
      const cropPath = path.join(outDir, cropFilename);
      const cropPublicPath = path.resolve("public", "storyboard-reviews", `${reviewId}-${cropFilename}`);
      await Promise.all([writeFile(cropPath, crop.bytes), writeFile(cropPublicPath, crop.bytes)]);
      const persisted = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
        method: "POST",
        body: JSON.stringify({ url: crop.dataUrl, index: 100 + card.order }),
        signal: AbortSignal.timeout(120_000),
      });
      assert.ok(persisted.response.ok && /^https?:\/\//u.test(String(persisted.data.url || "")), persisted.data.error || `card ${card.order} crop persist failed`);
      card.firstFrame = {
        localPath: cropPath,
        publicReviewUrl: `/storyboard-reviews/${reviewId}-${cropFilename}`,
        persistedUrl: String(persisted.data.url),
        dimensions: { width: crop.width, height: crop.height },
        sha256: sha256(crop.bytes),
      };
      const executionPrompt = buildStoryboardVideoPrompt({ prompt: card.originalVideoPrompt, duration: 10 });
      assert.ok(executionPrompt.length <= 4_000, `card ${card.order} execution prompt exceeds 4000 chars`);
      assert.ok(!executionPrompt.includes(card.narration), `card ${card.order} leaked narration into video prompt`);
      assert.ok(executionPrompt.includes("第一格裁出的单张16:9纯净首帧"));
      assert.ok(executionPrompt.includes("视频模型看不到其余故事板格"));
      assert.doesNotMatch(executionPrompt, /完整的一图多画面故事板|黄色连帽|中文短牌/u);
      card.video.executionPrompt = executionPrompt;
      card.video.executionPromptSha256 = sha256(executionPrompt);
      card.video.originalPromptSha256 = sha256(card.originalVideoPrompt);
    }
  } finally {
    await cropPage.close();
    await browser.close();
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  for (let index = 0; index < state.cards.length; index += 1) {
    if (index > 0) await sleep(8_000);
    const card = state.cards[index];
    card.video = {
      ...card.video,
      status: "submitting",
      apiAttempts: 1,
      submittedAt: new Date().toISOString(),
      negativePrompt,
    };
    console.log(JSON.stringify({ phase: "video-submit", card: card.order, model: videoPublicId, duration: 10, resolution: "1080p" }));
    const submitted = await requestJson(`${baseUrl}/api/video/generate`, token, {
      method: "POST",
      body: JSON.stringify({
        model_id: videoPublicId,
        prompt: card.video.executionPrompt,
        image_url: card.firstFrame.persistedUrl,
        duration: 10,
        aspect_ratio: "16:9",
        resolution_tier: "1080p",
        negative_prompt: negativePrompt,
        task_label: `分镜工作台镜头${card.order}`,
        batch_id: runId,
        batch_topic: "storyboard-workbench",
        card_index: card.order,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    card.video.submitHttpStatus = submitted.response.status;
    card.video.submitResponse = submitted.data;
    if (!submitted.response.ok || (!submitted.data.task_id && !submitted.data.video_url)) {
      card.video.status = "failed";
      card.video.error = submitted.data.error || `video submit failed (${submitted.response.status})`;
      console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
    } else {
      card.video.status = "running";
      card.video.taskId = String(submitted.data.task_id || "");
      card.video.contentUrl = String(submitted.data.content_url || "");
    }
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  await Promise.all(state.cards.map((card: Json) => pollVideo(card, token, state)));

  const videoTasks = await db.from("video_tasks")
    .select("id,task_id_external,model_id,status,card_index,duration_seconds,resolution,price_charged,error_message,created_at,completed_at")
    .eq("batch_id", runId)
    .order("created_at", { ascending: true });
  if (videoTasks.error) throw videoTasks.error;
  state.videoTaskRows = videoTasks.data || [];
  const successfulVideos = state.cards.filter((card: Json) => card.video.status === "done").length;
  const imageCost = Number(review.actualCost?.imageBusinessPriceCny || 0.4);
  state.actualCost = {
    agentCalls: 1,
    imageSubmissions: 2,
    successfulImages: 2,
    imageBusinessPriceCny: imageCost,
    videoSubmissions: state.cards.filter((card: Json) => card.video.apiAttempts === 1).length,
    successfulVideos,
    videoBusinessPriceCny: Number((successfulVideos * Number(videoRow.price_per_use)).toFixed(2)),
    totalBusinessPriceCny: Number((imageCost + successfulVideos * Number(videoRow.price_per_use)).toFixed(2)),
    paidRetries: 0,
  };
  state.completedAt = new Date().toISOString();

  review.status = successfulVideos === 2 ? "MEDIA_GENERATED_AWAITING_VISUAL_EVALUATION" : "VIDEO_GENERATION_COMPLETE_WITH_FAILURES";
  review.actualCost = state.actualCost;
  review.videoModelRoute = state.modelRoute;
  review.imageGate = state.imageGate;
  review.run.videoResolution = "1080p";
  review.run.videoDuration = 10;
  review.run.videoModelId = videoPublicId;
  review.run.updatedAt = Date.now();
  review.run.cards = review.run.cards.map((card: Json, index: number) => {
    const result = state.cards[index];
    return {
      ...card,
      referenceImageUrls: [result.firstFrame.publicReviewUrl],
      videoStatus: result.video.status === "done" ? "done" : "failed",
      videoUrl: result.video.publicReviewUrl,
      videoError: result.video.error,
      videoTaskId: result.video.taskId,
      videoTaskModelId: result.video.taskId ? videoPublicId : undefined,
      videoContentUrl: result.video.contentUrl,
      videoProgress: result.video.status === "done" ? 100 : result.video.progress,
      videoStartedAt: result.video.submittedAt ? Date.parse(result.video.submittedAt) : undefined,
      videoLastCheckedAt: result.video.completedAt ? Date.parse(result.video.completedAt) : undefined,
      videoStatusDetail: result.video.status === "done" ? "真实Omni 10秒视频已生成，待逐帧验收" : result.video.error,
      videoPollFailures: result.video.pollErrors?.length || 0,
    };
  });
  review.localArtifacts = state.cards.map((card: Json) => ({
    segmentNumber: card.order,
    storyboardImage: card.image.localOriginalPath,
    firstFrameCrop: card.firstFrame.localPath,
    video: card.video.localOriginalPath,
  }));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const reviewBrowser = await chromium.launch({ headless: true });
  try {
    const context = await reviewBrowser.newContext({ viewport: { width: 1680, height: 1100 } });
    await context.addInitScript((authToken) => {
      localStorage.setItem("auth_token", authToken);
      localStorage.removeItem("storyboard_prompt_workbench_current_v2");
      localStorage.removeItem("storyboard_prompt_workbench_history_v2");
    }, token);
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/storyboard-workbench?review=${reviewId}`, { waitUntil: "networkidle", timeout: 60_000 });
    assert.ok(response?.ok(), `review page failed (${response?.status()})`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".sbw-shot-card").count(), 2);
    await page.screenshot({ path: path.join(outDir, "review-page-with-videos.png"), fullPage: true });
    state.workbenchHistory = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]"));
    await writeFile(path.join(outDir, "workbench-history.json"), `${JSON.stringify(state.workbenchHistory, null, 2)}\n`, "utf8");
    await context.close();
  } finally {
    await reviewBrowser.close();
  }

  console.log(JSON.stringify({
    passed: successfulVideos === 2,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    conversationId: review.conversationId,
    actualCost: state.actualCost,
    videos: state.cards.map((card: Json) => ({ order: card.order, taskId: card.video.taskId, path: card.video.localOriginalPath })),
  }, null, 2));
}

main().catch(async (error) => {
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const failure = {
    passed: false,
    at: new Date().toISOString(),
    error: error instanceof Error ? error.stack || error.message : JSON.stringify(error),
    retryPolicy: "no automatic paid retry",
  };
  await writeFile(path.join(outDir, "video-gate-fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
