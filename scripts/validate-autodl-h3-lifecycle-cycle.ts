import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";

import type { AutodlH3PowerState } from "../src/lib/autodl-h3-lifecycle";
import {
  createAutodlDeveloperTokenResolver,
  createAutodlH3InstanceClient,
} from "../src/lib/autodl-h3-production-runtime";

export const AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS = Object.freeze({
  generationAck: "--ack-real-generation",
  powerCycleAck: "--ack-real-power-cycle",
  baseUrl: "http://127.0.0.1:5000",
  instanceUuid: "pro-7872645dd0a7",
  publicModelDisplayName: "MiniMax H3 Turbo · 自租 PRO6000（本地验证）",
  durationSeconds: 5,
  resolution: "480p",
  aspectRatio: "16:9",
  idleSeconds: 300,
  pollIntervalMs: 5_000,
  preStopTimeoutMs: 15 * 60_000,
  wakeTimeoutMs: 15 * 60_000,
  generationTimeoutMs: 30 * 60_000,
  postStopTimeoutMs: 15 * 60_000,
});

type JsonRecord = Record<string, unknown>;

export interface PublicVideoModel {
  id: string;
  displayName: string;
  capabilities?: Record<string, unknown>;
}

export interface SseTerminal {
  event: "completed" | "failed" | "cancelled" | "error";
  data: JsonRecord;
}

export interface MediaProbe {
  codec: string;
  audioCodec: string;
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: string;
  frameCount: number;
  inspector: "ffprobe" | "ffmpeg-static";
}

export interface OfficialStateEvidence {
  elapsedMs: number;
  phase: "pre-stop" | "wake" | "post-idle";
  state: AutodlH3PowerState;
}

export interface LifecycleAcceptanceDependencies {
  fetchImpl?: typeof fetch;
  getOfficialPowerState?: () => Promise<AutodlH3PowerState>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  inspectMedia?: (bytes: Buffer, mediaPath: string) => Promise<MediaProbe>;
  writeMedia?: (runId: string, bytes: Buffer) => Promise<string>;
  writeEvidence?: (runId: string, evidence: JsonRecord) => Promise<string>;
  log?: (message: string) => void;
}

const outputRoot = process.env.H3_LIFECYCLE_ACCEPTANCE_OUTPUT_DIR
  || path.join(process.cwd(), ".codex-evidence", "autodl-h3-lifecycle");

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s"']+/giu, "url:[redacted]")
    .replace(/[A-Za-z0-9._~+/=-]{20,}/gu, "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 500);
}

export function assertLifecycleAcceptanceArguments(argv: readonly string[]): void {
  const constants = AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS;
  assert.ok(argv.includes(constants.generationAck), `拒绝真实生成：必须显式传入 ${constants.generationAck}`);
  assert.ok(argv.includes(constants.powerCycleAck), `拒绝真实电源循环验收：必须显式传入 ${constants.powerCycleAck}`);
}

export function assertLifecycleAcceptanceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const constants = AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS;
  assert.equal(environment.AUTODL_H3_INSTANCE_UUID, constants.instanceUuid, "只允许验收固定的现有 PRO6000 实例");
  assert.equal(environment.AUTODL_H3_LIFECYCLE_ENABLED, "true", "生命周期控制器必须启用");
  assert.equal(environment.AUTODL_H3_LIFECYCLE_DRY_RUN, "false", "真实电源循环验收要求关闭 dry-run");
  assert.equal(environment.AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS, "true", "生命周期控制器必须获准执行电源动作");
  assert.equal(environment.AUTODL_H3_ATOMIC_FINALIZER_ENABLED, "true", "真实电源动作必须启用原子终结器");
  assert.equal(environment.AUTODL_H3_IDLE_SECONDS, String(constants.idleSeconds), "空闲关机阈值必须固定为 300 秒");
  assert.ok(!String(environment.AUTODL_DEVELOPER_TOKEN || ""), "验收禁止从环境变量读取 Developer Token；只能使用 DPAPI 文件解析器");

  for (const name of [
    "AUTODL_H3_SSH_EXECUTABLE",
    "AUTODL_H3_SSH_KEY_PATH",
    "AUTODL_H3_SSH_KNOWN_HOSTS_PATH",
  ] as const) {
    const value = String(environment[name] || "").trim();
    assert.ok(value && path.isAbsolute(value), `${name} 必须是已配置的绝对路径`);
  }
}

export function createDpapiOnlyOfficialStatusObserver(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): () => Promise<AutodlH3PowerState> {
  assert.equal(process.platform, "win32", "DPAPI 生命周期验收只能在创建密钥的 Windows 用户下运行");
  const dpapiEnvironment: Record<string, string | undefined> = {};
  if (environment.CODEX_HOME) dpapiEnvironment.CODEX_HOME = environment.CODEX_HOME;
  const resolveDeveloperToken = createAutodlDeveloperTokenResolver({
    environment: dpapiEnvironment,
    platform: "win32",
  });
  const client = createAutodlH3InstanceClient({
    allowedInstanceUuids: [AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.instanceUuid],
    resolveDeveloperToken,
  });
  return async () => {
    const status = await client.getStatus(AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.instanceUuid);
    return status.powerState;
  };
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    throw new Error(`LOCAL_API_NON_JSON_${response.status}`);
  }
  if (!response.ok) {
    const code = isRecord(parsed) ? safeMessage(parsed.error || `HTTP_${response.status}`) : `HTTP_${response.status}`;
    throw new Error(`LOCAL_API_FAILED_${response.status}_${code}`);
  }
  return parsed as T;
}

function assertLocalApiUrl(raw: string, expectedPath: string): string {
  assert.ok(raw.startsWith("/"), "站内媒体票据必须是相对路径");
  const parsed = new URL(raw, AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.baseUrl);
  assert.equal(parsed.origin, AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.baseUrl, "媒体票据禁止离开本地 5000 端口");
  assert.equal(parsed.pathname, expectedPath, `媒体票据必须指向 ${expectedPath}`);
  return parsed.toString();
}

function exactPublicModel(models: PublicVideoModel[]): PublicVideoModel {
  const constants = AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS;
  const matches = models.filter((model) => model.displayName === constants.publicModelDisplayName);
  assert.equal(matches.length, 1, "必须且只能找到 exact H3 selfhost PRO6000 公共模型");
  const model = matches[0];
  assert.match(model.id, /^pm_[A-Za-z0-9_-]+$/u, "H3 selfhost 必须使用公共 opaque model ID");
  const capabilities = model.capabilities || {};
  const resolutions = Array.isArray(capabilities.resolutionOptions) ? capabilities.resolutionOptions.map(String) : [];
  const durations = Array.isArray(capabilities.nativeDurations) ? capabilities.nativeDurations.map(Number) : [];
  const aspectRatios = Array.isArray(capabilities.aspectRatios) ? capabilities.aspectRatios.map(String) : [];
  assert.ok(resolutions.includes(constants.resolution), "exact H3 selfhost 未公开 480p 档");
  assert.ok(durations.includes(constants.durationSeconds), "exact H3 selfhost 未公开 5 秒原生时长");
  assert.ok(aspectRatios.includes(constants.aspectRatio), "exact H3 selfhost 未公开 16:9");
  assert.equal(capabilities.requiresImage, false, "exact H3 selfhost 必须允许纯文生视频");
  assert.notEqual(capabilities.available, false, "exact H3 selfhost 当前被健康门禁暂停");
  return model;
}

async function waitForTerminalSse(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
): Promise<SseTerminal> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.generationTimeoutMs,
  );
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: controller.signal,
    });
    assert.ok(response.ok && response.body, `SSE_CONNECT_FAILED_${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/gu, "\n");
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        let event = "";
        let data: JsonRecord = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          if (line.startsWith("data: ")) {
            const candidate = JSON.parse(line.slice(6)) as unknown;
            data = isRecord(candidate) ? candidate : {};
          }
        }
        if (["completed", "failed", "cancelled", "error"].includes(event)) {
          return { event: event as SseTerminal["event"], data };
        }
      }
      if (done) throw new Error("SSE_ENDED_BEFORE_TERMINAL_NO_RETRY");
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveLifecycleMediaInspector(options: {
  environment?: Readonly<Record<string, string | undefined>>;
  bundledFfmpegPath?: string | null;
  fileExists?: (filePath: string) => boolean;
} = {}): { kind: "ffprobe" | "ffmpeg-static"; command: string } {
  const environment = options.environment || process.env;
  const fileExists = options.fileExists || existsSync;
  const configured = String(environment.H3_LIFECYCLE_ACCEPTANCE_FFPROBE_PATH || "").trim();
  if (configured) {
    assert.ok(path.isAbsolute(configured), "H3_LIFECYCLE_ACCEPTANCE_FFPROBE_PATH 必须是绝对路径");
    assert.ok(fileExists(configured), "显式 ffprobe 路径不存在");
    return { kind: "ffprobe", command: configured };
  }

  const bundled = String(options.bundledFfmpegPath ?? ffmpegPath ?? "").trim();
  assert.ok(bundled && path.isAbsolute(bundled), "项目 ffmpeg-static 不可用");
  assert.ok(fileExists(bundled), "项目 ffmpeg-static 文件不存在");
  return { kind: "ffmpeg-static", command: bundled };
}

function parseTimestampSeconds(hours: string, minutes: string, seconds: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function parseLifecycleFfmpegMediaLog(mediaLog: string): MediaProbe {
  const duration = mediaLog.match(/Duration:\s*(\d{2}):(\d{2}):(\d+(?:\.\d+)?)/iu);
  const video = mediaLog.match(/Video:\s*([^,\s]+)[^\r\n]*?(\d{2,5})x(\d{2,5})[^\r\n]*?(\d+(?:\.\d+)?)\s*fps/iu);
  const audio = mediaLog.match(/Audio:\s*([^,\s]+)/iu);
  const frames = [...mediaLog.matchAll(/frame=\s*(\d+)/gu)];
  assert.ok(duration, "ffmpeg-static 未识别媒体时长");
  assert.ok(video, "ffmpeg-static 未识别视频编码、尺寸或帧率");
  assert.ok(audio, "ffmpeg-static 未识别音频编码");
  assert.ok(frames.length > 0, "ffmpeg-static 未识别解码帧数");
  return {
    codec: video[1].toLowerCase(),
    audioCodec: audio[1].toLowerCase(),
    width: Number(video[2]),
    height: Number(video[3]),
    durationSeconds: parseTimestampSeconds(duration[1], duration[2], duration[3]),
    frameRate: `${Number(video[4])}/1`,
    frameCount: Number(frames.at(-1)?.[1] || 0),
    inspector: "ffmpeg-static",
  };
}

async function inspectMediaStrictly(_bytes: Buffer, mediaPath: string): Promise<MediaProbe> {
  const inspector = resolveLifecycleMediaInspector();
  if (inspector.kind === "ffmpeg-static") {
    const result = spawnSync(inspector.command, [
      "-hide_banner",
      "-i", mediaPath,
      "-map", "0:v:0",
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3 * 60_000,
    });
    assert.equal(result.status, 0, `FFMPEG_STATIC_FAILED_${String(result.status)}`);
    return parseLifecycleFfmpegMediaLog(`${result.stdout || ""}\n${result.stderr || ""}`);
  }

  const result = spawnSync(inspector.command, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames:format=duration",
    "-of", "json",
    mediaPath,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `FFPROBE_FAILED_${String(result.status)}`);
  const parsed = JSON.parse(String(result.stdout || "{}")) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      nb_frames?: string;
    }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.find((candidate) => candidate.codec_type === "video");
  const audio = parsed.streams?.find((candidate) => candidate.codec_type === "audio");
  assert.ok(stream, "FFPROBE_VIDEO_STREAM_MISSING");
  assert.ok(audio, "FFPROBE_AUDIO_STREAM_MISSING");
  assert.ok(typeof stream.nb_frames === "string" && /^\d+$/u.test(stream.nb_frames), "FFPROBE_FRAME_COUNT_MISSING");
  return {
    codec: String(stream.codec_name || ""),
    audioCodec: String(audio.codec_name || ""),
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
    durationSeconds: Number(parsed.format?.duration || 0),
    frameRate: String(stream.r_frame_rate || ""),
    frameCount: Number(stream.nb_frames),
    inspector: "ffprobe",
  };
}

async function defaultWriteMedia(runId: string, bytes: Buffer): Promise<string> {
  const directory = path.join(outputRoot, runId);
  await mkdir(directory, { recursive: true });
  const mediaPath = path.join(directory, "minimax-h3-t2v-5s-480p.mp4");
  await writeFile(mediaPath, bytes);
  return mediaPath;
}

async function defaultWriteEvidence(runId: string, evidence: JsonRecord): Promise<string> {
  const directory = path.join(outputRoot, runId);
  await mkdir(directory, { recursive: true });
  const evidencePath = path.join(directory, "lifecycle-acceptance.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  return evidencePath;
}

function assertMediaProbe(probe: MediaProbe): void {
  assert.equal(probe.codec, "h264", "最终视频编码不是 H.264");
  assert.equal(probe.audioCodec, "aac", "最终视频音频编码不是 AAC");
  assert.deepEqual({ width: probe.width, height: probe.height }, { width: 864, height: 480 }, "最终视频不是 864x480 原生 480p");
  assert.ok(Math.abs(probe.durationSeconds - 5.167) <= 0.14, "最终视频时长不是约 5.167 秒");
  const [numerator, denominator] = probe.frameRate.split("/").map(Number);
  assert.ok(denominator > 0 && numerator / denominator >= 23.9 && numerator / denominator <= 24.1, "最终视频帧率不是 24fps");
  assert.equal(probe.frameCount, 124, "最终视频解码帧数不是 124 帧");
}

function createStatusTracker(options: {
  getOfficialPowerState: () => Promise<AutodlH3PowerState>;
  now: () => number;
  startedAtMs: number;
  timeline: OfficialStateEvidence[];
  log: (message: string) => void;
}) {
  let lastState: AutodlH3PowerState | undefined;
  return async (phase: OfficialStateEvidence["phase"]): Promise<AutodlH3PowerState> => {
    const state = await options.getOfficialPowerState();
    assert.notEqual(state, "unknown", "官方实例状态未知，验收立即停止");
    if (state !== lastState) {
      options.timeline.push({
        elapsedMs: Math.max(0, options.now() - options.startedAtMs),
        phase,
        state,
      });
      options.log(`[AutoDL H3 生命周期验收] 官方状态：${state}`);
      lastState = state;
    }
    return state;
  };
}

async function waitForOfficialState(options: {
  sample: (phase: OfficialStateEvidence["phase"]) => Promise<AutodlH3PowerState>;
  phase: OfficialStateEvidence["phase"];
  accepted: ReadonlySet<AutodlH3PowerState>;
  timeoutMs: number;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<AutodlH3PowerState> {
  const startedAt = options.now();
  while (options.now() - startedAt <= options.timeoutMs) {
    const state = await options.sample(options.phase);
    if (options.accepted.has(state)) return state;
    await options.sleep(AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS.pollIntervalMs);
  }
  throw new Error(`OFFICIAL_STATE_TIMEOUT_${options.phase}`);
}

export async function runAutodlH3LifecycleAcceptance(
  dependencies: LifecycleAcceptanceDependencies = {},
): Promise<{ evidencePath: string; evidence: JsonRecord }> {
  const constants = AUTODL_H3_LIFECYCLE_ACCEPTANCE_CONSTANTS;
  const fetchImpl = dependencies.fetchImpl || fetch;
  const getOfficialPowerState = dependencies.getOfficialPowerState || createDpapiOnlyOfficialStatusObserver();
  const now = dependencies.now || Date.now;
  const sleep = dependencies.sleep || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const inspectMedia = dependencies.inspectMedia || inspectMediaStrictly;
  const writeMedia = dependencies.writeMedia || defaultWriteMedia;
  const writeEvidence = dependencies.writeEvidence || defaultWriteEvidence;
  const log = dependencies.log || console.log;
  const runId = randomUUID().replace(/-/gu, "");
  const startedAtMs = now();
  const startedAtIso = new Date().toISOString();
  const timeline: OfficialStateEvidence[] = [];
  const sample = createStatusTracker({ getOfficialPowerState, now, startedAtMs, timeline, log });
  let generationPosts = 0;

  log("[AutoDL H3 生命周期验收] 等待控制器将空闲实例自动关机");
  await waitForOfficialState({
    sample,
    phase: "pre-stop",
    accepted: new Set<AutodlH3PowerState>(["stopped"]),
    timeoutMs: constants.preStopTimeoutMs,
    now,
    sleep,
  });

  const session = await json<{ token?: string; user?: { role?: string } }>(await fetchImpl(`${constants.baseUrl}/api/auth/dev-session`, {
    headers: { "x-local-workbench": "ai-creation-studio-local" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  }));
  assert.ok(session.token, "LOCAL_ADMIN_SESSION_MISSING");
  assert.equal(session.user?.role, "admin", "生命周期真实验收必须使用本地管理员免扣费会话");
  const authHeaders = { Authorization: `Bearer ${session.token}` };

  const modelPayload = await json<{ models?: PublicVideoModel[] }>(await fetchImpl(
    `${constants.baseUrl}/api/video/models?surface=video-page`,
    { headers: authHeaders, redirect: "error", signal: AbortSignal.timeout(20_000) },
  ));
  const model = exactPublicModel(Array.isArray(modelPayload.models) ? modelPayload.models : []);

  const prompt = "清晨的海边木栈道，微风吹动路边芦苇，镜头平稳缓慢向前推进，电影感自然光，无字幕，无水印。";
  generationPosts += 1;
  assert.equal(generationPosts, 1, "生命周期验收只允许提交一条视频任务");
  const submitPayload = await json<{
    task_id?: string;
    model_id?: string;
    content_url?: string;
    status?: string;
  }>(await fetchImpl(`${constants.baseUrl}/api/video/generate`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: model.id,
      prompt,
      duration: constants.durationSeconds,
      aspect_ratio: constants.aspectRatio,
      resolution: constants.resolution,
      resolution_tier: constants.resolution,
      task_label: `H3生命周期验收-${runId}`,
      card_index: 1,
      surface: "video-page",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  }));
  const publicTaskId = String(submitPayload.task_id || "");
  assert.match(publicTaskId, /^h3q_[a-f0-9]+$/u, "生命周期提交必须返回 h3q_ 公共任务 ID");
  assert.ok(["pending", "queued", "processing"].includes(String(submitPayload.status || "")), "生命周期任务提交状态异常");

  log("[AutoDL H3 生命周期验收] 已从 V2.6 提交唯一任务，等待官方状态由 stopped 进入 running");
  await waitForOfficialState({
    sample,
    phase: "wake",
    accepted: new Set<AutodlH3PowerState>(["running"]),
    timeoutMs: constants.wakeTimeoutMs,
    now,
    sleep,
  });
  assert.ok(
    timeline.some((entry) => entry.phase === "pre-stop" && entry.state === "stopped")
      && timeline.some((entry) => entry.phase === "wake" && ["starting", "running"].includes(entry.state)),
    "未观察到 stopped → starting/running 官方状态迁移",
  );

  const sseModelId = /^pm_[A-Za-z0-9_-]+$/u.test(String(submitPayload.model_id || ""))
    ? String(submitPayload.model_id)
    : model.id;
  const sseParams = new URLSearchParams({
    taskId: publicTaskId,
    modelId: sseModelId,
    contentUrl: String(submitPayload.content_url || ""),
    prompt,
    cardIndex: "1",
    targetDuration: String(constants.durationSeconds),
  });
  const terminal = await waitForTerminalSse(
    fetchImpl,
    `${constants.baseUrl}/api/video/stream?${sseParams.toString()}`,
    session.token,
  );
  assert.equal(terminal.event, "completed", `H3_SSE_TERMINAL_${safeMessage(terminal.data.errorMessage || terminal.event)}`);
  const idleStartedAtMs = now();

  const terminalPlaybackPath = String(terminal.data.videoUrl || terminal.data.video_url || "");
  assertLocalApiUrl(terminalPlaybackPath, "/api/video/proxy");
  const playbackTicket = await json<{ url?: string }>(await fetchImpl(
    `${constants.baseUrl}/api/video/access-ticket?${new URLSearchParams({ taskId: publicTaskId, scope: "playback" }).toString()}`,
    { headers: authHeaders, redirect: "error", signal: AbortSignal.timeout(20_000) },
  ));
  const playbackUrl = assertLocalApiUrl(String(playbackTicket.url || ""), "/api/video/proxy");
  const playbackResponse = await fetchImpl(playbackUrl, {
    headers: { Range: "bytes=0-4095" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  assert.ok(playbackResponse.status === 200 || playbackResponse.status === 206, `PLAYBACK_FAILED_${playbackResponse.status}`);
  assert.ok((await playbackResponse.arrayBuffer()).byteLength > 0, "PLAYBACK_EMPTY");

  const downloadTicket = await json<{ url?: string }>(await fetchImpl(
    `${constants.baseUrl}/api/video/access-ticket?${new URLSearchParams({
      taskId: publicTaskId,
      scope: "download",
      name: "minimax-h3-t2v-5s-480p.mp4",
    }).toString()}`,
    { headers: authHeaders, redirect: "error", signal: AbortSignal.timeout(20_000) },
  ));
  const downloadUrl = assertLocalApiUrl(String(downloadTicket.url || ""), "/api/video/proxy-download");
  const downloadResponse = await fetchImpl(downloadUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(3 * 60_000),
  });
  assert.ok(downloadResponse.ok, `DOWNLOAD_FAILED_${downloadResponse.status}`);
  const videoBytes = Buffer.from(await downloadResponse.arrayBuffer());
  assert.ok(videoBytes.length > 10_000, "DOWNLOADED_VIDEO_TOO_SMALL");
  assert.equal(videoBytes.subarray(4, 8).toString("ascii"), "ftyp", "DOWNLOADED_MEDIA_NOT_MP4");
  const mediaPath = await writeMedia(runId, videoBytes);
  const mediaProbe = await inspectMedia(videoBytes, mediaPath);
  assertMediaProbe(mediaProbe);

  log("[AutoDL H3 生命周期验收] 生成、播放、下载已通过；开始连续 300 秒空闲观察");
  while (now() - idleStartedAtMs < constants.idleSeconds * 1000) {
    const state = await sample("post-idle");
    assert.ok(!["stopping", "stopped"].includes(state), "实例在连续 300 秒空闲期完成前提前关机");
    const remaining = constants.idleSeconds * 1000 - (now() - idleStartedAtMs);
    await sleep(Math.min(constants.pollIntervalMs, Math.max(1, remaining)));
  }
  await waitForOfficialState({
    sample,
    phase: "post-idle",
    accepted: new Set<AutodlH3PowerState>(["stopped"]),
    timeoutMs: constants.postStopTimeoutMs,
    now,
    sleep,
  });

  assert.equal(generationPosts, 1, "验收过程中出现额外生成提交");
  const evidence: JsonRecord = {
    schema: "autodl_h3_lifecycle_cycle_acceptance.v1",
    status: "passed",
    run_id: runId,
    started_at: startedAtIso,
    finished_at: new Date().toISOString(),
    local_origin: constants.baseUrl,
    instance_uuid_sha256: sha256(constants.instanceUuid),
    model: {
      public_display_name: model.displayName,
      public_model_id_sha256: sha256(model.id),
    },
    request: {
      kind: "text_to_video",
      duration_seconds: constants.durationSeconds,
      resolution: constants.resolution,
      aspect_ratio: constants.aspectRatio,
      prompt_sha256: sha256(prompt),
      generation_posts: generationPosts,
      automatic_generation_retry: false,
    },
    task_id_sha256: sha256(publicTaskId),
    official_power_timeline: timeline,
    idle_observation_seconds: constants.idleSeconds,
    media: {
      bytes: videoBytes.length,
      sha256: sha256(videoBytes),
      codec: mediaProbe.codec,
      audio_codec: mediaProbe.audioCodec,
      width: mediaProbe.width,
      height: mediaProbe.height,
      duration_seconds: mediaProbe.durationSeconds,
      frame_rate: mediaProbe.frameRate,
      frame_count: mediaProbe.frameCount,
      inspector: mediaProbe.inspector,
      filename: path.basename(mediaPath),
      playback_range_ok: true,
      download_ok: true,
    },
    credential_source: "windows_dpapi_resolver",
    developer_token_printed: false,
    signed_url_printed: false,
    direct_power_calls: false,
    release_calls: false,
  };
  const evidencePath = await writeEvidence(runId, evidence);
  log(`[AutoDL H3 生命周期验收] 通过；脱敏证据：${evidencePath}`);
  return { evidencePath, evidence };
}

export async function main(argv = process.argv, environment = process.env): Promise<void> {
  assertLifecycleAcceptanceArguments(argv);
  assertLifecycleAcceptanceEnvironment(environment);
  await runAutodlH3LifecycleAcceptance();
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      message: safeMessage(error),
      automatic_generation_retry: false,
      direct_power_calls: false,
      release_calls: false,
      developer_token_printed: false,
    }, null, 2));
    process.exitCode = 1;
  });
}
