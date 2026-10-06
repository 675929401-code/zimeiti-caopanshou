import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  expectedAdminPermissionCatalogRows,
  summarizeAdminPermissionCatalogCoverage,
  type AdminPermissionCatalogDatabaseRow,
} from "../src/lib/admin-permission-catalog-coverage";

const canonicalRows = expectedAdminPermissionCatalogRows().map((row) => ({
  ...row,
  dependency_keys: [...row.dependency_keys],
}));
assert.equal(canonicalRows.length, 31);
assert.equal(new Set(canonicalRows.map((row) => row.permission_key)).size, 31);
assert.equal(new Set(canonicalRows.map((row) => row.sort_order)).size, 31);
assert.deepEqual(
  canonicalRows.find((row) => row.permission_key === "member_content.view"),
  {
    permission_key: "member_content.view",
    group_key: "member",
    label: "查看会员内容",
    description: "查看会员聊天、作品与其私有媒体；下载或导出仍需二次确认。",
    risk_level: "sensitive",
    step_up_required: false,
    sort_order: 25,
    is_active: true,
    is_delegable: true,
    dependency_keys: ["members.view"],
  },
);

const healthy = summarizeAdminPermissionCatalogCoverage(canonicalRows);
assert.equal(healthy.healthy, true);
assert.equal(healthy.codeCount, 31);
assert.equal(healthy.databaseCount, 31);
assert.equal(healthy.codeContractMismatchCount, 0);
assert.equal(healthy.contractMismatchCount, 0);

const fieldCases: Array<{
  column: keyof AdminPermissionCatalogDatabaseRow;
  value: unknown;
  summaryField: keyof typeof healthy.fieldMismatchCounts;
}> = [
  { column: "group_key", value: "wrong-group", summaryField: "groupKey" },
  { column: "label", value: "wrong-label", summaryField: "label" },
  { column: "description", value: "wrong-description", summaryField: "description" },
  { column: "risk_level", value: "normal", summaryField: "riskLevel" },
  { column: "step_up_required", value: false, summaryField: "stepUpRequired" },
  { column: "sort_order", value: 999, summaryField: "sortOrder" },
  { column: "is_delegable", value: true, summaryField: "delegable" },
  { column: "dependency_keys", value: ["members.view"], summaryField: "dependencies" },
];

for (const testCase of fieldCases) {
  const changed = canonicalRows.map((row, index) => index === 0
    ? { ...row, [testCase.column]: testCase.value }
    : row);
  const summary = summarizeAdminPermissionCatalogCoverage(changed);
  assert.equal(summary.healthy, false, `${String(testCase.column)} drift must fail health`);
  assert.equal(summary.contractMismatchCount, 1, `${String(testCase.column)} drift must count one row`);
  assert.equal(summary.fieldMismatchCounts[testCase.summaryField], 1, `${String(testCase.column)} drift must identify field`);
  assert.equal(JSON.stringify(summary).includes("admin.accounts.manage"), false, "health summary must not disclose permission keys");
  assert.equal(JSON.stringify(summary).includes("wrong-"), false, "health summary must not disclose stored values");
}

const missing = summarizeAdminPermissionCatalogCoverage(canonicalRows.slice(1));
assert.equal(missing.healthy, false);
assert.equal(missing.missingCount, 1);

const inactive = summarizeAdminPermissionCatalogCoverage([
  { ...canonicalRows[0], is_active: false },
  ...canonicalRows.slice(1),
]);
assert.equal(inactive.healthy, false);
assert.equal(inactive.inactiveCount, 1);
assert.equal(inactive.databaseCount, 30);

const unknown = summarizeAdminPermissionCatalogCoverage([
  ...canonicalRows,
  {
    ...canonicalRows[0],
    permission_key: "future.unknown",
    sort_order: 999,
  },
]);
assert.equal(unknown.healthy, false);
assert.equal(unknown.unknownCount, 1);
assert.equal(JSON.stringify(unknown).includes("future.unknown"), false);

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), "utf8");
const route = read("src/app/api/admin/access-control/route.ts");
assert.match(
  route,
  /\.select\("permission_key,group_key,label,description,risk_level,step_up_required,sort_order,is_active,is_delegable,dependency_keys"\)/u,
);
assert.match(route, /summarizeAdminPermissionCatalogCoverage\(databaseCatalog \|\| \[\]\)/u);
assert.doesNotMatch(route, /missingInDatabase|inactiveInDatabase|unknownInDatabase|contractMismatches/u);
assert.ok(
  route.indexOf("const authorization = await requireSuperAdmin(request)")
    < route.indexOf("const client = getSupabaseAdminClient()"),
  "super-admin authorization must precede catalog reads",
);

const selfRoute = read("src/app/api/admin/access-control/self/route.ts");
assert.match(selfRoute, /catalog: isSuperAdmin \? ADMIN_PERMISSION_CATALOG : grantedCatalog/u);

const panel = read("src/components/admin/super-admin-governance-panel.tsx");
assert.match(panel, /missingCount: number/u);
assert.match(panel, /contractMismatchCount: number/u);
assert.doesNotMatch(panel, /missingInDatabase|contractMismatches/u);

console.log("admin permission catalog coverage contract: ok");
