#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const refreshPath = "scripts/refresh-database-semantic-contract-transactional.mjs";
const contractPath = "deploy/policies/database-semantic-contract.v1.json";
const before = await readFile(contractPath, "utf8");
const beforeHash = createHash("sha256").update(before).digest("hex");
const result = spawnSync(process.execPath, [refreshPath, "--self-test-rebind-manifest"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: {
    ...process.env,
    LOCAL_DATA_RUNTIME_PATH: "Z:/must-not-be-read/runtime.json",
    DEPLOY_DATABASE_URL: "postgresql://forbidden.invalid/forbidden",
    SUPABASE_DATABASE_URL: "postgresql://forbidden.invalid/forbidden",
    DATABASE_URL: "postgresql://forbidden.invalid/forbidden",
    POSTGRES_URL: "postgresql://forbidden.invalid/forbidden",
  },
});
assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout);
assert.equal(report.passed, true);
assert.equal(report.mode, "self-test-rebind-manifest");
assert.equal(report.snapshotUnchanged, true);
assert.equal(report.generatedAtUnchanged, true);
assert.equal(report.sourceLabelUnchanged, true);
assert.equal(report.unexpectedDifferenceRejected, true);
assert.equal(report.networkRequests, 0);
assert.equal(report.databaseConnections, 0);
assert.equal(report.databaseWrites, 0);
assert.equal(report.filesystemWrites, 0);
const after = await readFile(contractPath, "utf8");
assert.equal(createHash("sha256").update(after).digest("hex"), beforeHash, "SELF_TEST_MUST_NOT_WRITE_CONTRACT");

const source = await readFile(refreshPath, "utf8");
const planIndex = source.indexOf("const plan = migrationPlan();");
const helperIndex = source.indexOf("function migrationPlan()");
const selfTestIndex = source.indexOf("if (selfTestRebind) {", helperIndex);
const rebindIndex = source.indexOf("if (rebindManifestOnly) {", planIndex);
const runtimeReadIndex = source.indexOf("const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH");
const clientIndex = source.indexOf("const client = new Client");
assert.ok(selfTestIndex >= 0 && selfTestIndex < planIndex);
assert.ok(planIndex < rebindIndex && rebindIndex < runtimeReadIndex);
assert.ok(rebindIndex < clientIndex);
assert.match(source, /MANIFEST_REBIND_REQUIRES_EXACT_FLAGS/u);
assert.match(source, /UNEXPECTED_SEMANTIC_CONTRACT_REBIND_DIFFERENCE/u);
assert.match(source, /SEMANTIC_SNAPSHOT_DRIFT_FORBIDDEN/u);
assert.match(source, /SEMANTIC_GENERATED_AT_DRIFT_FORBIDDEN/u);
assert.match(source, /SEMANTIC_SOURCE_LABEL_DRIFT_FORBIDDEN/u);
assert.match(source, /else if \(!write\) \{[\s\S]*TRANSACTIONAL_SEMANTIC_REFRESH_REQUIRES_WRITE_FLAG/u);

console.log(JSON.stringify({
  passed: true,
  assertions: 23,
  selfTestContractUnchanged: true,
  unexpectedDifferenceRejected: true,
  networkRequests: 0,
  databaseConnections: 0,
  databaseWrites: 0,
  filesystemWrites: 0,
}, null, 2));
