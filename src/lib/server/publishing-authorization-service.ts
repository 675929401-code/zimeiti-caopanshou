import "server-only";
import { randomUUID } from "node:crypto";
import type { AuthUser, getSupabase } from "../api-middleware";
import { PublishingAuthorizationActionSchema, PublishingAuthorizationBindingSchema, PublishingAuthorizationMutationSchema, PublishingAuthorizationOperationSchema, PublishingAuthorizationPageSchema, PublishingAuthorizationQuerySchema, PublishingAuthorizationSessionSchema, type PublishingAuthorizationAction, type PublishingAuthorizationPlatform, type PublishingAuthorizationQuery } from "../publishing-authorization-contract";
import { PublishingError } from "./publishing-service";
import { readMemberPermissionSnapshot } from "./member-permission-authority";
import { readPublishingProviderConfiguration } from "./publishing-provider-config";
import { publishingProviderPayloadHash } from "./publishing-provider";
import { openPublishingAuthContinuation, publishingAuthCookieName, sealPublishingAuthContinuation } from "./publishing-auth-continuation";
import { PublishingAuthorizationProvider, PublishingAuthorizationProviderError, type AuthorizationGrant, type PublishingAuthorizationProviderClient, type PublishingAuthorizationProviderOptions } from "./publishing-authorization-provider";

type DB = ReturnType<typeof getSupabase>;
type Row = Record<string, unknown>;
type Configuration = ReturnType<typeof readPublishingProviderConfiguration>;
type CookieReader = { get(name: string): string | undefined };
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const list = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => typeof value === "string" ? value : "";
export class PublishingAuthorizationError extends PublishingError {
  constructor(code: string, message: string, status = 400, readonly operationId?: string, unknown = false) { super(code, message, status, unknown); }
}
export interface PublishingAuthorizationDependencies {
  configuration(): Configuration;
  access(user: AuthUser): Promise<void>;
  provider(options: PublishingAuthorizationProviderOptions): PublishingAuthorizationProviderClient;
  randomId(): string;
  now(): number;
}
const defaults: PublishingAuthorizationDependencies = {
  configuration: readPublishingProviderConfiguration,
  async access(user) { const p = await readMemberPermissionSnapshot(user.id, { knownRole: user.role }); if (p.authorityStatus !== "ready" || !p.integrityValid || p.checksum === "legacy-schema-absent") throw new PublishingAuthorizationError("PUBLISH_PERMISSION_UNAVAILABLE", "会员权限暂不可确认", 503); if (!p.featureNavigationKeys.includes("publish_center")) throw new PublishingAuthorizationError("PUBLISH_ACCESS_DENIED", "当前会员未开通发布中心", 403); },
  provider: options => new PublishingAuthorizationProvider(options), randomId: randomUUID, now: Date.now,
};
const failures: Record<string, [number, string]> = {
  PUBLISH_AUTH_SELECTION_ALREADY_SUBMITTED: [409, "本会话已经提交过账号选择，请读取原会话核对"],
  PUBLISH_AUTH_INPUT_INVALID: [400, "授权参数不符合合同"], PUBLISH_AUTH_IDEMPOTENCY_CONFLICT: [409, "请求标识已用于不同内容，请核对原操作"], PUBLISH_AUTH_REVISION_CONFLICT: [409, "连接或授权会话已有新版本，请刷新"], PUBLISH_AUTH_GROUP_CHANGED: [409, "目标分组已变化，请重新选择"], PUBLISH_AUTH_RESTART_REQUIRED: [409, "授权会话无法继续，请重新发起授权"], PUBLISH_AUTH_SELECTION_INVALID: [400, "只能选择本次官方授权提供的候选账号"], PUBLISH_AUTH_BINDING_NOT_FOUND: [404, "连接不存在或不属于当前会员"], PUBLISH_AUTH_SESSION_NOT_FOUND: [404, "授权会话不存在或不属于当前会员"], PUBLISH_AUTH_OPERATION_NOT_FOUND: [404, "授权操作不存在或不属于当前会员"], PUBLISH_AUTH_PLATFORM_MISMATCH: [409, "官方账号平台与授权会话不一致"], PUBLISH_AUTH_ACCOUNT_ALREADY_OWNED: [409, "该平台账号已连接其他会员，请核对账号归属"], PUBLISH_AUTH_CONNECTION_CHANGED: [409, "服务连接已变化，原记录仍可核对"], PUBLISH_AUTH_OUTCOME_CONFLICT: [409, "官方回执与已确认事实不一致，请核对原会话"], PUBLISH_AUTH_FRESH_SESSION_REQUIRED: [409, "恢复连接需要在本站断开后重新完成授权"], PUBLISH_ACCESS_DENIED: [403, "当前会员未开通发布中心"], PUBLISH_PERMISSION_UNAVAILABLE: [503, "会员权限暂不可确认"],
};
function databaseFailure(error: unknown): never {
  const value = object(error), message = text(value.message);
  const code = Object.keys(failures).find(k => message.includes(k));
  if (code) throw new PublishingAuthorizationError(code, failures[code][1], failures[code][0]);
  if (["42P01", "PGRST202", "PGRST204", "PGRST205"].includes(text(value.code))) throw new PublishingAuthorizationError("PUBLISH_AUTH_SCHEMA_NOT_READY", "通用授权数据结构尚未初始化", 503);
  throw new PublishingAuthorizationError("PUBLISH_AUTH_SERVICE_UNAVAILABLE", "授权记录暂不可确认，请读取原操作核对", 503, undefined, true);
}
export interface PublishingAuthorizationResult { data: unknown; continuation?: { sessionId: string; value: string; expiresAt: string } }
export function createPublishingAuthorizationService(overrides: Partial<PublishingAuthorizationDependencies> = {}) {
  const deps = { ...defaults, ...overrides };
  async function rpc(db: DB, user: AuthUser, cfg: Configuration, input: Row) { const result = await db.rpc("mutate_publishing_authorization_atomic", { p_user_id: user.id, p_input: { ...input, connectionId: cfg.namespace } } as never); if (result.error) databaseFailure(result.error); return object(result.data); }
  async function owned(db: DB, user: AuthUser, table: string, id: string) { const result = await db.from(table).select("*").eq("owner_id", user.id).eq("id", id).maybeSingle(); if (result.error) databaseFailure(result.error); if (!result.data) throw new PublishingAuthorizationError("PUBLISH_AUTH_RECORD_NOT_FOUND", "记录不存在或不属于当前会员", 404); return object(result.data); }
  function configured(cfg: Configuration) { if (!cfg.configured || !cfg.apiKey) throw new PublishingAuthorizationError("PUBLISH_AUTH_NOT_CONFIGURED", "官方连接尚未配置，请联系管理员", 409); }
  function current(cfg: Configuration, row: Row) { if (row.connection_id !== cfg.namespace) throw new PublishingAuthorizationError("PUBLISH_AUTH_CONNECTION_CHANGED", "服务连接已变化，原授权仅可核对历史", 409); }
  function operationDto(row: Row, cfg: Configuration) { return PublishingAuthorizationOperationSchema.parse({ id: row.id, kind: row.kind, requestKey: row.request_key, sessionId: row.session_id ?? null, bindingId: row.binding_id ?? null, dispatchState: row.dispatch_state, grantUsed: row.grant_used, revision: row.revision, connectionCurrent: row.connection_id === cfg.namespace, errorCode: row.error_code ?? null, createdAt: row.created_at, updatedAt: row.updated_at }); }
  function bindingDto(row: Row, cfg: Configuration) { return PublishingAuthorizationBindingSchema.parse({ id: row.id, platform: row.platform, platformUid: row.platform_uid, ...(row.account ? { account: row.account } : {}), displayName: row.display_name, ...(row.avatar ? { avatar: row.avatar } : {}), status: row.status, revision: row.revision, groupId: row.group_id ?? null, authSessionId: row.auth_session_id, connectionCurrent: row.connection_id === cfg.namespace, capabilities: { connect: true, publish: false, analytics: false, engagement: false }, createdAt: row.created_at, updatedAt: row.updated_at }); }
  function continuation(cfg: Configuration, session: Row, cookies: CookieReader) {
    if (!cfg.apiKey || session.connection_id !== cfg.namespace || !session.provider_session_id || !session.expires_at || Date.parse(text(session.expires_at)) <= deps.now()) return undefined;
    const value = cookies.get(publishingAuthCookieName(text(session.id))); if (!value) return undefined;
    try { return openPublishingAuthContinuation(value, { ownerId: text(session.owner_id), localSessionId: text(session.id), providerSessionId: text(session.provider_session_id), environment: cfg.environment }, cfg.apiKey); } catch { return undefined; }
  }
  function sessionDto(row: Row, cfg: Configuration, cookies: CookieReader, temporaryError?: string) {
    const display = object(row.display), state = ["prepared", "pending", "requires_selection", "unknown"].includes(text(row.state)) && row.expires_at && Date.parse(text(row.expires_at)) <= deps.now() ? "expired" : row.state;
    const usable = row.connection_id === cfg.namespace && ["pending", "requires_selection"].includes(text(state));
    return PublishingAuthorizationSessionSchema.parse({ id: row.id, platform: row.platform, authType: "oauth2", state, revision: row.revision, expiresAt: row.expires_at ?? null, connectionCurrent: row.connection_id === cfg.namespace, continuationReady: usable && Boolean(continuation(cfg, row, cookies)), ...(usable && display.authUrl ? { authUrl: display.authUrl } : {}), ...(display.instructions ? { instructions: display.instructions } : {}), choices: list(row.choices).map(c => ({ id: c.id, displayName: c.displayName, ...(c.avatar ? { avatar: c.avatar } : {}), ...(c.parentDisplayName ? { parentDisplayName: c.parentDisplayName } : {}) })), bindingIds: row.binding_ids ?? [], errorCode: temporaryError ?? row.error_code ?? null, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  function client(user: AuthUser, cfg: Configuration, db: DB, op?: Row, session?: Row, accountIds: string[] = []) {
    configured(cfg);
    return deps.provider({ environment: cfg.environment, apiKey: cfg.apiKey!, ownerId: user.id, sessionIds: new Set(session?.provider_session_id ? [text(session.provider_session_id)] : []), accountIds: new Set(accountIds), consumeGrant: async (grant: AuthorizationGrant) => {
      if (!op || op.owner_id !== user.id || op.connection_id !== cfg.namespace || deps.configuration().namespace !== cfg.namespace || grant.ownerId !== user.id || grant.operationId !== op.id || grant.kind !== op.grant_kind || grant.subject !== op.grant_subject || grant.payloadHash !== op.provider_request_hash) return false;
      const result = await rpc(db, user, cfg, { action: "consume-grant", operationId: op.id, grantKind: grant.kind, grantSubject: grant.subject, providerRequestHash: grant.payloadHash });
      if (result.consumed === true) Object.assign(op, object(result.operation)); return result.consumed === true;
    } });
  }
  async function platformGate(user: AuthUser, cfg: Configuration, db: DB, platform: PublishingAuthorizationPlatform) {
    const caps = await client(user, cfg, db).capabilities(), cap = caps.find(c => c.platform === platform);
    if (!cap || cap.status !== "available" || cap.authType !== "oauth2") throw new PublishingAuthorizationError("PUBLISH_AUTH_PLATFORM_UNAVAILABLE", "该平台目前尚未开放官方授权，目录与历史连接仍会保留", 409);
  }
  async function result(db: DB, user: AuthUser, cfg: Configuration, op: Row, cookies: CookieReader, alreadyFulfilled: boolean) {
    // Local actions replay their immutable original result; later edits never replace it.
    const saved = object(op.result);
    return PublishingAuthorizationMutationSchema.parse({ operation: operationDto(op, cfg), ...(op.session_id ? { session: sessionDto(await owned(db, user, "pub4_auth_sessions", text(op.session_id)), cfg, cookies) } : {}), ...(op.binding_id ? { binding: bindingDto(saved.binding ? object(saved.binding) : await owned(db, user, "pub4_account_bindings", text(op.binding_id)), cfg) } : {}), alreadyFulfilled });
  }
  async function observe(db: DB, user: AuthUser, cfg: Configuration, session: Row) {
    if (session.connection_id !== cfg.namespace || !cfg.apiKey || !session.provider_session_id || ["completed", "failed"].includes(text(session.state)) || !session.expires_at || Date.parse(text(session.expires_at)) <= deps.now()) return session;
    const platform = session.platform as PublishingAuthorizationPlatform;
    const status = await client(user, cfg, db, undefined, session).status(platform, text(session.provider_session_id));
    const oldChoices = list(session.choices);
    const choices = (status.selectableAccounts ?? []).map(c => {
      const original = oldChoices.find(v => v.platformUid === c.platformUid && text(v.account) === (c.account ?? ""));
      return { id: original?.id ?? deps.randomId(), platform, platformUid: c.platformUid, ...(c.account !== undefined ? { account: c.account } : {}), displayName: c.displayName, ...(c.avatarUrl ? { avatar: c.avatarUrl } : {}), ...(original?.parentDisplayName ? { parentDisplayName: original.parentDisplayName } : {}) };
    });
    let accounts: Row[] = [];
    if (status.status === "completed") {
      accounts = (status.accounts ?? []).map(a => ({ providerAccountId: a.accountId, platform: a.platform, platformUid: a.platformUid, ...(a.account !== undefined ? { account: a.account } : {}), displayName: a.displayName, ...(a.avatarUrl ? { avatar: a.avatarUrl } : {}) }));
      if (!accounts.length) {
        const ids = status.accountIds ?? (status.accountId ? [status.accountId] : []);
        if (new Set(ids).size !== ids.length || ids.length > 100) throw new PublishingAuthorizationError("PUBLISH_AUTH_PROVIDER_INVALID", "官方授权账号集合暂不可确认", 503);
        const scoped = client(user, cfg, db, undefined, session, ids);
        for (const id of ids) { const a = await scoped.readAccount(id); if (a.platform !== platform) throw new PublishingAuthorizationError("PUBLISH_AUTH_PLATFORM_MISMATCH", "官方账号平台与授权会话不一致", 409); accounts.push({ providerAccountId: a.id, platform, platformUid: a.platformUid, ...(a.account !== undefined ? { account: a.account } : {}), displayName: a.displayName, ...(a.avatarUrl ? { avatar: a.avatarUrl } : {}) }); }
      }
      if (!accounts.length) throw new PublishingAuthorizationError("PUBLISH_AUTH_PROVIDER_INVALID", "官方完成状态尚未给出可核验的账号，请稍后读取原会话", 503);
    }
    try { return object((await rpc(db, user, cfg, { action: "record-observation", sessionId: session.id, expectedRevision: session.revision, providerSessionId: session.provider_session_id, platform, state: status.status === "completed" ? "completed" : status.status === "failed" ? "failed" : status.requiresSelection ? "requires_selection" : "pending", choices: choices.length ? choices : oldChoices, accounts, ...(status.errorCode !== undefined ? { errorCode: `PROVIDER_${status.errorCode < 0 ? "NEG_" : ""}${Math.abs(status.errorCode)}` } : {}) })).session); }
    catch (error) { if (error instanceof PublishingAuthorizationError && error.code === "PUBLISH_AUTH_REVISION_CONFLICT") return owned(db, user, "pub4_auth_sessions", text(session.id)); throw error; }
  }
  async function unknown(db: DB, user: AuthUser, cfg: Configuration, op: Row, error: unknown): Promise<never> {
    const code = error instanceof PublishingAuthorizationProviderError ? error.code : "AUTH_RESULT_UNCONFIRMED";
    try { await rpc(db, user, cfg, { action: "record-unknown", operationId: op.id, expectedRevision: op.revision, errorCode: code }); } catch { /* Never overwrite a newer completed observation or retry a remote mutation. */ }
    throw new PublishingAuthorizationError("PUBLISH_AUTH_OUTCOME_UNKNOWN", "官方授权操作结果未知，请读取原会话核对，勿重复发起", 503, text(op.id), true);
  }
  return {
    async mutate(user: AuthUser, db: DB, value: PublishingAuthorizationAction, cookies: CookieReader = { get: () => undefined }): Promise<PublishingAuthorizationResult> {
      await deps.access(user);
      const checked = PublishingAuthorizationActionSchema.safeParse(value); if (!checked.success) throw new PublishingAuthorizationError("PUBLISH_AUTH_INPUT_INVALID", "授权参数不符合合同", 400);
      const action = checked.data, cfg = deps.configuration();
      const existing = await db.from("pub4_auth_operations").select("*").eq("owner_id", user.id).eq("request_key", action.requestKey).maybeSingle(); if (existing.error) databaseFailure(existing.error);
      const prior = existing.data ? object(existing.data) : undefined;
      if (prior) {
        if (publishingProviderPayloadHash(prior.request_payload) !== publishingProviderPayloadHash(action)) throw new PublishingAuthorizationError("PUBLISH_AUTH_IDEMPOTENCY_CONFLICT", "请求标识已用于不同内容，请核对原操作", 409, text(prior.id));
        if (prior.dispatch_state !== "ready" || prior.grant_used === true || prior.connection_id !== cfg.namespace || !["start", "select"].includes(text(prior.kind))) return { data: await result(db, user, cfg, prior, cookies, true) };
      }
      if (action.action === "disconnect" || action.action === "move-binding") {
        const prepared = await rpc(db, user, cfg, { action: action.action === "disconnect" ? "disconnect-binding" : "move-binding", operationId: deps.randomId(), request: action });
        return { data: await result(db, user, cfg, object(prepared.operation), cookies, prepared.alreadyFulfilled === true) };
      }
      configured(cfg);
      let session: Row | undefined, cookie: string | undefined, body: Row, sessionId: string;
      if (prior) {
        session = await owned(db, user, "pub4_auth_sessions", text(prior.session_id)); current(cfg, session);
        await platformGate(user, cfg, db, session.platform as PublishingAuthorizationPlatform);
        if (action.action === "select") { cookie = continuation(cfg, session, cookies); if (!cookie) throw new PublishingAuthorizationError("PUBLISH_AUTH_RESTART_REQUIRED", "选择账号所需的授权续传已失效，请重新授权；原会话仍可只读核对", 409); }
        sessionId = text(prior.session_id); body = object(prior.provider_request);
      } else if (action.action === "start") { await platformGate(user, cfg, db, action.platform); sessionId = deps.randomId(); body = { type: action.platform, correlationId: sessionId, callbackUrl: null }; }
      else {
        session = await owned(db, user, "pub4_auth_sessions", action.sessionId); current(cfg, session);
        if (session.revision !== action.expectedRevision) throw new PublishingAuthorizationError("PUBLISH_AUTH_REVISION_CONFLICT", "授权会话已有新版本，请刷新", 409);
        cookie = continuation(cfg, session, cookies); if (!cookie) throw new PublishingAuthorizationError("PUBLISH_AUTH_RESTART_REQUIRED", "选择账号所需的授权续传已失效，请重新授权；原会话仍可只读核对", 409);
        await platformGate(user, cfg, db, session.platform as PublishingAuthorizationPlatform);
        const choices = list(session.choices), accounts = action.choiceIds.map(id => { const c = choices.find(v => v.id === id); if (!c) throw new PublishingAuthorizationError("PUBLISH_AUTH_SELECTION_INVALID", "只能选择本次授权返回的候选账号", 400); return { platformUid: text(c.platformUid), ...(c.account !== undefined ? { account: text(c.account) } : {}) }; });
        sessionId = action.sessionId; body = { accounts };
      }
      const prepared = prior ? { operation: prior } : await rpc(db, user, cfg, { action: action.action === "start" ? "prepare-start" : "prepare-selection", operationId: deps.randomId(), sessionId, request: action, providerRequest: body, providerRequestHash: publishingProviderPayloadHash(body) });
      let op = object(prepared.operation);
      const dispatched = await rpc(db, user, cfg, { action: "dispatch", operationId: op.id }); op = object(dispatched.operation);
      if (dispatched.shouldSend !== true) return { data: await result(db, user, cfg, op, cookies, true) };
      // A concurrent same-key prepare may have returned another request's committed row.
      // The grant, target and HTTP body always come from that immutable stored operation.
      sessionId = text(op.session_id); body = object(op.provider_request);
      session = await owned(db, user, "pub4_auth_sessions", sessionId);
      if (action.action === "select") { cookie = continuation(cfg, session, cookies); if (!cookie) throw new PublishingAuthorizationError("PUBLISH_AUTH_RESTART_REQUIRED", "授权续传已经失效，请重新授权", 409); }
      const provider = client(user, cfg, db, op, session);
      try {
        if (action.action === "start") {
          const started = await provider.start(session.platform as PublishingAuthorizationPlatform, sessionId, text(op.id));
          const raw = provider.takeCookie(started.sessionId);
          const recorded = await rpc(db, user, cfg, { action: "record-start", operationId: op.id, expectedRevision: op.revision, providerSessionId: started.sessionId, expiresAt: started.expiresAt, display: { authUrl: started.url, ...(started.instructions ? { instructions: started.instructions } : {}) } });
          op = object(recorded.operation);
          const sealed = raw ? { sessionId, value: sealPublishingAuthContinuation({ ownerId: user.id, localSessionId: sessionId, providerSessionId: started.sessionId, expiresAt: started.expiresAt, cookie: raw, environment: cfg.environment }, cfg.apiKey!), expiresAt: started.expiresAt } : undefined;
          const responseCookies = sealed ? { get: (name: string) => name === publishingAuthCookieName(sessionId) ? sealed.value : cookies.get(name) } : cookies;
          return { data: await result(db, user, cfg, op, responseCookies, false), ...(sealed ? { continuation: sealed } : {}) };
        }
        await provider.select(text(session!.provider_session_id), object(body).accounts as Array<{ platformUid: string; account?: string }>, text(op.id), cookie!);
        await observe(db, user, cfg, session!);
        return { data: await result(db, user, cfg, await owned(db, user, "pub4_auth_operations", text(op.id)), cookies, false) };
      } catch (error) { return unknown(db, user, cfg, op, error); }
    },
    async read(user: AuthUser, db: DB, value: PublishingAuthorizationQuery, cookies: CookieReader = { get: () => undefined }): Promise<PublishingAuthorizationResult> {
      await deps.access(user); const checked = PublishingAuthorizationQuerySchema.safeParse(value); if (!checked.success) throw new PublishingAuthorizationError("PUBLISH_AUTH_INPUT_INVALID", "查询参数不符合合同", 400);
      const query = checked.data, cfg = deps.configuration();
      if (query.resource === "session") {
        const local = await owned(db, user, "pub4_auth_sessions", query.id);
        try { return { data: sessionDto(await observe(db, user, cfg, local), cfg, cookies) }; } catch (error) { if (error instanceof PublishingAuthorizationError && error.status < 500) throw error; return { data: sessionDto(local, cfg, cookies, "AUTH_PROVIDER_UNAVAILABLE") }; }
      }
      let q = db.from(query.resource === "bindings" ? "pub4_account_bindings" : "pub4_auth_operations").select("*", { count: "exact" }).eq("owner_id", user.id);
      if (query.resource === "bindings" && query.platform) q = q.eq("platform", query.platform);
      if (query.resource === "operations") { if (query.id) q = q.eq("id", query.id); if (query.requestKey) q = q.eq("request_key", query.requestKey); }
      const result = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).range((query.page - 1) * query.pageSize, query.page * query.pageSize - 1); if (result.error) databaseFailure(result.error);
      return { data: query.resource === "bindings" ? PublishingAuthorizationPageSchema(PublishingAuthorizationBindingSchema).parse({ items: list(result.data).map(r => bindingDto(r, cfg)), total: result.count ?? 0, page: query.page, pageSize: query.pageSize }) : PublishingAuthorizationPageSchema(PublishingAuthorizationOperationSchema).parse({ items: list(result.data).map(r => operationDto(r, cfg)), total: result.count ?? 0, page: query.page, pageSize: query.pageSize }) };
    },
  };
}
const runtimeService = createPublishingAuthorizationService();
export const mutatePublishingAuthorization = runtimeService.mutate;
export const readPublishingAuthorization = runtimeService.read;
