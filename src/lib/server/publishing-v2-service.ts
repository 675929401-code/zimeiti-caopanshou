import "server-only";
import type { AuthUser, getSupabase } from "@/lib/api-middleware";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { PublishingError, publishingRuntimeEnabled } from "./publishing-service";
import { publishingCashFailure, publishingCashV2Proof } from './publishing-cash-service';
import { isPublishingShareLink } from "@/lib/publishing-contract";
import { parseMediaHistoryGallery } from "@/lib/media-history-gallery";
import { prepareNativePluginContent, validateNativePublishingMedia } from "@/lib/publishing-native";
import { PublishingV2AttemptSchema, PublishingV2BatchSchema, PublishingV2CollectionSchema, PublishingV2DraftInputSchema, PublishingV2DraftSchema, PublishingV2EventRecordSchema, PublishingV2GroupSchema, PublishingV2MutationSchema, PublishingV2PageSchema, PublishingV2ScheduleSchema, PublishingV2VersionSchema, PublishingV2AccountMetaSchema, type PublishingV2Action, type PublishingV2Query, type PublishingV2Page, type PublishingV2Mutation } from "@/lib/publishing-v2-contract";
type Database = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const absent = new Set(["42P01", "PGRST202", "PGRST204", "PGRST205"]);
const errors: Record<string, [number, string]> = {
  PUBLISH_INPUT_INVALID: [400, "内容管理字段或原生参数不符合合同"],
  PUBLISH_ACCESS_DENIED: [403, "当前会员未开通发布中心权限"], PUBLISH_PERMISSION_UNAVAILABLE: [503, "会员权限暂不可确认"], PUBLISH_USER_DISABLED: [403, "账户已停用"],
  PUBLISH_REVISION_CONFLICT: [409, "内容已有新版本，请刷新后保存"], PUBLISH_IDEMPOTENCY_CONFLICT: [409, "请求标识已用于其他内容，请核对原记录"], PUBLISH_RECEIPT_CONFLICT: [409, "回执与已保存结果冲突"],
  PUBLISH_DRAFT_NOT_FOUND: [404, "草稿不存在或已归档"], PUBLISH_ACCOUNT_NOT_FOUND: [404, "账号不存在或不属于当前会员"], PUBLISH_V2_COLLECTION_NOT_FOUND: [404, "内容集合不存在或已归档"], PUBLISH_V2_BATCH_NOT_FOUND: [404, "发布批次不存在"], PUBLISH_V2_ATTEMPT_NOT_FOUND: [404, "发布记录不存在"], PUBLISH_V2_TARGET_NOT_FOUND: [404, "发布目标不存在"],
  PUBLISH_V2_TARGET_ALREADY_CLAIMED: [409, "该批次目标已发起，请查看原记录"], PUBLISH_V2_TRANSPORT_UNCONFIGURED: [409, "该平台发布通道尚未配置，可先保存内容"], PUBLISH_EXECUTION_DISABLED: [409, "发布服务尚未开放，可以先保存草稿"], PUBLISH_PLATFORM_DISABLED: [409, "该平台暂未开放发布"], PUBLISH_PLATFORM_NOT_ALLOWED: [403, "执行套餐不支持该平台"],
  PUBLISH_V2_ACCOUNT_CHANGED: [409, "账号信息在批次创建后已变化，请核对账号并创建新批次"], PUBLISH_V2_ASSET_UNAVAILABLE: [409, "主站素材不可用或不属于当前会员，请重新选择"],
  PUBLISH_V2_SCHEDULE_NOT_FOUND: [404, "本地计划不存在或与本次发布目标不一致"],
  PUBLISH_V2_MEDIA_INVALID: [400, "请补齐当前平台所需的素材和视频信息"], PUBLISH_V2_NATIVE_SCHEDULE_UNAVAILABLE: [409, "该平台没有已核实的插件定时能力，请使用本地计划"], PUBLISH_V2_SCHEDULE_NOT_DUE: [409, "本地计划尚未到期，请在到期后确认发布"], PUBLISH_V2_SCHEDULE_LOCKED: [409, "该计划已经取消或发起，不能改期"], PUBLISH_V2_SCHEDULE_INVALID: [400, "计划时间必须晚于当前时间"],
  PUBLISH_ENTITLEMENT_NOT_FOUND: [404, "执行额度记录不存在"], PUBLISH_ENTITLEMENT_EXPIRED: [409, "执行额度已过期"], PUBLISH_NO_QUOTA: [409, "执行额度不足"],
};
function failDatabase(error: unknown, mutation = false): never {
  const row = object(error);
  if (absent.has(String(row.code))) throw new PublishingError("PUBLISH_V2_SCHEMA_NOT_READY", "内容管理升级尚未完成初始化", 503);
  const code = Object.keys(errors).find((item) => String(row.message).includes(item));
  if (code) throw new PublishingError(code, errors[code][1], errors[code][0]);
  throw new PublishingError("PUBLISH_V2_SERVICE_UNAVAILABLE", "操作结果暂不可确认，请刷新原记录核对", 503, mutation);
}
async function access(user: AuthUser): Promise<void> {
  const permission = await readMemberPermissionSnapshot(user.id, { knownRole: user.role });
  if (permission.authorityStatus !== "ready" || !permission.integrityValid || permission.checksum === "legacy-schema-absent") throw new PublishingError("PUBLISH_PERMISSION_UNAVAILABLE", "会员权限暂不可确认", 503);
  if (!permission.featureNavigationKeys.includes("publish_center")) throw new PublishingError("PUBLISH_ACCESS_DENIED", "当前会员未开通发布中心权限", 403);
}
function dto(kind: string, row: Row): unknown {
  const time = { createdAt: row.created_at, updatedAt: row.updated_at };
  switch (kind) {
    case "collection": return PublishingV2CollectionSchema.parse({ id: row.id, name: row.name, description: row.description, revision: row.revision, archived: row.archived, ...time });
    case "draft": return PublishingV2DraftSchema.parse({ id: row.id, revision: row.revision, payload: row.payload, archived: row.archived, ...time });
    case "version": return PublishingV2VersionSchema.parse({ draftId: row.draft_id, version: row.version, payload: row.payload, createdAt: row.created_at });
    case "group": return PublishingV2GroupSchema.parse({ id: row.id, name: row.name, accountIds: row.account_ids, revision: row.revision, ...time });
    case "accountMeta": return PublishingV2AccountMetaSchema.parse({ accountId: row.account_id, label: row.label, notes: row.notes, updatedAt: row.updated_at });
    case "batch": return PublishingV2BatchSchema.parse({ id: row.id, draftId: row.draft_id, draftVersion: row.draft_version, targetIds: row.target_ids, accountSnapshots: row.account_snapshots, requestKey: row.request_key, createdAt: row.created_at });
    case "schedule": return PublishingV2ScheduleSchema.parse({ id: row.id, draftId: row.draft_id, draftVersion: row.draft_version, targetId: row.target_id, scheduledAt: row.scheduled_at, revision: row.revision, state: row.state, ...time });
    case "attempt": return PublishingV2AttemptSchema.parse({ id: row.id, batchId: row.batch_id, targetId: row.target_id, ...(row.entitlement_id ? { entitlementId: row.entitlement_id } : {}), ...(row.cash_admission_id ? { cashAdmissionId: row.cash_admission_id } : {}), platform: row.platform, transport: row.transport, snapshot: row.snapshot, snapshotHash: row.snapshot_hash, requestKey: row.request_key, createdAt: row.created_at });
    case "event": return PublishingV2EventRecordSchema.parse({ id: row.id, attemptId: row.attempt_id, kind: row.kind, requestKey: row.request_key, payload: row.payload, source: row.source, createdAt: row.created_at });
    default: throw new PublishingError("PUBLISH_V2_SERVICE_UNAVAILABLE", "返回内容类型无法确认", 503, true);
  }
}
const resources = {
  collections: ["pub2_collections", "collection", "created_at"], drafts: ["pub2_drafts", "draft", "created_at"], versions: ["pub2_draft_versions", "version", "created_at"], groups: ["pub2_groups", "group", "created_at"], "account-meta": ["pub2_account_meta", "accountMeta", "updated_at"], batches: ["pub2_batches", "batch", "created_at"], attempts: ["pub2_attempts", "attempt", "created_at"], events: ["pub2_attempt_events", "event", "created_at"], schedules: ["pub2_schedules", "schedule", "created_at"],
} as const;
export async function readPublishingV2(user: AuthUser, database: Database, query: PublishingV2Query): Promise<PublishingV2Page> {
  await access(user);
  const [table, kind, order] = resources[query.resource];
  let builder = database.from(table).select("*", { count: "exact" }).eq("user_id", user.id).order(order, { ascending: false });
  builder = builder.order(kind === "version" ? "draft_id" : kind === "accountMeta" ? "account_id" : "id", { ascending: false });
  if (kind === "version") builder = builder.order("version", { ascending: false });
  if (query.draftId && ["versions", "batches", "schedules"].includes(query.resource)) builder = builder.eq("draft_id", query.draftId);
  if (query.version !== undefined && query.resource === "versions") builder = builder.eq("version", query.version);
  if (query.attemptId && query.resource === "events") builder = builder.eq("attempt_id", query.attemptId);
  if (query.eventKind && query.resource === "events") builder = builder.eq("kind", query.eventKind);
  if (query.attemptId && query.resource === "attempts") builder = builder.eq("id", query.attemptId);
  if (query.requestKey && ["attempts", "batches", "events"].includes(query.resource)) builder = builder.eq("request_key", query.requestKey);
  const result = await builder.range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1);
  const base = { resource: query.resource, page: query.page, pageSize: query.pageSize, total: 0, hasMore: false, items: [] };
  if (result.error) {
    if (absent.has(result.error.code)) return PublishingV2PageSchema.parse({ ...base, schemaReady: false });
    failDatabase(result.error);
  }
  const source = list(result.data);
  if (kind === "draft") await Promise.all(source.map(async (row) => {
    const version = await database.from("pub2_draft_versions").select("payload").eq("user_id", user.id).eq("draft_id", String(row.id)).eq("version", Number(row.revision)).single();
    if (version.error) failDatabase(version.error);
    row.payload = object(version.data).payload;
  }));
  const total = result.count ?? 0;
  return PublishingV2PageSchema.parse({ ...base, schemaReady: true, total, hasMore: query.page * query.pageSize < total, items: source.map((row) => dto(kind, row)) });
}
export async function mutatePublishingV2(user: AuthUser, database: Database, action: PublishingV2Action): Promise<PublishingV2Mutation> {
  await access(user);
  if (action.action === "claim" && !publishingRuntimeEnabled()) throw new PublishingError("PUBLISH_EXECUTION_DISABLED", "发布服务尚未开放，可以先保存草稿", 409);
  if (action.action === "claim") await validateNativeClaimBeforeQuota(user, database, action);
  if (action.action === "report" || action.action === "append-link") {
    const previous = await database.from("pub2_attempts").select("platform").eq("id", action.attemptId).eq("user_id", user.id).maybeSingle();
    if (previous.error) failDatabase(previous.error);
    const platform = object(previous.data).platform;
    if (platform !== "xhs" && platform !== "wxSph" && platform !== "douyin") throw new PublishingError("PUBLISH_V2_ATTEMPT_NOT_FOUND", "发布记录不存在", 404);
    if (action.shareLink && !isPublishingShareLink(platform, action.shareLink)) throw new PublishingError("PUBLISH_SHARE_LINK_INVALID", "作品链接与发布平台不一致", 400);
  }
  if (action.action === "save-draft") {
    const draft = PublishingV2DraftInputSchema.parse(action.draft);
    for (const media of draft.media) if (media.source === "main_asset" && media.reference.kind === "image_gallery") {
      const reference = media.reference;
      const history = await database.from("conversation_messages").select("content").eq("id", reference.id).eq("user_id", user.id).eq("role", "assistant").maybeSingle();
      if (history.error) failDatabase(history.error);
      const image = parseMediaHistoryGallery(object(history.data).content)?.images[reference.index];
      if (!image?.assetId || !image.storageKey) throw new PublishingError("PUBLISH_V2_ASSET_UNAVAILABLE", "图片历史缺少有效的主站资产引用", 409);
      const owned = await database.from("user_files").select("id,content_type").eq("id", image.assetId).eq("user_id", user.id).eq("storage_key", image.storageKey).maybeSingle();
      if (owned.error) failDatabase(owned.error);
      if (!String(object(owned.data).content_type || "").startsWith("image/")) throw new PublishingError("PUBLISH_V2_ASSET_UNAVAILABLE", "图片资产不属于当前会员或已不可用", 409);
      media.reference = { kind: "image_asset", id: image.assetId };
    }
    action = { ...action, draft };
  }
  const cashContentCanonical = action.action === 'claim' && action.funding ? await publishingCashV2Proof(user, database, action.batchId, action.targetId, action.funding, action.scheduleId) : undefined;
  const result = await database.rpc("mutate_publish_v2_atomic", { p_user_id: user.id, p_input: { ...action, ...(cashContentCanonical ? { cashContentCanonical } : {}) } } as never);
  if (result.error) { if (/PUBLISH_CASH_|VIDEO_BUDGET_CASH_RESERVED|WALLET_INSUFFICIENT/.test(result.error.message)) publishingCashFailure(result.error); failDatabase(result.error, true); }
  return projectPublishingV2Mutation(result.data);
}
export function projectPublishingV2Mutation(value: unknown): PublishingV2Mutation {
  const row = object(value);
  if (row.deleted === true) return { ok: true, deleted: true };
  const kind = String(row.kind);
  return PublishingV2MutationSchema.parse({ ok: true, [kind]: dto(kind, object(row.row)), ...(typeof row.shouldExecute === "boolean" ? { shouldExecute: row.shouldExecute } : {}), ...(typeof row.alreadyFulfilled === "boolean" ? { alreadyFulfilled: row.alreadyFulfilled } : {}) });
}

/** Validate first-time dispatch before the atomic quota mutation. Replays go to
 * the RPC unchanged so a newer content rule cannot hide an existing receipt. */
async function validateNativeClaimBeforeQuota(user: AuthUser, database: Database, action: Extract<PublishingV2Action, { action: "claim" }>): Promise<void> {
  const previous = await Promise.all([
    database.from("pub2_attempts").select("id").eq("user_id", user.id).eq("request_key", action.idempotencyKey).maybeSingle(),
    database.from("pub2_attempts").select("id").eq("user_id", user.id).eq("batch_id", action.batchId).eq("target_id", action.targetId).maybeSingle(),
  ]);
  for (const result of previous) if (result.error) failDatabase(result.error);
  if (previous.some((result) => !!result.data)) return;
  const batchResult = await database.from("pub2_batches").select("draft_id,draft_version,target_ids").eq("id", action.batchId).eq("user_id", user.id).maybeSingle();
  if (batchResult.error) failDatabase(batchResult.error);
  const batch = object(batchResult.data);
  if (!batchResult.data) throw new PublishingError("PUBLISH_V2_BATCH_NOT_FOUND", "发布批次不存在", 404);
  if (!Array.isArray(batch.target_ids) || !batch.target_ids.includes(action.targetId)) throw new PublishingError("PUBLISH_V2_TARGET_NOT_FOUND", "发布目标不属于该批次", 404);
  const versionResult = await database.from("pub2_draft_versions").select("payload").eq("user_id", user.id).eq("draft_id", String(batch.draft_id)).eq("version", Number(batch.draft_version)).maybeSingle();
  if (versionResult.error) failDatabase(versionResult.error);
  if (!versionResult.data) throw new PublishingError("PUBLISH_REVISION_CONFLICT", "内容版本已不可读取，请刷新核对", 409);
  const draft = PublishingV2DraftInputSchema.parse(object(versionResult.data).payload);
  const target = draft.targets.find((item) => item.id === action.targetId);
  if (!target) throw new PublishingError("PUBLISH_V2_TARGET_NOT_FOUND", "内容版本中没有该目标", 404);
  if (target.platform === "douyin" && target.options.privacyLevel === "private") throw new PublishingError("PUBLISH_INPUT_INVALID", "抖音浏览器通道未核实私密发布能力", 400);
  const selected = target.mediaIds ? target.mediaIds.map((mediaId) => draft.media.find((media) => media.id === mediaId)) : draft.media.filter((item) => item.role !== "cover");
  if (selected.some((media) => !media)) throw new PublishingError("PUBLISH_INPUT_INVALID", "目标素材引用不完整，请重新选择", 400);
  const media = selected.filter((item): item is typeof draft.media[number] => !!item);
  const poolCovers = draft.media.filter((item) => item.role === "cover");
  if (!target.mediaIds && !target.coverMediaId && poolCovers.length > 1) throw new PublishingError("PUBLISH_INPUT_INVALID", "素材池有多张封面，请为该目标明确选择封面", 400);
  const cover = target.coverMediaId ? draft.media.find((item) => item.id === target.coverMediaId) : !target.mediaIds && poolCovers.length === 1 ? poolCovers[0] : undefined;
  const content = prepareNativePluginContent(target.platform, target.titleOverride ?? draft.title, target.bodyOverride ?? draft.body, target.topicsOverride ?? draft.topics);
  const mediaErrors = validateNativePublishingMedia(target.platform, draft.contentType, media, cover, action.scheduleId ? null : target.scheduledAt);
  const problems = [...content.errors, ...mediaErrors];
  if (problems.length) throw new PublishingError("PUBLISH_INPUT_INVALID", problems.join("；").slice(0,1000), 400);
}
