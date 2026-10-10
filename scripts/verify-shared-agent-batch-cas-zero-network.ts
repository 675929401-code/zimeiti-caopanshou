import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { isAgentBatchConflict, parseExpectedAgentRevision } from "../src/lib/server/agent-config-cas";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/20261010140000_shared_agent_batch_cas.sql");
const rollback = read("supabase/rollbacks/20261010140000_shared_agent_batch_cas.rollback.sql");
const reorderRoute = read("src/app/api/admin/agents/reorder/route.ts");
const cozeRoute = read("src/app/api/admin/agents/import-coze/route.ts");
const avatarGenerator = read("src/lib/auto-avatar/generator.ts");
const batchAvatarRoute = read("src/app/api/admin/agents/batch-avatar/route.ts");
const storage = read("src/lib/storage.ts");
const marketplace = read("src/components/agent-marketplace.tsx");
const applyProbe = read("scripts/apply-shared-agent-batch-cas-local.mjs");
const readinessProbe = read("scripts/verify-shared-agent-batch-cas-readiness-local.mjs");
const rollbackProbe = read("scripts/verify-shared-agent-batch-cas-rollback-local.mjs");

for (const value of [true, false, 1.5, 1e20, 0, -1, NaN, Infinity, "", " ", " 1", "1 ", "0", "-1", "1.0", "1e2", "01"]) {
  assert.equal(parseExpectedAgentRevision({ expected_revision: value }), null, `REVISION_MUST_BE_REJECTED:${String(value)}`);
}
for (const [value, expected] of [[1, 1], [42, 42], ["1", 1], ["42", 42]] as const) {
  assert.equal(parseExpectedAgentRevision({ expected_revision: value }), expected);
}
assert.equal(parseExpectedAgentRevision({ expectedRevision: "7" }), 7);
for (const code of ["23505", "23514", "40001", "P0002"]) {
  assert.equal(isAgentBatchConflict({ code }), true, `CONFLICT_CODE_MUST_MAP_409:${code}`);
}
assert.equal(isAgentBatchConflict({ code: "22023" }), false);

assert.match(migration, /^BEGIN;/u);
assert.match(migration, /COMMIT;\s*$/u);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.apply_agent_reorder_cas_v1\(p_entries jsonb\)/u);
assert.match(migration, /CREATE OR REPLACE FUNCTION public\.apply_coze_agent_import_cas_v1\(p_entries jsonb\)/u);
assert.match(migration, /ORDER BY agents\.id\s+FOR UPDATE OF agents/gu);
assert.match(migration, /ORDER BY bot_id[\s\S]*?pg_advisory_xact_lock\(hashtextextended\('coze-agent:' \|\| v_bot_id, 0\)\)/u);
assert.match(migration, /AGENT_CONFIG_REVISION_CONFLICT[^]*?USING ERRCODE = '40001'/u);
assert.match(migration, /9223372036854775807::numeric/gu);
assert.match(migration, /AGENT_REORDER_CATEGORY_INCOMPLETE[^]*?ERRCODE = '40001'/u);
assert.match(migration, /FROM public\.agents AS agents\s+WHERE agents\.deleted_at IS NULL\s+ORDER BY agents\.id\s+FOR UPDATE OF agents/u);
assert.match(migration, /ALTER FUNCTION %s OWNER TO %I/u);
assert.match(migration, /ALTER FUNCTION %s SECURITY DEFINER/u);
assert.match(migration, /ALTER FUNCTION %s SET search_path = public, pg_temp/u);
assert.match(migration, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/u);
assert.match(migration, /GRANT EXECUTE ON FUNCTION %s TO service_role/u);
assert.match(migration, /aclexplode/u);
assert.doesNotMatch(migration, /OWNER TO (?:postgres|zimeiti_owner)/iu);
assert.ok(
  migration.indexOf("AGENT_CONFIG_REVISION_CONFLICT:%:%:%") < migration.indexOf("UPDATE public.agents AS agents"),
  "REORDER_MUST_PREVALIDATE_ALL_REVISIONS_BEFORE_UPDATE",
);
const cozeFunction = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.apply_coze_agent_import_cas_v1"));
assert.ok(
  cozeFunction.indexOf("AGENT_CONFIG_REVISION_CONFLICT:%:%:%") < cozeFunction.indexOf("INSERT INTO public.agents"),
  "COZE_MUST_PREVALIDATE_ALL_REVISIONS_BEFORE_FIRST_WRITE",
);
assert.match(rollback, /DROP FUNCTION IF EXISTS public\.apply_agent_reorder_cas_v1\(jsonb\)/u);
assert.match(rollback, /DROP FUNCTION IF EXISTS public\.apply_coze_agent_import_cas_v1\(jsonb\)/u);
assert.match(rollback, /DELETE FROM supabase_migrations\.schema_migrations[\s\S]*?20261010140000/u);
assert.match(applyProbe, /LEDGER_SCHEMA_DIVERGENCE:REORDER_FUNCTION_MISSING/u);
assert.match(readinessProbe, /pg_get_functiondef\(p\.oid\)/u);
assert.match(readinessProbe, /semanticHashMatches/u);
assert.doesNotMatch(readinessProbe, /p\.prosrc/u);
assert.match(rollbackProbe, /ROLLBACK_MUST_REMOVE_FUNCTIONS_AND_LEDGER/u);
assert.match(rollbackProbe, /rollback -> reapply -> semantic\/security ready/u);
assert.doesNotMatch(rollbackProbe, /p\.prosrc/u);

assert.match(reorderRoute, /client\.rpc\("apply_agent_reorder_cas_v1"/u);
assert.match(reorderRoute, /AGENT_REORDER_CATEGORY_INCOMPLETE/u);
assert.match(reorderRoute, /completeIds\.size !== submittedIds\.size/u);
assert.doesNotMatch(reorderRoute, /updateAgentByRevision|\.from\(["']agents["']\)[\s\S]{0,180}?\.update\(/u);
assert.equal((reorderRoute.match(/apply_agent_reorder_cas_v1/gu) || []).length, 1);

assert.match(cozeRoute, /client\.rpc\('apply_coze_agent_import_cas_v1'/u);
assert.match(cozeRoute, /本批次零写入/u);
assert.match(cozeRoute, /COZE_IMPORT_UPSTREAM_BATCH_INCOMPLETE/u);
assert.ok(cozeRoute.indexOf("if (failed > 0)") < cozeRoute.indexOf("client.rpc('apply_coze_agent_import_cas_v1'"),
  "UPSTREAM_FAILURE_MUST_ABORT_BEFORE_RPC");
assert.doesNotMatch(cozeRoute, /updateAgentByRevision|\.from\(["']agents["']\)[\s\S]{0,240}?\.(?:insert|update)\(/u);
assert.equal((cozeRoute.match(/apply_coze_agent_import_cas_v1/gu) || []).length, 1);

assert.match(avatarGenerator, /select\("id,avatar,config_revision"\)/u);
assert.match(avatarGenerator, /\.eq\("config_revision", snapshot\.configRevision\)/u);
assert.match(avatarGenerator, /snapshot\.avatar === null[\s\S]*?\.is\("avatar", null\)[\s\S]*?\.eq\("avatar", snapshot\.avatar\)/u);
assert.match(avatarGenerator, /discardUnclaimedGeneratedAvatar\(generatedAvatar\)/u);
assert.match(avatarGenerator, /invalidateAgentConfigCache\(agentId\)/u);
assert.match(avatarGenerator, /invalidateBotsCache\(\)/u);
assert.match(batchAvatarRoute, /select\("id,name,description,avatar,config_revision"\)/u);
assert.match(storage, /select\("id", \{ head: true, count: "exact" \}\)[\s\S]*?\.eq\("avatar", normalized\)/u);
assert.match(storage, /agent-avatar-generated/u);
assert.match(storage, /metadata\?\.length !== 1/u);
assert.match(storage, /!row\.storage_provider/u);
assert.doesNotMatch(storage, /storage\.from\("avatars"\)\.remove/u);
assert.match(marketplace, /const currentIds = agents[\s\S]*?agent\.category === dragged\.category/u);
assert.doesNotMatch(marketplace.slice(marketplace.indexOf("const handleAgentDrop ="), marketplace.indexOf("const handleAgentDragEnd")),
  /const currentIds = sortedAgentIds/u);

type Row = { id: string; revision: number; value: string };
function simulatePrevalidatedBatch(rows: Row[], changes: Array<{ id: string; expected: number; value: string }>): Row[] {
  for (const change of changes) {
    const current = rows.find((row) => row.id === change.id);
    if (!current || current.revision !== change.expected) throw new Error("AGENT_CONFIG_REVISION_CONFLICT");
  }
  return rows.map((row) => {
    const change = changes.find((candidate) => candidate.id === row.id);
    return change ? { ...row, revision: row.revision + 1, value: change.value } : row;
  });
}
const original: Row[] = [{ id: "first", revision: 4, value: "before-1" }, { id: "second", revision: 9, value: "before-2" }];
let projected = structuredClone(original);
assert.throws(() => {
  projected = simulatePrevalidatedBatch(projected, [
    { id: "first", expected: 4, value: "after-1" },
    { id: "second", expected: 8, value: "after-2" },
  ]);
}, /AGENT_CONFIG_REVISION_CONFLICT/u);
assert.deepEqual(projected, original, "SECOND_ROW_CONFLICT_MUST_LEAVE_FIRST_ROW_UNCHANGED");

function requireCompleteCategoryOrder(allIds: string[], submittedIds: string[]): void {
  const submitted = new Set(submittedIds);
  if (allIds.length !== submitted.size || allIds.some((id) => !submitted.has(id))) {
    throw new Error("AGENT_REORDER_CATEGORY_INCOMPLETE");
  }
}
assert.throws(() => requireCompleteCategoryOrder(["visible", "filtered-out"], ["visible"]),
  /AGENT_REORDER_CATEGORY_INCOMPLETE/u);
assert.doesNotThrow(() => requireCompleteCategoryOrder(["first", "second"], ["second", "first"]));

const inventory = new Map<string, string>([
  ["src/lib/server/agent-config-cas.ts", "formal-single-row-cas"],
  ["src/lib/auto-avatar/generator.ts", "formal-avatar-dual-cas"],
  ["src/app/api/admin/agents/route.ts", "formal-create-and-single-row-cas"],
  ["src/app/api/admin/agents/reorder/route.ts", "formal-transactional-batch-cas"],
  ["src/app/api/admin/agents/import-coze/route.ts", "formal-transactional-mixed-cas"],
  ["src/app/api/admin/agents/restore/route.ts", "formal-single-row-cas"],
  ["src/app/api/auth/setup/route.ts", "bootstrap-create-only"],
  ["src/app/api/admin/agents/import/route.ts", "admin-create-only"],
  ["src/app/api/admin/agents/import-by-ids/route.ts", "admin-create-only"],
  ["src/app/api/admin/aiweb-import/route.ts", "admin-create-only"],
  ["src/app/api/admin/coze-import/route.ts", "legacy-admin-create-only"],
  ["scripts/activate-story-director-prompt-quality-candidates.ts", "explicit-local-or-confirmed-shared-automation"],
  ["scripts/apply-storyboard-director-v6-2-rest.mjs", "legacy-manual-shared-automation"],
  ["scripts/sync-storyboard-agent.mjs", "legacy-manual-shared-automation"],
  ["scripts/update-3d-story-director-breed-priority.ts", "explicit-local-or-confirmed-shared-automation"],
  ["scripts/update-3d-story-director-intake-templates.ts", "explicit-local-or-confirmed-shared-automation"],
  ["scripts/upgrade-agent-engineering-developer-5-0.ts", "legacy-manual-shared-automation"],
  ["scripts/update-benchmark-agent-action-loop.ts", "local-transaction-config-revision-cas"],
  ["scripts/website-promoter-v2-local.ts", "local-transaction-config-revision-cas"],
  ["scripts/restore-story-director-capabilities-20261005.ts", "legacy-local-transaction-updated-at-cas"],
  ["scripts/backup-storyboard-directors-v6-2.ts", "generated-transactional-restore-sql-config-revision-cas"],
  ["scripts/verify-shared-agent-batch-cas-rollback-local.mjs", "nonpersistent-transaction-fixture"],
  ["scripts/verify-shared-agent-config-revision-local-rollback.mjs", "nonpersistent-transaction-fixture"],
  ["scripts/verify-storyboard-director-agents-v6-2.ts", "static-verifier-sql-literal-not-executed"],
]);

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const absolute = resolve(directory, name);
    return statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
  });
}
const discovered = new Set<string>();
for (const absolute of [...filesUnder(resolve(root, "src")), ...filesUnder(resolve(root, "scripts"))]) {
  if (!/\.(?:[cm]?[jt]sx?)$/u.test(absolute)) continue;
  const path = relative(root, absolute).replaceAll("\\", "/");
  if (path === "scripts/verify-shared-agent-batch-cas-zero-network.ts") continue;
  const source = readFileSync(absolute, "utf8");
  const directMutation = /\.from\(\s*(["'])agents\1\s*\)[^;]{0,1200}?\.(?:insert|update|delete|upsert)\s*\(/u.test(source);
  const sharedCasMutation = /(?:updateAgentByRevision|deleteAgentByRevision)\s*\(/u.test(source);
  const batchRpcMutation = /\.rpc\(\s*(["'])apply_(?:agent_reorder|coze_agent_import)_cas_v1\1/u.test(source);
  const nativeSqlMutation = /(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?agents\b/iu.test(source);
  if (directMutation || sharedCasMutation || batchRpcMutation || nativeSqlMutation) discovered.add(path);
}
for (const path of discovered) assert.ok(inventory.has(path), `UNCLASSIFIED_AGENTS_MUTATION:${path}`);
for (const path of inventory.keys()) {
  assert.ok(discovered.has(path), `STALE_AGENTS_MUTATION_INVENTORY:${path}`);
}
assert.equal(inventory.get("src/lib/auto-avatar/generator.ts"), "formal-avatar-dual-cas");
assert.equal(inventory.get("scripts/update-3d-story-director-breed-priority.ts"), "explicit-local-or-confirmed-shared-automation");
assert.equal(inventory.get("scripts/restore-story-director-capabilities-20261005.ts"), "legacy-local-transaction-updated-at-cas");
assert.equal(inventory.get("scripts/backup-storyboard-directors-v6-2.ts"), "generated-transactional-restore-sql-config-revision-cas");

console.log(JSON.stringify({
  passed: true,
  network: "disabled-by-design",
  checks: [
    "strict positive revision parser",
    "atomic reorder and mixed Coze RPC source contracts",
    "dynamic owner, SECURITY DEFINER, fixed search_path, service_role-only ACL",
    "avatar dual CAS, conflict disposal, and both cache invalidations",
    "second-row conflict zero-write fixture",
    "filtered-category reorder and concurrency code fixtures",
    `repository agents mutation inventory (${discovered.size} classified files)`,
  ],
  mutationInventory: [...discovered].sort().map(path => ({ path, classification: inventory.get(path) })),
}, null, 2));
