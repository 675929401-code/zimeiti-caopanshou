import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthUser } from "@/lib/api-middleware";
import { getSupabase } from "@/lib/api-middleware";
import { readMemberPermissionSnapshot } from "@/lib/server/member-permission-authority";
import { PublishingPurchaseRecoverySchema, type PublishingPurchaseRecovery } from "@/lib/publishing-purchase-recovery";
import {
  PUBLISHING_DEFAULT_OPERATOR_LINKS, PUBLISHING_DEFAULT_PUBLIC_CONFIG, PUBLISHING_USAGE_NOTICE,
  PublishingAccountSchema, PublishingAdminStateSchema, PublishingCenterSchema, PublishingDraftSchema,
  PublishingEntitlementSchema, PublishingMutationResponseSchema, PublishingPlanSchema, PublishingPurchaseSchema,
  PublishingTaskSchema, PublishingRecoverySchema, PublishingSubmissionKeySchema, isPublishingShareLink,
  type PublishingAction, type PublishingAdminAction, type PublishingAdminState, type PublishingCenter,
  type PublishingMutationResponse, type PublishingPlatform, type PublishingCommercialPlatform, type PublishingPublicConfig, type PublishingRecovery,
} from "@/lib/publishing-contract";

type Row = Record<string, unknown>;
type Database = ReturnType<typeof getSupabase>;
const absentCodes = new Set(["42P01", "PGRST202", "PGRST204", "PGRST205"]);
export class PublishingError extends Error {
  constructor(public code: string, message: string, public status = 400, public outcomeUnknown = false) { super(message); }
}
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(record) : []; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function num(value: unknown): number { return Number(value || 0); }
function nullable(value: unknown): string | null { return typeof value === "string" && value ? value : null; }
export function publishingRuntimeEnabled(): boolean { return process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED === "true"; }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

const errorMessages: Record<string, [number, string]> = {
  PUBLISH_ACCESS_DENIED: [403, "当前会员未开通发布中心权限"], PUBLISH_PERMISSION_UNAVAILABLE: [503, "会员权限暂不可确认，请稍后重试"],
  PUBLISH_USER_DISABLED: [403, "账户已停用"], PUBLISH_USER_NOT_FOUND: [401, "账户不存在"],
  PUBLISH_EXECUTION_DISABLED: [409, "发布服务尚未开放，请先保存草稿"], PUBLISH_SALES_DISABLED: [409, "发布套餐暂未开放购买"],
  PUBLISH_PLAN_UNAVAILABLE: [409, "套餐已更新或暂停销售，请刷新后查看"], PUBLISH_IDEMPOTENCY_CONFLICT: [409, "该请求标识已用于不同内容，请核对原记录"],
  PUBLISH_REVISION_CONFLICT: [409, "内容已更新，请刷新后再操作"], PUBLISH_RECEIPT_CONFLICT: [409, "回执与已保存结果冲突，请核对原记录"],
  PUBLISH_DRAFT_NOT_FOUND: [404, "草稿不存在"], PUBLISH_ACCOUNT_NOT_FOUND: [404, "账号记录不存在"], PUBLISH_TASK_NOT_FOUND: [404, "发布记录不存在"],
  PUBLISH_ENTITLEMENT_NOT_FOUND: [404, "执行额度记录不存在"], PUBLISH_ENTITLEMENT_EXPIRED: [409, "执行额度已过期"], PUBLISH_NO_QUOTA: [409, "执行额度不足"],
  PUBLISH_PLATFORM_NOT_ALLOWED: [403, "草稿或套餐不支持该平台"], PUBLISH_PLATFORM_DISABLED: [409, "该平台暂未开放发布"],
  INSUFFICIENT_CASH: [409, "现金余额不足，请先前往充值中心充值"], VIDEO_BUDGET_CASH_RESERVED: [409, "可用现金余额不足，部分余额可能被进行中的任务占用，请核对后充值"], WALLET_USER_ID_NOT_UUID_COMPATIBLE: [409, "账户账务身份暂不支持购买，请联系管理员"],
  PUBLISH_INPUT_INVALID: [400, "请求内容不符合发布合同"],
};
function databaseFailure(error: unknown, mutation = false): never {
  const value = record(error);
  if (absentCodes.has(str(value.code))) throw new PublishingError("PUBLISH_SCHEMA_NOT_READY", "发布中心尚未完成初始化", 503);
  const message = str(value.message);
  const code = Object.keys(errorMessages).find((candidate) => message.includes(candidate));
  if (code) throw new PublishingError(code, errorMessages[code][1], errorMessages[code][0]);
  throw new PublishingError("PUBLISH_SERVICE_UNAVAILABLE", mutation ? "操作结果暂不可确认，请刷新记录核对，请勿重复发起" : "发布中心暂不可用，请稍后重试", 503, mutation);
}
async function rpc(database: Database, name: string, args: Row): Promise<Row> {
  // This legacy client has no generated schema for newly versioned RPCs.
  const result = await database.rpc(name, args as never);
  if (result.error) databaseFailure(result.error, true);
  return record(result.data);
}
async function memberAccess(user: AuthUser): Promise<PublishingCenter["access"]> {
  const snapshot = await readMemberPermissionSnapshot(user.id, { knownRole: user.role });
  if (snapshot.authorityStatus !== "ready" || !snapshot.integrityValid || snapshot.checksum === "legacy-schema-absent") {
    return { allowed: false, code: "PUBLISH_PERMISSION_UNAVAILABLE", message: "会员权限暂不可确认，请稍后重试" };
  }
  const allowed = snapshot.featureNavigationKeys.includes("publish_center");
  return { allowed, code: allowed ? "PUBLISH_ACCESS_READY" : "PUBLISH_ACCESS_DENIED", message: allowed ? "发布中心权限已开通" : "当前会员未开通发布中心权限，请联系管理员" };
}
async function requireAccess(user: AuthUser): Promise<void> {
  const access = await memberAccess(user);
  if (!access.allowed) throw new PublishingError(access.code, access.message, access.code === "PUBLISH_ACCESS_DENIED" ? 403 : 503);
}
async function loadConfig(database: Database): Promise<{ row: Row; schemaReady: boolean }> {
  const result = await database.from("pub_config_versions").select("*").order("version", { ascending: false }).limit(1).maybeSingle();
  if (result.error) {
    if (absentCodes.has(result.error.code)) return { row: {}, schemaReady: false };
    databaseFailure(result.error);
  }
  return { row: record(result.data), schemaReady: !!result.data };
}
function publicConfig(row: Row, effective = true): PublishingPublicConfig {
  const links = record(row.operator_links);
  const runtime = !effective || publishingRuntimeEnabled();
  return {
    ...PUBLISHING_DEFAULT_PUBLIC_CONFIG,
    version: num(row.version), executionEnabled: row.execution_enabled === true && runtime,
    salesEnabled: row.sales_enabled === true && (!effective || row.execution_enabled === true && runtime),
    enabledPlatforms: Array.isArray(row.enabled_platforms) ? row.enabled_platforms as PublishingCommercialPlatform[] : PUBLISHING_DEFAULT_PUBLIC_CONFIG.enabledPlatforms,
    pluginUrl: nullable(links.pluginUrl) || PUBLISHING_DEFAULT_PUBLIC_CONFIG.pluginUrl,
    announcement: typeof row.announcement === "string" ? row.announcement : PUBLISHING_DEFAULT_PUBLIC_CONFIG.announcement,
    usageNotice: PUBLISHING_USAGE_NOTICE,
  };
}
function planDto(row: Row) { return PublishingPlanSchema.parse({ id: row.id, version: num(row.version), name: row.name, description: row.description, priceCents: num(row.price_cents), quota: num(row.quota), validDays: num(row.valid_days), platforms: row.platforms, enabled: row.enabled === true, createdAt: row.created_at }); }
function purchaseDto(row: Row) { return PublishingPurchaseSchema.parse({ id: row.id, planId: row.plan_id, planVersion: num(row.plan_version), planName: row.plan_name, priceCents: num(row.price_cents), createdAt: row.created_at }); }
function entitlementDto(row: Row) { return PublishingEntitlementSchema.parse({ id: row.id, purchaseId: row.purchase_id??null, grantId: row.grant_id??null, source: row.grant_id?'membership':'purchase', planId: row.plan_id, planVersion: num(row.plan_version), planName: row.plan_name, quota: num(row.quota), used: num(row.used), expiresAt: row.expires_at, platforms: row.platforms }); }
async function purchaseReceipt(database: Database, user: AuthUser, key: string) {
  const purchase = await database.from("pub_purchases").select("*").eq("user_id", user.id).eq("idempotency_key", key).maybeSingle();
  if (purchase.error) databaseFailure(purchase.error);
  if (!purchase.data) return null;
  const row = record(purchase.data);
  if (row.user_id !== user.id || row.idempotency_key !== key) throw new PublishingError("PUBLISH_PURCHASE_RECONCILIATION_REQUIRED", "原订单归属暂不可确认，请保留订单标识并联系管理员", 503, true);
  const entitlement = await database.from("pub_entitlements").select("*").eq("user_id", user.id).eq("purchase_id", str(row.id)).maybeSingle();
  if (entitlement.error) databaseFailure(entitlement.error);
  const owned = record(entitlement.data);
  if (!entitlement.data || owned.user_id !== user.id || owned.purchase_id !== row.id || owned.plan_id !== row.plan_id || num(owned.plan_version) !== num(row.plan_version)) throw new PublishingError("PUBLISH_PURCHASE_RECONCILIATION_REQUIRED", "原订单已存在，执行额度仍待核对，请勿另建订单", 503, true);
  return { purchase: row, entitlement: owned };
}
/** Observes an existing owner order even if its plan or sales gate changed.
 * An absent row is not permission to create another purchase. */
export async function recoverPublishingPurchase(user: AuthUser, database: Database, purchaseKey: string, options: { assertAccess?: typeof requireAccess } = {}): Promise<PublishingPurchaseRecovery> {
  await (options.assertAccess ?? requireAccess)(user);
  if (!PublishingSubmissionKeySchema.safeParse(purchaseKey).success) throw new PublishingError("PUBLISH_INPUT_INVALID", "订单标识无效", 400);
  const result = await purchaseReceipt(database, user, purchaseKey);
  return PublishingPurchaseRecoverySchema.parse({ schemaReady: true, purchaseKey, found: !!result, shouldPurchase: false, purchase: result ? purchaseDto(result.purchase) : null, entitlement: result ? entitlementDto(result.entitlement) : null });
}
function accountDto(row: Row) { return PublishingAccountSchema.parse({ id: row.id, platform: row.platform, platformAccountId: row.platform_account_id, displayName: row.display_name, ...(row.avatar ? { avatar: row.avatar } : {}), source: "browser_reported", updatedAt: row.updated_at }); }
function draftDto(row: Row) { return PublishingDraftSchema.parse({ ...record(row.payload), id: row.id, revision: num(row.revision), createdAt: row.created_at, updatedAt: row.updated_at }); }
function taskDto(row: Row) {
  const receipt = record(row.receipt);
  return PublishingTaskSchema.parse({ id: row.id, draftId: row.draft_id, draftRevision: num(row.draft_revision), accountId: row.account_id, platform: row.platform,
    status: row.status, reportedSuccess: typeof receipt.success === "boolean" ? receipt.success : null, workId: nullable(receipt.workId), shareLink: nullable(receipt.shareLink),
    receiptSource: row.receipt_source === "browser_reported" ? "browser_reported" : null, createdAt: row.created_at, updatedAt: row.updated_at });
}
async function loadPlans(database: Database) {
  const result = await database.from("pub_plan_versions").select("*").order("version", { ascending: false }).limit(1000);
  if (result.error) databaseFailure(result.error);
  const newest = new Map<string, Row>();
  for (const row of rows(result.data)) if (!newest.has(str(row.id))) newest.set(str(row.id), row);
  return [...newest.values()].map(planDto);
}

/** Narrow entry projection: do not add unrelated history or draft queries here. */
export async function readPublishingBootstrap(user: AuthUser, database: Database): Promise<Pick<PublishingCenter, 'config' | 'entitlements' | 'schemaReady' | 'access'>> {
  const [access, loaded] = await Promise.all([memberAccess(user), loadConfig(database)]);
  const base = { config: publicConfig(loaded.row), entitlements: [] as PublishingCenter['entitlements'], schemaReady: loaded.schemaReady, access };
  if (!loaded.schemaReady || !access.allowed) return base;
  const entitlements = await database.from('pub_entitlements').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(200);
  if (entitlements.error) databaseFailure(entitlements.error);
  return { ...base, entitlements: rows(entitlements.data).map(entitlementDto) };
}

export async function readPublishingCenter(user: AuthUser, database: Database): Promise<PublishingCenter> {
  const [access, loaded] = await Promise.all([memberAccess(user), loadConfig(database)]);
  const base = { config: publicConfig(loaded.row), plans: [], entitlements: [], purchases: [], accounts: [], drafts: [], tasks: [], walletCash: num(user.cashBalance), schemaReady: loaded.schemaReady, access };
  if (!loaded.schemaReady || !access.allowed) return PublishingCenterSchema.parse(base);
  const [plans, entitlements, purchases, accounts, drafts, tasks] = await Promise.all([
    loadPlans(database), database.from("pub_entitlements").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200),
    database.from("pub_purchases").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200),
    database.from("pub_accounts").select("*").eq("user_id", user.id).order("updated_at", { ascending: false }).limit(100),
    database.from("pub_drafts").select("*").eq("user_id", user.id).eq("is_deleted", false).order("updated_at", { ascending: false }).limit(100),
    database.from("pub_tasks").select("id,draft_id,draft_revision,account_id,platform,status,receipt,receipt_source,created_at,updated_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
  ]);
  for (const result of [entitlements, purchases, accounts, drafts, tasks]) if (result.error) databaseFailure(result.error);
  return PublishingCenterSchema.parse({ ...base, plans: plans.filter((plan) => plan.enabled && plan.platforms.every((platform) => base.config.enabledPlatforms.includes(platform))), entitlements: rows(entitlements.data).map(entitlementDto), purchases: rows(purchases.data).map(purchaseDto), accounts: rows(accounts.data).map(accountDto), drafts: rows(drafts.data).map(draftDto), tasks: rows(tasks.data).map(taskDto) });
}

export async function mutatePublishingCenter(user: AuthUser, database: Database, action: PublishingAction, options: { assertAccess?: typeof requireAccess; runtimeEnabled?: () => boolean } = {}): Promise<PublishingMutationResponse> {
  await (options.assertAccess ?? requireAccess)(user);
  const owner = { p_user_id: user.id };
  switch (action.action) {
    case "save-draft": {
      const row = await rpc(database, "save_publish_draft_atomic", { ...owner, p_id: action.id ?? null, p_expected_revision: action.expectedRevision, p_payload: action.draft, p_delete: false });
      return PublishingMutationResponseSchema.parse({ ok: true, draft: draftDto(row) });
    }
    case "delete-draft": {
      await rpc(database, "save_publish_draft_atomic", { ...owner, p_id: action.id, p_expected_revision: action.expectedRevision, p_payload: {}, p_delete: true });
      return { ok: true, deleted: true };
    }
    case "save-account": {
      const input = action.account;
      const row = await rpc(database, "save_publish_account_atomic", { ...owner, p_platform: input.platform, p_platform_account_id: input.platformAccountId, p_display_name: input.displayName, p_avatar: input.avatar ?? null });
      return { ok: true, account: accountDto(row) };
    }
    case "purchase": {
      const prior = await purchaseReceipt(database, user, action.idempotencyKey);
      if (prior) {
        if (prior.purchase.plan_id !== action.planId || num(prior.purchase.plan_version) !== action.planVersion || prior.purchase.payload_fingerprint !== fingerprint(["purchase", action.planId, action.planVersion])) throw new PublishingError("PUBLISH_IDEMPOTENCY_CONFLICT", "该订单标识已用于其他购买内容，请核对原订单", 409);
        return { ok: true, purchase: purchaseDto(prior.purchase), entitlement: entitlementDto(prior.entitlement), alreadyFulfilled: true };
      }
      if (!(options.runtimeEnabled ?? publishingRuntimeEnabled)()) throw new PublishingError("PUBLISH_SALES_DISABLED", "发布套餐暂未开放购买", 409);
      const result = await rpc(database, "purchase_publish_package_atomic", { ...owner, p_plan_id: action.planId, p_plan_version: action.planVersion, p_idempotency_key: action.idempotencyKey, p_payload_fingerprint: fingerprint(["purchase", action.planId, action.planVersion]) });
      return { ok: true, purchase: purchaseDto(record(result.purchase)), entitlement: entitlementDto(record(result.entitlement)), alreadyFulfilled: result.alreadyFulfilled === true };
    }
    case "claim": {
      // No network call is made in this module, even when both gates are on.
      if (!publishingRuntimeEnabled()) throw new PublishingError("PUBLISH_EXECUTION_DISABLED", "发布服务尚未开放，请先保存草稿", 409);
      const result = await rpc(database, "claim_publish_execution_atomic", { ...owner, p_draft_id: action.draftId, p_draft_revision: action.draftRevision, p_account_id: action.accountId, p_entitlement_id: action.entitlementId, p_idempotency_key: action.idempotencyKey, p_payload_fingerprint: fingerprint(["claim", action.draftId, action.draftRevision, action.accountId, action.entitlementId]) });
      return { ok: true, task: taskDto(record(result.task)), shouldExecute: result.shouldExecute === true, alreadyFulfilled: result.alreadyFulfilled === true };
    }
    case "report": {
      // Read owner-scoped platform before accepting a platform-specific share domain.
      const existing = await database.from("pub_tasks").select("platform").eq("id", action.taskId).eq("user_id", user.id).maybeSingle();
      if (existing.error) databaseFailure(existing.error);
      if (!existing.data) throw new PublishingError("PUBLISH_TASK_NOT_FOUND", "发布记录不存在", 404);
      const platform = str(record(existing.data).platform) as PublishingPlatform;
      if (action.shareLink && !isPublishingShareLink(platform, action.shareLink)) throw new PublishingError("PUBLISH_SHARE_LINK_INVALID", "分享链接与发布平台不一致", 400);
      const receipt = { success: action.success, ...(action.workId ? { workId: action.workId } : {}), ...(action.shareLink ? { shareLink: action.shareLink } : {}) };
      const row = await rpc(database, "report_publish_execution_atomic", { ...owner, p_task_id: action.taskId, p_receipt: receipt });
      return { ok: true, task: taskDto(row) };
    }
  }
}

/** Read-only recovery never grants a second execution, including after a lost claim response. */
export async function recoverPublishingClaim(user: AuthUser, database: Database, submissionKey: string): Promise<PublishingRecovery> {
  await requireAccess(user);
  const loaded = await loadConfig(database);
  if (!loaded.schemaReady) throw new PublishingError("PUBLISH_SCHEMA_NOT_READY", "发布中心尚未完成初始化", 503);
  const result = await database.from("pub_tasks").select("id,draft_id,draft_revision,account_id,platform,status,receipt,receipt_source,created_at,updated_at").eq("user_id", user.id).eq("idempotency_key", submissionKey).maybeSingle();
  if (result.error) databaseFailure(result.error);
  return PublishingRecoverySchema.parse({ schemaReady: true, found: !!result.data, task: result.data ? taskDto(record(result.data)) : null, shouldExecute: false });
}

export async function readPublishingAdmin(database: Database, billingAllowed: boolean): Promise<PublishingAdminState> {
  const loaded = await loadConfig(database);
  const rawConfig = publicConfig(loaded.row, false);
  const base = { config: { ...rawConfig, operatorLinks: Object.keys(record(loaded.row.operator_links)).length ? record(loaded.row.operator_links) : PUBLISHING_DEFAULT_OPERATOR_LINKS,
    runtimeExecutionEnabled: publishingRuntimeEnabled(), procurementNotes: str(loaded.row.procurement_notes), procurementVerifiedAt: nullable(loaded.row.procurement_verified_at) },
    plans: [], stats: null, tasks: [], schemaReady: loaded.schemaReady, sectionAccess: { billing: billingAllowed } };
  if (!loaded.schemaReady) return PublishingAdminStateSchema.parse(base);
  const plans = await loadPlans(database);
  if (!billingAllowed) return PublishingAdminStateSchema.parse({ ...base, plans });
  const [purchases, tasksCount, accounts, taskList, attempts, officialPublish, douyinBindings, oauthBindings, genericTargets] = await Promise.all([
    database.from("pub_purchases").select("id", { head: true, count: "exact" }), database.from("pub_tasks").select("id", { head: true, count: "exact" }),
    database.from("pub_accounts").select("id", { head: true, count: "exact" }),
    database.from("pub_tasks").select("id,draft_id,draft_revision,account_id,platform,status,receipt_source,created_at,updated_at").order("created_at", { ascending: false }).limit(50),
    database.from("pub2_attempts").select("id", { head: true, count: "exact" }),
    database.from("pub3_operations").select("id", { head: true, count: "exact" }).eq("kind", "publish"),
    database.from("pub3_account_bindings").select("id", { head: true, count: "exact" }),
    database.from("pub4_account_bindings").select("id", { head: true, count: "exact" }),
    database.from("pub5_targets").select("id", { head: true, count: "exact" }),
  ]);
  const studioSchemaReady = !genericTargets.error;
  if (genericTargets.error && !absentCodes.has(str(record(genericTargets.error).code))) databaseFailure(genericTargets.error);
  if (studioSchemaReady && (typeof genericTargets.count !== "number" || !Number.isSafeInteger(genericTargets.count) || genericTargets.count < 0)) throw new PublishingError("PUBLISH_NATIVE_STATUS_UNAVAILABLE", "工作台任务统计暂不可确认，请稍后读取", 503);
  for (const result of [purchases, tasksCount, accounts, taskList, attempts, officialPublish, douyinBindings, oauthBindings]) if (result.error) databaseFailure(result.error);
  for (const result of [purchases, tasksCount, accounts, attempts, officialPublish, douyinBindings, oauthBindings]) if (typeof result.count !== "number" || !Number.isSafeInteger(result.count) || result.count < 0) throw new PublishingError("PUBLISH_NATIVE_STATUS_UNAVAILABLE", "任务统计暂不可确认，请稍后读取", 503);
  const sources = { tasksV1: tasksCount.count!, tasksV2: attempts.count!, tasksOfficial: officialPublish.count!, tasksGeneric: studioSchemaReady ? genericTargets.count! : 0, studioSchemaReady, accountsBrowser: accounts.count!, accountsDouyin: douyinBindings.count!, accountsOAuth: oauthBindings.count! };
  const tasks = rows(taskList.data).map((row) => { const task = taskDto(row); const { workId: _workId, shareLink: _shareLink, ...summary } = task; void _workId; void _shareLink; return summary; });
  return PublishingAdminStateSchema.parse({ ...base, plans, stats: { purchases: purchases.count!, tasks: sources.tasksV1 + sources.tasksV2 + sources.tasksOfficial + sources.tasksGeneric, accounts: sources.accountsBrowser + sources.accountsDouyin + sources.accountsOAuth, sources }, tasks });
}
export async function mutatePublishingAdmin(database: Database, actorId: string, action: PublishingAdminAction): Promise<void> {
  if (action.action === "save-config") {
    if (action.config.salesEnabled && (!action.config.executionEnabled || !publishingRuntimeEnabled() || !action.config.operatorLinks.pluginUrl || !action.config.procurementVerifiedAt || !action.config.enabledPlatforms.length)) {
      throw new PublishingError("PUBLISH_SALES_NOT_READY", "启用套餐销售前需完成服务核验、选择平台并由运维开放执行条件", 409);
    }
    await rpc(database, "save_publish_config_atomic", { p_actor_id: actorId, p_expected_version: action.config.expectedVersion, p_config: action.config });
  } else {
    await rpc(database, "save_publish_plan_atomic", { p_actor_id: actorId, p_plan: action.plan });
  }
}
export async function readPublishingJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 512 * 1024) throw new PublishingError("PUBLISH_BODY_TOO_LARGE", "请求内容过大", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PublishingError("PUBLISH_INPUT_INVALID", "请求内容为空", 400);
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new PublishingError("PUBLISH_BODY_TOO_LARGE", "请求内容过大", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof PublishingError) throw error;
    throw new PublishingError("PUBLISH_INPUT_INVALID", "请求须为有效 JSON", 400);
  } finally { reader.releaseLock(); }
}
export function publishingFailure(error: unknown): { body: Row; status: number } {
  if (error instanceof PublishingError) return { body: { error: error.message, code: error.code, ...(error.outcomeUnknown ? { outcome: "unknown", retryable: false } : {}) }, status: error.status };
  // Routes classify request validation before invoking mutations. A ZodError
  // here can instead be an output failure after a committed RPC; never call it
  // an input rejection or let a client erase its unknown-operation marker.
  if (error instanceof z.ZodError) return { body: { error: "操作结果格式暂不可确认，请刷新核对原记录", code: "PUBLISH_SERVICE_UNAVAILABLE", outcome: "unknown", retryable: false }, status: 503 };
  return { body: { error: "发布服务暂不可用，请刷新核对记录", code: "PUBLISH_SERVICE_UNAVAILABLE", outcome: "unknown", retryable: false }, status: 503 };
}
