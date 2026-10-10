#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_CHAT_STREAMING_EVIDENCE_GATE_TEST");
};

const verifierUrl = new URL("./verify-chat-streaming-experience-live.mjs", import.meta.url);
const { auditSseEvidence, buildPlanReport } = await import(verifierUrl.href);

const validEvidence = auditSseEvidence([
  { atMs: 120, ordinal: 1, bytes: 24, gapMs: 120, cumulativeContentChars: 4 },
  { atMs: 180, ordinal: 2, bytes: 32, gapMs: 60, cumulativeContentChars: 11 },
  { atMs: 420, ordinal: 10, bytes: 48, gapMs: 35, cumulativeContentChars: 29 },
]);
assert.equal(validEvidence.contentBearingSampleExists, true);
assert.equal(validEvidence.sampledNetworkHasContent, true);
assert.equal(validEvidence.chunkIntervalSampleCount, 2);
assert.equal(validEvidence.chunkIntervalSamplesAuditable, true);
assert.equal(validEvidence.passed, true);

const contentWithoutInterval = auditSseEvidence([
  { atMs: 120, ordinal: 1, bytes: 24, gapMs: 120, cumulativeContentChars: 4 },
]);
assert.equal(contentWithoutInterval.contentBearingSampleExists, true);
assert.equal(contentWithoutInterval.sampledNetworkHasContent, true);
assert.equal(contentWithoutInterval.chunkIntervalSamplesAuditable, false);
assert.equal(contentWithoutInterval.passed, false);

const intervalWithoutContent = auditSseEvidence([
  { atMs: 120, ordinal: 1, bytes: 24, gapMs: 120, cumulativeContentChars: 0 },
  { atMs: 180, ordinal: 2, bytes: 32, gapMs: 60, cumulativeContentChars: 0 },
]);
assert.equal(intervalWithoutContent.chunkIntervalSamplesAuditable, true);
assert.equal(intervalWithoutContent.contentBearingSampleExists, false);
assert.equal(intervalWithoutContent.sampledNetworkHasContent, false);
assert.equal(intervalWithoutContent.passed, false);

const malformedInterval = auditSseEvidence([
  { atMs: 120, ordinal: 1, bytes: 24, gapMs: 120, cumulativeContentChars: 4 },
  { atMs: 180, ordinal: 2, bytes: 32, gapMs: -1, cumulativeContentChars: 11 },
]);
assert.equal(malformedInterval.chunkIntervalSamplesAuditable, false);
assert.equal(malformedInterval.passed, false);

const nonMonotonicEvidence = auditSseEvidence([
  { atMs: 180, ordinal: 2, bytes: 24, gapMs: 60, cumulativeContentChars: 11 },
  { atMs: 120, ordinal: 1, bytes: 32, gapMs: 60, cumulativeContentChars: 4 },
]);
assert.equal(nonMonotonicEvidence.orderedSamplesAuditable, false);
assert.equal(nonMonotonicEvidence.chunkIntervalSamplesAuditable, false);
assert.equal(nonMonotonicEvidence.passed, false);

const plan = buildPlanReport({
  execute: false,
  expectedSourceVersion: "R_TEST",
  expectedBuildId: "BUILD_TEST",
  userId: "",
  minimumCredits: 300,
}, new Date("2026-10-10T00:00:00.000Z"));
assert.equal(plan.status, "planned");
assert.equal(plan.runtimeGate.runningLatestRequiredAtExecution, true);
assert.equal(plan.constraints.actualLlmPosts, 0);
assert.equal(plan.constraints.providerCalls, 0);
assert.equal(plan.constraints.networkRequests, 0);
assert.equal(plan.constraints.fileWrites, 0);
assert.equal(plan.constraints.databaseWrites, 0);
assert.match(plan.plan.command, /--expected-source-version=R_TEST/u);
assert.match(plan.plan.command, /--expected-build-id=BUILD_TEST/u);

const source = await readFile(verifierUrl, "utf8");
const mainIndex = source.indexOf("async function main()");
const earlyPlanIndex = source.indexOf("process.stdout.write(safeJson(buildPlanReport(options)))", mainIndex);
const firstEvidenceWriteIndex = source.indexOf("await fs.mkdir(outputDir", mainIndex);
const firstRuntimeReadIndex = source.indexOf("await fs.readFile(RUNTIME_PATH", mainIndex);
assert.ok(mainIndex >= 0 && earlyPlanIndex > mainIndex, "STATIC_PLAN_EARLY_RETURN_MISSING");
assert.ok(firstEvidenceWriteIndex > earlyPlanIndex, "PLAN_MUST_PRECEDE_EVIDENCE_DIRECTORY_WRITE");
assert.ok(firstRuntimeReadIndex > earlyPlanIndex, "PLAN_MUST_PRECEDE_RUNTIME_READ");
assert.match(source.slice(earlyPlanIndex, firstEvidenceWriteIndex), /return;/u, "STATIC_PLAN_MUST_RETURN_BEFORE_WRITES");
assert.match(source, /smoothness\.sampledNetworkHasContent && smoothness\.contentBearingSseSampleExists/u);
assert.match(source, /smoothness\.chunkIntervalSamplesAuditable && smoothness\.sseEvidencePassed/u);
assert.equal(networkCalls, 0);

process.stdout.write(`${JSON.stringify({
  passed: 35,
  failed: 0,
  validSseEvidenceAccepted: validEvidence.passed,
  missingIntervalRejected: !contentWithoutInterval.passed,
  missingContentRejected: !intervalWithoutContent.passed,
  malformedIntervalRejected: !malformedInterval.passed,
  nonMonotonicEvidenceRejected: !nonMonotonicEvidence.passed,
  staticPlanNetworkRequests: networkCalls,
  staticPlanFileWrites: plan.constraints.fileWrites,
  paidCalls: 0,
  databaseWrites: 0,
}, null, 2)}\n`);
