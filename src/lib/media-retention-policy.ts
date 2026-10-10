export const MEDIA_RETENTION_POLICY_VERSION = "media-object-retention.v2";

export const MANAGED_PROJECT_VIDEO_CLOUD_RETENTION_DAYS = 3;
export const CREATIVE_ASSET_CLOUD_RETENTION_DAYS = 30;
export const EXTRACTION_HISTORY_RETENTION_DAYS = 10;
export const CONVERSATION_CONTENT_RETENTION_DAYS = 30;
export const BROWSER_MEDIA_CACHE_DAYS = 3;

export type CloudMediaRetentionClass = "managed_project_video" | "creative_asset";

export interface CloudMediaRetentionRule {
  id: string;
  retentionClass: CloudMediaRetentionClass;
  days: number;
  prefixes: readonly string[];
}

/**
 * Ordinary provider-generated videos never enter these prefixes. Managed
 * project outputs are explicit finite exceptions; broad image/role-library
 * prefixes are deliberately excluded so user-owned roles survive until the
 * user removes them.
 */
export const CLOUD_MEDIA_RETENTION_RULES: readonly CloudMediaRetentionRule[] = [
  {
    id: "managed-project-video-3d",
    retentionClass: "managed_project_video",
    days: MANAGED_PROJECT_VIDEO_CLOUD_RETENTION_DAYS,
    prefixes: [
      "videos/scoped/autodl-h3/",
      "videos/scoped/short-drama/",
      "videos/scoped/model-acceptance/",
      "videos/digital-human-long/",
      "short-drama/final/",
    ],
  },
  {
    id: "transient-creative-input-30d",
    retentionClass: "creative_asset",
    days: CREATIVE_ASSET_CLOUD_RETENTION_DAYS,
    prefixes: [
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
    ? "普通视频不复制到平台存储，播放有效期跟随上游；确认失效后自动移出历史。"
    : "视频播放有效期跟随上游，长期保存请及时下载到电脑。";
}
