import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
  forceNewVideoModelPending,
  isActivationGatedVideoConfig,
} from "../src/lib/model-activation-gate";

type JsonRecord = Record<string, unknown>;
type VideoModelRecord = JsonRecord & {
  id: string;
  name: string;
  model_name: string;
  provider: string;
  protocol_type: string;
  api_endpoint: string;
  api_key: string;
  price_per_use: number;
  cost_price: number;
  currency: "CNY";
  duration_seconds: number;
  max_duration: number;
  supports_image_input: boolean;
  requires_image: boolean;
  is_active: boolean;
  is_hidden: boolean;
  sort_order: number;
  admin_notes: string;
  api_protocol_config: JsonRecord;
};

const APPLY = process.argv.includes("--apply");
const MIGRATE_EXISTING = process.argv.includes("--migrate-existing-secret-refs");
const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const ENDPOINT = "https://token.secure-skill.com";

const EXISTING_SECRET_REFS: Record<string, string> = {
  "omni-video-edit-chA": "secret://secure-skill-flow-omni-video-edit",
  "grok-imagine-video-1-5-fast-chA": "secret://secure-skill-grok-video",
  "grok-imagine-video-1-5-preview-chA": "secret://secure-skill-grok-video-1-5-preview",
};

function protocolConfig(input: JsonRecord): JsonRecord {
  return {
    submit_path: input.submit_path,
    poll_path: input.poll_path,
    duration_options: input.duration_options,
    min_duration: input.min_duration,
    max_duration: input.max_duration,
    min_submit_duration: input.min_submit_duration,
    duration_step: input.duration_step,
    resolution_options: input.resolution_options,
    default_resolution: input.default_resolution,
    resolution_prices: input.resolution_prices,
    resolution_cost_prices: input.resolution_cost_prices,
    aspect_ratios: input.aspect_ratios,
    workflow_input_mode: input.workflow_input_mode,
    supports_prompt: input.supports_prompt ?? true,
    required_reference_images: input.required_reference_images ?? 0,
    max_reference_images: input.max_reference_images ?? 0,
    requires_first_frame: input.requires_first_frame ?? false,
    requires_last_frame: input.requires_last_frame ?? false,
    supports_audio_input: input.supports_audio_input ?? false,
    required_reference_audios: input.required_reference_audios ?? 0,
    max_reference_audios: input.max_reference_audios ?? 0,
    supports_source_video_input: input.supports_source_video_input ?? false,
    requires_source_video: input.requires_source_video ?? false,
    billing_unit: input.billing_unit,
    workspace_surfaces: ["video-page", "storyboard-workbench"],
    supports_remote_cancel: false,
    provider_channel: input.provider_channel,
    supplier_pricing_note: input.supplier_pricing_note,
  };
}

function row(input: {
  id: string;
  name: string;
  modelName: string;
  protocol: "secure_skill_flow_jobs" | "secure_skill_video" | "secure_skill_wan3_video";
  secretRef: string;
  cost: number;
  price: number;
  duration: number;
  maxDuration: number;
  sortOrder: number;
  image: boolean;
  requiresImage: boolean;
  notes: string;
  config: JsonRecord;
}): VideoModelRecord {
  return {
    id: input.id,
    name: input.name,
    model_name: input.modelName,
    provider: input.protocol,
    protocol_type: input.protocol,
    api_endpoint: ENDPOINT,
    api_key: input.secretRef,
    price_per_use: input.price,
    cost_price: input.cost,
    currency: "CNY",
    duration_seconds: input.duration,
    max_duration: input.maxDuration,
    supports_image_input: input.image,
    requires_image: input.requiresImage,
    is_active: false,
    is_hidden: true,
    sort_order: input.sortOrder,
    admin_notes: input.notes,
    api_protocol_config: protocolConfig(input.config),
  };
}

const FLOW_BASE = {
  submit_path: "/v1/jobs",
  poll_path: "/v1/jobs/{id}",
  resolution_options: ["720p"],
  default_resolution: "720p",
  aspect_ratios: ["16:9", "9:16"],
  supports_audio_input: false,
  max_reference_audios: 0,
  billing_unit: "per_use",
  provider_channel: "secure-skill:flow:14",
};

const MODELS: VideoModelRecord[] = [
  row({
    id: "secure-skill-flow-omni-ch14",
    name: "Omni · 4-10秒 · 720P · Secure Skill Flow 14",
    modelName: "omni",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-omni",
    cost: 0.63,
    price: 0.756,
    duration: 4,
    maxDuration: 10,
    sortOrder: 4140,
    image: true,
    requiresImage: false,
    notes: "供应商成本 ¥0.63/次；独立 Flow 14 渠道。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [4, 6, 8, 10],
      min_duration: 4,
      max_duration: 10,
      min_submit_duration: 4,
      duration_step: 2,
      workflow_input_mode: "multi_image",
      required_reference_images: 0,
      max_reference_images: 5,
      supplier_pricing_note: "¥0.63/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-i2v-lite-ch14",
    name: "VEO 3.1 图生视频 Lite · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_i2v_lite",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-i2v-lite",
    cost: 0.5,
    price: 0.6,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4141,
    image: true,
    requiresImage: true,
    notes: "供应商成本 ¥0.50/次；固定 8 秒、720P、单首帧。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "multi_image", required_reference_images: 1, max_reference_images: 1,
      requires_first_frame: true, supplier_pricing_note: "¥0.50/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-i2v-fast-ch14",
    name: "VEO 3.1 图生视频 Fast · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_i2v_s_fast_fl",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-i2v-fast",
    cost: 0.6,
    price: 0.72,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4142,
    image: true,
    requiresImage: true,
    notes: "供应商成本 ¥0.60/次；固定 8 秒、720P、单首帧。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "multi_image", required_reference_images: 1, max_reference_images: 1,
      requires_first_frame: true, supplier_pricing_note: "¥0.60/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-interpolation-lite-ch14",
    name: "VEO 3.1 首尾帧 Lite · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_interpolation_lite",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-interpolation-lite",
    cost: 0.5,
    price: 0.6,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4143,
    image: true,
    requiresImage: true,
    notes: "供应商成本 ¥0.50/次；固定 8 秒、720P、必须首尾两帧。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "first_last_frame", required_reference_images: 2, max_reference_images: 2,
      requires_first_frame: true, requires_last_frame: true, supplier_pricing_note: "¥0.50/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-r2v-fast-ch14",
    name: "VEO 3.1 多参考 Fast · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_r2v_fast",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-r2v-fast",
    cost: 0.6,
    price: 0.72,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4144,
    image: true,
    requiresImage: true,
    notes: "供应商成本 ¥0.60/次；固定 8 秒、720P、1-5 张参考图。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "multi_image", required_reference_images: 1, max_reference_images: 5,
      supplier_pricing_note: "¥0.60/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-t2v-fast-ch14",
    name: "VEO 3.1 文生视频 Fast · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_t2v_fast",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-t2v-fast",
    cost: 0.6,
    price: 0.72,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4145,
    image: false,
    requiresImage: false,
    notes: "供应商成本 ¥0.60/次；固定 8 秒、720P、纯文本输入。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "text", required_reference_images: 0, max_reference_images: 0,
      supplier_pricing_note: "¥0.60/request",
    },
  }),
  row({
    id: "secure-skill-flow-veo-3-1-t2v-lite-ch14",
    name: "VEO 3.1 文生视频 Lite · 8秒 · 720P · Secure Skill Flow 14",
    modelName: "veo_3_1_t2v_lite",
    protocol: "secure_skill_flow_jobs",
    secretRef: "secret://secure-skill-flow-veo-t2v-lite",
    cost: 0.5,
    price: 0.6,
    duration: 8,
    maxDuration: 8,
    sortOrder: 4146,
    image: false,
    requiresImage: false,
    notes: "供应商成本 ¥0.50/次；固定 8 秒、720P、纯文本输入。真实生成通过前保持隐藏。",
    config: {
      ...FLOW_BASE,
      duration_options: [8], min_duration: 8, max_duration: 8, min_submit_duration: 8, duration_step: 1,
      workflow_input_mode: "text", required_reference_images: 0, max_reference_images: 0,
      supplier_pricing_note: "¥0.50/request",
    },
  }),
  row({
    id: "secure-skill-minimax-h3-ecommerce-ch36",
    name: "MiniMax H3 电商优化 · 4-15秒 · 720P · Secure Skill 36",
    modelName: "minimax-h3",
    protocol: "secure_skill_video",
    secretRef: "secret://secure-skill-minimax-h3-ecommerce",
    cost: 0.08,
    price: 0.096,
    duration: 5,
    maxDuration: 15,
    sortOrder: 4360,
    image: true,
    requiresImage: false,
    notes: "供应商成本 ¥0.08/输出秒；独立电商优化 36 渠道。真实生成通过前保持隐藏。",
    config: {
      submit_path: "/v1/videos", poll_path: "/v1/videos/{id}",
      duration_options: Array.from({ length: 12 }, (_, index) => index + 4),
      min_duration: 4, max_duration: 15, min_submit_duration: 4, duration_step: 1,
      resolution_options: ["720p"], default_resolution: "720p",
      resolution_prices: { "720p": 0.096 }, resolution_cost_prices: { "720p": 0.08 },
      aspect_ratios: ["16:9", "9:16"], workflow_input_mode: "multi_image_audio",
      required_reference_images: 0, max_reference_images: 9,
      supports_audio_input: true, required_reference_audios: 0, max_reference_audios: 3,
      billing_unit: "output_second", provider_channel: "secure-skill:minimax-h3:36",
      supplier_pricing_note: "¥0.08/output-second",
    },
  }),
  row({
    id: "secure-skill-wan3-video-ch40",
    name: "Wan 3.0 Video · 2-30秒 · 720P/1080P · Secure Skill 40",
    modelName: "wan3.0-video",
    protocol: "secure_skill_wan3_video",
    secretRef: "secret://secure-skill-wan3-video",
    cost: 0.19,
    price: 0.228,
    duration: 5,
    maxDuration: 30,
    sortOrder: 4400,
    image: true,
    requiresImage: false,
    notes: "供应商成本 720P ¥0.19/输出秒、1080P ¥0.35/输出秒；独立 40 渠道。真实生成通过前保持隐藏。",
    config: {
      submit_path: "/v1/videos/generations", poll_path: "/v1/videos/tasks/{id}",
      duration_options: Array.from({ length: 29 }, (_, index) => index + 2),
      min_duration: 2, max_duration: 30, min_submit_duration: 2, duration_step: 1,
      resolution_options: ["480p", "720p", "1080p"], default_resolution: "480p",
      resolution_prices: { "480p": 0.228, "720p": 0.228, "1080p": 0.42 },
      resolution_cost_prices: { "480p": 0.19, "720p": 0.19, "1080p": 0.35 },
      aspect_ratios: ["16:9", "9:16"], workflow_input_mode: "multi_image_audio",
      required_reference_images: 0, max_reference_images: 10,
      supports_audio_input: true, required_reference_audios: 0, max_reference_audios: 5,
      supports_source_video_input: true,
      billing_unit: "output_second", provider_channel: "secure-skill:wan3:40",
      supplier_pricing_note: "720p ¥0.19/s; 1080p ¥0.35/s",
    },
  }),
  row({
    id: "secure-skill-wan3-video-prime-ch40",
    name: "Wan 3.0 Video Prime · 2-30秒 · 720P/1080P · Secure Skill 40",
    modelName: "wan3.0-video-prime",
    protocol: "secure_skill_wan3_video",
    secretRef: "secret://secure-skill-wan3-video-prime",
    cost: 0.25,
    price: 0.3,
    duration: 5,
    maxDuration: 30,
    sortOrder: 4401,
    image: true,
    requiresImage: false,
    notes: "供应商成本 720P ¥0.30/输出秒、1080P ¥0.40/输出秒；独立 40 渠道。真实生成通过前保持隐藏。",
    config: {
      submit_path: "/v1/videos/generations", poll_path: "/v1/videos/tasks/{id}",
      duration_options: Array.from({ length: 29 }, (_, index) => index + 2),
      min_duration: 2, max_duration: 30, min_submit_duration: 2, duration_step: 1,
      resolution_options: ["480p", "720p", "1080p"], default_resolution: "480p",
      resolution_prices: { "480p": 0.3, "720p": 0.36, "1080p": 0.48 },
      resolution_cost_prices: { "480p": 0.25, "720p": 0.3, "1080p": 0.4 },
      aspect_ratios: ["16:9", "9:16"], workflow_input_mode: "multi_image_audio",
      required_reference_images: 0, max_reference_images: 10,
      supports_audio_input: true, required_reference_audios: 0, max_reference_audios: 5,
      supports_source_video_input: true,
      billing_unit: "output_second", provider_channel: "secure-skill:wan3:40",
      supplier_pricing_note: "720p ¥0.30/s; 1080p ¥0.40/s",
    },
  }),
];

const TARGET_IDS = new Set(MODELS.map((model) => model.id));
const SAFE_FIELDS = [
  "id", "name", "model_name", "provider", "protocol_type", "api_endpoint",
  "price_per_use", "cost_price", "currency", "duration_seconds", "max_duration",
  "supports_image_input", "requires_image", "is_active", "is_hidden", "sort_order",
  "admin_notes", "api_protocol_config",
].join(",");

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function credentialFingerprint(value: unknown): string {
  const text = String(value || "");
  return text ? createHash("sha256").update(text).digest("hex") : "";
}

async function main() {
  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  assert.equal(runtime.localOnly, true, "catalog writes are allowed only against the isolated local runtime");
  const runtimeUrl = new URL(String(runtime.supabaseUrl || ""));
  assert.equal(runtimeUrl.hostname, "127.0.0.1", "catalog writes must stay on localhost");
  const serviceRoleKey = String(runtime.serviceRoleKey || "");
  assert.ok(serviceRoleKey, "local runtime service-role key is missing");

  const db = createClient(runtimeUrl.toString().replace(/\/$/u, ""), serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: allBefore, error: beforeError } = await db.from("video_models").select(`*,api_key`).order("id");
  if (beforeError) throw beforeError;
  const beforeRows = (allBefore || []) as VideoModelRecord[];
  const newTargetBefore = beforeRows.filter((entry) => TARGET_IDS.has(entry.id));
  const existingTargetBefore = beforeRows.filter((entry) => Object.hasOwn(EXISTING_SECRET_REFS, entry.id));
  const unaffectedBefore = beforeRows.filter((entry) => !TARGET_IDS.has(entry.id) && !Object.hasOwn(EXISTING_SECRET_REFS, entry.id));
  const persisted = new Map(newTargetBefore.map((entry) => [entry.id, entry]));
  const prepared = MODELS.map((model) => persisted.has(model.id)
    ? { ...forceNewVideoModelPending(model), api_protocol_config: forceNewVideoModelPending(model).api_protocol_config }
    : forceNewVideoModelPending(model));

  const safeExisting = existingTargetBefore.map(({ api_key, ...entry }) => ({
    ...entry,
    credential_configured: Boolean(String(api_key || "").trim()),
    credential_sha256: credentialFingerprint(api_key),
  }));
  const safeNew = newTargetBefore.map(({ api_key, ...entry }) => ({
    ...entry,
    credential_configured: Boolean(String(api_key || "").trim()),
    credential_sha256: credentialFingerprint(api_key),
  }));
  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `secure-skill-video-catalog-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "targets.before.sanitized.json"), `${JSON.stringify({ newTargets: safeNew, existingTargets: safeExisting }, null, 2)}\n`);
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "secure_skill_video_catalog_backup.v1",
    created_at: new Date().toISOString(),
    runtime_local_only: true,
    target_ids: [...TARGET_IDS],
    existing_secret_ref_targets: Object.keys(EXISTING_SECRET_REFS),
    credentials_in_backup: false,
    paid_generation_calls: 0,
    apply_requested: APPLY,
    migrate_existing_secret_refs_requested: MIGRATE_EXISTING,
  }, null, 2)}\n`);

  if (!APPLY) {
    console.log(JSON.stringify({ mode: "dry-run", backupDir, newModels: prepared.map(({ api_key: _key, ...model }) => model), migrateExistingSecretRefs: MIGRATE_EXISTING }, null, 2));
    return;
  }

  const upsert = await db.from("video_models").upsert(prepared, { onConflict: "id" });
  if (upsert.error) throw upsert.error;
  if (MIGRATE_EXISTING) {
    for (const [id, secretRef] of Object.entries(EXISTING_SECRET_REFS)) {
      const update = await db.from("video_models").update({ api_key: secretRef }).eq("id", id);
      if (update.error) throw update.error;
    }
  }

  const { data: allAfter, error: afterError } = await db.from("video_models").select(`*,api_key`).order("id");
  if (afterError) throw afterError;
  const afterRows = (allAfter || []) as VideoModelRecord[];
  const newTargetAfter = afterRows.filter((entry) => TARGET_IDS.has(entry.id));
  const unaffectedAfter = afterRows.filter((entry) => !TARGET_IDS.has(entry.id) && !Object.hasOwn(EXISTING_SECRET_REFS, entry.id));
  assert.equal(newTargetAfter.length, MODELS.length, "every dedicated Secure Skill channel row must exist");
  assert.equal(stable(unaffectedAfter), stable(unaffectedBefore), "a non-target video model changed");
  for (const model of newTargetAfter) {
    assert.equal(model.is_active, false, `${model.id} must remain inactive until real canary acceptance`);
    assert.equal(model.is_hidden, true, `${model.id} must remain hidden until real canary acceptance`);
    assert.equal(isActivationGatedVideoConfig(model.api_protocol_config), true, `${model.id} must retain the activation gate`);
    assert.match(String(model.api_key || ""), /^secret:\/\/secure-skill-/u, `${model.id} must store only a secret reference`);
  }
  if (MIGRATE_EXISTING) {
    for (const [id, secretRef] of Object.entries(EXISTING_SECRET_REFS)) {
      assert.equal(afterRows.find((entry) => entry.id === id)?.api_key, secretRef, `${id} secret reference migration failed`);
    }
  }

  console.log(JSON.stringify({
    mode: "applied",
    backupDir,
    database: "local-only",
    insertedOrUpdatedHiddenModels: newTargetAfter.map((model) => model.id).sort(),
    migratedExistingSecretRefs: MIGRATE_EXISTING ? Object.keys(EXISTING_SECRET_REFS) : [],
    nonTargetModelsUnchanged: true,
    paidGenerationCalls: 0,
  }, null, 2));
}

void main().catch((error) => {
  const candidate = error && typeof error === "object" ? error as JsonRecord : {};
  console.error(JSON.stringify({
    name: String(candidate.name || "Error"),
    message: String(candidate.message || error || "Secure Skill catalog configuration failed"),
    code: String(candidate.code || ""),
    paidGenerationCalls: 0,
  }));
  process.exitCode = 1;
});
