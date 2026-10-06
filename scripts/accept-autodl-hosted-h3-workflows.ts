import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import dotenv from "dotenv";

import {
  AUTODL_HOSTED_H3_API_BASE,
  AUTODL_HOSTED_H3_METADATA_BASE,
  AUTODL_HOSTED_H3_WORKFLOWS,
  autoDLHostedH3ContractSha256,
  buildAutoDLHostedH3CatalogRecords,
  type AutoDLHostedH3WorkflowSpec,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";
import {
  assertVideoModelActivationReady,
  inspectVideoModelActivationReadiness,
  isActivationGatedVideoConfig,
  issueVideoModelAcceptanceEvidence,
  persistVideoModelAcceptanceEvidence,
  videoActivationBindingSha256,
} from "../src/lib/model-activation-gate";
import { AUTODL_COMFYUI_SECRET_REF, resolveProviderSecret } from "../src/lib/provider-secret";
import { safeFetch, validateSafeUrl } from "../src/lib/safe-fetch";
import { validateUploadBuffer } from "../src/lib/file-upload-security";
import { pollVideoTask, submitVideoTask, type VideoGenerateParams, type VideoModelConfig } from "../src/lib/video-adapter";
import { validateAutodlComfyuiWorkflowInput } from "../src/lib/video-autodl-comfyui-workflow";
import { storageManager } from "../src/storage/object";
import type { StorageProviderType } from "../src/storage/object";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";

dotenv.config({ path: ".env.local", quiet: true });

const ACCEPTANCE_SCHEMA = "autodl_hosted_h3_acceptance.v1";
const TARGET_PROTOCOL = "autodl_comfyui_workflow";
const TARGET_PROVIDER: StorageProviderType = "tencent_cos";
const CANARY_DURATION_SECONDS = 5;
const CANARY_RESOLUTION = "480p";
const CANARY_ASPECT_RATIO = "16:9";
const EXPECTED_WIDTH = 864;
const EXPECTED_HEIGHT = 480;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 45 * 60_000;
const AUTODL_HOSTED_RESULT_HOST = "codewithgpu-image-1310972338.cos.ap-beijing.myqcloud.com";
const TARGET_IDS = new Set(AUTODL_HOSTED_H3_WORKFLOWS.map((spec) => spec.modelId));
const MODEL_SELECT = [
  "id", "name", "model_name", "provider", "protocol_type", "api_endpoint", "api_key",
  "price_per_use", "duration_seconds", "supports_image_input", "requires_image",
  "is_active", "is_hidden", "api_protocol_config",
].join(",");

type JsonRecord = Record<string, unknown>;

type VideoModelRow = {
  id: string;
  name: string;
  model_name: string;
  provider: string;
  protocol_type: string;
  api_endpoint: string;
  api_key: string;
  price_per_use: number;
  duration_seconds: number;
  supports_image_input: boolean;
  requires_image: boolean;
  is_active: boolean;
  is_hidden: boolean;
  api_protocol_config: Record<string, unknown>;
};

type OwnedAsset = {
  id: string;
  user_id: string;
  storage_key: string;
  storage_provider: StorageProviderType;
  file_category: "image" | "audio";
  file_size: number;
  content_type: string;
  created_at: string;
};

type MediaProbe = {
  codec: string;
  width: number;
  height: number;
  duration_seconds: number;
  format_name: string;
};

type ModelLedger = {
  model_id: string;
  workflow_id: string;
  state:
    | "planned"
    | "submit_intent"
    | "submitted"
    | "upstream_success"
    | "persisted"
    | "activated"
    | "failed";
  submitted_at?: string;
  task_id?: string;
  completed_at?: string;
  persisted_at?: string;
  storage_provider?: StorageProviderType;
  storage_key?: string;
  storage_size?: number;
  media_probe?: MediaProbe;
  evidence_id?: string;
  error_code?: string;
};

type AcceptanceLedger = {
  schema: typeof ACCEPTANCE_SCHEMA;
  run_id: string;
  created_at: string;
  user_ref: string;
  execution: {
    task_count: number;
    duration_seconds_each: number;
    resolution: string;
    aspect_ratio: string;
    max_estimated_cost_cny: number;
    sequential: true;
    submit_retries: 0;
  };
  models: ModelLedger[];
};

type PublicBridgeRecord = {
  category: "image" | "audio";
  key: string;
  url: string;
  content_type: string;
  size: number;
  sha256: string;
};

type PublicBridgeManifest = {
  schema: "autodl_hosted_h3_public_input_bridge.v1";
  run_id: string;
  user_ref: string;
  created_at: string;
  records: PublicBridgeRecord[];
};

type CliOptions = {
  execute: boolean;
  runId: string;
  userId: string;
  confirmedCanaries: number;
  maxCostCny: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  ffprobePath: string;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRunId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9][a-z0-9_-]{7,79}$/u.test(normalized)) {
    throw new Error("RUN_ID_INVALID: use 8-80 lowercase letters, digits, underscore, or hyphen");
  }
  return normalized;
}

function optionValue(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || "";
}

function numericOption(name: string, fallback: number): number {
  const value = Number(optionValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bundledFfprobePath(): string {
  const executable = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const candidate = path.join(process.cwd(), "node_modules", "ffprobe-static", "bin", process.platform, process.arch, executable);
  return existsSync(candidate) ? candidate : "ffprobe";
}

function parseOptions(): CliOptions {
  const execute = process.argv.includes("--execute");
  const suppliedRunId = optionValue("run-id");
  const generatedRunId = `h3hosted-${new Date().toISOString().slice(0, 10).replace(/-/gu, "")}-${randomUUID().slice(0, 8)}`;
  return {
    execute,
    runId: safeRunId(suppliedRunId || generatedRunId),
    userId: optionValue("user-id") || safeString(process.env.AUTODL_HOSTED_H3_ACCEPTANCE_USER_ID),
    confirmedCanaries: Math.trunc(numericOption("confirm-paid-canaries", 0)),
    maxCostCny: numericOption("max-cost-cny", 0),
    pollIntervalMs: Math.max(2_000, Math.trunc(numericOption("poll-interval-ms", DEFAULT_POLL_INTERVAL_MS))),
    pollTimeoutMs: Math.max(60_000, Math.trunc(numericOption("poll-timeout-ms", DEFAULT_POLL_TIMEOUT_MS))),
    ffprobePath: optionValue("ffprobe") || safeString(process.env.AUTODL_HOSTED_H3_ACCEPTANCE_FFPROBE_PATH) || bundledFfprobePath(),
  };
}

function cleanError(error: unknown): string {
  const candidate = record(error);
  const raw = error instanceof Error
    ? error.message
    : [candidate.code, candidate.message, candidate.details, candidate.hint]
      .map(safeString)
      .filter(Boolean)
      .join(":") || String(error || "unknown error");
  return raw
    .replace(/https?:\/\/[^\s"']+/giu, "[url-redacted]")
    .replace(/(?:Bearer\s+)?[A-Za-z0-9_-]{24,}/gu, "[secret-redacted]")
    .slice(0, 500);
}

function evidenceRef(kind: string, modelId: string, runId: string): string {
  return `${kind}:${sha256(`${runId}:${modelId}:${kind}`).slice(0, 24)}`;
}

function trustedAutoDLResultHostname(value: string): string {
  const parsed = new URL(value);
  assert.equal(parsed.protocol, "https:", "AUTODL_RESULT_NOT_HTTPS");
  assert.equal(parsed.hostname, AUTODL_HOSTED_RESULT_HOST, "AUTODL_RESULT_HOST_NOT_ALLOWED");
  assert.equal(parsed.port, "", "AUTODL_RESULT_PORT_NOT_ALLOWED");
  assert.equal(parsed.username, "", "AUTODL_RESULT_CREDENTIALS_NOT_ALLOWED");
  assert.equal(parsed.password, "", "AUTODL_RESULT_CREDENTIALS_NOT_ALLOWED");
  assert.equal(parsed.search, "", "AUTODL_RESULT_QUERY_NOT_ALLOWED");
  assert.match(parsed.pathname, /\.mp4$/iu, "AUTODL_RESULT_NOT_MP4_PATH");
  return parsed.hostname;
}

function modelConfig(row: VideoModelRow, token: string): VideoModelConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    protocol_type: row.protocol_type,
    api_endpoint: row.api_endpoint,
    api_key: token,
    price_per_use: Number(row.price_per_use || 0),
    duration_seconds: Number(row.duration_seconds || CANARY_DURATION_SECONDS),
    supports_image_input: row.supports_image_input === true,
    model_name: row.model_name,
    api_protocol_config: row.api_protocol_config,
  };
}

function expectedCostCny(): number {
  return Number(AUTODL_HOSTED_H3_WORKFLOWS.reduce((total, spec) => (
    total + Number(spec.cnyPerOutputSecondByTier[CANARY_RESOLUTION] || 0) * CANARY_DURATION_SECONDS
  ), 0).toFixed(2));
}

function runSelfTest(): void {
  const records = buildAutoDLHostedH3CatalogRecords({ createdAt: new Date().toISOString() });
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((item) => item.id)).size, 3);
  assert.equal(new Set(records.map((item) => item.model_name)).size, 3);
  assert.equal(expectedCostCny(), 0.45);
  const imageUrls = ["https://assets.example.test/first.png", "https://assets.example.test/last.png"];
  const audioUrl = "https://assets.example.test/voice.wav";
  for (let index = 0; index < records.length; index += 1) {
    const row = records[index]!;
    const spec = AUTODL_HOSTED_H3_WORKFLOWS[index]!;
    const config: VideoModelConfig = {
      id: row.id,
      name: row.name,
      provider: row.provider,
      protocol_type: row.protocol_type,
      api_endpoint: row.api_endpoint,
      api_key: "fixture-token-never-sent",
      price_per_use: row.price_per_use,
      duration_seconds: row.duration_seconds,
      supports_image_input: row.supports_image_input,
      model_name: row.model_name,
      api_protocol_config: row.api_protocol_config,
    };
    const params = canaryParams(spec, imageUrls, audioUrl);
    assert.deepEqual(validateAutodlComfyuiWorkflowInput(config, params), { ok: true });
    assert.equal(params.duration, 5);
    assert.equal(params.resolutionTier, "480p");
    assert.equal(params.aspectRatio, "16:9");
  }
  assert.equal(
    trustedAutoDLResultHostname(`https://${AUTODL_HOSTED_RESULT_HOST}/outputs/canary.mp4`),
    AUTODL_HOSTED_RESULT_HOST,
  );
  assert.throws(
    () => trustedAutoDLResultHostname(`https://${AUTODL_HOSTED_RESULT_HOST}.evil.example/canary.mp4`),
    /AUTODL_RESULT_HOST_NOT_ALLOWED/u,
  );
  assert.throws(
    () => trustedAutoDLResultHostname(`http://${AUTODL_HOSTED_RESULT_HOST}/canary.mp4`),
    /AUTODL_RESULT_NOT_HTTPS/u,
  );
  assert.throws(
    () => trustedAutoDLResultHostname(`https://${AUTODL_HOSTED_RESULT_HOST}/canary.mp4?redirect=evil`),
    /AUTODL_RESULT_QUERY_NOT_ALLOWED/u,
  );
  console.log(JSON.stringify({
    event: "acceptance-runner-self-test-passed",
    network_calls: 0,
    paid_generation_calls: 0,
    workflows_checked: records.length,
    planned_max_cost_cny: expectedCostCny(),
    submit_retries: 0,
  }));
}

function canaryParams(
  spec: AutoDLHostedH3WorkflowSpec,
  imageUrls: readonly string[],
  audioUrl: string,
): VideoGenerateParams {
  const common: VideoGenerateParams = {
    prompt: "A friendly corgi calmly turns toward the camera in a bright living room, natural motion, stable composition, no text, no watermark.",
    duration: CANARY_DURATION_SECONDS,
    resolutionTier: CANARY_RESOLUTION,
    aspectRatio: CANARY_ASPECT_RATIO,
  };
  switch (spec.kind) {
    case "text_to_video":
      return common;
    case "multi_image_to_video":
      return { ...common, imageUrl: imageUrls[0], imageUrls: [imageUrls[0]] };
    case "first_last_frame_to_video":
      return { ...common, imageUrl: imageUrls[0], lastFrameUrl: imageUrls[1] };
    case "image_audio_lipsync":
      return { ...common, prompt: "", imageUrl: imageUrls[0], audioUrl };
    case "multi_image_audio_to_video":
      return { ...common, imageUrl: imageUrls[0], imageUrls: [imageUrls[0]], audioUrl, audioUrls: [audioUrl] };
  }
}

function resolveFfprobe(command: string): string {
  const explicit = path.isAbsolute(command);
  if (explicit && !existsSync(command)) throw new Error("FFPROBE_NOT_FOUND");
  const check = spawnSync(command, ["-version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (check.status !== 0) throw new Error("FFPROBE_NOT_AVAILABLE: configure AUTODL_HOSTED_H3_ACCEPTANCE_FFPROBE_PATH");
  return command;
}

function probeMp4(command: string, filePath: string): MediaProbe {
  const result = spawnSync(command, [
    "-v", "error",
    "-show_entries", "stream=index,codec_type,codec_name,width,height:format=format_name,duration",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`FFPROBE_FAILED:${safeString(result.stderr).slice(0, 160)}`);
  const data = JSON.parse(safeString(result.stdout) || "{}") as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  assert.ok(video, "FFPROBE_VIDEO_STREAM_MISSING");
  const probe: MediaProbe = {
    codec: safeString(video.codec_name),
    width: Number(video.width || 0),
    height: Number(video.height || 0),
    duration_seconds: Number(data.format?.duration || 0),
    format_name: safeString(data.format?.format_name),
  };
  assert.equal(probe.width, EXPECTED_WIDTH, `CANARY_WIDTH_MISMATCH:${probe.width}`);
  assert.equal(probe.height, EXPECTED_HEIGHT, `CANARY_HEIGHT_MISMATCH:${probe.height}`);
  assert.ok(probe.duration_seconds >= 3.5 && probe.duration_seconds <= 7.0, `CANARY_DURATION_MISMATCH:${probe.duration_seconds}`);
  assert.ok(/mp4|mov/iu.test(probe.format_name), `CANARY_CONTAINER_MISMATCH:${probe.format_name}`);
  return probe;
}

function probeAudioDuration(command: string, filePath: string): number {
  const result = spawnSync(command, [
    "-v", "error",
    "-show_entries", "stream=codec_type:format=duration",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  if (result.status !== 0) return 0;
  const data = JSON.parse(safeString(result.stdout) || "{}") as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  if (!data.streams?.some((stream) => stream.codec_type === "audio")) return 0;
  return Number(data.format?.duration || 0);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function loadOrCreateLedger(filePath: string, options: CliOptions, userRef: string): Promise<AcceptanceLedger> {
  if (existsSync(filePath)) {
    const ledger = JSON.parse(await readFile(filePath, "utf8")) as AcceptanceLedger;
    assert.equal(ledger.schema, ACCEPTANCE_SCHEMA, "LEDGER_SCHEMA_MISMATCH");
    assert.equal(ledger.run_id, options.runId, "LEDGER_RUN_ID_MISMATCH");
    assert.equal(ledger.user_ref, userRef, "LEDGER_USER_MISMATCH");
    return ledger;
  }
  const ledger: AcceptanceLedger = {
    schema: ACCEPTANCE_SCHEMA,
    run_id: options.runId,
    created_at: new Date().toISOString(),
    user_ref: userRef,
    execution: {
      task_count: AUTODL_HOSTED_H3_WORKFLOWS.length,
      duration_seconds_each: CANARY_DURATION_SECONDS,
      resolution: CANARY_RESOLUTION,
      aspect_ratio: CANARY_ASPECT_RATIO,
      max_estimated_cost_cny: expectedCostCny(),
      sequential: true,
      submit_retries: 0,
    },
    models: AUTODL_HOSTED_H3_WORKFLOWS.map((spec) => ({
      model_id: spec.modelId,
      workflow_id: spec.workflowId,
      state: "planned",
    })),
  };
  await atomicWriteJson(filePath, ledger);
  return ledger;
}

async function readModels(): Promise<VideoModelRow[]> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("video_models").select(MODEL_SELECT).in("id", [...TARGET_IDS]).order("sort_order");
  if (error) throw error;
  const rows = (data || []) as VideoModelRow[];
  assert.equal(rows.length, TARGET_IDS.size, "TARGET_MODELS_MISSING: apply catalog configuration first");
  const byId = new Map(rows.map((row) => [row.id, row]));
  return AUTODL_HOSTED_H3_WORKFLOWS.map((spec) => {
    const row = byId.get(spec.modelId);
    assert.ok(row, `TARGET_MODEL_MISSING:${spec.modelId}`);
    assert.equal(row.model_name, spec.workflowId, `WORKFLOW_BINDING_MISMATCH:${spec.modelId}`);
    assert.equal(row.provider, TARGET_PROTOCOL, `PROVIDER_MISMATCH:${spec.modelId}`);
    assert.equal(row.protocol_type, TARGET_PROTOCOL, `PROTOCOL_MISMATCH:${spec.modelId}`);
    assert.equal(row.api_endpoint, AUTODL_HOSTED_H3_API_BASE, `ENDPOINT_MISMATCH:${spec.modelId}`);
    assert.equal(row.api_key, AUTODL_COMFYUI_SECRET_REF, `SECRET_REFERENCE_MISMATCH:${spec.modelId}`);
    assert.equal(row.is_active, true, `MODEL_MUST_BE_ACTIVE:${spec.modelId}`);
    assert.equal(row.is_hidden, false, `MODEL_MUST_BE_VISIBLE:${spec.modelId}`);
    assert.equal(isActivationGatedVideoConfig(row.api_protocol_config), true, `ACTIVATION_GATE_MISSING:${spec.modelId}`);
    assert.equal(
      safeString(record(row.api_protocol_config).official_contract_sha256),
      autoDLHostedH3ContractSha256(spec),
      `PROTOCOL_FIXTURE_HASH_MISMATCH:${spec.modelId}`,
    );
    return row;
  });
}

async function selectOwner(explicitUserId: string): Promise<string> {
  const db = getSupabaseAdminClient();
  if (explicitUserId) {
    const { data, error } = await db.from("users").select("id,role").eq("id", explicitUserId).maybeSingle();
    if (error) throw error;
    assert.ok(data?.id, "ACCEPTANCE_USER_NOT_FOUND");
    return String(data.id);
  }
  const { data: admins, error: adminError } = await db.from("users").select("id").eq("role", "admin");
  if (adminError) throw adminError;
  const adminIds = (admins || []).map((row: { id?: unknown }) => safeString(row.id)).filter(Boolean);
  assert.ok(adminIds.length > 0, "NO_ADMIN_USER_FOUND");
  const { data: assets, error: assetError } = await db
    .from("user_files")
    .select("user_id,file_category")
    .in("user_id", adminIds)
    .eq("storage_provider", TARGET_PROVIDER)
    .in("file_category", ["image", "audio"])
    .limit(2_000);
  if (assetError) throw assetError;
  const counts = new Map<string, { images: number; audios: number }>();
  for (const asset of assets || []) {
    const userId = safeString(asset.user_id);
    const entry = counts.get(userId) || { images: 0, audios: 0 };
    if (asset.file_category === "image") entry.images += 1;
    if (asset.file_category === "audio") entry.audios += 1;
    counts.set(userId, entry);
  }
  const eligible = [...counts.entries()].filter(([, count]) => count.images >= 2 && count.audios >= 1);
  assert.equal(eligible.length, 1, "ACCEPTANCE_USER_AMBIGUOUS: pass --user-id for the signed-in owner with >=2 COS images and >=1 COS audio");
  return eligible[0]![0];
}

async function ownedAssets(userId: string, ffprobe: string | null): Promise<{ images: OwnedAsset[]; audio: OwnedAsset }> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("user_files")
    .select("id,user_id,storage_key,storage_provider,file_category,file_size,content_type,created_at")
    .eq("user_id", userId)
    .eq("storage_provider", TARGET_PROVIDER)
    .in("file_category", ["image", "audio"])
    .order("created_at", { ascending: false })
    .limit(250);
  if (error) throw error;
  const rows = (data || []) as OwnedAsset[];
  const imageCandidates = rows.filter((row) => row.file_category === "image" && ["image/jpeg", "image/png", "image/webp"].includes(row.content_type));
  const audioCandidates = rows.filter((row) => row.file_category === "audio" && ["audio/mpeg", "audio/wav", "audio/mp4", "audio/flac"].includes(row.content_type));
  const images: OwnedAsset[] = [];
  for (const candidate of imageCandidates) {
    try {
      const bytes = await storageManager.read(candidate.storage_key, TARGET_PROVIDER);
      const validated = validateUploadBuffer(bytes, candidate.content_type);
      if (validated.contentType.startsWith("image/") && bytes.length > 0) images.push(candidate);
    } catch {
      // Historical metadata can outlive an object. Only a successful COS read is accepted.
    }
    if (images.length === 2) break;
  }
  let audio: OwnedAsset | undefined;
  for (const candidate of audioCandidates) {
    let bytes: Buffer;
    try {
      bytes = await storageManager.read(candidate.storage_key, TARGET_PROVIDER);
      if (bytes.length <= 0 || bytes.length > 100 * 1024 * 1024) continue;
      validateUploadBuffer(bytes, candidate.content_type);
    } catch {
      continue;
    }
    if (!ffprobe) {
      audio = candidate;
      break;
    }
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "autodl-h3-audio-preflight-"));
    const extension = candidate.content_type === "audio/wav" ? ".wav"
      : candidate.content_type === "audio/flac" ? ".flac"
        : candidate.content_type === "audio/mp4" ? ".m4a"
          : ".mp3";
    try {
      const tempFile = path.join(tempDir, `owned-audio${extension}`);
      await writeFile(tempFile, bytes);
      const duration = probeAudioDuration(ffprobe, tempFile);
      if (duration >= CANARY_DURATION_SECONDS) {
        audio = candidate;
        break;
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  assert.equal(images.length, 2, "OWNED_COS_IMAGES_MISSING: two distinct stable images are required");
  assert.ok(audio, "OWNED_COS_AUDIO_MISSING: stop before paid calls; arbitrary external audio is forbidden");
  return { images, audio };
}

async function readonlyMetadataCheck(spec: AutoDLHostedH3WorkflowSpec): Promise<void> {
  const response = await fetch(`${AUTODL_HOSTED_H3_METADATA_BASE}/${encodeURIComponent(spec.workflowId)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.ok, `METADATA_HTTP_${response.status}:${spec.workflowId}`);
  const text = await response.text();
  assert.ok(text.includes(spec.workflowId), `METADATA_WORKFLOW_ID_MISMATCH:${spec.workflowId}`);
}

async function readonlyTokenProbe(token: string, runId: string): Promise<boolean> {
  const probeId = `codex_readonly_${sha256(runId).slice(0, 16)}`;
  const response = await fetch(`${AUTODL_HOSTED_H3_API_BASE}/comfyui/comfyui_workflow/result/${probeId}`, {
    method: "GET",
    headers: { Authorization: token, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  await response.body?.cancel();
  return response.status !== 401 && response.status !== 403;
}

async function platformBalanceSufficient(userId: string, requiredCny: number): Promise<boolean> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db.from("users").select("role,cash_balance").eq("id", userId).single();
  if (error || !data) throw error || new Error("ACCEPTANCE_USER_BALANCE_UNAVAILABLE");
  return data.role === "admin" || Number(data.cash_balance || 0) >= requiredCny;
}

async function validatePublicBridgeRecord(recordValue: PublicBridgeRecord, userId: string): Promise<void> {
  const publicUrl = new URL(recordValue.url);
  assert.equal(publicUrl.protocol, "https:", "PUBLIC_BRIDGE_NOT_HTTPS");
  assert.equal(publicUrl.search, "", "PUBLIC_BRIDGE_URL_HAS_QUERY");
  assert.equal(publicUrl.username, "", "PUBLIC_BRIDGE_URL_HAS_CREDENTIALS");
  assert.equal(publicUrl.password, "", "PUBLIC_BRIDGE_URL_HAS_CREDENTIALS");
  assert.match(
    publicUrl.hostname,
    /^[a-z0-9][a-z0-9-]{0,62}\.cos\.[a-z0-9-]+\.myqcloud\.com$/iu,
    "PUBLIC_BRIDGE_HOST_NOT_TENCENT_COS",
  );
  // This desktop runtime resolves public hosts through a 198.18/15 inspection
  // proxy. Trust only the exact HTTPS COS hostname produced by our provider;
  // arbitrary caller-controlled hosts never reach this acceptance path.
  const trustedHostnames = [publicUrl.hostname];
  const safePublicUrl = await validateSafeUrl(publicUrl, { trustedHostnames });
  const headResponse = await fetch(safePublicUrl, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(headResponse.status, 200, "PUBLIC_BRIDGE_EXTERNAL_HEAD_NOT_200");
  assert.equal(
    safeString(headResponse.headers.get("content-type")).split(";", 1)[0].toLowerCase(),
    recordValue.content_type,
    "PUBLIC_BRIDGE_EXTERNAL_HEAD_MIME_MISMATCH",
  );
  const declaredLength = Number(headResponse.headers.get("content-length") || 0);
  assert.equal(declaredLength, recordValue.size, "PUBLIC_BRIDGE_EXTERNAL_HEAD_SIZE_MISMATCH");
  await headResponse.body?.cancel();
  const expectedBytes = await storageManager.read(recordValue.key, TARGET_PROVIDER);
  assert.equal(expectedBytes.length, recordValue.size, "PUBLIC_BRIDGE_COS_SIZE_MISMATCH");
  assert.equal(sha256(expectedBytes), recordValue.sha256, "PUBLIC_BRIDGE_COS_HASH_MISMATCH");
  const downloaded = await safeFetch(recordValue.url, {
    maxBytes: Math.max(recordValue.size + 1024, 1 * 1024 * 1024),
    timeoutMs: 30_000,
    maxRedirects: 3,
    trustedHostnames,
  });
  assert.equal(downloaded.status, 200, "PUBLIC_BRIDGE_EXTERNAL_GET_NOT_200");
  assert.equal(downloaded.contentType, recordValue.content_type, "PUBLIC_BRIDGE_EXTERNAL_MIME_MISMATCH");
  assert.equal(downloaded.buffer.length, recordValue.size, "PUBLIC_BRIDGE_EXTERNAL_SIZE_MISMATCH");
  assert.equal(sha256(downloaded.buffer), recordValue.sha256, "PUBLIC_BRIDGE_EXTERNAL_HASH_MISMATCH");
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from("user_files")
    .select("id")
    .eq("user_id", userId)
    .eq("storage_provider", TARGET_PROVIDER)
    .eq("storage_key", recordValue.key)
    .eq("file_category", recordValue.category)
    .maybeSingle();
  if (error) throw error;
  assert.ok(data?.id, "PUBLIC_BRIDGE_OWNERSHIP_RECORD_MISSING");
}

async function publicInputBridge(
  assets: { images: OwnedAsset[]; audio: OwnedAsset },
  userId: string,
  userRef: string,
  runId: string,
  manifestPath: string,
): Promise<{ images: string[]; audio: string; records: PublicBridgeRecord[] }> {
  let manifest: PublicBridgeManifest;
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PublicBridgeManifest;
    assert.equal(manifest.schema, "autodl_hosted_h3_public_input_bridge.v1", "PUBLIC_BRIDGE_SCHEMA_MISMATCH");
    assert.equal(manifest.run_id, runId, "PUBLIC_BRIDGE_RUN_MISMATCH");
    assert.equal(manifest.user_ref, userRef, "PUBLIC_BRIDGE_OWNER_MISMATCH");
  } else {
    const sourceAssets = [assets.images[0]!, assets.images[1]!, assets.audio];
    const records: PublicBridgeRecord[] = [];
    for (let index = 0; index < sourceAssets.length; index += 1) {
      const source = sourceAssets[index]!;
      const bytes = await storageManager.read(source.storage_key, TARGET_PROVIDER);
      const validated = validateUploadBuffer(bytes, source.content_type);
      const category = source.file_category;
      const extension = validated.extension;
      const uploaded = await storageManager.upload(
        bytes,
        `${runId}-${category}-${index + 1}${extension}`,
        validated.contentType,
        {
          providerType: TARGET_PROVIDER,
          publicRead: true,
          category,
          userId,
          source: "acceptance",
          prefix: "autodl-hosted-h3-input-bridge/",
          fileName: `${runId}-${category}-${index + 1}${extension}`,
          requireOwnershipRecord: true,
          meta: { acceptance_run_id: runId, temporary_public_bridge: "true" },
        },
      );
      assert.equal(uploaded.provider, TARGET_PROVIDER, "PUBLIC_BRIDGE_PROVIDER_MISMATCH");
      assert.equal(uploaded.isPublic, true, "PUBLIC_BRIDGE_NOT_PUBLIC");
      assert.ok(uploaded.url, "PUBLIC_BRIDGE_URL_MISSING");
      records.push({
        category,
        key: uploaded.key,
        url: uploaded.url,
        content_type: validated.contentType,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    manifest = {
      schema: "autodl_hosted_h3_public_input_bridge.v1",
      run_id: runId,
      user_ref: userRef,
      created_at: new Date().toISOString(),
      records,
    };
    await atomicWriteJson(manifestPath, manifest);
  }
  assert.equal(manifest.records.length, 3, "PUBLIC_BRIDGE_OBJECT_COUNT_MISMATCH");
  assert.equal(manifest.records.filter((item) => item.category === "image").length, 2, "PUBLIC_BRIDGE_IMAGE_COUNT_MISMATCH");
  assert.equal(manifest.records.filter((item) => item.category === "audio").length, 1, "PUBLIC_BRIDGE_AUDIO_COUNT_MISMATCH");
  for (const bridgeRecord of manifest.records) await validatePublicBridgeRecord(bridgeRecord, userId);
  const imageRecords = manifest.records.filter((item) => item.category === "image");
  const audioRecord = manifest.records.find((item) => item.category === "audio");
  assert.ok(audioRecord);
  return { images: imageRecords.map((item) => item.url), audio: audioRecord.url, records: manifest.records };
}

async function waitForResult(config: VideoModelConfig, taskId: string, options: CliOptions) {
  const deadline = Date.now() + options.pollTimeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    const result = await pollVideoTask(config, taskId);
    pollCount += 1;
    if (result.status === "success") {
      assert.ok(result.videoUrl, "UPSTREAM_SUCCESS_WITHOUT_VIDEO_URL");
      return { videoUrl: result.videoUrl, pollCount };
    }
    if (result.status === "failed") throw new Error(`UPSTREAM_TASK_FAILED:${result.error || "unknown"}`);
    if (pollCount === 1 || pollCount % 3 === 0) {
      console.log(JSON.stringify({ event: "poll", task_id: taskId, poll_count: pollCount, status: result.status }));
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
  }
  throw new Error(`UPSTREAM_POLL_TIMEOUT:${taskId}`);
}

async function persistAndProbe(
  videoUrl: string,
  model: VideoModelRow,
  taskId: string,
  userId: string,
  runId: string,
  ffprobe: string,
): Promise<{ provider: StorageProviderType; key: string; size: number; probe: MediaProbe }> {
  const trustedHostname = trustedAutoDLResultHostname(videoUrl);
  const downloaded = await safeFetch(videoUrl, {
    maxBytes: 512 * 1024 * 1024,
    timeoutMs: 120_000,
    maxRedirects: 3,
    trustedHostnames: [trustedHostname],
    allowedContentTypes: ["video/mp4", "application/octet-stream"],
  });
  const declaredContentType = downloaded.contentType === "application/octet-stream"
    ? "video/mp4"
    : downloaded.contentType;
  const validated = validateUploadBuffer(downloaded.buffer, declaredContentType);
  assert.equal(validated.contentType, "video/mp4", `UPSTREAM_RESULT_NOT_MP4:${validated.contentType}`);
  const uploaded = await storageManager.upload(downloaded.buffer, `${runId}-${model.id}-${taskId}.mp4`, "video/mp4", {
    providerType: TARGET_PROVIDER,
    category: "video",
    prefix: "videos/generated/autodl-hosted-h3-acceptance/",
    fileName: `${runId}-${model.id}-${taskId}.mp4`,
    userId,
    source: "autodl-hosted-h3-acceptance",
    requireOwnershipRecord: true,
    meta: { acceptance_run_id: runId, model_id: model.id, upstream_task_id: taskId },
  });
  assert.equal(uploaded.provider, TARGET_PROVIDER, "PERSISTENCE_PROVIDER_MISMATCH");
  const db = getSupabaseAdminClient();
  const { data: ownerRecord, error } = await db
    .from("user_files")
    .select("id,user_id,storage_key,storage_provider,file_category,file_size")
    .eq("user_id", userId)
    .eq("storage_key", uploaded.key)
    .eq("storage_provider", TARGET_PROVIDER)
    .maybeSingle();
  if (error) throw error;
  assert.ok(ownerRecord?.id, "PERSISTED_OWNERSHIP_RECORD_MISSING");
  const bytes = await storageManager.read(uploaded.key, TARGET_PROVIDER);
  assert.equal(bytes.length, uploaded.size, "PERSISTED_OBJECT_SIZE_MISMATCH");
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "autodl-h3-acceptance-"));
  const tempFile = path.join(tempDir, `${model.id}.mp4`);
  try {
    await writeFile(tempFile, bytes);
    const probe = probeMp4(ffprobe, tempFile);
    return { provider: uploaded.provider, key: uploaded.key, size: bytes.length, probe };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function persistEvidenceAndActivate(
  initialModel: VideoModelRow,
  ledgerEntry: ModelLedger,
  runId: string,
): Promise<string> {
  const db = getSupabaseAdminClient();
  const { data: current, error: currentError } = await db
    .from("video_models")
    .select(MODEL_SELECT)
    .eq("id", initialModel.id)
    .single();
  if (currentError || !current) throw currentError || new Error("MODEL_REREAD_FAILED");
  const currentModel = current as VideoModelRow;
  assert.equal(currentModel.is_active, true, "MODEL_NO_LONGER_ACTIVE");
  assert.equal(currentModel.is_hidden, false, "MODEL_NO_LONGER_VISIBLE");
  assert.equal(
    videoActivationBindingSha256(currentModel),
    videoActivationBindingSha256(initialModel),
    "MODEL_BINDING_CHANGED_DURING_ACCEPTANCE",
  );
  const checkedAt = new Date().toISOString();
  const evidence = issueVideoModelAcceptanceEvidence(currentModel, {
    secretResolution: { evidenceRef: evidenceRef("secret", currentModel.id, runId), checkedAt },
    endpointConnectivity: { evidenceRef: evidenceRef("endpoint", currentModel.id, runId), checkedAt },
    protocolFixture: { evidenceRef: evidenceRef("fixture", currentModel.id, runId), checkedAt },
    canary: { evidenceRef: evidenceRef("canary", currentModel.id, runId), checkedAt },
    resultPersistence: { evidenceRef: evidenceRef("persistence", currentModel.id, runId), checkedAt },
  }, {
    evidenceId: `acceptance:${sha256(`${runId}:${currentModel.id}`).slice(0, 28)}`,
    issuedAt: checkedAt,
    issuedBy: "server:autodl-hosted-h3-acceptance.v1",
  });
  const nextConfig = persistVideoModelAcceptanceEvidence(currentModel.api_protocol_config, evidence);
  const evidenceUpdate = db
    .from("video_models")
    .update({ api_protocol_config: nextConfig })
    .eq("id", currentModel.id)
    .eq("is_active", false)
    .eq("is_hidden", true);
  const { data: evidenceReady, error: evidenceError } = await evidenceUpdate.select(MODEL_SELECT).maybeSingle();
  if (evidenceError || !evidenceReady) throw evidenceError || new Error("EVIDENCE_COMPARE_AND_SET_FAILED");
  const readiness = inspectVideoModelActivationReadiness(evidenceReady as VideoModelRow);
  assert.equal(readiness.ready, true, `EVIDENCE_NOT_READY:${readiness.reason}`);
  const evidenceId = assertVideoModelActivationReady(evidenceReady as VideoModelRow);
  const { data: activated, error: activationError } = await db
    .from("video_models")
    .update({ is_active: true, is_hidden: false })
    .eq("id", currentModel.id)
    .eq("is_active", false)
    .eq("is_hidden", true)
    .select("id,is_active,is_hidden,api_protocol_config")
    .maybeSingle();
  if (activationError || !activated) throw activationError || new Error("ACTIVATION_COMPARE_AND_SET_FAILED");
  assert.equal(activated.is_active, true);
  assert.equal(activated.is_hidden, false);
  assert.equal(ledgerEntry.state, "persisted");
  return evidenceId;
}

async function writeSanitizedEvidence(
  evidenceDir: string,
  model: VideoModelRow,
  ledger: ModelLedger,
  userRef: string,
): Promise<void> {
  await atomicWriteJson(path.join(evidenceDir, `${model.id}.json`), {
    schema: ACCEPTANCE_SCHEMA,
    model_id: model.id,
    workflow_id: model.model_name,
    protocol_type: model.protocol_type,
    secret_reference: model.api_key,
    token_exposed: false,
    user_ref: userRef,
    task_id: ledger.task_id,
    result_url_persisted: ledger.state === "persisted" || ledger.state === "activated",
    storage_provider: ledger.storage_provider,
    storage_key_sha256: ledger.storage_key ? sha256(ledger.storage_key) : undefined,
    storage_size: ledger.storage_size,
    media_probe: ledger.media_probe,
    evidence_id: ledger.evidence_id,
    state: ledger.state,
    error_code: ledger.error_code,
  });
}

async function archivePriorFailureEvidence(
  evidenceDir: string,
  model: VideoModelRow,
  ledger: ModelLedger,
): Promise<void> {
  if (ledger.state !== "failed" || !ledger.error_code) return;
  const currentPath = path.join(evidenceDir, `${model.id}.json`);
  if (!existsSync(currentPath)) return;
  const archiveName = `${model.id}-${sha256(`${ledger.task_id || "no-task"}:${ledger.error_code}`).slice(0, 16)}.json`;
  const archivePath = path.join(evidenceDir, "failures", archiveName);
  if (existsSync(archivePath)) return;
  const priorEvidence = JSON.parse(await readFile(currentPath, "utf8")) as JsonRecord;
  await atomicWriteJson(archivePath, priorEvidence);
}

async function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }
  const options = parseOptions();
  if (options.execute && !optionValue("run-id")) {
    throw new Error("EXECUTION_REQUIRES_EXPLICIT_RUN_ID: prevents accidental duplicate paid runs");
  }
  const models = await readModels();
  const userId = await selectOwner(options.userId);
  const userRef = sha256(userId).slice(0, 16);
  let ffprobe: string | null = null;
  let ffprobeBlocker = "";
  try {
    ffprobe = resolveFfprobe(options.ffprobePath);
  } catch (error) {
    if (options.execute) throw error;
    ffprobeBlocker = cleanError(error);
  }
  const assets = await ownedAssets(userId, ffprobe);
  const token = resolveProviderSecret(AUTODL_COMFYUI_SECRET_REF);
  assert.ok(token.length >= 8, "SECRET_RESOLUTION_FAILED");
  for (const spec of AUTODL_HOSTED_H3_WORKFLOWS) await readonlyMetadataCheck(spec);
  const tokenValid = await readonlyTokenProbe(token, options.runId);
  assert.equal(tokenValid, true, "COMFYUI_TOKEN_AUTH_PROBE_FAILED");
  const balanceSufficient = await platformBalanceSufficient(userId, expectedCostCny());
  assert.equal(balanceSufficient, true, "PLATFORM_BALANCE_PREFLIGHT_FAILED");

  const evidenceDir = path.join(".codex-evidence", "autodl-hosted-h3", options.runId);
  const ledgerPath = path.join(evidenceDir, "ledger.resume.json");
  const ledger = await loadOrCreateLedger(ledgerPath, options, userRef);
  const bridge = await publicInputBridge(
    assets,
    userId,
    userRef,
    options.runId,
    path.join(evidenceDir, "input-bridge.resume.json"),
  );
  const plan = {
    mode: options.execute ? "execute" : "prepare-only",
    run_id: options.runId,
    model_count: models.length,
    paid_generation_calls_planned: options.execute ? models.length : 0,
    sequential: true,
    submit_retries: 0,
    canary: `${CANARY_DURATION_SECONDS}s ${CANARY_RESOLUTION} ${CANARY_ASPECT_RATIO}`,
    maximum_estimated_cost_cny: expectedCostCny(),
    owned_cos_assets: { images: assets.images.length, audio: 1, user_ref: userRef },
    secret_resolved: true,
    token_valid: tokenValid,
    platform_balance_sufficient: balanceSufficient,
    upstream_balance_readonly_api_available: false,
    metadata_contracts_checked: AUTODL_HOSTED_H3_WORKFLOWS.length,
    public_input_bridge_verified: true,
    public_input_bridge_objects: bridge.records.length,
    public_input_urls_have_query: false,
    public_input_external_head_200: true,
    public_input_external_get_200: true,
    public_input_full_bytes_verified: true,
    public_input_ownership_persisted: true,
    ffprobe_ready: Boolean(ffprobe),
    ready_for_execute: Boolean(ffprobe),
    blockers: ffprobeBlocker ? [ffprobeBlocker] : [],
  };
  console.log(JSON.stringify({ event: "acceptance-plan", ...plan }, null, 2));
  await atomicWriteJson(path.join(evidenceDir, "prepare-only.json"), plan);
  if (!options.execute) return;
  assert.ok(ffprobe, "FFPROBE_REQUIRED_FOR_EXECUTION");

  const estimatedCost = expectedCostCny();
  assert.equal(options.confirmedCanaries, models.length, `PAID_CONFIRMATION_COUNT_MISMATCH: expected ${models.length}`);
  assert.ok(options.maxCostCny >= estimatedCost, `PAID_COST_CAP_TOO_LOW: expected at least ${estimatedCost.toFixed(2)}`);
  assert.ok(options.maxCostCny <= estimatedCost, `PAID_COST_CAP_TOO_HIGH: exact cap ${estimatedCost.toFixed(2)} is required`);
  const urls = { images: bridge.images, audio: bridge.audio };

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]!;
    const spec = AUTODL_HOSTED_H3_WORKFLOWS[index]!;
    const entry = ledger.models[index]!;
    assert.equal(entry.model_id, model.id, "LEDGER_MODEL_ORDER_MISMATCH");
    await archivePriorFailureEvidence(evidenceDir, model, entry);
    if (entry.state === "activated") {
      console.log(JSON.stringify({ event: "resume-skip-activated", model_id: model.id }));
      continue;
    }
    if (entry.state === "submit_intent" && !entry.task_id) {
      throw new Error(`AMBIGUOUS_PRIOR_SUBMISSION_NO_RETRY:${model.id}`);
    }
    const config = modelConfig(model, token);
    try {
      let taskId = safeString(entry.task_id);
      if (!taskId) {
        entry.state = "submit_intent";
        entry.submitted_at = new Date().toISOString();
        await atomicWriteJson(ledgerPath, ledger);
        console.log(JSON.stringify({ event: "submit-once", sequence: index + 1, total: models.length, model_id: model.id, workflow_id: spec.workflowId }));
        const submitted = await submitVideoTask(config, canaryParams(spec, urls.images, urls.audio));
        if (submitted.status === "failed" || !submitted.taskId) {
          entry.state = "failed";
          entry.error_code = `SUBMIT_FAILED:${cleanError(submitted.error || "missing task id")}`;
          await atomicWriteJson(ledgerPath, ledger);
          await writeSanitizedEvidence(evidenceDir, model, entry, userRef);
          throw new Error(entry.error_code);
        }
        taskId = submitted.taskId;
        entry.task_id = taskId;
        entry.state = "submitted";
        await atomicWriteJson(ledgerPath, ledger);
      }

      const { videoUrl, pollCount } = await waitForResult(config, taskId, options);
      entry.state = "upstream_success";
      entry.completed_at = new Date().toISOString();
      delete entry.error_code;
      await atomicWriteJson(ledgerPath, ledger);
      console.log(JSON.stringify({ event: "upstream-success", model_id: model.id, task_id: taskId, poll_count: pollCount }));

      const persisted = await persistAndProbe(videoUrl, model, taskId, userId, options.runId, ffprobe);
      entry.state = "persisted";
      entry.persisted_at = new Date().toISOString();
      entry.storage_provider = persisted.provider;
      entry.storage_key = persisted.key;
      entry.storage_size = persisted.size;
      entry.media_probe = persisted.probe;
      await atomicWriteJson(ledgerPath, ledger);

      entry.evidence_id = await persistEvidenceAndActivate(model, entry, options.runId);
      entry.state = "activated";
      await atomicWriteJson(ledgerPath, ledger);
      await writeSanitizedEvidence(evidenceDir, model, entry, userRef);
      console.log(JSON.stringify({
        event: "model-accepted-and-activated",
        model_id: model.id,
        task_id: taskId,
        media: persisted.probe,
        stable_storage: true,
      }));
    } catch (error) {
      if (entry.state !== "failed" && entry.state !== "activated") {
        entry.state = "failed";
        entry.error_code = cleanError(error);
        await atomicWriteJson(ledgerPath, ledger);
        await writeSanitizedEvidence(evidenceDir, model, entry, userRef);
      }
      console.error(JSON.stringify({ event: "acceptance-stopped", model_id: model.id, error: cleanError(error), later_models_submitted: 0 }));
      throw error;
    }
  }

  const allActivated = ledger.models.every((entry) => entry.state === "activated");
  assert.equal(allActivated, true, "NOT_ALL_MODELS_ACTIVATED");
  await atomicWriteJson(path.join(evidenceDir, "summary.json"), {
    schema: ACCEPTANCE_SCHEMA,
    run_id: options.runId,
    completed_at: new Date().toISOString(),
    paid_generation_calls: ledger.models.length,
    submit_retries: 0,
    all_models_activated: true,
    models: ledger.models.map((entry) => ({
      model_id: entry.model_id,
      workflow_id: entry.workflow_id,
      task_id: entry.task_id,
      state: entry.state,
      media_probe: entry.media_probe,
      storage_provider: entry.storage_provider,
      storage_key_sha256: entry.storage_key ? sha256(entry.storage_key) : undefined,
      evidence_id: entry.evidence_id,
    })),
  });
  console.log(JSON.stringify({ event: "acceptance-complete", run_id: options.runId, models_activated: models.length, paid_generation_calls: models.length }));
}

void main().catch((error) => {
  console.error(JSON.stringify({
    event: "acceptance-failed",
    message: cleanError(error),
    no_automatic_submit_retry: true,
  }));
  process.exitCode = 1;
});
