import { z } from "zod";
import { isPublishingSafeHttps } from "./publishing-contract";

/** Authorization only. A connected account does not enable a publishing transport. */
export const PUBLISHING_OAUTH_PLATFORMS = ["linkedin", "threads", "instagram", "KWAI", "pinterest", "wxGzh", "bilibili", "facebook", "youtube", "tiktok", "twitter"] as const;
export const PublishingAuthorizationPlatformSchema = z.enum(PUBLISHING_OAUTH_PLATFORMS);
export type PublishingAuthorizationPlatform = z.infer<typeof PublishingAuthorizationPlatformSchema>;
const id = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
const requestKey = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const stamp = z.string().datetime({ offset: true });
const safeAvatar = z.string().max(2048).refine(isPublishingSafeHttps);
const start = z.object({ action: z.literal("start"), platform: PublishingAuthorizationPlatformSchema, requestKey, groupId: id.optional(), expectedGroupRevision: revision.optional() }).strict().superRefine((v, ctx) => {
  if ((v.groupId === undefined) !== (v.expectedGroupRevision === undefined)) ctx.addIssue({ code: "custom", message: "分组与分组版本必须同时提供" });
});
export const PublishingAuthorizationActionSchema = z.discriminatedUnion("action", [
  start,
  z.object({ action: z.literal("select"), sessionId: id, expectedRevision: revision, choiceIds: z.array(id).min(1).max(100).refine(v => new Set(v).size === v.length), requestKey }).strict(),
  z.object({ action: z.literal("disconnect"), bindingId: id, expectedRevision: revision, requestKey }).strict(),
  z.object({ action: z.literal("move-binding"), bindingId: id, expectedRevision: revision, groupId: id.nullable(), expectedGroupRevision: revision.optional(), requestKey }).strict().superRefine((v, ctx) => {
    if ((v.groupId !== null) !== (v.expectedGroupRevision !== undefined)) ctx.addIssue({ code: "custom", message: "目标分组需要明确版本，移出分组不接受分组版本" });
  }),
]);
export type PublishingAuthorizationAction = z.infer<typeof PublishingAuthorizationActionSchema>;
export const PublishingAuthorizationQuerySchema = z.discriminatedUnion("resource", [
  z.object({ resource: z.literal("session"), id }).strict(),
  z.object({ resource: z.literal("bindings"), page: z.coerce.number().int().positive().max(1000000).default(1), pageSize: z.coerce.number().int().positive().max(100).default(30), platform: PublishingAuthorizationPlatformSchema.optional() }).strict(),
  z.object({ resource: z.literal("operations"), id: id.optional(), requestKey: requestKey.optional(), page: z.coerce.number().int().positive().max(1000000).default(1), pageSize: z.coerce.number().int().positive().max(100).default(30) }).strict().refine(v => !(v.id && v.requestKey), "操作ID与请求标识只能选一项"),
]);
export type PublishingAuthorizationQuery = z.infer<typeof PublishingAuthorizationQuerySchema>;
export const PublishingAuthorizationStateSchema = z.enum(["prepared", "pending", "requires_selection", "completed", "failed", "unknown", "expired"]);
export const PublishingAuthorizationChoiceSchema = z.object({ id, displayName: z.string().max(240), avatar: safeAvatar.optional(), parentDisplayName: z.string().max(240).optional() }).strict();
export const PublishingAuthorizationSessionSchema = z.object({
  id, platform: PublishingAuthorizationPlatformSchema, authType: z.literal("oauth2"), state: PublishingAuthorizationStateSchema, revision,
  expiresAt: stamp.nullable(), connectionCurrent: z.boolean(), continuationReady: z.boolean(), authUrl: z.string().max(16384).optional(),
  instructions: z.object({ "zh-CN": z.string().max(2000), "en-US": z.string().max(2000) }).strict().optional(),
  choices: z.array(PublishingAuthorizationChoiceSchema).max(100), bindingIds: z.array(id).max(100), errorCode: z.string().max(100).nullable(), createdAt: stamp, updatedAt: stamp,
}).strict();
export const PublishingAuthorizationBindingSchema = z.object({
  id, platform: PublishingAuthorizationPlatformSchema, platformUid: z.string().min(1).max(240), account: z.string().max(240).optional(), displayName: z.string().max(240), avatar: safeAvatar.optional(),
  status: z.enum(["active", "disconnected", "unknown"]), revision, groupId: id.nullable(), authSessionId: id, connectionCurrent: z.boolean(),
  capabilities: z.object({ connect: z.literal(true), publish: z.literal(false), analytics: z.literal(false), engagement: z.literal(false) }).strict(), createdAt: stamp, updatedAt: stamp,
}).strict();
export const PublishingAuthorizationOperationSchema = z.object({ id, kind: z.enum(["start", "select", "move_binding", "disconnect_binding"]), requestKey, sessionId: id.nullable(), bindingId: id.nullable(),
  dispatchState: z.enum(["ready", "dispatching", "dispatched", "unknown", "settled", "blocked"]), grantUsed: z.boolean(), revision, connectionCurrent: z.boolean(), errorCode: z.string().max(100).nullable(), createdAt: stamp, updatedAt: stamp }).strict();
export const PublishingAuthorizationMutationSchema = z.object({ operation: PublishingAuthorizationOperationSchema, session: PublishingAuthorizationSessionSchema.optional(), binding: PublishingAuthorizationBindingSchema.optional(), alreadyFulfilled: z.boolean() }).strict();
export const PublishingAuthorizationPageSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), total: z.number().int().nonnegative(), page: z.number().int().positive(), pageSize: z.number().int().positive().max(100) }).strict();
export type PublishingAuthorizationSession = z.infer<typeof PublishingAuthorizationSessionSchema>;
export type PublishingAuthorizationBinding = z.infer<typeof PublishingAuthorizationBindingSchema>;
export type PublishingAuthorizationMutation = z.infer<typeof PublishingAuthorizationMutationSchema>;
