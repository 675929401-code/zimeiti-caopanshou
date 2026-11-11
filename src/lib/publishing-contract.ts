import { z } from "zod";
import { NATIVE_OFFICIAL_API_PLATFORMS } from "./publishing-native";

/** Plain shared DTOs: never import server modules or persist plugin credentials here. */
export const PUBLISHING_FEATURE_KEY = "publish_center" as const;
export const PUBLISHING_PLATFORM_KEYS = ["xhs", "douyin", "wxSph"] as const;
export const PublishingPlatformSchema = z.enum(PUBLISHING_PLATFORM_KEYS);
export type PublishingPlatform = z.infer<typeof PublishingPlatformSchema>;
export const PUBLISHING_PLATFORMS: ReadonlyArray<{ key: PublishingPlatform; name: string }> = [
  { key: "xhs", name: "小红书" }, { key: "douyin", name: "抖音" }, { key: "wxSph", name: "视频号" },
];
/** Commercial eligibility is wider than the three legacy execution adapters. */
export const PublishingCommercialPlatformSchema = z.enum(NATIVE_OFFICIAL_API_PLATFORMS.map(item => item.platform));
export type PublishingCommercialPlatform = z.infer<typeof PublishingCommercialPlatformSchema>;
export const PUBLISHING_COMMERCIAL_PLATFORMS: ReadonlyArray<{ key: PublishingCommercialPlatform; name: string }> = NATIVE_OFFICIAL_API_PLATFORMS.map(item => ({ key: item.platform, name: item.name }));
export const PUBLISHING_USAGE_NOTICE = "每向一个平台账号发起一次发布消耗 1 次执行额度；结果待核对时请勿重复提交。";

export function isPublishingSafeHttps(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const credentialKey = /(?:cookie|token|authorization|secret|password|passwd|api.?key|signature|credential)|^(?:key|auth|session|sessionid|session_id)$/i;
    if ([...url.searchParams.keys()].some((name) => credentialKey.test(name))) return false;
    let fragment = url.hash.slice(1);
    try { fragment = decodeURIComponent(fragment); } catch { return false; }
    if (fragment.split(/[?&#;]/).some((part) => credentialKey.test(part.split(/[=:]/, 1)[0]) && /[=:]/.test(part))) return false;
    return url.protocol === "https:" && !url.username && !url.password && (url.port === "" || url.port === "443")
      && host.includes(".") && !host.includes(":") && !/^\d+(?:\.\d+){3}$/.test(host)
      && !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host) && !host.endsWith(".localhost")
      && host !== "metadata.google.internal";
  } catch { return false; }
}
const safeHttps = z.string().max(2048).refine(isPublishingSafeHttps, "仅允许公开 HTTPS 地址");
const id = z.string().uuid();
const stamp = z.string();
const shortText = z.string().trim().max(200);
export const PublishingAssetMetadataSchema = z.object({
  fileName: z.string().trim().min(1).max(255), size: z.number().int().nonnegative().max(10 * 1024 ** 3),
  type: z.string().max(120), lastModified: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const PublishingDraftInputSchema = z.object({
  title: z.string().trim().max(200), body: z.string().max(50000),
  topics: z.array(z.string().trim().min(1).max(100)).max(30),
  platforms: z.array(PublishingPlatformSchema).max(10), assets: z.array(PublishingAssetMetadataSchema).max(30),
}).strict();
export type PublishingDraftInput = z.infer<typeof PublishingDraftInputSchema>;
export const PublishingDraftSchema = PublishingDraftInputSchema.extend({ id, revision: z.number().int().positive(), createdAt: stamp, updatedAt: stamp }).strict();
export type PublishingDraft = z.infer<typeof PublishingDraftSchema>;
export const PublishingAccountInputSchema = z.object({ platform: PublishingPlatformSchema, platformAccountId: z.string().trim().min(1).max(160), displayName: shortText.min(1), avatar: safeHttps.optional() }).strict();
export const PublishingAccountSchema = PublishingAccountInputSchema.extend({ id, source: z.literal("browser_reported"), updatedAt: stamp }).strict();
export type PublishingAccount = z.infer<typeof PublishingAccountSchema>;
export const PublishingPlanInputSchema = z.object({
  id, expectedVersion: z.number().int().nonnegative(), name: shortText.min(1), description: z.string().max(2000),
  priceCents: z.number().int().positive().max(100000000), quota: z.number().int().positive().max(1000000),
  validDays: z.number().int().positive().max(3650), platforms: z.array(PublishingCommercialPlatformSchema).min(1).max(14), enabled: z.boolean(),
}).strict();
export const PublishingPlanSchema = PublishingPlanInputSchema.omit({ expectedVersion: true }).extend({ version: z.number().int().positive(), createdAt: stamp }).strict();
export type PublishingPlan = z.infer<typeof PublishingPlanSchema>;
export const PublishingEntitlementSchema = z.object({ id, purchaseId: id.nullable(), grantId: id.nullable().optional(), source: z.enum(['purchase','membership']).default('purchase'), planId: id, planVersion: z.number().int().positive(), planName: shortText, quota: z.number().int().positive(), used: z.number().int().nonnegative(), expiresAt: stamp, platforms: z.array(PublishingCommercialPlatformSchema).max(14) }).strict().superRefine((value,ctx)=>{if(value.source==='membership'?(!value.grantId||value.purchaseId!==null):(!value.purchaseId||!!value.grantId))ctx.addIssue({code:'custom',message:'权益来源不一致'});});
export type PublishingEntitlement = z.infer<typeof PublishingEntitlementSchema>;
export const PublishingPurchaseSchema = z.object({ id, planId: id, planVersion: z.number().int().positive(), planName: shortText, priceCents: z.number().int().positive(), createdAt: stamp }).strict();
export type PublishingPurchase = z.infer<typeof PublishingPurchaseSchema>;
export const PublishingTaskSchema = z.object({
  id, draftId: id, draftRevision: z.number().int().positive(), accountId: id, platform: PublishingPlatformSchema,
  status: z.enum(["awaiting_receipt", "unknown", "browser_reported"]), reportedSuccess: z.boolean().nullable(),
  workId: z.string().max(240).nullable(), shareLink: safeHttps.nullable(), receiptSource: z.literal("browser_reported").nullable(), createdAt: stamp, updatedAt: stamp,
}).strict();
export type PublishingTask = z.infer<typeof PublishingTaskSchema>;
export const PublishingPublicConfigSchema = z.object({ version: z.number().int().nonnegative(), mode: z.literal("browser_plugin"), executionEnabled: z.boolean(), salesEnabled: z.boolean(), cloudEnabled: z.literal(false), enabledPlatforms: z.array(PublishingCommercialPlatformSchema).max(14), pluginUrl: safeHttps.nullable(), announcement: z.string().max(2000), usageNotice: z.string().max(2000) }).strict();
export type PublishingPublicConfig = z.infer<typeof PublishingPublicConfigSchema>;
export const PublishingOperatorLinksSchema = z.object({ officialUrl: safeHttps.nullable(), docsUrl: safeHttps.nullable(), apiKeyUrl: safeHttps.nullable(), contactUrl: safeHttps.nullable(), pluginUrl: safeHttps.nullable() }).strict();
const procurementNotes = z.string().max(2000).refine((value) => !/(?:bearer\s+[A-Za-z0-9._-]{12,}|(?:api[_ -]?key|secret|token|cookie|password)\s*[:=]\s*\S{6,}|sk-[A-Za-z0-9]{12,})/i.test(value), "备注不得填写密钥、Cookie 或 Token");
const procurementVerifiedAt = z.string().datetime({ offset: true }).nullable();
export const PublishingConfigInputSchema = z.object({ expectedVersion: z.number().int().nonnegative(), executionEnabled: z.boolean(), salesEnabled: z.boolean(), enabledPlatforms: z.array(PublishingCommercialPlatformSchema).max(14), announcement: z.string().max(2000), operatorLinks: PublishingOperatorLinksSchema, procurementNotes, procurementVerifiedAt }).strict();
export const PublishingAdminConfigSchema = PublishingPublicConfigSchema.extend({ operatorLinks: PublishingOperatorLinksSchema, runtimeExecutionEnabled: z.boolean(), procurementNotes, procurementVerifiedAt }).strict();
export const PublishingCenterSchema = z.object({
  config: PublishingPublicConfigSchema, plans: z.array(PublishingPlanSchema), entitlements: z.array(PublishingEntitlementSchema), purchases: z.array(PublishingPurchaseSchema),
  accounts: z.array(PublishingAccountSchema), drafts: z.array(PublishingDraftSchema), tasks: z.array(PublishingTaskSchema), walletCash: z.number(), schemaReady: z.boolean(),
  access: z.object({ allowed: z.boolean(), code: z.string(), message: z.string() }).strict(),
}).strict();
export type PublishingCenter = z.infer<typeof PublishingCenterSchema>;
export const PublishingAdminTaskSchema = PublishingTaskSchema.omit({ workId: true, shareLink: true }).strict();
export const PublishingAdminStateSchema = z.object({
  config: PublishingAdminConfigSchema, plans: z.array(PublishingPlanSchema),
  stats: z.object({
    purchases: z.number().int().nonnegative(), tasks: z.number().int().nonnegative(), accounts: z.number().int().nonnegative(),
    sources: z.object({ tasksV1: z.number().int().nonnegative(), tasksV2: z.number().int().nonnegative(), tasksOfficial: z.number().int().nonnegative(), tasksGeneric: z.number().int().nonnegative().optional(), studioSchemaReady: z.boolean().optional(), accountsBrowser: z.number().int().nonnegative(), accountsDouyin: z.number().int().nonnegative(), accountsOAuth: z.number().int().nonnegative() }).strict().optional(),
  }).strict().nullable(),
  tasks: z.array(PublishingAdminTaskSchema), schemaReady: z.boolean(), sectionAccess: z.object({ billing: z.boolean() }).strict(),
}).strict();
export type PublishingAdminState = z.infer<typeof PublishingAdminStateSchema>;
const key = z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const PublishingActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-draft"), id: id.optional(), expectedRevision: z.number().int().nonnegative(), draft: PublishingDraftInputSchema }).strict(),
  z.object({ action: z.literal("delete-draft"), id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("save-account"), account: PublishingAccountInputSchema }).strict(),
  z.object({ action: z.literal("purchase"), planId: id, planVersion: z.number().int().positive(), idempotencyKey: key }).strict(),
  z.object({ action: z.literal("claim"), draftId: id, draftRevision: z.number().int().positive(), accountId: id, entitlementId: id, idempotencyKey: key }).strict(),
  z.object({ action: z.literal("report"), taskId: id, success: z.boolean(), workId: z.string().trim().max(240).optional(), shareLink: safeHttps.optional() }).strict(),
]);
export type PublishingAction = z.infer<typeof PublishingActionSchema>;
export const PublishingAdminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-config"), config: PublishingConfigInputSchema }).strict(),
  z.object({ action: z.literal("save-plan"), plan: PublishingPlanInputSchema }).strict(),
]);
export type PublishingAdminAction = z.infer<typeof PublishingAdminActionSchema>;
export const PublishingMutationResponseSchema = z.object({ ok: z.literal(true), draft: PublishingDraftSchema.optional(), account: PublishingAccountSchema.optional(), purchase: PublishingPurchaseSchema.optional(), entitlement: PublishingEntitlementSchema.optional(), task: PublishingTaskSchema.optional(), shouldExecute: z.boolean().optional(), alreadyFulfilled: z.boolean().optional(), deleted: z.boolean().optional() }).strict();
export type PublishingMutationResponse = z.infer<typeof PublishingMutationResponseSchema>;
export const PublishingRecoverySchema = z.object({ schemaReady: z.literal(true), found: z.boolean(), task: PublishingTaskSchema.nullable(), shouldExecute: z.literal(false) }).strict();
export type PublishingRecovery = z.infer<typeof PublishingRecoverySchema>;
export const PublishingSubmissionKeySchema = key;
/** Only clear a marker for its first attempt; never clear an older unknown attempt. */
export const PUBLISHING_SAFE_CLAIM_REJECTION_CODES: readonly string[] = [
  "PUBLISH_INPUT_INVALID", "PUBLISH_BODY_TOO_LARGE", "PUBLISH_ACCESS_DENIED", "PUBLISH_PERMISSION_UNAVAILABLE",
  "PUBLISH_USER_DISABLED", "PUBLISH_USER_NOT_FOUND", "PUBLISH_EXECUTION_DISABLED", "PUBLISH_DRAFT_NOT_FOUND",
  "PUBLISH_REVISION_CONFLICT", "PUBLISH_ACCOUNT_NOT_FOUND", "PUBLISH_ENTITLEMENT_NOT_FOUND", "PUBLISH_ENTITLEMENT_EXPIRED",
  "PUBLISH_NO_QUOTA", "PUBLISH_PLATFORM_NOT_ALLOWED", "PUBLISH_PLATFORM_DISABLED",
];
export const PUBLISHING_DEFAULT_PUBLIC_CONFIG: PublishingPublicConfig = { version: 0, mode: "browser_plugin", executionEnabled: false, salesEnabled: false, cloudEnabled: false, enabledPlatforms: ["xhs", "douyin", "wxSph"], pluginUrl: "https://aitoearn.cn/zh-CN/websit/plugin-guide", announcement: "发布服务尚未开放，您可以先整理成片和保存草稿。", usageNotice: PUBLISHING_USAGE_NOTICE };
export const PUBLISHING_DEFAULT_OPERATOR_LINKS = { officialUrl: "https://aitoearn.cn/", docsUrl: "https://docs.aitoearn.ai/zh/use/publish-flow", apiKeyUrl: "https://aitoearn.cn/zh-CN/developer/api-keys", contactUrl: "https://github.com/yikart/AiToEarn#社区与支持", pluginUrl: "https://aitoearn.cn/zh-CN/websit/plugin-guide" } as const;

const SHARE_HOSTS: Record<PublishingPlatform, readonly string[]> = {
  douyin: ["douyin.com", "iesdouyin.com"], xhs: ["xiaohongshu.com", "xhslink.com"], wxSph: ["channels.weixin.qq.com", "weixin.qq.com"],
};
export function isPublishingShareLink(platform: PublishingPlatform, value: string): boolean {
  if (!isPublishingSafeHttps(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  return SHARE_HOSTS[platform].some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
