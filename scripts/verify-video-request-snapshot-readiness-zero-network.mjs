#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = process.cwd();
const checkerPath = path.join(root, "scripts", "verify-video-request-snapshot-readiness-local.mjs");
const canaryPath = path.join(root, "scripts", "verify-video-live-history-full-canary.mjs");
const checker = fs.readFileSync(checkerPath, "utf8");
const canary = fs.readFileSync(canaryPath, "utf8");

assert.match(checker, /const BASE_VERSION = "20261010023000"/u);
assert.match(checker, /const ALIGNMENT_VERSION = "20261010132000"/u);
assert.match(checker, /const TARGET = "127\.0\.0\.1:54322\/zimeiti_local"/u);
assert.match(checker, /runtime\.ownerConnection\?\.host, "127\.0\.0\.1"/u);
assert.match(checker, /Number\(runtime\.ownerConnection\?\.port\), 54322/u);
assert.match(checker, /runtime\.ownerConnection\?\.database, "zimeiti_local"/u);
assert.match(checker, /createHash\("sha256"\)/u);
assert.match(checker, /supabase_migrations\.schema_migrations/u);
assert.match(checker, /ledgerHashMatches/u);
assert.match(checker, /\[BASE_VERSION, ALIGNMENT_VERSION\]/u);
assert.match(checker, /video_tasks_request_snapshot_v1_check/u);
assert.match(checker, /constraintTokens\.every/u);
assert.match(checker, /live\.snapshotCounts\.invalid === 0/u);

for (const signature of [
  "persist_video_generation_request_snapshot_v1_atomic",
  "reserve_video_generation_task_request_snapshot_v1_atomic",
  "reserve_queued_digital_video_task_request_snapshot_v1_atomic",
]) assert.match(checker, new RegExp(signature, "u"));
for (const contract of [
  /row\?\.owner === tableOwner/u,
  /row\?\.security_definer === true/u,
  /search_path=public, pg_temp/u,
  /sameMembers\(executeGrantees, \[tableOwner, "service_role"\]\)/u,
  /unexpectedEffectiveGrantees\.length === 0/u,
  /privileges\.anonExecute === false/u,
  /privileges\.authenticatedExecute === false/u,
  /privileges\.serviceExecute === true/u,
]) assert.match(checker, contract);

assert.doesNotMatch(checker, /\bfetch\s*\(/u);
assert.doesNotMatch(checker, /client\.query\(\s*["'`]\s*(?:insert|update|delete|alter|create|drop|grant|revoke|truncate)\b/iu);
assert.match(checker, /writes: 0/u);
assert.match(checker, /providerCalls: 0/u);
assert.match(checker, /billingOperations: 0/u);
assert.match(checker, /credentialsPrinted: false/u);
assert.match(checker, /passed: ready/u);

const checkerRunIndex = canary.indexOf("report.databaseReadiness = await readPaidDatabaseReadiness(paidOptions,report.runtime)");
const runtimeIndex = canary.indexOf("report.runtime = await runtimeIdentity");
const uiIndex = canary.indexOf("const uiResult = await submitVideoThroughUi");
assert.ok(runtimeIndex > 0 && runtimeIndex < checkerRunIndex, "DATABASE_READINESS_MUST_BIND_CURRENT_RUNTIME");
assert.ok(checkerRunIndex < uiIndex, "DATABASE_AND_RUNTIME_GATES_MUST_PRECEDE_UI_SUBMISSION");
assert.match(canary, /import[^\n]+readPaidDatabaseReadiness[^\n]+from ['"]\.\/verify-image-workbench-live-e2e\.mjs['"]/u);

// Execute the actual main() guard. Only its external readiness and runtime
// readers are fixtures; a rejection must prevent reaching the submission edge.
const tree = ts.createSourceFile(canaryPath, canary, ts.ScriptTarget.Latest, true);
const guards = [];
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(tree) === "execute"
    && node.thenStatement.getText(tree).includes("report.databaseReadiness = await readPaidDatabaseReadiness")) guards.push(node);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(guards.length, 1, "EXACT_ACTIVE_EXECUTE_READINESS_GUARD_REQUIRED");
const guardSource = guards[0].getText(tree);
const cases = [];
for (const failure of ["runtime", "readiness", "none"]) {
  const calls = [];
  const report = {};
  const context = {
    assert, execute: true, report, client: {}, expectedSourceVersion: "R-fixture", expectedBuildId: "fixture-build",
    SAFE_RUNTIME_ID: /^[A-Za-z0-9._-]+$/u, paidOptions: { mode: "offline-fixture" }, outputDir: "fixture-no-write",
    runtimeIdentity: async () => {
      calls.push("runtime");
      if (failure === "runtime") throw new Error("FIXTURE_RUNTIME_REJECTED");
      return { sourceVersion: "R-fixture", buildId: "fixture-build" };
    },
    readPaidDatabaseReadiness: async (options, runtime) => {
      calls.push("readiness");
      assert.equal(options.mode, "offline-fixture"); assert.equal(runtime, report.runtime);
      if (failure === "readiness") throw new Error("FIXTURE_DATABASE_REJECTED");
      return { verified: true };
    },
    ordinaryStudentBillingPolicy: async () => { calls.push("billing-policy"); return { enabled: true }; },
    saveReport: async () => { calls.push("ram-report"); },
    reachedSubmissionEdge: () => { calls.push("submission-edge"); },
    exports: {},
  };
  vm.runInNewContext(`exports.run = async () => { ${guardSource}; reachedSubmissionEdge(); };`, context);
  if (failure === "none") {
    await context.exports.run();
    assert.deepEqual(calls, ["runtime", "readiness", "billing-policy", "ram-report", "submission-edge"]);
  } else {
    await assert.rejects(() => context.exports.run(), new RegExp(failure === "runtime" ? "FIXTURE_RUNTIME_REJECTED" : "FIXTURE_DATABASE_REJECTED", "u"));
    assert.deepEqual(calls, failure === "runtime" ? ["runtime"] : ["runtime", "readiness"]);
    assert.equal(calls.includes("submission-edge"), false);
  }
  cases.push({ failure, calls });
}

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-video-database-readiness-source-contract",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWrites: 0,
  assertions: {
    exactLocalDatabaseTarget: true,
    migrationLedgerAndCurrentSqlHashRequired: true,
    liveConstraintAndThreeFunctionSemanticsRequired: true,
    strictOwnerSecurityDefinerSearchPathAndAclRequired: true,
    legacySnapshotInspectorRemainsReadOnly: true,
    activeCanonicalReadinessBindsRuntimeBeforeBrowserSubmission: true,
    rejectedReadinessCannotReachSubmission: true,
  },
  cases,
  externalReadinessReaderIsFixture: true,
}, null, 2));
