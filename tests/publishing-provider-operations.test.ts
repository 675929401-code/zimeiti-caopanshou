import assert from "node:assert/strict";
import test from "node:test";
import { PublishingProvider, publishingProviderWorkScopeKey, type PublishingProviderScope } from "../src/lib/server/publishing-provider";

const accountId = "account-1", platform = "youtube", workId = "work-1", at = "2026-11-10T00:00:00Z";
const scope = (): PublishingProviderScope => ({ ownerId: "owner", accountIds: new Set([accountId]), flowIds: new Set(), recordIds: new Set(), taskIds: new Set(), authSessionIds: new Set(), workRefs: new Set([publishingProviderWorkScopeKey(accountId, platform, workId)]) });
const reply = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
const make = (fetcher: typeof fetch, owned = scope()) => new PublishingProvider({ environment: "domestic", apiKey: "synthetic-fixture", scope: owned, fetch: fetcher });
const originalFetch = globalThis.fetch;
let escaped = 0;
test.before(() => { globalThis.fetch = async () => { escaped++; throw new Error("EXTERNAL_NETWORK_FORBIDDEN"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(escaped, 0); });

test("operational reads reject foreign accounts, foreign work proofs and malformed paths before HTTP", async () => {
  let calls = 0;
  const client = make(async () => { calls++; return reply({}); });
  await assert.rejects(client.readAccountAnalytics("foreign"), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(client.readAccountWorks(platform, "foreign"), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(client.readWorkDetail(platform, accountId, "foreign"), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(client.readWorkAnalytics("twitter", accountId, workId), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(client.readWorkComments(platform, "foreign", workId), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(client.readWorkComments(platform, accountId, ".."), { code: "PROVIDER_INPUT_INVALID" });
  await assert.rejects(client.readAccountWorks("../accounts", accountId), { code: "PROVIDER_INPUT_INVALID" });
  assert.equal(calls, 0);
});

test("account metrics are bounded GET projections with no remote private metadata", async () => {
  const client = make(async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v2/channels/accounts/account-1/analytics");
    assert.equal(url.searchParams.get("since"), at);
    assert.equal(url.searchParams.get("until"), at);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return reply({ platform, accountId, profile: { displayName: "作者", loginCookie: "discard" }, metrics: { fansCount: 32, token: "discard" }, snapshots: [{ snapshotAt: at, fetchedAt: at, metrics: { fansCount: 32 }, extra: { secret: "discard" } }], extra: { secret: "discard" } });
  });
  assert.deepEqual(await client.readAccountAnalytics(accountId, { since: at, until: at }), { platform, accountId, profile: { displayName: "作者" }, metrics: { fansCount: 32 }, snapshots: [{ snapshotAt: at, fetchedAt: at, metrics: { fansCount: 32 } }] });
});

test("work list uses original bracket pagination and rejects changed response identity", async () => {
  const client = make(async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.pathname, "/api/v2/channels/works/youtube");
    assert.equal(url.searchParams.get("accountId"), accountId); assert.equal(url.searchParams.get("pagination[cursor]"), "opaque+/=&next"); assert.equal(url.searchParams.get("pagination[limit]"), "20");
    assert.equal(init?.body, undefined);
    return reply({ platform, items: [{ platformWorkId: workId, contentMode: "video", title: "作品", loginCookie: "discard" }], pagination: { mode: "cursor", nextCursor: "opaque-next", limit: 20, hasNext: true, hasPrevious: false }, tenantTotal: 900 });
  });
  const result = await client.readAccountWorks(platform, accountId, { cursor: "opaque+/=&next", limit: 20 });
  assert.equal(result.items.length, 1); assert.ok(!("tenantTotal" in result)); assert.ok(!("loginCookie" in result.items[0]));
  await assert.rejects(make(async () => reply({ platform: "twitter", items: [], pagination: { mode: "none" } })).readAccountWorks(platform, accountId), { code: "PROVIDER_PROTOCOL_ERROR" });
  await assert.rejects(make(async () => reply({ platform, items: [{ platformWorkId: workId, contentMode: "video" }, { platformWorkId: workId, contentMode: "video" }], pagination: { mode: "none" } })).readAccountWorks(platform, accountId), { code: "PROVIDER_PROTOCOL_ERROR" });
});

test("work detail and metrics require exact account/platform/work tuple and validate every snapshot", async () => {
  const paths: string[] = [];
  const client = make(async input => {
    const url = new URL(String(input)); paths.push(url.pathname); assert.equal(url.searchParams.get("accountId"), accountId);
    return reply({ platform, platformWorkId: workId, accountId, work: { id: workId, title: "作品" }, metrics: { viewCount: 15 }, snapshots: [{ snapshotAt: at, fetchedAt: at, platformWorkId: workId, work: { id: workId } }] });
  });
  assert.equal((await client.readWorkDetail(platform, accountId, workId)).work?.id, workId);
  assert.equal((await client.readWorkAnalytics(platform, accountId, workId)).metrics?.viewCount, 15);
  assert.deepEqual(paths, ["/api/v2/channels/works/youtube/work-1", "/api/v2/channels/works/youtube/work-1/analytics"]);
  const foreign = make(async () => reply({ platform, platformWorkId: workId, accountId, work: { id: workId }, snapshots: [{ snapshotAt: at, fetchedAt: at, work: { id: "foreign" } }] }));
  await assert.rejects(foreign.readWorkDetail(platform, accountId, workId), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(foreign.readWorkAnalytics(platform, accountId, workId), { code: "PROVIDER_SCOPE_DENIED" });
  await assert.rejects(make(async () => reply({ platform, platformWorkId: workId, accountId: "foreign" })).readWorkAnalytics(platform, accountId, workId), { code: "PROVIDER_SCOPE_DENIED" });
});

test("comments are read-only, scoped to proven work and discard upstream extras", async () => {
  let calls = 0;
  const client = make(async (input, init) => {
    calls++; const url = new URL(String(input)); assert.equal(url.pathname, "/api/v2/channels/engagement/comments");
    assert.equal(url.searchParams.get("platform"), platform); assert.equal(url.searchParams.get("platformWorkId"), workId); assert.equal(url.searchParams.get("accountId"), accountId); assert.equal(url.searchParams.get("pagination[page]"), "2");
    assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined);
    return reply({ platform, items: [{ platformCommentId: "comment-1", platformWorkId: workId, parentCommentId: "parent-1", content: "测试评论", raw: "discard" }], pagination: { mode: "page", page: 2, pageSize: 10, hasNext: false, hasPrevious: true }, private: "discard" });
  });
  const result = await client.readWorkComments(platform, accountId, workId, { page: 2, pageSize: 10 });
  assert.equal(calls, 1); assert.equal(result.items[0].parentCommentId, "parent-1"); assert.ok(!("raw" in result.items[0])); assert.ok(!("private" in result));
  await assert.rejects(make(async () => reply({ platform, items: [{ platformCommentId: "comment-1", platformWorkId: "foreign", content: "other" }], pagination: { mode: "none" } })).readWorkComments(platform, accountId, workId), { code: "PROVIDER_SCOPE_DENIED" });
});

test("invalid ranges, unbounded pagination and unknown query keys never leave the adapter", async () => {
  let calls = 0; const client = make(async () => { calls++; return reply({}); });
  await assert.rejects(client.readAccountAnalytics(accountId, { since: at, until: "2020-01-01T00:00:00Z" }), { code: "PROVIDER_INPUT_INVALID" });
  for (const pagination of [{ page: 1, pageSize: 101 }, { page: 1, pageSize: 10, cursor: "mixed" }, { cursor: "\n" }, { arbitrary: "injected" }]) {
    await assert.rejects(client.readAccountWorks(platform, accountId, pagination as never), { code: "PROVIDER_INPUT_INVALID" });
  }
  assert.equal(calls, 0);
});

test("malformed and unavailable operational GETs fail without retry or remote error disclosure", async () => {
  for (const response of [new Response("credential-bearing upstream error", { status: 503 }), new Response("invalid json"), new Response("{}", { headers: { "Content-Length": "3000000" } })]) {
    let calls = 0; const client = make(async () => { calls++; return response; });
    await assert.rejects(client.readAccountAnalytics(accountId), error => ["PROVIDER_UNAVAILABLE", "PROVIDER_PROTOCOL_ERROR"].includes((error as { code: string }).code) && !String(error).includes("credential-bearing"));
    assert.equal(calls, 1);
  }
});
