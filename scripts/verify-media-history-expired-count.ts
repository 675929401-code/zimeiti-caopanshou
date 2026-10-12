import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

type QueryCall = {
  method: "from" | "select" | "eq" | "not" | "or";
  args: unknown[];
};

type CountResult = {
  count: number;
  failed: boolean;
};

type ExpiredCountHook = {
  loadExpiredVideoCount: (db: unknown, userId: string) => Promise<CountResult>;
};

type VideoRow = {
  user_id: string;
  source_expired_at: string | null;
  history_hidden_at: string | null;
  task_label: string | null;
  client_request_id: string | null;
};

function splitFilters(filter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < filter.length; index += 1) {
    if (filter[index] === "(") depth += 1;
    else if (filter[index] === ")") depth -= 1;
    else if (filter[index] === "," && depth === 0) {
      parts.push(filter.slice(start, index));
      start = index + 1;
    }
  }
  assert.equal(depth, 0, "fixture filter must have balanced parentheses");
  return [...parts, filter.slice(start)];
}

function matchesFilter(row: VideoRow, filter: string): boolean {
  if (filter.startsWith("and(") || filter.startsWith("or(")) {
    assert.ok(filter.endsWith(")"), "fixture compound filter must close");
    const conjunction = filter.startsWith("and(");
    const terms = splitFilters(filter.slice(conjunction ? 4 : 3, -1));
    return conjunction
      ? terms.every(term => matchesFilter(row, term))
      : terms.some(term => matchesFilter(row, term));
  }
  const condition = /^([a-z_]+)\.(not\.)?(is|like|in)\.(.+)$/u.exec(filter);
  assert.ok(condition, `unsupported fixture filter: ${filter}`);
  const [, column, negate, operator, expected] = condition;
  assert.ok(column in row, `unknown fixture column: ${column}`);
  const value = row[column as keyof VideoRow];
  let matches: boolean;
  if (operator === "is") {
    assert.equal(expected, "null");
    matches = value === null;
  } else if (operator === "in") {
    assert.ok(expected.startsWith("(") && expected.endsWith(")"));
    matches = value !== null && splitFilters(expected.slice(1, -1)).includes(value);
  } else {
    const pattern = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll("%", ".*").replaceAll("_", ".");
    matches = value !== null && new RegExp(`^${pattern}$`, "u").test(value);
  }
  // SQL negated predicates also exclude NULL; the explicit is.null term handles it.
  return negate ? value !== null && !matches : matches;
}

function countFixture(rows: VideoRow[], override?: { count: number | null; error: unknown }) {
  const calls: QueryCall[] = [];
  const predicates: Array<(row: VideoRow) => boolean> = [];
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
      assert.ok(rows.length === 0 || column in rows[0], `unknown fixture column: ${column}`);
      predicates.push(row => row[column as keyof VideoRow] === value);
      return this;
    },
    not(column: string, operator: string, value: unknown) {
      calls.push({ method: "not", args: [column, operator, value] });
      assert.equal(operator, "is");
      assert.equal(value, null);
      predicates.push(row => row[column as keyof VideoRow] !== null);
      return this;
    },
    or(filter: string) {
      calls.push({ method: "or", args: [filter] });
      const terms = splitFilters(filter);
      predicates.push(row => terms.some(term => matchesFilter(row, term)));
      return this;
    },
    then(resolve: (value: { count: number | null; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) {
      const result = override ?? { count: rows.filter(row => predicates.every(predicate => predicate(row))).length, error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return { db: query, calls };
}

async function verifyCountQuery(hook: ExpiredCountHook): Promise<void> {
  const active: VideoRow = { user_id: "current-user", source_expired_at: null, history_hidden_at: null, task_label: "普通视频", client_request_id: "video-active" };
  const confirmedExpiry = "2026-10-12T01:00:00.000Z";
  const cases: Array<{ name: string; row: VideoRow; count: number }> = [
    { name: "active", row: active, count: 0 },
    { name: "hidden-only", row: { ...active, history_hidden_at: confirmedExpiry }, count: 0 },
    { name: "expired-only", row: { ...active, source_expired_at: confirmedExpiry }, count: 1 },
    { name: "hidden-and-expired", row: { ...active, source_expired_at: confirmedExpiry, history_hidden_at: confirmedExpiry }, count: 1 },
    { name: "other-user", row: { ...active, user_id: "other-user", source_expired_at: confirmedExpiry }, count: 0 },
    { name: "unlabelled-video", row: { ...active, source_expired_at: confirmedExpiry, task_label: null }, count: 1 },
    { name: "retired-digital-human", row: { ...active, source_expired_at: confirmedExpiry, task_label: "digital-human:retired", client_request_id: "digital-old" }, count: 0 },
    { name: "current-digital-photo", row: { ...active, source_expired_at: confirmedExpiry, task_label: "digital-human:photo", client_request_id: "digital-photo" }, count: 1 },
    { name: "current-digital-video", row: { ...active, source_expired_at: confirmedExpiry, task_label: "digital-human:video", client_request_id: "vav_current" }, count: 1 },
    { name: "digital-human-without-current-request", row: { ...active, source_expired_at: confirmedExpiry, task_label: "digital-human:photo", client_request_id: "legacy-request" }, count: 0 },
  ];
  for (const testCase of cases) {
    const fixture = countFixture([testCase.row]);
    assert.deepEqual(await hook.loadExpiredVideoCount(fixture.db, "current-user"), { count: testCase.count, failed: false }, testCase.name);
  }
  const fixture = countFixture(cases.map(testCase => testCase.row));
  assert.deepEqual(
    await hook.loadExpiredVideoCount(fixture.db, "current-user"),
    { count: cases.reduce((count, testCase) => count + testCase.count, 0), failed: false },
  );
  assert.deepEqual(fixture.calls, [
    { method: "from", args: ["video_tasks"] },
    { method: "select", args: ["id", { count: "exact", head: true }] },
    { method: "eq", args: ["user_id", "current-user"] },
    { method: "not", args: ["source_expired_at", "is", null] },
    {
      method: "or",
      args: ["task_label.is.null,task_label.not.like.digital-human:%,and(task_label.in.(digital-human:photo,digital-human:video),or(client_request_id.like.digital-%,client_request_id.like.vav_%))"],
    },
  ]);

  for (const partialCount of [null, 3]) {
    const failedFixture = countFixture([], { count: partialCount, error: { code: "FIXTURE_FAILURE" } });
    assert.deepEqual(await hook.loadExpiredVideoCount(failedFixture.db, "current-user"), { count: 0, failed: true },
      "统计查询失败时必须显式标记失败，不能把零条或部分计数当成准确统计");
  }
  const nullFixture = countFixture([], { count: null, error: null });
  assert.deepEqual(await hook.loadExpiredVideoCount(nullFixture.db, "current-user"), { count: 0, failed: false });
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
    "过期统计必须合并数据库确认过期计数与仍在可见枚举中判定过期的媒体",
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
    console.log("media-history confirmed-expiry count verification passed: active/hidden/expired/both/user isolation, digital-human scope, exact head count, honest partial/null/error reporting, zero paid calls");
  } finally {
    delete testGlobal.__MEDIA_HISTORY_CACHE_TEST_HOOK__;
    delete process.env.MEDIA_HISTORY_CACHE_TEST_HOOK;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
