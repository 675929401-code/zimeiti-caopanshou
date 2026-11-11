import test from "node:test";
import assert from "node:assert/strict";
import { readPublishingAdmin } from "../src/lib/server/publishing-service";

function fixture(missing = "") {
  const counts: Record<string, number> = { pub_purchases: 2, pub_tasks: 3, pub2_attempts: 5, pub3_operations: 7, pub_accounts: 11, pub3_account_bindings: 13, pub4_account_bindings: 17 };
  const reads: { table: string; counted: boolean; filters: Record<string, unknown> }[] = [];
  const db = { from(table: string) {
    const entry = { table, counted: false, filters: {} as Record<string, unknown> }; reads.push(entry);
    const result = () => ({ data: [], count: counts[table] ?? null, error: table === missing ? { code: "42P01" } : null });
    const q = {
      select: (_columns: string, options?: { count?: string }) => { entry.counted = options?.count === "exact"; return q; },
      order: () => q, limit: () => q,
      eq: (key: string, value: unknown) => { entry.filters[key] = value; return q; },
      maybeSingle: async () => ({ data: { version: 1, execution_enabled: false, sales_enabled: false, enabled_platforms: ["xhs", "wxSph", "douyin"], announcement: "" }, error: null }),
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
    }; return q;
  } };
  return { db: db as never, reads };
}
test("actual administrator summary counts each execution generation once and excludes non-publish official operations", async () => {
  const f = fixture(); const result = await readPublishingAdmin(f.db, true);
  assert.equal(result.stats?.purchases, 2); assert.equal(result.stats?.tasks, 15); assert.equal(result.stats?.accounts, 41);
  assert.deepEqual(result.stats?.sources, { tasksV1: 3, tasksV2: 5, tasksOfficial: 7, accountsBrowser: 11, accountsDouyin: 13, accountsOAuth: 17 });
  assert.equal(f.reads.find(read => read.table === "pub3_operations")?.filters.kind, "publish");
});
test("without billing read permission no global task/account/purchase counts are queried", async () => {
  const f = fixture(); const result = await readPublishingAdmin(f.db, false);
  assert.equal(result.stats, null); assert.deepEqual(result.tasks, []); assert.equal(f.reads.some(read => read.counted), false);
});
test("missing native table refuses the incomplete summary instead of reporting zero", async () => {
  const f = fixture("pub3_operations");
  await assert.rejects(readPublishingAdmin(f.db, true), error => (error as { code?: string }).code === "PUBLISH_SCHEMA_NOT_READY");
});
