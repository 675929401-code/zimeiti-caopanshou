#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const scriptPath = path.join(root, "scripts", "db-migration-release.mjs");
const pendingSemanticPath = path.join(root, "scripts", "verify-pending-migration-semantics.mjs");
const evidencedAdoptionPath = path.join(root, "scripts", "adopt-evidenced-migrations.mjs");
const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
const packagePath = path.join(root, "package.json");
const migrationRoot = path.join(root, "supabase", "migrations");
const rollbackRoot = path.join(root, "supabase", "rollbacks");
const llmRollbackPath = path.join(rollbackRoot, "20260901170000_llm_request_attempts_exactly_once.rollback.sql");
const videoRollbackPath = path.join(rollbackRoot, "20260825180000_video_terminal_billing_p0.rollback.sql");
const refundRollbackPath = path.join(rollbackRoot, "20260904193000_payment_refund_exactly_once.rollback.sql");
const reconciliationMigrationName = "20260904031000_reconcile_pending_legacy_semantics.sql";
const reconciliationMigrationPath = path.join(migrationRoot, reconciliationMigrationName);

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function json(filePath) {
  return JSON.parse(read(filePath));
}

function extractJsonObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
}

const checks = [];

function add(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail });
}

const script = read(scriptPath);
const pendingSemanticScript = read(pendingSemanticPath);
const evidencedAdoptionScript = read(evidencedAdoptionPath);
const reconciliationMigration = read(reconciliationMigrationPath);
const llmRollback = read(llmRollbackPath);
const videoRollback = read(videoRollbackPath);
const refundRollback = read(refundRollbackPath);
const policy = json(policyPath);
const pkg = json(packagePath);

add("script:exists", fs.existsSync(scriptPath), "scripts/db-migration-release.mjs exists");
add("script:uses-pg-direct-migration-channel", script.includes("from \"pg\"") || script.includes("from 'pg'"), "uses pg outside app runtime");
add("script:loads-env-without-printing-secrets", script.includes("dotenv.config") && script.includes("credentialsPrinted: false"), "loads env and redacts credentials");
add("script:plan-status-semantic-adopt-apply", ["plan", "status", "semantic-check", "adopt", "apply"].every((item) => script.includes(item)), "supports plan/status/semantic-check/adopt/apply");
add("script:requires-target-confirmation", script.includes("--confirm-target-host") && script.includes("TARGET_HOST_CONFIRMATION_REQUIRED"), "target host confirmation is enforced");
add("script:requires-manifest-confirmation", script.includes("--confirm-manifest-sha256") && script.includes("MANIFEST_SHA256_CONFIRMATION_REQUIRED"), "manifest sha confirmation is enforced");
add("script:requires-backup-confirmation", script.includes("--confirm-backup") && script.includes("PRE_MIGRATION_BACKUP_CONFIRMATION_REQUIRED"), "pre-migration backup confirmation is enforced");
add("script:uses-advisory-lock", script.includes("pg_advisory_lock") && script.includes("pg_advisory_unlock"), "single-run advisory lock is present");
add("script:records-ledger", script.includes("supabase_migrations.schema_migrations") && script.includes("hash") && script.includes("applied_at"), "migration ledger is recorded");
add("script:hash-drift-fails-closed", script.includes("APPLIED_MIGRATION_HASH_DRIFT") && script.includes("appliedMigrationHashDrifts"), "applied migration hash drift blocks status/apply");
add(
  "script:semantic-adoption-is-exact-noop-only",
  script.includes("migration-semantic-noop-receipt")
    && script.includes("changedObjects.length === 0 && dmlChanges.length === 0")
    && script.includes("committedMigrationSql: 0"),
  "semantic adoption requires an unchanged catalog and zero transactional DML changes",
);
add(
  "script:semantic-adoption-covers-critical-catalogs",
  ["relations-and-permissions", "columns-defaults-and-permissions", "functions-and-permissions", "row-security-policies", "constraints", "indexes", "triggers"].every((item) => script.includes(item)),
  "semantic probe fingerprints objects, functions, permissions, policies, constraints, indexes and triggers",
);
add(
  "script:semantic-adoption-reports-object-level-differences",
  script.includes("CATALOG_IDENTITY_FIELDS")
    && script.includes("changedCatalogObjects")
    && script.includes("safeDatabaseErrorObject"),
  "blocked migrations identify changed catalog objects or sanitized duplicate-object targets",
);
add(
  "script:semantic-adoption-rechecks-before-ledger-write",
  script.includes("SEMANTIC_RECHECK_FAILED")
    && script.includes("SEMANTIC_RECEIPT_MIGRATION_CHANGED")
    && script.includes("TARGET_FINGERPRINT_CONFIRMATION_REQUIRED"),
  "receipt, source, target and live database semantics are rechecked before ledger adoption",
);
add(
  "script:semantic-adoption-requires-explicit-receipt",
  script.includes("--semantic-receipt")
    && script.includes("--confirm-semantic-receipt-sha256")
    && script.includes("--confirm-target-fingerprint")
    && script.includes("SEMANTIC_RECEIPT_REQUIRED"),
  "blind migration adoption is unavailable",
);
add("script:only-uses-prefix-closure", script.includes("dependencyClosureAdded") && script.includes("ONLY_SELECTOR_NOT_FOUND"), "--only includes its ordered prerequisite closure");
add("script:refreshes-postgrest", script.includes("notify pgrst"), "PostgREST schema reload notification is sent after apply");
add("script:blocks-broad-destructive-ddl", ["DROP_DATABASE_FORBIDDEN", "DROP_SCHEMA_FORBIDDEN", "DROP_TABLE_FORBIDDEN", "TRUNCATE_FORBIDDEN"].every((item) => script.includes(item)), "broad destructive DDL is blocked");
add("script:wraps-missing-transaction", script.includes("wrapped-by-runner") && script.includes("applySql"), "runner wraps migration files without explicit transaction");
add("pending-semantic:script-exists", fs.existsSync(pendingSemanticPath), "dedicated pending migration semantic verifier exists");
add(
  "pending-semantic:profiles-all-nine-legacy-migrations",
  [
    "20260825123000_manju_config_control_plane.sql",
    "20260825173500_voice_atomic_authorization_purchase.sql",
    "20260827093000_skill_packages_runtime.sql",
    "20260829223000_manju_config_storage_state.sql",
    "20260902134000_skill_next_draft_cas.sql",
    "20260903021000_image_model_validation_governance.sql",
    "20260903074000_llm_stream_credit_reservations.sql",
    "20260903153500_video_fractional_duration.sql",
    "20260903212000_digital_video_dispatch_queue.sql",
  ].every((name) => pendingSemanticScript.includes(name)),
  "the nine unresolved legacy migrations are explicit verifier profiles",
);
add(
  "pending-semantic:local-read-only-fail-closed",
  pendingSemanticScript.includes("NON_LOCAL_DATABASE_READ_REFUSED")
    && pendingSemanticScript.includes('client.query("begin read only")')
    && pendingSemanticScript.includes('client.query("rollback")'),
  "semantic coverage is restricted to a loopback database and always runs in a read-only transaction",
);
add(
  "pending-semantic:checks-effective-schema-and-code",
  [
    "latestFunctionsByName",
    "tableDefinitions",
    "relrowsecurity",
    "has_table_privilege",
    "has_function_privilege",
    "pg_trigger",
    "pg_constraint",
    "pg_index",
    "bodySha256",
  ].every((item) => pendingSemanticScript.includes(item)),
  "semantic coverage compares effective columns, RLS, privileges, function bodies, triggers, constraints and indexes",
);
add(
  "pending-semantic:zero-write-receipt",
  pendingSemanticScript.includes("pending-migration-semantic-coverage-receipt")
    && pendingSemanticScript.includes("databaseWrites: 0")
    && pendingSemanticScript.includes("migrationLedgerWrites: 0")
    && pendingSemanticScript.includes("credentialsPrinted: false"),
  "coverage receipts state that database and migration-ledger writes are zero and omit credentials",
);
add("evidenced-adoption:script-exists", fs.existsSync(evidencedAdoptionPath), "dedicated evidence-only ledger adoption tool exists");
add(
  "evidenced-adoption:local-target-is-hard-limited",
  evidencedAdoptionScript.includes('const EXPECTED_TARGET_HOST = "127.0.0.1"')
    && evidencedAdoptionScript.includes("const EXPECTED_TARGET_PORT = 54322")
    && evidencedAdoptionScript.includes("NON_LOCAL_DATABASE_WRITE_REFUSED")
    && evidencedAdoptionScript.includes("LIVE_DATABASE_TARGET_MISMATCH"),
  "evidenced adoption can write only to the named local loopback database service",
);
add(
  "evidenced-adoption:requires-cryptographic-evidence",
  [
    "--confirm-coverage-file-sha256",
    "--confirm-application-file-sha256",
    "--confirm-backup-receipt-file-sha256",
    "--confirm-backup-archive-sha256",
    "--confirm-manifest-sha256",
    "--confirm-target-fingerprint",
  ].every((item) => evidencedAdoptionScript.includes(item)),
  "coverage, application, backup, manifest and target evidence all require explicit SHA confirmations",
);
add(
  "evidenced-adoption:rechecks-semantics-without-sql-replay",
  evidencedAdoptionScript.includes("liveCoverageRecheck")
    && evidencedAdoptionScript.includes("verify0255LiveEffect")
    && evidencedAdoptionScript.includes("migrationSqlExecuted: 0")
    && !evidencedAdoptionScript.includes("client.query(applySql"),
  "historical and already-executed migrations are rechecked live without replaying migration SQL",
);
add(
  "evidenced-adoption:ledger-write-is-atomic-and-fail-closed",
  evidencedAdoptionScript.includes('await client.query("begin")')
    && evidencedAdoptionScript.includes('await client.query("commit")')
    && evidencedAdoptionScript.includes('await client.query("rollback")')
    && evidencedAdoptionScript.includes("PENDING_SET_CHANGED_BEFORE_LEDGER_WRITE")
    && evidencedAdoptionScript.includes("pg_advisory_lock")
    && evidencedAdoptionScript.includes("--execute"),
  "ledger adoption requires an explicit execute flag and repeats pending/hash checks inside one locked transaction",
);
add("reconciliation:migration-exists", fs.existsSync(reconciliationMigrationPath), `${reconciliationMigrationName} exists`);
add(
  "reconciliation:user-voices-contract-repaired-forward-only",
  [
    "ALTER COLUMN source_info SET DEFAULT '{}'::jsonb",
    "ALTER COLUMN source_info SET NOT NULL",
    "ALTER COLUMN is_active SET NOT NULL",
    "ALTER COLUMN updated_at SET NOT NULL",
  ].every((item) => reconciliationMigration.includes(item)),
  "forward migration repairs the three proven user_voices contract differences",
);
add(
  "reconciliation:reservation-aware-wallet-guard-restored",
  reconciliationMigration.includes("v_balance_before - CASE WHEN v_wallet = 'credits' THEN v_user.credits_reserved ELSE 0 END")
    && reconciliationMigration.includes("REVOKE ALL ON FUNCTION public.apply_wallet_operation_atomic")
    && reconciliationMigration.includes("TO service_role"),
  "forward migration restores reserved-credit protection and least-privilege execution",
);

add("policy:runner-registered", policy.database?.migrationRunner === "scripts/db-migration-release.mjs", "release policy points to runner");
add("policy:verification-registered", policy.database?.migrationVerification === "scripts/verify-db-migration-release.mjs", "release policy points to verifier");
add("policy:semantic-check-registered", policy.database?.migrationSemanticCheckCommand?.includes("semantic-check --write-evidence") && policy.database?.migrationSemanticCheckVersion === "catalog-and-transaction-noop.v2", "release policy registers the semantic no-op probe");
add("policy:semantic-adopt-confirmations", ["--semantic-receipt", "--confirm-semantic-receipt-sha256", "--confirm-target-fingerprint", "--confirm-target-host", "--confirm-manifest-sha256", "--confirm-backup"].every((item) => policy.database?.migrationSemanticAdoptCommand?.includes(item)), "release policy exposes only confirmed semantic adoption");
add(
  "policy:pending-semantic-check-registered",
  policy.database?.migrationPendingSemanticVerification === "scripts/verify-pending-migration-semantics.mjs"
    && policy.database?.migrationPendingSemanticCheckCommand === "node scripts/verify-pending-migration-semantics.mjs --write-evidence"
    && policy.database?.migrationPendingSemanticCheckVersion === "pending-migration-object-coverage.v1",
  "release policy registers the read-only pending-migration coverage verifier",
);
add(
  "policy:pending-reconciliation-fails-closed",
  policy.database?.migrationPendingSemanticReconciliation?.forwardMigration === reconciliationMigrationName
    && policy.database?.migrationPendingSemanticReconciliation?.executionMode === "separate-reviewed-forward-only"
    && policy.database?.migrationPendingSemanticReconciliation?.requires?.includes("explicit application authorization")
    && policy.database?.migrationPendingSemanticReconciliation?.legacyAdoptionRule === "all-nine-profiles-must-pass-after-reconciliation-before-ledger-adoption"
    && policy.database?.migrationPendingSemanticReconciliation?.evidencedAdoptionTool === "scripts/adopt-evidenced-migrations.mjs"
    && policy.database?.migrationPendingSemanticReconciliation?.evidencedAdoptionRules?.includes("migration SQL replay forbidden"),
  "forward reconciliation requires review, backup, explicit authorization and a 9/9 post-apply semantic pass before legacy ledger adoption",
);
add("policy:not-application-managed", policy.database?.applicationManagedMigrationsAllowed === false, "app runtime migrations remain forbidden");
add("policy:backup-required", policy.database?.preMigrationBackupRequired === true, "backup remains required before apply");
add(
  "policy:rollback-safety-verifier-registered",
  policy.database?.rollbackSafetyVerification === "scripts/verify-db-migration-release.mjs",
  "release policy registers rollback dependency and evidence guards",
);
add(
  "policy:durable-features-use-forward-repair",
  policy.database?.rollbackStrategies?.extraction?.mode === "forward-repair-only-after-activation"
    && policy.database?.rollbackStrategies?.digitalHuman?.mode === "forward-repair-only-after-activation",
  "durable extraction and digital-human evidence cannot be removed by an automatic rollback",
);
add(
  "rollback:llm-transactional-and-guarded",
  /^\s*(?:--[^\n]*\n\s*)*BEGIN;/iu.test(llmRollback)
    && /COMMIT;\s*$/iu.test(llmRollback)
    && llmRollback.includes("ROLLBACK_BLOCKED_LLM_DEPENDENT_MIGRATION_PRESENT")
    && llmRollback.includes("ROLLBACK_BLOCKED_LLM_EVIDENCE_EXISTS")
    && llmRollback.includes("llm_credit_reservations")
    && policy.database?.rollbackStrategies?.llm?.requiresEmptyEvidenceTables === true,
  "LLM rollback is atomic and refuses dependent migrations or durable attempt evidence",
);
add(
  "rollback:video-transactional-and-guarded",
  /^\s*(?:--[^\n]*\n\s*)*BEGIN;/iu.test(videoRollback)
    && /COMMIT;\s*$/iu.test(videoRollback)
    && videoRollback.includes("ROLLBACK_BLOCKED_VIDEO_DEPENDENT_MIGRATION_PRESENT")
    && videoRollback.includes("ROLLBACK_BLOCKED_VIDEO_TASK_EVIDENCE_EXISTS")
    && videoRollback.includes("digital_video_dispatch_jobs")
    && videoRollback.includes("digital_human_long_jobs")
    && videoRollback.includes("finalize_video_generation_failure_atomic")
    && policy.database?.rollbackStrategies?.video?.requiresEmptyTaskTable === true,
  "video rollback is atomic and refuses queue/digital-human dependents or any task evidence",
);
add(
  "rollback:refund-transactional-and-guarded",
  /^\s*(?:--[^\n]*\n\s*)*BEGIN;/iu.test(refundRollback)
    && /COMMIT;\s*$/iu.test(refundRollback)
    && refundRollback.includes("ROLLBACK_BLOCKED_PAYMENT_REFUND_EVIDENCE_EXISTS")
    && policy.database?.rollbackStrategies?.refund?.requiresEmptyEvidenceTables === true,
  "refund rollback remains atomic and refuses durable provider-refund evidence",
);
add(
  "policy:retired-aid-migration-excluded",
  policy.database?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql")
    && script.includes("excludedForwardMigrations"),
  "retired AID bridge is excluded from the current forward release set",
);

add("package:db-plan-script", pkg.scripts?.["deploy:db:plan"] === "node ./scripts/db-migration-release.mjs plan", "deploy:db:plan exists");
add("package:db-status-script", pkg.scripts?.["deploy:db:status"] === "node ./scripts/db-migration-release.mjs status", "deploy:db:status exists");
add("package:db-apply-script", pkg.scripts?.["deploy:db:apply"] === "node ./scripts/db-migration-release.mjs apply", "deploy:db:apply exists");
add("package:db-verify-script", pkg.scripts?.["deploy:db:verify"] === "node ./scripts/verify-db-migration-release.mjs", "deploy:db:verify exists");

const migrationNames = fs.readdirSync(migrationRoot)
  .filter((name) => name.toLowerCase().endsWith(".sql"))
  .sort();
const releaseMigrationNames = migrationNames.filter(
  (name) => !policy.database?.excludedForwardMigrations?.includes(name),
);
add("migrations:present", migrationNames.length >= 1, `${migrationNames.length} migration files`);
add(
  "migrations:canonical-names",
  migrationNames.every((name) => /^\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/iu.test(name)),
  "all forward migration files use timestamped canonical names",
);
add(
  "migrations:no-rollback-like-files",
  migrationNames.every((name) => !/(?:^|[._-])(?:rollback|down)(?:[._-]|$)/iu.test(name)),
  "rollback/down files are not in forward migration root",
);

const versions = migrationNames.map((name) => name.slice(0, 14));
add("migrations:unique-versions", new Set(versions).size === versions.length, "migration timestamps are unique");

const criticalMigrationOrder = policy.database?.criticalMigrationOrder || [];
const criticalMigrationPositions = criticalMigrationOrder.map((name) => releaseMigrationNames.indexOf(name));
add(
  "migrations:critical-order-complete",
  criticalMigrationOrder.length > 0
    && new Set(criticalMigrationOrder).size === criticalMigrationOrder.length
    && criticalMigrationPositions.every((position) => position >= 0)
    && criticalMigrationPositions.every((position, index) => index === 0 || position > criticalMigrationPositions[index - 1]),
  "wallet, extraction, LLM, video, digital-human and refund prerequisites are present in release order",
);

const plan = runNode(["./scripts/db-migration-release.mjs", "plan"]);
const planJson = extractJsonObject(plan.stdout);
add("runner:plan-exits-zero", plan.status === 0, plan.stderr || "plan command exits zero");
add("runner:plan-json", planJson?.mode === "plan" && planJson?.databaseWrites === 0, "plan emits redacted JSON with zero writes");
add("runner:manifest-sha", /^[a-f0-9]{64}$/u.test(planJson?.manifestSha256 || ""), "manifest sha is stable hex");
add("runner:detects-migrations", planJson?.migrationCount === releaseMigrationNames.length, `plan sees ${planJson?.migrationCount ?? "?"} release migrations`);
add(
  "runner:excludes-retired-aid-migration",
  planJson?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql")
    && !planJson?.migrations?.some((migration) => migration.name === "20260822032000_aid_integration_bridge.sql"),
  "release plan cannot apply the retired AID bridge",
);

const newestMigration = releaseMigrationNames.at(-1);
const onlyPlan = runNode(["./scripts/db-migration-release.mjs", "plan", `--only=${newestMigration}`]);
const onlyPlanJson = extractJsonObject(onlyPlan.stdout);
add("runner:only-prefix-closure-exits-zero", onlyPlan.status === 0, onlyPlan.stderr || "--only prefix closure plans safely");
add(
  "runner:only-prefix-closure-complete",
  onlyPlanJson?.migrationCount === releaseMigrationNames.length
    && onlyPlanJson?.onlySelection?.directlyMatched?.includes(newestMigration)
    && onlyPlanJson?.onlySelection?.dependencyClosureAdded?.length === releaseMigrationNames.length - 1,
  "selecting the newest migration includes every ordered prerequisite",
);

const unknownOnly = runNode(["./scripts/db-migration-release.mjs", "plan", "--only=definitely_missing_migration"]);
const unknownOnlyJson = extractJsonObject(`${unknownOnly.stderr}\n${unknownOnly.stdout}`);
add("runner:only-unknown-fails", unknownOnly.status !== 0 && /ONLY_SELECTOR_NOT_FOUND/u.test(unknownOnlyJson?.code || ""), "unknown --only selector is rejected");

const blindAdopt = runNode(["./scripts/db-migration-release.mjs", "adopt"]);
const blindAdoptJson = extractJsonObject(`${blindAdopt.stderr}\n${blindAdopt.stdout}`);
add(
  "runner:blind-adoption-fails",
  blindAdopt.status !== 0 && /SEMANTIC_RECEIPT_REQUIRED/u.test(blindAdoptJson?.code || ""),
  "adopt refuses to run without a reviewed semantic receipt",
);

const failed = checks.filter((check) => !check.passed);
const result = {
  ok: failed.length === 0,
  verifier: "db-migration-release",
  summary: { passed: checks.length - failed.length, total: checks.length },
  failed,
  checks,
  credentialsPrinted: false,
  databaseWrites: 0,
  paidModelCalls: 0,
};

console.log(JSON.stringify(result, null, 2));
assert.equal(failed.length, 0, "DB_MIGRATION_RELEASE_VERIFIER_FAILED");
