import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { getSupabaseAdminClient } from "../src/storage/database/supabase-client";
import { buildAutodlH3ActivationPlan, type AutodlH3ActivationPlan } from "../src/lib/autodl-h3-activation-profile";
import {
  AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
  AUTODL_H3_SELFHOST_PROTOCOL,
  AUTODL_H3_SELFHOST_PROVIDER,
  AUTODL_H3_SELFHOST_SECRET_REF,
  AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
} from "../src/lib/autodl-h3-selfhost";

dotenv.config({ path: ".env.local", quiet: true });

const APPLY = process.argv.includes("--apply");
const REPAIR_HIDDEN = process.argv.includes("--repair-hidden");
const HIDE = process.argv.includes("--hide");
const VERIFY = process.argv.includes("--verify");
const REPAIR_HARDWARE_NEUTRAL = process.argv.includes("--repair-hardware-neutral");
const LEGACY_ENABLE = process.argv.includes("--enable");

function argumentValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = String(process.argv[index + 1] || "").trim();
  if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少档案路径`);
  return value;
}

const VERIFY_PROFILE_PATH = argumentValue("--verify-profile");
const ACTIVATE_PROFILE_PATH = argumentValue("--activate-profile");
const HIDE_EVIDENCE_ID = argumentValue("--evidence-id");
const VERIFY_PROFILE = Boolean(VERIFY_PROFILE_PATH);
const ACTIVATE_PROFILE = Boolean(ACTIVATE_PROFILE_PATH);
const MODE_COUNT = [APPLY, REPAIR_HIDDEN, HIDE, VERIFY, REPAIR_HARDWARE_NEUTRAL, VERIFY_PROFILE, ACTIVATE_PROFILE, LEGACY_ENABLE].filter(Boolean).length;

if (MODE_COUNT > 1) throw new Error("配置命令模式只能选择一个");
if (LEGACY_ENABLE) throw new Error("--enable 已禁用；必须使用 --activate-profile 通过单事务更新实测档案并启用");
if (HIDE && !/^[A-Za-z0-9._:-]{8,160}$/u.test(HIDE_EVIDENCE_ID)) {
  throw new Error("--hide 必须同时提供 8-160 位的 --evidence-id");
}
if (!HIDE && HIDE_EVIDENCE_ID) throw new Error("--evidence-id 仅可与 --hide 同时使用");

const VIDEO_ID = "minimax-h3-turbo-selfhost-pro6000";
const IMAGE_ID = "qwen-image-2512-hq-selfhost-pro6000";

export const videoRecord = {
  id: VIDEO_ID,
  name: "MiniMax H3 Turbo · 自租实例（本地验证）",
  model_name: "minimax-h3-turbo",
  provider: AUTODL_H3_SELFHOST_PROVIDER,
  protocol_type: AUTODL_H3_SELFHOST_PROTOCOL,
  api_endpoint: AUTODL_H3_SELFHOST_VIDEO_ENDPOINT,
  api_key: AUTODL_H3_SELFHOST_SECRET_REF,
  price_per_use: 0,
  cost_price: 0,
  currency: "CNY",
  duration_seconds: 10,
  max_duration: 15,
  supports_image_input: true,
  requires_image: false,
  is_active: true,
  is_hidden: true,
  sort_order: 900,
  admin_notes: [
    "【内部渠道备注｜仅本地 V2.6 验证】",
    "独立协议 autodl_h3_selfhost；不得与 AutoDL 托管 ComfyUI Token/协议混用。",
    "视频：MiniMax H3 Turbo，5/10/15 秒；480p 档对应 16:9=864x480、9:16=480x864、1:1=768x768。",
    "支持可选首帧图；未上传图片时严格走文生视频，不自动额外生图。",
    "结果短链必须立即由 V2.6 后端取回并转存；不支持上游远程取消。",
    "当前端点依赖本机 SSH 回环隧道，仅用于开发验收，不是全国用户生产入口。",
  ].join("\n"),
  api_protocol_config: {
    supports_duration: true,
    duration_options: [5, 10, 15],
    min_duration: 5,
    max_duration: 15,
    min_submit_duration: 5,
    duration_step: 5,
    default_duration: 10,
    exact_duration_only: true,
    resolution_options: ["480p"],
    default_resolution: "480p",
    resolution: "480p",
    resolution_cost_prices: { "480p": 0 },
    resolution_prices: { "480p": 0 },
    aspect_ratios: ["16:9", "9:16", "1:1"],
    pixel_size_by_aspect_ratio: {
      "16:9": "864x480",
      "9:16": "480x864",
      "1:1": "768x768",
    },
    auto_generate_reference: false,
    persist_result_immediately: true,
    supports_remote_cancel: false,
    billing_unit: "per_use",
    workspace_surfaces: ["ai-video", "storyboard"],
  },
};

export const imageRecord = {
  id: IMAGE_ID,
  name: "Qwen Image 2512 HQ · 自租 PRO6000（本地验证）",
  model_name: "qwen-image-2512-hq",
  provider: AUTODL_H3_SELFHOST_PROVIDER,
  api_endpoint: AUTODL_H3_SELFHOST_IMAGE_ENDPOINT,
  api_key: AUTODL_H3_SELFHOST_SECRET_REF,
  cost_price: 0,
  selling_price: 0,
  is_active: true,
  is_hidden: true,
  supports_image_input: false,
  sort_order: 900,
};

const VIDEO_STABLE_FIELDS = [
  "id", "name", "model_name", "provider", "protocol_type", "api_endpoint",
  "price_per_use", "cost_price", "currency", "duration_seconds", "max_duration",
  "supports_image_input", "requires_image", "is_active", "is_hidden", "sort_order",
  "admin_notes", "api_protocol_config",
].join(",");

const IMAGE_STABLE_FIELDS = [
  "id", "name", "model_name", "provider", "api_endpoint", "cost_price", "selling_price",
  "is_active", "is_hidden", "supports_image_input", "sort_order",
].join(",");

const VIDEO_TARGET_FIELDS = `${VIDEO_STABLE_FIELDS},api_key`;
const IMAGE_TARGET_FIELDS = `${IMAGE_STABLE_FIELDS},api_key`;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function secretRefMatches(value: unknown): boolean {
  const actual = createHash("sha256").update(String(value || ""), "utf8").digest();
  const expected = createHash("sha256").update(AUTODL_H3_SELFHOST_SECRET_REF, "utf8").digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function targetConfig(value: Record<string, unknown>): Record<string, unknown> {
  const config = { ...value };
  delete config.api_key;
  delete config.is_hidden;
  return config;
}

function targetVideoWithoutHardwareLabel(value: Record<string, unknown>): Record<string, unknown> {
  const config = targetConfig(value);
  delete config.name;
  delete config.admin_notes;
  return config;
}

type TargetPair = {
  video: Record<string, unknown> | null;
  image: Record<string, unknown> | null;
};

export type RecognizedVerifyState = "seed-hidden" | "verified-profile-hidden" | "verified-profile-visible";

export function assertRecognizedVerifyState(
  targets: TargetPair,
  verifiedRecords: { video: Record<string, unknown>; image: Record<string, unknown> },
): {
  state: RecognizedVerifyState;
  hidden: boolean;
  videoSecretRefVerified: true;
  imageSecretRefVerified: true;
} {
  if (!targets.video || !targets.image) throw new Error("两条 H3 自租模型记录尚未全部创建");
  const videoHidden = targets.video.is_hidden;
  const imageHidden = targets.image.is_hidden;
  if (typeof videoHidden !== "boolean" || imageHidden !== videoHidden) {
    throw new Error("两条 H3 自租模型必须处于一致的 hidden/visible 状态");
  }
  if (!secretRefMatches(targets.video.api_key) || !secretRefMatches(targets.image.api_key)) {
    throw new Error("H3 自租模型必须使用独立 secret 引用，拒绝验收");
  }

  const actualVideoHash = stableHash(targetConfig(targets.video));
  const actualImageHash = stableHash(targetConfig(targets.image));
  const seedMatches = actualVideoHash === stableHash(targetConfig(videoRecord))
    && actualImageHash === stableHash(targetConfig(imageRecord));
  const profileMatches = actualVideoHash === stableHash(targetConfig(verifiedRecords.video))
    && actualImageHash === stableHash(targetConfig(verifiedRecords.image));

  if (seedMatches) {
    if (!videoHidden) throw new Error("seed 配置只能以双 hidden 状态通过验收");
    return {
      state: "seed-hidden",
      hidden: true,
      videoSecretRefVerified: true,
      imageSecretRefVerified: true,
    };
  }
  if (profileMatches) {
    return {
      state: videoHidden ? "verified-profile-hidden" : "verified-profile-visible",
      hidden: videoHidden,
      videoSecretRefVerified: true,
      imageSecretRefVerified: true,
    };
  }
  throw new Error("目标模型既不匹配精确 seed-hidden 配置，也不匹配精确 verified-profile 配置");
}

export function assertOldModelSnapshotUnchanged(
  before: { videoHash: string; imageHash: string },
  after: { videoHash: string; imageHash: string },
): void {
  if (before.videoHash !== after.videoHash || before.imageHash !== after.imageHash) {
    throw new Error("验收期间旧模型稳定哈希发生变化");
  }
}

function sortedRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

async function readSnapshot(db: ReturnType<typeof getSupabaseAdminClient>) {
  const [videoResult, imageResult] = await Promise.all([
    db.from("video_models").select(VIDEO_STABLE_FIELDS).neq("id", VIDEO_ID),
    db.from("cover_models").select(IMAGE_STABLE_FIELDS).neq("id", IMAGE_ID),
  ]);
  if (videoResult.error) throw videoResult.error;
  if (imageResult.error) throw imageResult.error;
  const video = sortedRows((videoResult.data || []) as Record<string, unknown>[]);
  const image = sortedRows((imageResult.data || []) as Record<string, unknown>[]);
  return {
    video,
    image,
    videoHash: stableHash(video),
    imageHash: stableHash(image),
  };
}

async function readTargets(db: ReturnType<typeof getSupabaseAdminClient>) {
  const [videoResult, imageResult] = await Promise.all([
    db.from("video_models").select(VIDEO_TARGET_FIELDS).eq("id", VIDEO_ID).maybeSingle(),
    db.from("cover_models").select(IMAGE_TARGET_FIELDS).eq("id", IMAGE_ID).maybeSingle(),
  ]);
  if (videoResult.error) throw videoResult.error;
  if (imageResult.error) throw imageResult.error;
  return { video: videoResult.data, image: imageResult.data };
}

function assertTargetIdentity(
  targets: Awaited<ReturnType<typeof readTargets>>,
  expectedHidden?: boolean,
  expectedVideoRecord: Record<string, unknown> = videoRecord,
  expectedImageRecord: Record<string, unknown> = imageRecord,
) {
  if (!targets.video || !targets.image) throw new Error("两条 H3 自租模型记录尚未全部创建");
  const video = targets.video as Record<string, unknown>;
  const image = targets.image as Record<string, unknown>;
  const videoSecretRefVerified = secretRefMatches(video.api_key);
  const imageSecretRefVerified = secretRefMatches(image.api_key);
  if (!videoSecretRefVerified || !imageSecretRefVerified) {
    throw new Error("H3 自租模型必须使用独立 secret 引用，拒绝启用");
  }
  if (stableHash(targetConfig(video)) !== stableHash(targetConfig(expectedVideoRecord))) {
    throw new Error("视频模型完整配置或能力与 H3 自租隔离契约不一致，拒绝启用");
  }
  if (stableHash(targetConfig(image)) !== stableHash(targetConfig(expectedImageRecord))) {
    throw new Error("生图模型完整配置或能力与 H3 自租隔离契约不一致，拒绝启用");
  }
  if (expectedHidden !== undefined && (
    video.is_hidden !== expectedHidden || image.is_hidden !== expectedHidden
  )) {
    throw new Error(expectedHidden
      ? "H3 自租模型必须保持隐藏才能进入启用阶段"
      : "H3 自租模型启用后的可见状态校验失败");
  }
  return { videoSecretRefVerified, imageSecretRefVerified };
}

function assertTargetSecurity(
  targets: Awaited<ReturnType<typeof readTargets>>,
  expectedHidden: boolean,
) {
  if (!targets.video || !targets.image) throw new Error("两条 H3 自租模型记录尚未全部创建");
  const video = targets.video as Record<string, unknown>;
  const image = targets.image as Record<string, unknown>;
  const checks = [
    [video.provider, AUTODL_H3_SELFHOST_PROVIDER, "视频供应商"],
    [video.protocol_type, AUTODL_H3_SELFHOST_PROTOCOL, "视频协议"],
    [video.model_name, videoRecord.model_name, "视频模型"],
    [video.api_endpoint, AUTODL_H3_SELFHOST_VIDEO_ENDPOINT, "视频端点"],
    [image.provider, AUTODL_H3_SELFHOST_PROVIDER, "生图供应商"],
    [image.model_name, imageRecord.model_name, "生图模型"],
    [image.api_endpoint, AUTODL_H3_SELFHOST_IMAGE_ENDPOINT, "生图端点"],
  ] as const;
  for (const [actual, expected, label] of checks) {
    if (String(actual || "") !== String(expected)) throw new Error(`${label}不符合独立 H3 安全绑定`);
  }
  if (!secretRefMatches(video.api_key) || !secretRefMatches(image.api_key)) {
    throw new Error("H3 自租模型必须使用独立 secret 引用，拒绝启用");
  }
  if (video.is_hidden !== expectedHidden || image.is_hidden !== expectedHidden) {
    throw new Error(expectedHidden ? "原子激活只允许从双隐藏状态开始" : "原子激活后的可见状态异常");
  }
}

function sanitizedTarget(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.api_key;
  return copy;
}

async function saveBackup(
  snapshot: Awaited<ReturnType<typeof readSnapshot>>,
  mode: string,
  targets?: Awaited<ReturnType<typeof readTargets>>,
) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "");
  const backupDir = path.join("backups", `autodl-h3-selfhost-${stamp}`);
  await mkdir(backupDir, { recursive: true });
  await writeFile(path.join(backupDir, "existing-models.sanitized.json"), `${JSON.stringify({
    video_models: snapshot.video,
    cover_models: snapshot.image,
    target_video_model: sanitizedTarget(targets?.video),
    target_cover_model: sanitizedTarget(targets?.image),
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(backupDir, "manifest.json"), `${JSON.stringify({
    schema: "autodl_h3_selfhost_config.v1",
    created_at: new Date().toISOString(),
    mode,
    target_ids: [VIDEO_ID, IMAGE_ID],
    credentials_in_backup: false,
    paid_generation_calls: 0,
    old_video_count: snapshot.video.length,
    old_cover_count: snapshot.image.length,
    old_video_hash: snapshot.videoHash,
    old_cover_hash: snapshot.imageHash,
  }, null, 2)}\n`, "utf8");
  return backupDir;
}

export function activationRecords(plan: AutodlH3ActivationPlan) {
  return {
    video: {
      ...videoRecord,
      name: plan.videoName,
      duration_seconds: plan.videoDurationSeconds,
      max_duration: plan.videoMaxDuration,
      admin_notes: plan.videoAdminNotes,
      api_protocol_config: plan.videoProtocolConfig,
      is_hidden: false,
    },
    image: {
      ...imageRecord,
      name: plan.imageName,
      is_hidden: false,
    },
  };
}

async function readActivationPlan(profilePath: string) {
  const absolutePath = path.resolve(profilePath);
  const parsed = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  return { absolutePath, plan: buildAutodlH3ActivationPlan(parsed) };
}

function activationPlanSummary(plan: AutodlH3ActivationPlan) {
  const config = plan.videoProtocolConfig;
  return {
    evidence_id: plan.evidenceId,
    verified_at: plan.verifiedAt,
    video: {
      duration_options: config.duration_options,
      resolution_options: config.resolution_options,
      resolution_labels: config.resolution_labels,
      resolution_status: config.resolution_status,
      resolution_verification_mode: config.resolution_verification_mode,
      direct_verified_combinations: config.direct_verified_combinations,
      supported_combinations: config.supported_combinations,
      combination_verification_mode: config.combination_verification_mode,
      verification_notice: config.verification_notice,
      aspect_ratios: config.aspect_ratios,
      input_pixel_size_by_resolution: config.input_pixel_size_by_resolution,
      output_pixel_size_by_resolution: config.output_pixel_size_by_resolution,
      gateway_output_tier_by_resolution: config.gateway_output_tier_by_resolution,
    },
    image: {
      resolution: plan.imageResolution,
      aspect_ratios: plan.imageAspectRatios,
      request_pixel_sizes: plan.imageRequestPixelSizes,
      output_pixel_sizes: plan.imageOutputPixelSizes,
    },
    credentials_printed: false,
    paid_generation_calls: 0,
  };
}

async function main() {
  if (VERIFY_PROFILE) {
    const { plan } = await readActivationPlan(VERIFY_PROFILE_PATH);
    console.log(JSON.stringify({ mode: "profile-verified", ...activationPlanSummary(plan) }, null, 2));
    return;
  }

  const activation = ACTIVATE_PROFILE
    ? await readActivationPlan(ACTIVATE_PROFILE_PATH)
    : null;
  const verifiedActivation = (VERIFY || REPAIR_HARDWARE_NEUTRAL)
    ? await readActivationPlan(path.join(path.dirname(fileURLToPath(import.meta.url)), "config", "autodl-h3-selfhost-activation-profile.verified.json"))
    : null;
  const db = getSupabaseAdminClient();
  const before = await readSnapshot(db);
  const targetsBefore = await readTargets(db);

  if (!APPLY && !REPAIR_HIDDEN && !HIDE && !ACTIVATE_PROFILE && !VERIFY && !REPAIR_HARDWARE_NEUTRAL) {
    console.log(JSON.stringify({
      mode: "dry-run",
      targets_exist: { video: Boolean(targetsBefore.video), image: Boolean(targetsBefore.image) },
      old_counts: { video: before.video.length, image: before.image.length },
      old_hashes: { video: before.videoHash, image: before.imageHash },
      planned_records: [
        { id: VIDEO_ID, provider: videoRecord.provider, protocol: videoRecord.protocol_type, hidden: true },
        { id: IMAGE_ID, provider: imageRecord.provider, hidden: true },
      ],
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (REPAIR_HARDWARE_NEUTRAL) {
    if (!verifiedActivation) throw new Error("硬件中性名称修复缺少固定 verified profile");
    if (!targetsBefore.video || !targetsBefore.image) throw new Error("H3 自租目标模型记录不完整");
    const expected = activationRecords(verifiedActivation.plan);
    const videoBefore = targetsBefore.video as Record<string, unknown>;
    const imageBefore = targetsBefore.image as Record<string, unknown>;
    if (videoBefore.is_hidden !== false || imageBefore.is_hidden !== false) {
      throw new Error("硬件中性名称修复只允许处理已激活且可见的目标模型");
    }
    if (!secretRefMatches(videoBefore.api_key) || !secretRefMatches(imageBefore.api_key)) {
      throw new Error("H3 自租模型 secret 引用不匹配，拒绝修复");
    }
    const beforeNonAllowedHash = stableHash(targetVideoWithoutHardwareLabel(videoBefore));
    const expectedNonAllowedHash = stableHash(targetVideoWithoutHardwareLabel(expected.video));
    if (beforeNonAllowedHash !== expectedNonAllowedHash) {
      throw new Error("H3 目标行存在超出 name/admin_notes 的配置漂移，拒绝自动修复");
    }
    if (stableHash(targetConfig(imageBefore)) !== stableHash(targetConfig(expected.image))) {
      throw new Error("H3 配套生图模型发生漂移，拒绝修改任何记录");
    }
    const backupDir = await saveBackup(before, "repair-hardware-neutral-label", targetsBefore);
    const alreadyRepaired = videoBefore.name === expected.video.name
      && videoBefore.admin_notes === expected.video.admin_notes;
    if (!alreadyRepaired) {
      const update = await db.from("video_models")
        .update({ name: expected.video.name, admin_notes: expected.video.admin_notes })
        .eq("id", VIDEO_ID)
        .eq("is_hidden", false)
        .select("id");
      if (update.error) throw update.error;
      if ((update.data || []).length !== 1) throw new Error("H3 硬件中性名称修复未精确命中单行");
    }
    const targetsAfter = await readTargets(db);
    const targetChecks = assertTargetIdentity(targetsAfter, false, expected.video, expected.image);
    const videoAfter = targetsAfter.video as Record<string, unknown>;
    const after = await readSnapshot(db);
    assertOldModelSnapshotUnchanged(before, after);
    if (stableHash(targetVideoWithoutHardwareLabel(videoAfter)) !== beforeNonAllowedHash) {
      throw new Error("H3 硬件中性名称修复意外改变了非允许字段");
    }
    console.log(JSON.stringify({
      mode: alreadyRepaired ? "hardware-neutral-label-already-repaired" : "hardware-neutral-label-repaired",
      backupDir,
      target_id: VIDEO_ID,
      allowed_fields_changed: alreadyRepaired ? [] : ["name", "admin_notes"],
      target_non_allowed_hash_unchanged: true,
      old_video_hash_unchanged: before.videoHash === after.videoHash,
      old_image_hash_unchanged: before.imageHash === after.imageHash,
      secret_refs_verified: targetChecks.videoSecretRefVerified && targetChecks.imageSecretRefVerified,
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (REPAIR_HIDDEN) {
    if (!targetsBefore.video || !targetsBefore.image) {
      throw new Error("--repair-hidden 只允许修复已经存在的两条 H3 目标记录");
    }
    if (targetsBefore.video.is_hidden !== true || targetsBefore.image.is_hidden !== true) {
      throw new Error("--repair-hidden 只允许修复仍处于隐藏状态的 H3 目标记录");
    }
    if (!secretRefMatches(targetsBefore.video.api_key) || !secretRefMatches(targetsBefore.image.api_key)) {
      throw new Error("--repair-hidden 检测到非预期密钥引用，拒绝覆盖");
    }
    const backupDir = await saveBackup(before, "repair-hidden", targetsBefore);
    const videoRepair = Object.fromEntries(Object.entries(videoRecord).filter(([key]) => key !== "id"));
    const imageRepair = Object.fromEntries(Object.entries(imageRecord).filter(([key]) => key !== "id"));
    const videoUpdate = await db.from("video_models").update(videoRepair).eq("id", VIDEO_ID);
    if (videoUpdate.error) throw videoUpdate.error;
    const imageUpdate = await db.from("cover_models").update(imageRepair).eq("id", IMAGE_ID);
    if (imageUpdate.error) throw imageUpdate.error;
    const targetsAfter = await readTargets(db);
    const targetChecks = assertTargetIdentity(targetsAfter, true);
    const after = await readSnapshot(db);
    if (before.videoHash !== after.videoHash || before.imageHash !== after.imageHash) {
      throw new Error("修复隐藏目标记录时意外改变了旧模型");
    }
    console.log(JSON.stringify({
      mode: "repaired-hidden",
      backupDir,
      target_ids: [VIDEO_ID, IMAGE_ID],
      old_models_unchanged: true,
      secret_refs_verified: targetChecks.videoSecretRefVerified && targetChecks.imageSecretRefVerified,
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (APPLY) {
    if (targetsBefore.video || targetsBefore.image) {
      throw new Error("目标 ID 已存在；为避免覆盖，--apply 拒绝 upsert/update");
    }
    const backupDir = await saveBackup(before, "apply", targetsBefore);
    const videoInsert = await db.from("video_models").insert(videoRecord);
    if (videoInsert.error) throw videoInsert.error;
    const imageInsert = await db.from("cover_models").insert(imageRecord);
    if (imageInsert.error) throw imageInsert.error;
    const targetsAfter = await readTargets(db);
    const targetChecks = assertTargetIdentity(targetsAfter, true);
    const after = await readSnapshot(db);
    if (before.videoHash !== after.videoHash || before.imageHash !== after.imageHash) {
      throw new Error("旧模型稳定哈希发生变化；停止后续启用");
    }
    console.log(JSON.stringify({
      mode: "applied-hidden",
      backupDir,
      target_ids: [VIDEO_ID, IMAGE_ID],
      old_models_unchanged: true,
      secret_refs_verified: targetChecks.videoSecretRefVerified && targetChecks.imageSecretRefVerified,
      old_counts: { video: after.video.length, image: after.image.length },
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (ACTIVATE_PROFILE && activation) {
    assertTargetSecurity(targetsBefore, true);
    const expected = activationRecords(activation.plan);
    const backupDir = await saveBackup(before, "activate-profile", targetsBefore);
    const { data: rpcResult, error: rpcError } = await db.rpc("activate_autodl_h3_selfhost_models_v1", {
      p_video_name: activation.plan.videoName,
      p_video_duration_seconds: activation.plan.videoDurationSeconds,
      p_video_max_duration: activation.plan.videoMaxDuration,
      p_video_admin_notes: activation.plan.videoAdminNotes,
      p_video_protocol_config: activation.plan.videoProtocolConfig,
      p_image_name: activation.plan.imageName,
      p_profile_evidence_id: activation.plan.evidenceId,
    });
    if (rpcError) {
      throw new Error(`原子激活 RPC 失败；未执行顺序更新：${rpcError.message}`);
    }
    const targetsAfter = await readTargets(db);
    assertTargetSecurity(targetsAfter, false);
    const targetChecks = assertTargetIdentity(targetsAfter, false, expected.video, expected.image);
    const after = await readSnapshot(db);
    if (before.videoHash !== after.videoHash || before.imageHash !== after.imageHash) {
      throw new Error("原子激活操作意外改变了旧模型");
    }
    console.log(JSON.stringify({
      mode: "activated-atomically",
      backupDir,
      target_ids: [VIDEO_ID, IMAGE_ID],
      old_models_unchanged: true,
      secret_refs_verified: targetChecks.videoSecretRefVerified && targetChecks.imageSecretRefVerified,
      rpc_committed: Boolean(rpcResult),
      profile: activationPlanSummary(activation.plan),
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (HIDE) {
    assertTargetSecurity(targetsBefore, false);
    const backupDir = await saveBackup(before, "hide-atomically", targetsBefore);
    const { data: rpcResult, error: rpcError } = await db.rpc("hide_autodl_h3_selfhost_models_v1", {
      p_reason_evidence_id: HIDE_EVIDENCE_ID,
    });
    if (rpcError) throw new Error(`原子隐藏 RPC 失败：${rpcError.message}`);
    const targetsAfter = await readTargets(db);
    assertTargetSecurity(targetsAfter, true);
    const after = await readSnapshot(db);
    if (before.videoHash !== after.videoHash || before.imageHash !== after.imageHash) {
      throw new Error("原子隐藏操作意外改变了旧模型");
    }
    console.log(JSON.stringify({
      mode: "hidden-atomically",
      backupDir,
      target_ids: [VIDEO_ID, IMAGE_ID],
      old_models_unchanged: true,
      rpc_committed: Boolean(rpcResult),
      evidence_id: HIDE_EVIDENCE_ID,
      credentials_printed: false,
      paid_generation_calls: 0,
    }, null, 2));
    return;
  }

  if (!verifiedActivation) throw new Error("--verify 缺少固定 verified profile");
  const expected = activationRecords(verifiedActivation.plan);
  const targetChecks = assertRecognizedVerifyState(
    targetsBefore as TargetPair,
    { video: expected.video, image: expected.image },
  );
  const after = await readSnapshot(db);
  assertOldModelSnapshotUnchanged(before, after);
  console.log(JSON.stringify({
    mode: "verified",
    target_ids: [VIDEO_ID, IMAGE_ID],
    target_config_state: targetChecks.state,
    target_state: {
      video_hidden: targetChecks.hidden,
      image_hidden: targetChecks.hidden,
    },
    old_counts: { video: after.video.length, image: after.image.length },
    old_hashes: { video: after.videoHash, image: after.imageHash },
    old_models_unchanged: true,
    secret_refs_verified: targetChecks.videoSecretRefVerified && targetChecks.imageSecretRefVerified,
    credentials_printed: false,
    paid_generation_calls: 0,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error) => {
    console.error(JSON.stringify({
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      credentials_printed: false,
      paid_generation_calls: 0,
    }));
    process.exitCode = 1;
  });
}
