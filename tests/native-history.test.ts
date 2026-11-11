import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { NativeHistoryQuerySchema, nativeHistoryMediaPath, projectNativeHistoryConsumption, projectNativeHistoryMedia } from "../src/lib/native-history-contract";
import { readNativeHistory } from "../src/lib/server/native-history-service";

const user = { id: "owned-fixture", email: "fixture@invalid.example", role: "student" };
const request = (search = "") => new NextRequest(`http://127.0.0.1:5000/api/native-operations/history/assets${search}`, { headers: { cookie: "auth_token=fixture-cookie", authorization: "must-not-forward" } });
test("media projection keeps only fixed private main-site handlers and does not confirm publish assets", () => {
  for (const input of ["https://elsewhere.invalid/a.png", "//elsewhere.invalid/api/media-history/content", "/api/native-operations/assets/123/content", "/api/media-history/content#hash", "/api/media-history/content\\x"]) assert.equal(nativeHistoryMediaPath(input), "");
  const row = { id: "record", title: "作品", kind: "image", status: "completed", previewPath: "/api/media-history/content?assetId=owned", createdAt: "2026-11-10" };
  const asset = projectNativeHistoryMedia(row, "assets");
  assert.ok("url" in asset); assert.equal(asset.url, row.previewPath); assert.equal(asset.nativePublishingReady, false);
  assert.equal(projectNativeHistoryMedia({ ...row, kind: "video", previewPath: "" }, "videos").status, "UNAVAILABLE");
});
test("consumption units remain distinct and invalid/missing amounts never become zero", () => {
  assert.equal(projectNativeHistoryConsumption({ id: "a", amount: "-2.5" }, "credits", user.id).points, 2.5);
  const cash = projectNativeHistoryConsumption({ id: "b", amount: "3.1", providerKey: "secret" }, "CNY", user.id);
  assert.equal(cash.points, null); assert.equal(cash.nativeBilling.amount, 3.1); assert.equal("providerKey" in cash, false);
  for (const amount of [undefined, null, "NaN", Infinity, "", "  ", "0x10", "1e3"]) assert.equal(projectNativeHistoryConsumption({ amount }, "credits", user.id).nativeBilling.amount, null);
});
test("history query rejects invalid calendar dates, repeated/unknown input and unbounded pages", () => {
  for (const value of [{ startDate: "2026-02-30" }, { startDate: "2026-11-10", endDate: "2026-11-09" }, { page: 101 }, { pageSize: 51 }, { ownerId: "other" }]) assert.equal(NativeHistoryQuerySchema.safeParse(value).success, false);
});
test("actual media history read forwards only Cookie to the fixed owning handler and preserves partial unknown counts", async () => {
  const result = await readNativeHistory(user, null as never, "assets", request("?page=2&pageSize=10"), { mediaHistory: async input => {
    assert.equal(input.nextUrl.pathname, "/api/media-history"); assert.equal(input.nextUrl.searchParams.get("offset"), "10");
    assert.equal(input.headers.get("cookie"), "auth_token=fixture-cookie"); assert.equal(input.headers.has("authorization"), false);
    return Response.json({ items: [], totalCount: null, sourceFailures: ["fixture"] });
  } });
  assert.equal(result.total, null); assert.equal(result.totalPages, null); assert.equal(result.nativeAvailability, "unknown");
});
test("media failure does not appear as successful zero history; bad queries never read the source", async () => {
  let reads = 0;
  const dependencies = { mediaHistory: async () => { reads++; return new Response(null, { status: 503 }); } };
  await assert.rejects(readNativeHistory(user, null as never, "assets", request(), dependencies), /主站记录暂时不可确认/);
  await assert.rejects(readNativeHistory(user, null as never, "assets", request("?page=1&page=2"), dependencies), /查询参数不能重复/);
  assert.equal(reads, 1);
});
test("actual consumption union filters each source by owner and paginates the merged order", async () => {
  const credit = [{ id: "3", amount: -3, created_at: "2026-11-10T03:00:00Z" }, { id: "1", amount: -1, created_at: "2026-11-10T01:00:00Z" }];
  const cash = [{ id: "2", amount: -2, created_at: "2026-11-10T02:00:00Z" }];
  const db = { from(table: string) {
    const rows = table === "credit_transactions" ? credit : cash;
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { if (key === "user_id") assert.equal(value, user.id); else { assert.equal(key, "type"); assert.equal(value, "consume"); } return query; },
      in: (key: string, value: unknown) => { assert.equal(key, "type"); assert.deepEqual(value, ["consume", "consumption"]); return query; },
      order: () => query,
      range: async (from: number, to: number) => { assert.equal(from, 0); assert.equal(to, 1); return { data: rows, count: rows.length, error: null }; },
    }; return query;
  } };
  const result = await readNativeHistory(user, db as never, "logs", request("?page=2&pageSize=1"));
  assert.equal(result.total, 3); assert.equal(result.list.length, 1); const item = result.list[0]; assert.ok("id" in item); assert.equal(item.id, "CNY:2");
});
test("actual consumption history enumerates bounded pages beyond PostgREST response caps", async () => {
  const windows: number[][] = [];
  const rows = Array.from({ length: 1200 }, (_, index) => ({ id: String(1200 - index).padStart(4, "0"), amount: -1, created_at: "2026-11-10T00:00:00Z" }));
  const db = { from(table: string) {
    const data = table === "credit_transactions" ? rows : [];
    const q = { select: () => q, eq: () => q, in: () => q, order: () => q, range: async (from: number, to: number) => { assert.ok(to - from < 500); if (data.length) windows.push([from, to]); return { data: data.slice(from, to + 1), count: data.length, error: null }; } };
    return q;
  } };
  const result = await readNativeHistory(user, db as never, "logs", request("?page=22&pageSize=50"));
  assert.equal(result.total, 1200); assert.equal(result.list.length, 50); assert.deepEqual(windows, [[0, 499], [500, 999], [1000, 1099]]);
});
