import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { forceNewVideoModelPending } from "../src/lib/model-activation-gate";
import { resolveProviderSecret } from "../src/lib/provider-secret";

type JsonRecord = Record<string, unknown>;
export type VideoModelRecord = JsonRecord & {
  id: string;
  api_key: string;
  api_protocol_config: JsonRecord;
  is_active: boolean;
  is_hidden: boolean;
};

const RUNTIME_CONFIG = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const GAORUI_ENDPOINT = "https://gaorui.cc/v1";
const SECURE_SKILL_ENDPOINT = "https://token.secure-skill.com/v1";
const GATE_KEY = "__model_activation_gate";
// 视频售价只能来自逐模型运营价格表。这里保留历史候选的显式金额，
// 不再从成本按百分比推导；隐藏候选仍需在开放前复核最新价格表。
const EXPLICIT_VIDEO_SALE = {
  gaoruiCandidate: 1.2,
  secureSkillBackupCandidate: 1.8,
  existingGrokFast: 0.6,
} as const;

export const NEW_MODEL_IDS = [
  "grok-imagine-1-0-video-gaorui",
  "grok-imagine-video-1-5-gaorui",
  "grok-imagine-video-secure-backup-chA",
] as const;

export const EXISTING_PRICE_IDS = [
  "grok-imagine-video-1-5-fast-chA",
  "grok-imagine-video-1-5-preview-chA",
] as const;

export const VEO_COMPONENTS_ID = "veo-3-1-components-gaorui";
export const TARGET_IDS = new Set<string>([
  ...NEW_MODEL_IDS,
  ...EXISTING_PRICE_IDS,
  VEO_COMPONENTS_ID,
]);

const SECRET_REFERENCES = {
  "grok-imagine-1-0-video-gaorui": "secret://gaorui-grok-imagine-1-0-video",
  "grok-imagine-video-1-5-gaorui": "secret://gaorui-grok-imagine-video-1-5",
  "grok-imagine-video-secure-backup-chA": "secret://secure-skill-grok-video-backup",
} as const;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function notes(current: unknown, marker: string): string {
  const value = String(current || "").trim();
  return value.includes(marker) ? value : [value, marker].filter(Boolean).join("\n");
}

function gaoruiConfig(input: {
  channel: string;
  durations: number[];
  resolutions: string[];
  maxImages: number;
}): JsonRecord {
  return {
    submit_path: "/v1/videos",
    poll_path: "/v1/videos/{id}",
    duration_options: input.durations,
    min_duration: input.durations[0],
    max_duration: input.durations.at(-1),
    resolution_options: input.resolutions,
    default_resolution: input.resolutions.at(-1),
    aspect_ratios: ["16:9", "9:16", "1:1"],
    workflow_input_mode: "multi_image",
    supports_prompt: true,
    required_reference_images: 0,
    min_reference_images: 0,
    max_reference_images: input.maxImages,
    supports_audio_input: false,
    supports_source_video_input: false,
    billing_unit: "per_use",
    workspace_surfaces: ["video-page", "storyboard-workbench"],
    provider_channel: input.channel,
    credential_scope: "dedicated_model_key",
    supports_remote_cancel: false,
  };
}

function newRows(): VideoModelRecord[] {
  const gaoruiCost = 1;
  const secureBackupCost = 1.5;
  return [
    {
      id: "grok-imagine-1-0-video-gaorui",
      name: "Grok Imagine 1.0 Video · 高端渠道",
      model_name: "grok-imagine-1.0-video",
      provider: "gaorui_video",
      protocol_type: "gaorui_video",
      api_endpoint: GAORUI_ENDPOINT,
      api_key: SECRET_REFERENCES["grok-imagine-1-0-video-gaorui"],
      price_per_use: EXPLICIT_VIDEO_SALE.gaoruiCandidate,
      cost_price: gaoruiCost,
      currency: "CNY",
      duration_seconds: 10,
      max_duration: 15,
      supports_image_input: true,
      requires_image: false,
      is_active: false,
      is_hidden: true,
      sort_order: 20,
      admin_notes: "高瑞独立模型密钥；6/10/15 秒、720P，支持文生、单图及多图。真实 canary 与结果持久化通过前保持隐藏。",
      api_protocol_config: gaoruiConfig({
        channel: "gaorui:grok-imagine-1.0-video",
        durations: [6, 10, 15],
        resolutions: ["720p"],
        maxImages: 9,
      }),
    },
    {
      id: "grok-imagine-video-1-5-gaorui",
      name: "Grok Imagine Video 1.5 · 高端渠道",
      model_name: "grok-imagine-video-1.5",
      provider: "gaorui_video",
      protocol_type: "gaorui_video",
      api_endpoint: GAORUI_ENDPOINT,
      api_key: SECRET_REFERENCES["grok-imagine-video-1-5-gaorui"],
      price_per_use: EXPLICIT_VIDEO_SALE.gaoruiCandidate,
      cost_price: gaoruiCost,
      currency: "CNY",
      duration_seconds: 10,
      max_duration: 15,
      supports_image_input: true,
      requires_image: false,
      is_active: false,
      is_hidden: true,
      sort_order: 21,
      admin_notes: "高瑞独立模型密钥；6/8/10/12/15 秒、480P/720P，支持文生及最多 5 张参考图。真实 canary 与结果持久化通过前保持隐藏。",
      api_protocol_config: gaoruiConfig({
        channel: "gaorui:grok-imagine-video-1.5",
        durations: [6, 8, 10, 12, 15],
        resolutions: ["480p", "720p"],
        maxImages: 5,
      }),
    },
    {
      id: "grok-imagine-video-secure-backup-chA",
      name: "Grok Imagine Video · 渠道A备用组",
      model_name: "grok-imagine-video",
      provider: "secure_skill_A_backup",
      protocol_type: "secure_skill_grok_video",
      api_endpoint: SECURE_SKILL_ENDPOINT,
      api_key: SECRET_REFERENCES["grok-imagine-video-secure-backup-chA"],
      price_per_use: EXPLICIT_VIDEO_SALE.secureSkillBackupCandidate,
      cost_price: secureBackupCost,
      currency: "CNY",
      duration_seconds: 10,
      max_duration: 15,
      supports_image_input: true,
      requires_image: false,
      is_active: false,
      is_hidden: true,
      sort_order: 22,
      admin_notes: "Secure Skill Grok 备用分组独立密钥；不复用特价组或其他模型密钥。真实 canary 与结果持久化通过前保持隐藏。",
      api_protocol_config: {
        submit_path: "/openai/v1/videos",
        poll_path: "/openai/v1/videos/{id}",
        duration_options: [6, 10, 15],
        min_duration: 6,
        max_duration: 15,
        resolution_options: ["720p"],
        default_resolution: "720p",
        aspect_ratios: ["16:9", "9:16", "1:1"],
        workflow_input_mode: "multi_image",
        supports_prompt: true,
        required_reference_images: 0,
        max_reference_images: 5,
        billing_unit: "per_use",
        workspace_surfaces: ["video-page", "storyboard-workbench"],
        provider_channel: "secure-skill:grok-backup",
        credential_scope: "dedicated_model_key",
        supports_remote_cancel: false,
      },
    },
  ];
}

function updateExistingPrice(row: VideoModelRecord): VideoModelRecord {
  return {
    ...row,
    cost_price: 0.48,
    price_per_use: EXPLICIT_VIDEO_SALE.existingGrokFast,
    admin_notes: notes(row.admin_notes, "供应商成本 ¥0.48/次；运营价格表显式售价 ¥0.60/次。"),
  };
}

function updateVeoComponents(row: VideoModelRecord): VideoModelRecord {
  const currentConfig = record(row.api_protocol_config);
  return {
    ...row,
    cost_price: 0.55,
    price_per_use: 0.66,
    is_active: false,
    is_hidden: true,
    admin_notes: notes(row.admin_notes, "新增 lite/720P/1080P 分档后需重新完成真实 canary；旧验收证据仅保留审计，不代表新配置通过。"),
    api_protocol_config: {
      ...currentConfig,
      resolution: "720p",
      resolution_options: ["lite", "720p", "1080p"],
      default_resolution: "720p",
      resolution_cost_prices: { lite: 0.3, "720p": 0.55, "1080p": 0.65 },
      resolution_prices: { lite: 0.36, "720p": 0.66, "1080p": 0.78 },
      [GATE_KEY]: currentConfig[GATE_KEY],
    },
  };
}

function mergeNewModel(existing: VideoModelRecord | undefined, desired: VideoModelRecord): VideoModelRecord {
  if (!existing) return forceNewVideoModelPending(desired);
  const existingConfig = record(existing.api_protocol_config);
  const currentGate = existingConfig[GATE_KEY];
  const existingBindingConfig = { ...existingConfig };
  delete existingBindingConfig[GATE_KEY];
  const desiredConfig = { ...desired.api_protocol_config, ...(currentGate ? { [GATE_KEY]: currentGate } : {}) };
  const bindingChanged = stable({
    model_name: existing.model_name,
    provider: existing.provider,
    protocol_type: existing.protocol_type,
    api_endpoint: existing.api_endpoint,
    api_key: existing.api_key,
    api_protocol_config: existingBindingConfig,
  }) !== stable({
    model_name: desired.model_name,
    provider: desired.provider,
    protocol_type: desired.protocol_type,
    api_endpoint: desired.api_endpoint,
    api_key: desired.api_key,
    api_protocol_config: desired.api_protocol_config,
  });
  return {
    ...existing,
    ...desired,
    // Once a model has passed the server acceptance gate, an idempotent rerun
    // must not hide or deactivate it again.
    is_active: bindingChanged ? false : existing.is_active,
    is_hidden: bindingChanged ? true : existing.is_hidden,
    api_protocol_config: desiredConfig,
  };
}

export type OnboardingPlan = {
  before: VideoModelRecord[];
  after: VideoModelRecord[];
  changedIds: string[];
  missingExistingIds: string[];
};

export function buildPriorityVideoModelPlan(rows: VideoModelRecord[]): OnboardingPlan {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missingExistingIds = [...EXISTING_PRICE_IDS, VEO_COMPONENTS_ID].filter((id) => !byId.has(id));
  const afterById = new Map(byId);

  for (const desired of newRows()) {
    afterById.set(desired.id, mergeNewModel(byId.get(desired.id), desired));
  }
  for (const id of EXISTING_PRICE_IDS) {
    const current = byId.get(id);
    if (current) afterById.set(id, updateExistingPrice(current));
  }
  const veo = byId.get(VEO_COMPONENTS_ID);
  if (veo) afterById.set(VEO_COMPONENTS_ID, updateVeoComponents(veo));

  const after = [...afterById.values()];
  const changedIds = [...TARGET_IDS]
    .filter((id) => stable(byId.get(id)) !== stable(afterById.get(id)))
    .sort();
  return { before: rows, after, changedIds, missingExistingIds };
}

function sanitize(row: VideoModelRecord) {
  const { api_key, api_protocol_config, ...safe } = row;
  const config = record(api_protocol_config);
  const { [GATE_KEY]: gate, ...safeConfig } = config;
  return {
    ...safe,
    credential_reference_sha256: createHash("sha256").update(String(api_key || "")).digest("hex"),
    credential_configured: Boolean(String(api_key || "").trim()),
    api_protocol_config: safeConfig,
    activation_gate_state: record(gate).state || null,
  };
}

function persistedTargetShape(actual: VideoModelRecord | undefined, target: VideoModelRecord) {
  if (!actual) return undefined;
  return Object.fromEntries(Object.keys(target).map((key) => [key, actual[key]]));
}

function assertDedicatedCredentialsReady() {
  for (const reference of Object.values(SECRET_REFERENCES)) {
    const secret = resolveProviderSecret(reference);
    assert.ok(secret.trim().length >= 8, "Dedicated provider credential is unresolved");
  }
}

function assertPlan(plan: OnboardingPlan) {
  assert.deepEqual(plan.missingExistingIds, [], `Required existing models are missing: ${plan.missingExistingIds.join(", ")}`);
  const after = new Map(plan.after.map((row) => [row.id, row]));
  for (const id of NEW_MODEL_IDS) {
    const row = after.get(id);
    assert.ok(row, `${id} must exist in the plan`);
    const original = plan.before.find((entry) => entry.id === id);
    if (!original) {
      assert.equal(row.is_active, false, `${id} must start inactive`);
      assert.equal(row.is_hidden, true, `${id} must start hidden`);
      assert.equal(record(row.api_protocol_config)[GATE_KEY] && record(record(row.api_protocol_config)[GATE_KEY]).state, "pending");
    }
    assert.equal(String(row.api_key), SECRET_REFERENCES[id], `${id} must use its dedicated credential reference`);
  }
  for (const id of EXISTING_PRICE_IDS) {
    const before = plan.before.find((row) => row.id === id)!;
    const next = after.get(id)!;
    assert.equal(next.cost_price, 0.48);
    assert.equal(next.price_per_use, EXPLICIT_VIDEO_SALE.existingGrokFast);
    assert.equal(
      stable(record(before.api_protocol_config)[GATE_KEY]),
      stable(record(next.api_protocol_config)[GATE_KEY]),
      `${id} activation evidence must remain byte-equivalent`,
    );
  }
  const veoBefore = plan.before.find((row) => row.id === VEO_COMPONENTS_ID)!;
  const veoAfter = after.get(VEO_COMPONENTS_ID)!;
  assert.equal(stable(record(veoBefore.api_protocol_config)[GATE_KEY]), stable(record(veoAfter.api_protocol_config)[GATE_KEY]));
  assert.equal(veoAfter.is_active, false);
  assert.equal(veoAfter.is_hidden, true);
}

export async function main(argumentsList = process.argv.slice(2)) {
  const apply = argumentsList.includes("--apply");
  const unknown = argumentsList.filter((argument) => argument !== "--apply");
  assert.deepEqual(unknown, [], `Unknown arguments: ${unknown.join(", ")}`);

  const runtime = JSON.parse((await readFile(RUNTIME_CONFIG, "utf8")).replace(/^\uFEFF/u, "")) as JsonRecord;
  const supabaseUrl = String(runtime.supabaseUrl || "");
  const serviceRoleKey = String(runtime.serviceRoleKey || "");
  assert.equal(new URL(supabaseUrl).origin, "http://127.0.0.1:54321", "Only the isolated local database is permitted");
  assert.ok(serviceRoleKey.length >= 16, "Local service role key is unavailable");
  const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const beforeResult = await db.from("video_models").select("*").order("id");
  if (beforeResult.error) throw beforeResult.error;
  const before = (beforeResult.data || []) as VideoModelRecord[];
  const plan = buildPriorityVideoModelPlan(before);
  assertPlan(plan);

  const publicPlan = {
    mode: apply ? "apply" : "plan",
    database: "local-only",
    targetIds: [...TARGET_IDS].sort(),
    changedIds: plan.changedIds,
    dedicatedCredentialReferencesRequired: Object.keys(SECRET_REFERENCES).sort(),
    secretValuesPrinted: false,
    providerRequests: 0,
    paidGenerationCalls: 0,
    models: plan.after.filter((row) => TARGET_IDS.has(row.id)).map(sanitize),
  };

  if (!apply) {
    console.log(JSON.stringify(publicPlan, null, 2));
    return;
  }

  assertDedicatedCredentialsReady();
  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `priority-video-models-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "targets.before.sanitized.json"), `${JSON.stringify(
    before.filter((row) => TARGET_IDS.has(row.id)).map(sanitize), null, 2,
  )}\n`);
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "priority_video_model_onboarding_backup.v1",
    createdAt: new Date().toISOString(),
    database: "local-only",
    targetIds: [...TARGET_IDS].sort(),
    credentialsInBackup: false,
    providerRequests: 0,
    paidGenerationCalls: 0,
  }, null, 2)}\n`);

  const targets = plan.after.filter((row) => TARGET_IDS.has(row.id));
  const write = await db.from("video_models").upsert(targets, { onConflict: "id" });
  if (write.error) throw write.error;

  const afterResult = await db.from("video_models").select("*").order("id");
  if (afterResult.error) throw afterResult.error;
  const actual = (afterResult.data || []) as VideoModelRecord[];
  const actualById = new Map(actual.map((row) => [row.id, row]));
  // PostgREST returns schema columns that were not present on a newly inserted
  // object as explicit nulls. Verify every field we intended to persist while
  // ignoring only those database-supplied columns, otherwise a successful
  // insert is incorrectly reported as a failed write.
  for (const target of targets) {
    assert.equal(
      stable(persistedTargetShape(actualById.get(target.id), target)),
      stable(target),
      `${target.id} write verification failed`,
    );
  }
  const beforeNonTargets = before.filter((row) => !TARGET_IDS.has(row.id));
  const afterNonTargets = actual.filter((row) => !TARGET_IDS.has(row.id));
  assert.equal(stable(afterNonTargets), stable(beforeNonTargets), "A non-target video model changed");

  console.log(JSON.stringify({
    ...publicPlan,
    mode: "applied",
    backupDir,
    changedIds: plan.changedIds,
    nonTargetModelsUnchanged: true,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    const candidate = record(error);
    console.error(JSON.stringify({
      failed: true,
      name: String(candidate.name || "Error"),
      message: String(candidate.message || error || "Priority video model onboarding failed"),
      providerRequests: 0,
      paidGenerationCalls: 0,
      secretValuesPrinted: false,
    }));
    process.exitCode = 1;
  });
}
