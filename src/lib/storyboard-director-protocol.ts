import type { AgentPresetField } from "@/lib/agent-preset-schema";
import { StoryboardPerformancePlanSchema, STORYBOARD_PERFORMANCE_MODE_LABELS, validateStoryboardPerformancePlan, type StoryboardPerformancePlan } from "./storyboard-director-performance";

export const STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION = "storyboard_director_input.v1" as const;
export const STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION = "storyboard_director_output.v1" as const;
export const STORYBOARD_DIRECTOR_ARTIFACT_TYPE = "storyboard_director_package" as const;

export const STORYBOARD_DIRECTOR_MODES = [
  "high_energy",
  "cinematic",
  "lyrical",
] as const;

export type StoryboardDirectorMode = typeof STORYBOARD_DIRECTOR_MODES[number];

export const STORYBOARD_DIRECTOR_MODE_LABELS: Record<StoryboardDirectorMode, string> = {
  high_energy: "高能夸张",
  cinematic: "电影叙事",
  lyrical: "抒情情感",
};

export const STORYBOARD_LAYOUTS = [
  "two_by_two",
  "four_plus_panorama",
] as const;

export const STORYBOARD_PACING_MODES = [
  "slow",
  "medium",
  "fast",
] as const;

export const STORYBOARD_TARGET_DURATIONS = [8, 10, 15] as const;

export type StoryboardLayout = typeof STORYBOARD_LAYOUTS[number];
export type StoryboardPacingMode = typeof STORYBOARD_PACING_MODES[number];
export type StoryboardTargetDurationSeconds = typeof STORYBOARD_TARGET_DURATIONS[number];
export type StoryboardActualShotCount = 1 | 2 | 3 | 4 | 5;

/** Structured scene and panel controls shared by the agent package and the workbench. */
export const STORYBOARD_SCENE_TYPES = ["interior", "exterior", "transition", "abstract"] as const;
export type StoryboardSceneType = typeof STORYBOARD_SCENE_TYPES[number];
export const STORYBOARD_ENVIRONMENT_MODES = ["anchor", "prompt", "none"] as const;
export type StoryboardEnvironmentMode = typeof STORYBOARD_ENVIRONMENT_MODES[number];
export const STORYBOARD_PANEL_ROLES = ["none", "panorama", "reveal", "evidence", "conclusion"] as const;
export type StoryboardBottomPanelRole = typeof STORYBOARD_PANEL_ROLES[number];
export const STORYBOARD_CONFIDENCE_LEVELS = ["confirmed", "inferred", "unknown"] as const;
export type StoryboardConfidenceLevel = typeof STORYBOARD_CONFIDENCE_LEVELS[number];

export const STORYBOARD_3D_STYLES = [
  "电影级高能3D动画喜剧",
  "童话奇幻3D动画",
  "欧美反差3D动画喜剧",
  "高饱和萌宠3D动画喜剧",
  "温暖家庭3D动画电影",
  "电影级风格化半写实3D",
  "手工黏土定格3D动画",
  "Q版收藏玩具3D动画",
  "东方国潮3D动画电影",
  "未来科技3D动画",
] as const;

export const STORYBOARD_DIRECTOR_PRESET_FIELDS: AgentPresetField[] = [
  {
    id: "segmented_script",
    label: "已分段口播文案",
    type: "textarea",
    placeholder: "例如：1.【第一段……】\n2.【第二段……】",
    required: true,
    options: [],
    order: 0,
    sendLabel: true,
    sendText: "segmented_script",
    description: "保留段落编号、边界、顺序和原字，不重新拆段。",
  },
  {
    id: "director_mode",
    label: "故事版导演",
    type: "select",
    placeholder: "选择导演版本",
    required: true,
    options: STORYBOARD_DIRECTOR_MODES.map((mode) => STORYBOARD_DIRECTOR_MODE_LABELS[mode]),
    order: 1,
    defaultValue: STORYBOARD_DIRECTOR_MODE_LABELS.high_energy,
    sendLabel: true,
    sendText: "director_mode",
    description: "高能夸张、电影叙事、抒情情感共用稳定结构协议，只改变表演、镜头和节奏取舍。",
  },
  {
    id: "animation_style",
    label: "3D动画风格",
    type: "select",
    placeholder: "选择全片统一的3D动画风格",
    required: true,
    options: [...STORYBOARD_3D_STYLES],
    order: 2,
    sendLabel: true,
    sendText: "animation_style",
  },
  {
    id: "aspect_ratio",
    label: "画面尺寸",
    type: "select",
    placeholder: "选择横屏或竖屏",
    required: true,
    options: ["16:9", "9:16"],
    order: 3,
    sendLabel: true,
    sendText: "aspect_ratio",
  },
  {
    id: "target_duration_seconds",
    label: "目标视频时长",
    type: "select",
    placeholder: "选择 8、10 或 15 秒",
    required: true,
    options: ["8", "10", "15"],
    order: 4,
    defaultValue: "10",
    sendLabel: true,
    sendText: "target_duration_seconds",
    description: "默认 10 秒；8秒更短更冲，10秒标准高能，15秒增加升级爆点；时长影响表演容量和镜头节奏，不机械决定镜头数。",
  },
  {
    id: "special_notes",
    label: "特殊备注",
    type: "textarea",
    placeholder: "选填：角色品种、年龄、毛色、服装、真实产品参考、禁用内容等。",
    required: false,
    options: [],
    order: 5,
    sendLabel: true,
    sendText: "special_notes",
    description: "只有这里明确要求时才绑定外部角色或产品参考资产。",
  },
];

export interface StoryboardDirectorInput {
  schema_version: typeof STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION;
  segmented_script: string;
  director_mode: StoryboardDirectorMode;
  animation_style: string;
  aspect_ratio: "16:9" | "9:16";
  target_duration_seconds: StoryboardTargetDurationSeconds;
  special_notes: string;
  /** Original submitted choices. Resolved character identities belong in asset locks. */
  owner_gender?: string;
  dog_breed?: string;
  video_model_profile?: string;
  visual_asset_mode?: string;
}

export interface StoryboardScriptSegment {
  segment_id: string;
  source_index: number;
  narration: string;
}

export interface StoryboardSemanticVisualization {
  trigger: string;
  visual_form: string;
  interaction: string;
}

export interface StoryboardShotTimeRange {
  shot_id: string;
  start_seconds: number;
  end_seconds: number;
  action_beat: string;
}

export interface StoryboardContinuityLink {
  from_shot: string;
  to_shot: string;
  link_type: string;
  description: string;
}

export type StoryboardVisualAssetRefRole = "character" | "pet" | "environment" | "prop";
export type StoryboardVisualAssetReferenceKind = "turnaround" | "identity" | "environment-wide" | "environment-angle" | "detail" | "prop";

/**
 * Stable JSON form of a visual-asset binding.  The canvas converts this
 * snake_case transport shape to the workbench's camelCase persistence shape.
 * It is optional so older v1 packages remain fully compatible.
 */
export interface StoryboardDirectorVisualAssetRef {
  asset_id: string;
  role: StoryboardVisualAssetRefRole;
  reference_kinds: StoryboardVisualAssetReferenceKind[];
  scene_id?: string;
  scene_zone?: string;
  camera_coverage?: "wide" | "front" | "side" | "reverse" | "detail";
}

export interface StoryboardDirectorVisualAssetReference {
  kind: StoryboardVisualAssetReferenceKind;
  purpose: string;
  prompt: string;
}

export interface StoryboardDirectorVisualAssetSource {
  kind: "generated-image-history" | "uploaded-image" | "platform-preset";
  asset_id: string;
  preset_id?: string;
  preset_revision?: number;
  library_saved?: boolean;
  history_record_id?: string;
  storage_key?: string;
  model_id?: string;
  model_name?: string;
  quoted_price?: number;
  created_at?: string;
}

/**
 * Project-level asset intent carried by the stable Agent package.  `source` is
 * optional because a director can propose an asset before the user chooses a
 * real account-owned image.  The canvas must resolve it before attaching any
 * URL to a generation card.
 */
export interface StoryboardDirectorVisualAsset {
  id: string;
  role: StoryboardVisualAssetRefRole;
  name: string;
  identity_lock: string;
  allowed_changes: string[];
  reference_prompts: StoryboardDirectorVisualAssetReference[];
  scene_id?: string;
  scene_zone?: string;
  camera_coverage?: "wide" | "front" | "side" | "reverse" | "detail";
  fixed_anchors?: string[];
  allowed_segment_kinds?: string[];
  derived_from_asset_id?: string;
  source?: StoryboardDirectorVisualAssetSource;
}

export interface StoryboardDirectorEnvironmentGroup {
  scene_id: string;
  name: string;
  fixed_anchors: string[];
  zones: string[];
  available_angles: Array<"wide" | "front" | "side" | "reverse" | "detail">;
  allowed_segment_kinds: string[];
  scene_type?: StoryboardSceneType;
  environment_mode?: StoryboardEnvironmentMode;
  anchor_required?: boolean;
  scene_zone?: string;
  confidence?: StoryboardConfidenceLevel;
}

export type StoryboardVisualAssetEnvironmentAnchorPolicy = "none" | "per-scene-when-required" | "always";

export interface StoryboardDirectorVisualAssetGenerationPolicy {
  /** Hard cap for the first paid image-generation pass. */
  max_initial_images: number;
  /** Assets that must be generated in the first pass. */
  initial_required_asset_ids: string[];
  /** Assets declared for later passes and never auto-generated in pass one. */
  initial_deferred_asset_ids: string[];
  /** Whether scene environment anchors are generated in the first pass. */
  environment_anchor_policy: StoryboardVisualAssetEnvironmentAnchorPolicy;
}

export interface StoryboardDirectorVisualAssetPlan {
  mode: "off" | "selected";
  assets: StoryboardDirectorVisualAsset[];
  generation_policy?: StoryboardDirectorVisualAssetGenerationPolicy;
}

export interface StoryboardDirectorSegmentOutput extends StoryboardScriptSegment {
  target_duration_seconds: StoryboardTargetDurationSeconds;
  estimated_narration_duration: number;
  panel_count: 4 | 5;
  layout: StoryboardLayout;
  pacing_mode: StoryboardPacingMode;
  actual_shot_count: StoryboardActualShotCount;
  shot_time_ranges: StoryboardShotTimeRange[];
  panoramic_anchor_role: string | null;
  bottom_panel_role?: StoryboardBottomPanelRole;
  continuity_links: StoryboardContinuityLink[];
  character_assets: string[];
  /** Stable identity IDs paired positionally with character_assets. */
  character_asset_ids?: string[];
  visual_asset_refs?: StoryboardDirectorVisualAssetRef[];
  wardrobe_change_events?: StoryboardWardrobeChangeEvent[];
  quality_checks?: StoryboardQualityCheck[];
  scene_id?: string;
  scene_zone?: string;
  /** Compact per-segment style fingerprint repeated by image/video prompts. */
  style_lock?: string;
  /** Compact per-segment scene/environment fingerprint repeated by prompts. */
  scene_lock?: string;
  camera?: string;
  dynamic_state?: string[];
  capability_gaps?: string[];
  semantic_visualizations: StoryboardSemanticVisualization[];
  performance_plan?: StoryboardPerformancePlan;
  storyboard_image_prompt: string;
  image_to_video_prompt: string;
}

export interface StoryboardWardrobeChangeEvent {
  segment_id: string;
  from: string;
  to: string;
  reason: string;
}

export interface StoryboardDirectorWardrobePlan {
  base_look: string;
  continuity_rule: string;
  change_events: StoryboardWardrobeChangeEvent[];
}

export interface StoryboardQualityCheck {
  check_id: string;
  status: "pass" | "fail" | "unknown";
  detail: string;
  verification?: { kind: "visual_asset_binding"; asset_ids: string[] };
}

export const STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION = "storyboard_director_contract.v2";
export const STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION = "storyboard_director_assets.v1";
export const STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE = "storyboard_director_assets";
export const STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION = "storyboard_director_plan.v1";
export const STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE = "storyboard_director_plan";

/** Populated by the host after reading the account-owned adopted asset. */
export interface StoryboardVerifiedAssetBinding {
  assetId: string;
  sourceAssetId: string;
  role: "character" | "pet";
  referenceKind: "turnaround";
  historyRecordId: string;
  storageKey?: string;
}

export interface StoryboardDirectorPackage {
  schema_version: typeof STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION;
  artifact_type: typeof STORYBOARD_DIRECTOR_ARTIFACT_TYPE;
  director_mode: StoryboardDirectorMode;
  input: StoryboardDirectorInput;
  production_contract_version?: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  phase?: "storyboard";
  wardrobe_plan?: StoryboardDirectorWardrobePlan;
  visual_asset_plan?: StoryboardDirectorVisualAssetPlan;
  environment_groups?: StoryboardDirectorEnvironmentGroup[];
  segments: StoryboardDirectorSegmentOutput[];
}

export interface StoryboardDirectorAssetsPackage extends Omit<StoryboardDirectorPackage, "schema_version" | "artifact_type" | "segments" | "phase"> {
  schema_version: typeof STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION;
  artifact_type: typeof STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE;
  production_contract_version: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  phase: "assets";
  visual_asset_plan: StoryboardDirectorVisualAssetPlan;
}

/** A complete text plan carries stable asset IDs, never proof of generated images. */
export interface StoryboardDirectorPlanPackage extends Omit<StoryboardDirectorPackage, "schema_version" | "artifact_type" | "phase"> {
  schema_version: typeof STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION;
  artifact_type: typeof STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE;
  production_contract_version: typeof STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  phase: "planned";
  visual_asset_plan: StoryboardDirectorVisualAssetPlan;
}

type UnknownRecord = Record<string, unknown>;

const VISUAL_ASSET_REF_ROLES = new Set<StoryboardVisualAssetRefRole>(["character", "pet", "environment", "prop"]);
const VISUAL_ASSET_REFERENCE_KINDS = new Set<StoryboardVisualAssetReferenceKind>([
  "turnaround",
  "identity",
  "environment-wide",
  "environment-angle",
  "detail",
  "prop",
]);
const SCENE_TYPES = new Set<StoryboardSceneType>(STORYBOARD_SCENE_TYPES);
const ENVIRONMENT_MODES = new Set<StoryboardEnvironmentMode>(STORYBOARD_ENVIRONMENT_MODES);
const PANEL_ROLES = new Set<StoryboardBottomPanelRole>(STORYBOARD_PANEL_ROLES);
const CONFIDENCE_LEVELS = new Set<StoryboardConfidenceLevel>(STORYBOARD_CONFIDENCE_LEVELS);
const VISUAL_ASSET_ENVIRONMENT_ANCHOR_POLICIES = new Set<StoryboardVisualAssetEnvironmentAnchorPolicy>([
  "none",
  "per-scene-when-required",
  "always",
]);

function normalizeBottomPanelRole(value: unknown, panelCount: 4 | 5): StoryboardBottomPanelRole | null {
  const raw = String(value ?? "").trim();
  const role = raw ? raw as StoryboardBottomPanelRole : panelCount === 5 ? "panorama" : "none";
  if (!PANEL_ROLES.has(role)) return null;
  if (panelCount === 4 && role !== "none") return null;
  if (panelCount === 5 && role === "none") return null;
  return role;
}

function normalizeWardrobeChangeEvents(value: unknown): StoryboardWardrobeChangeEvent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const events = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const segmentId = String(item.segment_id ?? item.segmentId ?? "").trim();
    const from = String(item.from ?? item.from_look ?? item.fromLook ?? "").trim();
    const to = String(item.to ?? item.to_look ?? item.toLook ?? "").trim();
    const reason = String(item.reason ?? "").trim();
    return segmentId && from && to && reason
      ? [{ segment_id: segmentId, from, to, reason }]
      : [];
  });
  return events.length === value.length ? events : [];
}

function normalizeWardrobePlan(value: unknown): StoryboardDirectorWardrobePlan | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const baseLook = String(value.base_look ?? value.baseLook ?? "").trim();
  const continuityRule = String(value.continuity_rule ?? value.continuityRule ?? "").trim();
  const eventsValue = value.change_events ?? value.changeEvents ?? [];
  const changeEvents = normalizeWardrobeChangeEvents(eventsValue);
  if (!baseLook || !continuityRule || !changeEvents || baseLook.length < 12 || baseLook.length > 500 || continuityRule.length < 12 || continuityRule.length > 500) return null;
  return { base_look: baseLook, continuity_rule: continuityRule, change_events: changeEvents };
}

function normalizeQualityChecks(value: unknown): StoryboardQualityCheck[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const checks = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const checkId = String(item.check_id ?? item.checkId ?? item.id ?? "").trim();
    const status = String(item.status ?? "").trim() as StoryboardQualityCheck["status"];
    const detail = String(item.detail ?? item.message ?? "").trim();
    const verification = item.verification;
    if (verification !== undefined && (!isRecord(verification) || verification.kind !== "visual_asset_binding"
      || Object.keys(verification).some(key => key !== "kind" && key !== "asset_ids")
      || !Array.isArray(verification.asset_ids) || !verification.asset_ids.length || verification.asset_ids.length > 16
      || verification.asset_ids.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/u.test(id))
      || new Set(verification.asset_ids).size !== verification.asset_ids.length)) return [];
    return checkId && (status === "pass" || status === "fail" || status === "unknown") && detail
      ? [{ check_id: checkId, status, detail, ...(verification !== undefined
        ? { verification: { kind: "visual_asset_binding" as const, asset_ids: [...(verification as { asset_ids: string[] }).asset_ids] } } : {}) }]
      : [];
  });
  return checks.length === value.length ? checks : [];
}

function normalizeVisualAssetRefs(value: unknown): StoryboardDirectorVisualAssetRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const refs = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const assetId = String(item.asset_id ?? "").trim();
    const role = String(item.role ?? "").trim() as StoryboardVisualAssetRefRole;
    const referenceKinds = Array.isArray(item.reference_kinds)
      ? item.reference_kinds.map((kind) => String(kind).trim() as StoryboardVisualAssetReferenceKind)
      : [];
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(assetId)
      || !VISUAL_ASSET_REF_ROLES.has(role)
      || referenceKinds.length < 1
      || referenceKinds.length > 4
      || referenceKinds.some((kind) => !VISUAL_ASSET_REFERENCE_KINDS.has(kind))) {
      return [];
    }
    const sceneId = String(item.scene_id ?? item.sceneId ?? "").trim();
    const sceneZone = String(item.scene_zone ?? item.sceneZone ?? "").trim();
    const camera = String(item.camera_coverage ?? item.cameraCoverage ?? "").trim();
    return [{ asset_id: assetId, role, reference_kinds: referenceKinds,
      ...(sceneId ? { scene_id: sceneId } : {}),
      ...(sceneZone ? { scene_zone: sceneZone } : {}),
      ...(([
        "wide", "front", "side", "reverse", "detail",
      ] as const).includes(camera as never) ? { camera_coverage: camera as StoryboardDirectorVisualAssetRef["camera_coverage"] } : {}),
    }];
  });
  return refs.length === value.length ? refs : [];
}

function normalizeVisualAssetGenerationPolicy(
  value: unknown,
  assetIds: Set<string>,
): StoryboardDirectorVisualAssetGenerationPolicy | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const maxInitialImages = Number(value.max_initial_images ?? value.maxInitialImages ?? 2);
  if (!Number.isSafeInteger(maxInitialImages) || maxInitialImages < 0 || maxInitialImages > 16) return null;
  const readIds = (candidate: unknown): string[] | null => {
    if (candidate === undefined) return [];
    if (!Array.isArray(candidate) || candidate.length > 16) return null;
    const ids = candidate.map((id) => String(id).trim());
    if (ids.some((id) => !/^[a-z][a-z0-9_-]{2,63}$/u.test(id))) return null;
    if (new Set(ids).size !== ids.length) return null;
    if (ids.some((id) => !assetIds.has(id))) return null;
    return ids;
  };
  const required = readIds(value.initial_required_asset_ids ?? value.initialRequiredAssetIds);
  const deferred = readIds(value.initial_deferred_asset_ids ?? value.initialDeferredAssetIds);
  if (!required || !deferred || required.length > maxInitialImages) return null;
  const deferredSet = new Set(deferred);
  if (required.some((id) => deferredSet.has(id))) return null;
  const environmentAnchorPolicy = String(
    value.environment_anchor_policy ?? value.environmentAnchorPolicy ?? "per-scene-when-required",
  ).trim() as StoryboardVisualAssetEnvironmentAnchorPolicy;
  if (!VISUAL_ASSET_ENVIRONMENT_ANCHOR_POLICIES.has(environmentAnchorPolicy)) return null;
  return {
    max_initial_images: maxInitialImages,
    initial_required_asset_ids: required,
    initial_deferred_asset_ids: deferred,
    environment_anchor_policy: environmentAnchorPolicy,
  };
}

function normalizeVisualAssetPlan(value: unknown): StoryboardDirectorVisualAssetPlan | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const mode = String(value.mode ?? "off").trim();
  if (mode !== "off" && mode !== "selected") return null;
  if (!Array.isArray(value.assets)) return null;
  const assets = value.assets.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = String(item.id ?? "").trim();
    const role = String(item.role ?? "").trim() as StoryboardVisualAssetRefRole;
    const name = String(item.name ?? "").trim();
    const identityLock = String(item.identity_lock ?? item.identityLock ?? "").trim();
    const allowedChangesValue = item.allowed_changes ?? item.allowedChanges;
    const allowedChanges = Array.isArray(allowedChangesValue)
      ? allowedChangesValue.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const referenceValue = item.reference_prompts ?? item.referencePrompts;
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(id)
      || !VISUAL_ASSET_REF_ROLES.has(role)
      || name.length < 2
      || identityLock.length < 12
      || !Array.isArray(referenceValue)
      || referenceValue.length < 1
      || referenceValue.length > 4) return [];
    const referencePrompts = referenceValue.flatMap((reference) => {
      if (!isRecord(reference)) return [];
      const kind = String(reference.kind ?? "").trim() as StoryboardVisualAssetReferenceKind;
      const purpose = String(reference.purpose ?? "").trim();
      const prompt = String(reference.prompt ?? "").trim();
      return VISUAL_ASSET_REFERENCE_KINDS.has(kind) && purpose.length >= 4 && prompt.length >= 20
        ? [{ kind, purpose, prompt }]
        : [];
    });
    if (referencePrompts.length !== referenceValue.length) return [];
    const sourceValue = item.source;
    let source: StoryboardDirectorVisualAssetSource | undefined;
    if (sourceValue !== undefined) {
      if (!isRecord(sourceValue)) return [];
      const sourceKind = String(sourceValue.kind ?? "").trim();
      const sourceAssetId = String(sourceValue.asset_id ?? sourceValue.assetId ?? "").trim();
      if (!["generated-image-history", "uploaded-image", "platform-preset"].includes(sourceKind) || !sourceAssetId) return [];
      const presetId = String(sourceValue.preset_id ?? sourceValue.presetId ?? "").trim();
      const presetRevision = Number(sourceValue.preset_revision ?? sourceValue.presetRevision);
      if (sourceKind === "platform-preset" && (!/^preset-[a-z0-9][a-z0-9_-]{2,63}$/u.test(presetId) || !Number.isSafeInteger(presetRevision) || presetRevision < 1)) return [];
      const quotedPrice = Number(sourceValue.quoted_price ?? sourceValue.quotedPrice);
      source = {
        kind: sourceKind as StoryboardDirectorVisualAssetSource["kind"],
        asset_id: sourceAssetId,
        ...(sourceKind === "platform-preset" ? { preset_id: presetId, preset_revision: presetRevision } : {}),
        ...(typeof (sourceValue.library_saved ?? sourceValue.librarySaved) === "boolean" ? { library_saved: Boolean(sourceValue.library_saved ?? sourceValue.librarySaved) } : {}),
        ...(String(sourceValue.history_record_id ?? sourceValue.historyRecordId ?? "").trim()
          ? { history_record_id: String(sourceValue.history_record_id ?? sourceValue.historyRecordId).trim() }
          : {}),
        ...(String(sourceValue.storage_key ?? sourceValue.storageKey ?? "").trim()
          ? { storage_key: String(sourceValue.storage_key ?? sourceValue.storageKey).trim() }
          : {}),
        ...(String(sourceValue.model_id ?? sourceValue.modelId ?? "").trim()
          ? { model_id: String(sourceValue.model_id ?? sourceValue.modelId).trim() }
          : {}),
        ...(String(sourceValue.model_name ?? sourceValue.modelName ?? "").trim()
          ? { model_name: String(sourceValue.model_name ?? sourceValue.modelName).trim() }
          : {}),
        ...(Number.isFinite(quotedPrice) && quotedPrice >= 0 ? { quoted_price: quotedPrice } : {}),
        ...(String(sourceValue.created_at ?? sourceValue.createdAt ?? "").trim()
          ? { created_at: String(sourceValue.created_at ?? sourceValue.createdAt).trim() }
          : {}),
      };
    }
    const sceneId = String(item.scene_id ?? item.sceneId ?? "").trim();
    const sceneZone = String(item.scene_zone ?? item.sceneZone ?? "").trim();
    const camera = String(item.camera_coverage ?? item.cameraCoverage ?? "").trim();
    const fixedAnchorsValue = item.fixed_anchors ?? item.fixedAnchors;
    const fixedAnchors = Array.isArray(fixedAnchorsValue)
      ? fixedAnchorsValue.map((value) => String(value).trim()).filter(Boolean).slice(0, 16)
      : [];
    const allowedSegmentKindsValue = item.allowed_segment_kinds ?? item.allowedSegmentKinds;
    const allowedSegmentKinds = Array.isArray(allowedSegmentKindsValue)
      ? allowedSegmentKindsValue.map((value) => String(value).trim()).filter(Boolean).slice(0, 24)
      : [];
    const derivedFromAssetId = String(item.derived_from_asset_id ?? item.derivedFromAssetId ?? "").trim();
    return [{ id, role, name, identity_lock: identityLock, allowed_changes: allowedChanges, reference_prompts: referencePrompts,
      ...(sceneId ? { scene_id: sceneId } : {}), ...(sceneZone ? { scene_zone: sceneZone } : {}),
      ...(([
        "wide", "front", "side", "reverse", "detail",
      ] as const).includes(camera as never) ? { camera_coverage: camera as StoryboardDirectorVisualAsset["camera_coverage"] } : {}),
      ...(fixedAnchors.length ? { fixed_anchors: fixedAnchors } : {}),
      ...(allowedSegmentKinds.length ? { allowed_segment_kinds: allowedSegmentKinds } : {}),
      ...(derivedFromAssetId ? { derived_from_asset_id: derivedFromAssetId } : {}),
      ...(source ? { source } : {}) }];
  });
  if (assets.length !== value.assets.length || (mode === "off" && assets.length > 0)) return null;
  const ids = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id)) return null;
    ids.add(asset.id);
  }
  const generationPolicy = normalizeVisualAssetGenerationPolicy(
    value.generation_policy ?? value.generationPolicy,
    ids,
  );
  if ((value.generation_policy !== undefined || value.generationPolicy !== undefined) && !generationPolicy) return null;
  return {
    mode: mode as "off" | "selected",
    assets,
    ...(generationPolicy ? { generation_policy: generationPolicy } : {}),
  };
}

function normalizeEnvironmentGroups(value: unknown): StoryboardDirectorEnvironmentGroup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const angles = new Set(["wide", "front", "side", "reverse", "detail"]);
  const groups = value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const sceneId = String(item.scene_id ?? item.sceneId ?? "").trim();
    const name = String(item.name ?? "").trim();
    if (!/^[a-z][a-z0-9_-]{2,63}$/u.test(sceneId) || !name) return [];
    const list = (candidate: unknown, max: number) => Array.isArray(candidate)
      ? candidate.map((value) => String(value).trim()).filter(Boolean).slice(0, max)
      : [];
    const availableAngles = list(item.available_angles ?? item.availableAngles, 5)
      .filter((value): value is StoryboardDirectorEnvironmentGroup["available_angles"][number] => angles.has(value));
    const sceneTypeValue = String(item.scene_type ?? item.sceneType ?? "").trim();
    const environmentModeValue = String(item.environment_mode ?? item.environmentMode ?? "").trim();
    const confidenceValue = String(item.confidence ?? "").trim();
    if ((sceneTypeValue && !SCENE_TYPES.has(sceneTypeValue as StoryboardSceneType))
      || (environmentModeValue && !ENVIRONMENT_MODES.has(environmentModeValue as StoryboardEnvironmentMode))
      || (confidenceValue && !CONFIDENCE_LEVELS.has(confidenceValue as StoryboardConfidenceLevel))) return [];
    const anchorRequiredValue = item.anchor_required ?? item.anchorRequired;
    if (anchorRequiredValue !== undefined && typeof anchorRequiredValue !== "boolean") return [];
    const sceneZone = String(item.scene_zone ?? item.sceneZone ?? "").trim();
    return [{
      scene_id: sceneId,
      name,
      fixed_anchors: list(item.fixed_anchors ?? item.fixedAnchors, 16),
      zones: list(item.zones, 16),
      available_angles: availableAngles,
      allowed_segment_kinds: list(item.allowed_segment_kinds ?? item.allowedSegmentKinds, 24),
      ...(sceneTypeValue ? { scene_type: sceneTypeValue as StoryboardSceneType } : {}),
      ...(environmentModeValue ? { environment_mode: environmentModeValue as StoryboardEnvironmentMode } : {}),
      ...(anchorRequiredValue !== undefined ? { anchor_required: anchorRequiredValue } : {}),
      ...(sceneZone ? { scene_zone: sceneZone } : {}),
      ...(confidenceValue ? { confidence: confidenceValue as StoryboardConfidenceLevel } : {}),
    }];
  });
  return groups.length === value.length ? groups : [];
}

export const STORYBOARD_DIRECTOR_INPUT_ALIASES = {
  segmented_script: ["segmented_script", "storyboard_segmented_copy", "segmented_copy", "分段文案", "已分段口播文案", "已分段文案", "口播文案"],
  director_mode: ["director_mode", "storyboard_director_mode", "导演版本", "故事版导演"],
  animation_style: ["animation_style", "storyboard_visual_style", "visual_style", "动画风格", "3D动画风格", "画面风格"],
  aspect_ratio: ["aspect_ratio", "storyboard_aspect_ratio", "video_ratio", "ratio", "画面尺寸", "生图比例", "视频比例"],
  target_duration_seconds: ["target_duration_seconds", "storyboard_target_duration_seconds", "target_duration", "duration_seconds", "segment_duration", "目标视频时长", "视频时长", "分段时长", "时长"],
  special_notes: ["special_notes", "storyboard_special_requirements", "special_requirements", "特殊备注", "特殊要求"],
  owner_gender: ["owner_gender", "主人性别"],
  dog_breed: ["dog_breed", "狗狗品种", "宠物品种"],
  video_model_profile: ["video_model_profile", "生成模型", "视频模型"],
  visual_asset_mode: ["visual_asset_mode", "视觉资产模式", "创作模式", "角色参考模式"],
  legacy_character: ["storyboard_character_setting", "character_setting", "角色设定"],
} as const;

const INPUT_ALIASES = STORYBOARD_DIRECTOR_INPUT_ALIASES;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(source: UnknownRecord, keys: readonly string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstValue(source: UnknownRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function normalizeRatio(value: string): "16:9" | "9:16" {
  return value.includes("9:16") ? "9:16" : "16:9";
}

function normalizeTargetDuration(value: unknown): StoryboardTargetDurationSeconds {
  const parsed = Number(String(value ?? "").match(/\d+/)?.[0]);
  return (STORYBOARD_TARGET_DURATIONS as readonly number[]).includes(parsed)
    ? parsed as StoryboardTargetDurationSeconds
    : 10;
}

function normalizeDirectorMode(value: unknown): StoryboardDirectorMode {
  const normalized = String(value ?? "").trim();
  if ((STORYBOARD_DIRECTOR_MODES as readonly string[]).includes(normalized)) {
    return normalized as StoryboardDirectorMode;
  }
  const entry = (Object.entries(STORYBOARD_DIRECTOR_MODE_LABELS) as Array<[StoryboardDirectorMode, string]>)
    .find(([, label]) => label === normalized);
  return entry?.[0] ?? "high_energy";
}

/** Accepts stable v1 IDs, legacy storyboard IDs, and common Chinese labels. */
export function normalizeStoryboardDirectorInput(input: unknown): StoryboardDirectorInput {
  const source = isRecord(input) ? input : {};
  const specialNotes = firstString(source, INPUT_ALIASES.special_notes);
  const legacyCharacter = firstString(source, INPUT_ALIASES.legacy_character);
  return {
    schema_version: STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION,
    segmented_script: firstString(source, INPUT_ALIASES.segmented_script),
    director_mode: normalizeDirectorMode(firstValue(source, INPUT_ALIASES.director_mode)),
    animation_style: firstString(source, INPUT_ALIASES.animation_style) || STORYBOARD_3D_STYLES[0],
    aspect_ratio: normalizeRatio(firstString(source, INPUT_ALIASES.aspect_ratio)),
    target_duration_seconds: normalizeTargetDuration(firstValue(source, INPUT_ALIASES.target_duration_seconds)),
    special_notes: [legacyCharacter, specialNotes].filter(Boolean).join("；"),
    ...Object.fromEntries((["owner_gender", "dog_breed", "video_model_profile", "visual_asset_mode"] as const)
      .flatMap((key) => {
        const value = firstString(source, INPUT_ALIASES[key]);
        return value ? [[key, value]] : [];
      })),
  };
}

export function estimateNarrationDuration(narration: string): number {
  const compact = narration.replace(/\s+/g, "");
  const spokenCharacters = [...compact.replace(/[，。！？；：、,.!?;:“”‘’'"（）()【】\[\]]/g, "")].length;
  const pauseMarks = (compact.match(/[。！？!?；;]/g) ?? []).length;
  const pauseSeconds = Math.min(0.8, 0.3 + Math.max(0, pauseMarks - 1) * 0.1);
  return Math.round((spokenCharacters / 6 + pauseSeconds) * 10) / 10;
}

export function narrationExceedsGenerationUnit(
  narration: string,
  duration: StoryboardTargetDurationSeconds,
): boolean {
  return estimateNarrationDuration(narration) > duration + 0.8;
}

const SHOT_COUNT_RULES: Record<StoryboardTargetDurationSeconds, Record<StoryboardDirectorMode, readonly [number, number, StoryboardActualShotCount]>> = {
  8: {
    high_energy: [2, 3, 3],
    cinematic: [2, 3, 2],
    lyrical: [1, 2, 1],
  },
  10: {
    high_energy: [3, 4, 4],
    cinematic: [2, 3, 3],
    lyrical: [1, 2, 2],
  },
  15: {
    high_energy: [4, 5, 5],
    cinematic: [3, 4, 4],
    lyrical: [2, 3, 3],
  },
};

export function storyboardShotCountRule(
  duration: StoryboardTargetDurationSeconds,
  mode: StoryboardDirectorMode,
): { min: number; max: number; defaultCount: StoryboardActualShotCount } {
  const [min, max, defaultCount] = SHOT_COUNT_RULES[duration][mode];
  return { min, max, defaultCount };
}

export function parseSegmentedScript(text: string): StoryboardScriptSegment[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  const starts = [...normalized.matchAll(/(?:^|\n)\s*(\d+)\s*(?:\\?\.|、)\s*/g)];
  if (starts.length === 0) {
    return [{ segment_id: "segment_001", source_index: 1, narration: normalized }];
  }

  return starts.flatMap((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = starts[index + 1]?.index ?? normalized.length;
    const narration = normalized
      .slice(start, end)
      .trim()
      .replace(/^【/, "")
      .replace(/】\s*$/, "")
      .trim();
    if (!narration) return [];
    const sourceIndex = Number(match[1]);
    return [{
      segment_id: `segment_${String(sourceIndex).padStart(3, "0")}`,
      source_index: sourceIndex,
      narration,
    }];
  });
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
}

function findMachinePayload(text: string): unknown | null {
  const direct = parseJson(text);
  if (direct) return direct;

  const marker = text.match(/<!--\s*storyboard_director_(?:output|assets|plan):v1\s*([\s\S]*?)-->/i);
  if (marker) {
    const parsed = parseJson(marker[1]);
    if (parsed) return parsed;
  }

  for (const match of text.matchAll(/(`{3,})json\s*\n?([\s\S]*?)\n?\1/gi)) {
    const parsed = parseJson(match[2]);
    if (parsed) return parsed;
  }
  return null;
}

function isDirectorMode(value: unknown): value is StoryboardDirectorMode {
  return typeof value === "string"
    && (STORYBOARD_DIRECTOR_MODES as readonly string[]).includes(value);
}

function isStoryboardLayout(value: unknown): value is StoryboardLayout {
  return typeof value === "string"
    && (STORYBOARD_LAYOUTS as readonly string[]).includes(value);
}

function isPacingMode(value: unknown): value is StoryboardPacingMode {
  return typeof value === "string"
    && (STORYBOARD_PACING_MODES as readonly string[]).includes(value);
}

function defaultPacingMode(mode: StoryboardDirectorMode): StoryboardPacingMode {
  if (mode === "high_energy") return "fast";
  if (mode === "lyrical") return "slow";
  return "medium";
}

function normalizeSemanticVisualizations(value: unknown): StoryboardSemanticVisualization[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const trigger = String(item.trigger ?? "").trim();
    const visualForm = String(item.visual_form ?? item.visualForm ?? "").trim();
    const interaction = String(item.interaction ?? "").trim();
    return trigger && visualForm && interaction
      ? [{ trigger, visual_form: visualForm, interaction }]
      : [];
  });
}

function roundedTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function fallbackShotTimeRanges(
  count: StoryboardActualShotCount,
  duration: StoryboardTargetDurationSeconds,
): StoryboardShotTimeRange[] {
  return Array.from({ length: count }, (_, index) => ({
    shot_id: `shot_${String(index + 1).padStart(2, "0")}`,
    start_seconds: roundedTenth(index * duration / count),
    end_seconds: roundedTenth((index + 1) * duration / count),
    action_beat: `兼容旧输出：第${index + 1}镜动作节拍未单列`,
  }));
}

function normalizeShotTimeRanges(
  value: unknown,
  count: StoryboardActualShotCount,
  duration: StoryboardTargetDurationSeconds,
  allowLegacyFallback = true,
): StoryboardShotTimeRange[] {
  if (!Array.isArray(value) || value.length !== count) {
    return allowLegacyFallback ? fallbackShotTimeRanges(count, duration) : [];
  }
  const parsed = value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const start = Number(item.start_seconds ?? item.start);
    const end = Number(item.end_seconds ?? item.end);
    const actionBeat = String(item.action_beat ?? item.beat ?? item.action ?? "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !actionBeat) return [];
    return [{
      shot_id: String(item.shot_id ?? item.id ?? `shot_${String(index + 1).padStart(2, "0")}`),
      start_seconds: roundedTenth(start),
      end_seconds: roundedTenth(end),
      action_beat: actionBeat,
    }];
  });
  return parsed.length === count ? parsed : allowLegacyFallback ? fallbackShotTimeRanges(count, duration) : [];
}

function fallbackContinuityLinks(count: StoryboardActualShotCount): StoryboardContinuityLink[] {
  return Array.from({ length: Math.max(0, count - 1) }, (_, index) => ({
    from_shot: `shot_${String(index + 1).padStart(2, "0")}`,
    to_shot: `shot_${String(index + 2).padStart(2, "0")}`,
    link_type: "legacy_continuity",
    description: "兼容旧输出：沿主体运动方向与视线连续衔接",
  }));
}

function normalizeContinuityLinks(
  value: unknown,
  count: StoryboardActualShotCount,
  allowLegacyFallback = true,
): StoryboardContinuityLink[] {
  if (!Array.isArray(value)) return allowLegacyFallback ? fallbackContinuityLinks(count) : [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const fromShot = String(item.from_shot ?? item.from ?? "").trim();
    const toShot = String(item.to_shot ?? item.to ?? "").trim();
    const linkType = String(item.link_type ?? item.type ?? "").trim();
    const description = String(item.description ?? item.link ?? "").trim();
    return fromShot && toShot && linkType && description
      ? [{ from_shot: fromShot, to_shot: toShot, link_type: linkType, description }]
      : [];
  });
}

export function parseStoryboardDirectorPackage(text: string): StoryboardDirectorPackage | null {
  const parsed = findMachinePayload(text);
  if (!isRecord(parsed)) return null;
  const source = isRecord(parsed.package) ? parsed.package : parsed;
  if (source.schema_version !== STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION
    || source.artifact_type !== STORYBOARD_DIRECTOR_ARTIFACT_TYPE
    || !isDirectorMode(source.director_mode)
    || !isRecord(source.input)
    || !Array.isArray(source.segments)) {
    return null;
  }

  if (source.production_contract_version !== undefined
    && source.production_contract_version !== STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION) return null;
  if (source.phase !== undefined && source.phase !== "storyboard") return null;
  const strictContract = source.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  if (strictContract) {
    const strictInput = source.input;
    if (strictInput.schema_version !== STORYBOARD_DIRECTOR_INPUT_SCHEMA_VERSION
      || ["segmented_script", "animation_style", "video_model_profile", "visual_asset_mode"]
      .some((key) => typeof strictInput[key] !== "string" || !String(strictInput[key]).trim())
      || ["owner_gender", "dog_breed"].some(key => strictInput[key] !== undefined
        && (typeof strictInput[key] !== "string" || !String(strictInput[key]).trim()))
      || typeof strictInput.special_notes !== "string"
      || strictInput.director_mode !== source.director_mode
      || !["16:9", "9:16"].includes(String(strictInput.aspect_ratio))
      || !STORYBOARD_TARGET_DURATIONS.includes(strictInput.target_duration_seconds as StoryboardTargetDurationSeconds)) return null;
  }
  const input = normalizeStoryboardDirectorInput(source.input);
  const directorMode = source.director_mode;
  const wardrobePlan = normalizeWardrobePlan(source.wardrobe_plan ?? source.wardrobePlan);
  if ((source.wardrobe_plan !== undefined || source.wardrobePlan !== undefined) && !wardrobePlan) return null;
  const visualAssetPlan = normalizeVisualAssetPlan(source.visual_asset_plan ?? source.visualAssetPlan);
  if ((source.visual_asset_plan !== undefined || source.visualAssetPlan !== undefined) && !visualAssetPlan) return null;
  const environmentGroups = normalizeEnvironmentGroups(source.environment_groups ?? source.environmentGroups);
  if ((source.environment_groups !== undefined || source.environmentGroups !== undefined) && !environmentGroups) return null;
  input.director_mode = directorMode;
  const segments = source.segments.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    if (strictContract && (
      !Number.isInteger(item.source_index) || Number(item.source_index) < 1
      || typeof item.segment_id !== "string" || !item.segment_id.trim()
      || !isStoryboardLayout(item.layout) || !isPacingMode(item.pacing_mode)
      || !Number.isInteger(item.actual_shot_count)
      || !Array.isArray(item.character_assets) || !Array.isArray(item.character_asset_ids)
      || item.character_asset_ids.length !== item.character_assets.length
      || item.character_asset_ids.some(id => typeof id !== "string" || !/^[a-z][a-z0-9_-]{2,63}$/.test(id))
      || new Set(item.character_asset_ids).size !== item.character_asset_ids.length
      || item.character_assets.some(asset => typeof asset !== "string" || !asset.trim())
      || !STORYBOARD_TARGET_DURATIONS.includes(item.target_duration_seconds as StoryboardTargetDurationSeconds)
      || !Array.isArray(item.shot_time_ranges) || item.shot_time_ranges.length !== item.actual_shot_count
      || item.shot_time_ranges.some((range) => !isRecord(range)
        || typeof range.shot_id !== "string" || !range.shot_id.trim()
        || typeof range.start_seconds !== "number" || !Number.isFinite(range.start_seconds)
        || typeof range.end_seconds !== "number" || !Number.isFinite(range.end_seconds)
        || typeof range.action_beat !== "string" || !range.action_beat.trim())
      || !Array.isArray(item.continuity_links)
      || item.continuity_links.some((link) => !isRecord(link)
        || ["from_shot", "to_shot", "link_type", "description"].some(key => typeof link[key] !== "string" || !String(link[key]).trim()))
    )) return [];
    const narration = String(item.narration ?? "").trim();
    const performance = item.performance_plan === undefined ? undefined : StoryboardPerformancePlanSchema.safeParse(item.performance_plan);
    if (performance && !performance.success) return [];
    const imagePrompt = String(item.storyboard_image_prompt ?? "").trim();
    const videoPrompt = String(item.image_to_video_prompt ?? "").trim();
    const panelCount = Number(item.panel_count ?? item.frame_count);
    if (!narration || !imagePrompt || !videoPrompt || (panelCount !== 4 && panelCount !== 5)) {
      return [];
    }
    const layout = isStoryboardLayout(item.layout)
      ? item.layout
      : panelCount === 5 ? "four_plus_panorama" : "two_by_two";
    const bottomPanelRole = normalizeBottomPanelRole(item.bottom_panel_role ?? item.bottomPanelRole, panelCount as 4 | 5);
    if (!bottomPanelRole) return [];
    const pacingMode = isPacingMode(item.pacing_mode)
      ? item.pacing_mode
      : defaultPacingMode(directorMode);
    const targetDuration = normalizeTargetDuration(item.target_duration_seconds ?? input.target_duration_seconds);
    const shotRule = storyboardShotCountRule(targetDuration, directorMode);
    const requestedShotCount = Number(item.actual_shot_count);
    const actualShotCount = requestedShotCount >= 1 && requestedShotCount <= 5
      ? requestedShotCount as StoryboardActualShotCount
      : shotRule.defaultCount;
    const sourceIndex = Number(item.source_index) || index + 1;
    const estimatedNarrationDuration = Number(item.estimated_narration_duration);
    if (item.visual_asset_refs !== undefined && !Array.isArray(item.visual_asset_refs)) return [];
    const visualAssetRefs = normalizeVisualAssetRefs(item.visual_asset_refs);
    if (Array.isArray(item.visual_asset_refs) && visualAssetRefs?.length !== item.visual_asset_refs.length) return [];
    const dynamicStateValue = item.dynamic_state ?? item.dynamicState;
    const capabilityGapsValue = item.capability_gaps ?? item.capabilityGaps;
    const styleLock = String(item.style_lock ?? item.styleLock ?? "").trim();
    const sceneLock = String(item.scene_lock ?? item.sceneLock ?? "").trim();
    if (styleLock && (styleLock.length < 20 || styleLock.length > 500)) return [];
    if (sceneLock && (sceneLock.length < 12 || sceneLock.length > 500)) return [];
    const wardrobeChangeEventsValue = item.wardrobe_change_events ?? item.wardrobeChangeEvents;
    const qualityChecksValue = item.quality_checks ?? item.qualityChecks;
    const wardrobeChangeEvents = normalizeWardrobeChangeEvents(wardrobeChangeEventsValue);
    const qualityChecks = normalizeQualityChecks(qualityChecksValue);
    if (Array.isArray(wardrobeChangeEventsValue)
      && wardrobeChangeEvents?.length !== wardrobeChangeEventsValue.length) return [];
    if (Array.isArray(qualityChecksValue)
      && qualityChecks?.length !== qualityChecksValue.length) return [];
    return [{
      segment_id: String(item.segment_id ?? `segment_${String(sourceIndex).padStart(3, "0")}`),
      source_index: sourceIndex,
      narration,
      target_duration_seconds: targetDuration,
      estimated_narration_duration: Number.isFinite(estimatedNarrationDuration) && estimatedNarrationDuration > 0
        ? roundedTenth(estimatedNarrationDuration)
        : estimateNarrationDuration(narration),
      panel_count: panelCount as 4 | 5,
      layout,
      pacing_mode: pacingMode,
      actual_shot_count: actualShotCount,
      shot_time_ranges: normalizeShotTimeRanges(item.shot_time_ranges, actualShotCount, targetDuration, !strictContract),
      panoramic_anchor_role: panelCount === 4
        ? null
        : String(item.panoramic_anchor_role ?? "legacy_unspecified").trim() || "legacy_unspecified",
      bottom_panel_role: bottomPanelRole,
      continuity_links: normalizeContinuityLinks(item.continuity_links, actualShotCount, !strictContract),
      character_assets: Array.isArray(item.character_assets)
        ? item.character_assets.map(String).map((value) => value.trim()).filter(Boolean)
        : [],
      ...(Array.isArray(item.character_asset_ids) ? { character_asset_ids: item.character_asset_ids.map(String) } : {}),
      ...(visualAssetRefs ? { visual_asset_refs: visualAssetRefs } : {}),
      ...(wardrobeChangeEvents ? { wardrobe_change_events: wardrobeChangeEvents } : {}),
      ...(qualityChecks ? { quality_checks: qualityChecks } : {}),
      ...(String(item.scene_id ?? item.sceneId ?? "").trim() ? { scene_id: String(item.scene_id ?? item.sceneId).trim() } : {}),
      ...(String(item.scene_zone ?? item.sceneZone ?? "").trim() ? { scene_zone: String(item.scene_zone ?? item.sceneZone).trim() } : {}),
      ...(styleLock ? { style_lock: styleLock } : {}),
      ...(sceneLock ? { scene_lock: sceneLock } : {}),
      ...(String(item.camera ?? "").trim() ? { camera: String(item.camera).trim() } : {}),
      ...(Array.isArray(dynamicStateValue) ? { dynamic_state: dynamicStateValue.map((value) => String(value).trim()).filter(Boolean).slice(0, 16) } : {}),
      ...(Array.isArray(capabilityGapsValue) ? { capability_gaps: capabilityGapsValue.map((value) => String(value).trim()).filter(Boolean).slice(0, 16) } : {}),
      semantic_visualizations: normalizeSemanticVisualizations(item.semantic_visualizations),
      ...(performance?.success ? { performance_plan: performance.data } : {}),
      storyboard_image_prompt: imagePrompt,
      image_to_video_prompt: videoPrompt,
    }];
  });

  if (segments.length !== source.segments.length) return null;
  return {
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    director_mode: directorMode,
    input,
    ...(strictContract ? { production_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION } : {}),
    ...(strictContract ? { phase: "storyboard" as const } : {}),
    ...(wardrobePlan ? { wardrobe_plan: wardrobePlan } : {}),
    ...(visualAssetPlan ? { visual_asset_plan: visualAssetPlan } : {}),
    ...(environmentGroups ? { environment_groups: environmentGroups } : {}),
    segments,
  };
}

function assetsAsStoryboardPackage(pkg: StoryboardDirectorAssetsPackage): StoryboardDirectorPackage {
  return { ...pkg, schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE, phase: "storyboard", segments: [] };
}

export function storyboardDirectorPlanAsStoryboardPackage(pkg: StoryboardDirectorPlanPackage): StoryboardDirectorPackage {
  return { ...pkg, schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE, phase: "storyboard" };
}

export function parseStoryboardDirectorPlanPackage(text: string): StoryboardDirectorPlanPackage | null {
  const parsed = findMachinePayload(text);
  if (!isRecord(parsed)) return null;
  const source = isRecord(parsed.package) ? parsed.package : parsed;
  if (source.schema_version !== STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION
    || source.artifact_type !== STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE
    || source.production_contract_version !== STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    || source.phase !== "planned") return null;
  const rawPlan = source.visual_asset_plan;
  if (!isRecord(rawPlan) || rawPlan.mode !== "selected" || !Array.isArray(rawPlan.assets)) return null;
  // Normalize creative intent through the existing production parser. Model
  // media metadata must never become an adopted source or an execution receipt.
  const normalized = parseStoryboardDirectorPackage(JSON.stringify({ ...source,
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION, artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    phase: "storyboard", visual_asset_plan: { ...rawPlan, assets: rawPlan.assets.map(asset => {
      if (!isRecord(asset)) return asset;
      const intent = { ...asset };
      delete intent.source;
      delete intent.derived_from_asset_id;
      return intent;
    }) } }));
  if (!normalized?.visual_asset_plan || normalized.visual_asset_plan.mode !== "selected") return null;
  return { ...normalized, schema_version: STORYBOARD_DIRECTOR_PLAN_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_PLAN_ARTIFACT_TYPE,
    production_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION, phase: "planned",
    visual_asset_plan: normalized.visual_asset_plan,
    segments: normalized.segments.map(segment => ({ ...segment,
      ...(segment.quality_checks ? { quality_checks: segment.quality_checks.map(check => check.verification?.kind === "visual_asset_binding"
        ? { ...check, status: "unknown" as const, detail: "角色参考图须在工作台生成并由用户逐项确认后核验。" } : check) } : {}),
    })) };
}

export function validateStoryboardDirectorPlanPackage(pkg: StoryboardDirectorPlanPackage, expectedInput?: StoryboardDirectorInput): string[] {
  const issues = validateStoryboardDirectorPackage(storyboardDirectorPlanAsStoryboardPackage(pkg), expectedInput,
    { stage: "planning", requirePerformancePlan: true });
  if (pkg.visual_asset_plan.mode !== "selected") issues.push("planned_phase_requires_selected_plan");
  if (pkg.visual_asset_plan.assets.some(asset => asset.source !== undefined || asset.derived_from_asset_id !== undefined)) issues.push("planned_phase_forbids_media_receipts");
  const assets = new Map(pkg.visual_asset_plan.assets.map(asset => [asset.id, asset]));
  if (assets.size !== pkg.visual_asset_plan.assets.length) issues.push("planned_phase_duplicate_asset_id");
  for (const segment of pkg.segments) {
    const actorIds = segment.character_asset_ids || [];
    const refs = (segment.visual_asset_refs || []).filter(ref => ref.role === "character" || ref.role === "pet");
    if (new Set(refs.map(ref => ref.asset_id)).size !== refs.length || refs.length !== actorIds.length
      || actorIds.some(id => !refs.some(ref => ref.asset_id === id && ref.role === assets.get(id)?.role && ref.reference_kinds.includes("turnaround")))) {
      issues.push(`${segment.segment_id}:planned_actor_turnaround_refs_incomplete`);
    }
  }
  return [...new Set(issues)];
}

export function renderStoryboardDirectorPlanVisibleOutput(pkg: StoryboardDirectorPlanPackage): string {
  return ["已完成角色三视图、分镜图与视频的完整文字计划，尚未生成图片或视频。推送工作台后先生成并逐项确认角色参考图，再执行分镜图和视频；无需返回智能体。",
    renderStoryboardDirectorBody(storyboardDirectorPlanAsStoryboardPackage(pkg))].join("\n\n");
}

export function parseStoryboardDirectorAssetsPackage(text: string): StoryboardDirectorAssetsPackage | null {
  const parsed = findMachinePayload(text);
  if (!isRecord(parsed)) return null;
  const source = isRecord(parsed.package) ? parsed.package : parsed;
  if (source.schema_version !== STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION
    || source.artifact_type !== STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE
    || source.production_contract_version !== STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION
    || source.phase !== "assets" || Object.hasOwn(source, "segments")) return null;
  const normalized = parseStoryboardDirectorPackage(JSON.stringify({ ...source,
    schema_version: STORYBOARD_DIRECTOR_OUTPUT_SCHEMA_VERSION, artifact_type: STORYBOARD_DIRECTOR_ARTIFACT_TYPE,
    phase: "storyboard", segments: [] }));
  if (!normalized?.visual_asset_plan) return null;
  const { segments: _segments, ...rest } = normalized;
  return { ...rest, schema_version: STORYBOARD_DIRECTOR_ASSETS_SCHEMA_VERSION,
    artifact_type: STORYBOARD_DIRECTOR_ASSETS_ARTIFACT_TYPE,
    production_contract_version: STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION,
    phase: "assets", visual_asset_plan: normalized.visual_asset_plan };
}

export function validateStoryboardDirectorAssetsPackage(pkg: StoryboardDirectorAssetsPackage, expectedInput?: StoryboardDirectorInput): string[] {
  const issues = validateStoryboardDirectorPackage(assetsAsStoryboardPackage(pkg), expectedInput, { assetsOnly: true, stage: "planning" });
  if (pkg.visual_asset_plan.mode !== "selected") issues.push("assets_phase_requires_selected_plan");
  return [...new Set(issues)];
}

export function renderStoryboardDirectorAssetsVisibleOutput(pkg: StoryboardDirectorAssetsPackage): string {
  return ["请先在分镜工作台生成并采用计划中所需的角色参考图，完成后使用续写卡继续生成分镜。",
    renderStoryboardDirectorVisibleOutput(assetsAsStoryboardPackage(pkg), { assetsOnly: true })].join("\n\n");
}

function fenced(language: "text" | "json", value: string): string {
  const longestRun = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

/** Visible copy and one-click import share these exact package strings. */
export function renderStoryboardDirectorVisibleOutput(
  pkg: StoryboardDirectorPackage,
  options: { hostVerifiedReferenceAssets?: boolean; assetsOnly?: boolean; expectedInput?: StoryboardDirectorInput } = {},
): string {
  // Prompt text is readable before any image exists. Adopted sources are
  // independently checked by the workbench immediately before media requests.
  void options;
  return renderStoryboardDirectorBody(pkg);
}

/**
 * Return true only for findings that describe a repairable prompt-quality
 * defect.  These findings do not change the source card, selected mode,
 * identity bindings, or media ownership, so a host may keep the package
 * importable while showing the finding for repair.  Input, segment, mode,
 * asset, role, timeline, layout, and safety findings intentionally remain
 * hard gates.
 */
const QUALITY_WARNING_ISSUE_CODES = new Set([
  "performance_plan_required",
  "performance_peak_shot_unknown",
  "performance_image_excerpt_missing",
  "performance_video_excerpt_missing",
  "invalid_style_lock",
  "invalid_scene_lock",
  "style_lock_not_repeated_in_image_prompt",
  "scene_lock_not_repeated_in_image_prompt",
  "style_lock_not_repeated_in_video_prompt",
  "scene_lock_not_repeated_in_video_prompt",
  "invalid_narration_duration_estimate",
  "overload_without_split_recommendation",
  "missing_semantic_visualization",
  "video_prompt_not_actionable",
  "missing_audio_boundary",
]);

export function isQualityWarningIssue(issue: string): boolean {
  const raw = String(issue || "").trim();
  if (!raw) return false;
  const code = raw.includes(":") ? raw.slice(raw.indexOf(":") + 1) : raw;
  return QUALITY_WARNING_ISSUE_CODES.has(code);
}

function renderStoryboardDirectorBody(pkg: StoryboardDirectorPackage): string {
  const sections = pkg.segments.map((segment) => [
    `**段落 ${segment.source_index}**：${segment.narration}`,
    `**故事板布局**：${segment.panel_count}格｜底部面板角色：${segment.bottom_panel_role ?? (segment.panel_count === 5 ? "panorama" : "none")}`,
    ...(segment.style_lock ? [`**风格锁**：${segment.style_lock}`] : []),
    ...(segment.scene_lock ? [`**场景锁**：${segment.scene_lock}`] : []),
    ...(segment.performance_plan ? [`**演绎重点**：${segment.performance_plan.semantic_event}`,
      `**主峰**：${STORYBOARD_PERFORMANCE_MODE_LABELS[segment.performance_plan.mode]}；**段末**：${segment.performance_plan.end_state}`] : []),
    "",
    `**生图 Prompt（${segment.panel_count}格故事板）**`,
    fenced("text", segment.storyboard_image_prompt),
    "",
    `**图生视频 Prompt（${segment.target_duration_seconds}秒 / ${segment.actual_shot_count}镜）**`,
    fenced("text", segment.image_to_video_prompt),
  ].join("\n"));

  return [
    ...(pkg.visual_asset_plan?.mode === "selected" ? pkg.visual_asset_plan.assets.flatMap((asset) => [
      `**视觉资产：${asset.name}**`,
      `身份与衣着：${asset.identity_lock}`,
      ...asset.reference_prompts.flatMap((reference) => [
        `**${reference.kind === "turnaround" ? "三视图" : reference.purpose}生图 Prompt**`,
        fenced("text", reference.prompt),
      ]),
    ]) : []),
    ...(pkg.wardrobe_plan ? [
      "**全局服装计划**",
      `基础造型：${pkg.wardrobe_plan.base_look}`,
      `连续规则：${pkg.wardrobe_plan.continuity_rule}`,
      `换装事件：${pkg.wardrobe_plan.change_events.length ? JSON.stringify(pkg.wardrobe_plan.change_events) : "无"}`,
      "",
    ] : []),
    ...sections,
  ].join("\n\n");
}

export function renderStoryboardDirectorPackage(pkg: StoryboardDirectorPackage): string {
  return [renderStoryboardDirectorVisibleOutput(pkg), "**机器 JSON 包**", fenced("json", JSON.stringify(pkg, null, 2))].join("\n\n");
}

function hasExplicitAudioBoundary(text: string): boolean {
  // Require an audio directive with a scoped object, not an isolated sound noun
  // or a visual/written description. This checks a boundary, not source-policy compliance.
  const clauses = text.split(/[，,。；;！!？?\n]/u);
  return clauses.some((value) => {
    const clause = value.trim().replace(/^(?:声音(?:边界|设计)?|音频|音轨|声轨|音效)\s*[：:]\s*/u, "");
    if (/[“”"'「」]|(?:写下|写出|书写|字样|标语|字幕显示|画面呈现)/u.test(clause)) return false;
    if (/^(?:角色|人物|宠物)?(?:无对白|无旁白|不说话|静音|无声)(?=$|[、和与或\s])/u.test(clause)) return true;
    const directive = clause.match(/^(?:(?:只|仅)?(?:保留|留)|只有|仅有|不(?:生成|添加|加入|产生|使用|要)|禁止(?:生成|添加|加入)?|无需|无)\s*(?:任何)?(.+)$/u);
    if (!directive) return false;
    // A restriction on deleting speech, on a caption saying "no speech", or on
    // visible breathing is not a restriction on the actual soundtrack.
    const objects = directive[1].split(/[、和与或及]/u).map((item) => item.trim()).filter(Boolean);
    if (objects.some((object) => object !== "字幕" && /(?:不|无|没|删除|取消|避免|禁止|允许|需要|要求|保留|生成|添加|加入|^说|写|文字|字幕|画面|动作|波形|图示|标记|检查)/u.test(object))) return false;
    return objects.some((object) => /^[\p{L}\p{N}\s]{0,40}(?:声(?:音)?|音效|底噪|呼吸|鼻息|轻响|口播|对白|旁白|配音|音乐|音轨|声轨)$/u.test(object));
  });
}

export function validateStoryboardDirectorPackage(
  pkg: StoryboardDirectorPackage,
  expectedInput?: StoryboardDirectorInput,
  options: { stage?: "strict" | "planning"; allowLegacyMissingChoices?: boolean; assetsOnly?: boolean; requirePerformancePlan?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const strictContract = pkg.production_contract_version === STORYBOARD_DIRECTOR_PRODUCTION_CONTRACT_VERSION;
  const expectedSegments = expectedInput ? parseSegmentedScript(expectedInput.segmented_script) : [];
  if (expectedInput) {
    const fields = ["segmented_script", "director_mode", "animation_style", "aspect_ratio", "target_duration_seconds", "special_notes",
      "owner_gender", "dog_breed", "video_model_profile", "visual_asset_mode"] as const;
    for (const field of fields) {
      const expected = expectedInput[field];
      // Older cards did not have the four extended choices. Never manufacture
      // those choices while checking their historic output.
      if (expected === undefined && !strictContract) continue;
      // Owner/breed are scoped optional choices. Matching omission is valid;
      // a model-supplied choice that the card never submitted still mismatches.
      if (expected === undefined && pkg.input[field] === undefined && (field === "owner_gender" || field === "dog_breed")) continue;
      if (!strictContract && options.allowLegacyMissingChoices && pkg.input[field] === undefined
        && ["owner_gender", "dog_breed", "video_model_profile", "visual_asset_mode"].includes(field)) continue;
      if (expected === undefined || pkg.input[field] !== expected) {
        issues.push(field === "target_duration_seconds" ? "input_target_duration_mismatch" : `input_${field}_mismatch`);
      }
    }
    if (pkg.director_mode !== expectedInput.director_mode) issues.push("expected_director_mode_mismatch");
  }
  if (!pkg.input.segmented_script.trim() || (!options.assetsOnly && !pkg.segments.length)) issues.push("missing_script_or_segments");
  if (pkg.input.director_mode !== pkg.director_mode) {
    issues.push("input_director_mode_mismatch");
  }
  if (!options.assetsOnly && expectedSegments.length && expectedSegments.length !== pkg.segments.length) {
    issues.push("segment_count_mismatch");
  }

  // A segment may only bind assets declared by the project-level plan.  This
  // keeps the machine package deterministic and prevents a stale or forged
  // asset id from silently becoming a reference image in the workbench.
  const declaredAssets = new Map((pkg.visual_asset_plan?.assets || []).map((asset) => [asset.id, asset]));
  const visualAssetMode = pkg.visual_asset_plan?.mode || "off";
  if (visualAssetMode === "off" && pkg.visual_asset_plan?.assets.length) {
    issues.push("visual_asset_plan_off_with_assets");
  }
  const requestsReferenceAssets = ["参考图模式", "角色参考模式", "角色参考图模式", "selected", "reference"].includes(pkg.input.visual_asset_mode || "");
  const requestsOrdinaryMode = ["普通模式", "off", "ordinary", "串联模式", "连续串联模式", "chained"].includes(pkg.input.visual_asset_mode || "");
  const explicitlyRequestsFivePanels = pkg.input.special_notes.split(/[。；;\n]/).some(clause => (
    /(?:5\s*格|五格|5[- ]?panels?|five[- ]?panels?)/i.test(clause)
    && !/(?:不要|不选|不用|不使用|不采用|禁止|不得|避免|拒绝|\bno\b|\bnot\b|\bavoid\b)/i.test(clause)
  ));
  if (strictContract) {
    if (!requestsReferenceAssets && !requestsOrdinaryMode) issues.push("unknown_visual_asset_mode");
    if (requestsOrdinaryMode && visualAssetMode !== "off") issues.push("ordinary_mode_must_not_bind_reference_assets");
    if (requestsReferenceAssets) {
      if (visualAssetMode !== "selected") issues.push("reference_mode_requires_selected_asset_plan");
      if (!pkg.visual_asset_plan?.generation_policy) issues.push("reference_mode_requires_generation_policy");
      // A reference plan follows the roles that the story actually declares.
      // Do not manufacture a character or pet requirement for a story that has
      // only the other role (or a different supported visual asset role).
      for (const role of ["character", "pet"] as const) {
        const assets = pkg.visual_asset_plan?.assets.filter(asset => asset.role === role) || [];
        if (assets.some(asset => !asset.reference_prompts.some(reference => reference.kind === "turnaround"))) {
          issues.push(`reference_mode_requires_${role}_turnaround`);
        }
      }
    }
  }

  const identityLocksById = new Map<string, string>();
  const identityIdsByLabel = new Map<string, string>();
  for (const [index, segment] of pkg.segments.entries()) {
    let explicitActorlessPerformance = false;
    if (options.requirePerformancePlan && segment.performance_plan === undefined) issues.push(`${segment.segment_id}:performance_plan_required`);
    if (segment.performance_plan !== undefined) {
      const performanceIssues = validateStoryboardPerformancePlan(segment.performance_plan, {
        shotIds: segment.shot_time_ranges.map(shot => shot.shot_id), actorIds: segment.character_asset_ids || [],
        ...(visualAssetMode === "selected" ? { referenceRoles: new Map((pkg.visual_asset_plan?.assets || []).map(asset => [asset.id, asset.role])) } : {}),
        imagePrompt: segment.storyboard_image_prompt, videoPrompt: segment.image_to_video_prompt,
      });
      issues.push(...performanceIssues.map(issue => `${segment.segment_id}:${issue}`));
      if (segment.performance_plan.cast_presence === "none") {
        if (segment.character_assets.length || (segment.visual_asset_refs || []).some(ref => ref.role === "character" || ref.role === "pet")) {
          issues.push(`${segment.segment_id}:performance_cast_presence_actor_mismatch`);
        }
        explicitActorlessPerformance = performanceIssues.length === 0
          && Array.isArray(segment.character_asset_ids) && segment.character_asset_ids.length === 0;
      }
    }
    const expected = expectedSegments[index];
    if (expected && (segment.source_index !== expected.source_index || segment.narration !== expected.narration)) {
      issues.push(`${segment.segment_id}:source_not_preserved`);
    }
    if (segment.target_duration_seconds !== pkg.input.target_duration_seconds) {
      issues.push(`${segment.segment_id}:target_duration_mismatch`);
    }
    if (segment.style_lock !== undefined && (segment.style_lock.length < 20 || segment.style_lock.length > 500)) {
      issues.push(`${segment.segment_id}:invalid_style_lock`);
    }
    if (segment.scene_lock !== undefined && (segment.scene_lock.length < 12 || segment.scene_lock.length > 500)) {
      issues.push(`${segment.segment_id}:invalid_scene_lock`);
    }
    if (segment.style_lock && !segment.storyboard_image_prompt.includes(segment.style_lock)) {
      issues.push(`${segment.segment_id}:style_lock_not_repeated_in_image_prompt`);
    }
    if (segment.scene_lock && !segment.storyboard_image_prompt.includes(segment.scene_lock)) {
      issues.push(`${segment.segment_id}:scene_lock_not_repeated_in_image_prompt`);
    }
    if (segment.style_lock && !segment.image_to_video_prompt.includes(segment.style_lock)) {
      issues.push(`${segment.segment_id}:style_lock_not_repeated_in_video_prompt`);
    }
    if (segment.scene_lock && !segment.image_to_video_prompt.includes(segment.scene_lock)) {
      issues.push(`${segment.segment_id}:scene_lock_not_repeated_in_video_prompt`);
    }
    const expectedNarrationDuration = estimateNarrationDuration(segment.narration);
    if (!Number.isFinite(segment.estimated_narration_duration)
      || segment.estimated_narration_duration <= 0
      || segment.estimated_narration_duration > segment.target_duration_seconds + 1) {
      issues.push(`${segment.segment_id}:invalid_narration_duration_estimate`);
    }
    if (segment.panel_count !== 4 && segment.panel_count !== 5) {
      issues.push(`${segment.segment_id}:invalid_panel_count`);
    }
    const expectedLayout = segment.panel_count === 5 ? "four_plus_panorama" : "two_by_two";
    if (segment.layout !== expectedLayout) {
      issues.push(`${segment.segment_id}:layout_panel_count_mismatch`);
    }
    if (segment.panel_count === 4 && segment.panoramic_anchor_role !== null) {
      issues.push(`${segment.segment_id}:unexpected_panorama_role`);
    }
    if (segment.panel_count === 5
      && (!segment.panoramic_anchor_role || segment.panoramic_anchor_role === "legacy_unspecified")) {
      issues.push(`${segment.segment_id}:missing_panorama_role`);
    }
    if (segment.panel_count === 4 && segment.bottom_panel_role !== undefined && segment.bottom_panel_role !== "none") {
      issues.push(`${segment.segment_id}:unexpected_bottom_panel_role`);
    }
    if (segment.panel_count === 5 && segment.bottom_panel_role !== undefined && segment.bottom_panel_role === "none") {
      issues.push(`${segment.segment_id}:missing_bottom_panel_role`);
    }
    if (segment.scene_id && pkg.environment_groups?.length) {
      const scene = pkg.environment_groups.find((group) => group.scene_id === segment.scene_id);
      if (!scene) issues.push(`${segment.segment_id}:unknown_scene_id`);
      if (scene?.scene_zone && segment.scene_zone && scene.scene_zone !== segment.scene_zone) {
        issues.push(`${segment.segment_id}:scene_zone_mismatch`);
      }
    }
    for (const check of segment.quality_checks || []) {
      const verification = check.verification;
      const refIds = (segment.visual_asset_refs || []).map(ref => ref.asset_id);
      const bindingValid = verification?.kind === "visual_asset_binding"
        && Object.keys(verification).every(key => key === "kind" || key === "asset_ids")
        && Array.isArray(verification.asset_ids) && verification.asset_ids.length > 0 && verification.asset_ids.length <= 16
        && verification.asset_ids.every(id => typeof id === "string" && /^[a-z][a-z0-9_-]{2,63}$/u.test(id))
        && new Set(verification.asset_ids).size === verification.asset_ids.length
        && visualAssetMode === "selected" && new Set(refIds).size === refIds.length
        && verification.asset_ids.length === refIds.length
        && verification.asset_ids.every(id => refIds.includes(id) && declaredAssets.has(id))
        && (segment.visual_asset_refs || []).every(ref => declaredAssets.get(ref.asset_id)?.role === ref.role);
      if (verification !== undefined && !bindingValid) issues.push(`${segment.segment_id}:invalid_quality_check_verification`);
      if (check.status !== "pass" && !(options.stage === "planning" && check.status === "unknown" && bindingValid)) {
        issues.push(`${segment.segment_id}:quality_check_${check.status}`);
      }
    }
    // Layout is authoritative in the machine fields; prompt prose may be localized.
    const assertedLayoutText = segment.storyboard_image_prompt
      .split(/\r?\n/)
      .filter((line) => !/(?:禁止|不得|严禁|do not|avoid)/i.test(line))
      .join("\n");
    if (/(?:上|top)\s*2\s*(?:下|bottom)\s*3|2\s*\+\s*3|(?:五|5)格等宽|five equal(?:-width)? panels/i.test(assertedLayoutText)) {
      issues.push(`${segment.segment_id}:forbidden_two_plus_three_layout`);
    }
    const shotRule = storyboardShotCountRule(segment.target_duration_seconds, pkg.director_mode);
    if (segment.actual_shot_count < shotRule.min || segment.actual_shot_count > shotRule.max) {
      issues.push(`${segment.segment_id}:invalid_actual_shot_count_for_duration_and_mode`);
    }
    // The machine package carries the authoritative shot count and precise
    // ranges. Human-facing prompts may use a terse style, so do not reject a
    // valid structured package merely because prose does not repeat metadata.
    if (/Frame\s*1\s*(?:至|到|-)\s*Frame\s*[45].{0,24}(?:依次|连续|逐格)|(?:四|五|4|5)格每格.{0,12}秒/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:video_prompt_forces_panel_cuts`);
    }
    if (segment.shot_time_ranges.length !== segment.actual_shot_count) {
      issues.push(`${segment.segment_id}:shot_time_range_count_mismatch`);
    } else {
      const firstRange = segment.shot_time_ranges[0];
      const lastRange = segment.shot_time_ranges.at(-1);
      if (!firstRange || Math.abs(firstRange.start_seconds) > 0.11
        || !lastRange || Math.abs(lastRange.end_seconds - segment.target_duration_seconds) > 0.11) {
        issues.push(`${segment.segment_id}:shot_time_ranges_do_not_cover_duration`);
      }
      for (const [rangeIndex, range] of segment.shot_time_ranges.entries()) {
        if (range.end_seconds <= range.start_seconds || !range.action_beat.trim()) {
          issues.push(`${segment.segment_id}:invalid_shot_time_range`);
        }
        const next = segment.shot_time_ranges[rangeIndex + 1];
        if (next && Math.abs(range.end_seconds - next.start_seconds) > 0.11) {
          issues.push(`${segment.segment_id}:shot_time_ranges_not_contiguous`);
        }
      }
    }
    if (segment.continuity_links.length !== Math.max(0, segment.actual_shot_count - 1)) {
      issues.push(`${segment.segment_id}:continuity_link_count_mismatch`);
    }
    if (narrationExceedsGenerationUnit(segment.narration, segment.target_duration_seconds)
      && !/(?:建议|需要|应当)?.{0,8}(?:拆分|拆为).{0,12}(?:下一|后续)?(?:生成)?单元/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:overload_without_split_recommendation`);
    }
    if (segment.character_assets.length === 0 && !explicitActorlessPerformance) {
      issues.push(`${segment.segment_id}:missing_character_assets`);
    }
    if (strictContract) {
      if (segment.panel_count !== (explicitlyRequestsFivePanels ? 5 : 4)) {
        issues.push(`${segment.segment_id}:panel_count_does_not_match_project_choice`);
      }
      if (segment.character_assets.some(asset => !segment.storyboard_image_prompt.includes(asset))) {
        issues.push(`${segment.segment_id}:character_asset_lock_not_repeated_in_image_prompt`);
      }
      const identityIds = segment.character_asset_ids || [];
      if (identityIds.length !== segment.character_assets.length || new Set(identityIds).size !== identityIds.length
        || identityIds.some(id => !/^[a-z][a-z0-9_-]{2,63}$/.test(id))) {
        issues.push(`${segment.segment_id}:invalid_character_asset_ids`);
      } else {
        const changeEvents = [...(pkg.wardrobe_plan?.change_events || []), ...(segment.wardrobe_change_events || [])]
          .filter(event => event.segment_id === segment.segment_id);
        for (const [assetIndex, id] of identityIds.entries()) {
          const currentLock = segment.character_assets[assetIndex];
          // A stable named identity cannot bypass continuity by receiving a new ID.
          const identityLabel = currentLock.split(/[：:,，；;]/u, 1)[0].trim();
          const registeredId = identityIdsByLabel.get(identityLabel);
          if (registeredId && registeredId !== id) issues.push(`${segment.segment_id}:character_identity_id_changed:${identityLabel}`);
          identityIdsByLabel.set(identityLabel, id);
          const previousLock = identityLocksById.get(id);
          if (previousLock && previousLock !== currentLock && !changeEvents.some(event => event.reason.trim()
            && event.from.trim() && event.to.trim() && event.from !== event.to
            && previousLock.includes(event.from) && currentLock.includes(event.to))) {
            issues.push(`${segment.segment_id}:character_asset_lock_changed_without_event:${id}`);
          }
          identityLocksById.set(id, currentLock);
        }
      }
      if (segment.shot_time_ranges.some(range => /兼容旧输出|未单列/.test(range.action_beat))
        || segment.continuity_links.some(link => link.link_type === "legacy_continuity" || /兼容旧输出/.test(link.description))) {
        issues.push(`${segment.segment_id}:legacy_fallback_not_allowed`);
      }
      const shotIds = segment.shot_time_ranges.map(range => range.shot_id);
      if (new Set(shotIds).size !== shotIds.length) issues.push(`${segment.segment_id}:duplicate_shot_id`);
      if (segment.continuity_links.some((link, linkIndex) => link.from_shot !== shotIds[linkIndex] || link.to_shot !== shotIds[linkIndex + 1])) {
        issues.push(`${segment.segment_id}:continuity_link_order_mismatch`);
      }
    }
    for (const ref of segment.visual_asset_refs || []) {
      const declared = declaredAssets.get(ref.asset_id);
      if (visualAssetMode !== "selected") {
        issues.push(`${segment.segment_id}:visual_asset_ref_without_selected_plan`);
      } else if (!declared) {
        issues.push(`${segment.segment_id}:unknown_visual_asset_ref`);
      } else if (declared.role !== ref.role) {
        issues.push(`${segment.segment_id}:visual_asset_ref_role_mismatch`);
      }
    }
    if (segment.semantic_visualizations.length === 0) {
      issues.push(`${segment.segment_id}:missing_semantic_visualization`);
    }
    const combined = [
      ...segment.character_assets,
      segment.storyboard_image_prompt,
      segment.image_to_video_prompt,
    ].join("\n");
    if (/同一只(?:狗|猫)|同一个人|那个(?:女人|男人|主人)/.test(combined)) {
      issues.push(`${segment.segment_id}:vague_character_identity`);
    }
    if (!/(先|随后|接着|猛地|缓慢|抬|冲|转|缩|停|落|发现|追逐|收束|移动|变化|完成|等待|稳定|收起|趴下|回头)/.test(segment.image_to_video_prompt)) {
      issues.push(`${segment.segment_id}:video_prompt_not_actionable`);
    }
    if (!hasExplicitAudioBoundary(`${segment.image_to_video_prompt}\n${pkg.input.special_notes}`)) {
      issues.push(`${segment.segment_id}:missing_audio_boundary`);
    }
  }
  return [...new Set(issues)];
}
