import { CREATION_CAPABILITIES } from "@/lib/creation-center-catalog";
import { PRIMARY_NAVIGATION } from "@/lib/marketplace-navigation";

export const PROJECT_REGISTRY_SCHEMA_VERSION = 1 as const;
export const ROOT_PROJECT_KEY = "zimeiti-caopanshou" as const;

const STABLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;

export type ProjectLifecycleStatus = "active" | "paused" | "retired";
export type ProjectRegistrationStatus = "registered" | "partial" | "unavailable";
export type ProjectTenantSupport = "unknown" | "unsupported" | "single_tenant" | "multi_tenant";
export type ProjectMessageSurface = "modal" | "toast" | "banner" | "inbox" | "email";
export type ProjectSourceKind = "task" | "billing" | "notification";
export type ProjectSourceMappingStatus = "mapped" | "unregistered" | "unavailable";
export type ProjectRegistryAvailability = "available" | "partial" | "unavailable";

export interface ProjectRegistryRecord {
  projectKey: string;
  parentProjectKey: string | null;
  displayName: string;
  internalName: string;
  primaryRoute: string | null;
  responsibleOwner: string | null;
  lifecycleStatus: ProjectLifecycleStatus;
  registrationStatus: ProjectRegistrationStatus;
  acceptsNewBusiness: boolean;
  slaProfile: Record<string, unknown>;
  tenantSupport: ProjectTenantSupport;
  allowedMessageSurfaces: ProjectMessageSurface[];
  sourceEvidence: Array<Record<string, unknown>>;
  sortOrder: number;
  revision: number;
  updatedAt: string | null;
}

export interface ProjectWorkspaceRecord {
  workspaceKey: string;
  projectKey: string;
  displayName: string;
  route: string;
  sourceCatalog: string;
  sourceEvidence: Array<Record<string, unknown>>;
  sortOrder: number;
  updatedAt: string | null;
}

export interface ProjectSourceRecord {
  sourceKind: ProjectSourceKind;
  sourceKey: string;
  projectKey: string | null;
  mappingStatus: ProjectSourceMappingStatus;
  projectKeyField: string | null;
  evidencePath: string;
  reasonCode: string;
  updatedAt: string | null;
}

export interface ProjectRegistryIssue {
  code: string;
  severity: "warning" | "error";
  subject: string;
  message: string;
}

export interface ProjectRegistryConsistency {
  status: ProjectRegistryAvailability;
  workspaceCoverage: {
    expected: number;
    mapped: number;
    unavailable: number;
  };
  sourceCoverage: {
    expected: number;
    mapped: number;
    unregistered: number;
    unavailable: number;
  };
  catalogCoverage: {
    expected: number;
    mapped: number;
    unavailable: number;
  };
  issues: ProjectRegistryIssue[];
}

export const PROJECT_DEFINITIONS = Object.freeze([
  {
    projectKey: ROOT_PROJECT_KEY,
    parentProjectKey: null,
    displayName: "自媒体操盘手",
    internalName: ROOT_PROJECT_KEY,
    primaryRoute: null,
    source: "deploy/policies/release-policy.json#projectId",
    sortOrder: 0,
  },
  ...PRIMARY_NAVIGATION.map((item, index) => ({
    projectKey: item.key,
    parentProjectKey: ROOT_PROJECT_KEY,
    displayName: item.label,
    internalName: item.key,
    primaryRoute: item.route,
    source: "src/lib/marketplace-navigation.ts#PRIMARY_NAVIGATION",
    sortOrder: index + 10,
  })),
] as const);

export const PROJECT_WORKSPACE_FACTS = Object.freeze(PRIMARY_NAVIGATION.map((item, index) => ({
  workspaceKey: item.key,
  projectKey: item.key,
  displayName: item.label,
  route: item.route,
  sourceCatalog: "PRIMARY_NAVIGATION",
  evidencePath: "src/lib/marketplace-navigation.ts",
  sortOrder: index + 10,
})));

/**
 * These aliases are backed by actual redirect pages. Keeping them explicit
 * prevents a route-prefix guess from silently assigning a capability to the
 * wrong product line.
 */
export const PROJECT_ROUTE_ALIAS_FACTS = Object.freeze([
  {
    route: "/short-drama",
    workspaceKey: "toolbox",
    evidencePath: "src/app/short-drama/page.tsx",
  },
  {
    route: "/voice-studio",
    workspaceKey: "voice",
    evidencePath: "src/app/voice-studio/page.tsx",
  },
] as const);

/**
 * Current source containers do not have a canonical project_key column. They
 * must remain unregistered until a forward migration and every writer adopt
 * the key; table names or notification types alone are not enough evidence to
 * infer a product line for historical rows.
 */
export const PROJECT_SOURCE_FACTS = Object.freeze([
  { sourceKind: "task", sourceKey: "llm_request_attempts", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "task", sourceKey: "image_generation_requests", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "task", sourceKey: "video_tasks", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "task", sourceKey: "voice_generation_requests", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "task", sourceKey: "extraction_attempts", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "billing", sourceKey: "revenue_records", evidencePath: "src/lib/server/admin-command-center.ts" },
  { sourceKind: "billing", sourceKey: "credit_transactions", evidencePath: "src/lib/billing-source-catalog.ts" },
  { sourceKind: "billing", sourceKey: "cash_transactions", evidencePath: "src/lib/billing.ts" },
  { sourceKind: "notification", sourceKey: "user_notifications", evidencePath: "src/lib/user-notification-server.ts" },
  { sourceKind: "notification", sourceKey: "announcements", evidencePath: "src/lib/announcement-delivery-server.ts" },
] as const satisfies ReadonlyArray<{
  sourceKind: ProjectSourceKind;
  sourceKey: string;
  evidencePath: string;
}>);

export const CREATION_CATALOG_ROUTE_FACTS = Object.freeze(CREATION_CAPABILITIES.map((item) => ({
  catalogId: item.id,
  route: item.href,
})));

export function isStableProjectKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 64
    && STABLE_KEY_PATTERN.test(value);
}

export function requireStableProjectKey(value: unknown): string {
  if (!isStableProjectKey(value)) throw new Error("PROJECT_KEY_INVALID");
  return value;
}

function normalizeRoute(value: unknown): string {
  if (typeof value !== "string") return "";
  const route = value.split(/[?#]/u, 1)[0].trim();
  if (!route.startsWith("/")) return "";
  return route.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
}

export function workspaceKeyForRoute(value: unknown): string | null {
  const route = normalizeRoute(value);
  if (!route) return null;
  const alias = PROJECT_ROUTE_ALIAS_FACTS.find((item) => item.route === route);
  if (alias) return alias.workspaceKey;
  const ordered = [...PROJECT_WORKSPACE_FACTS].sort((left, right) => right.route.length - left.route.length);
  const match = ordered.find((item) => item.route === route || (item.route !== "/" && route.startsWith(`${item.route}/`)));
  return match?.workspaceKey || null;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    groups.set(value, [...(groups.get(value) || []), item]);
  }
  return groups;
}

export function inspectProjectRegistryConsistency(input: {
  projects: readonly ProjectRegistryRecord[];
  workspaces: readonly ProjectWorkspaceRecord[];
  sources: readonly ProjectSourceRecord[];
}): ProjectRegistryConsistency {
  const issues: ProjectRegistryIssue[] = [];
  const projectsByKey = groupBy(input.projects, (item) => item.projectKey);
  const workspacesByKey = groupBy(input.workspaces, (item) => item.workspaceKey);
  const sourcesByKey = groupBy(input.sources, (item) => `${item.sourceKind}:${item.sourceKey}`);

  for (const project of input.projects) {
    if (!isStableProjectKey(project.projectKey)) {
      issues.push({
        code: "PROJECT_KEY_INVALID",
        severity: "error",
        subject: project.projectKey || "(empty)",
        message: "注册表包含不符合稳定 key 合同的项目。",
      });
    }
  }

  for (const expected of PROJECT_DEFINITIONS) {
    const matches = projectsByKey.get(expected.projectKey) || [];
    if (matches.length === 0) {
      issues.push({
        code: "PROJECT_UNREGISTERED",
        severity: "error",
        subject: expected.projectKey,
        message: "源码事实中的项目尚未进入项目注册表。",
      });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        code: "PROJECT_DUPLICATED",
        severity: "error",
        subject: expected.projectKey,
        message: "同一稳定 project_key 出现多条记录。",
      });
    }
  }

  let mappedWorkspaces = 0;
  for (const expected of PROJECT_WORKSPACE_FACTS) {
    const matches = workspacesByKey.get(expected.workspaceKey) || [];
    if (matches.length !== 1) {
      issues.push({
        code: matches.length === 0 ? "WORKSPACE_UNREGISTERED" : "WORKSPACE_DUPLICATED",
        severity: "error",
        subject: expected.workspaceKey,
        message: matches.length === 0 ? "可见工作区没有项目映射。" : "可见工作区映射不唯一。",
      });
      continue;
    }
    const mapping = matches[0];
    if (mapping.projectKey !== expected.projectKey || mapping.route !== expected.route) {
      issues.push({
        code: "WORKSPACE_MAPPING_DRIFT",
        severity: "error",
        subject: expected.workspaceKey,
        message: "工作区的项目 key 或路由与稳定导航合同不一致。",
      });
      continue;
    }
    if (!projectsByKey.has(mapping.projectKey)) {
      issues.push({
        code: "WORKSPACE_PROJECT_UNAVAILABLE",
        severity: "error",
        subject: expected.workspaceKey,
        message: "工作区指向的项目不存在。",
      });
      continue;
    }
    mappedWorkspaces += 1;
  }

  let mappedCatalogRoutes = 0;
  for (const item of CREATION_CATALOG_ROUTE_FACTS) {
    const workspaceKey = workspaceKeyForRoute(item.route);
    if (!workspaceKey || (workspacesByKey.get(workspaceKey) || []).length !== 1) {
      issues.push({
        code: "CATALOG_ROUTE_UNREGISTERED",
        severity: "error",
        subject: item.catalogId,
        message: `创作中心路由 ${item.route} 没有唯一工作区映射。`,
      });
      continue;
    }
    mappedCatalogRoutes += 1;
  }

  let mappedSources = 0;
  let unregisteredSources = 0;
  let unavailableSources = 0;
  for (const expected of PROJECT_SOURCE_FACTS) {
    const key = `${expected.sourceKind}:${expected.sourceKey}`;
    const matches = sourcesByKey.get(key) || [];
    if (matches.length !== 1) {
      unavailableSources += 1;
      issues.push({
        code: matches.length === 0 ? "SOURCE_REGISTRY_MISSING" : "SOURCE_REGISTRY_DUPLICATED",
        severity: "error",
        subject: key,
        message: matches.length === 0 ? "已审计来源没有登记状态。" : "已审计来源出现多条登记状态。",
      });
      continue;
    }
    const source = matches[0];
    if (source.mappingStatus === "mapped") {
      if (!source.projectKey || !source.projectKeyField || !projectsByKey.has(source.projectKey)) {
        unavailableSources += 1;
        issues.push({
          code: "SOURCE_MAPPING_INVALID",
          severity: "error",
          subject: key,
          message: "来源声称已映射，但缺少有效 project_key、字段或项目记录。",
        });
      } else {
        mappedSources += 1;
      }
      continue;
    }
    if (source.mappingStatus === "unregistered") {
      unregisteredSources += 1;
      issues.push({
        code: "SOURCE_PROJECT_UNREGISTERED",
        severity: "warning",
        subject: key,
        message: "来源没有可验证的 project_key 字段，历史记录保持未登记。",
      });
      continue;
    }
    unavailableSources += 1;
    issues.push({
      code: "SOURCE_UNAVAILABLE",
      severity: "warning",
      subject: key,
      message: "来源当前不可用，不能验证项目归属。",
    });
  }

  const hardFailure = issues.some((issue) => issue.severity === "error");
  const status: ProjectRegistryAvailability = input.projects.length === 0 || input.workspaces.length === 0
    ? "unavailable"
    : hardFailure || issues.length > 0
      ? "partial"
      : "available";

  return {
    status,
    workspaceCoverage: {
      expected: PROJECT_WORKSPACE_FACTS.length,
      mapped: mappedWorkspaces,
      unavailable: PROJECT_WORKSPACE_FACTS.length - mappedWorkspaces,
    },
    sourceCoverage: {
      expected: PROJECT_SOURCE_FACTS.length,
      mapped: mappedSources,
      unregistered: unregisteredSources,
      unavailable: unavailableSources,
    },
    catalogCoverage: {
      expected: CREATION_CATALOG_ROUTE_FACTS.length,
      mapped: mappedCatalogRoutes,
      unavailable: CREATION_CATALOG_ROUTE_FACTS.length - mappedCatalogRoutes,
    },
    issues,
  };
}
