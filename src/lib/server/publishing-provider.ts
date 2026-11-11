import "server-only";
import { validatePublishingProviderOptions } from '../publishing-option-schema';
import { createHash } from "node:crypto";
import { z } from "zod";
import { isPublishingSafeHttps } from "../publishing-contract";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";

/** AiToEarn channels HTTP adapter, matched against upstream 47e5a6fa.
 * Server credentials and scope are injected; this module grants no route permission.
 * No automatic retries: an unknown POST result requires provider record reconciliation.
 */
export class PublishingProviderError extends Error {
  constructor(readonly code: "PROVIDER_NOT_CONFIGURED" | "PROVIDER_SCOPE_DENIED" | "PROVIDER_INPUT_INVALID" | "PROVIDER_PROTOCOL_ERROR" | "PROVIDER_UNAVAILABLE" | "PROVIDER_OUTCOME_UNKNOWN" | "PROVIDER_ACTION_NOT_GRANTED", message: string) { super(message); }
}
function fail(code: PublishingProviderError["code"]): never { throw new PublishingProviderError(code, {
  PROVIDER_NOT_CONFIGURED: "官方 API 尚未配置",
  PROVIDER_SCOPE_DENIED: "当前账号没有此官方连接记录的访问权限",
  PROVIDER_INPUT_INVALID: "官方接口参数未通过核验",
  PROVIDER_PROTOCOL_ERROR: "官方返回格式暂不可确认",
  PROVIDER_UNAVAILABLE: "官方服务暂不可读取",
  PROVIDER_OUTCOME_UNKNOWN: "官方操作结果未知，请核对原记录，勿重复提交",
  PROVIDER_ACTION_NOT_GRANTED: "当前操作没有对应的一次执行许可",
}[code]); }
const ident = z.string().min(1).max(240).regex(/^[A-Za-z0-9_.:-]+$/).refine(value => value !== "." && value !== "..", "A path identifier cannot be a dot segment");
const https = z.string().max(2048).refine(isPublishingSafeHttps);
/** The same signed-upload destination policy serves both browser and server uploads. */
export function isPublishingProviderUploadUrl(value:string):boolean {
 try {const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password&&(!url.port||url.port==="443")&&/(?:^|\.)(?:aliyuncs\.com|cloudflarestorage\.com|amazonaws\.com|myqcloud\.com|aitoearn\.cn|aitoearn\.ai)$/.test(url.hostname);}catch{return false;}
}
const datetime = z.string().datetime({ offset: true });
const platform = z.string().min(1).max(50).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const plain = z.string().max(2000);
const recordSchema = z.object({
  id: ident, accountId: ident, platform: platform.optional(), accountType: platform.optional(),
  status: z.number().int().optional(), publishTime: z.string().max(80).optional(),
  platformWorkId: z.string().max(240).optional(), workLink: https.optional(),
  linkStatus: z.enum(["pending", "ready", "failed"]).optional(),
  errorData: z.object({ type: z.string().max(100), code: z.string().max(100) }).strip().optional(),
  linkMeta: z.object({ mediaMd5sum: z.string().regex(/^[a-f0-9]{32}$/i).optional(), videoClipTaskId: ident.optional(), scheduledTime: z.number().finite().optional() }).strip().optional(),
}).strip();
const flowSchema = z.object({ flowId: ident, tasks: z.array(recordSchema).max(500) }).strip();
const accountSchema = z.object({ id: ident, type: platform, uid: z.string().max(240).optional(), account: z.string().max(240).optional(), nickname: z.string().max(240).optional(), avatar: https.optional(), status: z.number().int().optional() }).strip();
const authUrl = z.union([https, z.string().max(1024 * 1024).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)]);
const localeText = z.object({ "zh-CN": plain, "en-US": plain }).strip();
const connectedAccount = z.object({ accountId: ident, platform, platformUid: ident, account: z.string().max(240).optional(), displayName: z.string().max(240), avatarUrl: https.optional() }).strip();
const selectableAccount = connectedAccount.omit({ accountId: true }).extend({ parentPlatformUid: ident.optional() }).strip();
const authSchema = z.object({ url: authUrl, sessionId: ident, expiresAt: z.union([datetime, z.number().finite()]), authInstructions: localeText.optional() }).strip();
const authStatusSchema = z.object({ sessionId: ident, status: z.enum(["pending", "completed", "failed"]), requiresSelection: z.boolean(), expiresAt: z.union([datetime, z.number().finite()]).optional(), errorCode: z.number().int().optional(), accountId: ident.optional(), accountIds: z.array(ident).max(500).optional(), accounts: z.array(connectedAccount).max(500).optional(), selectableAccounts: z.array(selectableAccount).max(500).optional() }).strip();
const mediaSchema = z.object({ url: https, options: z.object({ adaptation: z.object({ imageFormat: z.enum(["off", "auto", "jpeg", "png", "webp"]).optional() }).strict().optional() }).strict().optional() }).strict();
const contentSchema = z.object({ title: z.string().max(10000).optional(), body: z.string().max(100000).optional(), media: z.array(mediaSchema).max(100), cover: mediaSchema.optional() }).strict();
const dangerousKey = /cookie|token|secret|password|authorization|credential|api.?key/i;
function safeJson(value: unknown, depth = 0, maximumDepth = 12): boolean {
  if (depth > maximumDepth) return false;
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return true;
  if (typeof value === "string") return value.length <= 10000;
  if (Array.isArray(value)) return value.length <= 1000 && value.every(item => safeJson(item, depth + 1, maximumDepth));
  if (typeof value !== "object" || !value) return false;
  return Object.entries(value).length <= 100 && Object.entries(value).every(([key, item]) => !dangerousKey.test(key) && key !== "__proto__" && key !== "constructor" && safeJson(item, depth + 1, maximumDepth));
}
const jsonObject = z.record(z.string(), z.unknown()).refine(safeJson);
// Current public engagement schemas nest pagination unions more deeply than
// execution option values. Keep the response byte bound and a separate depth cap.
const metadataObject = z.record(z.string(), z.unknown()).refine(value => safeJson(value, 0, 32));
const flowInput = z.object({
  flowId: ident.optional(), publishAt: datetime, content: contentSchema,
  context: z.object({ taskId: ident.optional(), materialGroupId: ident.optional(), materialId: ident.optional(), source: z.enum(["publish", "task_link", "offline_qr", "web", "api", "internal", "mcp"]).optional() }).strict().optional(),
  items: z.array(z.object({ platform, accountId: ident, option: jsonObject.optional(), overrides: contentSchema.partial().extend({ cover: mediaSchema.nullable().optional() }).strict().optional() }).strict()).min(1).max(100),
}).strict();
export type PublishingProviderFlowInput = z.infer<typeof flowInput>;
export { validatePublishingProviderOptions } from '../publishing-option-schema';
export interface PublishingProviderScope {
  ownerId: string;
  accountIds: ReadonlySet<string>;
  flowIds: ReadonlySet<string>;
  recordIds: ReadonlySet<string>;
  taskIds: ReadonlySet<string>;
  authSessionIds: ReadonlySet<string>;
  assetIds?: ReadonlySet<string>;
  /** Server-owned work proofs, keyed by publishingProviderWorkScopeKey. */
  workRefs?: ReadonlySet<string>;
}
export function publishingProviderWorkScopeKey(accountId: string, type: string, workId: string): string {
  return JSON.stringify([accountId, type, workId]);
}
const rangeSchema = z.object({ since: datetime.optional(), until: datetime.optional() }).strict().refine(value => !value.since || !value.until || Date.parse(value.since) <= Date.parse(value.until));
export type PublishingProviderRange = z.infer<typeof rangeSchema>;
const cursor = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/u.test(value));
const paginationSchema = z.union([
  z.object({ page: z.number().int().positive().max(100000), pageSize: z.number().int().positive().max(100) }).strict(),
  z.object({ cursor, limit: z.number().int().positive().max(100).optional(), direction: z.enum(["next", "previous"]).optional() }).strict(),
  z.object({ limit: z.number().int().positive().max(100), direction: z.literal("next").optional() }).strict(),
  z.object({ direction: z.literal("next") }).strict(), z.object({}).strict(),
]);
export type PublishingProviderPagination = z.infer<typeof paginationSchema>;
const paginationResultSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("cursor"), nextCursor: cursor.optional(), previousCursor: cursor.optional(), hasNext: z.boolean(), hasPrevious: z.boolean(), limit: z.number().int().positive().max(1000) }).strip(),
  z.object({ mode: z.literal("page"), page: z.number().int().positive(), pageSize: z.number().int().positive().max(1000), total: z.number().int().nonnegative().optional(), hasNext: z.boolean(), hasPrevious: z.boolean() }).strip(),
  z.object({ mode: z.literal("none") }).strip(),
]);
const profileSchema = z.object({ displayName: z.string().max(500).optional(), username: z.string().max(500).optional(), avatarUrl: https.optional(), accountType: z.string().max(100).optional() }).strip();
const count = z.number().finite().nonnegative();
const accountMetricsSchema = z.object(Object.fromEntries(["fansCount", "followingCount", "workCount", "readCount", "viewCount", "impressionCount", "reachCount", "likeCount", "collectCount", "forwardCount", "commentCount", "clickCount", "engagementCount"].map(name => [name, count.optional()]))).strip();
const workMetricsSchema = z.object(Object.fromEntries(["viewCount", "playCount", "impressionCount", "reachCount", "likeCount", "collectCount", "commentCount", "shareCount", "saveCount", "clickCount", "engagementCount", "watchTimeSeconds"].map(name => [name, count.optional()]))).strip();
const workSchema = z.object({ id: ident, url: https.optional(), title: z.string().max(10000).optional(), description: z.string().max(100000).optional(), mediaType: z.string().max(100).optional(), coverUrl: https.optional(), publishedAt: datetime.optional(), status: z.string().max(100).optional(), author: z.string().max(500).optional() }).strip();
const snapshotTimes = { snapshotAt: datetime, fetchedAt: datetime, periodStartAt: datetime.optional(), periodEndAt: datetime.optional() };
const workSnapshotSchema = z.object({ ...snapshotTimes, platformWorkId: ident.optional(), work: workSchema, metrics: workMetricsSchema.optional() }).strip();
const accountAnalyticsSchema = z.object({ platform, accountId: ident, profile: profileSchema.optional(), metrics: accountMetricsSchema.optional(), snapshots: z.array(z.object({ ...snapshotTimes, platformUid: ident.optional(), profile: profileSchema.optional(), metrics: accountMetricsSchema.optional() }).strip()).max(500).default([]), fetchedAt: datetime.optional(), message: z.string().max(2000).optional() }).strip();
const workListSchema = z.object({ platform, items: z.array(z.object({ platformWorkId: ident, contentMode: z.enum(["article2", "article", "video"]), title: z.string().max(10000).optional(), description: z.string().max(100000).optional(), url: https.optional(), coverUrl: https.optional(), publishedAt: datetime.optional(), authorName: z.string().max(500).optional(), authorPlatformUid: ident.optional(), status: z.string().max(100).optional(), metrics: workMetricsSchema.optional() }).strip()).max(1000), pagination: paginationResultSchema }).strip();
const workDetailSchema = z.object({ platform, work: workSchema.optional(), snapshots: z.array(workSnapshotSchema).max(500).default([]), fetchedAt: datetime.optional(), message: z.string().max(2000).optional() }).strip();
const workAnalyticsSchema = workDetailSchema.extend({ accountId: ident.optional(), platformWorkId: ident, metrics: workMetricsSchema.optional() });
const commentsSchema = z.object({ platform, items: z.array(z.object({ platformCommentId: ident, platformWorkId: ident.optional(), parentCommentId: ident.optional(), authorName: z.string().max(500).optional(), authorPlatformUid: ident.optional(), content: z.string().max(20000), createdAt: datetime.optional(), likeCount: z.number().int().nonnegative().optional(), replyCount: z.number().int().nonnegative().optional() }).strip()).max(1000), pagination: paginationResultSchema }).strip();
function boundedQuery(input: Record<string, unknown>, pagination?: PublishingProviderPagination) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) if (value !== undefined) query.set(name, String(value));
  if (pagination) for (const [name, value] of Object.entries(pagination)) if (value !== undefined) query.set(`pagination[${name}]`, String(value));
  return query.size ? `?${query}` : "";
}
export type PublishingProviderGrant = { kind: "authorization" | "create_flow" | "task_change" | "analytics" | "asset_sign" | "asset_confirm"; ownerId: string; subject: string; operationId: string; payloadHash: string };
export interface PublishingProviderOptions {
  environment: "domestic" | "international";
  apiKey?: string;
  scope: PublishingProviderScope;
  fetch?: typeof fetch;
  consumeGrant?: (grant: PublishingProviderGrant) => Promise<boolean>;
  allowedAuthCallbackOrigins?: ReadonlySet<string>;
}
export function publishingProviderStatus() {
  const configuration = readPublishingProviderConfiguration();
  return { configured: configuration.configured, environment: configuration.environment, credentialSource: configuration.credentialSource, credentialIssue: configuration.credentialIssue,
    routeExecutionEnabled: configuration.configured && process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED === "true", bindingRequired: true as const };
}
export function publishingProviderPayloadHash(payload: unknown): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}
export function projectProviderStatus(status?: number): "failed" | "waiting" | "published" | "publishing" | "updating" | "update_failed" | "queued" | "platform_scheduled" | "awaiting_user_action" | "cancelled" | "unknown" {
  return ({ [-1]: "failed", 0: "waiting", 1: "published", 2: "publishing", 3: "updating", 4: "updating", 5: "update_failed", 6: "queued", 7: "platform_scheduled", 8: "awaiting_user_action", 9: "cancelled" } as const)[status as 0] ?? "unknown";
}
function validated<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); return parsed.success ? parsed.data : fail("PROVIDER_INPUT_INVALID"); }

export class PublishingProvider {
  private readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly consumed = new Set<string>();
  private readonly sessionCookies = new Map<string, string>();
  constructor(private readonly options: PublishingProviderOptions) {
    this.origin = options.environment === "international" ? "https://aitoearn.ai" : "https://aitoearn.cn";
    this.fetcher = options.fetch ?? fetch;
  }
  private requireScope(kind: "accountIds" | "flowIds" | "recordIds" | "taskIds" | "authSessionIds", value: string) {
    validated(ident, value);
    if (!this.options.scope.ownerId || !this.options.scope[kind].has(value)) fail("PROVIDER_SCOPE_DENIED");
  }
  private async grant(input: Pick<PublishingProviderGrant, "kind" | "subject" | "operationId">, payload: unknown) {
    const grant = { ...input, ownerId: this.options.scope.ownerId, payloadHash: publishingProviderPayloadHash(payload) };
    if (!this.options.apiKey?.trim()) fail("PROVIDER_NOT_CONFIGURED");
    if (!grant.ownerId || !ident.safeParse(grant.operationId).success || this.consumed.has(grant.operationId) || !this.options.consumeGrant) fail("PROVIDER_ACTION_NOT_GRANTED");
    this.consumed.add(grant.operationId);
    if (!await this.options.consumeGrant(grant)) fail("PROVIDER_ACTION_NOT_GRANTED");
  }
  private async request<T>(path: string, schema: z.ZodType<T>, options: { method?: string; body?: unknown; mutation?: boolean; cookie?: string; rememberCookie?: (value: string) => void; assets?: boolean; discardHtml?: boolean } = {}): Promise<T> {
    if (!this.options.apiKey?.trim()) fail("PROVIDER_NOT_CONFIGURED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.fetcher(`${this.origin}${options.assets ? "/api/assets" : "/api/v2/channels"}${path}`, {
        method: options.method ?? "GET", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { "X-Api-Key": this.options.apiKey!, ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(options.cookie ? { Cookie: options.cookie } : {}) },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
      if (!response.ok) fail(options.mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE");
      if (Number(response.headers.get("content-length") || 0) > 2 * 1024 * 1024) fail("PROVIDER_PROTOCOL_ERROR");
      const reader = response.body?.getReader(); if (!reader) fail("PROVIDER_PROTOCOL_ERROR");
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); fail("PROVIDER_PROTOCOL_ERROR"); } chunks.push(value); } }
      finally { reader.releaseLock(); }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (options.discardHtml) return validated(schema, {});
      let value: unknown; try { value = JSON.parse(raw); } catch { fail(options.mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_PROTOCOL_ERROR"); }
      const parsed = z.object({ code: z.literal(0), data: schema }).strip().safeParse(value);
      if (!parsed.success) fail(options.mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_PROTOCOL_ERROR");
      const cookies = response.headers.getSetCookie();
      const sessionCookie = cookies.map(cookie => cookie.split(";", 1)[0]).find(cookie => cookie.startsWith("_cas="));
      if (sessionCookie && options.rememberCookie) options.rememberCookie(sessionCookie);
      return parsed.data.data;
    } catch (error) {
      if (error instanceof PublishingProviderError) {
        if (options.mutation) return fail("PROVIDER_OUTCOME_UNKNOWN");
        throw error;
      }
      return fail(options.mutation ? "PROVIDER_OUTCOME_UNKNOWN" : "PROVIDER_UNAVAILABLE");
    } finally { clearTimeout(timer); }
  }
  async readCapabilities() {
    // Strip operational extra fields. Dynamic schemas remain server-only validation input.
    const metadata = z.object({ platform, displayName: localeText, logoUrl: https.optional(), status: z.string().or(z.number()), authType: z.string(), authInstructions: localeText.optional(), editor: z.string().optional(), contentLimits: metadataObject.optional(), mediaRules: metadataObject.optional(), topic: metadataObject.optional(), optionSchema: metadataObject, defaultOption: metadataObject.optional(), capabilities: metadataObject }).strip();
    return this.request("/platforms", z.array(metadata).max(100));
  }
  async readPublishOptions(type: string) {
    validated(platform, type);
    return this.request(`/platforms/${encodeURIComponent(type)}/publish-options`, z.array(z.object({ field: ident, label: z.string().max(500), valueType: z.string().max(100), requiresAccount: z.boolean(), filterSchema: jsonObject.optional(), createSchema: jsonObject.optional() }).strip()).max(100));
  }
  async readPublishOptionValues(accountId: string, field: string, filter: Record<string, string | number | boolean> = {}) {
    this.requireScope("accountIds", accountId); validated(ident, field);
    const account = await this.readAccount(accountId);
    const sources = await this.readPublishOptions(account.type);
    const descriptor = sources.find(item => item.field === field);
    if (!descriptor || !safeJson(filter) || descriptor.filterSchema && !validatePublishingProviderOptions(descriptor.filterSchema, filter) || !descriptor.filterSchema && Object.keys(filter).length) fail("PROVIDER_INPUT_INVALID");
    interface ValueItem { value: string; label: string; disabled?: boolean; children?: ValueItem[] }
    const itemSchema: z.ZodType<ValueItem> = z.lazy(() => z.object({ value: z.string().max(500), label: z.string().max(1000), disabled: z.boolean().optional(), children: z.array(itemSchema).max(1000).optional() }).strip());
    const query = new URLSearchParams(Object.entries(filter).map(([key, value]) => [key, String(value)]));
    const result = await this.request(`/accounts/${encodeURIComponent(accountId)}/publish-options/${encodeURIComponent(field)}/values${query.size ? `?${query}` : ""}`, z.object({ field: ident, valueType: z.string().max(100), items: z.array(itemSchema).max(1000) }).strip());
    if (result.field !== field) fail("PROVIDER_PROTOCOL_ERROR");
    return result;
  }
  async startAuthorization(type: string, correlationId: string, operationId: string, callbackUrl?: string) {
    validated(platform, type); validated(ident, correlationId);
    if (callbackUrl) {
      validated(https, callbackUrl);
      if (!this.options.allowedAuthCallbackOrigins?.has(new URL(callbackUrl).origin)) fail("PROVIDER_INPUT_INVALID");
    }
    await this.grant({ kind: "authorization", subject: correlationId, operationId }, { type, correlationId, callbackUrl: callbackUrl ?? null });
    let cookie = "";
    const data = await this.request(`/accounts/auth/${encodeURIComponent(type)}${callbackUrl ? `?${new URLSearchParams({ callbackUrl })}` : ""}`, authSchema, { mutation: true, rememberCookie: value => { cookie = value; } });
    if (cookie) this.sessionCookies.set(data.sessionId, cookie);
    return data;
  }
  async readAuthorizationStatus(type: string, sessionId: string) {
    validated(platform, type); this.requireScope("authSessionIds", sessionId);
    const data = await this.request(`/accounts/auth/${encodeURIComponent(type)}/status/${encodeURIComponent(sessionId)}`, authStatusSchema, { cookie: this.sessionCookies.get(sessionId) });
    if (data.sessionId !== sessionId) fail("PROVIDER_PROTOCOL_ERROR");
    return data;
  }
  /** Only the owning route may seal this continuation into its HttpOnly cookie. */
  takeAuthorizationCookie(sessionId: string): string | undefined { const cookie = this.sessionCookies.get(sessionId); this.sessionCookies.delete(sessionId); return cookie; }
  restoreAuthorizationCookie(sessionId: string, cookie: string): void {
    this.requireScope("authSessionIds", sessionId);
    if (!/^_cas=[^;\r\n]{1,8192}$/.test(cookie)) fail("PROVIDER_INPUT_INVALID");
    this.sessionCookies.set(sessionId, cookie);
  }
  async selectAuthorizationAccounts(sessionId: string, accounts: { platformUid: string; account?: string }[], operationId: string) {
    this.requireScope("authSessionIds", sessionId);
    const cookie = this.sessionCookies.get(sessionId); if (!cookie) fail("PROVIDER_ACTION_NOT_GRANTED");
    const body = validated(z.object({ accounts: z.array(z.object({ platformUid: ident, account: z.string().max(240).optional() }).strict()).min(1).max(100) }).strict(), { accounts });
    await this.grant({ kind: "authorization", subject: `${sessionId}:selection`, operationId }, body);
    await this.request("/accounts/auth/selections", z.object({}).strict(), { method: "POST", body, cookie, mutation: true, discardHtml: true });
  }
  async startAssetUpload(input: { filename: string; size: number }, operationId: string) {
    const body = validated(z.object({ filename: z.string().min(1).max(255).regex(/^[^\\/\r\n\u0000]+\.(?:mp4|jpe?g|png|webp|bmp)$/i), size: z.number().int().positive().max(1024 ** 3), type: z.literal("publishMedia") }).strict(), { ...input, type: "publishMedia" });
    await this.grant({ kind: "asset_sign", subject: operationId, operationId }, body);
    const uploadUrl = z.string().max(16384).refine(isPublishingProviderUploadUrl);
    return this.request("/uploadSign", z.object({ id: ident, uploadUrl, url: https }).strip(), { method: "POST", body, mutation: true, assets: true });
  }
  async confirmAssetUpload(assetId: string, operationId: string) {
    validated(ident, assetId);
    if (!this.options.scope.assetIds?.has(assetId)) fail("PROVIDER_SCOPE_DENIED");
    await this.grant({ kind: "asset_confirm", subject: assetId, operationId }, { assetId });
    const result = await this.request(`/${encodeURIComponent(assetId)}/confirm`, z.object({ id: ident, url: https, status: z.literal("confirmed"), size: z.number().int().positive().max(1024 ** 3), mimeType: z.string().max(120), metadata: z.object({ width: z.number().positive().optional(), height: z.number().positive().optional(), duration: z.number().positive().optional() }).strip().optional() }).strip(), { method: "POST", mutation: true, assets: true });
    if (result.id !== assetId) fail("PROVIDER_OUTCOME_UNKNOWN"); return result;
  }
  async listAccounts() {
    const owned = [...this.options.scope.accountIds];
    if (!owned.length) return { total: 0, list: [] };
    const query = new URLSearchParams(); owned.forEach(value => { validated(ident, value); query.append("ids[]", value); });
    const data = await this.request(`/accounts?${query}`, z.object({ total: z.number().int().nonnegative(), list: z.array(accountSchema).max(1000) }).strip());
    const list = data.list.filter(item => this.options.scope.accountIds.has(item.id));
    return { total: list.length, list }; // Never leak supplier tenant totals.
  }
  async readAccount(accountId: string) { this.requireScope("accountIds", accountId); const account = await this.request(`/accounts/${encodeURIComponent(accountId)}`, accountSchema); if (account.id !== accountId) fail("PROVIDER_PROTOCOL_ERROR"); return account; }
  private requireWork(type: string, accountId: string, workId: string) {
    this.requireScope("accountIds", accountId); validated(platform, type); validated(ident, workId);
    if (!this.options.scope.workRefs?.has(publishingProviderWorkScopeKey(accountId, type, workId))) fail("PROVIDER_SCOPE_DENIED");
  }
  async readAccountAnalytics(accountId: string, range: PublishingProviderRange = {}) {
    this.requireScope("accountIds", accountId); const checked = validated(rangeSchema, range);
    const result = await this.request(`/accounts/${encodeURIComponent(accountId)}/analytics${boundedQuery(checked)}`, accountAnalyticsSchema);
    if (result.accountId !== accountId) fail("PROVIDER_SCOPE_DENIED");
    return result;
  }
  async readAccountWorks(type: string, accountId: string, pagination: PublishingProviderPagination = {}) {
    this.requireScope("accountIds", accountId); validated(platform, type); const checked = validated(paginationSchema, pagination);
    const result = await this.request(`/works/${encodeURIComponent(type)}${boundedQuery({ accountId }, checked)}`, workListSchema);
    if (result.platform !== type || new Set(result.items.map(item => item.platformWorkId)).size !== result.items.length) fail("PROVIDER_PROTOCOL_ERROR");
    return result;
  }
  async readWorkDetail(type: string, accountId: string, workId: string) {
    this.requireWork(type, accountId, workId);
    const result = await this.request(`/works/${encodeURIComponent(type)}/${encodeURIComponent(workId)}${boundedQuery({ accountId })}`, workDetailSchema);
    if (result.platform !== type || result.work && result.work.id !== workId || result.snapshots.some(snapshot => snapshot.work.id !== workId || snapshot.platformWorkId && snapshot.platformWorkId !== workId)) fail("PROVIDER_SCOPE_DENIED");
    return result;
  }
  async readWorkAnalytics(type: string, accountId: string, workId: string, range: PublishingProviderRange = {}) {
    this.requireWork(type, accountId, workId); const checked = validated(rangeSchema, range);
    const result = await this.request(`/works/${encodeURIComponent(type)}/${encodeURIComponent(workId)}/analytics${boundedQuery({ accountId, ...checked })}`, workAnalyticsSchema);
    if (result.platform !== type || result.platformWorkId !== workId || result.accountId && result.accountId !== accountId || result.work && result.work.id !== workId || result.snapshots.some(snapshot => snapshot.work.id !== workId || snapshot.platformWorkId && snapshot.platformWorkId !== workId)) fail("PROVIDER_SCOPE_DENIED");
    return result;
  }
  async readWorkComments(type: string, accountId: string, workId: string, pagination: PublishingProviderPagination = {}) {
    this.requireWork(type, accountId, workId); const checked = validated(paginationSchema, pagination);
    const result = await this.request(`/engagement/comments${boundedQuery({ platform: type, platformWorkId: workId, accountId }, checked)}`, commentsSchema);
    if (result.platform !== type || result.items.some(item => item.platformWorkId && item.platformWorkId !== workId)) fail("PROVIDER_SCOPE_DENIED");
    return result;
  }
  async createPublishFlow(input: PublishingProviderFlowInput, operationId: string) {
    const body = validated(flowInput, input);
    body.items.forEach(item => this.requireScope("accountIds", item.accountId));
    const metadata = await this.readCapabilities();
    for (const item of body.items) {
      const capability = metadata.find(entry => entry.platform === item.platform);
      const publish = capability?.capabilities.publish as Record<string, unknown> | undefined;
      if (!capability || publish?.supported !== true || !validatePublishingProviderOptions(capability.optionSchema, item.option ?? {})) fail("PROVIDER_INPUT_INVALID");
    }
    await this.grant({ kind: "create_flow", subject: body.flowId ?? operationId, operationId }, body);
    const flow = await this.request("/publish/flows", flowSchema, { method: "POST", body, mutation: true });
    if (body.flowId && flow.flowId !== body.flowId) fail("PROVIDER_OUTCOME_UNKNOWN");
    if (flow.tasks.length !== body.items.length || body.items.some(item => flow.tasks.filter(task => task.accountId === item.accountId && (!task.platform || task.platform === item.platform)).length !== 1)) fail("PROVIDER_OUTCOME_UNKNOWN");
    return flow;
  }
  async readPublishFlow(flowId: string) {
    this.requireScope("flowIds", flowId);
    const flow = await this.request(`/publish/flows/${encodeURIComponent(flowId)}`, flowSchema);
    if (flow.flowId !== flowId || flow.tasks.some(task => !this.options.scope.accountIds.has(task.accountId))) fail("PROVIDER_SCOPE_DENIED");
    return flow;
  }
  async readPublishRecord(recordId: string) {
    this.requireScope("recordIds", recordId);
    const result = await this.request(`/publish/records/${encodeURIComponent(recordId)}`, recordSchema);
    if (result.id !== recordId || !this.options.scope.accountIds.has(result.accountId)) fail("PROVIDER_SCOPE_DENIED");
    return result;
  }
  async readUserAction(recordId: string) {
    await this.readPublishRecord(recordId);
    const action = await this.request(`/publish/records/${encodeURIComponent(recordId)}/user-action`, z.object({ recordId: ident, platform: z.literal("douyin"), shareId: ident, schemeUrl: z.string().max(4096).refine(url => /^snssdk1128:\/\//.test(url) || isPublishingSafeHttps(url)), shortLink: https, expiresAt: z.string().max(80).optional() }).strip());
    if (action.recordId !== recordId) fail("PROVIDER_PROTOCOL_ERROR");
    return action;
  }
  async changeTask(taskId: string, action: "publish-now" | "retry" | "cancel" | "reschedule", operationId: string, publishAt?: string) {
    this.requireScope("taskIds", taskId);
    if (action === "reschedule") validated(datetime, publishAt);
    await this.grant({ kind: "task_change", subject: `${taskId}:${action}`, operationId }, { taskId, action, publishAt: publishAt ?? null });
    const path = `/publish/tasks/${encodeURIComponent(taskId)}` + (action === "cancel" ? "" : `/${action === "reschedule" ? "publish-at" : action}`);
    const data = await this.request(path, z.object({ taskId: ident }).strip(), { method: action === "cancel" ? "DELETE" : action === "reschedule" ? "PATCH" : "POST", ...(action === "reschedule" ? { body: { publishAt } } : {}), mutation: true });
    if (data.taskId !== taskId) fail("PROVIDER_OUTCOME_UNKNOWN");
    return data;
  }
}
