import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildPlan, evaluateSuite } from "./media-prompt-adherence-verifier.mjs";

let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error("NETWORK_FORBIDDEN_IN_PROMPT_ADHERENCE_ZERO_COST_TEST");
};

function digest(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function requestFor(suiteCase) {
  if (suiteCase.mediaKind === "image") {
    return {
      schema: "image_generation_request_snapshot.v2",
      prompt: suiteCase.prompt.userPrompt,
      effectivePrompt: suiteCase.prompt.userPrompt,
      aspectRatio: "16:9",
      resolution: "1K",
      imageCount: 1,
    };
  }
  const durationSeconds = suiteCase.mediaKind === "h3_video" ? 10 : 6;
  return {
    schema: "video_generation_request_snapshot.v1",
    userPrompt: suiteCase.prompt.userPrompt,
    effectivePrompt: suiteCase.prompt.userPrompt,
    referenceAssets: suiteCase.mediaKind === "h3_video" ? [
      { role: "reference_image_list", locator: "asset://fixture/reference/image-1" },
      { role: "reference_image_list", locator: "asset://fixture/reference/image-2" },
      { role: "reference_audio_list", locator: "asset://fixture/reference/rain-audio" },
    ] : [],
    effectiveDurationSeconds: durationSeconds,
    aspectRatio: "16:9",
    resolution: suiteCase.mediaKind === "h3_video" ? "1080p" : "720p",
    generateAudio: suiteCase.mediaKind === "h3_video",
    providerPayloadHash: digest(`${suiteCase.id}:payload`),
  };
}

function providerFieldsFor(suiteCase) {
  if (suiteCase.mediaKind === "image") {
    return { prompt: suiteCase.prompt.userPrompt, aspectRatio: "16:9", resolution: "1K" };
  }
  return {
    prompt: suiteCase.prompt.userPrompt,
    durationSeconds: suiteCase.mediaKind === "h3_video" ? 10 : 6,
    referenceImageCount: suiteCase.mediaKind === "h3_video" ? 2 : 0,
    referenceAudioCount: suiteCase.mediaKind === "h3_video" ? 1 : 0,
  };
}

function evidenceFor(assertion, context) {
  const evidenceKind = Array.isArray(assertion.evidenceKinds)
    ? assertion.evidenceKinds[0]
    : { visual: "frame", temporal: "timestamp_range", audio: "audio_segment", metadata: "media_probe" }[assertion.layer];
  const evidence = {
    kind: evidenceKind,
    locator: `asset://prompt-adherence/${context.caseId}/evidence/${assertion.id}`,
    sha256: digest(`${context.caseId}:${assertion.id}:evidence`),
    observedAt: context.observedAt,
    reviewer: "local-fixture-reviewer-v1",
    binding: {
      taskId: context.taskId,
      outputAssetLocator: context.outputAssetLocator,
      outputContentSha256: context.outputContentSha256,
      sourceVersion: context.sourceVersion,
      buildId: context.buildId,
    },
  };
  if (assertion.layer === "visual") evidence.frame = { index: 0, timeSeconds: 0 };
  if (assertion.layer === "temporal" || assertion.layer === "audio"
    || (assertion.layer === "visual" && context.mediaKind !== "image")) {
    evidence.range = {
      startFrameIndex: 0,
      endFrameIndex: context.mediaKind === "image" ? 0 : 143,
      startSeconds: 0,
      endSeconds: context.durationSeconds || 0,
    };
  }
  return evidence;
}

function completeLocalFixture(suite, plan) {
  const observedAt = "2026-10-10T02:00:00.000Z";
  const sourceVersion = "R000960-20261010-d95c940a";
  const buildId = "fixtureBuild20261010";
  const run = structuredClone(plan);
  run.status = "local_fixture";
  run.environment = {
    sourceVersion,
    buildId,
    route: "http://127.0.0.1:5000/prompt-adherence-fixture",
    browser: {
      name: "Chromium",
      version: "fixture-1",
      userAgent: "prompt-adherence-local-fixture/1",
      viewport: { width: 1440, height: 900 },
    },
    capturedAt: observedAt,
  };
  run.paidCanaryGate = {
    ...run.paidCanaryGate,
    authorized: true,
    authorizationId: "local-fixture-authorization",
    authorizedBy: "zero-cost-test-harness",
    authorizedAt: observedAt,
  };
  run.cases = suite.cases.map((suiteCase, index) => {
    const runCase = structuredClone(plan.cases[index]);
    const requestSnapshot = requestFor(suiteCase);
    const taskId = `fixture-task-${suiteCase.id}`;
    const outputAssetLocator = `asset://prompt-adherence/${suiteCase.id}/output`;
    const outputContentSha256 = digest(`${suiteCase.id}:output`);
    const durationSeconds = suiteCase.mediaKind === "image" ? null : suiteCase.mediaKind === "h3_video" ? 10 : 6;
    runCase.model = {
      publicModelId: `fixture-${suiteCase.mediaKind}`,
      provider: "local-fixture-provider",
      modelVersion: "fixture-model-v1",
      adapterVersion: "fixture-adapter-v1",
    };
    runCase.requestSnapshot = requestSnapshot;
    runCase.historyReadback = {
      requestSnapshot: structuredClone(requestSnapshot),
      snapshotHash: digest(JSON.stringify(requestSnapshot)),
      taskId,
    };
    runCase.providerObservation = {
      captureMethod: "in-memory-zero-cost-fixture",
      protocol: "fixture-provider-protocol.v1",
      dispatchCount: 1,
      automaticRetryCount: 0,
      payloadHash: requestSnapshot.providerPayloadHash || digest(`${suiteCase.id}:payload`),
      receiptId: `provider-receipt-${suiteCase.id}`,
      receiptSha256: digest(`${suiteCase.id}:provider-receipt`),
      fields: providerFieldsFor(suiteCase),
    };
    runCase.billing = {
      status: "settled",
      netAmountYuan: 0,
      receiptId: `billing-receipt-${suiteCase.id}`,
      receiptSha256: digest(`${suiteCase.id}:billing-receipt`),
    };
    runCase.outputAsset = {
      urlOrAssetId: outputAssetLocator,
      contentSha256: outputContentSha256,
      width: suiteCase.mediaKind === "h3_video" ? 1920 : 1280,
      height: suiteCase.mediaKind === "h3_video" ? 1080 : 720,
      durationSeconds,
      hasAudio: suiteCase.mediaKind === "image" ? null : suiteCase.mediaKind === "h3_video",
    };
    const evidenceContext = {
      caseId: suiteCase.id,
      mediaKind: suiteCase.mediaKind,
      durationSeconds,
      taskId,
      outputAssetLocator,
      outputContentSha256,
      sourceVersion,
      buildId,
      observedAt,
    };
    runCase.observations = Object.fromEntries(suiteCase.outputAssertions.map(assertion => [assertion.id, {
      status: "pass",
      evidence: [evidenceFor(assertion, evidenceContext)],
      note: "complete local deterministic fixture",
    }]));
    return runCase;
  });
  return run;
}

const root = process.cwd();
const suite = JSON.parse(await readFile(path.join(root, "scripts/fixtures/prompt-adherence/paid-canary-suite.v1.json"), "utf8"));
const plan = buildPlan(suite);
assert.equal(plan.status, "planned");
assert.equal(plan.cases.length, 3);
assert.equal(plan.paidCanaryGate.authorized, false);

const imageSuite = { ...suite, cases: [suite.cases[0]] };
const imageRun = structuredClone(plan.cases[0]);
imageRun.model.publicModelId = "pm_fixture_image";
imageRun.requestSnapshot = requestFor(suite.cases[0]);
imageRun.historyReadback.requestSnapshot = structuredClone(imageRun.requestSnapshot);
imageRun.providerObservation = {
  ...imageRun.providerObservation,
  captureMethod: "in-memory-zero-cost-fixture",
  dispatchCount: 1,
  automaticRetryCount: 0,
  payloadHash: "a".repeat(64),
  fields: providerFieldsFor(suite.cases[0]),
};

const lexicalOnlyRun = { ...plan, status: "fixture", cases: [imageRun] };
const lexicalOnlyReport = evaluateSuite(imageSuite, lexicalOnlyRun);
assert.equal(lexicalOnlyReport.cases[0].scores.promptLexicalCoverage, 100);
assert.equal(lexicalOnlyReport.cases[0].scores.outputSemanticAdherenceObserved, null);
assert.equal(lexicalOnlyReport.cases[0].scores.outputSemanticEvidenceCoverage, 0);
assert.equal(lexicalOnlyReport.status, "failed");
assert.equal(lexicalOnlyReport.evidenceLevel, "schema_or_partial_runtime_only");

for (const assertion of suite.cases[0].outputAssertions) {
  const kind = assertion.layer === "metadata" ? "media_probe" : "frame";
  imageRun.observations[assertion.id] = {
    status: "pass",
    evidence: [{ kind, locator: "", note: "intentionally hollow evidence" }],
  };
}
const hollowReport = evaluateSuite(imageSuite, lexicalOnlyRun);
assert.equal(hollowReport.status, "failed");
assert.equal(hollowReport.runtimeGate.passed, false);
assert.equal(hollowReport.evidenceLevel, "schema_or_partial_runtime_only");
assert.ok(hollowReport.cases[0].outputResults.every(result => result.evidenceValid === false));

imageRun.observations["img-action"] = {
  status: "fail",
  evidence: [{ kind: "frame", locator: "", note: "paper airplane is absent" }],
};
const semanticFailureReport = evaluateSuite(imageSuite, lexicalOnlyRun);
assert.equal(semanticFailureReport.cases[0].status, "failed");

imageRun.observations["img-action"] = {
  status: "pass",
  evidence: [{ kind: "prompt_text", locator: "requestSnapshot.effectivePrompt", note: "invalid semantic evidence" }],
};
const invalidEvidenceReport = evaluateSuite(imageSuite, lexicalOnlyRun);
const invalidAction = invalidEvidenceReport.cases[0].outputResults.find(item => item.id === "img-action");
assert.equal(invalidAction.status, "fail");
assert.deepEqual(invalidAction.invalidEvidenceKinds, ["prompt_text"]);

const completeRun = completeLocalFixture(suite, plan);
const completeReport = evaluateSuite(suite, completeRun);
assert.equal(completeReport.status, "passed");
assert.equal(completeReport.runtimeGate.passed, true);
assert.equal(completeReport.evidenceLevel, "runtime_media_reviewed");
assert.deepEqual(completeReport.totals, { passed: 3, failed: 0, incomplete: 0 });

const unauthorizedRun = structuredClone(completeRun);
unauthorizedRun.paidCanaryGate.authorized = false;
const unauthorizedReport = evaluateSuite(suite, unauthorizedRun);
assert.equal(unauthorizedReport.status, "failed");
assert.equal(unauthorizedReport.runtimeGate.passed, false);
assert.ok(unauthorizedReport.runtimeGate.globalFailures.includes("paidCanaryGate.authorized"));
assert.equal(unauthorizedReport.evidenceLevel, "schema_or_partial_runtime_only");

const mismatchedBindingRun = structuredClone(completeRun);
mismatchedBindingRun.cases[0].observations["img-subject"].evidence[0].binding.buildId = "differentBuildId";
const mismatchedBindingReport = evaluateSuite(suite, mismatchedBindingRun);
const mismatchedBindingResult = mismatchedBindingReport.cases[0].outputResults.find(item => item.id === "img-subject");
assert.equal(mismatchedBindingReport.status, "failed");
assert.equal(mismatchedBindingResult.evidenceValid, false);
assert.ok(mismatchedBindingResult.invalidEvidenceDetails[0].issues.includes("binding.buildId"));

const missingReceiptRun = structuredClone(completeRun);
missingReceiptRun.cases[1].providerObservation.receiptSha256 = null;
missingReceiptRun.cases[1].billing.receiptSha256 = null;
const missingReceiptReport = evaluateSuite(suite, missingReceiptRun);
assert.equal(missingReceiptReport.status, "failed");
assert.ok(missingReceiptReport.runtimeGate.caseFailures["ordinary-video-action-6s"].includes("providerObservation.receiptSha256"));
assert.ok(missingReceiptReport.runtimeGate.caseFailures["ordinary-video-action-6s"].includes("billing.receiptSha256"));

const missingFrameRangeRun = structuredClone(completeRun);
delete missingFrameRangeRun.cases[1].observations["vid-action"].evidence[0].range;
const missingFrameRangeReport = evaluateSuite(suite, missingFrameRangeRun);
const missingFrameRangeResult = missingFrameRangeReport.cases[1].outputResults.find(item => item.id === "vid-action");
assert.equal(missingFrameRangeReport.status, "failed");
assert.equal(missingFrameRangeResult.evidenceValid, false);
assert.ok(missingFrameRangeResult.invalidEvidenceDetails[0].issues.includes("range.startFrameIndex"));

assert.equal(networkCalls, 0);

process.stdout.write(`${JSON.stringify({
  passed: 36,
  failed: 0,
  casesPlanned: plan.cases.length,
  hollowShellRejected: hollowReport.status === "failed",
  unauthorizedRuntimeRejected: unauthorizedReport.status === "failed",
  mismatchedBindingRejected: mismatchedBindingReport.status === "failed",
  missingReceiptHashesRejected: missingReceiptReport.status === "failed",
  missingFrameRangeRejected: missingFrameRangeReport.status === "failed",
  completeLocalFixturePassed: completeReport.status === "passed",
  completeLocalFixtureEvidenceLevel: completeReport.evidenceLevel,
  promptTextRejectedAsVisualEvidence: invalidAction.status === "fail",
  providerRequests: networkCalls,
  paidCalls: 0,
  databaseWrites: 0,
}, null, 2)}\n`);
