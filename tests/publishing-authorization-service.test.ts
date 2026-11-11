import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPublishingAuthorizationService, PublishingAuthorizationError } from "../src/lib/server/publishing-authorization-service";
import { PublishingAuthorizationProviderError, type PublishingAuthorizationProviderOptions, type PublishingAuthorizationProviderStatus } from "../src/lib/server/publishing-authorization-provider";
import { publishingProviderPayloadHash } from "../src/lib/server/publishing-provider";
import { sealPublishingAuthContinuation, publishingAuthCookieName } from "../src/lib/server/publishing-auth-continuation";

type Row = Record<string, unknown>;
const user = { id: randomUUID(), email: "fixture@example.invalid", role: "student" };
const cfg = { environment: "domestic" as const, configured: true, apiKey: "synthetic-injected-fixture-only", namespace: "domestic:fixture", credentialSource: "environment" as const, credentialIssue: null };
const clone = <T>(v: T): T => structuredClone(v);
const now = new Date().toISOString();
class Database {
  tables: Record<string, Row[]> = { pub4_auth_operations: [], pub4_auth_sessions: [], pub4_account_bindings: [] };
  calls: Row[] = [];
  dispatchPause?: () => Promise<void>;
  lookupPause?: () => Promise<void>;
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    const q = { select: () => q, eq: (key: string, value: unknown) => { filters.push([key, value]); return q; }, order: () => q,
      maybeSingle: async () => { if (table === "pub4_auth_operations" && this.lookupPause) await this.lookupPause(); return { data: clone(this.tables[table]?.find(r => filters.every(([k, v]) => r[k] === v)) ?? null), error: null }; },
      range: async () => { const data = this.tables[table].filter(r => filters.every(([k, v]) => r[k] === v)); return { data: clone(data), count: data.length, error: null }; } };
    return q;
  }
  async rpc(_name: string, args: { p_user_id: string; p_input: Row }) {
    const p = args.p_input; this.calls.push(clone(p));
    const operations = this.tables.pub4_auth_operations, sessions = this.tables.pub4_auth_sessions;
    if (p.action === "prepare-start" || p.action === "prepare-selection") {
      const request = p.request as Row;
      const existing = operations.find(o => o.owner_id === args.p_user_id && o.request_key === request.requestKey);
      if (existing) return { data: { operation: clone(existing), alreadyFulfilled: true }, error: null };
      if (p.action === "prepare-start") sessions.push({ id: p.sessionId, owner_id: args.p_user_id, connection_id: p.connectionId, platform: request.platform, request_key: request.requestKey, state: "prepared", revision: 1, display: {}, choices: [], binding_ids: [], created_at: now, updated_at: now });
      const session = sessions.find(s => s.id === p.sessionId)!;
      const op = { id: p.operationId, owner_id: args.p_user_id, connection_id: p.connectionId, kind: p.action === "prepare-start" ? "start" : "select", session_id: p.sessionId, request_key: request.requestKey, request_payload: request, provider_request: p.providerRequest, provider_request_hash: p.providerRequestHash, grant_kind: "authorization", grant_subject: p.action === "prepare-start" ? p.sessionId : `${session.provider_session_id}:selection`, grant_used: false, revision: 1, dispatch_state: "ready", created_at: now, updated_at: now };
      operations.push(op); return { data: { operation: clone(op) }, error: null };
    }
    const op = operations.find(o => o.id === p.operationId);
    if (p.action === "dispatch") { if (this.dispatchPause) await this.dispatchPause(); const shouldSend = op!.dispatch_state === "ready"; if (shouldSend) { op!.dispatch_state = "dispatching"; op!.revision = Number(op!.revision) + 1; } return { data: { operation: clone(op), shouldSend }, error: null }; }
    if (p.action === "consume-grant") { const consumed = !op!.grant_used && op!.dispatch_state === "dispatching" && p.providerRequestHash === op!.provider_request_hash; if (consumed) { op!.grant_used = true; op!.revision = Number(op!.revision) + 1; } return { data: { operation: clone(op), consumed }, error: null }; }
    if (p.action === "record-start") { assert.equal(p.expectedRevision, op!.revision); const session = sessions.find(s => s.id === op!.session_id)!; Object.assign(session, { provider_session_id: p.providerSessionId, expires_at: p.expiresAt, display: p.display, state: "pending", revision: Number(session.revision) + 1 }); op!.dispatch_state = "dispatched"; op!.revision = Number(op!.revision) + 1; return { data: { operation: clone(op), session: clone(session) }, error: null }; }
    if (p.action === "record-unknown") { op!.dispatch_state = "unknown"; op!.revision = Number(op!.revision) + 1; op!.error_code = p.errorCode; return { data: { operation: clone(op) }, error: null }; }
    if (p.action === "record-observation") { const session = sessions.find(s => s.id === p.sessionId)!; if (p.expectedRevision !== session.revision) return { error: { message: "PUBLISH_AUTH_REVISION_CONFLICT" } }; Object.assign(session, { state: p.state, choices: p.choices, completed_accounts: p.accounts, revision: Number(session.revision) + 1 }); return { data: { session: clone(session) }, error: null }; }
    throw new Error(`UNEXPECTED_STUB_RPC_${String(p.action)}`);
  }
}
function fixture() {
  const db = new Database();
  let starts = 0, selections = 0, observations = 0, caps = 0, grants = 0;
  let lost = false, available = true, status: PublishingAuthorizationProviderStatus = { sessionId: "provider-session", status: "pending", requiresSelection: false };
  const service = createPublishingAuthorizationService({ configuration: () => cfg, access: async () => {}, provider: (options: PublishingAuthorizationProviderOptions) => ({
    capabilities: async () => { caps++; return [{ platform: "twitter", status: available ? "available" : "unavailable", authType: "oauth2" }, { platform: "linkedin", status: "unavailable", authType: "oauth2" }]; },
    start: async (platform, localSessionId, operationId) => { starts++; grants++; assert.equal(platform, "twitter"); assert.ok(await options.consumeGrant({ ownerId: user.id, operationId, kind: "authorization", subject: localSessionId, payloadHash: publishingProviderPayloadHash({ type: platform, correlationId: localSessionId, callbackUrl: null }) })); if (lost) throw new PublishingAuthorizationProviderError("AUTH_PROVIDER_OUTCOME_UNKNOWN"); const url = new URL("https://x.com/i/oauth2/authorize"); url.searchParams.set("state", "provider-session"); return { sessionId: "provider-session", url: url.toString(), expiresAt: new Date(Date.now() + 240000).toISOString() }; },
    select: async (sessionId, accounts, operationId, cookie) => { selections++; assert.equal(cookie, "_cas=synthetic"); assert.deepEqual(accounts, [{ platformUid: "only-one" }]); assert.ok(await options.consumeGrant({ ownerId: user.id, operationId, kind: "authorization", subject: `${sessionId}:selection`, payloadHash: publishingProviderPayloadHash({ accounts }) })); },
    status: async () => { observations++; return clone(status); }, readAccount: async () => { throw new Error("NO_TENANT_ACCOUNT_LIST_OR_UNSCOPED_READ_ALLOWED"); }, takeCookie: () => "_cas=synthetic",
  }) });
  return { db, service, counts: () => ({ starts, selections, observations, caps, grants }), lose: () => { lost = true; }, unavailable: () => { available = false; }, status: (v: PublishingAuthorizationProviderStatus) => { status = v; } };
}
const start = { action: "start" as const, platform: "twitter" as const, requestKey: "fixture:start" };
const pending = (id = randomUUID()): Row => ({ id, owner_id: user.id, connection_id: cfg.namespace, platform: "twitter", provider_session_id: "provider-session", state: "requires_selection", revision: 3, display: {}, choices: [{ id: randomUUID(), platform: "twitter", platformUid: "only-one", displayName: "Candidate" }], binding_ids: [], expires_at: new Date(Date.now() + 240000).toISOString(), created_at: now, updated_at: now });
test("lost acknowledgement replays the original operation without another provider start", async () => {
  const f = fixture(); f.lose();
  await assert.rejects(() => f.service.mutate(user, f.db as never, start), (e: unknown) => e instanceof PublishingAuthorizationError && e.code === "PUBLISH_AUTH_OUTCOME_UNKNOWN");
  const result = await f.service.mutate(user, f.db as never, start);
  assert.equal((result.data as Row).alreadyFulfilled, true); assert.equal(f.counts().starts, 1); assert.equal(f.db.tables.pub4_auth_operations.length, 1);
  await assert.rejects(() => f.service.mutate(user, f.db as never, { ...start, platform: "youtube" }), /请求标识已用于不同内容/); assert.equal(f.counts().starts, 1);
});
test("same-key prepare race dispatches only the committed session and body", async () => {
  const f = fixture(); let release: () => void = () => {}; const pause = new Promise<void>(r => { release = r; }); let dispatches = 0;
  f.db.dispatchPause = async () => { if (++dispatches === 1) await pause; else release(); };
  const results = await Promise.all([f.service.mutate(user, f.db as never, start), f.service.mutate(user, f.db as never, start)]);
  assert.equal(results.length, 2); assert.equal(f.counts().starts, 1); assert.equal(f.counts().grants, 1); assert.equal(f.db.tables.pub4_auth_sessions.length, 1);
  const op = f.db.tables.pub4_auth_operations[0]; assert.equal(op.session_id, (op.provider_request as Row).correlationId); assert.ok(op.grant_used);
});
test("a crash after prepare can resume the persisted ready operation once", async () => {
  const f = fixture(), sessionId = randomUUID(), operationId = randomUUID();
  const body = { type: "twitter", correlationId: sessionId, callbackUrl: null };
  await f.db.rpc("", { p_user_id: user.id, p_input: { action: "prepare-start", operationId, sessionId, connectionId: cfg.namespace, request: start, providerRequest: body, providerRequestHash: publishingProviderPayloadHash(body) } });
  await f.service.mutate(user, f.db as never, start); await f.service.mutate(user, f.db as never, start);
  assert.equal(f.counts().starts, 1); assert.equal(f.db.tables.pub4_auth_operations[0].id, operationId);
});
test("unavailable platform cannot create a session or grant", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.mutate(user, f.db as never, { ...start, platform: "linkedin" }), /尚未开放官方授权/);
  assert.equal(f.db.calls.length, 0); assert.equal(f.counts().starts, 0);
});
test("selection accepts only opaque persisted choice IDs and needs an owner-bound continuation", async () => {
  const f = fixture(), session = pending(); f.db.tables.pub4_auth_sessions.push(session);
  const action = { action: "select" as const, sessionId: String(session.id), expectedRevision: 3, choiceIds: [String((session.choices as Row[])[0].id)], requestKey: "select:one" };
  await assert.rejects(() => f.service.mutate(user, f.db as never, action), /授权续传已失效/); assert.equal(f.db.calls.length, 0);
  const sealed = sealPublishingAuthContinuation({ ownerId: user.id, localSessionId: String(session.id), providerSessionId: "provider-session", environment: "domestic", expiresAt: String(session.expires_at), cookie: "_cas=synthetic" }, cfg.apiKey);
  const cookies = { get: (name: string) => name === publishingAuthCookieName(String(session.id)) ? sealed : undefined };
  await assert.rejects(() => f.service.mutate(user, f.db as never, { ...action, choiceIds: [randomUUID()] }, cookies), /只能选择本次授权返回/); assert.equal(f.counts().selections, 0);
  f.status({ sessionId: "provider-session", status: "completed", requiresSelection: false, accounts: [{ accountId: "provider-one", platform: "twitter", platformUid: "only-one", displayName: "Candidate" }] });
  await f.service.mutate(user, f.db as never, action, cookies); assert.equal(f.counts().selections, 1); assert.equal(f.counts().observations, 1);
  const prepared = f.db.calls.find(c => c.action === "prepare-selection")!; assert.deepEqual(prepared.providerRequest, { accounts: [{ platformUid: "only-one" }] });
});
test("foreign, old-namespace and completed sessions never reach provider status", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.read(user, f.db as never, { resource: "session", id: randomUUID() }), /不属于当前会员/);
  const old: Row = { ...pending(), connection_id: "domestic:previous" }; f.db.tables.pub4_auth_sessions.push(old);
  const oldResult = await f.service.read(user, f.db as never, { resource: "session", id: String(old.id) }); assert.equal((oldResult.data as Row).connectionCurrent, false);
  const completed: Row = { ...pending(), state: "completed", expires_at: new Date(Date.now() - 10000).toISOString() }; f.db.tables.pub4_auth_sessions.push(completed);
  const result = await f.service.read(user, f.db as never, { resource: "session", id: String(completed.id) }); assert.equal((result.data as Row).state, "completed"); assert.equal(f.counts().observations, 0); assert.equal(f.counts().starts, 0);
});
