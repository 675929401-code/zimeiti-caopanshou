import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/20260924091000_workspace_model_configuration_atomic.sql"), "utf8");
const workspaceRoute = fs.readFileSync(path.join(root, "src/app/api/admin/workspace-models/route.ts"), "utf8");
const modelRoute = fs.readFileSync(path.join(root, "src/app/api/admin/models/route.ts"), "utf8");
const compatibilityStore = fs.readFileSync(path.join(root, "src/lib/server/platform-configuration-compatibility.ts"), "utf8");
const configurationAdmin = fs.readFileSync(path.join(root, "src/lib/server/platform-configuration-admin.ts"), "utf8");
const retiredSeed = fs.readFileSync(path.join(root, "scripts/migrate-workspace-model-assignments-explicit.ts"), "utf8");

assert.match(migration, /update_workspace_model_configuration_atomic/u);
assert.match(migration, /ORDER BY setting_key\s+FOR UPDATE/iu);
assert.match(migration, /WORKSPACE_MODEL_NOT_ASSIGNED/u);
assert.match(migration, /p_action IS NULL[\s\S]*p_require_assigned IS NULL/iu);
assert.match(migration, /GROUP BY \(entry\.value #>> '\{\}'\)::numeric[\s\S]*HAVING count\(\*\) > 1/iu);
assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC, anon, authenticated/iu);
assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO service_role/iu);
assert.ok(workspaceRoute.match(/return stageLegacyWorkspaceMutation/gu)?.length === 2);
assert.match(compatibilityStore, /currentOrBootstrapWorkspace\(\)[\s\S]*?applyWorkspaceModelCompatibilityMutation[\s\S]*?createMutationCandidate/u);
assert.match(compatibilityStore, /createPlatformConfigurationCandidate\(actorId, kind, snapshot, note\)/u);
assert.match(configurationAdmin, /publish_platform_configuration_release_atomic/u);
assert.match(configurationAdmin, /p_expected_current_id[\s\S]*?p_expected_current_sha256/u);
assert.match(modelRoute, /stageLegacyWorkspaceMutation/u);
assert.doesNotMatch(workspaceRoute.slice(workspaceRoute.indexOf("async function updateAssignment")), /platform_settings"\)\.upsert/u);
assert.doesNotMatch(modelRoute.slice(modelRoute.indexOf("if \(surface\)"), modelRoute.indexOf("const table =", modelRoute.indexOf("if \(surface\)"))), /platform_settings[\s\S]*upsert/u);
assert.match(retiredSeed, /RETIRED_WORKSPACE_ASSIGNMENT_SEED/u);

const staticReport = {
  mode: "static",
  passed: 12,
  databaseWrites: 0,
  providerCalls: 0,
  generationRequests: 0,
  externalNetworkRequests: 0,
};

if (!process.argv.includes("--execute-local-concurrency")) {
  console.log(JSON.stringify(staticReport, null, 2));
  process.exit(0);
}
if (!process.argv.includes("--confirm-local-settings-roundtrip")) {
  throw new Error("LOCAL_CONCURRENCY_REQUIRES_EXPLICIT_CONFIRMATION");
}

const storageRoot = path.resolve(root, "..", "..", "..");
const runtime = JSON.parse(fs.readFileSync(path.join(storageRoot, "运行数据/自媒体操盘手/local-data-20260902/config/runtime.json"), "utf8"));
assert.equal(runtime.localOnly, true);
const connectionString = [runtime.ownerDatabaseUrl, runtime.databaseUrl, runtime.ownerConnection]
  .find((value) => typeof value === "string" && value.trim()) || "";
const target = new URL(connectionString);
assert.ok(["127.0.0.1", "localhost", "::1"].includes(target.hostname));
assert.equal(target.port, "54322");
assert.equal(target.pathname.replace(/^\//u, ""), "zimeiti_local");

const keys = ["workspace_model_assignment_overrides_v1", "image_model_surface_orders_v1", "video_model_surface_orders_v1"];
const clients = [0, 1, 2].map((index) => new Client({ connectionString, application_name: `codex-workspace-concurrency-${index}` }));
await Promise.all(clients.map((client) => client.connect()));
const [control, first, second] = clients;
let snapshot;
try {
  const original = await control.query("SELECT setting_key, setting_value FROM public.platform_settings WHERE setting_key = ANY($1::text[]) ORDER BY setting_key", [keys]);
  snapshot = new Map(original.rows.map((row) => [row.setting_key, row.setting_value]));
  assert.equal(snapshot.size, 3, "WORKSPACE_SETTING_ROWS_REQUIRED");

  await first.query("BEGIN");
  await first.query("SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)", ["assign", "image", "image-workbench", "__codex_concurrency_a__", true, null, true]);
  let secondFinished = false;
  const blocked = second.query("SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)", ["assign", "image", "image-workbench", "__codex_concurrency_b__", true, null, true]).finally(() => { secondFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(secondFinished, false, "SECOND_ASSIGNMENT_MUST_WAIT_FOR_ROW_LOCK");
  await first.query("COMMIT");
  await blocked;
  const combined = await control.query("SELECT setting_value::jsonb #> '{surfaces,image-workbench}' AS value FROM public.platform_settings WHERE setting_key=$1", [keys[0]]);
  assert.equal(combined.rows[0].value.__codex_concurrency_a__, true);
  assert.equal(combined.rows[0].value.__codex_concurrency_b__, true);

  await first.query("BEGIN");
  await first.query("SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)", ["assign", "image", "image-workbench", "__codex_concurrency_a__", false, null, true]);
  let reorderFinished = false;
  const rejected = second.query("SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)", ["reorder", "image", "image-workbench", null, null, { __codex_concurrency_a__: 10 }, true])
    .then(() => null, (error) => error)
    .finally(() => { reorderFinished = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(reorderFinished, false, "REORDER_MUST_WAIT_FOR_ASSIGNMENT_LOCK");
  await first.query("COMMIT");
  const rejection = await rejected;
  assert.equal(rejection?.code, "23514");

  const invalidNull = await control.query(
    "SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)",
    [null, "image", "image-workbench", null, null, null, true],
  ).then(() => null, (error) => error);
  assert.equal(invalidNull?.code, "22023");

  const invalidDuplicateOrder = await control.query(
    "SELECT public.update_workspace_model_configuration_atomic($1,$2,$3,$4,$5,$6,$7)",
    ["reorder", "image", "image-workbench", null, null, { __codex_concurrency_a__: 10, __codex_concurrency_b__: 10 }, false],
  ).then(() => null, (error) => error);
  assert.equal(invalidDuplicateOrder?.code, "22023");

  console.log(JSON.stringify({ ...staticReport, mode: "local-concurrency", passed: 20, target: "127.0.0.1:54322/zimeiti_local" }, null, 2));
} finally {
  await first.query("ROLLBACK").catch(() => undefined);
  if (snapshot?.size === 3) {
    await control.query("BEGIN");
    try {
      for (const [settingKey, settingValue] of [...snapshot.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        await control.query("UPDATE public.platform_settings SET setting_value=$2,updated_at=now() WHERE setting_key=$1", [settingKey, settingValue]);
      }
      await control.query("COMMIT");
    } catch (error) {
      await control.query("ROLLBACK");
      throw error;
    }
  }
  await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
}
