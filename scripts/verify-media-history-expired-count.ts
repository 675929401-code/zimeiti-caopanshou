import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type QueryCall = {
  method: "from" | "select" | "eq" | "or";
  args: unknown[];
};

type CountResult = {
  count: number;
  failed: boolean;
};

type ExpiredCountHook = {
  loadHiddenOrExpiredVideoCount: (db: unknown, userId: string) => Promise<CountResult>;
};

function countFixture(result: { count: number | null; error: unknown }) {
  const calls: QueryCall[] = [];
  const query = {
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return this;
    },
    select(columns: string, options: unknown) {
      calls.push({ method: "select", args: [columns, options] });
      return this;
    },
    eq(column: string, value: unknown) {
      calls.push({ method: "eq", args: [column, value] });
      return this;
    },
    or(filter: string) {
      calls.push({ method: "or", args: [filter] });
      return this;
    },
    then(resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return { db: query, calls };
}

async function verifyCountQuery(hook: ExpiredCountHook): Promise<void> {
  const fixture = countFixture({ count: 3, error: null });
  assert.deepEqual(
    await hook.loadHiddenOrExpiredVideoCount(fixture.db, "current-user"),
    { count: 3, failed: false },
  );
  assert.deepEqual(fixture.calls, [
    { method: "from", args: ["video_tasks"] },
    { method: "select", args: ["id", { count: "exact", head: true }] },
    { method: "eq", args: ["user_id", "current-user"] },
    { method: "or", args: ["source_expired_at.not.is.null,history_hidden_at.not.is.null"] },
    {
      method: "or",
      args: ["task_label.is.null,task_label.not.like.digital-human:%,and(task_label.in.(digital-human:photo,digital-human:video),or(client_request_id.like.digital-%,client_request_id.like.vav_%))"],
    },
  ]);

  const failedFixture = countFixture({ count: null, error: { code: "FIXTURE_FAILURE" } });
  assert.deepEqual(
    await hook.loadHiddenOrExpiredVideoCount(failedFixture.db, "current-user"),
    { count: 0, failed: true },
    "统计查询失败时必须显式标记失败，不能把零条当成准确统计",
  );
}

async function verifyRouteComposition(): Promise<void> {
  const route = await readFile(path.join(process.cwd(), "src/app/api/media-history/route.ts"), "utf8");
  assert.match(
    route,
    /loadVideoRows[\s\S]*?\.is\("history_hidden_at", null\)[\s\S]*?\.is\("source_expired_at", null\)/u,
    "可见列表仍必须在数据库层排除隐藏和已确认过期的视频",
  );
  assert.match(
    route,
    /videoExcludedPage\.count \+ retainedExpiredCount/u,
    "过期统计必须合并数据库排除计数与仍在可见枚举中判定过期的媒体",
  );
  assert.match(
    route,
    /expiredCount = sourceEnumerationFailed \|\| videoExcludedPage\.failed[\s\S]*?\? null/u,
    "任一统计来源失败时不得返回误导性的部分计数",
  );
  assert.match(
    route,
    /countFailures: snapshot\.countFailures/u,
    "统计失败必须独立暴露，不能污染可见列表分页结果",
  );
}

async function main(): Promise<void> {
  process.env.MEDIA_HISTORY_CACHE_TEST_HOOK = "1";
  await import("../src/app/api/media-history/route");
  const testGlobal = globalThis as typeof globalThis & {
    __MEDIA_HISTORY_CACHE_TEST_HOOK__?: ExpiredCountHook;
  };
  const hook = testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__;
  assert.ok(hook, "媒体历史统计测试 hook 未注册");
  try {
    await verifyCountQuery(hook);
    await verifyRouteComposition();
    console.log("media-history expired/hidden count verification passed: exact head count, user and media scope, visible-row exclusion, honest failure reporting, zero paid calls");
  } finally {
    delete testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__;
    delete process.env.MEDIA_HISTORY_CACHE_TEST_HOOK;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
