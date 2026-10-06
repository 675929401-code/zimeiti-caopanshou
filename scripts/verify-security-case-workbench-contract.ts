import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  SECURITY_CASE_AUTO_REFRESH_MS,
  SECURITY_CASE_READ_COOLDOWN_MS,
  SECURITY_CASE_WORKBENCH_PAGE_SIZE,
  isSecurityCaseDetailResponse,
  isSecurityCaseListResponse,
  nextSecurityCaseStatuses,
  retryAfterDeadlineMs,
  securityCaseActionStatusLabel,
} from "../src/lib/security-case-workbench-domain";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(resolve(root, relativePath), "utf8");

assert.deepEqual(nextSecurityCaseStatuses("open"), ["triaged", "false_positive"]);
assert.deepEqual(nextSecurityCaseStatuses("triaged"), []);
assert.deepEqual(nextSecurityCaseStatuses("assigned"), ["mitigating", "false_positive"]);
assert.deepEqual(nextSecurityCaseStatuses("mitigating"), ["monitoring", "false_positive"]);
assert.deepEqual(nextSecurityCaseStatuses("monitoring"), ["resolved", "false_positive"]);
assert.deepEqual(nextSecurityCaseStatuses("resolved"), []);
assert.equal(securityCaseActionStatusLabel("pending_executor"), "待执行 · 执行器未接入");
assert.equal(SECURITY_CASE_WORKBENCH_PAGE_SIZE, 20);
assert.equal(SECURITY_CASE_READ_COOLDOWN_MS, 15_000);
assert.equal(SECURITY_CASE_AUTO_REFRESH_MS, 30_000);

const now = Date.parse("2026-10-03T00:00:00.000Z");
assert.equal(retryAfterDeadlineMs("12", null, now), now + 12_000);
assert.equal(
  retryAfterDeadlineMs("12", "2026-10-03T00:01:00.000Z", now),
  now + 60_000,
);
assert.equal(retryAfterDeadlineMs(null, null, now), now + 15_000);

const caseRow = {
  id: "11111111-1111-4111-8111-111111111111",
  fingerprint: "fingerprint",
  title: "异常登录失败",
  summary: "连续失败登录",
  risk_level: "high",
  risk_score: 78,
  status: "triaged",
  assigned_to: null,
  revision: 2,
  event_count: 3,
  first_seen_at: "2026-10-03T00:00:00.000Z",
  last_seen_at: "2026-10-03T00:01:00.000Z",
  closed_at: null,
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:01:00.000Z",
};
const policy = { executorAvailable: false, destructiveExecutionEnabled: false };
const readMetadata = {
  asOf: "2026-10-03T00:01:00.000Z",
  freshnessSeconds: 0,
  nextRefreshAt: "2026-10-03T00:01:10.000Z",
  cacheStatus: "miss",
  rateLimit: { scope: "per_admin_query", backend: "process_memory", limit: 1, windowSeconds: 10, remaining: 0 },
};

assert.equal(isSecurityCaseListResponse({
  ok: true,
  cases: [caseRow],
  page: 1,
  pageSize: 20,
  total: 1,
  executionPolicy: policy,
  ...readMetadata,
}), true);
assert.equal(isSecurityCaseListResponse({
  ok: true,
  cases: [caseRow],
  page: 1,
  pageSize: 20,
  total: 1,
  executionPolicy: { executorAvailable: true, destructiveExecutionEnabled: true },
  ...readMetadata,
}), false, "workbench must reject a response that silently changes the phase-1 execution boundary");
assert.equal(isSecurityCaseDetailResponse({
  ok: true,
  case: caseRow,
  events: [],
  links: [],
  actions: [],
  audit: [],
  executionPolicy: policy,
  ...readMetadata,
}), true);

const component = read("src/components/admin/security-case-workbench.tsx");
const css = read("src/components/admin/security-case-workbench.module.css");
const listRoute = read("src/app/api/admin/security-events/cases/route.ts");
const detailRoute = read("src/app/api/admin/security-events/cases/[id]/route.ts");
const actionRoute = read("src/app/api/admin/security-events/cases/[id]/actions/route.ts");
const server = read("src/lib/server/security-case-control-plane.ts");
const readGovernor = read("src/lib/server/security-case-read-governor.ts");

for (const required of [
  "安全案件工作台",
  "案件队列",
  "证据时间线",
  "关联实体",
  "不可变审计时间线",
  "待执行处置队列",
  "执行器未接入",
  "不会自动停用账号",
  "不会撤销会话",
  "创建待执行请求",
  "影响预演 · 未保存 · 未执行",
]) {
  assert.ok(component.includes(required), `missing workbench boundary copy: ${required}`);
}

assert.match(component, /document\.hidden/);
assert.match(component, /navigator\.onLine/);
assert.match(component, /visibilitychange/);
assert.match(component, /listAbortRef\.current\?\.abort\(\)/);
assert.match(component, /detailAbortRef\.current\?\.abort\(\)/);
assert.match(component, /response\.status === 429/);
assert.match(component, /Retry-After/);
assert.match(component, /window\.setTimeout/);
assert.doesNotMatch(component, /window\.setInterval|setInterval\(/, "case workbench must not create a perpetual polling interval");
assert.match(component, /Authorization: `Bearer \$\{token\}`/);
assert.match(component, /credentials: "same-origin"/);
assert.match(component, /"Idempotency-Key": requestKey/);
assert.match(component, /operation: "claim"/);
assert.match(component, /operation: "transition"/);
assert.match(component, /operation: "link-entity"/);
assert.match(component, /operation: "preview"/);
assert.match(component, /operation: "request"/);
assert.match(component, /operation: "cancel"/);
assert.match(component, /boundary\.executed !== false/);
assert.match(component, /boundary\.status !== "pending_executor"/);
assert.match(component, /canManage &&/);
assert.match(component, /stepUpReady/);
assert.match(component, /onRequestUnlock/);

assert.match(listRoute, /authorizeAdminCapability\(request, "security\.view"/);
assert.match(detailRoute, /authorizeAdminCapability\(request, "security\.view"/);
for (const route of [listRoute, detailRoute, actionRoute]) {
  if (route.includes("security.manage")) assert.match(route, /requireStepUp: true/);
}
assert.match(listRoute, /authorizeAdminCapability\(request, "security\.manage"/);
assert.match(detailRoute, /authorizeAdminCapability\(request, "security\.manage"/);
assert.match(actionRoute, /authorizeAdminCapability\(request, "security\.manage"/);
assert.match(actionRoute, /executed: false/);
assert.match(actionRoute, /status: "pending_executor"/);
assert.match(actionRoute, /executorAvailable: false/);
assert.match(server, /executorAvailable: false/);
assert.match(server, /destructiveExecutionEnabled: false/);
for (const route of [listRoute, detailRoute]) {
  assert.match(route, /governedSecurityCaseRead/);
  assert.match(route, /SecurityCaseReadRateLimitError/);
  assert.match(route, /Retry-After|securityCaseRateLimitErrorHeaders/);
  assert.match(route, /nextRefreshAt/);
  assert.match(route, /status[^\n]*429|\}, 429/);
}
assert.match(readGovernor, /SECURITY_CASE_SERVER_READ_INTERVAL_MS = 10_000/);
assert.match(readGovernor, /SECURITY_CASE_SERVER_CACHE_TTL_MS = 8_000/);
assert.match(readGovernor, /const inFlight = new Map/);
assert.match(readGovernor, /cacheGeneration/);
assert.match(readGovernor, /generationAtStart === cacheGeneration/);
assert.match(readGovernor, /cacheStatus/);
assert.match(readGovernor, /freshnessSeconds/);
assert.match(readGovernor, /backend: "process_memory"/);
assert.match(readGovernor, /"Retry-After"/);
assert.match(readGovernor, /invalidateSecurityCaseReadCache/);
assert.match(listRoute, /invalidateSecurityCaseReadCache/);
assert.match(detailRoute, /invalidateSecurityCaseReadCache/);
assert.match(actionRoute, /invalidateSecurityCaseReadCache/);

const pixelFonts = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
assert.ok(pixelFonts.length > 0, "expected explicit visible font sizes");
assert.ok(pixelFonts.every((value) => value >= 12), `visible font below 12px: ${pixelFonts.filter((value) => value < 12).join(", ")}`);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(css, /grid-template-columns: minmax\(300px, 355px\) minmax\(0, 1fr\)/);

console.log(JSON.stringify({
  ok: true,
  contract: "security-case-workbench/v1",
  listPermission: "security.view",
  mutationPermission: "security.manage + step-up",
  executor: "unavailable",
  persistedActionState: "pending_executor",
  pageSize: SECURITY_CASE_WORKBENCH_PAGE_SIZE,
  readCooldownMs: SECURITY_CASE_READ_COOLDOWN_MS,
  autoRefreshMs: SECURITY_CASE_AUTO_REFRESH_MS,
  serverReadIntervalMs: 10_000,
  serverCacheTtlMs: 8_000,
  minimumVisibleFontPx: Math.min(...pixelFonts),
}, null, 2));
