#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const target = path.join(root, "scripts", "verify-video-workbenches-user-browser-local.mjs");
const source = fs.readFileSync(target, "utf8");

for (const contract of [
  /computeLocalBuildFingerprint/u,
  /--expected-source-version=/u,
  /--expected-build-id=/u,
  /public", "version\.json/u,
  /\.next", "BUILD_ID/u,
  /\.next", "local-source-fingerprint\.v1\.json/u,
  /RUNTIME_NOT_LATEST/u,
  /EXPECTED_SOURCE_VERSION_MISMATCH/u,
  /EXPECTED_BUILD_ID_MISMATCH/u,
  /SOURCE_OR_BUILD_CHANGED_DURING_ACCEPTANCE/u,
  /READ_ONLY_ADMIN_ROLE_MUST_BE_EXPLICIT/u,
  /ACTOR_IDENTITY_CHANGED_DURING_ACCEPTANCE/u,
  /ACTOR_ROLE_CHANGED_DURING_ACCEPTANCE/u,
]) assert.match(source, contract);

const runtimeBefore = source.indexOf("report.runtimeIdentity.before = await readRuntimeIdentity()");
const browserLaunch = source.indexOf("browser = await chromium.launch");
const browserClose = source.indexOf("await context.close()");
const actorAfter = source.indexOf("report.actorIdentity.after = actorProjection");
const runtimeAfter = source.indexOf("report.runtimeIdentity.after = await readRuntimeIdentity()");
assert.ok(runtimeBefore > 0 && runtimeBefore < browserLaunch, "RUNTIME_GATE_MUST_PRECEDE_BROWSER_CREATION");
assert.ok(browserClose > browserLaunch && actorAfter > browserClose, "ACTOR_MUST_BE_RECHECKED_AFTER_BROWSER_WORK");
assert.ok(runtimeAfter > actorAfter, "RUNTIME_MUST_BE_RECHECKED_AFTER_ACTOR_AND_BROWSER_WORK");
assert.match(source, /assert\.deepEqual\(report\.runtimeIdentity\.after, report\.runtimeIdentity\.before/u);
assert.match(source, /report\.runtimeIdentity\.unchanged === true/u);
assert.match(source, /report\.actorIdentity\.unchanged === true/u);
assert.match(source, /url\.pathname === "\/api\/video\/generate"/u);
assert.match(source, /providerGenerationRequests === 0/u);
assert.match(source, /unexpectedMutations\.length === 0/u);

const runId = `video_workbenches_plan_${process.pid}_${Date.now()}`;
const evidenceDir = path.join(root, ".codex-evidence", "video-workbenches-browser-acceptance-20260904", runId);
assert.equal(fs.existsSync(evidenceDir), false, "PLAN_EVIDENCE_DIRECTORY_ALREADY_EXISTS");
const plan = spawnSync(process.execPath, [target, "--plan", `--run-id=${runId}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(plan.status, 0, plan.stderr);
const report = JSON.parse(plan.stdout);
assert.equal(report.mode, "plan");
assert.equal(report.planOnly, true);
assert.equal(report.networkCalls, 0);
assert.equal(report.databaseWrites, 0);
assert.equal(report.filesystemWrites, 0);
assert.equal(report.providerGenerationRequests, 0);
assert.deepEqual(report.requiredExecuteArguments, [
  "--expected-source-version=<sourceVersion>",
  "--expected-build-id=<buildId>",
]);
assert.equal(fs.existsSync(evidenceDir), false, "PLAN_MODE_MUST_NOT_WRITE_EVIDENCE");

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-video-workbenches-runtime-gate-contract",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWritesByPlan: 0,
  assertions: {
    expectedSourceAndBuildAreMandatory: true,
    runningLatestGatePrecedesBrowser: true,
    sourceBuildAndActorAreRecheckedAfterBrowser: true,
    adminReadOnlyRoleIsExplicit: true,
    generationPostsAndMutationsRemainZero: true,
  },
}, null, 2));
