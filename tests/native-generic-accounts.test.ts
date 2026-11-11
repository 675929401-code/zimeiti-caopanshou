import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { AuthUser } from "../src/lib/api-middleware";
import { PUBLISHING_OAUTH_PLATFORMS } from "../src/lib/publishing-authorization-contract";

type Row = Record<string, unknown>;
const owner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000002";
const groupId = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const user: AuthUser = { id: owner, email: "fixture@example.invalid", role: "student" };
const namespace = "domestic:injected-fixture";
const stamp = "2026-11-10T00:00:00.000Z";
const uuid = (index: number) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const expectedCapabilities = { connect: true, publish: false, analytics: false, engagement: false };
const configuration = () => ({ namespace });
function binding(index = 1, extra: Row = {}): Row {
  return { id: uuid(index), owner_id: owner, connection_id: namespace, platform: "facebook", platform_uid: `platform-${index}`,
    provider_account_id: `private-provider-account-${index}`, account: "page-1", display_name: `账号${index}`, avatar: "https://images.example.com/avatar.png",
    status: "active", revision: 7, group_id: groupId, auth_session_id: sessionId, created_at: stamp, updated_at: stamp, ...extra };
}
interface QueryCall { table: string; columns?: string; filters: Row; range?: [number, number]; single?: boolean }
class Database {
  calls: QueryCall[] = [];
  error: Row | null = null;
  returned?: unknown;
  constructor(readonly rows: Row[]) {}
  from(table: string) {
    assert.equal(table, "pub4_account_bindings", "Only local owner binding rows may be read");
    const call: QueryCall = { table, filters: {} };
    this.calls.push(call);
    const matching = () => {
      assert.equal(call.filters.owner_id, owner, "Every query must filter the real member");
      assert.equal(call.filters.connection_id, namespace, "Every query must filter the captured namespace");
      return this.rows.filter(row => Object.entries(call.filters).every(([key, value]) => row[key] === value));
    };
    const query = {
      select: (columns: string) => { call.columns = columns; assert(!columns.split(",").includes("provider_account_id")); return query; },
      eq: (key: string, value: unknown) => { call.filters[key] = value; return query; },
      order: (key: string) => { assert.equal(key, "id"); return query; },
      range: async (start: number, end: number) => {
        call.range = [start, end]; const rows = matching();
        return { data: this.returned === undefined ? structuredClone(rows.slice(start, end + 1)) : this.returned, error: this.error };
      },
      maybeSingle: async () => {
        call.single = true; const rows = matching();
        return { data: this.returned === undefined ? structuredClone(rows[0] ?? null) : this.returned, error: this.error };
      },
    };
    return query;
  }
  rpc(): never { throw new Error("READ_PROJECTION_MUST_NOT_MUTATE"); }
}
let readList: typeof import("../src/lib/server/native-generic-accounts").readNativeGenericAccounts;
let readOne: typeof import("../src/lib/server/native-generic-accounts").readNativeGenericAccount;
let projectPlatform: typeof import("../src/lib/server/native-generic-accounts").projectNativeGenericPlatform;
const originalFetch = globalThis.fetch;
let escapedNetwork = 0;
before(async () => {
  // All DB/configuration inputs are injected; any accidental HTTP is a failure.
  globalThis.fetch = async () => { escapedNetwork++; throw new Error("UNEXPECTED_NETWORK_ESCAPE"); };
  const actual = await import("../src/lib/server/native-generic-accounts");
  readList = actual.readNativeGenericAccounts; readOne = actual.readNativeGenericAccount; projectPlatform = actual.projectNativeGenericPlatform;
});
after(() => { globalThis.fetch = originalFetch; assert.equal(escapedNetwork, 0); });

test("account projection preserves binding IDs, group and CAS without claiming publishing or online status", async () => {
  const db = new Database([binding()]);
  const [account] = await readList(db as never, user, { configuration });
  assert.equal(account.id, uuid(1)); assert.equal(account.type, "facebook"); assert.equal(account.uid, "platform-1");
  assert.equal(account.nickname, "账号1"); assert.equal(account.groupId, groupId);
  assert.equal(account.nativeAccountKind, "generic"); assert.equal(account.nativeTransport, "generic-oauth");
  assert.equal(account.nativeBindingRevision, 7); assert.equal(account.nativeRevision, 7); assert.equal(account.nativeMetadataRevision, 0);
  assert.equal(account.nativeAuthSessionId, sessionId); assert.equal(account.authSessionId, sessionId);
  assert.equal(account.status, 0); assert.equal(account.nativeBindingStatus, "active"); assert.equal(account.nativeConnectionState, "official_bound");
  assert.equal(account.nativeConnectionCurrent, true); assert.equal(account.connectionCurrent, true); assert.equal(account.nativeReadOnly, false);
  assert.equal(account.nativePublishAllowed, false); assert.deepEqual(account.capabilities, expectedCapabilities); assert.deepEqual(account.nativeCapabilities, expectedCapabilities);
  assert(!JSON.stringify(account).includes("private-provider-account")); assert(!JSON.stringify(account).includes(namespace));
});

test("list reads every owner/current active page and excludes foreign, historical and disconnected bindings", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => binding(index + 1));
  rows.push(binding(300, { owner_id: otherOwner }), binding(301, { connection_id: "previous:namespace" }), binding(302, { status: "disconnected" }), binding(303, { status: "unknown" }));
  const db = new Database(rows); let configurationReads = 0;
  const accounts = await readList(db as never, user, { configuration: () => { configurationReads++; return { namespace }; } });
  assert.equal(accounts.length, 201); assert.equal(configurationReads, 1); assert.equal(db.calls.length, 3);
  assert.deepEqual(db.calls.map(call => call.range), [[0, 99], [100, 199], [200, 299]]);
  for (const call of db.calls) assert.equal(call.filters.status, "active");
  assert.equal(new Set(accounts.map(account => account.id)).size, 201);
});

test("detail uses the same owner and namespace filters as list", async () => {
  const db = new Database([binding(), binding(2, { owner_id: otherOwner }), binding(3, { connection_id: "previous:namespace" })]);
  assert.equal((await readOne(db as never, user, uuid(1), { configuration }))?.id, uuid(1));
  assert.equal(await readOne(db as never, user, uuid(2), { configuration }), null);
  assert.equal(await readOne(db as never, user, uuid(3), { configuration }), null);
  assert.equal(await readOne(db as never, user, uuid(4), { configuration }), null);
  for (const call of db.calls) { assert.equal(call.single, true); assert.equal(call.filters.status, undefined); }
});

test("current disconnected detail is explicit and cannot become an executable account", async () => {
  const db = new Database([binding(1, { status: "disconnected", group_id: null, revision: 8 })]);
  const account = await readOne(db as never, user, uuid(1), { configuration });
  assert(account); assert.equal(account.groupId, ""); assert.equal(account.nativeDisconnected, true);
  assert.equal(account.nativeConnectionState, "disconnected"); assert.equal(account.nativeBindingStatus, "disconnected");
  assert.equal(account.nativeBindingRevision, 8); assert.equal(account.status, 0); assert.equal(account.nativePublishAllowed, false);
});

test("a DB response outside the enforced owner/current filters fails closed", async () => {
  for (const extra of [{ owner_id: otherOwner }, { connection_id: "previous:namespace" }, { platform: "douyin" }, { avatar: "http://unsafe.example.invalid/avatar.png" }]) {
    const db = new Database([]); db.returned = binding(1, extra);
    await assert.rejects(readOne(db as never, user, uuid(1), { configuration }), error => (error as Row).code === "NATIVE_GENERIC_ACCOUNTS_UNAVAILABLE");
  }
  const db = new Database([]); db.returned = [binding(1, { status: "disconnected" })];
  await assert.rejects(readList(db as never, user, { configuration }), error => (error as Row).code === "NATIVE_GENERIC_ACCOUNTS_UNAVAILABLE");
});

test("schema and database failures never return a false empty account inventory", async () => {
  const missing = new Database([]); missing.error = { code: "42P01", message: "synthetic schema missing" };
  await assert.rejects(readList(missing as never, user, { configuration }), error => (error as Row).code === "PUBLISH_AUTH_SCHEMA_NOT_READY");
  const failed = new Database([]); failed.error = { code: "XX000", message: "synthetic read failure" };
  await assert.rejects(readOne(failed as never, user, uuid(1), { configuration }), error => (error as Row).code === "NATIVE_GENERIC_ACCOUNTS_UNAVAILABLE");
});

test("all 11 generic OAuth platforms use metadata availability and never enable publishing", () => {
  assert.equal(PUBLISHING_OAUTH_PLATFORMS.length, 11);
  for (const platform of PUBLISHING_OAUTH_PLATFORMS) {
    const projected = projectPlatform({ platform, status: "available", authType: "oauth2", capabilities: { publish: { supported: true } } }, { configured: true });
    assert(projected); assert.equal(projected.platform, platform); assert.equal(projected.nativeConnectionAllowed, true);
    assert.equal(projected.nativeAccountKind, "generic"); assert.equal(projected.nativeTransport, "generic-oauth");
    assert.equal(projected.nativePublishAllowed, false); assert.deepEqual(projected.nativeCapabilities, expectedCapabilities);
  }
});

test("LinkedIn unavailable, unknown metadata, wrong auth type and absent configuration forbid connection", () => {
  for (const [item, configured] of [
    [{ platform: "linkedin", status: "unavailable", authType: "oauth2" }, true],
    [{ platform: "threads", status: "available", authType: "qrcode" }, true],
    [{ platform: "instagram", authType: "oauth2" }, true],
    [{ platform: "youtube", status: "available", authType: "oauth2" }, false],
  ] as const) {
    const projected = projectPlatform(item, { configured });
    assert(projected); assert.equal(projected.nativeConnectionAllowed, false); assert.equal(projected.nativePublishAllowed, false);
    assert.equal(typeof projected.nativeReason, "string");
  }
});

test("browser, Douyin official and unknown entries retain their existing projector", () => {
  for (const platform of ["xhs", "wxSph", "douyin", "unsupported"]) assert.equal(projectPlatform({ platform, status: "available", authType: "oauth2" }, { configured: true }), null);
});
