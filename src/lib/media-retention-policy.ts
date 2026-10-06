export const MEDIA_RETENTION_POLICY_VERSION = "media-object-retention.v1";

export const GENERATED_VIDEO_CLOUD_RETENTION_DAYS = 3;
export const CREATIVE_ASSET_CLOUD_RETENTION_DAYS = 30;
export const BROWSER_MEDIA_CACHE_DAYS = 3;

export type CloudMediaRetentionClass = "generated_video" | "creative_asset";

export interface CloudMediaRetentionRule {
  id: string;
  retentionClass: CloudMediaRetentionClass;
  days: number;
  prefixes: readonly string[];
}

/**
 * Prefixes are intentionally compatible with Tencent COS lifecycle rules.
 * Keep generated/derived video prefixes separate from reusable creative assets,
 * so applying the 3-day rule cannot remove role or reference material early.
 */
export const CLOUD_MEDIA_RETENTION_RULES: readonly CloudMediaRetentionRule[] = [
  {
    id: "generated-and-derived-video-3d",
    retentionClass: "generated_video",
    days: GENERATED_VIDEO_CLOUD_RETENTION_DAYS,
    prefixes: [
      "videos/generated/",
      "videos/extracted/",
      "videos/digital-human-long/",
      "short-drama/final/",
    ],
  },
  {
    id: "creative-and-reference-asset-30d",
    retentionClass: "creative_asset",
    days: CREATIVE_ASSET_CLOUD_RETENTION_DAYS,
    prefixes: [
      "images/",
      "image-workbench/",
      "video-inputs/",
      "video-audio-inputs/",
      "digital-human-inputs/",
    ],
  },
] as const;

export interface CloudMediaRetentionTarget {
  policyVersion: string;
  ruleId: string;
  retentionClass: CloudMediaRetentionClass;
  days: number;
  targetExpiresAt: string;
  enforcement: "cos_lifecycle_required";
}

export function resolveCloudMediaRetentionRule(key: string): CloudMediaRetentionRule | null {
  const normalizedKey = String(key || "").replace(/^\/+/, "");
  if (!normalizedKey) return null;
  return CLOUD_MEDIA_RETENTION_RULES.find((rule) =>
    rule.prefixes.some((prefix) => normalizedKey.startsWith(prefix)),
  ) || null;
}

/**
 * Produces an audit target for user_files.meta. This does not claim deletion is
 * active: COS lifecycle configuration remains the enforcement mechanism.
 */
export function cloudMediaRetentionTarget(
  key: string,
  uploadedAt = new Date(),
): CloudMediaRetentionTarget | null {
  const rule = resolveCloudMediaRetentionRule(key);
  if (!rule) return null;
  const uploadedAtMs = uploadedAt.getTime();
  if (!Number.isFinite(uploadedAtMs)) throw new Error("MEDIA_RETENTION_UPLOAD_TIME_INVALID");
  return {
    policyVersion: MEDIA_RETENTION_POLICY_VERSION,
    ruleId: rule.id,
    retentionClass: rule.retentionClass,
    days: rule.days,
    targetExpiresAt: new Date(uploadedAtMs + rule.days * 24 * 60 * 60 * 1000).toISOString(),
    enforcement: "cos_lifecycle_required",
  };
}

export function generatedVideoCloudNotice(enforced: boolean): string {
  return enforced
    ? `云端成片默认保留${GENERATED_VIDEO_CLOUD_RETENTION_DAYS}天，请在到期前下载到电脑长期保存。`
    : "云端文件可能按存储策略到期，长期保存请下载到电脑。";
}
