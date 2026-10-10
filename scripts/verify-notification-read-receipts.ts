import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type Json = Record<string, unknown>;

function bundledRoute(entry: string, stubs: Record<string, unknown>): Record<string, unknown> {
  const filename = path.resolve(entry);
  const source = readFileSync(filename, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  });
  const routeModule = { exports: {} as Record<string, unknown> };
  const requireStub = (specifier: string) => {
    assert(Object.hasOwn(stubs, specifier), `UNEXPECTED_ROUTE_IMPORT:${specifier}`);
    return stubs[specifier];
  };
  const evaluate = new Function("exports", "require", "module", "__filename", "__dirname", transpiled.outputText) as (
    exports: Record<string, unknown>,
    require: (specifier: string) => unknown,
    module: { exports: Record<string, unknown> },
    filename: string,
    dirname: string,
  ) => void;
  evaluate(routeModule.exports, requireStub, routeModule, filename, path.dirname(filename));
  return routeModule.exports;
}

function responseStub() {
  class NextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new NextResponse(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  }
  return { NextResponse, NextRequest: Request };
}

function accountDatabase(rows: Json[]) {
  const effects = { updates: 0, changedRows: 0, selects: 0 };
  return {
    effects,
    from(table: string) {
      assert.equal(table, "user_notifications");
      return {
        update(values: Json) {
          effects.updates += 1;
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            async select() {
              const matched = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
              for (const row of matched) {
                Object.assign(row, values);
                effects.changedRows += 1;
              }
              return { data: matched.map((row) => ({ id: row.id, read_at: row.read_at })), error: null };
            },
          };
          return query;
        },
        select() {
          effects.selects += 1;
          const filters: Array<[string, unknown]> = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            async limit(count: number) {
              const matched = rows
                .filter((row) => filters.every(([column, value]) => row[column] === value))
                .slice(0, count);
              return {
                data: matched.map((row) => ({ id: row.id, is_read: row.is_read, read_at: row.read_at })),
                error: null,
              };
            },
          };
          return query;
        },
      };
    },
  };
}

async function body(response: Response): Promise<Json> {
  return response.json() as Promise<Json>;
}

async function verifyAccountReceipts() {
  const route = bundledRoute("src/app/api/notifications/user/route.ts", {
    "node:buffer": { Buffer },
    "next/server": responseStub(),
    "@/lib/auth": { verifyToken: async () => ({ userId: "user-1" }) },
    "@/storage/database/supabase-client": { getSupabaseAdminClient: () => globalThis.__notificationDatabase },
  });
  const put = route.PUT as (request: Request) => Promise<Response>;
  assert.equal(typeof put, "function", "ACCOUNT_PUT_EXPORT_REQUIRED");

  const ownUnread = { id: "notification-1", user_id: "user-1", is_read: false, read_at: null };
  globalThis.__notificationDatabase = accountDatabase([ownUnread]);
  const success = await put(new Request("http://local/api/notifications/user", {
    method: "PUT",
    headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    body: JSON.stringify({ notificationId: ownUnread.id }),
  }));
  const successBody = await body(success);
  assert.equal(success.status, 200);
  assert.equal(successBody.success, true);
  assert.equal(successBody.status, "read");
  assert.equal(successBody.notificationId, ownUnread.id);
  assert.equal(successBody.alreadyRead, false);
  assert.equal(typeof successBody.readAt, "string");
  assert(Number.isFinite(Date.parse(String(successBody.readAt))), "ACCOUNT_READ_AT_MUST_BE_VALID");
  const firstReadAt = String(successBody.readAt);
  const retry = await put(new Request("http://local/api/notifications/user", {
    method: "PUT",
    headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    body: JSON.stringify({ notificationId: ownUnread.id }),
  }));
  const retryBody = await body(retry);
  assert.equal(retry.status, 200);
  assert.deepEqual(retryBody, {
    success: true,
    status: "read",
    notificationId: ownUnread.id,
    readAt: firstReadAt,
    alreadyRead: true,
    message: "已标记阅读",
  });
  assert.equal(globalThis.__notificationDatabase.effects.updates, 2, "RETRY_MAY_REPEAT_CONDITIONAL_UPDATE");
  assert.equal(globalThis.__notificationDatabase.effects.changedRows, 1, "RETRY_MUST_NOT_REPEAT_WRITE_SIDE_EFFECT");
  assert.equal(globalThis.__notificationDatabase.effects.selects, 1, "RETRY_MUST_READ_STABLE_RECEIPT");
  assert.equal(ownUnread.read_at, firstReadAt, "RETRY_MUST_PRESERVE_FIRST_READ_TIMESTAMP");

  for (const fixture of [
    { id: "missing", rows: [] },
    { id: "foreign", rows: [{ id: "foreign", user_id: "user-2", is_read: false, read_at: null }] },
  ]) {
    globalThis.__notificationDatabase = accountDatabase(fixture.rows);
    const response = await put(new Request("http://local/api/notifications/user", {
      method: "PUT",
      headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
      body: JSON.stringify({ notificationId: fixture.id }),
    }));
    const payload = await body(response);
    assert.equal(response.status, 404, `ACCOUNT_${fixture.id.toUpperCase()}_MUST_FAIL`);
    assert.equal(payload.success, false);
    assert.notEqual(payload.status, "read");
    assert.equal(payload.readAt, null);
  }

  const foreignReadAt = "2026-10-09T06:00:00.000Z";
  globalThis.__notificationDatabase = accountDatabase([
    { id: "shared-id", user_id: "user-2", is_read: true, read_at: foreignReadAt },
  ]);
  const foreignAlreadyRead = await put(new Request("http://local/api/notifications/user", {
    method: "PUT",
    headers: { Authorization: "Bearer valid", "Content-Type": "application/json" },
    body: JSON.stringify({ notificationId: "shared-id" }),
  }));
  const foreignAlreadyReadBody = await body(foreignAlreadyRead);
  assert.equal(foreignAlreadyRead.status, 404, "FOREIGN_READ_RECEIPT_MUST_NOT_BE_DISCLOSED");
  assert.equal(foreignAlreadyReadBody.success, false);
  assert.equal(foreignAlreadyReadBody.readAt, null);
}

async function verifyAnnouncementReceipts() {
  const route = bundledRoute("src/app/api/announcements/[id]/read/route.ts", {
    "next/server": responseStub(),
    "@/lib/api-middleware": {
      withAuth: (_request: Request, handler: (user: { id: string }, database: unknown) => unknown) => (
        handler({ id: "user-1" }, globalThis.__announcementDatabase)
      ),
    },
    "@/lib/announcement-delivery-server": {
      ANNOUNCEMENT_PRIVATE_HEADERS: { "Cache-Control": "private, no-store" },
      requiredPositiveInteger(value: unknown) {
        const parsed = typeof value === "number" ? value : Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      },
      announcementBackendError(_error: unknown, fallback: string) {
        return Response.json({ error: fallback, code: "ANNOUNCEMENT_BACKEND_UNAVAILABLE" }, { status: 503 });
      },
    },
  });
  const post = route.POST as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
  assert.equal(typeof post, "function", "ANNOUNCEMENT_POST_EXPORT_REQUIRED");

  const announcementId = "announcement-1";
  const revision = 3;
  const readAt = "2026-10-09T06:40:00.000Z";
  const invoke = async (data: unknown) => {
    globalThis.__announcementDatabase = { rpc: async () => ({ data, error: null }) };
    return post(new Request(`http://local/api/announcements/${announcementId}/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision }),
    }), { params: Promise.resolve({ id: announcementId }) });
  };

  const canonical = await invoke({ success: true, announcementId, revision, readAt, alreadyRead: false, status: "read" });
  assert.equal(canonical.status, 200);
  assert.deepEqual(await body(canonical), { success: true, announcementId, revision, readAt, alreadyRead: false, status: "read" });

  const aliases = await invoke({ success: true, id: announcementId, push_revision: revision, read_at: readAt, already_read: true, status: "read" });
  assert.equal(aliases.status, 200);
  assert.deepEqual(await body(aliases), { success: true, announcementId, revision, readAt, alreadyRead: true, status: "read" });

  for (const data of [
    {},
    { success: false, announcementId, revision, readAt, alreadyRead: false, status: "read" },
    { success: true, announcementId: "another-announcement", revision, readAt, alreadyRead: false, status: "read" },
    { success: true, announcementId, revision: revision + 1, readAt, alreadyRead: false, status: "read" },
    { success: true, announcementId, revision, readAt: "invalid", alreadyRead: false, status: "read" },
    { success: true, announcementId, revision, readAt: "2026-02-30T06:40:00.000Z", alreadyRead: false, status: "read" },
    { success: true, announcementId, revision, readAt, alreadyRead: false, status: "unread" },
    { success: true, announcementId, revision, readAt, status: "read" },
  ]) {
    const response = await invoke(data);
    assert.equal(response.status, 503, "INVALID_ANNOUNCEMENT_RPC_OBJECT_MUST_FAIL_CLOSED");
  }
}

declare global {
  var __notificationDatabase: ReturnType<typeof accountDatabase>;
  var __announcementDatabase: { rpc: () => Promise<{ data: unknown; error: null }> };
}

async function main() {
  await verifyAccountReceipts();
  await verifyAnnouncementReceipts();
  console.log(JSON.stringify({
    verifier: "notification-read-receipts",
    passed: true,
    checks: {
      accountRouteRequiresCurrentUserOwnershipForUpdateAndRetryLookup: true,
      accountRouteReturnsCanonicalFirstReadReceipt: true,
      accountRouteRetryPreservesReadAtWithoutRepeatedSideEffect: true,
      accountRouteMissingAndForeignRowsRemainNotFound: true,
      announcementRouteRejectsArbitraryRpcObjects: true,
      announcementRouteNormalizesExistingFieldAliases: true,
    },
    databaseWrites: 0,
    productionWrites: 0,
  }, null, 2));
}

void main();
