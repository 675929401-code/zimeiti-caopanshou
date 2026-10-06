import { createHash } from "node:crypto";

import {
  isActivationGatedVideoConfig,
  makePendingVideoProtocolConfig,
  preservePersistedVideoActivationGate,
  videoActivationBindingSha256,
} from "./model-activation-gate";
import { AUTODL_COMFYUI_SECRET_REF } from "./provider-secret";

export const AUTODL_HOSTED_H3_CATALOG_SCHEMA = "autodl_hosted_h3_workflow_catalog.v1";
export const AUTODL_HOSTED_H3_API_BASE = "https://www.autodl.art/api/v1";
export const AUTODL_HOSTED_H3_DOC_URL = "https://autodl.art/docs/comfyui_api/";
export const AUTODL_HOSTED_H3_MARKET_URL = "https://autodl.art/large-model/comfyui";
export const AUTODL_HOSTED_H3_METADATA_BASE = `${AUTODL_HOSTED_H3_API_BASE}/comfyui/workflows`;

const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const AUDIO_MIME_TYPES = ["audio/mpeg", "audio/wav", "audio/mp4", "audio/flac"] as const;

type ResolutionTier = "480p" | "768p" | "1080p";
type AspectRatio = "16:9" | "9:16" | "1:1";
type WorkflowKind =
  | "text_to_video"
  | "multi_image_to_video"
  | "first_last_frame_to_video"
  | "image_audio_lipsync"
  | "multi_image_audio_to_video";

type InputFieldContract = {
  field: string;
  type: "prompt" | "number" | "image" | "audio" | "enum";
  required: boolean;
  min?: number;
  max?: number;
  default?: number | string;
  accepted_mime_types?: readonly string[];
};

export type AutoDLHostedH3Resolution = {
  label: string;
  tier: ResolutionTier;
  aspect_ratio: AspectRatio;
  width: number;
  height: number;
};

export type AutoDLHostedH3WorkflowSpec = {
  modelId: string;
  sortOrder: number;
  workflowId: string;
  displayName: string;
  officialName: string;
  officialDescription: string;
  kind: WorkflowKind;
  metadataCreatedAt: string;
  metadataUpdatedAt: string;
  prompt: InputFieldContract | null;
  duration: InputFieldContract;
  images: readonly InputFieldContract[];
  audios: readonly InputFieldContract[];
  seed: InputFieldContract | null;
  resolutions: readonly AutoDLHostedH3Resolution[];
  defaultResolutionLabel: string;
  rawBillingByTier: Readonly<Record<ResolutionTier, number | undefined>>;
  cnyPerOutputSecondByTier: Readonly<Record<ResolutionTier, number | undefined>>;
  workspaceSurfaces: readonly string[];
  adapterCompatibility: {
    status: "ready" | "partial" | "blocked";
    limitations: readonly string[];
  };
};

export type AutoDLHostedH3VideoRecord = {
  id: string;
  name: string;
  model_name: string;
  provider: "autodl_comfyui_workflow";
  protocol_type: "autodl_comfyui_workflow";
  api_endpoint: string;
  api_key: typeof AUTODL_COMFYUI_SECRET_REF;
  price_per_use: number;
  cost_price: number;
  currency: "CNY";
  duration_seconds: number;
  max_duration: number;
  supports_image_input: boolean;
  requires_image: boolean;
  is_active: true;
  is_hidden: false;
  sort_order: number;
  admin_notes: string;
  api_protocol_config: Record<string, unknown>;
};

const PIXELS: Readonly<Record<string, Omit<AutoDLHostedH3Resolution, "label">>> = {
  "480p竖": { tier: "480p", aspect_ratio: "9:16", width: 480, height: 864 },
  "768p竖": { tier: "768p", aspect_ratio: "9:16", width: 768, height: 1344 },
  "1080p竖": { tier: "1080p", aspect_ratio: "9:16", width: 1080, height: 1920 },
  "480p横": { tier: "480p", aspect_ratio: "16:9", width: 864, height: 480 },
  "768p横": { tier: "768p", aspect_ratio: "16:9", width: 1344, height: 768 },
  "1080p横": { tier: "1080p", aspect_ratio: "16:9", width: 1920, height: 1080 },
  "480p(1:1)": { tier: "480p", aspect_ratio: "1:1", width: 480, height: 480 },
  "768p(1:1)": { tier: "768p", aspect_ratio: "1:1", width: 768, height: 768 },
  "1080p(1:1)": { tier: "1080p", aspect_ratio: "1:1", width: 1080, height: 1080 },
};

function resolutionSet(labels: readonly string[]): AutoDLHostedH3Resolution[] {
  return labels.map((label) => {
    const pixels = PIXELS[label];
    if (!pixels) throw new Error(`AUTODL_H3_UNKNOWN_RESOLUTION_LABEL:${label}`);
    return { label, ...pixels };
  });
}

function prompt(max: number): InputFieldContract {
  return { field: "prompt", type: "prompt", required: true, min: 1, max };
}

function duration(field: "duration" | "audio_duration", max: 10 | 15): InputFieldContract {
  return { field, type: "number", required: false, default: 5, min: 1, max };
}

function imageFields(count: number, requiredIndexes: readonly number[]): InputFieldContract[] {
  return Array.from({ length: count }, (_, index) => ({
    field: `ref_image_${index}`,
    type: "image" as const,
    required: requiredIndexes.includes(index),
    accepted_mime_types: IMAGE_MIME_TYPES,
  }));
}

function audioFields(count: number, requiredIndexes: readonly number[]): InputFieldContract[] {
  return Array.from({ length: count }, (_, index) => ({
    field: `ref_audio_${index}`,
    type: "audio" as const,
    required: requiredIndexes.includes(index),
    accepted_mime_types: AUDIO_MIME_TYPES,
  }));
}

const seed: InputFieldContract = {
  field: "seed",
  type: "number",
  required: false,
  min: 1,
  max: 999_999_999_999_999,
};

const RES_480_768 = resolutionSet(["480p竖", "768p竖", "480p横", "768p横"]);
const RES_480_768_SQUARE = resolutionSet([
  "480p竖", "768p竖", "480p横", "768p横", "480p(1:1)", "768p(1:1)",
]);
const RES_ALL = resolutionSet([
  "480p竖", "768p竖", "1080p竖",
  "480p横", "768p横", "1080p横",
]);
const RES_ALL_SQUARE = resolutionSet([
  "480p竖", "768p竖", "1080p竖",
  "480p横", "768p横", "1080p横",
  "480p(1:1)", "768p(1:1)", "1080p(1:1)",
]);

/**
 * Snapshot of AutoDL's public workflow metadata captured on 2026-09-05.
 * `rawBillingByTier` preserves the API value; the CNY map follows the public
 * ordinary-time metadata price (raw / 1000 -> CNY/output-second).
 */
const AUTODL_HOSTED_H3_WORKFLOW_EVIDENCE: readonly AutoDLHostedH3WorkflowSpec[] = [
  {
    modelId: "minimax-h3-autodl-hosted-lightx2v-v5",
    sortOrder: 20,
    workflowId: "minimax_h3_lightx2v_v5",
    displayName: "MiniMax H3 · 多图参考（AutoDL 在线）",
    officialName: "H3多图参考生视频",
    officialDescription: "MiniMax H3多图参考生成视频",
    kind: "multi_image_to_video",
    metadataCreatedAt: "2026-08-14 18:47:56",
    metadataUpdatedAt: "2026-08-14 18:47:56",
    prompt: prompt(500_000),
    duration: duration("duration", 10),
    images: imageFields(9, [0]),
    audios: [],
    seed,
    resolutions: RES_ALL_SQUARE,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": 90 },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": 0.09 },
    workspaceSurfaces: ["ai-video", "storyboard"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-text",
    sortOrder: 21,
    workflowId: "minimax_h3_lightx2v_no_pic",
    displayName: "MiniMax H3 · 文生视频（AutoDL 在线）",
    officialName: "H3文生视频",
    officialDescription: "MiniMax H3文生视频",
    kind: "text_to_video",
    metadataCreatedAt: "2026-08-13 17:36:23",
    metadataUpdatedAt: "2026-08-13 17:36:23",
    prompt: prompt(200_000),
    duration: duration("duration", 15),
    images: [],
    audios: [],
    seed: null,
    resolutions: RES_480_768,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": undefined },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": undefined },
    workspaceSurfaces: ["ai-video"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-first-last",
    sortOrder: 22,
    workflowId: "minimax_h3_lightx2v",
    displayName: "MiniMax H3 · 首尾帧（AutoDL 在线）",
    officialName: "H3首尾帧生成视频",
    officialDescription: "MiniMax H3首尾帧生视频",
    kind: "first_last_frame_to_video",
    metadataCreatedAt: "2026-08-13 17:34:10",
    metadataUpdatedAt: "2026-08-13 17:34:10",
    prompt: prompt(2_000_000),
    duration: duration("duration", 15),
    images: [
      { field: "first_frame", type: "image", required: true, accepted_mime_types: IMAGE_MIME_TYPES },
      { field: "last_frame", type: "image", required: true, accepted_mime_types: IMAGE_MIME_TYPES },
    ],
    audios: [],
    seed: null,
    resolutions: RES_480_768,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": undefined },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": undefined },
    workspaceSurfaces: ["ai-video", "storyboard"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-lightx2v-v5-15s",
    sortOrder: 23,
    workflowId: "minimax_h3_lightx2v_v5_15s",
    displayName: "MiniMax H3 · 多图参考 15秒（AutoDL 在线）",
    officialName: "H3多图生视频15秒",
    officialDescription: "MiniMax H3多图参考生成视频，最长支持15秒视频",
    kind: "multi_image_to_video",
    metadataCreatedAt: "2026-08-21 16:12:48",
    metadataUpdatedAt: "2026-08-21 16:12:48",
    prompt: prompt(500_000),
    duration: duration("duration", 15),
    images: imageFields(9, [0]),
    audios: [],
    seed,
    resolutions: RES_480_768_SQUARE,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": undefined },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": undefined },
    workspaceSurfaces: ["ai-video", "storyboard"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-image-audio",
    sortOrder: 24,
    workflowId: "minimax_h3_image_audio_to_video",
    displayName: "MiniMax H3 · 图生视频音频同步（AutoDL 在线）",
    officialName: "H3图生视频-音频同步(自动对口型)",
    officialDescription: "MiniMax H3图生视频-音频同步",
    kind: "image_audio_lipsync",
    metadataCreatedAt: "2026-08-19 15:06:11",
    metadataUpdatedAt: "2026-08-19 15:06:11",
    prompt: null,
    duration: duration("audio_duration", 15),
    images: imageFields(1, [0]),
    audios: audioFields(1, [0]),
    seed: null,
    resolutions: RES_ALL,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": 90 },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": 0.09 },
    workspaceSurfaces: ["digital-human"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-image-audio-v2",
    sortOrder: 25,
    workflowId: "minimax_h3_image_audio_to_video_v2",
    displayName: "MiniMax H3 · 多图多音频（AutoDL 在线新协议）",
    officialName: "H3多图多音频生视频",
    officialDescription: "MiniMax H3多图多音频参考生视频，该工作流未做任何包装门槛较高，需精确控制提示词来使用",
    kind: "multi_image_audio_to_video",
    metadataCreatedAt: "2026-08-19 20:59:01",
    metadataUpdatedAt: "2026-08-19 20:59:01",
    prompt: prompt(10_000),
    duration: duration("duration", 10),
    images: imageFields(9, []),
    audios: audioFields(3, []),
    seed,
    resolutions: RES_ALL,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": 100 },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": 0.10 },
    workspaceSurfaces: ["ai-video", "storyboard"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
  {
    modelId: "minimax-h3-autodl-hosted-image-audio-v2-15s",
    sortOrder: 26,
    workflowId: "minimax_h3_image_audio_to_video_v2_15s",
    displayName: "MiniMax H3 · 多图多音频 15秒（AutoDL 在线）",
    officialName: "H3多图多音频生视频15秒",
    officialDescription: "MiniMax H3多图多音频参考生视频，最长支持15秒视频，该工作流未做任何包装门槛较高，需精确控制提示词来使用",
    kind: "multi_image_audio_to_video",
    metadataCreatedAt: "2026-08-21 16:46:26",
    metadataUpdatedAt: "2026-08-21 16:46:26",
    prompt: prompt(10_000),
    duration: duration("duration", 15),
    images: imageFields(9, []),
    audios: audioFields(3, []),
    seed,
    resolutions: RES_480_768,
    defaultResolutionLabel: "768p竖",
    rawBillingByTier: { "480p": 20, "768p": 30, "1080p": undefined },
    cnyPerOutputSecondByTier: { "480p": 0.02, "768p": 0.03, "1080p": undefined },
    workspaceSurfaces: ["ai-video", "storyboard"],
    adapterCompatibility: { status: "ready", limitations: [] },
  },
] as const;

const RETIRED_WORKFLOW_IDS = new Set([
  "minimax-h3-autodl-hosted-first-last",
  "minimax-h3-autodl-hosted-image-audio",
  "minimax-h3-autodl-hosted-image-audio-v2-15s",
  "minimax-h3-autodl-hosted-lightx2v-v5-15s",
]);

// Only the three workflows retained by the 2026-09-20 cleanup may be
// configured again. The retired specs remain immutable evidence so old
// configurators cannot silently resurrect them.
export const AUTODL_HOSTED_H3_WORKFLOWS: readonly AutoDLHostedH3WorkflowSpec[] =
  AUTODL_HOSTED_H3_WORKFLOW_EVIDENCE.filter((spec) => !RETIRED_WORKFLOW_IDS.has(spec.modelId));

export const RETIRED_AUTODL_HOSTED_H3_WORKFLOWS: readonly AutoDLHostedH3WorkflowSpec[] =
  AUTODL_HOSTED_H3_WORKFLOW_EVIDENCE.filter((spec) => RETIRED_WORKFLOW_IDS.has(spec.modelId));

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function autoDLHostedH3ContractSnapshot(spec: AutoDLHostedH3WorkflowSpec) {
  return {
    schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
    workflow_id: spec.workflowId,
    official_name: spec.officialName,
    official_description: spec.officialDescription,
    workflow_kind: spec.kind,
    metadata_created_at: spec.metadataCreatedAt,
    metadata_updated_at: spec.metadataUpdatedAt,
    submit: {
      method: "POST",
      path: `/comfyui/comfyui_workflow/${spec.workflowId}`,
      authorization: "raw_comfyui_token",
    },
    poll: {
      method: "GET",
      path: "/comfyui/comfyui_workflow/result/{task_id}",
      authorization: "raw_comfyui_token",
    },
    inputs: {
      prompt: spec.prompt,
      duration: spec.duration,
      images: spec.images,
      audios: spec.audios,
      resolution: {
        field: "resolution",
        type: "enum",
        required: false,
        default: spec.defaultResolutionLabel,
        options: spec.resolutions,
      },
      seed: spec.seed,
    },
    billing: {
      unit: "output_second",
      raw_api_value_by_resolution: spec.rawBillingByTier,
      cny_per_output_second_by_resolution: spec.cnyPerOutputSecondByTier,
      conversion_evidence: AUTODL_HOSTED_H3_MARKET_URL,
    },
  };
}

export function autoDLHostedH3ContractSha256(spec: AutoDLHostedH3WorkflowSpec): string {
  return sha256(autoDLHostedH3ContractSnapshot(spec));
}

function tierList(spec: AutoDLHostedH3WorkflowSpec): ResolutionTier[] {
  return [...new Set(spec.resolutions.map((resolution) => resolution.tier))];
}

function ratioList(spec: AutoDLHostedH3WorkflowSpec): AspectRatio[] {
  return [...new Set(spec.resolutions.map((resolution) => resolution.aspect_ratio))];
}

function numericTierMap(
  tiers: readonly ResolutionTier[],
  source: Readonly<Record<ResolutionTier, number | undefined>>,
): Record<string, number> {
  return Object.fromEntries(tiers.flatMap((tier) => {
    const value = source[tier];
    return value === undefined ? [] : [[tier, value]];
  }));
}

function requiredCount(fields: readonly InputFieldContract[]): number {
  return fields.filter((field) => field.required).length;
}

function workflowInputMode(kind: WorkflowKind): string {
  switch (kind) {
    case "text_to_video": return "text";
    case "multi_image_to_video": return "multi_image";
    case "first_last_frame_to_video": return "first_last_frame";
    case "image_audio_lipsync": return "image_audio_lipsync";
    case "multi_image_audio_to_video": return "multi_image_audio";
  }
}

export function buildAutoDLHostedH3VideoRecord(
  spec: AutoDLHostedH3WorkflowSpec,
  options: { createdAt?: string; persistedProtocolConfig?: unknown } = {},
): AutoDLHostedH3VideoRecord {
  const tiers = tierList(spec);
  const ratios = ratioList(spec);
  const defaultTier = spec.resolutions.find((item) => item.label === spec.defaultResolutionLabel)?.tier || tiers[0];
  const costPrices = numericTierMap(tiers, spec.cnyPerOutputSecondByTier);
  const persisted = options.persistedProtocolConfig as { resolution_prices?: Record<string, unknown> } | undefined;
  const publicPrices = Object.fromEntries(tiers.map((tier) => {
    const saved = persisted?.resolution_prices?.[tier];
    // Preserve explicit administrator prices, including a deliberately free tier.
    const defaultPrice = tier === "480p" ? 0.03 : tier === "768p" ? 0.04
      : spec.workflowId === "minimax_h3_image_audio_to_video_v2" ? 0.11 : 0.10;
    return [tier, typeof saved === "number" && Number.isFinite(saved) && saved >= 0 ? saved : defaultPrice];
  }));
  const defaultPrice = publicPrices[defaultTier] ?? 0;
  const contractHash = autoDLHostedH3ContractSha256(spec);
  const requiredImages = requiredCount(spec.images);
  const requiredAudios = requiredCount(spec.audios);
  const plainProtocolConfig: Record<string, unknown> = {
    schema: AUTODL_HOSTED_H3_CATALOG_SCHEMA,
    workflow_id: spec.workflowId,
    workflow_kind: spec.kind,
    workflow_input_mode: workflowInputMode(spec.kind),
    submit_path: `/comfyui/comfyui_workflow/${spec.workflowId}`,
    poll_path: "/comfyui/comfyui_workflow/result/{task_id}",
    poll_method: "GET",
    authorization_scheme: "raw_comfyui_token",
    supports_duration: true,
    min_duration: spec.duration.min,
    max_duration: spec.duration.max,
    duration_options: Array.from(
      { length: Number(spec.duration.max) - Number(spec.duration.min) + 1 },
      (_, index) => Number(spec.duration.min) + index,
    ),
    min_submit_duration: spec.duration.min,
    duration_step: 1,
    duration_field: spec.duration.field,
    supports_prompt: spec.prompt !== null,
    prompt_field: spec.prompt?.field || null,
    image_field_names: spec.images.map((field) => field.field),
    audio_field_names: spec.audios.map((field) => field.field),
    required_reference_images: requiredImages,
    required_reference_audios: requiredAudios,
    requires_first_frame: spec.images.some((field) => field.field === "first_frame" && field.required),
    requires_last_frame: spec.images.some((field) => field.field === "last_frame" && field.required),
    exact_duration_only: true,
    resolution_options: tiers,
    default_resolution: defaultTier,
    resolution: defaultTier,
    resolution_labels: Object.fromEntries(tiers.map((tier) => [tier, `${tier} 原生`])),
    official_resolution_labels: spec.resolutions.map((item) => item.label),
    official_resolution_pixels: Object.fromEntries(
      spec.resolutions.map((item) => [item.label, { width: item.width, height: item.height }]),
    ),
    resolution_cost_prices: costPrices,
    resolution_prices: publicPrices,
    upstream_billing_raw: numericTierMap(tiers, spec.rawBillingByTier),
    billing_unit: "output_second",
    aspect_ratios: ratios,
    max_reference_images: spec.images.length,
    min_reference_images: requiredImages,
    max_reference_audios: spec.audios.length,
    min_reference_audios: requiredAudios,
    supports_audio_input: spec.audios.length > 0,
    auto_generate_reference: false,
    workspace_surfaces: spec.workspaceSurfaces,
    persist_result_immediately: true,
    supports_remote_cancel: false,
    input_contract: autoDLHostedH3ContractSnapshot(spec).inputs,
    official_metadata_url: `${AUTODL_HOSTED_H3_METADATA_BASE}/${spec.workflowId}`,
    official_api_docs_url: AUTODL_HOSTED_H3_DOC_URL,
    official_market_url: AUTODL_HOSTED_H3_MARKET_URL,
    official_metadata_updated_at: spec.metadataUpdatedAt,
    official_contract_sha256: contractHash,
    adapter_compatibility: spec.adapterCompatibility,
  };
  const apiProtocolConfig = options.persistedProtocolConfig
    && isActivationGatedVideoConfig(options.persistedProtocolConfig)
    ? preservePersistedVideoActivationGate(options.persistedProtocolConfig, plainProtocolConfig)
    : makePendingVideoProtocolConfig(plainProtocolConfig, { createdAt: options.createdAt });
  return {
    id: spec.modelId,
    name: spec.displayName,
    model_name: spec.workflowId,
    provider: "autodl_comfyui_workflow",
    protocol_type: "autodl_comfyui_workflow",
    api_endpoint: AUTODL_HOSTED_H3_API_BASE,
    api_key: AUTODL_COMFYUI_SECRET_REF,
    price_per_use: defaultPrice,
    cost_price: costPrices[defaultTier] ?? 0,
    currency: "CNY",
    duration_seconds: Number(spec.duration.default) || 5,
    max_duration: Number(spec.duration.max) || 5,
    supports_image_input: spec.images.length > 0,
    requires_image: requiredImages > 0,
    is_active: true,
    is_hidden: false,
    sort_order: spec.sortOrder,
    admin_notes: [
      "【AutoDL 托管 H3 新协议隔离记录】",
      `官方工作流：${spec.workflowId}（${spec.officialName}）。`,
      `输入：prompt=${spec.prompt ? "必填" : "无"}，图片 ${requiredImages}-${spec.images.length} 张，音频 ${requiredAudios}-${spec.audios.length} 段。`,
      `时长：${spec.duration.min}-${spec.duration.max} 秒整数；分辨率：${tiers.join("/")}；画幅：${ratios.join("/")}。`,
      `官方促销成本（输出秒）：${tiers.map((tier) => `${tier} ¥${publicPrices[tier]?.toFixed(2)}`).join("；")}。`,
      `协议哈希：${contractHash}。`,
      `当前适配状态：${spec.adapterCompatibility.status}${spec.adapterCompatibility.limitations.length ? `；${spec.adapterCompatibility.limitations.join("；")}` : ""}。`,
      "目录状态：此工作流属于保留的 AutoDL H3 官方工作流，可在工作台选择。",
      `密钥：仅保存 ${AUTODL_COMFYUI_SECRET_REF} 引用，不保存明文令牌。`,
    ].join("\n"),
    api_protocol_config: apiProtocolConfig,
  };
}

export function buildAutoDLHostedH3CatalogRecords(
  options: {
    createdAt?: string;
    persistedById?: ReadonlyMap<string, { api_protocol_config?: unknown }>;
  } = {},
): AutoDLHostedH3VideoRecord[] {
  return AUTODL_HOSTED_H3_WORKFLOWS.map((spec) => buildAutoDLHostedH3VideoRecord(spec, {
    createdAt: options.createdAt,
    persistedProtocolConfig: options.persistedById?.get(spec.modelId)?.api_protocol_config,
  }));
}

export function autoDLHostedH3BindingSha256(record: AutoDLHostedH3VideoRecord): string {
  return videoActivationBindingSha256(record);
}
