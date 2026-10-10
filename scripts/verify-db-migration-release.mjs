#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  CANONICAL_FORWARD_MIGRATION_NAME,
  forwardMigrationEntryViolations,
  isCanonicalForwardMigrationRelativePath,
  inspectForwardMigrationRoot,
  inspectGitIndexRaw,
} from "./lib/forward-migration-source-validator.mjs";

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
const videoSnapshotRollbackName = "20261010023000_video_generation_request_snapshot_v1.rollback.sql";
const videoSnapshotRollbackPath = path.join(rollbackRoot, videoSnapshotRollbackName);
const reconciliationMigrationName = "20260904031000_reconcile_pending_legacy_semantics.sql";
const reconciliationMigrationPath = path.join(migrationRoot, reconciliationMigrationName);
const semanticCatalogPath = path.join(root, "scripts", "lib", "database-semantic-catalog.mjs");
const semanticContractScriptPath = path.join(root, "scripts", "database-semantic-contract.mjs");
const semanticRepairGeneratorPath = path.join(root, "scripts", "generate-database-semantic-repair.mjs");
const semanticContractPath = path.join(root, "deploy", "policies", "database-semantic-contract.v1.json");
const semanticRepairMigrationName = "20261009030000_database_semantic_contract_repair.sql";
const semanticRepairMigrationPath = path.join(root, "deploy", "database-repairs", "20261009-production-semantic", semanticRepairMigrationName);
const ledgerReconciliationGeneratorPath = path.join(root, "scripts", "render-migration-ledger-reconciliation.mjs");
const ledgerReconciliationArtifactPath = path.join(root, "deploy", "database-repairs", "20261009-production-semantic", "20261009035000_migration_ledger_reconciliation.sql");
const h3ContractReconcilePath = path.join(migrationRoot, "20261009033000_runtime_function_contract_reconcile.sql");
const functionSecurityReconcilePath = path.join(migrationRoot, "20261009034000_runtime_function_security_reconcile.sql");

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

function runMigrationNodeWithCandidateIndex(args) {
  const prefix = "zimeiti-db-release-candidate-index-";
  const fixtureContainer = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const temporaryIndex = path.join(fixtureContainer, "index");
  try {
    const indexPathResult = spawnSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(indexPathResult.status, 0, indexPathResult.stderr || "unable to locate the real Git index");
    const realIndex = path.resolve(root, indexPathResult.stdout.trim());
    fs.copyFileSync(realIndex, temporaryIndex);
    const candidateEnv = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    const relocationPaths = (policy.database?.legacyRollbackRelocations || [])
      .flatMap((receipt) => [receipt.from, receipt.to])
      .filter((relativePath) => {
        if (fs.existsSync(path.join(root, ...relativePath.split("/")))) return true;
        const indexed = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
          cwd: root,
          encoding: "utf8",
          windowsHide: true,
          env: candidateEnv,
        });
        return indexed.status === 0;
      });
    if (relocationPaths.length > 0) {
      const staged = spawnSync("git", ["add", "-A", "--", ...relocationPaths], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        env: candidateEnv,
      });
      assert.equal(staged.status, 0, staged.stderr || "unable to prepare the temporary candidate index");
    }
    return spawnSync(process.execPath, args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: candidateEnv,
    });
  } finally {
    const resolvedContainer = path.resolve(fixtureContainer);
    assert.equal(path.dirname(resolvedContainer), path.resolve(os.tmpdir()), "candidate index cleanup escaped the OS temp root");
    assert.ok(path.basename(resolvedContainer).startsWith(prefix), "candidate index cleanup prefix mismatch");
    fs.rmSync(resolvedContainer, { recursive: true, force: true });
  }
}

function runFixtureGit(fixtureRoot, args) {
  const result = spawnSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || `fixture git ${args.join(" ")} failed`);
}

function writeFixtureFile(fixtureRoot, relativePath, value) {
  const target = path.join(fixtureRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function initializeFixtureRepository(fixtureRoot) {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  runFixtureGit(fixtureRoot, ["init", "--quiet"]);
  runFixtureGit(fixtureRoot, ["config", "user.email", "migration-fixture@example.invalid"]);
  runFixtureGit(fixtureRoot, ["config", "user.name", "Migration Fixture"]);
  runFixtureGit(fixtureRoot, ["config", "commit.gpgSign", "false"]);
}

function verifySharedForwardRootAdversarialFixtures() {
  const prefix = "zimeiti-forward-root-validator-";
  const fixtureContainer = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    const outsideProject = path.join(fixtureContainer, "outside-project");
    const outsideMigrations = path.join(fixtureContainer, "outside-migrations");
    fs.mkdirSync(outsideProject, { recursive: true });
    writeFixtureFile(fixtureContainer, "outside-migrations/20990101000000_safe.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\n");
    const outsideReport = inspectForwardMigrationRoot({
      projectRoot: outsideProject,
      migrationRoot: outsideMigrations,
      gitIndexMode: "required",
    });
    writeFixtureFile(
      outsideProject,
      "deploy/policies/release-policy.json",
      `${JSON.stringify({ database: { migrationRoot: "supabase/migrations", rollbackRoot: "supabase/rollbacks" } })}\n`,
    );
    const outsideRunner = spawnSync(process.execPath, [
      scriptPath,
      "plan",
      `--root=${outsideProject}`,
      `--migration-root=${outsideMigrations}`,
    ], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    const noGitProject = path.join(fixtureContainer, "no-git-project");
    writeFixtureFile(noGitProject, "supabase/migrations/20990101000001_artifact.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\n");
    writeFixtureFile(
      noGitProject,
      "deploy/policies/release-policy.json",
      `${JSON.stringify({ database: { migrationRoot: "supabase/migrations", rollbackRoot: "supabase/rollbacks" } })}\n`,
    );
    const noGitRequiredReport = inspectForwardMigrationRoot({
      projectRoot: noGitProject,
      migrationRoot: path.join(noGitProject, "supabase", "migrations"),
      gitIndexMode: "required",
    });
    const noGitAutoReport = inspectForwardMigrationRoot({
      projectRoot: noGitProject,
      migrationRoot: path.join(noGitProject, "supabase", "migrations"),
      gitIndexMode: "auto",
    });
    const noGitDisabledReport = inspectForwardMigrationRoot({
      projectRoot: noGitProject,
      migrationRoot: path.join(noGitProject, "supabase", "migrations"),
      gitIndexMode: "disabled",
    });
    const noGitRunner = spawnSync(process.execPath, [scriptPath, "plan", `--root=${noGitProject}`], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    const junctionProject = path.join(fixtureContainer, "junction-project");
    const junctionTarget = path.join(fixtureContainer, "junction-target");
    fs.mkdirSync(junctionProject, { recursive: true });
    writeFixtureFile(fixtureContainer, "junction-target/migrations/20990101000001_safe.sql", "BEGIN;\nSELECT 1;\nCOMMIT;\n");
    fs.symlinkSync(junctionTarget, path.join(junctionProject, "supabase"), process.platform === "win32" ? "junction" : "dir");
    const junctionReport = inspectForwardMigrationRoot({
      projectRoot: junctionProject,
      migrationRoot: path.join(junctionProject, "supabase", "migrations"),
      gitIndexMode: "disabled",
    });
    writeFixtureFile(
      junctionProject,
      "deploy/policies/release-policy.json",
      `${JSON.stringify({ database: { migrationRoot: "supabase/migrations", rollbackRoot: "supabase/rollbacks" } })}\n`,
    );
    const junctionRunner = spawnSync(process.execPath, [scriptPath, "plan", `--root=${junctionProject}`], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    });

    const unknownRepository = path.join(fixtureContainer, "unknown-index-repository");
    initializeFixtureRepository(unknownRepository);
    const canonicalForwardBytes = "BEGIN;\nSELECT 2;\nCOMMIT;\n";
    const canonicalForwardPath = writeFixtureFile(
      unknownRepository,
      "supabase/migrations/20990101000002_safe.sql",
      canonicalForwardBytes,
    );
    const stagedModifiedPath = writeFixtureFile(
      unknownRepository,
      "supabase/migrations/20990101000003_staged_modify.sql",
      "BEGIN;\nSELECT 3;\nCOMMIT;\n",
    );
    writeFixtureFile(
      unknownRepository,
      "supabase/migrations/20990101000004_staged_delete.sql",
      "BEGIN;\nSELECT 4;\nCOMMIT;\n",
    );
    writeFixtureFile(
      unknownRepository,
      "supabase/migrations/20990101000005_staged_rename.sql",
      "BEGIN;\nSELECT 5;\nCOMMIT;\n",
    );
    writeFixtureFile(
      unknownRepository,
      "supabase/migrations/unknown/20990101000006_unknown.rollback.sql",
      "BEGIN;\nSELECT 6;\nCOMMIT;\n",
    );
    runFixtureGit(unknownRepository, ["add", "--", "supabase/migrations"]);
    runFixtureGit(unknownRepository, ["commit", "--quiet", "-m", "fixture"]);
    fs.appendFileSync(stagedModifiedPath, "-- staged modified\n");
    runFixtureGit(unknownRepository, ["add", "--", "supabase/migrations/20990101000003_staged_modify.sql"]);
    runFixtureGit(unknownRepository, ["rm", "--quiet", "--", "supabase/migrations/20990101000004_staged_delete.sql"]);
    runFixtureGit(unknownRepository, [
      "mv",
      "--",
      "supabase/migrations/20990101000005_staged_rename.sql",
      "supabase/migrations/20990101000007_renamed.sql",
    ]);
    runFixtureGit(unknownRepository, ["rm", "--quiet", "--", "supabase/migrations/unknown/20990101000006_unknown.rollback.sql"]);
    const stagedChangesReport = inspectForwardMigrationRoot({
      projectRoot: unknownRepository,
      migrationRoot: path.join(unknownRepository, "supabase", "migrations"),
      gitIndexMode: "required",
    });
    fs.appendFileSync(canonicalForwardPath, "-- modified after index\n");
    const worktreeModifiedReport = inspectForwardMigrationRoot({
      projectRoot: unknownRepository,
      migrationRoot: path.join(unknownRepository, "supabase", "migrations"),
      gitIndexMode: "required",
    });
    fs.rmSync(canonicalForwardPath);
    const worktreeDeletedReport = inspectForwardMigrationRoot({
      projectRoot: unknownRepository,
      migrationRoot: path.join(unknownRepository, "supabase", "migrations"),
      gitIndexMode: "required",
    });

    const unbornRepository = path.join(fixtureContainer, "unborn-repository");
    initializeFixtureRepository(unbornRepository);
    writeFixtureFile(unbornRepository, "supabase/migrations/20990101000008_unborn.sql", "BEGIN;\nSELECT 8;\nCOMMIT;\n");
    const unbornReport = inspectForwardMigrationRoot({
      projectRoot: unbornRepository,
      migrationRoot: path.join(unbornRepository, "supabase", "migrations"),
      gitIndexMode: "required",
    });

    const receiptRepository = path.join(fixtureContainer, "receipt-index-repository");
    initializeFixtureRepository(receiptRepository);
    writeFixtureFile(receiptRepository, "supabase/migrations/20990101000004_safe.sql", "BEGIN;\nSELECT 4;\nCOMMIT;\n");
    const legacyName = "20990101000005_legacy.rollback.sql";
    const legacyBytes = Buffer.from("BEGIN;\nSELECT 5;\nCOMMIT;\n", "utf8");
    const legacySource = writeFixtureFile(receiptRepository, `supabase/migrations/rollback/${legacyName}`, legacyBytes);
    runFixtureGit(receiptRepository, ["add", "--", "supabase/migrations"]);
    runFixtureGit(receiptRepository, ["commit", "--quiet", "-m", "fixture"]);
    fs.mkdirSync(path.join(receiptRepository, "supabase", "rollbacks"), { recursive: true });
    const legacyTarget = path.join(receiptRepository, "supabase", "rollbacks", legacyName);
    runFixtureGit(receiptRepository, [
      "mv",
      "--",
      path.relative(receiptRepository, legacySource).split(path.sep).join("/"),
      path.relative(receiptRepository, legacyTarget).split(path.sep).join("/"),
    ]);
    fs.rmdirSync(path.dirname(legacySource));
    writeFixtureFile(receiptRepository, "supabase/migrations/20990101000006_untracked_new.sql", "BEGIN;\nSELECT 6;\nCOMMIT;\n");
    const exactReceipt = {
      from: `supabase/migrations/rollback/${legacyName}`,
      to: `supabase/rollbacks/${legacyName}`,
      sha256: crypto.createHash("sha256").update(legacyBytes).digest("hex"),
    };
    const receiptReport = inspectForwardMigrationRoot({
      projectRoot: receiptRepository,
      migrationRoot: path.join(receiptRepository, "supabase", "migrations"),
      rollbackRoot: path.join(receiptRepository, "supabase", "rollbacks"),
      legacyRollbackRelocations: [exactReceipt],
      gitIndexMode: "required",
    });
    const receiptMissingPolicyReport = inspectForwardMigrationRoot({
      projectRoot: receiptRepository,
      migrationRoot: path.join(receiptRepository, "supabase", "migrations"),
      rollbackRoot: path.join(receiptRepository, "supabase", "rollbacks"),
      legacyRollbackRelocations: [],
      gitIndexMode: "required",
    });
    runFixtureGit(receiptRepository, ["add", "--all"]);
    runFixtureGit(receiptRepository, ["commit", "--quiet", "-m", "commit receipt relocation"]);
    const committedReceiptReport = inspectForwardMigrationRoot({
      projectRoot: receiptRepository,
      migrationRoot: path.join(receiptRepository, "supabase", "migrations"),
      rollbackRoot: path.join(receiptRepository, "supabase", "rollbacks"),
      legacyRollbackRelocations: [exactReceipt],
      gitIndexMode: "required",
    });
    fs.appendFileSync(legacyTarget, "-- tampered\n");
    runFixtureGit(receiptRepository, ["add", "--all"]);
    runFixtureGit(receiptRepository, ["commit", "--quiet", "-m", "tamper committed receipt"]);
    const tamperedReceiptReport = inspectForwardMigrationRoot({
      projectRoot: receiptRepository,
      migrationRoot: path.join(receiptRepository, "supabase", "migrations"),
      rollbackRoot: path.join(receiptRepository, "supabase", "rollbacks"),
      legacyRollbackRelocations: [exactReceipt],
      gitIndexMode: "required",
    });

    return {
      outsideRejected: !outsideReport.valid
        && outsideReport.rootErrors.includes("MIGRATION_ROOT_OUTSIDE_PROJECT_ROOT")
        && outsideRunner.status !== 0
        && `${outsideRunner.stdout}\n${outsideRunner.stderr}`.includes("MIGRATION_ROOT_OUTSIDE_PROJECT_ROOT"),
      noGitRequiredRejected: !noGitRequiredReport.valid
        && noGitRequiredReport.rootErrors.includes("GIT_INDEX_UNREADABLE")
        && !noGitAutoReport.valid
        && noGitAutoReport.rootErrors.includes("GIT_INDEX_MODE_INVALID")
        && noGitDisabledReport.valid
        && noGitRunner.status !== 0
        && `${noGitRunner.stdout}\n${noGitRunner.stderr}`.includes("GIT_INDEX_UNREADABLE"),
      ancestorJunctionRejected: !junctionReport.valid
        && junctionReport.rootErrors.some((error) => error.startsWith("MIGRATION_PATH_SYMLINK_OR_REPARSE_POINT:"))
        && junctionRunner.status !== 0
        && `${junctionRunner.stdout}\n${junctionRunner.stderr}`.includes("MIGRATION_PATH_SYMLINK_OR_REPARSE_POINT"),
      gitThreeLayerDriftRejected: !stagedChangesReport.valid
        && stagedChangesReport.rootErrors.includes("GIT_HEAD_INDEX_DRIFT")
        && stagedChangesReport.rootErrors.includes("GIT_INDEX_NON_CANONICAL_PATH")
        && stagedChangesReport.gitIndex.stagedChangePaths.some((entry) => entry.endsWith("20990101000003_staged_modify.sql"))
        && stagedChangesReport.gitIndex.stagedChangePaths.some((entry) => entry.endsWith("20990101000004_staged_delete.sql"))
        && stagedChangesReport.gitIndex.stagedChangePaths.some((entry) => entry.endsWith("20990101000005_staged_rename.sql"))
        && !worktreeModifiedReport.valid
        && worktreeModifiedReport.rootErrors.includes("GIT_INDEX_WORKTREE_DRIFT")
        && !worktreeDeletedReport.valid
        && worktreeDeletedReport.rootErrors.includes("GIT_INDEX_WORKTREE_DRIFT")
        && !unbornReport.valid
        && unbornReport.rootErrors.includes("GIT_HEAD_UNBORN"),
      exactReceiptAccepted: receiptReport.valid
        && receiptReport.gitIndex.legacyTombstonePaths.length === 1
        && receiptReport.gitIndex.trackedForwardPaths.length === 1
        && receiptReport.gitIndex.untrackedNewForwardPaths.length === 1
        && receiptReport.gitIndex.uncoveredForwardPaths.length === 0
        && committedReceiptReport.valid
        && committedReceiptReport.gitIndex.legacyTombstonePaths.length === 1
        && !receiptMissingPolicyReport.valid
        && receiptMissingPolicyReport.gitIndex.legacyTombstonePaths.length === 0
        && !tamperedReceiptReport.valid
        && tamperedReceiptReport.rootErrors.includes("GIT_INDEX_LEGACY_TOMBSTONE_INVALID"),
    };
  } finally {
    const resolvedContainer = path.resolve(fixtureContainer);
    assert.equal(path.dirname(resolvedContainer), path.resolve(os.tmpdir()), "fixture cleanup escaped the OS temp root");
    assert.ok(path.basename(resolvedContainer).startsWith(prefix), "fixture cleanup prefix mismatch");
    fs.rmSync(resolvedContainer, { recursive: true, force: true });
  }
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
const videoSnapshotRollback = read(videoSnapshotRollbackPath);
const semanticCatalog = read(semanticCatalogPath);
const semanticContractScript = read(semanticContractScriptPath);
const semanticRepairGenerator = read(semanticRepairGeneratorPath);
const semanticRepairMigration = read(semanticRepairMigrationPath);
const ledgerReconciliationGenerator = read(ledgerReconciliationGeneratorPath);
const ledgerReconciliationArtifact = read(ledgerReconciliationArtifactPath);
const h3ContractReconcile = read(h3ContractReconcilePath);
const functionSecurityReconcile = read(functionSecurityReconcilePath);
const semanticContract = json(semanticContractPath);
const policy = json(policyPath);
const pkg = json(packagePath);

add("script:exists", fs.existsSync(scriptPath), "scripts/db-migration-release.mjs exists");
add(
  "script:uses-shared-forward-root-validator",
  script.includes("./lib/forward-migration-source-validator.mjs")
    && script.includes("assertForwardMigrationRoot")
    && script.includes('gitIndexMode: "required"')
    && !script.includes('gitIndexMode: "auto"'),
  "production runner imports the shared validator and requires a readable committed Git checkout",
);
add(
  "script:validates-forward-root-before-env-load",
  script.indexOf("validateForwardMigrationSource();") >= 0
    && script.indexOf("validateForwardMigrationSource();") < script.indexOf("dotenv.config"),
  "invalid migration source is rejected before local environment secrets are loaded",
);
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
add(
  "script:failure-reports-committed-progress",
  ["committedMigrationCount", "ledgerRecordedCount", "committedButUnrecorded", "failedMigration", "failedStage"].every((item) => script.includes(item)),
  "apply failures disclose committed SQL and ledger progress instead of claiming zero writes",
);
add(
  "script:destructive-detector-is-statement-scoped",
  script.includes('expression: /^\\s*TRUNCATE\\b/imu') && script.includes('expression: /^\\s*DROP\\s+TABLE\\b/imu'),
  "GRANT TRUNCATE is not misclassified as a destructive TRUNCATE statement",
);
add("semantic-contract:catalog-exists", fs.existsSync(semanticCatalogPath), "normalized PostgreSQL semantic catalog exists");
add(
  "semantic-contract:catalog-covers-runtime-security",
  ["constraints", "indexes", "functions", "policies", "triggers", "sequences", "table-privileges", "function-privileges"].every((item) => semanticCatalog.includes(`name: "${item}"`)),
  "semantic contract covers data integrity, runtime behavior, RLS and grants",
);
add(
  "semantic-contract:verifier-fails-closed",
  semanticContractScript.includes("DATABASE_SEMANTIC_CONTRACT_INTEGRITY_FAILED")
    && semanticContractScript.includes("process.exitCode = 1")
    && semanticContractScript.includes("blockingCount"),
  "semantic verifier validates contract integrity and fails on blocking drift",
);
add(
  "semantic-repair:generator-has-target-safety",
  semanticRepairGenerator.includes("REMOTE_TARGET_REQUIRES_ALLOW_REMOTE_TARGET")
    && semanticRepairGenerator.includes("REFERENCE_AND_TARGET_DATABASE_MUST_DIFFER")
    && semanticRepairGenerator.includes("OUTPUT_PATH_OUTSIDE_PROJECT"),
  "repair generation refuses same-database and accidental remote targets",
);
add(
  "semantic-repair:migration-is-transactional-forward-repair",
  /^\s*(?:--[^\n]*\n\s*)*BEGIN;/iu.test(semanticRepairMigration)
    && /COMMIT;\s*$/iu.test(semanticRepairMigration)
    && !/^\s*(?:DROP\s+TABLE|TRUNCATE|DELETE\s+FROM)\b/imu.test(semanticRepairMigration)
    && semanticRepairMigration.includes("VALIDATE CONSTRAINT")
    && semanticRepairMigration.includes("ENABLE ROW LEVEL SECURITY"),
  "semantic repair is one transaction, preserves business rows and validates constraints",
);
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
add(
  "policy:semantic-contract-registered",
  policy.database?.semanticContract === "deploy/policies/database-semantic-contract.v1.json"
    && policy.database?.semanticContractVerification === "scripts/database-semantic-contract.mjs"
    && policy.database?.semanticRepairRoot === "deploy/database-repairs/20261009-production-semantic"
    && policy.database?.semanticRepairMigration === `deploy/database-repairs/20261009-production-semantic/${semanticRepairMigrationName}`
    && policy.database?.semanticRepairExecutionMode === "full-data-candidate-first-then-reviewed-forward-only",
  "release policy requires semantic contract verification and a full-data candidate rehearsal",
);
add(
  "policy:ledger-reconciliation-is-semantic-and-fail-closed",
  policy.database?.migrationLedgerReconciliation?.generator === "scripts/render-migration-ledger-reconciliation.mjs"
    && policy.database?.migrationLedgerReconciliation?.artifact === "deploy/database-repairs/20261009-production-semantic/20261009035000_migration_ledger_reconciliation.sql"
    && policy.database?.migrationLedgerReconciliation?.executionMode === "semantic-contract-pass-then-single-transaction"
    && policy.database?.migrationLedgerReconciliation?.migrationSqlReplayAllowed === false,
  "legacy production ledgers may be adopted only after the exact semantic contract passes",
);
add(
  "ledger-reconciliation:generator-and-artifact-guards",
  ledgerReconciliationGenerator.includes("SEMANTIC_CONTRACT_MIGRATION_MANIFEST_MISMATCH")
    && ledgerReconciliationArtifact.includes("LEDGER_RECONCILIATION_EXPECTED_DATABASE_REQUIRED")
    && ledgerReconciliationArtifact.includes("LEDGER_RECONCILIATION_HASH_DRIFT")
    && ledgerReconciliationArtifact.includes("pg_advisory_xact_lock")
    && ledgerReconciliationArtifact.includes("Migration SQL is not replayed"),
  "ledger reconciliation is generated, target-bound, hash-safe and transaction-locked",
);
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
  "rollback:video-snapshot-canonical-byte-exact-and-guarded",
  !fs.existsSync(path.join(migrationRoot, "rollback", videoSnapshotRollbackName))
    && crypto.createHash("sha256").update(videoSnapshotRollback, "utf8").digest("hex") === "edf1fd423c6199c0267cc15104d9ce93e15fba267c3a4ae64450c75c0b048a72"
    && /^\s*(?:--[^\n]*\n\s*)*BEGIN;/iu.test(videoSnapshotRollback)
    && /COMMIT;\s*$/iu.test(videoSnapshotRollback)
    && videoSnapshotRollback.includes("VIDEO_REQUEST_SNAPSHOT_ROLLBACK_EXPLICIT_CONFIRMATION_REQUIRED")
    && videoSnapshotRollback.includes("VIDEO_REQUEST_SNAPSHOT_ROLLBACK_WOULD_DELETE_HISTORY"),
  "video snapshot rollback exists only at rollbackRoot, is byte-exact, transactional and refuses destructive history loss",
);
add(
  "policy:retired-aid-migration-excluded",
  policy.database?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql")
    && script.includes("excludedForwardMigrations"),
  "retired AID bridge is excluded from the current forward release set",
);
add(
  "policy:invalid-historical-assignment-migration-excluded",
  policy.database?.excludedForwardMigrations?.includes("20260923190000_workspace_model_explicit_assignments.sql")
    && /invalid CASE syntax/iu.test(policy.database?.excludedForwardMigrationReasons?.["20260923190000_workspace_model_explicit_assignments.sql"] || ""),
  "invalid superseded historical DML is retained as evidence but cannot be replayed",
);
add(
  "policy:superseded-h3-revenue-migration-excluded",
  policy.database?.excludedForwardMigrations?.includes("20260915235500_autodl_h3_revenue_profit.sql")
    && /role-exempt billing/iu.test(policy.database?.excludedForwardMigrationReasons?.["20260915235500_autodl_h3_revenue_profit.sql"] || ""),
  "the out-of-order H3 migration cannot downgrade unified paid billing",
);
add(
  "migration:h3-contract-reconcile-preserves-paid-profit-semantics",
  h3ContractReconcile.includes("IF p_price_yuan > 0 THEN")
    && h3ContractReconcile.includes("billing_exempt")
    && h3ContractReconcile.includes("round((p_price_yuan - p_cost_price)::numeric, 12)")
    && h3ContractReconcile.includes("matched_h3_revenue"),
  "the replacement H3 migration combines safe historical repair with the final paid contract",
);
add(
  "migration:function-security-reconcile-is-explicit",
  functionSecurityReconcile.includes("DROP FUNCTION IF EXISTS public.publish_commerce_config_release_atomic(uuid, uuid)")
    && functionSecurityReconcile.includes("p.prorettype = 'trigger'::regtype")
    && functionSecurityReconcile.includes("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
    && functionSecurityReconcile.includes("GRANT EXECUTE ON FUNCTION public.claim_payment_order_creation_atomic")
    && functionSecurityReconcile.includes("GRANT EXECUTE ON FUNCTION public.ingest_external_site_monitor_probe"),
  "legacy CAS access is removed, trigger helpers are private, and server RPC grants are restored",
);

add("package:db-plan-script", pkg.scripts?.["deploy:db:plan"] === "node ./scripts/db-migration-release.mjs plan", "deploy:db:plan exists");
add("package:db-status-script", pkg.scripts?.["deploy:db:status"] === "node ./scripts/db-migration-release.mjs status", "deploy:db:status exists");
add("package:db-apply-script", pkg.scripts?.["deploy:db:apply"] === "node ./scripts/db-migration-release.mjs apply", "deploy:db:apply exists");
add("package:db-verify-script", pkg.scripts?.["deploy:db:verify"] === "node ./scripts/verify-db-migration-release.mjs", "deploy:db:verify exists");
add("package:db-semantic-verify-script", pkg.scripts?.["deploy:db:semantic:verify"] === "node ./scripts/database-semantic-contract.mjs verify", "semantic contract verifier is callable from the release workflow");

const forwardRootInspection = inspectForwardMigrationRoot({
  projectRoot: root,
  migrationRoot,
  rollbackRoot,
  legacyRollbackRelocations: policy.database?.legacyRollbackRelocations || [],
  gitIndexMode: "required",
});
const migrationNames = forwardRootInspection.entries
  .filter((entry) => entry.kind === "file")
  .map((entry) => entry.relativePath)
  .sort();
const releaseMigrationNames = migrationNames.filter(
  (name) => !policy.database?.excludedForwardMigrations?.includes(name),
);
add("migrations:present", migrationNames.length >= 1, `${migrationNames.length} migration files`);
add(
  "migrations:shared-production-root-validator",
  forwardRootInspection.valid,
  forwardRootInspection.valid
    ? "shared production validator accepted the filesystem and Git index"
    : [
      ...forwardRootInspection.rootErrors,
      ...forwardRootInspection.invalidEntries.map(({ entry, violations }) => `${entry.relativePath}:${violations.join("+")}`),
      `coverage(worktree=${migrationNames.length};tracked=${forwardRootInspection.gitIndex.trackedForwardPaths.length};stagedNew=${forwardRootInspection.gitIndex.stagedNewForwardPaths.length};untrackedNew=${forwardRootInspection.gitIndex.untrackedNewForwardPaths.length};uncovered=${forwardRootInspection.gitIndex.uncoveredForwardPaths.length};legacyRelocations=${forwardRootInspection.gitIndex.legacyTombstonePaths.length})`,
    ].join(", "),
);
add(
  "migrations:canonical-names",
  migrationNames.every((name) => CANONICAL_FORWARD_MIGRATION_NAME.test(name)),
  "all forward migration files use the exact lowercase ASCII production pattern",
);

const maliciousForwardFixtures = [
  { entry: { relativePath: "nested", kind: "directory" }, expected: "NOT_REGULAR_FILE" },
  { entry: { relativePath: "nested/20990101000000_safe.sql", kind: "file" }, expected: "NOT_TOP_LEVEL" },
  { entry: { relativePath: "20990101000001_Mixed_case.sql", kind: "file" }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "２０９９０１０１０００００２_fullwidth.sql", kind: "file" }, expected: "NFKC_NAME_DIFFERENCE" },
  { entry: { relativePath: "20990101000003_cyrillic_а.sql", kind: "file" }, expected: "NON_ASCII_NAME" },
  { entry: { relativePath: "20990101000004_down.sql", kind: "file" }, expected: "ROLLBACK_OR_DOWN_NAME" },
  { entry: { relativePath: "20990101000005_rollback.sql", kind: "file" }, expected: "ROLLBACK_OR_DOWN_NAME" },
  { entry: { relativePath: "20990101000006_safe.SQL", kind: "file" }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "20990101000007_safe-name.sql", kind: "file" }, expected: "NON_CANONICAL_FORWARD_NAME" },
  { entry: { relativePath: "20990101000008_safe.sql", kind: "symlink" }, expected: "SYMLINK_OR_REPARSE_POINT" },
  { entry: { relativePath: "20990101000009_safe.sql", kind: "other" }, expected: "NOT_REGULAR_FILE" },
];
const adversarialForwardRootFixtures = verifySharedForwardRootAdversarialFixtures();
const maliciousIndexPathFixtures = [
  "nested/20990101000000_safe.sql",
  "20990101000001_Mixed_case.sql",
  "２０９９０１０１０００００２_fullwidth.sql",
  "20990101000003_cyrillic_а.sql",
  "20990101000004_safe.sql:ads",
  "20990101000005_safe.SQL",
];
add(
  "migrations:shared-production-malicious-fixtures",
  maliciousForwardFixtures.every(({ entry, expected }) => (
    forwardMigrationEntryViolations(entry).includes(expected)
  ))
    && maliciousIndexPathFixtures.every((relativePath) => !isCanonicalForwardMigrationRelativePath(relativePath))
    && adversarialForwardRootFixtures.outsideRejected
    && adversarialForwardRootFixtures.ancestorJunctionRejected
    && adversarialForwardRootFixtures.noGitRequiredRejected,
  "the production runner requires Git while only an explicit test-only disabled mode can inspect a no-Git artifact",
);
const indexModeFixture = inspectGitIndexRaw(
  `120000 ${"a".repeat(40)} 0\tsupabase/migrations/20990101000010_safe.sql\0`,
);
add(
  "migrations:shared-production-index-mode-fixture",
  indexModeFixture.symlinkPaths.length === 1
    && indexModeFixture.nonRegularPaths.length === 1
    && indexModeFixture.parseErrors.length === 0
    && adversarialForwardRootFixtures.gitThreeLayerDriftRejected
    && adversarialForwardRootFixtures.exactReceiptAccepted,
  adversarialForwardRootFixtures.gitThreeLayerDriftRejected && adversarialForwardRootFixtures.exactReceiptAccepted
    ? "real Git fixtures reject staged modify/delete/rename, unknown nested delete, unborn HEAD and receipt-free relocation while accepting exact staged and committed legacy moves"
    : JSON.stringify(adversarialForwardRootFixtures),
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

const plan = runMigrationNodeWithCandidateIndex(["./scripts/db-migration-release.mjs", "plan"]);
const planJson = extractJsonObject(plan.stdout);
add("runner:plan-exits-zero", plan.status === 0, plan.stderr || "plan command exits zero");
add("runner:plan-json", planJson?.mode === "plan" && planJson?.databaseWrites === 0, "plan emits redacted JSON with zero writes");
add("runner:manifest-sha", /^[a-f0-9]{64}$/u.test(planJson?.manifestSha256 || ""), "manifest sha is stable hex");
add("runner:detects-migrations", planJson?.migrationCount === releaseMigrationNames.length, `plan sees ${planJson?.migrationCount ?? "?"} release migrations`);
add(
  "runner:manifest-is-bound-to-semantic-contract",
  semanticContract?.kind === "database-semantic-contract"
    && semanticContract?.profile === policy.database?.semanticContractProfile
    && semanticContract?.migrationManifestSha256 === planJson?.manifestSha256,
  "the reviewed database contract is bound to the exact migration manifest",
);
const ledgerArtifactVerification = runNode(["./scripts/render-migration-ledger-reconciliation.mjs"]);
const ledgerArtifactVerificationJson = extractJsonObject(ledgerArtifactVerification.stdout);
add(
  "runner:ledger-reconciliation-artifact-current",
  ledgerArtifactVerification.status === 0
    && ledgerArtifactVerificationJson?.mode === "verify"
    && ledgerArtifactVerificationJson?.migrationManifestSha256 === planJson?.manifestSha256
    && ledgerArtifactVerificationJson?.migrationCount === releaseMigrationNames.length,
  ledgerArtifactVerification.stderr || "ledger reconciliation artifact matches the current release manifest",
);
add(
  "runner:excludes-retired-aid-migration",
  planJson?.excludedForwardMigrations?.includes("20260822032000_aid_integration_bridge.sql")
    && !planJson?.migrations?.some((migration) => migration.name === "20260822032000_aid_integration_bridge.sql"),
  "release plan cannot apply the retired AID bridge",
);

const newestMigration = releaseMigrationNames.at(-1);
const onlyPlan = runMigrationNodeWithCandidateIndex(["./scripts/db-migration-release.mjs", "plan", `--only=${newestMigration}`]);
const onlyPlanJson = extractJsonObject(onlyPlan.stdout);
add("runner:only-prefix-closure-exits-zero", onlyPlan.status === 0, onlyPlan.stderr || "--only prefix closure plans safely");
add(
  "runner:only-prefix-closure-complete",
  onlyPlanJson?.migrationCount === releaseMigrationNames.length
    && onlyPlanJson?.onlySelection?.directlyMatched?.includes(newestMigration)
    && onlyPlanJson?.onlySelection?.dependencyClosureAdded?.length === releaseMigrationNames.length - 1,
  "selecting the newest migration includes every ordered prerequisite",
);

const unknownOnly = runMigrationNodeWithCandidateIndex(["./scripts/db-migration-release.mjs", "plan", "--only=definitely_missing_migration"]);
const unknownOnlyJson = extractJsonObject(`${unknownOnly.stderr}\n${unknownOnly.stdout}`);
add("runner:only-unknown-fails", unknownOnly.status !== 0 && /ONLY_SELECTOR_NOT_FOUND/u.test(unknownOnlyJson?.code || ""), "unknown --only selector is rejected");

const blindAdopt = runMigrationNodeWithCandidateIndex(["./scripts/db-migration-release.mjs", "adopt"]);
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
