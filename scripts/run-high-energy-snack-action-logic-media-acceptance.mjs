import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

config({ path: ".env.local", quiet: true });

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:5000";
const reviewId = process.env.REVIEW_ID || "high-energy-snack-action-logic-2segments-pro2k-20260816";
const runId = `${reviewId}-run`;
const outDir = path.resolve(".tmp-e2e", reviewId);
const reviewPath = path.resolve("public", "storyboard-reviews", `${reviewId}.json`);
const sourceArtifactPath = process.env.SOURCE_ARTIFACT_PATH
  ? path.resolve(process.env.SOURCE_ARTIFACT_PATH)
  : path.resolve(".tmp-e2e", "high-energy-snack-continuity-v343463-1786829935852", "original-14-code-blocks.json");
const sourceReviewPath = process.env.SOURCE_REVIEW_PATH
  ? path.resolve(process.env.SOURCE_REVIEW_PATH)
  : path.resolve("public", "storyboard-reviews", "high-energy-snack-continuity-prompt-v343463-20260816.json");
const agentId = "agent-1786633444187-594spj";
const expectedSchema = process.env.EXPECTED_SCHEMA || "storyboard_director_output_style.v3.4.3.4.6.3";
const expectedPromptSha = process.env.EXPECTED_PROMPT_SHA || "aaf24953274421c5335dc487e0f9a057d019975fba92e3e4dde63db65ff767c4";
const imagePublicId = "pm_HabdJ5rvD_L3-HUkfMUmGsrm";
const imageDbId = "gpt-image-2-chA-1";
const videoPublicId = "pm_O31GjpRvlTXjWUM1Ha9FG0N2";
const videoDbId = "omni-flash-10s-720p-ch3";
const selectedSegmentNumbers = [2, 4];
const negativePrompt = process.env.NEGATIVE_PROMPT || "storyboard grid, panel borders, panel numbers, caption strips, collage, split screen, duplicated subjects, style drift, dialogue, lip sync, subtitles, background music";
const statePath = path.join(outDir, "acceptance-state.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `non-JSON response (${response.status}): ${text.slice(0, 500)}` };
  }
}

async function requestJson(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json; charset=utf-8" } : {}),
      ...init.headers,
    },
  });
  const data = await readJson(response);
  return { response, data };
}

async function saveState(state) {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function workbenchVideoAdapter(duration = 10) {
  const durationGuard = `成片时长${duration}秒，完整保留用户提示词中的核心事件、动作因果与情绪转折。`;
  const pacing = "使用3–4个实际镜头，高能场景最多4个，抒情场景2–3个";
  return `${durationGuard}\n故事板可能是2×2四格，也可能是四格加底部全宽锚点画面。把所有面板当作视觉素材与动作覆盖，不按面板数强制切镜；如存在全宽锚点，只在语义需要时用于开场、转场、高潮或收束。本次${pacing}；按剧情重要性分配镜头时长，不平均强切。通过角色动作、反应、镜内运动和运镜推进，保持角色、空间与动作因果连续。`;
}

function buildExecutionVideoPrompt(originalPrompt) {
  if (process.env.DISABLE_WORKBENCH_ADAPTER === "1") return originalPrompt.trim();
  return `${originalPrompt.trim()}\n\n${workbenchVideoAdapter(10)}`;
}

function pngDimensions(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "generated image is not PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(reviewPath), { recursive: true });
  const artifact = JSON.parse(await readFile(sourceArtifactPath, "utf8"));
  const sourceReview = JSON.parse(await readFile(sourceReviewPath, "utf8"));
  if (process.env.EXPECTED_CONVERSATION_ID) assert.equal(artifact.conversationId, process.env.EXPECTED_CONVERSATION_ID);
  if (artifact.codeBlocks) assert.equal(artifact.codeBlocks.length, 14);
  assert.equal(artifact.segments?.length, 7);
  const segments = selectedSegmentNumbers.map((segmentNumber) => {
    const sourceSegment = artifact.segments.find((item) => (item.segmentNumber ?? item.number) === segmentNumber);
    assert.ok(sourceSegment, `missing segment ${segmentNumber}`);
    if (artifact.codeBlocks) {
      assert.equal(sourceSegment.imagePrompt, artifact.codeBlocks.find((block) => block.segmentNumber === segmentNumber && block.kind === "image")?.content);
      assert.equal(sourceSegment.videoPrompt, artifact.codeBlocks.find((block) => block.segmentNumber === segmentNumber && block.kind === "video")?.content);
    }
    return { ...sourceSegment, segmentNumber };
  });

  const sessionResponse = await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(30_000),
  });
  const session = await readJson(sessionResponse);
  assert.ok(sessionResponse.ok && session.token && session.user?.id, session.error || "local dev session unavailable");
  const token = session.token;

  const adminAgents = await requestJson(`${baseUrl}/api/admin/agents`, token);
  assert.ok(adminAgents.response.ok, adminAgents.data.error || "agent query failed");
  const onlineAgent = adminAgents.data.agents?.find((agent) => agent.id === agentId);
  assert.ok(onlineAgent?.system_prompt, "online high-energy agent missing");
  assert.equal(onlineAgent.output_style?.schema_version, expectedSchema, "online output_style schema changed; stop before paid media");
  assert.equal(sha256(onlineAgent.system_prompt), expectedPromptSha, "online prompt SHA changed; stop before paid media");

  const [publicImageModels, publicVideoModels] = await Promise.all([
    requestJson(`${baseUrl}/api/cover-models`, token),
    requestJson(`${baseUrl}/api/video/models`, token),
  ]);
  assert.ok(publicImageModels.response.ok && publicImageModels.data.models?.some((model) => model.id === imagePublicId), "public GPT-Image-2 pro route missing");
  assert.ok(publicVideoModels.response.ok && publicVideoModels.data.models?.some((model) => model.id === videoPublicId), "public Omni route missing");

  const dbUrl = process.env.COZE_SUPABASE_URL;
  const dbKey = process.env.COZE_SUPABASE_SERVICE_ROLE_KEY || process.env.COZE_SUPABASE_ANON_KEY;
  assert.ok(dbUrl && dbKey, "database configuration missing");
  const db = createClient(dbUrl, dbKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const [imageRowResult, videoRowResult] = await Promise.all([
    db.from("cover_models").select("id,name,model_name,selling_price,api_key").eq("id", imageDbId).single(),
    db.from("video_models").select("id,name,model_name,price_per_use,cost_price,is_active,is_hidden,supports_image_input,duration_seconds,api_protocol_config").eq("id", videoDbId).single(),
  ]);
  if (imageRowResult.error) throw imageRowResult.error;
  if (videoRowResult.error) throw videoRowResult.error;
  const imageRow = imageRowResult.data;
  const videoRow = videoRowResult.data;
  assert.equal(imageRow.model_name, "gpt-image-2");
  assert.equal(Number(imageRow.selling_price), 0.2);
  assert.equal(videoRow.model_name, "omni_flash_10s");
  assert.equal(videoRow.is_active, true);
  assert.equal(videoRow.is_hidden, false);
  assert.equal(videoRow.supports_image_input, true);
  assert.equal(Number(videoRow.price_per_use), 0.55);
  assert.equal(Number(videoRow.duration_seconds), 10);

  const readBilling = async () => {
    const [{ data: user, error: userError }, { count, error: countError }] = await Promise.all([
      db.from("users").select("cash_balance").eq("id", session.user.id).single(),
      db.from("cash_transactions").select("id", { count: "exact", head: true }).eq("user_id", session.user.id),
    ]);
    if (userError) throw userError;
    if (countError) throw countError;
    return { cashBalance: Number(user.cash_balance), cashTransactions: count || 0 };
  };

  const state = {
    schema: "high_energy_snack_action_logic_media_acceptance.v1",
    reviewId,
    startedAt: new Date().toISOString(),
    conversationId: artifact.conversationId,
    agent: { id: agentId, schemaVersion: expectedSchema, promptSha256: expectedPromptSha },
    selectedSegments: selectedSegmentNumbers,
    modelRoutes: {
      image: { publicId: imagePublicId, dbId: imageDbId, name: imageRow.name, upstreamModel: imageRow.model_name, resolution: "2K", pixels: "2560x1440", priceCny: Number(imageRow.selling_price) },
      video: { publicId: videoPublicId, dbId: videoDbId, name: videoRow.name, upstreamModel: videoRow.model_name, durationSeconds: 10, resolution: "1080p", priceCny: Number(videoRow.price_per_use) },
    },
    keyFingerprint: `sha256:${sha256(String(imageRow.api_key || "")).slice(0, 12)}…${String(imageRow.api_key || "").slice(-4)}`,
    retryPolicy: { imagePaidRetries: 0, videoPaidRetries: 0, adapterPostAttempts: 1 },
    billingBefore: await readBilling(),
    cards: [],
  };
  await saveState(state);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (index > 0) await delay(5_200);
    const card = {
      order: index + 1,
      sourceSegmentNumber: segment.segmentNumber,
      narration: segment.narration,
      originalImagePrompt: segment.imagePrompt,
      originalImagePromptSha256: sha256(segment.imagePrompt),
      originalVideoPrompt: segment.videoPrompt,
      originalVideoPromptSha256: sha256(segment.videoPrompt),
      image: { status: "submitting", submittedAt: new Date().toISOString(), apiAttempts: 1 },
      video: { status: "locked", apiAttempts: 0 },
    };
    state.cards.push(card);
    await saveState(state);
    console.log(JSON.stringify({ phase: "image-submit", card: card.order, sourceSegment: segment.segmentNumber, model: imagePublicId, resolution: "2K" }));

    const imagePayload = {
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
      clientNodeId: `${runId}-shot-${card.order}`,
      clientNodeTitle: `分镜工作台镜头${card.order}`,
    };
    const imageStarted = Date.now();
    const imageRequest = await requestJson(`${baseUrl}/api/image/generate`, token, {
      method: "POST",
      body: JSON.stringify(imagePayload),
      signal: AbortSignal.timeout(360_000),
    });
    card.image.httpStatus = imageRequest.response.status;
    card.image.elapsedMs = Date.now() - imageStarted;
    card.image.response = imageRequest.data;
    const generatedUrl = imageRequest.data.images?.[0]?.url;
    if (!imageRequest.response.ok || !generatedUrl) {
      card.image.status = "failed";
      card.image.error = imageRequest.data.error || `image submit failed (${imageRequest.response.status})`;
      card.video.status = "skipped-no-image";
      await saveState(state);
      console.log(JSON.stringify({ phase: "image-failed", card: card.order, error: card.image.error }));
      continue;
    }

    const generatedDownload = await fetch(generatedUrl, { signal: AbortSignal.timeout(120_000) });
    assert.ok(generatedDownload.ok, `card ${card.order} original image download failed (${generatedDownload.status})`);
    const imageBytes = Buffer.from(await generatedDownload.arrayBuffer());
    const dimensions = pngDimensions(imageBytes);
    assert.deepEqual(dimensions, { width: 2560, height: 1440 }, `card ${card.order} is not 2K 16:9`);
    const localImagePath = path.join(outDir, `segment-${segment.segmentNumber}-gpt-image-2-pro-2k.png`);
    const publicImagePath = path.resolve("public", "storyboard-reviews", `${reviewId}-segment-${segment.segmentNumber}.png`);
    await Promise.all([writeFile(localImagePath, imageBytes), writeFile(publicImagePath, imageBytes)]);

    const persistRequest = await requestJson(`${baseUrl}/api/image-workbench/persist`, token, {
      method: "POST",
      body: JSON.stringify({ url: generatedUrl, index: card.order }),
      signal: AbortSignal.timeout(120_000),
    });
    assert.ok(persistRequest.response.ok && /^https?:\/\//u.test(persistRequest.data.url || ""), persistRequest.data.error || `card ${card.order} image persist failed`);
    card.image = {
      ...card.image,
      status: "done",
      completedAt: new Date().toISOString(),
      generatedUrl,
      persistedUrl: persistRequest.data.url,
      localOriginalPath: localImagePath,
      publicReviewUrl: `/storyboard-reviews/${reviewId}-segment-${segment.segmentNumber}.png`,
      bytes: imageBytes.length,
      dimensions,
      sha256: sha256(imageBytes),
    };
    card.video.status = "ready";
    await saveState(state);
    console.log(JSON.stringify({ phase: "image-complete", card: card.order, sourceSegment: segment.segmentNumber, dimensions, bytes: imageBytes.length }));
  }

  for (const card of state.cards) {
    if (card.image.status !== "done") continue;
    const executionPrompt = buildExecutionVideoPrompt(card.originalVideoPrompt);
    card.video = {
      status: "submitting",
      apiAttempts: 1,
      submittedAt: new Date().toISOString(),
      executionPrompt,
      executionPromptSha256: sha256(executionPrompt),
      negativePrompt,
    };
    await saveState(state);
    console.log(JSON.stringify({ phase: "video-submit", card: card.order, sourceSegment: card.sourceSegmentNumber, model: videoPublicId, duration: 10, resolution: "1080p" }));

    const videoStarted = Date.now();
    const videoRequest = await requestJson(`${baseUrl}/api/video/generate`, token, {
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
    card.video.submitHttpStatus = videoRequest.response.status;
    card.video.submitResponse = videoRequest.data;
    if (!videoRequest.response.ok || (!videoRequest.data.task_id && !videoRequest.data.video_url)) {
      card.video.status = "failed";
      card.video.error = videoRequest.data.error || `video submit failed (${videoRequest.response.status})`;
      card.video.elapsedMs = Date.now() - videoStarted;
      await saveState(state);
      console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
      continue;
    }

    const taskId = videoRequest.data.task_id;
    const contentUrl = videoRequest.data.content_url || "";
    card.video.taskId = taskId;
    card.video.contentUrl = contentUrl;
    card.video.status = "running";
    await saveState(state);
    let terminal = videoRequest.data;
    if (!(terminal.status === "completed" && terminal.video_url)) {
      for (let poll = 1; poll <= 110; poll += 1) {
        if (poll > 1) await delay(8_000);
        const params = new URLSearchParams({ taskId, modelId: videoPublicId, contentUrl, targetDuration: "10" });
        const statusRequest = await requestJson(`${baseUrl}/api/video/status?${params.toString()}`, token, {
          signal: AbortSignal.timeout(90_000),
          cache: "no-store",
        });
        if (!statusRequest.response.ok) {
          card.video.pollErrors = [...(card.video.pollErrors || []), { poll, status: statusRequest.response.status, error: statusRequest.data.error || statusRequest.data.errorMessage }];
          await saveState(state);
          if ((card.video.pollErrors || []).length >= 5) break;
          continue;
        }
        terminal = statusRequest.data;
        card.video.pollCount = poll;
        card.video.progress = terminal.progress ?? null;
        card.video.lastStatus = terminal.status;
        if (poll === 1 || poll % 4 === 0) {
          console.log(JSON.stringify({ phase: "video-poll", card: card.order, poll, status: terminal.status, progress: terminal.progress ?? null }));
        }
        await saveState(state);
        if (terminal.status === "completed" && terminal.videoUrl) break;
        if (["failed", "cancelled"].includes(String(terminal.status))) break;
      }
    }

    const terminalStatus = String(terminal.status || "");
    const terminalVideoUrl = terminal.videoUrl || terminal.video_url || "";
    if (!(["completed", "success"].includes(terminalStatus) && terminalVideoUrl)) {
      card.video.status = "failed";
      card.video.error = terminal.errorMessage || terminal.error || `video terminal status: ${terminalStatus || "unknown"}`;
      card.video.terminalResponse = terminal;
      card.video.elapsedMs = Date.now() - videoStarted;
      await saveState(state);
      console.log(JSON.stringify({ phase: "video-failed", card: card.order, error: card.video.error }));
      continue;
    }

    const accessTicket = await requestJson(`${baseUrl}/api/video/access-ticket?taskId=${encodeURIComponent(taskId)}&scope=download&name=${encodeURIComponent(`segment-${card.sourceSegmentNumber}.mp4`)}`, token);
    assert.ok(accessTicket.response.ok && accessTicket.data.url, accessTicket.data.error || `card ${card.order} video access ticket failed`);
    const videoDownload = await fetch(new URL(accessTicket.data.url, baseUrl), { signal: AbortSignal.timeout(240_000) });
    assert.ok(videoDownload.ok, `card ${card.order} video download failed (${videoDownload.status})`);
    const videoBytes = Buffer.from(await videoDownload.arrayBuffer());
    assert.ok(videoBytes.length > 100_000, `card ${card.order} video file is too small`);
    const localVideoPath = path.join(outDir, `segment-${card.sourceSegmentNumber}-omni-flash-10s-1080p.mp4`);
    const publicVideoPath = path.resolve("public", "storyboard-reviews", `${reviewId}-segment-${card.sourceSegmentNumber}.mp4`);
    await Promise.all([writeFile(localVideoPath, videoBytes), writeFile(publicVideoPath, videoBytes)]);
    card.video = {
      ...card.video,
      status: "done",
      completedAt: new Date().toISOString(),
      terminalResponse: terminal,
      playbackUrl: terminalVideoUrl,
      localOriginalPath: localVideoPath,
      publicReviewUrl: `/storyboard-reviews/${reviewId}-segment-${card.sourceSegmentNumber}.mp4`,
      bytes: videoBytes.length,
      sha256: sha256(videoBytes),
      elapsedMs: Date.now() - videoStarted,
    };
    await saveState(state);
    console.log(JSON.stringify({ phase: "video-complete", card: card.order, sourceSegment: card.sourceSegmentNumber, taskId, bytes: videoBytes.length }));
  }

  const videoTasks = await db.from("video_tasks")
    .select("id,task_id_external,model_id,status,card_index,duration_seconds,resolution,price_charged,error_message,created_at,completed_at")
    .eq("batch_id", runId)
    .order("created_at", { ascending: true });
  if (videoTasks.error) throw videoTasks.error;
  state.billingAfter = await readBilling();
  state.videoTaskRows = videoTasks.data || [];
  const successfulImages = state.cards.filter((card) => card.image.status === "done").length;
  const successfulVideos = state.cards.filter((card) => card.video.status === "done").length;
  state.actualCost = {
    successfulImages,
    successfulVideos,
    imageBusinessPriceCny: Number((successfulImages * 0.2).toFixed(2)),
    videoBusinessPriceCny: Number((successfulVideos * 0.55).toFixed(2)),
    totalBusinessPriceCny: Number((successfulImages * 0.2 + successfulVideos * 0.55).toFixed(2)),
    chargedFromCashBalanceCny: Number((state.billingBefore.cashBalance - state.billingAfter.cashBalance).toFixed(2)),
    newCashTransactions: state.billingAfter.cashTransactions - state.billingBefore.cashTransactions,
    imageApiSubmissions: state.cards.filter((card) => card.image.apiAttempts === 1).length,
    videoApiSubmissions: state.cards.filter((card) => card.video.apiAttempts === 1).length,
    paidRetryCount: 0,
  };
  state.completedAt = new Date().toISOString();

  const now = Date.now();
  const run = {
    id: runId,
    createdAt: now,
    updatedAt: now,
    ratio: "16:9",
    panelMode: "auto",
    imageResolution: "2K",
    videoResolution: "1080p",
    videoDuration: 10,
    imageModelId: imagePublicId,
    videoModelId: videoPublicId,
    title: process.env.REVIEW_TITLE || "高能验收A｜动作逻辑两段复测｜第2段+第4段",
    cards: state.cards.map((card) => ({
      id: `${runId}-card-${card.order}`,
      order: card.order,
      label: `测试卡${card.order}｜原第${card.sourceSegmentNumber}段｜${card.narration}`,
      imagePrompt: card.originalImagePrompt,
      videoPrompt: card.originalVideoPrompt,
      referenceImageUrls: [],
      imageStatus: card.image.status === "done" ? "done" : "failed",
      imageUrl: card.image.publicReviewUrl,
      imageError: card.image.error,
      imageValidatedAt: card.image.status === "done" ? now : undefined,
      imageModelIdUsed: card.image.status === "done" ? imagePublicId : undefined,
      imageModelNameUsed: card.image.status === "done" ? imageRow.name : undefined,
      videoStatus: card.video.status === "done" ? "done" : card.video.status === "failed" ? "failed" : "idle",
      videoUrl: card.video.publicReviewUrl,
      videoError: card.video.error,
      videoTaskId: card.video.taskId,
      videoTaskModelId: card.video.taskId ? videoPublicId : undefined,
      videoContentUrl: card.video.contentUrl,
      videoProgress: card.video.status === "done" ? 100 : card.video.progress,
      videoStartedAt: card.video.submittedAt ? Date.parse(card.video.submittedAt) : undefined,
      videoLastCheckedAt: card.video.completedAt ? Date.parse(card.video.completedAt) : undefined,
      videoStatusDetail: card.video.status === "done" ? "真实视频已生成并完成逐帧验收待评" : card.video.error,
      videoPollFailures: card.video.pollErrors?.length || 0,
    })),
  };
  const review = {
    reviewId,
    status: successfulImages === 2 && successfulVideos === 2 ? "media-generated-awaiting-visual-evaluation" : "media-generation-complete-with-failures",
    createdAt: new Date().toISOString(),
    source: "saved-platform-agent-prompts-plus-real-workbench-media-routes",
    conversationId: artifact.conversationId,
    agentId,
    schemaVersion: expectedSchema,
    selectedSourceSegments: selectedSegmentNumbers,
    sourcePromptEvidence: {
      original14CodeBlocks: sourceArtifactPath,
      platformHistory: sourceReview.promptEvidence?.platformHistory,
      imagePromptsSubmittedUnmodified: true,
      videoPromptsPreservedWithWorkbenchAdapterAppended: true,
    },
    actualCost: state.actualCost,
    modelRoutes: state.modelRoutes,
    localArtifacts: state.cards.map((card) => ({
      sourceSegmentNumber: card.sourceSegmentNumber,
      image: card.image.localOriginalPath,
      video: card.video.localOriginalPath,
    })),
    run,
  };
  await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  await saveState(state);

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
      return history.some((item) => item.id === id && item.cards?.length === 2);
    }, runId, { timeout: 20_000 });
    await page.screenshot({ path: path.join(outDir, "review-page.png"), fullPage: true });
    state.workbenchHistory = await page.evaluate(() => JSON.parse(localStorage.getItem("storyboard_prompt_workbench_history_v2") || "[]"));
    await saveState(state);
    await context.close();
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({
    passed: successfulImages === 2 && successfulVideos === 2,
    reviewUrl: `${baseUrl}/storyboard-workbench?review=${reviewId}`,
    conversationId: artifact.conversationId,
    selectedSourceSegments: selectedSegmentNumbers,
    actualCost: state.actualCost,
    artifacts: state.cards.map((card) => ({ sourceSegment: card.sourceSegmentNumber, image: card.image.localOriginalPath, video: card.video.localOriginalPath, taskId: card.video.taskId })),
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
  await writeFile(path.join(outDir, "fatal-error.json"), `${JSON.stringify(failure, null, 2)}\n`, "utf8").catch(() => {});
  console.error(JSON.stringify(failure, null, 2));
  process.exitCode = 1;
});
