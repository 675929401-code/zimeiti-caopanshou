import { z } from "zod";
import { PublishingPlatformSchema, isPublishingSafeHttps } from "./publishing-contract";
import { PublishingCashFundingSchema } from './publishing-cash-contract';
const id = z.string().uuid();
const stamp = z.string().datetime({ offset: true });
const key = z.string().min(8).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().trim().max(200);
const safeUrl = z.string().max(2048).refine(isPublishingSafeHttps);
export const PublishingV2PoiSchema = z.object({ latitude: z.number().finite().min(-90).max(90).optional(), longitude: z.number().finite().min(-180).max(180).optional(), poiCity: text.optional(), poiName: text.optional(), poiAddress: z.string().max(500).optional(), poiId: text.optional(), province: text.optional(), region: text.optional(), fullAddress: z.string().max(500).optional(), poiCheckSum: text.optional() }).strict().refine((value) => !!value.poiId || !!value.poiName, "地点需包含标识或名称");
export const PublishingV2EventSchema = z.object({ eventTopicId: text.min(1), eventName: text.min(1), eventCreatorNickname: text.optional(), eventAttendCount: z.number().int().nonnegative().optional() }).strict();
export const PublishingV2XhsOptionsSchema = z.object({ declaration: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }).strict();
export const PublishingV2WxOptionsSchema = z.object({ poiInfo: PublishingV2PoiSchema.optional(), event: PublishingV2EventSchema.optional(), extLink: safeUrl.optional(), postFlag: z.union([z.literal(0), z.literal(1)]).optional() }).strict();
export const PublishingV2DouyinOptionsSchema = z.object({ privacyLevel: z.enum(["public", "private"]).optional() }).strict();
const targetBase = { id, accountId: id, scheduledAt: stamp.nullable(), titleOverride: z.string().max(200).optional(), bodyOverride: z.string().max(50000).optional(), topicsOverride: z.array(z.string().trim().min(1).max(100)).max(30).optional(), mediaIds: z.array(id).min(1).max(35).optional(), coverMediaId: id.optional() };
export const PublishingV2TargetSchema = z.discriminatedUnion("platform", [
  z.object({ ...targetBase, platform: z.literal("xhs"), options: PublishingV2XhsOptionsSchema }).strict(),
  z.object({ ...targetBase, platform: z.literal("wxSph"), options: PublishingV2WxOptionsSchema }).strict(),
  z.object({ ...targetBase, platform: z.literal("douyin"), options: PublishingV2DouyinOptionsSchema }).strict(),
]);
export type PublishingV2Target = z.infer<typeof PublishingV2TargetSchema>;
const mediaFields = { id, role: z.enum(["image", "video", "cover"]), fileName: z.string().min(1).max(255), size: z.number().int().nonnegative().max(10 * 1024 ** 3), type: z.string().max(120), lastModified: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/).optional(), width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(), duration: z.number().finite().positive().optional() };
const referenceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
export const PublishingV2AssetReferenceSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("video_task"), id: referenceId }).strict(), z.object({ kind: z.literal("image_asset"), id }).strict(), z.object({ kind: z.literal("image_record"), id: referenceId }).strict(), z.object({ kind: z.literal("image_gallery"), id: referenceId, index: z.number().int().min(0).max(1000) }).strict()]);
export const PublishingV2MediaSchema = z.discriminatedUnion("source", [z.object({ ...mediaFields, source: z.literal("local_file"), requiresReselection: z.literal(true) }).strict(), z.object({ ...mediaFields, source: z.literal("main_asset"), requiresReselection: z.literal(false), reference: PublishingV2AssetReferenceSchema }).strict()]);
export type PublishingV2Media = z.infer<typeof PublishingV2MediaSchema>;
export const PublishingV2DraftInputSchema = z.object({ schemaVersion: z.literal(2).default(2), collectionId: id.nullable(), contentType: z.enum(["image", "video"]), title: z.string().max(200), body: z.string().max(50000), topics: z.array(z.string().trim().min(1).max(100)).max(30), media: z.array(PublishingV2MediaSchema).max(100), targets: z.array(PublishingV2TargetSchema).max(100) }).strict().superRefine((value, context) => {
  for (const field of ["media", "targets"] as const) if (new Set(value[field].map((item) => item.id)).size !== value[field].length) context.addIssue({ code: "custom", path: [field], message: "标识必须唯一，数组顺序即素材顺序" });
  if (new Set(value.targets.map((item) => `${item.platform}:${item.accountId}`)).size !== value.targets.length) context.addIssue({ code: "custom", path: ["targets"], message: "每个草稿的同一平台账号只能出现一次" });
  for (const [index, target] of value.targets.entries()) {
    if (target.mediaIds && (new Set(target.mediaIds).size !== target.mediaIds.length || target.mediaIds.some((mediaId) => !value.media.some((media) => media.id === mediaId)))) context.addIssue({ code: "custom", path: ["targets", index, "mediaIds"], message: "目标素材必须为当前草稿素材的有序子集" });
    if (target.coverMediaId && !value.media.some((media) => media.id === target.coverMediaId && media.role !== "video")) context.addIssue({ code: "custom", path: ["targets", index, "coverMediaId"], message: "封面必须引用当前草稿图片" });
  }
  if (value.contentType === "image" && value.media.some((item) => item.role === "video")) context.addIssue({ code: "custom", path: ["media"], message: "图文草稿不能包含视频" });
  // A draft is a media pool. Each target selects its ordered subset and cover;
  // execution enforces one actual video and cover for that target.
});
export type PublishingV2DraftInput = z.infer<typeof PublishingV2DraftInputSchema>;
export const PublishingV2DraftSchema = z.object({ id, revision: z.number().int().positive(), payload: PublishingV2DraftInputSchema, archived: z.boolean(), createdAt: stamp, updatedAt: stamp }).strict();
export type PublishingV2Draft = z.infer<typeof PublishingV2DraftSchema>;
export const PublishingV2CollectionSchema = z.object({ id, name: text.min(1), description: z.string().max(2000), revision: z.number().int().positive(), archived: z.boolean(), createdAt: stamp, updatedAt: stamp }).strict();
export type PublishingV2Collection = z.infer<typeof PublishingV2CollectionSchema>;
export const PublishingV2GroupSchema = z.object({ id, name: text.min(1), accountIds: z.array(id).max(100), revision: z.number().int().positive(), createdAt: stamp, updatedAt: stamp }).strict();
export type PublishingV2Group = z.infer<typeof PublishingV2GroupSchema>;
export const PublishingV2AccountMetaSchema = z.object({ accountId: id, label: text, notes: z.string().max(1000), updatedAt: stamp }).strict();
export const PublishingV2AccountSnapshotSchema = z.object({ id, platform: PublishingPlatformSchema, platformAccountId: text.min(1), displayName: text, updatedAt: stamp }).strict();
export const PublishingV2BatchSchema = z.object({ id, draftId: id, draftVersion: z.number().int().positive(), targetIds: z.array(id), accountSnapshots: z.array(PublishingV2AccountSnapshotSchema), requestKey: key, createdAt: stamp }).strict();
export type PublishingV2Batch = z.infer<typeof PublishingV2BatchSchema>;
export const PublishingV2ScheduleSchema = z.object({ id, draftId: id, draftVersion: z.number().int().positive(), targetId: id, scheduledAt: stamp, revision: z.number().int().positive(), state: z.enum(["planned", "cancelled", "claimed"]), createdAt: stamp, updatedAt: stamp }).strict();
export type PublishingV2Schedule = z.infer<typeof PublishingV2ScheduleSchema>;
export const PublishingV2SnapshotSchema = z.object({ draft: PublishingV2DraftInputSchema, draftId: id, draftVersion: z.number().int().positive(), target: PublishingV2TargetSchema, account: PublishingV2AccountSnapshotSchema, localSchedule: z.object({ id, scheduledAt: stamp }).strict().nullable(), transport: z.literal("browser_plugin") }).strict();
export const PublishingV2AttemptSchema = z.object({ id, batchId: id, targetId: id, entitlementId: id.optional(), cashAdmissionId: id.optional(), platform: PublishingPlatformSchema, transport: z.literal("browser_plugin"), snapshot: PublishingV2SnapshotSchema, snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), requestKey: key, createdAt: stamp }).strict().refine(value => Boolean(value.entitlementId) !== Boolean(value.cashAdmissionId), '发布资金凭据必须明确且唯一');
export type PublishingV2Attempt = z.infer<typeof PublishingV2AttemptSchema>;
const receiptFields = { workId: z.string().max(240).optional(), shareLink: safeUrl.optional(), note: z.string().max(1000).optional(), mediaMd5sum: z.string().regex(/^[a-fA-F0-9]{32}$/).optional(), videoClipTaskId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/).optional(), scheduledTime: z.number().int().positive().lt(8640000000000000).optional(), publishTime: stamp.optional(), errorCode: z.enum(["WX_SPH_LOGIN_EXPIRED", "PUBLISH_FAILED", "NETWORK_ERROR", "UPLOAD_FAILED"]).optional() };
export const PublishingV2EventRecordSchema = z.object({ id, attemptId: id, kind: z.enum(["browser_report", "append_link"]), requestKey: key, payload: z.object({ success: z.boolean().optional(), ...receiptFields }).strict(), source: z.enum(["browser_reported", "user_reported"]), createdAt: stamp }).strict();
export type PublishingV2EventRecord = z.infer<typeof PublishingV2EventRecordSchema>;
export const PublishingV2ResourceSchema = z.enum(["collections", "drafts", "versions", "groups", "account-meta", "batches", "attempts", "events", "schedules"]);
export const PublishingV2QuerySchema = z.object({ resource: PublishingV2ResourceSchema.default("drafts"), page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), draftId: id.optional(), version: z.coerce.number().int().positive().optional(), attemptId: id.optional(), eventKind: z.enum(["browser_report", "append_link"]).optional(), requestKey: key.optional() }).strict().superRefine((value, context) => {
  if (value.version !== undefined && (value.resource !== "versions" || !value.draftId)) context.addIssue({ code: "custom", path: ["version"], message: "查询指定版本必须同时指定草稿" });
  if (value.eventKind !== undefined && value.resource !== "events") context.addIssue({ code: "custom", path: ["eventKind"], message: "事件类型仅可用于事件查询" });
});
export type PublishingV2Query = z.infer<typeof PublishingV2QuerySchema>;
export const PublishingV2VersionSchema = z.object({ draftId: id, version: z.number().int().positive(), payload: PublishingV2DraftInputSchema, createdAt: stamp }).strict();
export const PublishingV2PageSchema = z.object({ schemaReady: z.boolean(), resource: PublishingV2ResourceSchema, page: z.number().int().positive(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative(), hasMore: z.boolean(), items: z.array(z.union([PublishingV2CollectionSchema, PublishingV2DraftSchema, PublishingV2VersionSchema, PublishingV2GroupSchema, PublishingV2AccountMetaSchema, PublishingV2BatchSchema, PublishingV2AttemptSchema, PublishingV2EventRecordSchema, PublishingV2ScheduleSchema])) }).strict();
export type PublishingV2Page = z.infer<typeof PublishingV2PageSchema>;
export const PublishingV2ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save-collection"), id: id.optional(), expectedRevision: z.number().int().nonnegative(), name: text.min(1), description: z.string().max(2000), archived: z.boolean() }).strict(),
  z.object({ action: z.literal("save-draft"), id: id.optional(), expectedRevision: z.number().int().nonnegative(), draft: PublishingV2DraftInputSchema }).strict(),
  z.object({ action: z.literal("archive-draft"), id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("save-group"), id: id.optional(), expectedRevision: z.number().int().nonnegative(), name: text.min(1), accountIds: z.array(id).max(100) }).strict(),
  z.object({ action: z.literal("delete-group"), id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("save-account-meta"), accountId: id, label: text, notes: z.string().max(1000) }).strict(),
  z.object({ action: z.literal("create-batch"), draftId: id, draftVersion: z.number().int().positive(), targetIds: z.array(id).min(1).max(100), idempotencyKey: key }).strict(),
  z.object({ action: z.literal("save-schedule"), draftId: id, draftVersion: z.number().int().positive(), targetId: id, scheduledAt: stamp }).strict(),
  z.object({ action: z.literal("reschedule"), id, expectedRevision: z.number().int().positive(), scheduledAt: stamp }).strict(),
  z.object({ action: z.literal("cancel-schedule"), id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal("claim"), batchId: id, targetId: id, entitlementId: id.optional(), funding: PublishingCashFundingSchema.optional(), scheduleId: id.optional(), idempotencyKey: key }).strict().refine(v => Boolean(v.entitlementId) !== Boolean(v.funding), '发布资金来源必须明确且唯一'),
  z.object({ action: z.literal("report"), attemptId: id, idempotencyKey: key, success: z.boolean(), ...receiptFields }).strict(),
  z.object({ action: z.literal("append-link"), attemptId: id, idempotencyKey: key, shareLink: safeUrl, workId: z.string().max(240).optional(), note: z.string().max(1000).optional() }).strict(),
]);
export type PublishingV2Action = z.infer<typeof PublishingV2ActionSchema>;
export const PublishingV2MutationSchema = z.object({ ok: z.literal(true), collection: PublishingV2CollectionSchema.optional(), draft: PublishingV2DraftSchema.optional(), group: PublishingV2GroupSchema.optional(), accountMeta: PublishingV2AccountMetaSchema.optional(), batch: PublishingV2BatchSchema.optional(), schedule: PublishingV2ScheduleSchema.optional(), attempt: PublishingV2AttemptSchema.optional(), event: PublishingV2EventRecordSchema.optional(), shouldExecute: z.boolean().optional(), alreadyFulfilled: z.boolean().optional(), deleted: z.boolean().optional() }).strict();
export type PublishingV2Mutation = z.infer<typeof PublishingV2MutationSchema>;
