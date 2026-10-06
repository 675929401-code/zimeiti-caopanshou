import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

const ACK = "--ack-real-generation";
const baseUrl = String(process.env.H3_VALIDATION_BASE_URL || "http://127.0.0.1:5000").replace(/\/$/u, "");
const outputRoot = process.env.H3_VALIDATION_OUTPUT_DIR
  || path.join(process.cwd(), ".codex-evidence", "autodl-h3");
const runId = String(process.env.H3_VALIDATION_RUN_ID || randomUUID()).replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 64);
const deadlineMs = 20 * 60 * 1000;

type ValidationResolutionTier = "480p" | "1080p" | "2K";
const resolutionAliases: Record<string, ValidationResolutionTier> = {
  "480p": "480p",
  "480p原生": "480p",
  "1080p": "1080p",
  "1080p增强": "1080p",
  "2k": "2K",
  "2k增强": "2K",
};
const requestedResolutionText = String(process.env.H3_VALIDATION_RESOLUTION || "highest")
  .trim()
  .replace(/\s+/gu, "")
  .toLowerCase();
const requestedResolution: ValidationResolutionTier | "highest" | undefined = requestedResolutionText === "highest"
  ? "highest"
  : resolutionAliases[requestedResolutionText];
const resolutionSpecs: Record<ValidationResolutionTier, { label: string; width: number; height: number }> = {
  "480p": { label: "480p 原生", width: 864, height: 480 },
  "1080p": { label: "1080p增强", width: 1920, height: 1080 },
  "2K": { label: "2K增强", width: 2560, height: 1440 },
};

type PublicModel = {
  id: string;
  displayName: string;
  capabilities?: Record<string, unknown>;
};

type SseTerminal = {
  event: "completed" | "failed" | "cancelled" | "error";
  data: Record<string, unknown>;
};

function safeMessage(error: unknown) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/secret:\/\/[^\s"']+/giu, "secret://[redacted]")
    .replace(/https?:\/\/[^\s"']+/giu, (value) => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}?query=redacted`;
      } catch {
        return "url:redacted";
      }
    })
    .slice(0, 500);
}

function assertLocalBase() {
  const parsed = new URL(baseUrl);
  assert.equal(parsed.protocol, "http:", "真实验收只允许本地 HTTP V2.6");
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname), "真实验收只允许本地 V2.6");
  assert.equal(parsed.port, "5000", "真实验收只允许本地 5000 端口");
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    throw new Error(`接口返回非 JSON (${response.status})`);
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === "object"
      ? String((parsed as { error?: unknown }).error || `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parsed as T;
}

async function getModels(route: string) {
  const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(20_000) });
  const payload = await json<{ models?: PublicModel[] }>(response);
  return Array.isArray(payload.models) ? payload.models : [];
}

function findOnly(models: PublicModel[], label: string) {
  const matches = models.filter((model) => model.displayName.includes(label));
  assert.equal(matches.length, 1, `必须且只能找到一个模型：${label}`);
  assert.match(matches[0].id, /^pm_[A-Za-z0-9_-]+$/u, `${label} 必须使用公共 opaque ID`);
  return matches[0];
}

function assertStablePublicUrl(raw: string, label: string) {
  const url = new URL(raw);
  assert.equal(url.protocol, "https:", `${label} 必须使用 HTTPS 稳定对象地址`);
  assert.ok(!["127.0.0.1", "localhost"].includes(url.hostname), `${label} 不得暴露回环地址`);
  assert.ok(!url.searchParams.has("sig"), `${label} 不得暴露 H3 网关 sig`);
}

function pngDimensions(bytes: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(bytes.subarray(0, 8).equals(signature), "H3 生图验收当前要求 PNG 输出");
  assert.ok(bytes.length >= 24, "PNG 文件不完整");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function resolveFfprobeCommand() {
  const explicit = String(process.env.H3_VALIDATION_FFPROBE_PATH || "").trim();
  if (explicit) return explicit;
  if (ffmpegPath) {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
    if (existsSync(sibling)) return sibling;
  }
  return process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
}

function assertFfprobeAvailable() {
  const command = resolveFfprobeCommand();
  const version = spawnSync(command, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
  assert.equal(version.status, 0, "ffprobe 不可用；请通过 H3_VALIDATION_FFPROBE_PATH 指定可执行文件");
  return command;
}

async function waitForTerminalSse(url: string, token: string): Promise<SseTerminal> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    assert.ok(response.ok && response.body, `SSE 建连失败 (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        let event = "";
        let data: Record<string, unknown> = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          if (line.startsWith("data: ")) data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        }
        if (["completed", "failed", "cancelled", "error"].includes(event)) {
          return { event: event as SseTerminal["event"], data };
        }
      }
      if (done) throw new Error("SSE 在终态前断开；未自动重提任务");
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  assert.ok(process.argv.includes(ACK), `拒绝真实生成：必须显式传入 ${ACK}`);
  assert.ok(requestedResolution, "H3_VALIDATION_RESOLUTION 仅支持 highest|480p|480p 原生|1080p|1080p增强|2K|2K增强");
  assertLocalBase();
  assert.ok(runId.length >= 8, "run id 太短");
  const ffprobeCommand = assertFfprobeAvailable();

  let generationPosts = 0;
  const startedAt = new Date().toISOString();
  const session = await json<{ token?: string; user?: { role?: string } }>(await fetch(`${baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    signal: AbortSignal.timeout(20_000),
  }));
  assert.ok(session.token, "本地验收会话不可用");
  assert.equal(session.user?.role, "admin", "真实验收必须使用管理员免扣费会话");
  const authHeaders = { Authorization: `Bearer ${session.token}` };

  const [imageModels, imageModelsOutside, videoModels, videoModelsOutside, storyboardModels] = await Promise.all([
    getModels("/api/cover-models?surface=image-workbench"),
    getModels("/api/cover-models"),
    getModels("/api/video/models?surface=video-page"),
    getModels("/api/video/models"),
    getModels("/api/video/models?surface=storyboard-workbench"),
  ]);
  const imageModel = findOnly(imageModels, "Qwen Image 2512 HQ · 自租 PRO6000");
  const videoModel = findOnly(videoModels, "MiniMax H3 Turbo · 自租实例");
  const advertisedResolutionOptions = Array.isArray(videoModel.capabilities?.resolutionOptions)
    ? videoModel.capabilities.resolutionOptions.map(String)
    : [];
  const validationResolution = requestedResolution === "highest"
    ? (["2K", "1080p", "480p"] as ValidationResolutionTier[])
      .find((tier) => advertisedResolutionOptions.includes(tier))
    : requestedResolution;
  assert.ok(validationResolution, "模型列表没有可验收的分辨率档");
  const resolutionSpec = resolutionSpecs[validationResolution];
  assert.ok(advertisedResolutionOptions.includes(validationResolution), `模型列表未公开 ${resolutionSpec.label}`);
  assert.deepEqual(
    imageModel.capabilities?.verifiedOutputPixelSizes,
    ["16:9=3640x2048"],
    "H3 生图模型列表未公开已实测的 3640x2048 输出尺寸",
  );
  assert.ok(!imageModelsOutside.some((model) => model.displayName.includes("自租 PRO6000")), "H3 生图模型泄露到其他入口");
  assert.ok(!videoModelsOutside.some((model) => model.displayName.includes("自租 PRO6000")), "H3 视频模型泄露到无 surface 入口");
  assert.ok(!storyboardModels.some((model) => model.displayName.includes("自租 PRO6000")), "H3 视频模型泄露到分镜工作台");

  const prompt = "清晨薄雾中的江南竹林，一位穿青色长衫的年轻人缓步向前，电影感自然光，人物稳定，画面无文字无水印";
  generationPosts += 1;
  const imageResponse = await fetch(`${baseUrl}/api/image/generate`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      mode: "local",
      modelId: imageModel.id,
      style: "",
      aspectRatio: "16:9",
      resolution: "2K",
      coverText: "",
      clientIdempotencyKey: `h3validate_${runId}`,
    }),
    signal: AbortSignal.timeout(8 * 60 * 1000),
  });
  const imagePayload = await json<{
    images?: Array<{ url?: string; width?: number; height?: number; storageKey?: string; dimensionsVerified?: boolean }>;
    resolution?: string;
    cashCharged?: number;
  }>(imageResponse);
  const generatedImageUrl = String(imagePayload.images?.[0]?.url || "");
  const generatedStorageKey = String(imagePayload.images?.[0]?.storageKey || "");
  assertStablePublicUrl(generatedImageUrl, "生图结果");
  assert.ok(generatedStorageKey, "H3 生图结果缺少已持久化存储键");
  assert.equal(imagePayload.resolution, "2K", "H3 生图未同步为2K实测档");
  assert.equal(imagePayload.images?.[0]?.dimensionsVerified, true, "H3 生图响应未标记真实像素已验证");
  assert.equal(Number(imagePayload.cashCharged || 0), 0, "管理员验收不应扣主站余额");

  const generatedImageDownload = await fetch(generatedImageUrl, {
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(generatedImageDownload.ok, `生图结果下载失败 (${generatedImageDownload.status})`);
  const generatedImageBytes = Buffer.from(await generatedImageDownload.arrayBuffer());
  const generatedDimensions = pngDimensions(generatedImageBytes);
  assert.deepEqual(generatedDimensions, { width: 3640, height: 2048 }, "生图不是已实测的 3640x2048 输出");
  assert.equal(imagePayload.images?.[0]?.width, generatedDimensions.width, "生图API宽度未使用实际PNG尺寸");
  assert.equal(imagePayload.images?.[0]?.height, generatedDimensions.height, "生图API高度未使用实际PNG尺寸");
  assert.ok(Math.abs(generatedDimensions.width / generatedDimensions.height - 16 / 9) < 0.02, "生图比例不是 16:9");

  const persistedImage = await json<{ url?: string; key?: string; size?: number }>(await fetch(`${baseUrl}/api/image-workbench/persist`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ url: generatedImageUrl, index: 1, storageKey: generatedStorageKey }),
    signal: AbortSignal.timeout(90_000),
  }));
  const imageUrl = String(persistedImage.url || "");
  assertStablePublicUrl(imageUrl, "生图工作台入库结果");
  assert.ok(persistedImage.key, "生图工作台未返回存储键");

  const videoPrompt = "0-1秒：人物在竹林薄雾中稳定站立；1-4秒：人物自然向镜头方向缓步前行，衣摆轻微摆动，镜头缓慢平移跟随；4-5秒：人物停步并平稳落幅。保持人物身份、服饰和场景一致，无字幕、无水印。";
  generationPosts += 1;
  const videoSubmit = await json<{
    task_id?: string;
    model_id?: string;
    content_url?: string;
    status?: string;
  }>(await fetch(`${baseUrl}/api/video/generate`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: videoModel.id,
      prompt: videoPrompt,
      image_url: imageUrl,
      duration: 5,
      aspect_ratio: "16:9",
      resolution: validationResolution,
      resolution_tier: validationResolution,
      task_label: `H3链路验收-${validationResolution}-${runId}`,
      card_index: 1,
      surface: "video-page",
    }),
    signal: AbortSignal.timeout(60_000),
  }));
  const taskId = String(videoSubmit.task_id || "");
  assert.match(taskId, /^h3_[a-f0-9]+$/u, "H3 视频任务 ID 无效");
  assert.ok(["pending", "queued", "processing"].includes(String(videoSubmit.status || "")), "H3 视频提交状态异常");
  assert.equal(generationPosts, 2, "验收只能提交 1 图 + 1 视频");

  const sseParams = new URLSearchParams({
    taskId,
    modelId: String(videoSubmit.model_id || videoModel.id),
    contentUrl: String(videoSubmit.content_url || ""),
    prompt: videoPrompt,
    imageUrl,
    cardIndex: "1",
    targetDuration: "5",
  });
  const terminal = await waitForTerminalSse(`${baseUrl}/api/video/stream?${sseParams.toString()}`, session.token);
  assert.equal(terminal.event, "completed", `H3 视频终态失败：${String(terminal.data.errorMessage || terminal.data.message || terminal.event)}`);
  const returnedPlayback = String(terminal.data.videoUrl || terminal.data.video_url || "");
  assert.ok(returnedPlayback.startsWith("/api/video/proxy?"), "SSE 未返回站内播放票据");
  assert.ok(!returnedPlayback.includes("sig="), "SSE 泄露了上游 H3 签名 URL");

  const access = await json<{ url?: string }>(await fetch(`${baseUrl}/api/video/access-ticket?${new URLSearchParams({
    taskId,
    scope: "playback",
  }).toString()}`, { headers: authHeaders, signal: AbortSignal.timeout(20_000) }));
  assert.ok(String(access.url || "").startsWith("/api/video/proxy?"), "播放票据地址无效");
  const playbackProbe = await fetch(`${baseUrl}${access.url}`, {
    headers: { Range: "bytes=0-4095" },
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(playbackProbe.ok || playbackProbe.status === 206, `播放代理失败 (${playbackProbe.status})`);
  const playbackChunk = Buffer.from(await playbackProbe.arrayBuffer());
  assert.ok(playbackChunk.length > 0, "播放代理返回空内容");

  const download = await json<{ url?: string }>(await fetch(`${baseUrl}/api/video/access-ticket?${new URLSearchParams({
    taskId,
    scope: "download",
    name: `minimax-h3-${runId}.mp4`,
  }).toString()}`, { headers: authHeaders, signal: AbortSignal.timeout(20_000) }));
  assert.ok(String(download.url || "").startsWith("/api/video/proxy-download?"), "下载票据地址无效");
  const videoResponse = await fetch(`${baseUrl}${download.url}`, { signal: AbortSignal.timeout(3 * 60 * 1000) });
  assert.ok(videoResponse.ok, `视频下载失败 (${videoResponse.status})`);
  const videoBytes = Buffer.from(await videoResponse.arrayBuffer());
  assert.ok(videoBytes.length > 10_000, "视频文件过小");

  const evidenceDir = path.join(outputRoot, runId);
  await mkdir(evidenceDir, { recursive: true });
  const videoPath = path.join(evidenceDir, `minimax-h3-i2v-5s-${validationResolution.toLowerCase()}.mp4`);
  await writeFile(videoPath, videoBytes);
  const ffprobe = spawnSync(ffprobeCommand, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames:format=duration",
    "-of", "json",
    videoPath,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(ffprobe.status, 0, `ffprobe 失败 (${String(ffprobe.status)}): ${safeMessage(ffprobe.stderr || ffprobe.error)}`);
  const probe = JSON.parse(String(ffprobe.stdout || "{}")) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; r_frame_rate?: string; nb_frames?: string }>;
    format?: { duration?: string };
  };
  const probedVideo = probe.streams?.[0];
  assert.ok(probedVideo, "ffprobe 未找到视频流");
  assert.equal(probedVideo.codec_name, "h264", "ffprobe 检测到的视频编码不是 H.264");
  assert.deepEqual(
    { width: Number(probedVideo.width), height: Number(probedVideo.height) },
    { width: resolutionSpec.width, height: resolutionSpec.height },
    `ffprobe 检测到的最终尺寸不是 ${resolutionSpec.width}x${resolutionSpec.height}`,
  );
  const [fpsNumerator, fpsDenominator] = String(probedVideo.r_frame_rate || "0/1").split("/").map(Number);
  assert.ok(fpsDenominator > 0 && Math.abs(fpsNumerator / fpsDenominator - 24) < 0.01, "ffprobe 检测到的帧率不是 24fps");
  assert.ok(ffmpegPath, "ffmpeg-static 不可用");
  const ffmpeg = spawnSync(ffmpegPath, ["-hide_banner", "-i", videoPath, "-map", "0:v:0", "-f", "null", "NUL"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 3 * 60 * 1000,
  });
  const mediaLog = `${ffmpeg.stdout || ""}\n${ffmpeg.stderr || ""}`;
  assert.equal(ffmpeg.status, 0, `ffmpeg 解码失败 (${String(ffmpeg.status)}): ${safeMessage(ffmpeg.error)}`);
  const escapedSize = `${resolutionSpec.width}x${resolutionSpec.height}`.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(
    mediaLog,
    new RegExp(`Video:\\s*h264[^\\n]*${escapedSize}[^\\n]*24 fps`, "iu"),
    `最终视频编码、尺寸或帧率不符合 ${resolutionSpec.width}x${resolutionSpec.height}/24fps H.264`,
  );
  assert.match(mediaLog, /Audio:\s*aac/iu, "视频缺少 AAC 音轨");
  const durationMatch = mediaLog.match(/Duration:\s*00:00:(\d+(?:\.\d+)?)/u);
  assert.ok(durationMatch, "未识别视频时长");
  const durationSeconds = Number(durationMatch[1]);
  assert.ok(Math.abs(durationSeconds - 5.167) <= 0.14, `最终视频时长不是约5.167秒: ${durationSeconds}`);
  const frameMatches = [...mediaLog.matchAll(/frame=\s*(\d+)/gu)];
  const decodedFrames = Number(frameMatches.at(-1)?.[1] || 0);
  assert.equal(decodedFrames, 124, "视频解码帧数不是 124");

  const evidence = {
    schema: "autodl_h3_v26_chain_validation.v1",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    generation_posts: generationPosts,
    image: {
      model: imageModel.displayName,
      width: generatedDimensions.width,
      height: generatedDimensions.height,
      bytes: generatedImageBytes.length,
      persisted_bytes: Number(persistedImage.size || 0),
      storage_key_sha256: createHash("sha256").update(String(persistedImage.key)).digest("hex"),
    },
    video: {
      model: videoModel.displayName,
      resolution_tier: validationResolution,
      resolution_label: resolutionSpec.label,
      expected_width: resolutionSpec.width,
      expected_height: resolutionSpec.height,
      ffprobe_width: Number(probedVideo.width),
      ffprobe_height: Number(probedVideo.height),
      ffprobe_codec: probedVideo.codec_name,
      ffprobe_frame_rate: probedVideo.r_frame_rate,
      task_id: taskId,
      duration_seconds: durationSeconds,
      decoded_frames: decodedFrames,
      bytes: videoBytes.length,
      sha256: createHash("sha256").update(videoBytes).digest("hex"),
      local_path: videoPath,
    },
    secrets_printed: false,
    upstream_signed_urls_printed: false,
  };
  const evidencePath = path.join(evidenceDir, "validation.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    status: "passed",
    run_id: runId,
    generation_posts: generationPosts,
    image: evidence.image,
    video: evidence.video,
    evidence_path: evidencePath,
    secrets_printed: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: "failed",
    run_id: runId,
    message: safeMessage(error),
    automatic_generation_retry: false,
    power_action: false,
  }, null, 2));
  process.exitCode = 1;
});
