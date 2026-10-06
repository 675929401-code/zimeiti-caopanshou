import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { buildStoryboardVideoPrompt } from "../src/lib/storyboard-video-prompt";

config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = "high-energy-weight-corrected-segments-1-2-v353-fullchain-pro2k-omni10-20260816";
const runId = `${reviewId}-run`;
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const imageStatePath = path.join(outDir, "image-gate-state.json");
const statePath = path.join(outDir, "video-gate-state.json");
const agentId = "agent-1786633444187-594spj";
const expectedSchema = "storyboard_director_output_style.v3.5.3";
const expectedPromptSha = "8d71d01d0d3e5f9de8562fe09ec6cfba87a80017b12d37d110de8db2d95c925d";
const videoPublicId = "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
const videoDbId = "omni-flash-10s-720p-ch3";
const negativePrompt = "storyboard grid, panel borders, panel numbers, caption strips, collage, split screen, duplicated subjects, style drift, dialogue, lip sync, subtitles, background music";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(response: Response) {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as Record<string, any>;
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

async function main() {
  await mkdir(outDir, { recursive: true });
  const review = JSON.parse(await readFile(reviewPath, "utf8"));
  const imageState = JSON.parse(await readFile(imageStatePath, "utf8"));
  assert.equal(review.conversationId, imageState.conversationId);
  assert.equal(review.schemaVersion, expectedSchema);
  assert.equal(review.promptSha256, expectedPromptSha);
  assert.equal(imageState.cards?.length, 2);
  assert.ok(imageState.cards.every((card: any) => card.image?.status === "done" && card.image?.persistedUrl));
  assert.ok(imageState.cards.every((card: any) => sha256(card.originalVideoPrompt) === card.originalVideoPromptSha256));

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
  const onlineAgent = agents.data.agents?.find((agent: any) => agent.id === agentId);
  assert.ok(onlineAgent?.system_prompt, "online high-energy agent missing");
  assert.equal(onlineAgent.output_style?.schema_version, expectedSchema, "online schema changed; stop before paid video");
  assert.equal(sha256(onlineAgent.system_prompt), expectedPromptSha, "online prompt SHA changed; stop before paid video");
  const publicVideoModel = videoModels.data.models?.find((model: any) => model.id === videoPublicId);
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

  const state: Record<string, any> = {
    schema: "high_energy_weight_v353_video_gate.v1",
    reviewId,
    startedAt: new Date().toISOString(),
    conversationId: review.conversationId,
    imageGate: {
      verdict: "CONDITIONAL_PASS",
      approvedForVideo: true,
      hardFailures: 0,
      notes: [
        "Real-life scene and props are coherent; no health station, scanner, measurement ring, or concept stage.",
        "Segment 1 proverb is visually weak; segment 2 overweight-not-healthy contrast is understated.",
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
    retryPolicy: { paidVideoRetries: 0, submissionsPerCard: 1 },
    cards: imageState.cards.map((card: any) => ({ ...card, video: { status: "ready", apiAttempts: 0 } })),
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  for (const card of state.cards) {
    const executionPrompt = buildStoryboardVideoPrompt({
      prompt: card.originalVideoPrompt,
      duration: 10,
      narration: card.narration,
    });
    assert.ok(executionPrompt.length <= 4_000, `card ${card.order} execution prompt exceeds 4000 chars`);
    assert.ok(executionPrompt.includes(card.narration), `card ${card.order} missing exact narration guard`);
    card.video = {
      status: "submitting",
      apiAttempts: 1,
      submittedAt: new Date().toISOString(),
      originalPromptSha256: card.originalVideoPromptSha256,
      executionPrompt,
      executionPromptSha256: sha256(executionPrompt),
      adapter: "src/lib/storyboard-video-prompt.ts",
      negativePrompt,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "video-submit", card: card.order, model: videoPublicId, duration: 10, resolution: "1080p" }));

    const startedAt = Date.now();
    const submitted = await requestJson(`${baseUrl}/api/video/generate`, token, {
      method: "POST",
      body: JSON.stringify({
        model_id: videoPublicId,
        prompt: executionPrompt,
        image_url: card.image.persistedUrl,
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
      card.video.elapsedMs = Date.now() - startedAt;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
      continue;
    }

    const taskId = String(submitted.data.task_id || "");
    const contentUrl = String(submitted.data.content_url || "");
    card.video.taskId = taskId;
    card.video.contentUrl = contentUrl;
    card.video.status = "running";
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    let terminal = submitted.data;
    if (!(terminal.status === "completed" && terminal.video_url)) {
      for (let poll = 1; poll <= 110; poll += 1) {
        if (poll > 1) await sleep(8_000);
        const params = new URLSearchParams({ taskId, modelId: videoPublicId, contentUrl, targetDuration: "10" });
        const status = await requestJson(`${baseUrl}/api/video/status?${params.toString()}`, token, {
          signal: AbortSignal.timeout(90_000),
          cache: "no-store",
        });
        if (!status.response.ok) {
          card.video.pollErrors = [...(card.video.pollErrors || []), { poll, status: status.response.status, error: status.data.error || status.data.errorMessage }];
          if (card.video.pollErrors.length >= 5) break;
          continue;
        }
        terminal = status.data;
        card.video.pollCount = poll;
        card.video.progress = terminal.progress ?? null;
        card.video.lastStatus = terminal.status;
        if (poll === 1 || poll % 4 === 0) console.log(JSON.stringify({ phase: "video-poll", card: card.order, poll, status: terminal.status, progress: terminal.progress ?? null }));
        await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        if (terminal.status === "completed" && (terminal.videoUrl || terminal.video_url)) break;
        if (["failed", "cancelled"].includes(String(terminal.status))) break;
      }
    }

    const terminalStatus = String(terminal.status || "");
    const terminalVideoUrl = String(terminal.videoUrl || terminal.video_url || "");
    if (!(terminalStatus === "completed" && terminalVideoUrl)) {
      card.video.status = "failed";
      card.video.error = terminal.errorMessage || terminal.error || `video terminal status: ${terminalStatus || "unknown"}`;
      card.video.terminalResponse = terminal;
      card.video.elapsedMs = Date.now() - startedAt;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
      continue;
    }

    const ticket = await requestJson(`${baseUrl}/api/video/access-ticket?taskId=${encodeURIComponent(taskId)}&scope=download&name=${encodeURIComponent(`segment-${card.sourceSegmentNumber}.mp4`)}`, token);
    assert.ok(ticket.response.ok && ticket.data.url, ticket.data.error || `card ${card.order} access ticket failed`);
    const download = await fetch(new URL(ticket.data.url, baseUrl), { signal: AbortSignal.timeout(240_000) });
    assert.ok(download.ok, `card ${card.order} video download failed (${download.status})`);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.ok(bytes.length > 100_000, `card ${card.order} video file is too small`);
    const localPath = path.join(outDir, `segment-${card.sourceSegmentNumber}-omni-flash-10s-1080p.mp4`);
    const publicPath = path.resolve("public", "storyboard-reviews", `${reviewId}-segment-${card.sourceSegmentNumber}.mp4`);
    await Promise.all([writeFile(localPath, bytes), writeFile(publicPath, bytes)]);
    card.video = {
      ...card.video,
      status: "done",
      completedAt: new Date().toISOString(),
      terminalResponse: terminal,
      playbackUrl: terminalVideoUrl,
      localOriginalPath: localPath,
      publicReviewUrl: `/storyboard-reviews/${reviewId}-segment-${card.sourceSegmentNumber}.mp4`,
      bytes: bytes.length,
      sha256: sha256(bytes),
      elapsedMs: Date.now() - startedAt,
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ phase: "video-complete", card: card.order, taskId, bytes: bytes.length }));
  }

  const videoTasks = await db.from("video_tasks")
    .select("id,task_id_external,model_id,status,card_index,duration_seconds,resolution,price_charged,error_message,created_at,completed_at")
    .eq("batch_id", runId)
    .order("created_at", { ascending: true });
  if (videoTasks.error) throw videoTasks.error;
  state.videoTaskRows = videoTasks.data || [];
  const successfulVideos = state.cards.filter((card: any) => card.video.status === "done").length;
  state.actualCost = {
    agentCalls: imageState.actualCost.agentCalls,
    imageSubmissions: imageState.actualCost.imageSubmissions,
    successfulImages: imageState.actualCost.successfulImages,
    imageBusinessPriceCny: imageState.actualCost.imageBusinessPriceCny,
    videoSubmissions: state.cards.filter((card: any) => card.video.apiAttempts === 1).length,
    successfulVideos,
    videoBusinessPriceCny: Number((successfulVideos * Number(videoRow.price_per_use)).toFixed(2)),
    totalBusinessPriceCny: Number((imageState.actualCost.imageBusinessPriceCny + successfulVideos * Number(videoRow.price_per_use)).toFixed(2)),
    paidRetries: 0,
  };
  state.completedAt = new Date().toISOString();

  const now = Date.now();
  review.status = successfulVideos === 2 ? "media-generated-awaiting-visual-evaluation" : "video-generation-complete-with-failures";
  review.actualCost = state.actualCost;
  review.videoModelRoute = state.modelRoute;
  review.imageGate = state.imageGate;
  review.run.videoResolution = "1080p";
  review.run.videoDuration = 10;
  review.run.videoModelId = videoPublicId;
  review.run.updatedAt = now;
  review.run.cards = state.cards.map((card: any) => ({
    id: `${runId}-card-${card.order}`,
    order: card.order,
    label: `测试卡${card.order}｜${card.narration}`,
    narration: card.narration,
    imagePrompt: card.originalImagePrompt,
    videoPrompt: card.originalVideoPrompt,
    referenceImageUrls: [],
    imageStatus: "done",
    imageUrl: card.image.publicReviewUrl,
    imageValidatedAt: now,
    imageModelIdUsed: review.modelRoute.publicId,
    imageModelNameUsed: review.modelRoute.name,
    videoStatus: card.video.status === "done" ? "done" : "failed",
    videoUrl: card.video.publicReviewUrl,
    videoError: card.video.error,
    videoTaskId: card.video.taskId,
    videoTaskModelId: card.video.taskId ? videoPublicId : undefined,
    videoContentUrl: card.video.contentUrl,
    videoProgress: card.video.status === "done" ? 100 : card.video.progress,
    videoStartedAt: card.video.submittedAt ? Date.parse(card.video.submittedAt) : undefined,
    videoLastCheckedAt: card.video.completedAt ? Date.parse(card.video.completedAt) : undefined,
    videoStatusDetail: card.video.status === "done" ? "真实Omni 10秒视频已生成，待逐帧验收" : card.video.error,
    videoPollFailures: card.video.pollErrors?.length || 0,
  }));
  review.localArtifacts = state.cards.map((card: any) => ({
    segmentNumber: card.sourceSegmentNumber,
    image: card.image.localOriginalPath,
    video: card.video.localOriginalPath,
  }));
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

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
    assert.ok(response?.ok(), `review page failed (${response?.status()})`);
    await page.locator(".sbw-shot-card").first().waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(".sbw-shot-card").count(), 2);
    await page.waitForFunction((id) => {
      const history = JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]");
      return history.some((item: any) => item.id === id && item.cards?.length === 2);
    }, runId, { timeout: 20_000 });
    await page.screenshot({ path: path.join(outDir, "review-page-with-videos.png"), fullPage: true });
    state.workbenchHistory = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]"));
    await writeFile(path.join(outDir, "workbench-history.json"), `${JSON.stringify(state.workbenchHistory, null, 2)}\n`, "utf8");
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    passed: successfulVideos === 2,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    conversationId: review.conversationId,
    actualCost: state.actualCost,
    videos: state.cards.map((card: any) => ({ segment: card.sourceSegmentNumber, taskId: card.video.taskId, path: card.video.localOriginalPath })),
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
