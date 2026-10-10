#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const target = path.join(root, "scripts", "verify-video-live-history-full-canary.mjs");
const source = fs.readFileSync(target, "utf8");
const generateRouteSource = fs.readFileSync(path.join(root, "src", "app", "api", "video", "generate", "route.ts"), "utf8");

assert.doesNotMatch(source, /client\.requestJson\(\s*["'`]\/api\/video\/generate/u);
assert.doesNotMatch(source, /fetch\(\s*["'`]\/api\/video\/generate/u);
assert.match(source, /context\.route\("\*\*\/api\/video\/generate"/u);
assert.match(source, /if \(!clickArmed \|\| continuedPosts >= 1\)/u);
assert.match(source, /clickArmed = true;[\s\S]+await generateButton\.click\(\)/u);
assert.match(source, /VIDEO_UI_GENERATION_POST_ATTEMPTS_MUST_EQUAL_ONE/u);
assert.match(source, /VIDEO_UI_GENERATION_POST_CONTINUATIONS_MUST_EQUAL_ONE/u);
assert.match(source, /VIDEO_UI_DUPLICATE_GENERATION_POST_DETECTED/u);
assert.match(source, /submissionAuthority: "browser-page-click-only"/u);
assert.match(source, /automaticRetries: 0/u);
assert.doesNotMatch(source, /LOCAL_NAV_ADMIN_TOKEN/u);
assert.match(source, /process\.env\.R267_CUSTOMER_TOKEN/u);
assert.match(source, /process\.env\.LOCAL_NAV_READONLY_CUSTOMER/u);
assert.match(source, /wrapperCustomer\?\.role, "student"/u);
assert.match(source, /identity\?\.user\?\.role, "student"/u);
assert.match(source, /identity\?\.user\?\.id, wrapperCustomer\?\.id/u);
assert.match(source, /billing\.memberStatus, "active"/u);
assert.match(source, /node scripts\/with-local-customer-session\.mjs scripts\/verify-video-live-history-full-canary\.mjs --execute/u);
assert.match(generateRouteSource, /const billingExempt = false;/u);
assert.match(source, /billingExempt: false/u);
assert.match(source, /quotedPriceYuan: model\.publicPrice/u);
assert.match(source, /VIDEO_CHARGE_QUOTE_MISMATCH/u);
assert.match(source, /FINAL_STUDENT_ROLE_REQUIRED/u);
assert.match(source, /FINAL_NON_EXEMPT_BILLING_REQUIRED/u);
assert.match(source, /FINAL_POSITIVE_QUOTED_PRICE_REQUIRED/u);
assert.match(source, /FINAL_BILLING_TASK_MISMATCH/u);
assert.match(source, /FINAL_VIDEO_MUST_NOT_CHARGE_CREDITS/u);
assert.match(source, /FINAL_VIDEO_MUST_NOT_CHANGE_RESERVED_CREDITS/u);

for (const contract of [
  /body\?\.model_id, CHEAPEST_MODEL_ID/u,
  /Number\(body\?\.duration\), DURATION_SECONDS/u,
  /body\?\.resolution, RESOLUTION/u,
  /body\?\.aspect_ratio, "16:9"/u,
  /body\?\.surface, "video-page"/u,
  /request\.headers\(\)\["idempotency-key"\], clientRequestId/u,
]) assert.match(source, contract);

assert.match(source, /EXPECTED_SOURCE_VERSION_REQUIRED/u);
assert.match(source, /EXPECTED_BUILD_ID_REQUIRED/u);
assert.match(source, /RUNTIME_NOT_LATEST/u);
assert.match(source, /VIDEO_DATABASE_SNAPSHOT_READINESS_REQUIRED/u);
assert.match(source, /report\.databaseReadiness = localVideoDatabaseReadiness\(\)/u);
assert.match(source, /readOnlyReconciliation: true[\s\S]+providerPosts: 0[\s\S]+databaseWrites: 0[\s\S]+automaticRetries: 0[\s\S]+return;\s*\} else \{/u);
assert.match(source, /const preflightResult = reconcile\s*\? \{ identity: await requireOrdinaryStudentIdentity\(client, wrapperCustomer\), model: null, billing: null \}\s*: await preflight/u);
const databaseGateIndex = source.indexOf("report.databaseReadiness.ready");
const runtimeGateIndex = source.indexOf("report.runtime = await runtimeIdentity");
const uiSubmissionIndex = source.indexOf("const uiResult = await submitVideoThroughUi");
assert.ok(databaseGateIndex > 0 && databaseGateIndex < runtimeGateIndex, "DATABASE_GATE_MUST_PRECEDE_RUNTIME_NETWORK_GATE");
assert.ok(runtimeGateIndex < uiSubmissionIndex, "RUNTIME_GATE_MUST_PRECEDE_UI_SUBMISSION");

const runId = `video_ui_plan_${process.pid}_${Date.now()}`;
const evidenceDir = path.join(root, ".codex-evidence", "video-live-history-full-canary", runId);
assert.equal(fs.existsSync(evidenceDir), false, "PLAN_TEST_EVIDENCE_ALREADY_EXISTS");
const plan = spawnSync(process.execPath, [target, `--run-id=${runId}`], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  timeout: 30_000,
});
assert.equal(plan.status, 0, plan.stderr);
const report = JSON.parse(plan.stdout);
assert.equal(report.mode, "plan");
assert.equal(report.networkCalls, 0);
assert.equal(report.databaseWrites, 0);
assert.equal(report.filesystemWrites, 0);
assert.equal(report.providerPosts, 0);
assert.equal(report.automaticRetries, 0);
assert.equal(report.databaseReadiness.ready, false);
assert.equal(report.requiredActor.role, "student");
assert.equal(report.requiredActor.billingExempt, false);
assert.match(report.executeCommand, /with-local-customer-session\.mjs/u);
assert.equal(fs.existsSync(evidenceDir), false, "PLAN_MODE_MUST_NOT_WRITE_EVIDENCE");

console.log(JSON.stringify({
  passed: true,
  mode: "zero-network-ui-only-source-and-plan-contract",
  networkCalls: 0,
  databaseCalls: 0,
  filesystemWritesByPlan: 0,
  assertions: {
    browserUiClickIsOnlySubmissionAuthority: true,
    directApiSubmissionAbsent: true,
    onePostMaximumAndZeroAutomaticRetries: true,
    expectedRuntimeAndDatabaseGatesPrecedeSubmission: true,
    databaseCheckerMustBeFreshAndReady: true,
    sameRunReconciliationIsReadOnly: true,
    ordinaryStudentWrapperIsMandatory: true,
    billingExemptIsFalseAndQuoteIsPositive: true,
    cashAndCreditsAreTaskBound: true,
  },
}, null, 2));
