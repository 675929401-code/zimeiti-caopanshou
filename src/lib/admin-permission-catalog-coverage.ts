import { ADMIN_PERMISSION_CATALOG } from "@/lib/admin-governance";
import {
  ADMIN_PERMISSION_DEPENDENCIES,
  ownerOnlyAdminPermissionKeys,
} from "@/lib/admin-permission-design";

export interface AdminPermissionCatalogDatabaseRow {
  permission_key?: unknown;
  group_key?: unknown;
  label?: unknown;
  description?: unknown;
  risk_level?: unknown;
  step_up_required?: unknown;
  sort_order?: unknown;
  is_active?: unknown;
  is_delegable?: unknown;
  dependency_keys?: unknown;
}

export interface AdminPermissionCatalogCoverageSummary {
  healthy: boolean;
  codeCount: number;
  databaseCount: number;
  missingCount: number;
  inactiveCount: number;
  unknownCount: number;
  contractMismatchCount: number;
  codeContractMismatchCount: number;
  fieldMismatchCounts: {
    groupKey: number;
    label: number;
    description: number;
    riskLevel: number;
    stepUpRequired: number;
    sortOrder: number;
    delegable: number;
    dependencies: number;
  };
}

const ADMIN_PERMISSION_GROUP_KEYS: Readonly<Record<string, string>> = {
  "超级管理": "super",
  "会员与经营": "member",
  "资金与对账": "billing",
  "智能体与模型": "content",
  "平台与界面": "platform",
  "安全与运维": "security",
};

const ADMIN_PERMISSION_SORT_ORDER_CONTRACT = [
  ["admin.accounts.manage", 10],
  ["members.view", 20],
  ["member_content.view", 25],
  ["members.manage", 30],
  ["members.delete", 40],
  ["member_permissions.manage", 50],
  ["invitations.manage", 60],
  ["packages.manage", 70],
  ["cards.manage", 80],
  ["billing.view", 90],
  ["wallet.adjust", 100],
  ["billing.export", 110],
  ["agents.view", 120],
  ["agents.manage", 130],
  ["prompts.view", 140],
  ["prompts.edit", 150],
  ["internal_tools.manage", 160],
  ["models.view", 170],
  ["models.manage", 180],
  ["platform.settings.manage", 190],
  ["brand.settings.manage", 191],
  ["integrations.manage", 192],
  ["payment.settings.manage", 193],
  ["white_label.manage", 194],
  ["announcements.manage", 200],
  ["security.view", 210],
  ["security.manage", 220],
  ["logs.view", 230],
  ["logs.export", 240],
  ["backups.manage", 250],
  ["deployment.execute", 260],
] as const;

const sortOrderByKey = new Map<string, number>(
  ADMIN_PERMISSION_SORT_ORDER_CONTRACT,
);

export function expectedAdminPermissionCatalogRows() {
  return ADMIN_PERMISSION_CATALOG.map((permission) => {
    return {
      permission_key: permission.key,
      group_key: ADMIN_PERMISSION_GROUP_KEYS[permission.group] ?? "",
      label: permission.label,
      description: permission.description,
      risk_level: permission.risk,
      step_up_required: permission.stepUpRequired,
      sort_order: sortOrderByKey.get(permission.key) ?? Number.NaN,
      is_active: true,
      is_delegable: ownerOnlyAdminPermissionKeys([permission.key]).length === 0,
      dependency_keys: [...(ADMIN_PERMISSION_DEPENDENCIES[permission.key] || [])],
    };
  });
}

function dependencyKeysMatch(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual) || actual.some((item) => typeof item !== "string")) return false;
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function codeContractMismatchCount(): number {
  const catalogKeys = new Set(ADMIN_PERMISSION_CATALOG.map((permission) => permission.key));
  const storageKeys = ADMIN_PERMISSION_SORT_ORDER_CONTRACT.map(([permissionKey]) => permissionKey);
  const uniqueStorageKeys = new Set(storageKeys);
  const uniqueSortOrders = new Set(ADMIN_PERMISSION_SORT_ORDER_CONTRACT.map(([, sortOrder]) => sortOrder));
  return ADMIN_PERMISSION_CATALOG.filter((permission) => !sortOrderByKey.has(permission.key)).length
    + ADMIN_PERMISSION_CATALOG.filter((permission) => !ADMIN_PERMISSION_GROUP_KEYS[permission.group]).length
    + storageKeys.filter((permissionKey) => !catalogKeys.has(permissionKey)).length
    + (storageKeys.length - uniqueStorageKeys.size)
    + (ADMIN_PERMISSION_SORT_ORDER_CONTRACT.length - uniqueSortOrders.size);
}

export function summarizeAdminPermissionCatalogCoverage(
  databaseRows: readonly AdminPermissionCatalogDatabaseRow[],
): AdminPermissionCatalogCoverageSummary {
  const expectedRows = expectedAdminPermissionCatalogRows();
  const expectedByKey = new Map(expectedRows.map((row) => [row.permission_key, row]));
  const databaseByKey = new Map(
    databaseRows
      .filter((row) => typeof row.permission_key === "string")
      .map((row) => [row.permission_key as string, row]),
  );
  const fieldMismatchCounts = {
    groupKey: 0,
    label: 0,
    description: 0,
    riskLevel: 0,
    stepUpRequired: 0,
    sortOrder: 0,
    delegable: 0,
    dependencies: 0,
  };
  const mismatchedKeys = new Set<string>();

  for (const row of databaseRows) {
    const permissionKey = typeof row.permission_key === "string" ? row.permission_key : "";
    const expected = expectedByKey.get(permissionKey);
    if (!expected) continue;
    const mismatches = {
      groupKey: row.group_key !== expected.group_key,
      label: row.label !== expected.label,
      description: row.description !== expected.description,
      riskLevel: row.risk_level !== expected.risk_level,
      stepUpRequired: row.step_up_required !== expected.step_up_required,
      sortOrder: row.sort_order !== expected.sort_order,
      delegable: row.is_delegable !== expected.is_delegable,
      dependencies: !dependencyKeysMatch(row.dependency_keys, expected.dependency_keys),
    };
    for (const [field, mismatched] of Object.entries(mismatches)) {
      if (!mismatched) continue;
      fieldMismatchCounts[field as keyof typeof fieldMismatchCounts] += 1;
      mismatchedKeys.add(permissionKey);
    }
  }

  const missingCount = expectedRows.filter((row) => !databaseByKey.has(row.permission_key)).length;
  const inactiveCount = databaseRows.filter((row) => row.is_active !== true).length;
  const unknownCount = databaseRows.filter(
    (row) => typeof row.permission_key !== "string" || !expectedByKey.has(row.permission_key),
  ).length;
  const currentCodeContractMismatchCount = codeContractMismatchCount();
  const contractMismatchCount = mismatchedKeys.size;

  return {
    healthy: missingCount === 0
      && inactiveCount === 0
      && unknownCount === 0
      && contractMismatchCount === 0
      && currentCodeContractMismatchCount === 0,
    codeCount: expectedRows.length,
    databaseCount: databaseRows.filter((row) => row.is_active === true).length,
    missingCount,
    inactiveCount,
    unknownCount,
    contractMismatchCount,
    codeContractMismatchCount: currentCodeContractMismatchCount,
    fieldMismatchCounts,
  };
}
