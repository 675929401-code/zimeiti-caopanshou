import "server-only";

import {
  PROJECT_REGISTRY_SCHEMA_VERSION,
  inspectProjectRegistryConsistency,
  type ProjectLifecycleStatus,
  type ProjectMessageSurface,
  type ProjectRegistrationStatus,
  type ProjectRegistryIssue,
  type ProjectRegistryRecord,
  type ProjectSourceKind,
  type ProjectSourceMappingStatus,
  type ProjectSourceRecord,
  type ProjectTenantSupport,
  type ProjectWorkspaceRecord,
} from "@/lib/project-registry-domain";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseRow = Record<string, unknown>;

export interface AdminProjectRegistrySnapshot {
  schemaVersion: typeof PROJECT_REGISTRY_SCHEMA_VERSION;
  generatedAt: string;
  registryState: "available" | "partial" | "unavailable";
  projects: Array<ProjectRegistryRecord & { unregisteredFields: string[] }>;
  workspaces: ProjectWorkspaceRecord[];
  sourceMappings: ProjectSourceRecord[];
  consistency: ReturnType<typeof inspectProjectRegistryConsistency>;
  readOnly: true;
  providerCalls: 0;
  businessWrites: 0;
}

const PROJECT_SELECT = [
  "project_key",
  "parent_project_key",
  "display_name",
  "internal_name",
  "primary_route",
  "responsible_owner",
  "lifecycle_status",
  "registration_status",
  "accepts_new_business",
  "sla_profile",
  "tenant_support",
  "allowed_message_surfaces",
  "source_evidence",
  "sort_order",
  "revision",
  "updated_at",
].join(",");

const WORKSPACE_SELECT = [
  "workspace_key",
  "project_key",
  "display_name",
  "route",
  "source_catalog",
  "source_evidence",
  "sort_order",
  "updated_at",
].join(",");

const SOURCE_SELECT = [
  "source_kind",
  "source_key",
  "project_key",
  "mapping_status",
  "project_key_field",
  "evidence_path",
  "reason_code",
  "updated_at",
].join(",");

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value).trim();
  return valueText || null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function evidenceArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function lifecycleStatus(value: unknown): ProjectLifecycleStatus {
  return value === "active" || value === "paused" || value === "retired" ? value : "paused";
}

function registrationStatus(value: unknown): ProjectRegistrationStatus {
  return value === "registered" || value === "partial" || value === "unavailable" ? value : "unavailable";
}

function tenantSupport(value: unknown): ProjectTenantSupport {
  return value === "unsupported" || value === "single_tenant" || value === "multi_tenant" ? value : "unknown";
}

function messageSurfaces(value: unknown): ProjectMessageSurface[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<ProjectMessageSurface>(["modal", "toast", "banner", "inbox", "email"]);
  return [...new Set(value.filter((item): item is ProjectMessageSurface => typeof item === "string" && allowed.has(item as ProjectMessageSurface)))];
}

function sourceKind(value: unknown): ProjectSourceKind {
  return value === "task" || value === "billing" || value === "notification" ? value : "task";
}

function sourceMappingStatus(value: unknown): ProjectSourceMappingStatus {
  return value === "mapped" || value === "unregistered" || value === "unavailable" ? value : "unavailable";
}

function projectFromRow(row: DatabaseRow): ProjectRegistryRecord {
  return {
    projectKey: text(row.project_key),
    parentProjectKey: nullableText(row.parent_project_key),
    displayName: text(row.display_name),
    internalName: text(row.internal_name),
    primaryRoute: nullableText(row.primary_route),
    responsibleOwner: nullableText(row.responsible_owner),
    lifecycleStatus: lifecycleStatus(row.lifecycle_status),
    registrationStatus: registrationStatus(row.registration_status),
    acceptsNewBusiness: row.accepts_new_business === true,
    slaProfile: objectValue(row.sla_profile),
    tenantSupport: tenantSupport(row.tenant_support),
    allowedMessageSurfaces: messageSurfaces(row.allowed_message_surfaces),
    sourceEvidence: evidenceArray(row.source_evidence),
    sortOrder: integer(row.sort_order),
    revision: integer(row.revision, 1),
    updatedAt: nullableText(row.updated_at),
  };
}

function workspaceFromRow(row: DatabaseRow): ProjectWorkspaceRecord {
  return {
    workspaceKey: text(row.workspace_key),
    projectKey: text(row.project_key),
    displayName: text(row.display_name),
    route: text(row.route),
    sourceCatalog: text(row.source_catalog),
    sourceEvidence: evidenceArray(row.source_evidence),
    sortOrder: integer(row.sort_order),
    updatedAt: nullableText(row.updated_at),
  };
}

function sourceFromRow(row: DatabaseRow): ProjectSourceRecord {
  return {
    sourceKind: sourceKind(row.source_kind),
    sourceKey: text(row.source_key),
    projectKey: nullableText(row.project_key),
    mappingStatus: sourceMappingStatus(row.mapping_status),
    projectKeyField: nullableText(row.project_key_field),
    evidencePath: text(row.evidence_path),
    reasonCode: text(row.reason_code),
    updatedAt: nullableText(row.updated_at),
  };
}

function unavailableSnapshot(generatedAt: string, issue: ProjectRegistryIssue): AdminProjectRegistrySnapshot {
  const consistency = inspectProjectRegistryConsistency({ projects: [], workspaces: [], sources: [] });
  consistency.issues.unshift(issue);
  consistency.status = "unavailable";
  return {
    schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
    generatedAt,
    registryState: "unavailable",
    projects: [],
    workspaces: [],
    sourceMappings: [],
    consistency,
    readOnly: true,
    providerCalls: 0,
    businessWrites: 0,
  };
}

function unregisteredFields(project: ProjectRegistryRecord): string[] {
  const fields: string[] = [];
  if (!project.responsibleOwner) fields.push("responsibleOwner");
  if (project.slaProfile.status === "unregistered") fields.push("slaProfile");
  if (project.tenantSupport === "unknown") fields.push("tenantSupport");
  if (project.allowedMessageSurfaces.length === 0) fields.push("allowedMessageSurfaces");
  return fields;
}

export async function readAdminProjectRegistrySnapshot(): Promise<AdminProjectRegistrySnapshot> {
  const generatedAt = new Date().toISOString();
  try {
    const database = getSupabaseAdminClient();
    const [projectResult, workspaceResult, sourceResult] = await Promise.all([
      database.from("project_registry").select(PROJECT_SELECT).order("sort_order", { ascending: true }),
      database.from("project_workspace_registry").select(WORKSPACE_SELECT).order("sort_order", { ascending: true }),
      database.from("project_source_registry").select(SOURCE_SELECT).order("source_kind", { ascending: true }).order("source_key", { ascending: true }),
    ]);
    const error = projectResult.error || workspaceResult.error || sourceResult.error;
    if (error) {
      return unavailableSnapshot(generatedAt, {
        code: "PROJECT_REGISTRY_SCHEMA_UNAVAILABLE",
        severity: "error",
        subject: "project_registry",
        message: "项目注册表数据库迁移尚未可读，未回退为静态成功数据。",
      });
    }

    const projects = (projectResult.data || []).map((row: unknown) => projectFromRow(row as DatabaseRow));
    const workspaces = (workspaceResult.data || []).map((row: unknown) => workspaceFromRow(row as DatabaseRow));
    const sourceMappings = (sourceResult.data || []).map((row: unknown) => sourceFromRow(row as DatabaseRow));
    const consistency = inspectProjectRegistryConsistency({ projects, workspaces, sources: sourceMappings });
    return {
      schemaVersion: PROJECT_REGISTRY_SCHEMA_VERSION,
      generatedAt,
      registryState: consistency.status,
      projects: projects.map((project: ProjectRegistryRecord) => ({
        ...project,
        unregisteredFields: unregisteredFields(project),
      })),
      workspaces,
      sourceMappings,
      consistency,
      readOnly: true,
      providerCalls: 0,
      businessWrites: 0,
    };
  } catch {
    return unavailableSnapshot(generatedAt, {
      code: "PROJECT_REGISTRY_READ_FAILED",
      severity: "error",
      subject: "project_registry",
      message: "项目注册表读取失败，当前归属状态不可用。",
    });
  }
}
