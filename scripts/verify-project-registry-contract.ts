#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CREATION_CATALOG_ROUTE_FACTS,
  PROJECT_DEFINITIONS,
  PROJECT_SOURCE_FACTS,
  PROJECT_WORKSPACE_FACTS,
  ROOT_PROJECT_KEY,
  inspectProjectRegistryConsistency,
  isStableProjectKey,
  requireStableProjectKey,
  workspaceKeyForRoute,
  type ProjectRegistryRecord,
  type ProjectSourceRecord,
  type ProjectWorkspaceRecord,
} from "../src/lib/project-registry-domain";

let passed = 0;
function check(run: () => void) {
  run();
  passed += 1;
}

const projects: ProjectRegistryRecord[] = PROJECT_DEFINITIONS.map((item) => ({
  projectKey: item.projectKey,
  parentProjectKey: item.parentProjectKey,
  displayName: item.displayName,
  internalName: item.internalName,
  primaryRoute: item.primaryRoute,
  responsibleOwner: null,
  lifecycleStatus: "active",
  registrationStatus: "partial",
  acceptsNewBusiness: true,
  slaProfile: { status: "unregistered" },
  tenantSupport: "unknown",
  allowedMessageSurfaces: [],
  sourceEvidence: [{ source: item.source }],
  sortOrder: item.sortOrder,
  revision: 1,
  updatedAt: null,
}));

const workspaces: ProjectWorkspaceRecord[] = PROJECT_WORKSPACE_FACTS.map((item) => ({
  workspaceKey: item.workspaceKey,
  projectKey: item.projectKey,
  displayName: item.displayName,
  route: item.route,
  sourceCatalog: item.sourceCatalog,
  sourceEvidence: [{ source: item.evidencePath }],
  sortOrder: item.sortOrder,
  updatedAt: null,
}));

const unregisteredSources: ProjectSourceRecord[] = PROJECT_SOURCE_FACTS.map((item) => ({
  sourceKind: item.sourceKind,
  sourceKey: item.sourceKey,
  projectKey: null,
  mappingStatus: "unregistered",
  projectKeyField: null,
  evidencePath: item.evidencePath,
  reasonCode: "SOURCE_HAS_NO_PROJECT_KEY",
  updatedAt: null,
}));

check(() => {
  assert.equal(isStableProjectKey(ROOT_PROJECT_KEY), true);
  assert.equal(requireStableProjectKey("storyboard_workbench"), "storyboard_workbench");
  for (const value of ["", "AProject", "1-project", "project.key", "../project", "project key", "00000000-0000-4000-8000-000000000001"]) {
    assert.equal(isStableProjectKey(value), false, `unstable key accepted: ${value}`);
  }
  assert.throws(() => requireStableProjectKey("commerce/v2"), /PROJECT_KEY_INVALID/u);
});

check(() => {
  assert.equal(PROJECT_DEFINITIONS.length, 10);
  assert.equal(PROJECT_WORKSPACE_FACTS.length, 9);
  assert.equal(new Set(PROJECT_DEFINITIONS.map((item) => item.projectKey)).size, PROJECT_DEFINITIONS.length);
  assert.equal(new Set(PROJECT_WORKSPACE_FACTS.map((item) => item.workspaceKey)).size, PROJECT_WORKSPACE_FACTS.length);
  assert.equal(new Set(PROJECT_WORKSPACE_FACTS.map((item) => item.route)).size, PROJECT_WORKSPACE_FACTS.length);
  assert.ok(PROJECT_WORKSPACE_FACTS.every((item) => item.projectKey === item.workspaceKey));
});

check(() => {
  const expected = new Map<string, string>([
    ["/", "marketplace"],
    ["/tools", "toolbox"],
    ["/tools/film-studio", "toolbox"],
    ["/short-drama", "toolbox"],
    ["/image-workbench", "image_workbench"],
    ["/video?entry=short-drama", "create"],
    ["/voice-studio", "voice"],
    ["/voice-studio/workspace?speaker=test", "voice"],
    ["/commerce/rebuild", "commerce_agent"],
  ]);
  for (const [route, workspaceKey] of expected) {
    assert.equal(workspaceKeyForRoute(route), workspaceKey, route);
  }
  assert.equal(workspaceKeyForRoute("/unknown"), null);
  assert.ok(CREATION_CATALOG_ROUTE_FACTS.every((item) => workspaceKeyForRoute(item.route)), "creation catalog contains an unmapped route");
});

check(() => {
  const result = inspectProjectRegistryConsistency({ projects, workspaces, sources: unregisteredSources });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.workspaceCoverage, { expected: 9, mapped: 9, unavailable: 0 });
  assert.deepEqual(result.catalogCoverage, { expected: 8, mapped: 8, unavailable: 0 });
  assert.deepEqual(result.sourceCoverage, { expected: 10, mapped: 0, unregistered: 10, unavailable: 0 });
  assert.equal(result.issues.filter((issue) => issue.code === "SOURCE_PROJECT_UNREGISTERED").length, 10);
  assert.equal(result.issues.some((issue) => issue.severity === "error"), false);
});

check(() => {
  const mappedSources: ProjectSourceRecord[] = unregisteredSources.map((item) => ({
    ...item,
    projectKey: ROOT_PROJECT_KEY,
    projectKeyField: "project_key",
    mappingStatus: "mapped",
    reasonCode: "PROJECT_KEY_VERIFIED",
  }));
  const result = inspectProjectRegistryConsistency({ projects, workspaces, sources: mappedSources });
  assert.equal(result.status, "available");
  assert.deepEqual(result.sourceCoverage, { expected: 10, mapped: 10, unregistered: 0, unavailable: 0 });
  assert.deepEqual(result.issues, []);
});

check(() => {
  const result = inspectProjectRegistryConsistency({
    projects,
    workspaces: [...workspaces, { ...workspaces[0] }],
    sources: unregisteredSources,
  });
  assert.equal(result.status, "partial");
  assert.ok(result.issues.some((issue) => issue.code === "WORKSPACE_DUPLICATED" && issue.subject === "marketplace"));
});

check(() => {
  const releasePolicy = JSON.parse(readFileSync(new URL("../deploy/policies/release-policy.json", import.meta.url), "utf8"));
  assert.equal(releasePolicy.projectId, ROOT_PROJECT_KEY);

  const migration = readFileSync(new URL("../supabase/migrations/20261002143000_project_registry_control_plane.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../supabase/rollbacks/20261002143000_project_registry_control_plane.rollback.sql", import.meta.url), "utf8");
  const apiRoute = readFileSync(new URL("../src/app/api/admin/project-registry/route.ts", import.meta.url), "utf8");
  const serverReader = readFileSync(new URL("../src/lib/server/project-registry.ts", import.meta.url), "utf8");
  const localProbe = readFileSync(new URL("./verify-project-registry-local.mjs", import.meta.url), "utf8");

  for (const table of ["project_registry", "project_workspace_registry", "project_source_registry"]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "u"));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`, "u"));
    assert.match(migration, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO service_role`, "u"));
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS public\\.${table}`, "u"));
  }
  assert.match(migration, /SOURCE_HAS_NO_PROJECT_KEY/u);
  assert.match(migration, /PROJECT_REGISTRY_PROJECT_SEED_CONFLICT/u);
  assert.match(migration, /PROJECT_REGISTRY_WORKSPACE_SEED_CONFLICT/u);
  assert.match(migration, /PROJECT_REGISTRY_SOURCE_SEED_CONFLICT/u);
  assert.match(migration, /mapping_status = 'mapped' AND project_key IS NOT NULL AND project_key_field = 'project_key'/u);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(?:llm_request_attempts|image_generation_requests|video_tasks|voice_generation_requests|extraction_attempts|revenue_records|credit_transactions|cash_transactions|user_notifications|announcements)\b/u);
  assert.match(rollback, /PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_PROJECT_SEED/u);
  assert.match(rollback, /PROJECT_REGISTRY_ROLLBACK_REQUIRES_UNCHANGED_SOURCE_SEED/u);
  assert.match(rollback, /^BEGIN;\s*/u);
  assert.match(rollback, /\sCOMMIT;\s*$/u);
  assert.match(apiRoute, /authorizeAdminCapability\(request, "logs\.view"/u);
  assert.match(apiRoute, /export async function GET/u);
  assert.doesNotMatch(apiRoute, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(serverReader, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/u);
  assert.match(serverReader, /PROJECT_REGISTRY_SCHEMA_UNAVAILABLE/u);
  assert.match(localProbe, /runtime\.ownerConnection\?\.host, "127\.0\.0\.1"/u);
  assert.match(localProbe, /runtime\.ownerConnection\?\.port\), 54322/u);
  assert.match(localProbe, /assert\.deepEqual\(before, \{ projects: null, workspaces: null, sources: null \}/u);
  assert.match(localProbe, /await client\.query\("ROLLBACK"\)/u);
  assert.match(localProbe, /LOCAL_PROBE_MUST_NOT_PERSIST_SCHEMA/u);
});

process.stdout.write(`${JSON.stringify({
  passed,
  failed: 0,
  projects: PROJECT_DEFINITIONS.length,
  visibleWorkspaces: PROJECT_WORKSPACE_FACTS.length,
  catalogRoutes: CREATION_CATALOG_ROUTE_FACTS.length,
  auditedSources: PROJECT_SOURCE_FACTS.length,
  mappedSources: 0,
  unregisteredSources: PROJECT_SOURCE_FACTS.length,
  businessWrites: 0,
  providerCalls: 0,
  productionWrites: 0,
})}\n`);
