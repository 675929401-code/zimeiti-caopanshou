import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { recoverPublishingPurchase, mutatePublishingCenter } from "../src/lib/server/publishing-service";
import { parsePendingPublishingPurchases, pendingPublishingPurchaseMap, withPublishingPurchaseLock } from "../src/features/publishing/native/pending-purchases";

type Row = Record<string, unknown>;
const A = { id: "00000000-0000-4000-8000-000000000001", email: "a@fixture.invalid", role: "student" };
const B = { ...A, id: "00000000-0000-4000-8000-000000000002" };
const planId = "00000000-0000-4000-8000-000000000003", purchaseId = "00000000-0000-4000-8000-000000000004", entitlementId = "00000000-0000-4000-8000-000000000005";
const key = "purchase:00000000-0000-4000-8000-000000000006";
const action = { action: "purchase" as const, planId, planVersion: 1, idempotencyKey: key };
const fingerprint = createHash("sha256").update(JSON.stringify(["purchase", planId, 1])).digest("hex");
function fixture({ absent = false, missingEntitlement = false, readError = false } = {}) {
  const purchase: Row = { id: purchaseId, user_id: A.id, plan_id: planId, plan_version: 1, plan_name: "旧版本发布套餐", price_cents: 1234, created_at: "2026-11-10T00:00:00Z", idempotency_key: key, payload_fingerprint: fingerprint };
  const entitlement: Row = { id: entitlementId, user_id: A.id, purchase_id: purchaseId, plan_id: planId, plan_version: 1, plan_name: "旧版本发布套餐", quota: 10, used: 2, expires_at: "2026-12-10T00:00:00Z", platforms: ["douyin"] };
  const queries: { table: string; filters: Row }[] = [];
  let rpcCalls = 0;
  const db = { from(table: string) {
    assert.ok(["pub_purchases", "pub_entitlements"].includes(table), "recovery must not depend on current plan or sales configuration");
    const filters: Row = {}; queries.push({ table, filters });
    const q = { select: () => q, eq: (field: string, value: unknown) => { filters[field] = value; return q; }, maybeSingle: async () => {
      if (readError) return { data: null, error: { code: "08006" } };
      const row = table === "pub_purchases" ? absent ? null : purchase : missingEntitlement ? null : entitlement;
      return { data: row && Object.entries(filters).every(([field, value]) => row[field] === value) ? row : null, error: null };
    } }; return q;
  }, rpc() { rpcCalls++; throw new Error("RECOVERY_MUST_NOT_PURCHASE_OR_MUTATE_WALLET"); } };
  return { db: db as never, queries, purchase, entitlement, rpcCalls: () => rpcCalls };
}
const options = { assertAccess: async () => {}, runtimeEnabled: () => false };
test("actual read recovery finds the original order and entitlement after plan/sales changes without any mutation", async () => {
  const f = fixture(); const result = await recoverPublishingPurchase(A, f.db, key, options);
  assert.equal(result.found, true); assert.equal(result.purchase?.id, purchaseId); assert.equal(result.entitlement?.used, 2); assert.equal(result.shouldPurchase, false);
  assert.equal(f.rpcCalls(), 0); assert.ok(f.queries.every(query => query.filters.user_id === A.id));
  assert.equal("payload_fingerprint" in result.purchase!, false);
});
test("actual same-key purchase replay precedes disabled runtime and never charges again", async () => {
  const f = fixture(); const result = await mutatePublishingCenter(A, f.db, action, options);
  assert.equal(result.alreadyFulfilled, true); assert.equal(result.purchase?.id, purchaseId); assert.equal(f.rpcCalls(), 0);
});
test("same key with a different version or tampered fingerprint conflicts without invoking the wallet", async () => {
  const f = fixture();
  await assert.rejects(mutatePublishingCenter(A, f.db, { ...action, planVersion: 2 }, options), error => (error as Row).code === "PUBLISH_IDEMPOTENCY_CONFLICT");
  f.purchase.payload_fingerprint = "0".repeat(64);
  await assert.rejects(mutatePublishingCenter(A, f.db, action, options), error => (error as Row).code === "PUBLISH_IDEMPOTENCY_CONFLICT");
  assert.equal(f.rpcCalls(), 0);
});
test("absent and foreign records are observation only; a new purchase still respects sales admission", async () => {
  const f = fixture({ absent: true }); assert.equal((await recoverPublishingPurchase(A, f.db, key, options)).found, false);
  await assert.rejects(mutatePublishingCenter(A, f.db, action, options), error => (error as Row).code === "PUBLISH_SALES_DISABLED");
  const foreign = fixture(); assert.equal((await recoverPublishingPurchase(B, foreign.db, key, options)).found, false); assert.equal(foreign.rpcCalls(), 0);
});
test("missing entitlement and failed authority/database reads never become no-order success", async () => {
  for (const f of [fixture({ missingEntitlement: true }), fixture({ readError: true })]) await assert.rejects(recoverPublishingPurchase(A, f.db, key, options));
  const f = fixture(); await assert.rejects(recoverPublishingPurchase(A, f.db, key, { assertAccess: async () => { throw new Error("ACCESS_REVOKED"); } }), /ACCESS_REVOKED/); assert.equal(f.queries.length, 0);
});
test("both GET recovery and POST replay reject an entitlement attached to a different plan", async () => {
  const f = fixture(); f.entitlement.plan_version = 2;
  const check = (error: unknown) => (error as Row).code === "PUBLISH_PURCHASE_RECONCILIATION_REQUIRED";
  await assert.rejects(recoverPublishingPurchase(A, f.db, key, options), check);
  await assert.rejects(mutatePublishingCenter(A, f.db, action, options), check);
  assert.equal(f.rpcCalls(), 0);
});
test("actual purchase lock rejects a simultaneous tab without queuing a second purchase", async () => {
  let locked = false, requests = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const locks = { async request(name: string, flags: LockOptions, callback: (lock: Lock | null) => Promise<unknown>) {
    assert.equal(name, `publishing.purchase.v1:${A.id}`); assert.equal(flags.ifAvailable, true);
    if (locked) return callback(null);
    locked = true; try { return await callback({ name } as Lock); } finally { locked = false; }
  } } as Pick<LockManager, "request">;
  const first = withPublishingPurchaseLock(A.id, async () => { requests++; await barrier; return "confirmed"; }, locks);
  await assert.rejects(withPublishingPurchaseLock(A.id, async () => { requests++; }, locks), /另一个页面正在处理/);
  release(); assert.equal(await first, "confirmed"); assert.equal(requests, 1);
  await assert.rejects(withPublishingPurchaseLock(A.id, async () => { requests++; }, null), /当前浏览器无法保护/); assert.equal(requests, 1);
});
test("legacy pending order survives plan removal and serialization; malformed/ambiguous records fail closed", () => {
  const pending = parsePendingPublishingPurchases(JSON.stringify({ [`${planId}:1`]: key }));
  assert.equal(pending[0].requestKey, key); assert.equal(pending[0].planVersion, 1);
  assert.deepEqual(pendingPublishingPurchaseMap(pending), { [`${planId}:1`]: key });
  for (const raw of ["{", "null", "[]", '{"bad":"other"}', JSON.stringify({ [`${planId}:1`]: key, [`${planId}:2`]: key })]) assert.throws(() => parsePendingPublishingPurchases(raw));
});
