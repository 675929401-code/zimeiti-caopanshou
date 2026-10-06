export const AUTODL_H3_ACTIVATION_PROFILE_SCHEMA = "autodl_h3_selfhost_activation.v1";

export const AUTODL_H3_VIDEO_RESOLUTION_TIERS = ["480p", "1080p", "2K"] as const;
export type AutodlH3VideoResolutionTier = (typeof AUTODL_H3_VIDEO_RESOLUTION_TIERS)[number];

export const AUTODL_H3_VIDEO_RESOLUTION_LABELS: Record<AutodlH3VideoResolutionTier, string> = {
  "480p": "480p 原生",
  "1080p": "1080p增强",
  "2K": "2K增强",
};

const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
const VIDEO_DURATIONS = [5, 10, 15] as const;
const IMAGE_RESOLUTIONS = ["1K", "2K", "4K"] as const;

type JsonRecord = Record<string, unknown>;
type PixelMap = Record<string, string>;

export type AutodlH3ActivationPlan = {
  evidenceId: string;
  verifiedAt: string;
  videoName: string;
  videoAdminNotes: string;
  videoDurationSeconds: number;
  videoMaxDuration: number;
  videoProtocolConfig: Record<string, unknown>;
  imageName: string;
  imageResolution: "1K" | "2K" | "4K";
  imageAspectRatios: string[];
  imageRequestPixelSizes: PixelMap;
  imageOutputPixelSizes: PixelMap;
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as JsonRecord;
}

function safeEvidenceId(value: unknown, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(normalized)) {
    throw new Error(`${label} 必须是 8-160 位不含路径或密钥的证据编号`);
  }
  return normalized;
}

function verifiedTimestamp(value: unknown): string {
  const normalized = String(value || "").trim();
  const parsed = Date.parse(normalized);
  if (!normalized || !Number.isFinite(parsed)) throw new Error("verified_at 必须是有效时间");
  if (parsed > Date.now() + 5 * 60_000) throw new Error("verified_at 不得晚于当前时间");
  return new Date(parsed).toISOString();
}

function pixelSize(value: unknown, label: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  const match = normalized.match(/^(\d{2,4})x(\d{2,4})$/u);
  if (!match) throw new Error(`${label} 必须是 WxH 像素尺寸`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 8192 || height > 8192 || width * height > 40_000_000) {
    throw new Error(`${label} 超出安全像素范围`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) throw new Error(`${label} 宽高必须为偶数`);
  return `${width}x${height}`;
}

function pixelMap(value: unknown, label: string): PixelMap {
  const source = record(value, label);
  const result: PixelMap = {};
  for (const [aspectRatio, size] of Object.entries(source)) {
    if (!(VIDEO_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
      throw new Error(`${label} 含不支持的画幅 ${aspectRatio}`);
    }
    result[aspectRatio] = pixelSize(size, `${label}.${aspectRatio}`);
  }
  if (Object.keys(result).length === 0) throw new Error(`${label} 至少需要一个真实画幅`);
  return result;
}

function sameKeys(left: PixelMap, right: PixelMap, label: string): void {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
    throw new Error(`${label} 的输入与输出画幅必须一一对应`);
  }
}

function exactTierLabel(tier: AutodlH3VideoResolutionTier, value: unknown): string {
  const expected = AUTODL_H3_VIDEO_RESOLUTION_LABELS[tier];
  if (String(value || "").trim() !== expected) {
    throw new Error(`${tier} 必须明确标注为“${expected}”`);
  }
  return expected;
}

function gatewayOutputTier(tier: AutodlH3VideoResolutionTier, value: unknown): string {
  const normalized = String(value || "").trim();
  const expected = tier === "480p" ? "base" : tier;
  if (normalized !== expected) throw new Error(`${tier} 的 gateway_output_tier 必须为 ${expected}`);
  return normalized;
}

function assertOutputTierDimensions(tier: AutodlH3VideoResolutionTier, outputs: PixelMap): void {
  for (const [aspectRatio, value] of Object.entries(outputs)) {
    const [width, height] = value.split("x").map(Number);
    const longEdge = Math.max(width, height);
    const shortEdge = Math.min(width, height);
    if (tier === "480p" && (longEdge > 900 || shortEdge > 800)) {
      throw new Error(`480p 原生输出 ${aspectRatio}=${value} 超出已知原生档范围`);
    }
    if (tier === "1080p" && width * height < 1_000_000) {
      throw new Error(`1080p增强输出 ${aspectRatio}=${value} 未达到增强档`);
    }
    if (tier === "2K" && width * height < 2_000_000) {
      throw new Error(`2K增强输出 ${aspectRatio}=${value} 未达到增强档`);
    }
  }
}

function imageResolution(value: unknown): "1K" | "2K" | "4K" {
  const normalized = String(value || "").trim().toUpperCase();
  if (!(IMAGE_RESOLUTIONS as readonly string[]).includes(normalized)) {
    throw new Error("图片 resolution 必须是 1K、2K 或 4K");
  }
  return normalized as "1K" | "2K" | "4K";
}

function assertImageTierDimensions(tier: "1K" | "2K" | "4K", outputs: PixelMap): void {
  const requiredLongEdge = tier === "4K" ? 3840 : tier === "2K" ? 2048 : 1024;
  for (const [aspectRatio, value] of Object.entries(outputs)) {
    const [width, height] = value.split("x").map(Number);
    if (Math.max(width, height) < requiredLongEdge) {
      throw new Error(`图片 ${tier} 输出 ${aspectRatio}=${value} 未达到档位`);
    }
  }
}

export function buildAutodlH3ActivationPlan(value: unknown): AutodlH3ActivationPlan {
  const root = record(value, "激活档案");
  if (root.schema !== AUTODL_H3_ACTIVATION_PROFILE_SCHEMA) {
    throw new Error(`激活档案 schema 必须为 ${AUTODL_H3_ACTIVATION_PROFILE_SCHEMA}`);
  }
  const evidenceId = safeEvidenceId(root.evidence_id, "evidence_id");
  const verifiedAt = verifiedTimestamp(root.verified_at);
  const video = record(root.video, "video");
  const resolutions = record(video.resolutions, "video.resolutions");

  const durations = Array.isArray(video.duration_options)
    ? [...new Set(video.duration_options.map(Number))].sort((left, right) => left - right)
    : [];
  if (durations.length === 0 || durations.some((duration) => !(VIDEO_DURATIONS as readonly number[]).includes(duration))) {
    throw new Error("video.duration_options 只能包含真实验收的 5、10、15 秒档");
  }
  const defaultDuration = Number(video.default_duration);
  if (!durations.includes(defaultDuration)) throw new Error("video.default_duration 必须属于已验收时长档");

  const enabledTiers: AutodlH3VideoResolutionTier[] = [];
  const resolutionLabels: Record<string, string> = {};
  const resolutionStatus: Record<string, "verified" | "derived" | "disabled"> = {};
  const resolutionVerificationMode: Record<string, "direct" | "derived_from_higher_tier" | "disabled"> = {};
  const inputPixelSizes: Record<string, PixelMap> = {};
  const outputPixelSizes: Record<string, PixelMap> = {};
  const outputTiers: Record<string, string> = {};
  let sharedAspectRatios: string[] | null = null;

  for (const tier of AUTODL_H3_VIDEO_RESOLUTION_TIERS) {
    const entry = record(resolutions[tier], `video.resolutions.${tier}`);
    resolutionLabels[tier] = exactTierLabel(tier, entry.label);
    const enabled = entry.enabled === true;
    const verified = entry.verified === true;
    const verificationMode = String(entry.verification_mode || (verified ? "direct" : "disabled")).trim();
    if (!enabled) {
      resolutionStatus[tier] = "disabled";
      resolutionVerificationMode[tier] = "disabled";
      continue;
    }
    if (verificationMode === "direct") {
      if (!verified) {
        throw new Error(`${resolutionLabels[tier]} 以 direct 启用时必须 verified=true`);
      }
      resolutionStatus[tier] = "verified";
      resolutionVerificationMode[tier] = "direct";
    } else if (verificationMode === "derived_from_higher_tier") {
      if (tier !== "1080p" || verified || entry.derived_from_tier !== "2K") {
        throw new Error("仅允许 1080p增强以 verified=false、derived_from_higher_tier 且 derived_from_tier=2K 启用");
      }
      resolutionStatus[tier] = "derived";
      resolutionVerificationMode[tier] = "derived_from_higher_tier";
    } else {
      throw new Error(`${resolutionLabels[tier]} 的 verification_mode 无效`);
    }

    safeEvidenceId(entry.evidence_id, `${tier}.evidence_id`);
    const inputs = pixelMap(entry.input_pixel_size_by_aspect_ratio, `${tier}.input_pixel_size_by_aspect_ratio`);
    const outputs = pixelMap(entry.output_pixel_size_by_aspect_ratio, `${tier}.output_pixel_size_by_aspect_ratio`);
    sameKeys(inputs, outputs, tier);
    assertOutputTierDimensions(tier, outputs);
    const aspects = Object.keys(inputs).sort();
    if (sharedAspectRatios && JSON.stringify(sharedAspectRatios) !== JSON.stringify(aspects)) {
      throw new Error("所有启用的视频分辨率档必须具备相同的真实画幅集合");
    }
    sharedAspectRatios = aspects;
    enabledTiers.push(tier);
    inputPixelSizes[tier] = inputs;
    outputPixelSizes[tier] = outputs;
    outputTiers[tier] = gatewayOutputTier(tier, entry.gateway_output_tier);
  }

  if (enabledTiers.length === 0 || !sharedAspectRatios) throw new Error("至少启用一个有直接证据或受约束推导证据的视频分辨率档");
  if (resolutionVerificationMode["1080p"] === "derived_from_higher_tier"
    && resolutionVerificationMode["2K"] !== "direct") {
    throw new Error("1080p增强的推导启用必须由已直接实测的 2K增强档支撑");
  }
  const defaultResolution = String(video.default_resolution || "").trim() as AutodlH3VideoResolutionTier;
  if (!enabledTiers.includes(defaultResolution)) throw new Error("video.default_resolution 必须属于已启用档位");

  const directVerifiedCombinations = Array.isArray(video.direct_verified_combinations)
    ? [...new Set(video.direct_verified_combinations.map((value) => String(value || "").trim()))]
    : [];
  if (directVerifiedCombinations.length === 0) throw new Error("video.direct_verified_combinations 不得为空");
  for (const combination of directVerifiedCombinations) {
    const match = combination.match(/^(480p|1080p|2K)\|(5|10|15)\|(16:9|9:16|1:1)$/u);
    if (!match) throw new Error(`直接实测组合格式无效: ${combination}`);
    const [, tier, duration, aspectRatio] = match;
    if (resolutionVerificationMode[tier] !== "direct"
      || !durations.includes(Number(duration))
      || !sharedAspectRatios.includes(aspectRatio)) {
      throw new Error(`直接实测组合超出已验收范围: ${combination}`);
    }
  }
  for (const tier of enabledTiers.filter((value) => resolutionVerificationMode[value] === "direct")) {
    if (!directVerifiedCombinations.some((combination) => combination.startsWith(`${tier}|`))) {
      throw new Error(`${resolutionLabels[tier]} 缺少直接实测组合`);
    }
  }
  for (const duration of durations) {
    if (!directVerifiedCombinations.some((combination) => combination.split("|")[1] === String(duration))) {
      throw new Error(`${duration} 秒档缺少直接实测组合`);
    }
  }
  for (const aspectRatio of sharedAspectRatios) {
    if (!directVerifiedCombinations.some((combination) => combination.endsWith(`|${aspectRatio}`))) {
      throw new Error(`${aspectRatio} 画幅缺少直接实测组合`);
    }
  }
  if (!directVerifiedCombinations.some((combination) => (
    combination.startsWith(`${defaultResolution}|${defaultDuration}|`)
  ))) {
    throw new Error("video.default_resolution + video.default_duration 必须是直接实测成功组合");
  }

  const supportedCombinations = enabledTiers.flatMap((tier) => (
    durations.flatMap((duration) => (
      sharedAspectRatios.map((aspectRatio) => `${tier}|${duration}|${aspectRatio}`)
    ))
  ));
  const combinationVerificationMode = Object.fromEntries(supportedCombinations.map((combination) => [
    combination,
    directVerifiedCombinations.includes(combination) ? "direct" : "derived",
  ]));

  const image = record(root.image, "image");
  if (image.enabled !== true || image.verified !== true) throw new Error("图片模型必须有真实成功证据后才能一并启用");
  safeEvidenceId(image.evidence_id, "image.evidence_id");
  const resolvedImageResolution = imageResolution(image.resolution);
  const imageInputs = pixelMap(image.request_pixel_size_by_aspect_ratio, "image.request_pixel_size_by_aspect_ratio");
  const imageOutputs = pixelMap(image.output_pixel_size_by_aspect_ratio, "image.output_pixel_size_by_aspect_ratio");
  sameKeys(imageInputs, imageOutputs, "image");
  assertImageTierDimensions(resolvedImageResolution, imageOutputs);
  const imageAspectRatios = Object.keys(imageInputs).sort();
  const directVerificationSummary = directVerifiedCombinations.map((combination) => {
    const [tier, duration, aspectRatio] = combination.split("|");
    return `${resolutionLabels[tier]} ${duration}秒 ${aspectRatio}`;
  }).join("、");
  const verificationNotice = `直接实测：${directVerificationSummary}；其余已开放组合由同一原生生成/后处理链路推导，不宣称为逐组合直接实测。`;

  const videoProtocolConfig = {
    supports_duration: true,
    duration_options: durations,
    min_duration: durations[0],
    max_duration: durations.at(-1),
    min_submit_duration: durations[0],
    duration_step: 5,
    default_duration: defaultDuration,
    exact_duration_only: true,
    resolution_options: enabledTiers,
    default_resolution: defaultResolution,
    resolution: defaultResolution,
    resolution_labels: resolutionLabels,
    resolution_status: resolutionStatus,
    resolution_verification_mode: resolutionVerificationMode,
    direct_verified_combinations: directVerifiedCombinations,
    supported_combinations: supportedCombinations,
    combination_verification_mode: combinationVerificationMode,
    verification_notice: verificationNotice,
    resolution_cost_prices: Object.fromEntries(enabledTiers.map((tier) => [tier, 0])),
    resolution_prices: Object.fromEntries(enabledTiers.map((tier) => [tier, 0])),
    aspect_ratios: sharedAspectRatios,
    pixel_size_by_aspect_ratio: inputPixelSizes[defaultResolution],
    input_pixel_size_by_resolution: inputPixelSizes,
    output_pixel_size_by_resolution: outputPixelSizes,
    gateway_output_tier_by_resolution: outputTiers,
    auto_generate_reference: false,
    persist_result_immediately: true,
    supports_remote_cancel: false,
    billing_unit: "per_use",
    workspace_surfaces: ["ai-video"],
    live_verification: { evidence_id: evidenceId, verified_at: verifiedAt },
  };

  const enabledLabels = enabledTiers.map((tier) => resolutionLabels[tier]).join(" / ");
  const durationLabel = durations.join("/");
  return {
    evidenceId,
    verifiedAt,
    videoName: `MiniMax H3 Turbo · 自租实例（${enabledLabels}）`,
    videoAdminNotes: [
      "【内部渠道备注｜已按真实证据激活】",
      "渠道：AutoDL 自租 GPU 实例；与 AutoDL 托管 ComfyUI API 完全隔离。",
      "历史能力验收硬件：RTX PRO 6000。用户报告当前实例已更换为 RTX 5090；须先通过当前硬件的单条 canary，不得沿用历史速度、显存和稳定性结论。",
      `视频时长：${durationLabel} 秒；分辨率：${enabledLabels}。`,
      `直接实测组合：${directVerifiedCombinations.join("、")}。`,
      `激活证据：${evidenceId}；验收时间：${verifiedAt}。`,
      "增强档为网关后处理输出，不得描述为 MiniMax H3 原生 1080p/2K。",
      "无图走文生视频，有图才走图生视频；结果必须立即转存；不支持上游远程取消。",
    ].join("\n"),
    videoDurationSeconds: defaultDuration,
    videoMaxDuration: durations.at(-1)!,
    videoProtocolConfig,
    imageName: `Qwen Image 2512 HQ · 自租 PRO6000（${imageAspectRatios.map((aspectRatio) => `${aspectRatio}=${imageOutputs[aspectRatio].replace("x", "×")}`).join(" / ")} 实测输出）`,
    imageResolution: resolvedImageResolution,
    imageAspectRatios,
    imageRequestPixelSizes: imageInputs,
    imageOutputPixelSizes: imageOutputs,
  };
}
