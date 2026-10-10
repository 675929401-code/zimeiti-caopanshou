import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUITE_SCHEMA = "media_prompt_adherence_suite.v1";
const RUN_SCHEMA = "media_prompt_adherence_run.v1";
const ALLOWED_MEDIA_KINDS = new Set(["image", "ordinary_video", "h3_video"]);
const ALLOWED_LAYERS = new Set(["visual", "temporal", "audio", "metadata"]);
const ALLOWED_STATUSES = new Set(["pass", "fail", "unobservable", "not_run"]);
const SOURCE_VERSION_PATTERN = /^R\d{6}-\d{8}-[a-f0-9]{8}$/u;
const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{8,}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const VOLATILE_LOCATOR_QUERY_PATTERN = /(?:^|[?&])(token|signature|sig|expires|x-amz-|x-cos-|credential|authorization)=/iu;
const EVIDENCE_BY_LAYER = {
  visual: new Set(["frame", "human_review", "multimodal_review"]),
  temporal: new Set(["timestamp_range", "human_review", "multimodal_review"]),
  audio: new Set(["audio_segment", "media_probe", "human_review", "multimodal_review"]),
  metadata: new Set(["media_probe"]),
};

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stable(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function validIsoTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function validRuntimeUrl(value) {
  if (!nonEmptyString(value)) return false;
  try {
    const parsed = new URL(value);
    return ["http:", "https:"].includes(parsed.protocol)
      && nonEmptyString(parsed.hostname)
      && parsed.username === ""
      && parsed.password === "";
  } catch {
    return false;
  }
}

function stableLocator(value) {
  if (!nonEmptyString(value) || /^(?:blob|data):/iu.test(value)) return false;
  return !VOLATILE_LOCATOR_QUERY_PATTERN.test(value);
}

function validBrowserIdentity(value) {
  const browser = object(value);
  const viewport = object(browser.viewport);
  return nonEmptyString(browser.name)
    && nonEmptyString(browser.version)
    && nonEmptyString(browser.userAgent)
    && Number.isInteger(viewport.width)
    && viewport.width > 0
    && Number.isInteger(viewport.height)
    && viewport.height > 0;
}

function addFailure(failures, condition, code) {
  if (!condition) failures.push(code);
}

function validateRuntimeEnvelope(runInput, suite) {
  const run = object(runInput);
  const environment = object(run.environment);
  const gate = object(run.paidCanaryGate);
  const globalFailures = [];
  addFailure(globalFailures, SOURCE_VERSION_PATTERN.test(String(environment.sourceVersion || "")), "environment.sourceVersion");
  addFailure(globalFailures, BUILD_ID_PATTERN.test(String(environment.buildId || "")), "environment.buildId");
  addFailure(globalFailures, validRuntimeUrl(environment.route), "environment.route");
  addFailure(globalFailures, validBrowserIdentity(environment.browser), "environment.browser");
  addFailure(globalFailures, validIsoTimestamp(environment.capturedAt), "environment.capturedAt");
  addFailure(globalFailures, gate.authorized === true, "paidCanaryGate.authorized");
  addFailure(globalFailures, nonEmptyString(gate.authorizationId), "paidCanaryGate.authorizationId");
  addFailure(globalFailures, nonEmptyString(gate.authorizedBy), "paidCanaryGate.authorizedBy");
  addFailure(globalFailures, validIsoTimestamp(gate.authorizedAt), "paidCanaryGate.authorizedAt");

  const runCases = new Map((Array.isArray(run.cases) ? run.cases : []).map(item => [item?.caseId, item]));
  const byCase = {};
  for (const suiteCase of suite.cases) {
    const failures = [];
    const runCase = object(runCases.get(suiteCase.id));
    const model = object(runCase.model);
    const history = object(runCase.historyReadback);
    const provider = object(runCase.providerObservation);
    const billing = object(runCase.billing);
    const output = object(runCase.outputAsset);

    addFailure(failures, nonEmptyString(model.publicModelId), "model.publicModelId");
    addFailure(failures, nonEmptyString(model.provider), "model.provider");
    addFailure(failures, nonEmptyString(model.modelVersion), "model.modelVersion");
    addFailure(failures, nonEmptyString(model.adapterVersion), "model.adapterVersion");
    addFailure(failures, nonEmptyString(history.taskId), "historyReadback.taskId");
    addFailure(failures, validSha256(history.snapshotHash), "historyReadback.snapshotHash");
    addFailure(failures, nonEmptyString(provider.protocol), "providerObservation.protocol");
    addFailure(failures, validSha256(provider.payloadHash), "providerObservation.payloadHash");
    addFailure(failures, nonEmptyString(provider.receiptId), "providerObservation.receiptId");
    addFailure(failures, validSha256(provider.receiptSha256), "providerObservation.receiptSha256");
    addFailure(failures, nonEmptyString(billing.status), "billing.status");
    addFailure(failures, nonEmptyString(billing.receiptId), "billing.receiptId");
    addFailure(failures, validSha256(billing.receiptSha256), "billing.receiptSha256");
    addFailure(failures, stableLocator(output.urlOrAssetId), "outputAsset.urlOrAssetId");
    addFailure(failures, validSha256(output.contentSha256), "outputAsset.contentSha256");
    addFailure(failures, Number.isInteger(output.width) && output.width > 0, "outputAsset.width");
    addFailure(failures, Number.isInteger(output.height) && output.height > 0, "outputAsset.height");
    if (suiteCase.mediaKind !== "image") {
      addFailure(failures, Number.isFinite(output.durationSeconds) && output.durationSeconds > 0, "outputAsset.durationSeconds");
      addFailure(failures, typeof output.hasAudio === "boolean", "outputAsset.hasAudio");
    }
    byCase[suiteCase.id] = failures;
  }
  return {
    passed: globalFailures.length === 0 && Object.values(byCase).every(failures => failures.length === 0),
    globalFailures,
    caseFailures: byCase,
  };
}

function getPath(value, dottedPath) {
  return String(dottedPath || "").split(".").filter(Boolean).reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, value);
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function resolveExpected(assertion, suiteCase) {
  return assertion.expectedFrom ? getPath(suiteCase, assertion.expectedFrom) : assertion.expected;
}

function checkRequestAssertion(assertion, runCase, suiteCase) {
  const actual = getPath(runCase, assertion.path);
  const expected = resolveExpected(assertion, suiteCase);
  let passed = false;
  switch (assertion.operator) {
    case "present":
      passed = actual !== undefined && actual !== null && String(actual).trim() !== "";
      break;
    case "equals":
      passed = same(actual, expected);
      break;
    case "equals_path":
      passed = same(actual, getPath(runCase, assertion.expectedPath));
      break;
    case "includes_all":
      passed = typeof actual === "string" && Array.isArray(expected)
        && expected.every(item => actual.toLocaleLowerCase().includes(String(item).toLocaleLowerCase()));
      break;
    case "sha256":
      passed = typeof actual === "string" && /^[a-f0-9]{64}$/u.test(actual);
      break;
    case "array_length":
      passed = Array.isArray(actual) && actual.length === Number(expected);
      break;
    case "role_count":
      passed = Array.isArray(actual)
        && actual.filter(item => object(item).role === assertion.role).length === Number(expected);
      break;
    case "absent_or_empty":
      passed = actual === undefined || actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
      break;
    default:
      throw new Error(`UNSUPPORTED_REQUEST_ASSERTION_OPERATOR:${assertion.operator}`);
  }
  return {
    id: assertion.id,
    passed,
    hard: assertion.hard !== false,
    weight: Number(assertion.weight || 1),
    path: assertion.path,
    operator: assertion.operator,
    expected: assertion.operator === "equals_path" ? { expectedPath: assertion.expectedPath } : expected,
    actual: assertion.sensitive === true ? "[redacted]" : actual,
  };
}

function lexicalCheck(assertion, effectivePrompt) {
  const anchors = Array.isArray(assertion.promptAnchors) ? assertion.promptAnchors.filter(Boolean) : [];
  if (anchors.length === 0) return { id: assertion.id, applicable: false, passed: null, anchors: [] };
  const normalized = String(effectivePrompt || "").toLocaleLowerCase();
  const missing = anchors.filter(anchor => !normalized.includes(String(anchor).toLocaleLowerCase()));
  return { id: assertion.id, applicable: true, passed: missing.length === 0, anchors, missing };
}

function evidenceIssues(assertion, evidenceItem, context) {
  const item = object(evidenceItem);
  const binding = object(item.binding);
  const frame = object(item.frame);
  const range = object(item.range);
  const issues = [];
  addFailure(issues, stableLocator(item.locator), "locator");
  addFailure(issues, validSha256(item.sha256), "sha256");
  addFailure(issues, validIsoTimestamp(item.observedAt), "observedAt");
  addFailure(issues, nonEmptyString(item.reviewer), "reviewer");
  addFailure(issues, binding.taskId === context.taskId, "binding.taskId");
  addFailure(issues, binding.outputAssetLocator === context.outputAssetLocator, "binding.outputAssetLocator");
  addFailure(issues, binding.outputContentSha256 === context.outputContentSha256, "binding.outputContentSha256");
  addFailure(issues, binding.sourceVersion === context.sourceVersion, "binding.sourceVersion");
  addFailure(issues, binding.buildId === context.buildId, "binding.buildId");
  if (assertion.layer === "visual") {
    addFailure(issues, Number.isInteger(frame.index) && frame.index >= 0, "frame.index");
    addFailure(issues, Number.isFinite(frame.timeSeconds) && frame.timeSeconds >= 0, "frame.timeSeconds");
  }
  if (assertion.layer === "temporal" || assertion.layer === "audio" || (assertion.layer === "visual" && context.mediaKind !== "image")) {
    addFailure(issues, Number.isInteger(range.startFrameIndex) && range.startFrameIndex >= 0, "range.startFrameIndex");
    addFailure(issues, Number.isInteger(range.endFrameIndex) && range.endFrameIndex >= range.startFrameIndex, "range.endFrameIndex");
    addFailure(issues, Number.isFinite(range.startSeconds) && range.startSeconds >= 0, "range.startSeconds");
    addFailure(issues, Number.isFinite(range.endSeconds) && range.endSeconds >= range.startSeconds, "range.endSeconds");
  }
  return issues;
}

function checkObservation(assertion, observation, context) {
  const source = object(observation);
  const status = ALLOWED_STATUSES.has(source.status) ? source.status : "not_run";
  const evidence = Array.isArray(source.evidence) ? source.evidence.map(object) : [];
  const allowedEvidenceKinds = Array.isArray(assertion.evidenceKinds)
    ? new Set(assertion.evidenceKinds)
    : EVIDENCE_BY_LAYER[assertion.layer];
  const invalidEvidence = evidence.filter(item => !allowedEvidenceKinds.has(item.kind));
  const evidenceValidation = evidence.map((item, index) => ({ index, issues: evidenceIssues(assertion, item, context) }));
  const invalidEvidenceDetails = evidenceValidation.filter(item => item.issues.length > 0);
  const hasEvidence = evidence.length > 0 && invalidEvidence.length === 0 && invalidEvidenceDetails.length === 0;
  const invalidSemanticVerdict = ["pass", "fail"].includes(status) && !hasEvidence;
  return {
    id: assertion.id,
    category: assertion.category,
    layer: assertion.layer,
    hard: assertion.hard === true,
    weight: Number(assertion.weight || 1),
    status: invalidSemanticVerdict ? "fail" : status,
    evidenceValid: hasEvidence,
    evidenceCount: evidence.length,
    invalidEvidenceKinds: invalidEvidence.map(item => item.kind || null),
    invalidEvidenceDetails,
    note: invalidSemanticVerdict
      ? "A semantic verdict requires layer-appropriate output evidence; prompt text is never visual/audio/temporal/output-metadata evidence."
      : String(source.note || ""),
  };
}

function weightedPercent(results, predicate) {
  const applicable = results.filter(predicate);
  if (applicable.length === 0) return null;
  const total = applicable.reduce((sum, item) => sum + item.weight, 0);
  const passed = applicable.filter(item => item.passed === true || item.status === "pass")
    .reduce((sum, item) => sum + item.weight, 0);
  return Math.round((passed / total) * 10_000) / 100;
}

function validateSuite(suite) {
  if (object(suite).schema !== SUITE_SCHEMA) throw new Error("MEDIA_ADHERENCE_SUITE_SCHEMA_INVALID");
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error("MEDIA_ADHERENCE_CASES_REQUIRED");
  const caseIds = new Set();
  for (const suiteCase of suite.cases) {
    if (!suiteCase?.id || caseIds.has(suiteCase.id)) throw new Error("MEDIA_ADHERENCE_CASE_ID_INVALID");
    caseIds.add(suiteCase.id);
    if (!ALLOWED_MEDIA_KINDS.has(suiteCase.mediaKind)) throw new Error(`MEDIA_ADHERENCE_KIND_INVALID:${suiteCase.id}`);
    if (!Array.isArray(suiteCase.requestAssertions) || !Array.isArray(suiteCase.outputAssertions)) {
      throw new Error(`MEDIA_ADHERENCE_ASSERTIONS_REQUIRED:${suiteCase.id}`);
    }
    const assertionIds = new Set();
    for (const assertion of [...suiteCase.requestAssertions, ...suiteCase.outputAssertions]) {
      if (!assertion?.id || assertionIds.has(assertion.id)) throw new Error(`MEDIA_ADHERENCE_ASSERTION_ID_INVALID:${suiteCase.id}`);
      assertionIds.add(assertion.id);
    }
    for (const assertion of suiteCase.outputAssertions) {
      if (!ALLOWED_LAYERS.has(assertion.layer)) throw new Error(`MEDIA_ADHERENCE_LAYER_INVALID:${suiteCase.id}:${assertion.id}`);
      if (assertion.evidenceKinds !== undefined) {
        if (!Array.isArray(assertion.evidenceKinds) || assertion.evidenceKinds.length === 0
          || assertion.evidenceKinds.some(kind => !EVIDENCE_BY_LAYER[assertion.layer].has(kind))) {
          throw new Error(`MEDIA_ADHERENCE_EVIDENCE_KIND_INVALID:${suiteCase.id}:${assertion.id}`);
        }
      }
    }
  }
  return suite;
}

export function buildPlan(suiteInput) {
  const suite = validateSuite(suiteInput);
  return {
    schema: RUN_SCHEMA,
    suiteId: suite.suiteId,
    status: "planned",
    evidenceBoundary: suite.evidenceBoundary,
    environment: {
      sourceVersion: null,
      buildId: null,
      route: null,
      browser: { name: null, version: null, userAgent: null, viewport: { width: null, height: null } },
      capturedAt: null,
    },
    cases: suite.cases.map(suiteCase => ({
      caseId: suiteCase.id,
      model: { publicModelId: null, provider: null, modelVersion: null, adapterVersion: null },
      requestSnapshot: null,
      historyReadback: { requestSnapshot: null, snapshotHash: null, taskId: null },
      providerObservation: {
        captureMethod: null,
        protocol: null,
        dispatchCount: null,
        automaticRetryCount: null,
        payloadHash: null,
        receiptId: null,
        receiptSha256: null,
        fields: {},
      },
      billing: { status: null, netAmountYuan: null, receiptId: null, receiptSha256: null },
      outputAsset: { urlOrAssetId: null, contentSha256: null, width: null, height: null, durationSeconds: null, hasAudio: null },
      observations: Object.fromEntries(suiteCase.outputAssertions.map(assertion => [assertion.id, {
        status: "not_run",
        evidence: [],
        note: "",
      }])),
    })),
    paidCanaryGate: {
      authorized: false,
      authorizationId: null,
      authorizedBy: null,
      authorizedAt: null,
      maxProviderSubmissionsPerCase: 1,
      automaticRetriesAllowed: 0,
      instruction: "Fill current model/build identities and obtain explicit paid authorization before any provider request.",
    },
  };
}

export function evaluateSuite(suiteInput, runInput) {
  const suite = validateSuite(suiteInput);
  if (object(runInput).schema !== RUN_SCHEMA || runInput.suiteId !== suite.suiteId) {
    throw new Error("MEDIA_ADHERENCE_RUN_IDENTITY_INVALID");
  }
  const runtimeGate = validateRuntimeEnvelope(runInput, suite);
  const environment = object(runInput.environment);
  const runCases = new Map((Array.isArray(runInput.cases) ? runInput.cases : []).map(item => [item.caseId, item]));
  const cases = suite.cases.map(suiteCase => {
    const runCase = object(runCases.get(suiteCase.id));
    const requestResults = suiteCase.requestAssertions.map(assertion => checkRequestAssertion(assertion, runCase, suiteCase));
    const effectivePrompt = getPath(runCase, suiteCase.effectivePromptPath || "requestSnapshot.effectivePrompt");
    const lexicalResults = suiteCase.outputAssertions.map(assertion => lexicalCheck(assertion, effectivePrompt));
    const observations = object(runCase.observations);
    const outputAsset = object(runCase.outputAsset);
    const outputResults = suiteCase.outputAssertions.map(assertion => checkObservation(assertion, observations[assertion.id], {
      mediaKind: suiteCase.mediaKind,
      taskId: object(runCase.historyReadback).taskId,
      outputAssetLocator: outputAsset.urlOrAssetId,
      outputContentSha256: outputAsset.contentSha256,
      sourceVersion: environment.sourceVersion,
      buildId: environment.buildId,
    }));
    const requestCompleteness = weightedPercent(requestResults, () => true);
    const lexicalApplicable = lexicalResults.filter(item => item.applicable);
    const lexicalCoverage = lexicalApplicable.length === 0
      ? null
      : Math.round((lexicalApplicable.filter(item => item.passed).length / lexicalApplicable.length) * 10_000) / 100;
    const semanticAdherenceObserved = weightedPercent(outputResults, item => item.evidenceValid && ["pass", "fail"].includes(item.status));
    const semanticCoverage = Math.round((outputResults.filter(item => item.evidenceValid && ["pass", "fail"].includes(item.status)).length / Math.max(1, outputResults.length)) * 10_000) / 100;
    const hardFailures = [
      ...runtimeGate.globalFailures.map(item => `runtime:${item}`),
      ...(runtimeGate.caseFailures[suiteCase.id] || []).map(item => `runtime:${item}`),
      ...requestResults.filter(item => item.hard && !item.passed).map(item => `request:${item.id}`),
      ...outputResults.filter(item => item.hard && item.status === "fail").map(item => `output:${item.id}`),
    ];
    const incompleteOutputs = outputResults.filter(item => ["not_run", "unobservable"].includes(item.status));
    const status = hardFailures.length > 0
      ? "failed"
      : requestCompleteness !== 100 || incompleteOutputs.length > 0 || semanticCoverage !== 100
        ? "incomplete"
        : outputResults.some(item => item.status === "fail")
          ? "failed"
          : "passed";
    return {
      caseId: suiteCase.id,
      mediaKind: suiteCase.mediaKind,
      status,
      scores: {
        submissionCompleteness: requestCompleteness,
        promptLexicalCoverage: lexicalCoverage,
        outputSemanticAdherenceObserved: semanticAdherenceObserved,
        outputSemanticEvidenceCoverage: semanticCoverage,
      },
      boundary: "promptLexicalCoverage is diagnostic only and never contributes to outputSemanticAdherenceObserved.",
      hardFailures,
      requestResults,
      lexicalResults,
      outputResults,
    };
  });
  const status = cases.some(item => item.status === "failed")
    ? "failed"
    : cases.every(item => item.status === "passed") ? "passed" : "incomplete";
  return {
    schema: "media_prompt_adherence_report.v1",
    suiteId: suite.suiteId,
    runHash: sha256(JSON.stringify(stable(runInput))),
    status,
    runtimeGate,
    cases,
    totals: {
      passed: cases.filter(item => item.status === "passed").length,
      failed: cases.filter(item => item.status === "failed").length,
      incomplete: cases.filter(item => item.status === "incomplete").length,
    },
    evidenceLevel: status === "passed" && runtimeGate.passed ? "runtime_media_reviewed" : "schema_or_partial_runtime_only",
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function cli() {
  const suitePath = argument("--suite");
  const mode = argument("--mode") || "plan";
  const runPath = argument("--run");
  const outputPath = argument("--out");
  if (!suitePath) throw new Error("Usage: --suite <file> --mode plan|evaluate [--run <file>] [--out <file>]");
  const suite = JSON.parse(await readFile(path.resolve(suitePath), "utf8"));
  const output = mode === "plan"
    ? buildPlan(suite)
    : mode === "evaluate" && runPath
      ? evaluateSuite(suite, JSON.parse(await readFile(path.resolve(runPath), "utf8")))
      : (() => { throw new Error("MODE_OR_RUN_INVALID"); })();
  const serialized = `${JSON.stringify(output, null, 2)}\n`;
  if (outputPath) await writeFile(path.resolve(outputPath), serialized, "utf8");
  else process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
