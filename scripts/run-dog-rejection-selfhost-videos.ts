import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { buildStoryboardVideoPrompt } from "../src/lib/storyboard-single-frame-video-prompt";

const BASE_URL = "http://127.0.0.1:5000";
const MODEL_ID = "pm_tabUjazl2a7DJ2POEriC-Ogo";
const RUN_ID = "dog-rejection-signals-14shot-20260821";
const TARGET_RESOLUTION = (() => {
  const value = String(process.env.H3_STORYBOARD_RESOLUTION || "2K").trim();
  if (!(["1080p", "2K"] as const).includes(value as "1080p" | "2K")) {
    throw new Error("H3_STORYBOARD_RESOLUTION_INVALID");
  }
  return value as "1080p" | "2K";
})();
const TARGET_VIDEO_COUNT = (() => {
  const value = Number(process.env.H3_STORYBOARD_VIDEO_COUNT || 2);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2) {
    throw new Error("H3_STORYBOARD_VIDEO_COUNT_INVALID");
  }
  return value;
})();
const REVIEW_PATH = path.resolve("public/storyboard-reviews/dog-rejection-signals-14shot-20260821.json");
const EVIDENCE_PATH = path.resolve(
  `../../算力仓库/06_服务器部署/minimax-h3-server-deployment/evidence/dog-rejection-signals-20260821/selfhost-${TARGET_VIDEO_COUNT}-video-${TARGET_RESOLUTION.toLowerCase()}-run.json`,
);
const EVIDENCE_DIR = path.dirname(EVIDENCE_PATH);
const FFMPEG_PATH = path.resolve("node_modules/ffmpeg-static/ffmpeg.exe");
const CARD_INPUTS = [
  {
    order: 1,
    cardId: `${RUN_ID}-card-01`,
    fullStorageKey: "images/2026/08/21/image-workbench/2026-08-21/1787310581938-1.png",
    storageKey: "images/2026/08/21/image-workbench/2026-08-21/1787312512035-101.png",
  },
  {
    order: 2,
    cardId: `${RUN_ID}-card-02`,
    fullStorageKey: "images/2026/08/21/image-workbench/2026-08-21/1787312474146-2.png",
    storageKey: "images/2026/08/21/image-workbench/2026-08-21/1787312475883-102.png",
  },
] as const;
const NEGATIVE_PROMPT = "storyboard grid, panel borders, panel numbers, caption strips, collage, split screen, on-screen text, Chinese text, English text, letters, numbers, labels, signs, logos, watermarks, duplicated subjects, duplicated doors, style drift, photorealistic, live action, documentary footage, real person, realistic human skin, dialogue, speaking, talking mouth, lip sync, voiceover, subtitles, background music, laser, magic beam, scan ring, energy ring, hologram, plastic toy material, yellow-green color cast, clipped head, cropped hands, cropped feet, cropped dog ears, cropped dog paws, blurry, soft focus subject, noisy, grainy, low resolution, compression artifacts, humanoid dog, human hands on dog, bipedal dog";

type Card = { id: string; order: number; videoPrompt: string };
type Review = { run: { videoContract?: { modelId: string; resolution: string; duration: number; ratio: string }; cards: Card[] } };
type SubmitResponse = { task_id?: string; content_url?: string; status?: string; video_url?: string; error?: string; message?: string; error_code?: string };
type StatusResponse = SubmitResponse & {
  taskId?: string;
  videoUrl?: string;
  storageUrl?: string;
  progress?: number;
  errorMessage?: string;
  errorCode?: string;
  processingStage?: string;
  temporaryPlayback?: boolean;
};
type HistoryTask = {
  id?: string;
  taskIdExternal?: string;
  status?: string;
  videoUrl?: string;
  batchId?: string;
  cardIndex?: number;
  modelId?: string;
  resolution?: string;
  durationSeconds?: number;
  priceCharged?: number;
};

function requireAck() {
  if (!process.argv.includes("--ack-real-videos")) {
    throw new Error("REAL_VIDEO_ACK_REQUIRED");
  }
}

function taskHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function clientRequestId(input: { card: Card; prompt: string; storageKey: string }) {
  const digest = createHash("sha256").update(JSON.stringify({
    runId: RUN_ID,
    cardId: input.card.id,
    cardOrder: input.card.order,
    modelId: MODEL_ID,
    prompt: input.prompt,
    duration: 10,
    aspectRatio: "16:9",
    resolution: TARGET_RESOLUTION,
    sourceStorageKey: input.storageKey,
  })).digest("hex");
  return `sbw-video-${digest}`;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<{ response: Response; data: T }> {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({})) as T;
  return { response, data };
}

async function localAdminToken() {
  const { response, data } = await jsonFetch<{ token?: string; error?: string }>(`${BASE_URL}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
  });
  if (!response.ok || !data.token) throw new Error(data.error || "LOCAL_ADMIN_SESSION_UNAVAILABLE");
  return data.token;
}

async function assertModelContract() {
  const { response, data } = await jsonFetch<{ models?: Array<Record<string, unknown>> }>(
    `${BASE_URL}/api/video/models?surface=storyboard-workbench`,
  );
  const model = (data.models || []).find((item) => item.id === MODEL_ID);
  const capabilities = model?.capabilities as Record<string, unknown> | undefined;
  if (!response.ok || !model || capabilities?.available !== true) throw new Error("SELFHOST_MODEL_UNAVAILABLE");
  const durations = Array.isArray(capabilities.nativeDurations) ? capabilities.nativeDurations.map(Number) : [];
  const resolutions = Array.isArray(capabilities.resolutionOptions) ? capabilities.resolutionOptions.map(String) : [];
  const ratios = Array.isArray(capabilities.aspectRatios) ? capabilities.aspectRatios.map(String) : [];
  if (!durations.includes(10) || !resolutions.includes(TARGET_RESOLUTION) || !ratios.includes("16:9")) {
    throw new Error("SELFHOST_MODEL_CONTRACT_MISMATCH");
  }
}

async function dispatchPathStatus() {
  try {
    const response = await fetch("http://127.0.0.1:16011/health/ready", {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const data = await response.json().catch(() => ({})) as { status?: string };
    if (response.ok && data.status === "ready") {
      return { ready: true, mode: "gateway_ready" as const };
    }
  } catch {
    // An offline loopback gateway is expected while lifecycle wake-up is armed.
  }
  const envPath = path.resolve(".env.local");
  const envText = await fs.readFile(envPath, "utf8").catch(() => "");
  const enabled = /^AUTODL_H3_LIFECYCLE_ENABLED\s*=\s*true\s*$/mi.test(envText);
  const atomic = /^AUTODL_H3_ATOMIC_FINALIZER_ENABLED\s*=\s*true\s*$/mi.test(envText);
  const instanceUuid = /^AUTODL_H3_INSTANCE_UUID\s*=\s*pro-[A-Za-z0-9_-]+\s*$/mi.test(envText);
  const developerTokenPath = path.join(process.env.USERPROFILE || "", ".codex", "secrets", "autodl-developer.token");
  const developerTokenPresent = await fs.stat(developerTokenPath).then((item) => item.size > 0).catch(() => false);
  const lifecycleReady = enabled && atomic && instanceUuid && developerTokenPresent;
  return {
    ready: lifecycleReady,
    mode: lifecycleReady ? "lifecycle_ready" as const : "not_ready" as const,
    lifecycle: { enabled, atomic, instanceUuid, developerTokenPresent },
  };
}

async function resignOwnedImage(token: string, storageKey: string) {
  const { response, data } = await jsonFetch<{ url?: string; key?: string; error?: string }>(
    `${BASE_URL}/api/image-workbench/persist`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ storageKey }),
    },
  );
  if (!response.ok || !data.url || data.key !== storageKey) throw new Error(data.error || "INPUT_ASSET_RESIGN_FAILED");
  const parsed = new URL(data.url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".myqcloud.com")) {
    throw new Error("INPUT_ASSET_URL_INVALID");
  }
  return data.url;
}

async function validatePreparedAssets(input: { token: string; fullStorageKey: string; panelStorageKey: string }) {
  const [fullUrl, panelUrl] = await Promise.all([
    resignOwnedImage(input.token, input.fullStorageKey),
    resignOwnedImage(input.token, input.panelStorageKey),
  ]);
  const [fullResponse, panelResponse] = await Promise.all([
    fetch(fullUrl, { signal: AbortSignal.timeout(60_000) }),
    fetch(panelUrl, { signal: AbortSignal.timeout(60_000) }),
  ]);
  if (!fullResponse.ok || !panelResponse.ok) throw new Error("INPUT_ASSET_FETCH_FAILED");
  const [fullBytes, panelBytes] = await Promise.all([
    fullResponse.arrayBuffer().then((value) => Buffer.from(value)),
    panelResponse.arrayBuffer().then((value) => Buffer.from(value)),
  ]);
  const [fullMeta, panelMeta] = await Promise.all([sharp(fullBytes).metadata(), sharp(panelBytes).metadata()]);
  if (fullMeta.width !== 2560 || fullMeta.height !== 1440 || panelMeta.width !== 1280 || panelMeta.height !== 720) {
    throw new Error("INPUT_ASSET_DIMENSION_MISMATCH");
  }
  const [expectedPanelPixels, actualPanelPixels] = await Promise.all([
    sharp(fullBytes).extract({ left: 0, top: 0, width: 1280, height: 720 }).raw().toBuffer(),
    sharp(panelBytes).raw().toBuffer(),
  ]);
  const expectedHash = createHash("sha256").update(expectedPanelPixels).digest("hex");
  const actualHash = createHash("sha256").update(actualPanelPixels).digest("hex");
  if (expectedHash !== actualHash) throw new Error("INPUT_ASSET_FIRST_PANEL_MISMATCH");
  return {
    fullStorageKey: input.fullStorageKey,
    fullDimensions: "2560x1440",
    fullBytes: fullBytes.byteLength,
    panelStorageKey: input.panelStorageKey,
    panelDimensions: "1280x720",
    panelBytes: panelBytes.byteLength,
    exactFirstPanelPixels: true,
    panelPixelSha256: actualHash,
  };
}

async function submitOne(input: { token: string; card: Card; storageKey: string }) {
  const imageUrl = await resignOwnedImage(input.token, input.storageKey);
  const prompt = buildStoryboardVideoPrompt({ prompt: input.card.videoPrompt, duration: 10 });
  const stableRequestId = clientRequestId({ card: input.card, prompt, storageKey: input.storageKey });
  const { response, data } = await jsonFetch<SubmitResponse>(`${BASE_URL}/api/video/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({
      model_id: MODEL_ID,
      prompt,
      image_url: imageUrl,
      duration: 10,
      aspect_ratio: "16:9",
      resolution_tier: TARGET_RESOLUTION,
      negative_prompt: NEGATIVE_PROMPT,
      task_label: `分镜工作台镜头${input.card.order}`,
      batch_id: RUN_ID,
      batch_topic: "storyboard-workbench",
      card_index: input.card.order,
      surface: "storyboard-workbench",
      client_request_id: stableRequestId,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !data.task_id) throw new Error(data.error || data.message || `VIDEO_SUBMIT_${response.status}`);
  return { taskId: data.task_id, contentUrl: data.content_url || "", immediate: data, stableRequestId };
}

async function pollUntilTerminal(input: { token: string; taskId: string; contentUrl: string; order: number }) {
  for (let attempt = 0; attempt < 360; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
    const params = new URLSearchParams({
      taskId: input.taskId,
      modelId: MODEL_ID,
      contentUrl: input.contentUrl,
      targetDuration: "10",
      batchId: RUN_ID,
      batchTopic: "storyboard-workbench",
      cardIndex: String(input.order),
    });
    const { response, data } = await jsonFetch<StatusResponse>(`${BASE_URL}/api/video/status?${params}`, {
      headers: { Authorization: `Bearer ${input.token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(data.error || data.errorMessage || `VIDEO_STATUS_${response.status}`);
    const status = String(data.status || "").toLowerCase();
    if (["completed", "success", "succeeded"].includes(status)) {
      const playbackUrl = String(data.videoUrl || data.video_url || "");
      if (!playbackUrl || data.temporaryPlayback === true || data.processingStage === "finalizing") {
        continue;
      }
      return { status: "completed", hasStableAccess: true, playbackUrl };
    }
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(data.error || data.errorMessage || `VIDEO_${status.toUpperCase()}`);
    }
  }
  throw new Error("VIDEO_TERMINAL_TIMEOUT_30_MINUTES");
}

async function readTargetHistory(token: string) {
  const { response, data } = await jsonFetch<{ tasks?: HistoryTask[]; error?: string }>(
    `${BASE_URL}/api/video/history?limit=200`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!response.ok) throw new Error(data.error || "VIDEO_HISTORY_UNAVAILABLE");
  return (data.tasks || []).filter((task) =>
    task.batchId === RUN_ID
    && CARD_INPUTS.slice(0, TARGET_VIDEO_COUNT).some((card) => card.order === Number(task.cardIndex))
    && task.modelId === "minimax-h3-turbo-selfhost-pro6000"
  );
}

async function validateStableVideo(input: { token: string; playbackUrl: string; order: number }) {
  const url = new URL(input.playbackUrl, BASE_URL).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${input.token}` },
    redirect: "follow",
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`VIDEO_PLAYBACK_${response.status}`);
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.includes("video/mp4") && !contentType.includes("application/octet-stream")) {
    throw new Error("VIDEO_PLAYBACK_CONTENT_TYPE_INVALID");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 100_000 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new Error("VIDEO_PLAYBACK_FILE_INVALID");
  }
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const videoPath = path.join(
    EVIDENCE_DIR,
    `selfhost-card-${String(input.order).padStart(2, "0")}-10s-${TARGET_RESOLUTION.toLowerCase()}.mp4`,
  );
  await fs.writeFile(videoPath, bytes);

  const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";
  const probe = spawnSync(
    FFMPEG_PATH,
    ["-hide_banner", "-i", videoPath, "-map", "0:v:0", "-frames:v", "1", "-f", "null", nullSink],
    { encoding: "utf8", timeout: 120_000 },
  );
  const diagnostic = `${probe.stdout || ""}\n${probe.stderr || ""}`;
  const videoLine = diagnostic.split(/\r?\n/u).find((line) => line.includes("Video:")) || "";
  const audioLine = diagnostic.split(/\r?\n/u).find((line) => line.includes("Audio:")) || "";
  const durationMatch = diagnostic.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/u);
  const dimensions = videoLine.match(/(?:^|\s)(\d{3,5})x(\d{3,5})(?:[\s,]|$)/u);
  const durationSeconds = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  const width = Number(dimensions?.[1] || 0);
  const height = Number(dimensions?.[2] || 0);
  const expectedDimensions = TARGET_RESOLUTION === "1080p"
    ? { width: 1920, height: 1080 }
    : { width: 2560, height: 1440 };
  if (probe.status !== 0 || !videoLine.toLowerCase().includes("h264")
    || width !== expectedDimensions.width || height !== expectedDimensions.height) {
    throw new Error("VIDEO_RESOLUTION_OR_H264_PROBE_FAILED");
  }
  if (!audioLine.toLowerCase().includes("aac") || durationSeconds < 9.5 || durationSeconds > 10.8) {
    throw new Error("VIDEO_DURATION_OR_AUDIO_PROBE_FAILED");
  }
  return {
    path: videoPath,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    codec: "h264",
    audioCodec: "aac",
    width,
    height,
    durationSeconds,
    stablePlayback: true,
  };
}

async function writeEvidence(value: unknown) {
  await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
  const tempPath = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, EVIDENCE_PATH);
}

async function main() {
  const prepareOnly = process.argv.includes("--prepare-only");
  if (!prepareOnly) requireAck();
  const review = JSON.parse(await fs.readFile(REVIEW_PATH, "utf8")) as Review;
  const contract = review.run.videoContract;
  if (!contract || contract.modelId !== MODEL_ID || contract.duration !== 10 || contract.ratio !== "16:9") {
    throw new Error("REVIEW_VIDEO_CONTRACT_MISMATCH");
  }
  await assertModelContract();
  const token = await localAdminToken();
  const dispatch = await dispatchPathStatus();
  const history = await readTargetHistory(token);
  const preparedTasks = [] as Array<Record<string, unknown>>;
  const targetCards = CARD_INPUTS.slice(0, TARGET_VIDEO_COUNT);
  for (const prepared of targetCards) {
    const card = review.run.cards.find((item) => item.id === prepared.cardId && item.order === prepared.order);
    if (!card?.videoPrompt) throw new Error(`CARD_${prepared.order}_PROMPT_MISSING`);
    const sourceAsset = await validatePreparedAssets({
      token,
      fullStorageKey: prepared.fullStorageKey,
      panelStorageKey: prepared.storageKey,
    });
    const prompt = buildStoryboardVideoPrompt({ prompt: card.videoPrompt, duration: 10 });
    preparedTasks.push({
      cardIndex: prepared.order,
      cardId: prepared.cardId,
      sourceStorageKey: prepared.storageKey,
      sourceAssetOwned: true,
      sourceAsset,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      clientRequestId: clientRequestId({ card, prompt, storageKey: prepared.storageKey }),
      result: "prepared",
    });
  }
  const evidence: Record<string, unknown> = {
    schema: "autodl_h3_storyboard_video_run.v2",
    runId: RUN_ID,
    contract: { modelId: MODEL_ID, aspectRatio: "16:9", durationSeconds: 10, resolutionTier: TARGET_RESOLUTION },
    policy: { sequential: true, postRetries: 0, secondRequiresFirstSuccess: true },
    startedAt: new Date().toISOString(),
    dispatch,
    priorTargetHistory: history.map((task) => ({
      cardIndex: task.cardIndex,
      status: task.status,
      taskIdExternal: task.taskIdExternal,
      priceCharged: task.priceCharged,
    })),
    tasks: preparedTasks,
  };
  await writeEvidence(evidence);
  if (prepareOnly) {
    evidence.status = dispatch.ready ? "prepared_ready" : "prepared_waiting_runtime";
    evidence.preparedAt = new Date().toISOString();
    await writeEvidence(evidence);
    console.log(`Self-host H3 ${TARGET_VIDEO_COUNT}-video run prepared: dispatch=${dispatch.mode}; generation POSTs=0.`);
    return;
  }
  if (!dispatch.ready) throw new Error("SELFHOST_DISPATCH_PATH_NOT_READY");
  try {
    for (let index = 0; index < targetCards.length; index += 1) {
      const prepared = targetCards[index];
      const card = review.run.cards.find((item) => item.id === prepared.cardId && item.order === prepared.order);
      if (!card?.videoPrompt) throw new Error(`CARD_${prepared.order}_PROMPT_MISSING`);
      const taskRecord = preparedTasks[index];
      const existing = history.find((task) => Number(task.cardIndex) === prepared.order
        && ["pending", "queued", "processing", "generating", "completed"].includes(String(task.status || ""))
        && Boolean(task.taskIdExternal));
      let taskId = String(existing?.taskIdExternal || "");
      let contentUrl = "";
      const existingPlayback = String(existing?.videoUrl || "");
      if (taskId) {
        taskRecord.resumedExistingTask = true;
        taskRecord.taskId = taskId;
        taskRecord.taskHash = taskHash(taskId);
        taskRecord.postCount = 0;
      } else {
        const submitted = await submitOne({ token, card, storageKey: prepared.storageKey });
        taskId = submitted.taskId;
        contentUrl = submitted.contentUrl;
        taskRecord.submittedAt = new Date().toISOString();
        taskRecord.taskId = taskId;
        taskRecord.taskHash = taskHash(taskId);
        taskRecord.postCount = 1;
        taskRecord.clientRequestId = submitted.stableRequestId;
      }
      taskRecord.result = "processing";
      await writeEvidence(evidence);
      const terminal = existingPlayback
        ? { status: "completed", hasStableAccess: true, playbackUrl: existingPlayback }
        : await pollUntilTerminal({ token, taskId, contentUrl, order: prepared.order });
      const media = await validateStableVideo({ token, playbackUrl: terminal.playbackUrl, order: prepared.order });
      taskRecord.result = terminal.status;
      taskRecord.hasStableAccess = terminal.hasStableAccess;
      taskRecord.media = media;
      taskRecord.completedAt = new Date().toISOString();
      await writeEvidence(evidence);
    }
    evidence.completedAt = new Date().toISOString();
    evidence.status = "completed";
    await writeEvidence(evidence);
    console.log(`Self-host H3 video run completed: ${TARGET_VIDEO_COUNT}/${TARGET_VIDEO_COUNT} (sequential, zero POST retries).`);
  } catch (error) {
    evidence.status = "stopped";
    evidence.stoppedAt = new Date().toISOString();
    evidence.errorCode = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    await writeEvidence(evidence);
    throw error;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
