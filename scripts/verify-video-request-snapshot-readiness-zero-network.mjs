#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

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

const checkerRunIndex = canary.indexOf("report.databaseReadiness = localVideoDatabaseReadiness()");
const runtimeIndex = canary.indexOf("report.runtime = await runtimeIdentity");
const uiIndex = canary.indexOf("const uiResult = await submitVideoThroughUi");
assert.ok(checkerRunIndex > 0 && checkerRunIndex < runtimeIndex, "DATABASE_CHECKER_MUST_PRECEDE_RUNTIME_GATE");
assert.ok(runtimeIndex < uiIndex, "DATABASE_AND_RUNTIME_GATES_MUST_PRECEDE_UI_SUBMISSION");
assert.match(canary, /result\.status === 0[\s\S]+fresh[\s\S]+body\?\.target === LOCAL_DATABASE_TARGET[\s\S]+body\?\.ready === true/u);

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
    checkerIsReadOnlyAndRunsBeforeBrowserSubmission: true,
  },
}, null, 2));
