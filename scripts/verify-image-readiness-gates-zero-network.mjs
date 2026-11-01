#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const snapshotPath = path.join(root, "scripts", "apply-image-request-snapshot-v2-local.mjs");
const workbenchPath = path.join(root, "scripts", "verify-image-workbench-live-e2e.mjs");
const snapshotMigrationPath = path.join(root, "supabase", "migrations", "20261010130000_image_generation_request_snapshot_v2.sql");
const receiptMigrationPath = path.join(root, "supabase", "migrations", "20261010133000_image_provider_dispatch_receipts.sql");
const snapshot = fs.readFileSync(snapshotPath, "utf8");
const workbench = fs.readFileSync(workbenchPath, "utf8");
const snapshotMigration = fs.readFileSync(snapshotMigrationPath, "utf8");
const receiptMigration = fs.readFileSync(receiptMigrationPath, "utf8");

assert.match(snapshot, /const OWNER_ALIGNMENT_VERSION = "20261010131000";/u);
assert.match(snapshot, /ownerAlignmentLedgerHashMatches[\s\S]+finalCombinedReady\(before\)/u);
assert.match(snapshot, /ready: ledgerHashMatches[\s\S]+&& ownerAlignmentLedgerHashMatches[\s\S]+&& finalCombinedReady\(before\)/u);
assert.match(snapshot, /snapshotMigrationSecurityReady\(after\.security, after\.tableOwner\)/u);
assert.match(snapshot, /snapshotMigrationSecurityReady\(after\.reconciliationSecurity, after\.tableOwner\)/u);
assert.match(snapshot, /to_regprocedure\('public\.reconcile_stale_image_generation_request_without_provider_receipt\(text,text,integer\)'\)/u);
assert.match(snapshot, /const PROVIDER_RECEIPTS_VERSION = "20261010133000";/u);
assert.match(snapshot, /providerReceiptsLedgerHashMatches:/u);
assert.match(snapshot, /const applyDecision = snapshotApplyDecision\(\{/u);

const bodyUtilityFunctions = snapshot.match(
  /function migrationFunctionBody[\s\S]+?function functionBodySemanticHash[\s\S]+?\n\}/u,
);
const decisionFunctions = snapshot.match(
  /function supportsV2StaleReconciliation[\s\S]+?(?=async function liveProjection)/u,
);
assert.ok(bodyUtilityFunctions, "FUNCTION_BODY_HASH_UTILITIES_REQUIRED");
assert.ok(decisionFunctions, "V2_RECONCILIATION_AND_APPLY_DECISIONS_REQUIRED");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const pure = Function(
  "assert",
  "digest",
  `"use strict"; ${bodyUtilityFunctions[0]} ${decisionFunctions[0]}; return {
    migrationFunctionBody,
    functionBodySemanticHash,
    supportsV2StaleReconciliation,
    snapshotApplyDecision,
  };`,
)(assert, digest);
const directV2Body = pure.migrationFunctionBody(
  snapshotMigration,
  "reconcile_stale_image_generation_request_atomic",
);
const receiptAwareWrapperBody = pure.migrationFunctionBody(
  receiptMigration,
  "reconcile_stale_image_generation_request_atomic",
);
const directV2BodyHash = pure.functionBodySemanticHash(directV2Body);
const receiptAwareWrapperBodyHash = pure.functionBodySemanticHash(receiptAwareWrapperBody);
const supports = (publicBody, helperBody) => pure.supportsV2StaleReconciliation(
  publicBody,
  helperBody,
  directV2BodyHash,
  receiptAwareWrapperBodyHash,
);
const receiptGuardIndex = receiptAwareWrapperBody.indexOf("if v_request.provider_dispatch_receipt is not null");
const helperCallIndex = receiptAwareWrapperBody.indexOf(
  "return public.reconcile_stale_image_generation_request_without_provider_receipt(",
);
assert.ok(receiptGuardIndex >= 0, "PROVIDER_RECEIPT_GUARD_REQUIRED");
assert.ok(helperCallIndex > receiptGuardIndex, "PROVIDER_RECEIPT_GUARD_MUST_PRECEDE_HELPER_CALL");
assert.equal(supports(directV2Body, ""), true);
assert.equal(supports(receiptAwareWrapperBody, directV2Body), true);
assert.equal(supports(receiptAwareWrapperBody, "begin return '{}'::jsonb; end;"), false);
assert.equal(supports(`begin
  /* image_generation_request_snapshot.v2 payloadFingerprint apply_wallet_operation_atomic
     provider_dispatch_receipt provider_submission_receipt provider_evidence_present
     public.reconcile_stale_image_generation_request_without_provider_receipt */
  return '{}'::jsonb;
end;`, directV2Body), false);
assert.equal(supports(receiptAwareWrapperBody.replace(
  "return public.reconcile_stale_image_generation_request_without_provider_receipt(",
  "return jsonb_build_object(",
), directV2Body), false);

assert.equal(pure.snapshotApplyDecision({
  snapshotLedgerPresent: false,
  snapshotLedgerHashMatches: false,
  providerReceiptsLedgerPresent: false,
  providerReceiptsLedgerHashMatches: false,
  snapshotReady: false,
}), "apply");
assert.equal(pure.snapshotApplyDecision({
  snapshotLedgerPresent: true,
  snapshotLedgerHashMatches: true,
  providerReceiptsLedgerPresent: true,
  providerReceiptsLedgerHashMatches: true,
  snapshotReady: true,
}), "already_applied");
assert.throws(() => pure.snapshotApplyDecision({
  snapshotLedgerPresent: true,
  snapshotLedgerHashMatches: true,
  providerReceiptsLedgerPresent: true,
  providerReceiptsLedgerHashMatches: true,
  snapshotReady: false,
}), /IMAGE_SNAPSHOT_V2_FORWARD_REPAIR_REQUIRED_AFTER_1330/u);
assert.throws(() => pure.snapshotApplyDecision({
  snapshotLedgerPresent: true,
  snapshotLedgerHashMatches: true,
  providerReceiptsLedgerPresent: false,
  providerReceiptsLedgerHashMatches: false,
  snapshotReady: false,
}), /IMAGE_SNAPSHOT_V2_FORWARD_REPAIR_REQUIRED/u);
assert.throws(() => pure.snapshotApplyDecision({
  snapshotLedgerPresent: false,
  snapshotLedgerHashMatches: false,
  providerReceiptsLedgerPresent: true,
  providerReceiptsLedgerHashMatches: true,
  snapshotReady: false,
}), /IMAGE_SNAPSHOT_V2_BASE_LEDGER_MISSING_AFTER_1330/u);
assert.throws(() => pure.snapshotApplyDecision({
  snapshotLedgerPresent: true,
  snapshotLedgerHashMatches: true,
  providerReceiptsLedgerPresent: true,
  providerReceiptsLedgerHashMatches: false,
  snapshotReady: true,
}), /PROVIDER_RECEIPTS_LEDGER_HASH_CONFLICT/u);
assert.throws(() => pure.snapshotApplyDecision({
  snapshotLedgerPresent: true,
  snapshotLedgerHashMatches: false,
  providerReceiptsLedgerPresent: false,
  providerReceiptsLedgerHashMatches: false,
  snapshotReady: true,
}), /MIGRATION_LEDGER_HASH_CONFLICT/u);

const gateIndex = workbench.indexOf("report.databaseReadiness = await readPaidDatabaseReadiness(options.paid,report.runtime)");
const runtimeNetworkIndex = workbench.indexOf("report.runtime = await runtimeIdentity(options)");
const browserIndex = workbench.indexOf("browser = await chromium.launch");
const clickIndex = workbench.indexOf("generateButton.click()");
assert.ok(gateIndex > 0, "EXECUTE_DATABASE_READINESS_GATE_REQUIRED");
assert.ok(runtimeNetworkIndex > 0 && runtimeNetworkIndex < gateIndex, "RUNTIME_IDENTITY_MUST_PRECEDE_DATABASE_GATE");
assert.ok(gateIndex < browserIndex, "DATABASE_GATE_MUST_PRECEDE_BROWSER_CREATION");
assert.ok(gateIndex < clickIndex, "DATABASE_GATE_MUST_PRECEDE_GENERATION_CLICK");
assert.match(workbench, /READINESS_CHECKERS = \[[\s\S]+apply-image-request-snapshot-v2-local\.mjs[\s\S]+apply-image-rpc-owner-alignment-local\.mjs/u);
assert.match(workbench, /snapshotSummary\.migration\.ledgerHashMatches[\s\S]+snapshotSummary\.ownerAlignmentMigration\.ledgerHashMatches[\s\S]+snapshotSummary\.finalOwnerAlignmentReady/u);

const runId = `zero_network_${process.pid}_${Date.now()}`;
const evidencePath = path.join(root, ".codex-evidence", "image-workbench-live-ui-only", runId);
assert.equal(fs.existsSync(evidencePath), false, "ZERO_NETWORK_TEST_RUN_ID_ALREADY_EXISTS");
const plan = spawnSync(process.execPath, [workbenchPath, `--run-id=${runId}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(plan.status, 0, plan.stderr);
const report = JSON.parse(plan.stdout);
assert.equal(report.mode, "plan");
assert.equal(report.networkCalls, 0);
assert.equal(report.generationPosts, 0);
assert.equal(report.providerCalls, 0);
assert.equal(report.paidCalls, 0);
assert.equal(report.filesystemWrites, 0);
assert.match(report.executePreflight, /173-ledger[\\/]+full semantic[\\/]+function authority[\\/]+REST readiness evidence/u);
assert.equal(fs.existsSync(evidencePath), false, "PLAN_MODE_MUST_NOT_WRITE_EVIDENCE");

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-source-and-plan-contract",
  databaseCalls: 0,
  networkCalls: 0,
  filesystemWritesByPlan: 0,
  semanticHashes: {
    directV2ReconciliationBody: directV2BodyHash,
    receiptAwareWrapperBody: receiptAwareWrapperBodyHash,
  },
  assertions: {
    fresh1300ApplyDoesNotRequire1310OwnerAlignment: true,
    finalReadOnlyGateRequires1300And1310HashesAndStrictOwnerAcl: true,
    executeGatePrecedesBrowserAndGenerationClick: true,
    planModeDoesNotInvokeReadinessCheckers: true,
    reconciliationBodiesMatchAuditedMigrationHashes: true,
    hollowCommentsAndHollowHelperRejected: true,
    receiptGuardPrecedesExactHelperCall: true,
    applied1330DriftRequiresForwardRepair: true,
    onlyMissing1300Without1330CanApply1300: true,
  },
}, null, 2));
