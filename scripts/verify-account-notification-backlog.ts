import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type Json = Record<string, unknown>;
type NotificationRow = Json & {
  id: string;
  user_id: string;
  is_read: boolean;
  created_at: string;
};

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
  return { NextResponse };
}

function compareRows(left: NotificationRow, right: NotificationRow) {
  const timeDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
  return timeDifference || right.id.localeCompare(left.id);
}

function paginationDatabase(rows: NotificationRow[]) {
  const effects = { selects: 0, updates: 0 };
  return {
    effects,
    from(table: string) {
      assert.equal(table, "user_notifications");
      return {
        select(_columns: string, options?: { count?: string; head?: boolean }) {
          effects.selects += 1;
          const filters: Array<[string, unknown]> = [];
          let cursor: { createdAt: string; id: string } | null = null;
          let limitCount = Number.POSITIVE_INFINITY;
          const query = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return query;
            },
            or(expression: string) {
              const match = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/u.exec(expression);
              assert(match, `UNEXPECTED_CURSOR_FILTER:${expression}`);
              assert.equal(match[1], match[2], "CURSOR_TIMESTAMP_MUST_MATCH_BOTH_BRANCHES");
              cursor = { createdAt: match[1], id: match[3] };
              return query;
            },
            order() {
              return query;
            },
            limit(count: number) {
              limitCount = count;
              return query;
            },
            then<TResult1 = { data: NotificationRow[] | null; error: null; count: number }, TResult2 = never>(
              onfulfilled?: ((value: { data: NotificationRow[] | null; error: null; count: number }) => TResult1 | PromiseLike<TResult1>) | null,
              onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
            ) {
              try {
                const filtered = rows
                  .filter((row) => filters.every(([column, value]) => row[column] === value))
                  .filter((row) => !cursor
                    || row.created_at < cursor.createdAt
                    || (row.created_at === cursor.createdAt && row.id < cursor.id))
                  .sort(compareRows);
                const result = {
                  data: options?.head ? null : filtered.slice(0, limitCount),
                  error: null,
                  count: filtered.length,
                };
                return Promise.resolve(onfulfilled ? onfulfilled(result) : result as TResult1);
              } catch (error) {
                if (onrejected) return Promise.resolve(onrejected(error));
                return Promise.reject(error);
              }
            },
          };
          return query;
        },
      };
    },
  };
}

async function responseBody(response: Response): Promise<Json> {
  return response.json() as Promise<Json>;
}

function fixtures() {
  const base = Date.parse("2026-10-09T08:00:00.000Z");
  const unread = Array.from({ length: 123 }, (_, index): NotificationRow => ({
    id: `notice-${String(index).padStart(4, "0")}`,
    user_id: "user-1",
    type: "benefit",
    title: `权益通知 ${index}`,
    content: "零成本分页夹具",
    cami_code: null,
    is_read: false,
    created_at: new Date(base - Math.floor(index / 4) * 1_000).toISOString(),
    read_at: null,
    metadata: {},
  }));
  const read = Array.from({ length: 17 }, (_, index): NotificationRow => ({
    id: `read-${String(index).padStart(4, "0")}`,
    user_id: "user-1",
    type: "system",
    title: `旧已读 ${index}`,
    content: "不应进入未读积压分页",
    cami_code: null,
    is_read: true,
    created_at: new Date(base - (index * 7 + 2) * 1_000).toISOString(),
    read_at: new Date(base + 60_000).toISOString(),
    metadata: {},
  }));
  return { unread, read, all: [...unread, ...read] };
}

async function main() {
  const data = fixtures();
  globalThis.__notificationBacklogDatabase = paginationDatabase(data.all);
  const route = bundledRoute("src/app/api/notifications/user/route.ts", {
    "node:buffer": { Buffer },
    "next/server": responseStub(),
    "@/lib/auth": { verifyToken: async () => ({ userId: "user-1" }) },
    "@/storage/database/supabase-client": {
      getSupabaseAdminClient: () => globalThis.__notificationBacklogDatabase,
    },
  });
  const get = route.GET as (request: Request) => Promise<Response>;
  assert.equal(typeof get, "function", "ACCOUNT_NOTIFICATION_GET_EXPORT_REQUIRED");

  const recentResponse = await get(new Request("http://local/api/notifications/user?limit=50", {
    headers: { Authorization: "Bearer valid" },
  }));
  const recent = await responseBody(recentResponse);
  assert.equal(recentResponse.status, 200);
  assert.equal(recent.success, true);
  assert.equal(recent.pageSize, 50);
  assert.equal(recent.unreadCount, 123, "RECENT_WINDOW_MUST_KEEP_GLOBAL_UNREAD_COUNT");
  assert.equal((recent.notifications as unknown[]).length, 50, "ONLINE_WINDOW_MUST_STAY_SMALL");
  assert.equal(recent.hasMore, true);
  assert.equal(typeof recent.nextCursor, "string");

  const accumulated: NotificationRow[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  while (true) {
    pageCount += 1;
    assert(pageCount <= 10, "BACKLOG_PAGINATION_MUST_TERMINATE");
    const search = new URLSearchParams({ unreadOnly: "true", limit: "40" });
    if (cursor) search.set("cursor", cursor);
    const response = await get(new Request(`http://local/api/notifications/user?${search.toString()}`, {
      headers: { Authorization: "Bearer valid" },
    }));
    const payload = await responseBody(response);
    assert.equal(response.status, 200);
    assert.equal(payload.unreadCount, 123, "EVERY_PAGE_MUST_KEEP_GLOBAL_UNREAD_COUNT");
    const notifications = payload.notifications as NotificationRow[];
    assert(notifications.every((notification) => notification.is_read === false), "BACKLOG_MUST_EXCLUDE_OLD_READ_ROWS");
    for (const notification of notifications) {
      assert(!seenIds.has(notification.id), `DUPLICATE_NOTIFICATION:${notification.id}`);
      seenIds.add(notification.id);
      accumulated.push(notification);
    }
    if (payload.hasMore !== true) break;
    assert.equal(typeof payload.nextCursor, "string", "MORE_PAGES_REQUIRE_CURSOR");
    cursor = String(payload.nextCursor);
    assert(!seenCursors.has(cursor), "CURSOR_MUST_ADVANCE");
    seenCursors.add(cursor);
  }
  assert.equal(pageCount, 4);
  assert.equal(accumulated.length, 123, "ALL_UNREAD_NOTIFICATIONS_MUST_BE_REACHABLE");
  assert.deepEqual(
    accumulated.map((notification) => notification.id),
    [...data.unread].sort(compareRows).map((notification) => notification.id),
    "CREATED_AT_AND_ID_ORDER_MUST_REMAIN_STABLE_ACROSS_PAGES",
  );

  for (const url of [
    "http://local/api/notifications/user?limit=101",
    "http://local/api/notifications/user?cursor=not-a-cursor",
  ]) {
    const response = await get(new Request(url, { headers: { Authorization: "Bearer valid" } }));
    assert.equal(response.status, 400, `INVALID_PAGINATION_INPUT_MUST_FAIL:${url}`);
  }

  const routeSource = readFileSync("src/app/api/notifications/user/route.ts", "utf8");
  const clientSource = readFileSync("src/components/account-notification-center.tsx", "utf8");
  assert(routeSource.includes('.order("created_at", { ascending: false })')
    && routeSource.includes('.order("id", { ascending: false })'), "SERVER_KEYSET_ORDER_REQUIRED");
  assert(routeSource.includes("created_at.lt.${cursor.createdAt}")
    && routeSource.includes("id.lt.${cursor.id}"), "SERVER_KEYSET_CURSOR_REQUIRED");
  assert(clientSource.includes("const RECENT_PAGE_SIZE = 50")
    && clientSource.includes("const BACKLOG_PAGE_SIZE = 100"), "SMALL_ONLINE_AND_LARGE_BACKLOG_WINDOWS_REQUIRED");
  assert(clientSource.includes("MAX_BACKLOG_PAGES = 100")
    && clientSource.includes("MAX_BACKLOG_SYNC_ROUNDS = 3"), "BACKLOG_LOOP_GUARDS_REQUIRED");
  assert(clientSource.includes("seenCursors.has(page.nextCursor)")
    && clientSource.includes("unreadById.size === observedUnreadCount"), "CURSOR_PROGRESS_AND_COUNT_RECONCILIATION_REQUIRED");
  assert(clientSource.includes("itemsRef.current.filter((item) => !item.is_read)")
    && clientSource.includes("recent.filter((item) => item.is_read)"), "POLL_MUST_MERGE_UNREAD_WITH_RECENT_WINDOW");
  assert(clientSource.includes("loadAbortRef.current?.abort()")
    && clientSource.includes("requestRef.current += 1"), "READ_RECEIPT_MUST_INVALIDATE_STALE_POLL");
  assert(clientSource.includes("recent.find((item) => !item.is_read && !knownIdsRef.current.has(item.id))"), "ONLINE_TOAST_MUST_USE_RECENT_WINDOW");

  assert.equal(globalThis.__notificationBacklogDatabase.effects.updates, 0, "VERIFIER_MUST_NOT_WRITE_BUSINESS_DATA");
  console.log(JSON.stringify({
    verifier: "account-notification-backlog",
    passed: true,
    checks: {
      stableCreatedAtAndIdCursor: true,
      all123UnreadReachableWithoutDuplicates: true,
      unreadCountPreservedAcrossPages: true,
      oldReadRowsExcludedFromBacklogScan: true,
      invalidCursorAndLimitFailClosed: true,
      smallOnlineWindowAndLargeBacklogWindow: true,
      clientLoopAndRaceGuardsPresent: true,
    },
    pageCount,
    databaseWrites: 0,
    networkRequests: 0,
    productionWrites: 0,
  }, null, 2));
}

declare global {
  var __notificationBacklogDatabase: ReturnType<typeof paginationDatabase>;
}

void main();
