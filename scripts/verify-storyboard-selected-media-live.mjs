#!/usr/bin/env node
// Explicit API project loading; all paid generation is submitted by the real UI.
// Planned semantic refs remain pending until their real sources are saved and bound.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  parsePaidHarnessArgs, runtimeIdentity, readPaidDatabaseReadiness, assertPaidActor,
  assertPaidQuote, publicModelProjection, quotedModelPrice, makeWorkbenchPaidPostHandler,
  projectImageDelivery, assertImageReceiptBinding, assertPaidFinalPass, waitForImageDecoded,
  installPaidAuthCookie, safeHarnessEvidence, writePaidTerminalReadback,
} from "./verify-image-workbench-live-e2e.mjs";
import { makeMediaPaidRouteBoundary, awaitMediaGenerationResponse, observeMediaPromise } from "./verify-storyboard-image-live-canary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { StoryboardProjectDocument } = await tsImport("../src/lib/storyboard-project-contract.ts", import.meta.url);
export const MAX_STORYBOARD_SEGMENTS = StoryboardProjectDocument.shape.cards.toJSONSchema().maxItems;
assert.ok(Number.isSafeInteger(MAX_STORYBOARD_SEGMENTS) && MAX_STORYBOARD_SEGMENTS > 0, "SELECTED_WORKBENCH_CARD_LIMIT_REQUIRED");
const ASSET_PHASES = Object.freeze(["asset-character", "asset-pet", "bind"]);
export function mediaPhaseSequence(segmentCount) {
  assert.ok(Number.isSafeInteger(segmentCount) && segmentCount >= 1 && segmentCount <= MAX_STORYBOARD_SEGMENTS, "SELECTED_SEGMENT_COUNT_INVALID");
  return [...ASSET_PHASES, ...Array.from({ length: segmentCount }, (_, index) => `storyboard-${index + 1}`)];
}
export function assertMediaPhase(phase, segmentCount = MAX_STORYBOARD_SEGMENTS) {
  assert.ok(Number.isSafeInteger(segmentCount) && segmentCount >= 1 && segmentCount <= MAX_STORYBOARD_SEGMENTS, "SELECTED_SEGMENT_COUNT_INVALID");
  const match = /^storyboard-([1-9]\d*)$/u.exec(phase || "");
  const order = match ? Number(match[1]) : null;
  assert.ok(ASSET_PHASES.includes(phase) || Number.isSafeInteger(order) && order >= 1 && order <= segmentCount, "SELECTED_PHASE_INVALID");
  return order;
}
// Compatibility for existing three-segment callers; execution derives its sequence from the native plan.
export const PHASES = Object.freeze(mediaPhaseSequence(3));
const hash = value => createHash("sha256").update(value).digest("hex");
const money = value => Number(Number(value).toFixed(6));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identityAssets = plan => plan.assets.filter(asset => ["character", "pet"].includes(asset.role));

export function parseSelectedArgs(args) {
  const bind = args.includes("--phase=bind");
  const budgetKeys = ["max-charge", "remaining-budget"];
  if (bind) for (const key of budgetKeys) {
    const matches = args.filter(arg => arg.startsWith(`--${key}=`));
    assert.ok(matches.length <= 1 && matches.every(arg => arg === `--${key}=0`), "SELECTED_BIND_BUDGET_FORBIDDEN");
  }
  const parsed = parsePaidHarnessArgs(bind ? args.filter(arg => arg !== "--execute"
    && !budgetKeys.some(key => arg.startsWith(`--${key}=`))) : args, [
    "run-id", "project-id", "package-file", "package-sha256", "phase", "model-id", "aspect-ratio",
    "resolution", "execute", "self-test", "annotation-file", "annotation-sha256",
    "existing-project-id", "handoff-provenance-file", "handoff-provenance-sha256",
  ]);
  if (parsed.flags.has("self-test")) {
    assert.equal(args.length, 1, "SELECTED_SELFTEST_EXCLUSIVE");
    return parsed;
  }
  const v = parsed.values;
  if (bind) {
    assert.ok(args.filter(arg => arg === "--execute").length <= 1, "HARNESS_DUPLICATE_ARGUMENT");
    parsed.maxCharge = parsed.remainingBudget = 0;
    v["max-charge"] = v["remaining-budget"] = "0";
    if (args.includes("--execute")) {
      for (const key of ["user-id", "expected-source-version", "expected-build-id", "database-readiness",
        "database-readiness-sha256", "expected-database-target", "expected-database-identity"]) {
        assert.ok(v[key], "HARNESS_EXECUTE_PREREQUISITE_REQUIRED");
      }
      parsed.flags.add("execute");
    }
  }
  assertMediaPhase(v.phase);
  assert.match(v["run-id"] || "", /^[A-Za-z0-9_-]{8,100}$/u, "SELECTED_RUN_ID_REQUIRED");
  if (v["existing-project-id"]) {
    assert.ok(!v["project-id"], "SELECTED_PROJECT_MODES_EXCLUSIVE");
    assert.match(v["existing-project-id"], /^storyboard-run-[A-Za-z0-9_-]{8,100}$/u, "SELECTED_EXISTING_PROJECT_ID_REQUIRED");
    assert.ok(v["user-id"] && v["handoff-provenance-file"], "SELECTED_HANDOFF_PROVENANCE_REQUIRED");
    assert.match(v["handoff-provenance-sha256"] || "", /^[a-f0-9]{64}$/u, "SELECTED_HANDOFF_PROVENANCE_PIN_REQUIRED");
    v["project-id"] = v["existing-project-id"];
  } else {
    assert.match(v["project-id"] || "", /^storyboard-selected-[A-Za-z0-9_-]{8,100}$/u, "SELECTED_PROJECT_ID_REQUIRED");
    assert.ok(!v["handoff-provenance-file"] && !v["handoff-provenance-sha256"], "SELECTED_HANDOFF_WRONG_MODE");
  }
  assert.ok(v["package-file"], "SELECTED_PACKAGE_REQUIRED");
  assert.match(v["package-sha256"] || "", /^[a-f0-9]{64}$/u, "SELECTED_PACKAGE_PIN_REQUIRED");
  assert.equal(Boolean(v["annotation-file"]), Boolean(v["annotation-sha256"]), "SELECTED_ANNOTATION_PINS_REQUIRED");
  if (v["annotation-sha256"]) assert.match(v["annotation-sha256"], /^[a-f0-9]{64}$/u, "SELECTED_ANNOTATION_PIN_INVALID");
  phaseGenerationContract(v);
  return parsed;
}

export function cardIdForOrder(values, order) {
  if (!values["existing-project-id"]) return `${values["project-id"]}-card-${order}`;
  const matches = values.cardOrderMap?.filter(item => item.order === order) || [];
  assert.equal(matches.length, 1, "SELECTED_ACTUAL_CARD_MAP_REQUIRED");
  assert.match(matches[0].id, /^shot-[A-Za-z0-9_-]+$/u, "SELECTED_ACTUAL_CARD_ID_INVALID");
  return matches[0].id;
}

const cleanJson = value => JSON.parse(JSON.stringify(value ?? null));
const withoutAssetSources = plan => cleanJson({ ...plan, assets: plan.assets.map(asset => { const copy = { ...asset }; delete copy.source; return copy; }) });

export function assertFreshImportedDocument(document, plan, values) {
  assertDocumentInputs(document, plan, values);
  assert.equal(document.visualAssetWorkspace?.candidates?.length || 0, 0, "SELECTED_IMPORTED_CANDIDATES_FORBIDDEN");
  assert.ok(document.visualAssetPlan.assets.every(asset => !asset.source), "SELECTED_IMPORTED_SOURCES_FORBIDDEN");
  assert.deepEqual(cleanJson(document.visualAssetPlan), cleanJson(values.nativePlan), "SELECTED_IMPORTED_PLAN_DRIFT");
  for (const [index, card] of document.cards.entries()) {
    assert.equal(card.imageStatus, "idle", "SELECTED_IMPORTED_IMAGE_ATTEMPT_FORBIDDEN");
    assert.equal(card.videoStatus, "idle", "SELECTED_IMPORTED_VIDEO_ATTEMPT_FORBIDDEN");
    assert.equal(card.referenceImageUrls.length, 0, "SELECTED_IMPORTED_MEDIA_FORBIDDEN");
    assert.deepEqual(cleanJson(card.visualAssetRefs), cleanJson(plan.segments[index].visualAssetRefs), "SELECTED_IMPORTED_REFS_DRIFT");
    for (const key of ["imageUrl", "imageRef", "imageRecordId", "imageAssetId", "imageStorageKey", "imageClientRequestId",
      "imageClientTraceId", "imageRequestSnapshot", "imageRetryBlocked", "imageRecoveryReady", "imageBillingState",
      "videoUrl", "videoTaskId", "videoClientRequestId", "videoLifecycle", "videoBillingState", "videoSourceImageUrl"]) {
      assert.ok(!card[key], "SELECTED_IMPORTED_MEDIA_OR_UNKNOWN_FORBIDDEN");
    }
  }
}

export async function loadOfficialHandoff(values, pkg, contracts, plan, io = fs) {
  if (!values["existing-project-id"]) {
    assert.ok(!values["handoff-provenance-file"] && !values["handoff-provenance-sha256"], "SELECTED_HANDOFF_WRONG_MODE");
    return null;
  }
  const file = path.resolve(values["handoff-provenance-file"]);
  const base = path.dirname(file);
  const bytes = await io.readFile(file);
  assert.ok(bytes.length > 0 && bytes.length < 256 * 1024, "SELECTED_HANDOFF_MANIFEST_SIZE");
  assert.equal(hash(bytes), values["handoff-provenance-sha256"], "SELECTED_HANDOFF_MANIFEST_CHANGED");
  const evidence = JSON.parse(bytes.toString("utf8"));
  assert.equal(evidence.schema_version, "official_storyboard_handoff_provenance.v1", "SELECTED_HANDOFF_SCHEMA");
  assert.equal(evidence.success, true, "SELECTED_HANDOFF_CAPTURE_FAILED");
  assert.equal(evidence.noGenerationOrPaidRequests, true, "SELECTED_HANDOFF_CAPTURE_PAID_REQUEST");
  assert.equal(evidence.audit?.generationPosts, 0, "SELECTED_HANDOFF_CAPTURE_PAID_REQUEST");
  assert.equal(evidence.audit?.forwardedProjectPosts, 1, "SELECTED_HANDOFF_CAPTURE_POST_COUNT");
  for (const key of ["routeErrors", "blockedMutations", "pageErrors"]) assert.deepEqual(evidence.audit?.[key], [], "SELECTED_HANDOFF_CAPTURE_ERRORS");
  assert.ok(evidence.runtime && evidence.runtime.sourceVersion && evidence.runtime.buildId, "SELECTED_HANDOFF_CAPTURE_RUNTIME_REQUIRED");
  assert.equal(evidence.ownerUserId, values["user-id"], "SELECTED_HANDOFF_OWNER_DRIFT");
  assert.equal(evidence.projectId, values["existing-project-id"], "SELECTED_HANDOFF_PROJECT_DRIFT");
  assert.equal(evidence.packageSha256, values["package-sha256"], "SELECTED_HANDOFF_PACKAGE_DRIFT");
  assert.equal(evidence.sourceRoute, "/", "SELECTED_HANDOFF_ROUTE_DRIFT");
  assert.ok(evidence.conversationId && evidence.messageId && evidence.commitKey, "SELECTED_HANDOFF_MESSAGE_REQUIRED");
  assert.equal(Object.hasOwn(pkg, "host_annotation"), false, "SELECTED_HANDOFF_NATIVE_PACKAGE_REQUIRED");
  for (const key of ["draftImportClicked", "previewConfirmed", "librarySelectionClicked"]) {
    assert.equal(evidence.interactionEvidence?.[key], true, "SELECTED_HANDOFF_INTERACTION_REQUIRED");
  }
  const first = evidence.firstProjectSave, readback = evidence.projectReadback;
  assert.equal(first?.method, "POST", "SELECTED_HANDOFF_FIRST_SAVE_REQUIRED");
  assert.equal(first.pathname, "/api/storyboard/projects", "SELECTED_HANDOFF_FIRST_SAVE_REQUIRED");
  assert.equal(first.trigger, "library-selection", "SELECTED_HANDOFF_FIRST_SAVE_TRIGGER");
  for (const id of [first.documentId, first.responseProjectId, first.urlProjectId, readback?.projectId]) {
    assert.equal(id, evidence.projectId, "SELECTED_HANDOFF_SAVE_ID_DRIFT");
  }
  assert.equal(readback.ownerUserId, evidence.ownerUserId, "SELECTED_HANDOFF_READBACK_OWNER_DRIFT");
  assert.ok(Number.isSafeInteger(first.revision) && first.revision >= 1 && first.revision === readback.revision,
    "SELECTED_HANDOFF_REVISION_DRIFT");
  const readArtifact = async relative => {
    assert.ok(typeof relative === "string" && relative && !path.isAbsolute(relative), "SELECTED_HANDOFF_ARTIFACT_PATH");
    const resolved = path.resolve(base, relative);
    assert.ok(resolved.startsWith(base + path.sep), "SELECTED_HANDOFF_ARTIFACT_PATH");
    const result = await io.readFile(resolved);
    assert.ok(result.length > 0 && result.length < 4 * 1024 * 1024, "SELECTED_HANDOFF_ARTIFACT_SIZE");
    return result;
  };
  const keys = ["rawAssistantFile", "nativePackageFile", "firstDocumentFile", "readbackDocumentFile", "importPlanFile"];
  const artifacts = await Promise.all(keys.map(key => readArtifact(evidence.artifacts?.[key])));
  const response = JSON.parse((await readArtifact(first.responseFile)).toString("utf8"));
  assert.equal(response.project?.id, evidence.projectId, "SELECTED_HANDOFF_RESPONSE_DRIFT");
  assert.equal(response.project.revision, first.revision, "SELECTED_HANDOFF_RESPONSE_DRIFT");
  const [rawBytes, nativeBytes, firstBytes, readbackBytes, importPlanBytes] = artifacts;
  assert.equal(hash(rawBytes), evidence.rawContentSha256, "SELECTED_HANDOFF_RAW_CHANGED");
  assert.equal(hash(nativeBytes), values["package-sha256"], "SELECTED_HANDOFF_NATIVE_CHANGED");
  assert.deepEqual(JSON.parse(nativeBytes.toString("utf8")), pkg, "SELECTED_HANDOFF_NATIVE_CHANGED");
  const parsed = contracts.parseStructured(rawBytes.toString("utf8"), true);
  assert.ok(parsed.status === "valid" && parsed.kind === "storyboard_director" && parsed.source === "stable_json", "SELECTED_HANDOFF_RAW_INVALID");
  assert.deepEqual(cleanJson(parsed.machine_payload), cleanJson(pkg), "SELECTED_HANDOFF_RAW_PACKAGE_DRIFT");
  const detail = contracts.buildReady(evidence.messageId, parsed);
  assert.equal(detail?.commit_key, evidence.commitKey, "SELECTED_HANDOFF_COMMIT_DRIFT");
  const envelope = JSON.parse((await readArtifact(evidence.artifacts?.handoffEnvelopeFile)).toString("utf8"));
  assert.equal(envelope.schema_version, "agent_workbench_handoff.v1", "SELECTED_HANDOFF_ENVELOPE_SCHEMA");
  assert.equal(envelope.artifact_type, "agent_workbench_handoff", "SELECTED_HANDOFF_ENVELOPE_SCHEMA");
  assert.equal(envelope.source_route, "/", "SELECTED_HANDOFF_ENVELOPE_ROUTE");
  assert.equal(envelope.target, "storyboard-workbench", "SELECTED_HANDOFF_ENVELOPE_TARGET");
  assert.equal(envelope.payload?.message_id, evidence.messageId, "SELECTED_HANDOFF_ENVELOPE_MESSAGE");
  assert.equal(envelope.payload?.commit_key, evidence.commitKey, "SELECTED_HANDOFF_ENVELOPE_COMMIT");
  assert.deepEqual(cleanJson(envelope.payload), cleanJson(detail), "SELECTED_HANDOFF_ENVELOPE_DETAIL");
  assert.deepEqual(cleanJson(envelope.payload.machine_payload), cleanJson(pkg), "SELECTED_HANDOFF_ENVELOPE_PACKAGE");
  assert.deepEqual(cleanJson(contracts.parseBridge(detail)), JSON.parse(importPlanBytes.toString("utf8")), "SELECTED_HANDOFF_IMPORT_PLAN_DRIFT");
  const firstDocument = JSON.parse(firstBytes.toString("utf8"));
  const readbackDocument = JSON.parse(readbackBytes.toString("utf8"));
  assert.equal(hash(JSON.stringify(firstDocument)), first.documentSha256, "SELECTED_HANDOFF_FIRST_DOCUMENT_CHANGED");
  assert.equal(hash(JSON.stringify(readbackDocument)), readback.documentSha256, "SELECTED_HANDOFF_READBACK_CHANGED");
  assert.ok(Array.isArray(evidence.cardOrderMap) && evidence.cardOrderMap.length === plan.segments.length,
    "SELECTED_HANDOFF_CARD_MAP_REQUIRED");
  assert.equal(new Set(evidence.cardOrderMap.map(item => item.id)).size, plan.segments.length, "SELECTED_HANDOFF_CARD_MAP_DUPLICATE");
  const mapped = { ...values, cardOrderMap: evidence.cardOrderMap };
  const expected = contracts.projectSchema.parse(makeStagingDocument(plan, mapped, 1000));
  mapped.nativePlan = expected.visualAssetPlan;
  for (const document of [firstDocument, readbackDocument]) assertFreshImportedDocument(document, plan, mapped);
  return { cardOrderMap: cleanJson(evidence.cardOrderMap), nativePlan: mapped.nativePlan, captureRuntime: evidence.runtime,
    summary: { schema_version: evidence.schema_version, ownerUserId: evidence.ownerUserId, projectId: evidence.projectId,
      conversationId: evidence.conversationId, messageId: evidence.messageId, rawContentSha256: evidence.rawContentSha256,
      packageSha256: evidence.packageSha256, commitKey: evidence.commitKey,
      provenanceSha256: values["handoff-provenance-sha256"], originalProjectRevision: first.revision } };
}

export async function verifyOfficialHandoffSource(official, pkg, contracts, runtime, actor, read) {
  if (!official) return false;
  assert.deepEqual(official.captureRuntime, runtime, "SELECTED_HANDOFF_CURRENT_RUNTIME_DRIFT");
  assert.equal(official.summary.ownerUserId, actor.id, "SELECTED_HANDOFF_CURRENT_OWNER_DRIFT");
  const { conversation } = await read(`/api/conversations/history?id=${encodeURIComponent(official.summary.conversationId)}`);
  assert.equal(conversation?.id, official.summary.conversationId, "SELECTED_HANDOFF_SOURCE_CONVERSATION_DRIFT");
  assert.equal(conversation.user_id, actor.id, "SELECTED_HANDOFF_SOURCE_OWNER_DRIFT");
  const messages = conversation.messages?.filter(message => message.id === official.summary.messageId) || [];
  assert.equal(messages.length, 1, "SELECTED_HANDOFF_SOURCE_MESSAGE_MISSING");
  const message = messages[0];
  assert.equal(message.role, "assistant", "SELECTED_HANDOFF_SOURCE_ROLE_DRIFT");
  assert.equal(typeof message.content, "string", "SELECTED_HANDOFF_SOURCE_CONTENT_MISSING");
  assert.equal(hash(Buffer.from(message.content, "utf8")), official.summary.rawContentSha256, "SELECTED_HANDOFF_SOURCE_RAW_DRIFT");
  const parsed = contracts.parseStructured(message.content, true);
  assert.ok(parsed.status === "valid" && parsed.kind === "storyboard_director" && parsed.source === "stable_json", "SELECTED_HANDOFF_SOURCE_NATIVE_REQUIRED");
  assert.deepEqual(cleanJson(parsed.machine_payload), cleanJson(pkg), "SELECTED_HANDOFF_SOURCE_PACKAGE_DRIFT");
  assert.equal(contracts.buildReady(message.id, parsed)?.commit_key, official.summary.commitKey, "SELECTED_HANDOFF_SOURCE_COMMIT_DRIFT");
  return true;
}

export function phaseGenerationContract(values) {
  assertMediaPhase(values.phase);
  if (values.phase === "bind") {
    assert.ok(!values["model-id"] && !values.resolution && !values["aspect-ratio"], "SELECTED_BIND_HAS_GENERATION_SETTINGS");
    return null;
  }
  assert.match(values["model-id"] || "", /^pm_[A-Za-z0-9_-]+$/u, "SELECTED_PUBLIC_MODEL_REQUIRED");
  assert.ok(["1K", "2K", "4K"].includes(values.resolution), "SELECTED_RESOLUTION_REQUIRED");
  assert.ok(["1:1", "16:9"].includes(values["aspect-ratio"]), "SELECTED_ASPECT_RATIO_REQUIRED");
  if (values.phase.startsWith("storyboard-")) assert.equal(values["aspect-ratio"], "16:9", "SELECTED_STORYBOARD_LANDSCAPE_REQUIRED");
  return Object.freeze({ modelId: values["model-id"], resolution: values.resolution, aspectRatio: values["aspect-ratio"] });
}

export async function readPhaseModel(generationContract, readCatalog, paid) {
  if (!generationContract) return { rawModel: null, model: null, quote: 0 };
  const catalog = await readCatalog();
  const rawModel = catalog.models?.find(item => item.id === generationContract.modelId);
  const model = publicModelProjection(rawModel);
  assert.ok(rawModel && model.id === generationContract.modelId && model.available && model.priceReady
    && model.resolutionOptions.includes(generationContract.resolution)
    && model.aspectRatios.includes(generationContract.aspectRatio), "SELECTED_MODEL_UNAVAILABLE");
  const quote = assertPaidQuote(quotedModelPrice(model, generationContract.resolution), paid);
  return { rawModel, model, quote };
}

export function assertReferenceCapacity(rawModel, referenceCount) {
  assert.ok(Number.isSafeInteger(referenceCount) && referenceCount >= 0, "SELECTED_REFERENCE_COUNT_INVALID");
  const capabilities = rawModel?.capabilities || {};
  const minimum = Number(capabilities.minReferenceImages || (capabilities.requiresImage ? 1 : 0));
  assert.ok(Number.isSafeInteger(minimum) && referenceCount >= minimum, "SELECTED_MODEL_REFERENCE_MINIMUM");
  if (referenceCount > 0) assert.ok(Number.isSafeInteger(Number(capabilities.maxReferenceImages))
    && Number(capabilities.maxReferenceImages) >= referenceCount, "SELECTED_MODEL_REFERENCE_CAPACITY");
}

export function assertPhaseEvidence(phase, bundle, context) {
  const { dispatch, request, terminal, report } = bundle;
  assert.equal(report?.success, true, "SELECTED_PREVIOUS_PHASE_UNCONFIRMED");
  const generationContract = phaseGenerationContract({ phase,
    ...(report.generationContract ? { "model-id": report.generationContract.modelId,
      resolution: report.generationContract.resolution, "aspect-ratio": report.generationContract.aspectRatio } : {}) });
  for (const record of [dispatch, request, terminal, report]) {
    assert.equal(record?.phase, phase, "SELECTED_PREVIOUS_PHASE_DRIFT");
    assert.equal(record.projectId, context.projectId, "SELECTED_PREVIOUS_PROJECT_DRIFT");
    assert.equal(record.actor?.id, context.actorId, "SELECTED_PREVIOUS_ACTOR_DRIFT");
    assert.equal(record.packageSha256, context.packageSha256, "SELECTED_PREVIOUS_PACKAGE_DRIFT");
    assert.deepEqual(record.provenance, context.provenance, "SELECTED_PREVIOUS_PROVENANCE_DRIFT");
    assert.equal(record.runId, dispatch.runId, "SELECTED_PREVIOUS_RUN_DRIFT");
    assert.deepEqual(record.generationContract, generationContract, "SELECTED_PREVIOUS_GENERATION_DRIFT");
    assert.deepEqual(record.cardOrderMap, context.cardOrderMap, "SELECTED_PREVIOUS_CARD_MAP_DRIFT");
    assert.equal(record.quote, dispatch.quote, "SELECTED_PREVIOUS_QUOTE_DRIFT");
    assert.equal(record.allocatedBudget, dispatch.allocatedBudget, "SELECTED_PREVIOUS_BUDGET_DRIFT");
  }
  assert.equal(report.modelId, generationContract?.modelId ?? null, "SELECTED_PREVIOUS_MODEL_DRIFT");
  assert.equal(report.resolution, generationContract?.resolution ?? null, "SELECTED_PREVIOUS_RESOLUTION_DRIFT");
  assert.equal(report.aspectRatio, generationContract?.aspectRatio ?? null, "SELECTED_PREVIOUS_RATIO_DRIFT");
  if (!generationContract) {
    assert.equal(dispatch.quote, 0, "SELECTED_BIND_QUOTE_FORBIDDEN");
    assert.equal(dispatch.allocatedBudget, 0, "SELECTED_BIND_BUDGET_FORBIDDEN");
    assert.equal(dispatch.workflowBudget, 0, "SELECTED_BIND_BUDGET_FORBIDDEN");
    assert.equal(request.dispatchState, "generation-forbidden", "SELECTED_BIND_REQUEST_FORBIDDEN");
    assert.equal(terminal.terminalStatus, "no-generation", "SELECTED_BIND_TERMINAL_DRIFT");
    for (const record of [request, terminal, report]) assert.equal(record.generationPosts, 0, "SELECTED_BIND_GENERATION_FORBIDDEN");
    assert.equal(report.billing?.balanceDelta, 0, "SELECTED_BIND_BILLING_DRIFT");
    assert.equal(report.billing?.newTransactionCount, 0, "SELECTED_BIND_LEDGER_DRIFT");
    for (const key of ["generationPostAttempts", "generationPostsContinued", "duplicateGenerationPostsBlocked"]) {
      assert.equal(report.admission?.[key], 0, "SELECTED_BIND_ADMISSION_DRIFT");
    }
    assert.equal(report.deliveryReceipt, null, "SELECTED_BIND_RECEIPT_FORBIDDEN");
  } else {
    for (const key of ["modelId", "resolution", "aspectRatio"]) assert.equal(request[key], generationContract[key], "SELECTED_PREVIOUS_REQUEST_DRIFT");
    for (const key of ["clientIdempotencyKey", "clientTraceId"]) {
      assert.ok(request[key], "SELECTED_PREVIOUS_REQUEST_KEY_MISSING");
      assert.equal(report.request?.[key], request[key], "SELECTED_PREVIOUS_REQUEST_KEY_DRIFT");
      assert.equal(terminal.request?.[key], request[key], "SELECTED_PREVIOUS_REQUEST_KEY_DRIFT");
    }
    assert.equal(terminal.terminalStatus, "completed", "SELECTED_PREVIOUS_TERMINAL_DRIFT");
    assert.ok(report.deliveryReceipt?.recordId, "SELECTED_PREVIOUS_RECEIPT_MISSING");
    assert.deepEqual(terminal.deliveryReceipt, report.deliveryReceipt, "SELECTED_PREVIOUS_RECEIPT_DRIFT");
    if (phase.startsWith("asset-")) {
      assert.deepEqual(bundle.assetBinding, report.assetBinding, "SELECTED_PREVIOUS_ASSET_BINDING_DRIFT");
      assert.equal(report.assetBinding?.historyRecordId, report.deliveryReceipt.recordId, "SELECTED_ASSET_RECEIPT_DRIFT");
      assert.equal(report.assetBinding.generationAssetId, report.deliveryReceipt.assetId || `generated_${report.deliveryReceipt.recordId}`,
        "SELECTED_GENERATED_ASSET_DRIFT");
    }
  }
  return report;
}

export function pinAssetCandidate(document, asset, receipt, projectId, generationAssetId) {
  assert.match(receipt?.recordId || "", /^[a-f0-9]{64}$/u, "SELECTED_ASSET_RECORD_REQUIRED");
  const matches = document.visualAssetWorkspace?.candidates.filter(candidate => candidate.planId === asset.id) || [];
  assert.equal(matches.length, 1, "SELECTED_ASSET_CANDIDATE_AMBIGUOUS");
  const candidate = matches[0];
  assert.equal(candidate.projectId, projectId, "SELECTED_ASSET_PROJECT_DRIFT");
  assert.equal(candidate.role, asset.role, "SELECTED_ASSET_ROLE_DRIFT");
  assert.equal(candidate.historyRecordId, receipt.recordId, "SELECTED_ASSET_RECEIPT_DRIFT");
  assert.equal(generationAssetId, receipt.assetId || `generated_${receipt.recordId}`, "SELECTED_GENERATED_ASSET_DRIFT");
  assert.ok(candidate.saved === true && candidate.assetId && candidate.storageKey, "SELECTED_SAVED_ASSET_REQUIRED");
  return { planId: asset.id, role: asset.role, projectId, generationAssetId,
    assetId: candidate.assetId, historyRecordId: candidate.historyRecordId, storageKey: candidate.storageKey };
}

export function assertAssetCandidatePins(document, plan, values, reports, requireSources = false) {
  for (const asset of plan.visualAssetPlan.assets.filter(item => ["character", "pet"].includes(item.role))) {
    const report = reports[`asset-${asset.role}`];
    assert.ok(report?.success && report.assetBinding, "SELECTED_ASSET_PHASE_REQUIRED");
    const pin = pinAssetCandidate(document, asset, report.deliveryReceipt, values["project-id"], report.assetBinding.generationAssetId);
    assert.deepEqual(pin, report.assetBinding, "SELECTED_SAVED_ASSET_DRIFT");
    const source = document.visualAssetPlan.assets.find(item => item.id === asset.id)?.source;
    if (requireSources) assert.ok(source, "SELECTED_PERSISTENT_ASSET_REQUIRED");
    if (source) for (const key of ["assetId", "historyRecordId", "storageKey"]) {
      assert.equal(source[key], pin[key], "SELECTED_BOUND_ASSET_DRIFT");
    }
  }
}

// An annotation is reviewed host metadata, never a rewrite of model evidence.
export function validateAnnotationProvenance(pkg, originalBytes, manifestBytes, manifestSha256) {
  const marker = pkg.host_annotation;
  assert.ok(marker && typeof marker === "object" && !Array.isArray(marker), "SELECTED_ANNOTATION_MARKER_REQUIRED");
  assert.deepEqual(Object.keys(marker).sort(), ["manifest_sha256", "original_package_sha256", "schema_version"], "SELECTED_ANNOTATION_MARKER_FIELDS");
  assert.equal(marker.schema_version, "storyboard_quality_annotation.v1", "SELECTED_ANNOTATION_SCHEMA");
  assert.equal(hash(manifestBytes), manifestSha256, "SELECTED_ANNOTATION_MANIFEST_CHANGED");
  assert.equal(marker.manifest_sha256, manifestSha256, "SELECTED_ANNOTATION_MANIFEST_PIN");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["annotations", "original_package_file", "original_package_sha256", "schema_version"], "SELECTED_ANNOTATION_MANIFEST_FIELDS");
  assert.equal(manifest.schema_version, marker.schema_version, "SELECTED_ANNOTATION_SCHEMA");
  assert.ok(typeof manifest.original_package_file === "string" && manifest.original_package_file.trim(), "SELECTED_ANNOTATION_ORIGINAL_PATH");
  assert.equal(hash(originalBytes), manifest.original_package_sha256, "SELECTED_ANNOTATION_ORIGINAL_CHANGED");
  assert.equal(marker.original_package_sha256, manifest.original_package_sha256, "SELECTED_ANNOTATION_ORIGINAL_PIN");
  const original = JSON.parse(originalBytes.toString("utf8"));
  assert.ok(!Object.hasOwn(original, "host_annotation"), "SELECTED_ANNOTATION_CHAIN_FORBIDDEN");
  assert.ok(Array.isArray(manifest.annotations) && manifest.annotations.length > 0 && manifest.annotations.length <= 36, "SELECTED_ANNOTATION_COUNT");
  const expected = structuredClone(original), seen = new Set();
  for (const entry of manifest.annotations) {
    assert.deepEqual(Object.keys(entry).sort(), ["original_check_sha256", "pointer", "verification"], "SELECTED_ANNOTATION_ENTRY_FIELDS");
    const match = /^\/segments\/(0|[1-9][0-9]*)\/quality_checks\/(0|[1-9][0-9]*)$/u.exec(entry.pointer);
    assert.ok(match && !seen.has(entry.pointer), "SELECTED_ANNOTATION_POINTER");
    seen.add(entry.pointer);
    const segment = expected.segments?.[Number(match[1])];
    const check = segment?.quality_checks?.[Number(match[2])];
    assert.ok(check && !Object.hasOwn(check, "verification") && check.status === "unknown", "SELECTED_ANNOTATION_NOT_UNCLASSIFIED_UNKNOWN");
    assert.equal(hash(JSON.stringify(check)), entry.original_check_sha256, "SELECTED_ANNOTATION_CHECK_CHANGED");
    const verification = entry.verification;
    assert.ok(verification && typeof verification === "object" && !Array.isArray(verification), "SELECTED_ANNOTATION_VERIFICATION");
    assert.deepEqual(Object.keys(verification).sort(), ["asset_ids", "kind"], "SELECTED_ANNOTATION_VERIFICATION_FIELDS");
    assert.equal(verification.kind, "visual_asset_binding", "SELECTED_ANNOTATION_KIND");
    assert.ok(Array.isArray(verification.asset_ids) && verification.asset_ids.length > 0
      && verification.asset_ids.every(id => typeof id === "string" && id.trim() === id && id.length > 0)
      && new Set(verification.asset_ids).size === verification.asset_ids.length, "SELECTED_ANNOTATION_ASSET_IDS");
    assert.deepEqual([...verification.asset_ids].sort(), (segment.visual_asset_refs || []).map(ref => ref.asset_id).sort(), "SELECTED_ANNOTATION_REFERENCE_DRIFT");
    assert.equal(expected.visual_asset_plan?.mode, "selected", "SELECTED_ANNOTATION_SELECTED_REQUIRED");
    assert.ok(segment.visual_asset_refs.every(ref => expected.visual_asset_plan.assets.some(asset => asset.id === ref.asset_id && asset.role === ref.role)), "SELECTED_ANNOTATION_ROLE_DRIFT");
    check.verification = structuredClone(verification);
  }
  expected.host_annotation = structuredClone(marker);
  assert.deepEqual(pkg, expected, "SELECTED_ANNOTATION_CHANGED_MODEL_EVIDENCE");
  return { mode: "host-annotated", originalPackageSha256: manifest.original_package_sha256,
    annotationManifestSha256: manifestSha256, annotatedCheckCount: seen.size, onlyVerificationAdded: true };
}

export async function loadPackageProvenance(pkg, values) {
  if (!Object.hasOwn(pkg, "host_annotation")) {
    assert.ok(!values["annotation-file"] && !values["annotation-sha256"], "SELECTED_ANNOTATION_MARKER_MISSING");
    return { mode: "native-package", originalPackageSha256: values["package-sha256"], annotatedCheckCount: 0 };
  }
  assert.ok(values["annotation-file"] && values["annotation-sha256"], "SELECTED_ANNOTATION_PROVENANCE_REQUIRED");
  const manifestPath = path.resolve(values["annotation-file"]);
  const manifestBytes = await fs.readFile(manifestPath);
  assert.ok(manifestBytes.length > 0 && manifestBytes.length <= 256 * 1024, "SELECTED_ANNOTATION_MANIFEST_SIZE");
  assert.equal(hash(manifestBytes), values["annotation-sha256"], "SELECTED_ANNOTATION_MANIFEST_CHANGED");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(typeof manifest.original_package_file === "string" && manifest.original_package_file.trim(), "SELECTED_ANNOTATION_ORIGINAL_PATH");
  const originalBytes = await fs.readFile(path.resolve(path.dirname(manifestPath), manifest.original_package_file));
  assert.ok(originalBytes.length > 0 && originalBytes.length < 2 * 1024 * 1024, "SELECTED_ANNOTATION_ORIGINAL_SIZE");
  return validateAnnotationProvenance(pkg, originalBytes, manifestBytes, values["annotation-sha256"]);
}

export async function loadContracts() {
  const [bridge, contract, binding, structured] = await Promise.all([
    tsImport("../src/lib/storyboard-canvas-bridge.ts", import.meta.url),
    tsImport("../src/lib/storyboard-project-contract.ts", import.meta.url),
    tsImport("../src/lib/storyboard-visual-asset-binding.ts", import.meta.url),
    tsImport("../src/lib/structured-agent-output.ts", import.meta.url),
  ]);
  return { parseBridge: bridge.parseStoryboardCanvasImport, projectSchema: contract.StoryboardProjectDocument,
    urlMatchesSource: binding.visualAssetUrlMatchesSource, parseStructured: structured.parseStructuredAgentOutput,
    buildReady: structured.buildStructuredAgentOutputReadyDetail };
}

export function validateSelectedPackage(pkg, parseBridge) {
  assert.equal(pkg?.schema_version, "storyboard_director_output.v1", "SELECTED_STABLE_PACKAGE_REQUIRED");
  const detail = {
    source: "stable_json", schema_version: pkg.schema_version, machine_payload: pkg,
    message_id: "selected-real-output", commit_key: hash(JSON.stringify(pkg)), segments: [],
  };
  const plan = parseBridge(detail);
  assert.ok(plan, "SELECTED_BRIDGE_REJECTED");
  assert.equal(plan.settings.targetDurationSeconds, 10, "SELECTED_TEN_SECONDS_REQUIRED");
  assert.equal(plan.settings.aspectRatio, "16:9", "SELECTED_LANDSCAPE_REQUIRED");
  mediaPhaseSequence(plan.segments.length);
  assert.equal(plan.visualAssetPlan?.mode, "selected", "SELECTED_ASSET_MODE_REQUIRED");
  const assets = plan.visualAssetPlan.assets;
  const identities = identityAssets(plan.visualAssetPlan);
  const deferred = assets.filter(asset => !identities.includes(asset));
  for (const role of ["character", "pet"]) assert.equal(assets.filter(asset => asset.role === role).length, 1, "SELECTED_ONE_PER_ROLE");
  assert.ok(assets.every(asset => !asset.source && asset.referencePrompts?.length && asset.referencePrompts[0].prompt.trim()), "SELECTED_NEW_ASSET_PLAN_REQUIRED");
  assert.ok(deferred.every(asset => ["environment", "prop"].includes(asset.role) && !asset.anchorRequired), "SELECTED_UNSUPPORTED_DEFERRED_ASSET");
  const policy = plan.visualAssetPlan.generationPolicy;
  assert.ok(policy && policy.maxInitialImages >= 2, "SELECTED_TWO_ASSET_POLICY_REQUIRED");
  assert.deepEqual([...policy.initialRequiredAssetIds].sort(), identities.map(asset => asset.id).sort(), "SELECTED_REQUIRED_ASSET_DRIFT");
  assert.deepEqual([...policy.initialDeferredAssetIds].sort(), deferred.map(asset => asset.id).sort(), "SELECTED_DEFERRED_ASSET_DRIFT");
  assert.ok(!(plan.environmentGroups || []).some(group => group.anchorRequired || group.environmentMode === "anchor"), "SELECTED_EXTRA_ANCHOR_REQUIRED");
  assert.equal(new Set(plan.segments.map(s => s.segmentId)).size, plan.segments.length, "SELECTED_SEGMENT_ID_DUPLICATE");
  for (const segment of plan.segments) {
    assert.equal(segment.panelCount, 4, "SELECTED_FOUR_PANELS_REQUIRED");
    assert.equal(segment.layout, "two_by_two", "SELECTED_GRID_REQUIRED");
    assert.ok(segment.imagePrompt.trim() && segment.videoPrompt.trim(), "SELECTED_PROMPTS_REQUIRED");
    assert.ok(Array.isArray(segment.visualAssetRefs) && segment.visualAssetRefs.length > 0, "SELECTED_EXPLICIT_REFS_REQUIRED");
    assert.equal(new Set(segment.visualAssetRefs.map(ref => ref.assetId)).size, segment.visualAssetRefs.length, "SELECTED_DUPLICATE_REF");
    for (const ref of segment.visualAssetRefs) {
      assert.ok(identities.some(asset => asset.id === ref.assetId && asset.role === ref.role), "SELECTED_UNKNOWN_OR_DEFERRED_REFERENCE");
    }
  }
  return plan;
}

export function makeStagingDocument(plan, values, now = Date.now()) {
  return {
    id: values["project-id"], title: `selected · ${values["run-id"]}`, createdAt: now, updatedAt: now,
    ratio: "16:9", imageRatio: values["aspect-ratio"] || "16:9", imageResolution: values.resolution || "",
    videoResolution: "", videoDuration: 10, imageModelId: values["model-id"] || "", videoModelId: "",
    wardrobePlan: plan.wardrobePlan, environmentGroups: plan.environmentGroups || [],
    visualAssetPlan: structuredClone(plan.visualAssetPlan),
    visualAssetWorkspace: {
      drafts: identityAssets(plan.visualAssetPlan).map(asset => ({
        planId: asset.id, role: asset.role, name: asset.name,
        prompt: asset.referencePrompts[0].prompt, tagsText: "", customCategory: "",
      })), candidates: [],
    },
    cards: plan.segments.map((segment, index) => ({
      id: cardIdForOrder(values, index + 1), order: index + 1,
      sourceNumber: segment.sourceIndex, label: `分段 ${index + 1}`, narration: segment.narration,
      imagePrompt: segment.imagePrompt, videoPrompt: segment.videoPrompt,
      sceneId: segment.sceneId, sceneZone: segment.sceneZone, styleLock: segment.styleLock,
      sceneLock: segment.sceneLock, camera: segment.camera, dynamicState: segment.dynamicState || [],
      capabilityGaps: segment.capabilityGaps || [], bottomPanelRole: segment.bottomPanelRole,
      qualityChecks: segment.qualityChecks || [], wardrobeChangeEvents: segment.wardrobeChangeEvents || [],
      visualAssetRefsMode: "explicit", visualAssetSelectionMode: "custom",
      visualAssetRefs: structuredClone(segment.visualAssetRefs), referenceImageUrls: [], imageStatus: "idle", videoStatus: "idle",
    })),
  };
}

export function assertDocumentInputs(document, plan, values) {
  assert.equal(document.id, values["project-id"], "SELECTED_PROJECT_DRIFT");
  assert.equal(document.ratio, "16:9", "SELECTED_PROJECT_RATIO_DRIFT");
  assert.equal(document.cards?.length, plan.segments.length, "SELECTED_CARD_COUNT_DRIFT");
  assert.equal(document.visualAssetPlan?.mode, "selected", "SELECTED_MODE_DRIFT");
  if (values.nativePlan) assert.deepEqual(withoutAssetSources(document.visualAssetPlan), withoutAssetSources(values.nativePlan), "SELECTED_NATIVE_PLAN_DRIFT");
  if (values["existing-project-id"]) {
    assert.deepEqual(cleanJson(document.wardrobePlan), cleanJson(plan.wardrobePlan), "SELECTED_WARDROBE_DRIFT");
    assert.deepEqual(cleanJson(document.environmentGroups || []), cleanJson(plan.environmentGroups || []), "SELECTED_ENVIRONMENT_DRIFT");
  }
  assert.deepEqual(document.visualAssetPlan.assets.map(a => [a.id, a.role]).sort(), plan.visualAssetPlan.assets.map(a => [a.id, a.role]).sort(), "SELECTED_SLOT_DRIFT");
  for (const asset of document.visualAssetPlan.assets.filter(a => !["character", "pet"].includes(a.role))) {
    assert.ok(!asset.source, "SELECTED_DEFERRED_SOURCE_FORBIDDEN");
  }
  for (const [index, segment] of plan.segments.entries()) {
    const card = document.cards[index];
    assert.equal(card.id, cardIdForOrder(values, index + 1), "SELECTED_CARD_ID_DRIFT");
    assert.equal(card.order, index + 1, "SELECTED_CARD_ORDER_DRIFT");
    assert.equal(card.narration, segment.narration, "SELECTED_NARRATION_DRIFT");
    if (values["existing-project-id"]) {
      assert.equal(card.sourceNumber, segment.sourceIndex, "SELECTED_SOURCE_ORDER_DRIFT");
      for (const key of ["sceneId", "sceneZone", "styleLock", "sceneLock", "camera", "bottomPanelRole"]) {
        assert.deepEqual(cleanJson(card[key]), cleanJson(segment[key]), "SELECTED_NATIVE_CARD_METADATA_DRIFT");
      }
      for (const key of ["dynamicState", "capabilityGaps", "wardrobeChangeEvents"]) {
        assert.deepEqual(cleanJson(card[key] || []), cleanJson(segment[key] || []), "SELECTED_NATIVE_CARD_METADATA_DRIFT");
      }
    }
    assert.equal(card.imagePrompt, segment.imagePrompt, "SELECTED_IMAGE_PROMPT_DRIFT");
    assert.equal(card.videoPrompt, segment.videoPrompt, "SELECTED_VIDEO_PROMPT_DRIFT");
    assert.deepEqual(card.qualityChecks || [], segment.qualityChecks || [], "SELECTED_QUALITY_EVIDENCE_DRIFT");
    assert.equal(card.videoStatus, "idle", "SELECTED_UNEXPECTED_VIDEO");
  }
}

export function assertSelectedBindings(document, plan, values, reports) {
  assertDocumentInputs(document, plan, values);
  if (reports) assertAssetCandidatePins(document, plan, values, reports, true);
  const assets = identityAssets(document.visualAssetPlan);
  for (const asset of assets) {
    assert.ok(asset.source?.assetId && asset.source.storageKey && asset.source.librarySaved === true, "SELECTED_PERSISTENT_ASSET_REQUIRED");
    assert.match(asset.source.historyRecordId || "", /^[a-f0-9]{64}$/u, "SELECTED_ASSET_RECORD_REQUIRED");
  }
  for (const [index, segment] of plan.segments.entries()) {
    const card = document.cards[index];
    assert.equal(card.visualAssetSelectionMode, "custom", "SELECTED_CUSTOM_BINDING_REQUIRED");
    assert.deepEqual((card.visualAssetRefs || []).map(ref => [ref.assetId, ref.role]).sort(),
      segment.visualAssetRefs.map(ref => [ref.assetId, ref.role]).sort(), "SELECTED_CARD_REFERENCE_DRIFT");
    assert.equal(card.referenceImageUrls.length, segment.visualAssetRefs.length, "SELECTED_ACTUAL_REFERENCE_COUNT");
    assert.ok(card.referenceImageUrls.every(url => typeof url === "string" && url.length > 0), "SELECTED_EMPTY_REFERENCE");
  }
}

// Reuse the same pure formatter imported by the workbench, without copying prose.
export async function readAssetPromptBuilder() {
  const source = await fs.readFile(path.join(ROOT, "src/lib/storyboard-visual-asset-prompt.ts"), "utf8");
  const module = await tsImport("../src/lib/storyboard-visual-asset-prompt.ts", import.meta.url);
  assert.equal(typeof module.buildVisualAssetPrompt, "function", "SELECTED_ASSET_FORMATTER_INVALID");
  return { format: module.buildVisualAssetPrompt, sha256: hash(source) };
}

export async function writeEvidence(file, value, io = fs) {
  await io.writeFile(file, JSON.stringify(safeHarnessEvidence(value), null, 2) + "\n", { flag: "wx" });
}

async function poll(read, predicate, code, attempts = 40) {
  for (let index = 0; index < attempts; index++) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(500);
  }
  throw new Error(code);
}

export function assertPhasePredecessors(phase, reports, segmentCount = 3) {
  const phases = mediaPhaseSequence(segmentCount);
  assertMediaPhase(phase, segmentCount);
  const index = phases.indexOf(phase);
  for (const previous of phases.slice(0, index)) {
    assert.equal(reports[previous]?.success, true, "SELECTED_PREVIOUS_PHASE_UNCONFIRMED");
    assert.equal(reports[previous]?.phase, previous, "SELECTED_PREVIOUS_PHASE_DRIFT");
  }
}

export async function main(args = process.argv.slice(2)) {
  const paid = parseSelectedArgs(args);
  if (paid.flags.has("self-test")) {
    const { runSelfTest } = await import("./verify-storyboard-selected-media-selftest.mjs");
    return runSelfTest();
  }
  const v = paid.values, phase = v.phase, isAsset = phase.startsWith("asset-"), isBind = phase === "bind";
  const generationContract = phaseGenerationContract(v);
  const sourceBytes = await fs.readFile(path.resolve(v["package-file"]));
  assert.ok(sourceBytes.length > 0 && sourceBytes.length < 2 * 1024 * 1024, "SELECTED_PACKAGE_SIZE");
  assert.equal(hash(sourceBytes), v["package-sha256"], "SELECTED_PACKAGE_CHANGED");
  const contracts = await loadContracts();
  const pkg = JSON.parse(sourceBytes.toString("utf8"));
  let provenance = await loadPackageProvenance(pkg, v);
  // The production bridge applies the planning gate; actual generation still
  // resolves and binds the persisted sources through the unchanged strict gate.
  const plan = validateSelectedPackage(pkg, contracts.parseBridge);
  const phases = mediaPhaseSequence(plan.segments.length);
  assertMediaPhase(phase, plan.segments.length);
  const official = await loadOfficialHandoff(v, pkg, contracts, plan);
  if (official) {
    v.cardOrderMap = official.cardOrderMap;
    v.nativePlan = official.nativePlan;
    provenance = { ...provenance, officialHandoff: official.summary };
  }
  const planning = { validationPassed: true, pendingRuntimePrerequisites: plan.pendingRuntimePrerequisites || [],
    runtimeBindingVerified: false };
  const staging = contracts.projectSchema.parse(makeStagingDocument(plan, v));
  const cardOrderMap = staging.cards.map(card => ({ order: card.order, id: card.id }));
  const workflowDir = path.join(ROOT, ".codex-evidence/storyboard-selected-media", v["project-id"]);
  const phaseDir = path.join(workflowDir, phase);
  if (!paid.flags.has("execute")) {
    console.log(JSON.stringify({ mode: "plan", phase, generationContract, allocatedBudget: isBind ? 0 : paid.maxCharge, generationLimit: isBind ? 0 : 1,
      projectLoadMode: official ? "existing-official-ui-project" : "stable-v1-bridge-to-real-project-api", officialAgentHandoffVerified: false, stagedEmptyReferences: false,
      plannedSourcesPending: true, sourceBindingPath: "incremental-planned-source-preparation",
      packageSha256: v["package-sha256"], provenance, planning, segments: plan.segments.length, initialAssetImages: 2, storyboardImages: plan.segments.length,
      originalPromptHashes: plan.segments.map(s => ({ image: hash(s.imagePrompt), video: hash(s.videoPrompt) })), phaseDir }));
    return;
  }
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/+$/u, "");
  assert.equal(origin, "http://127.0.0.1:5000", "SELECTED_LOCAL_ONLY");
  const token = String(paid.actorRole === "admin" ? process.env.LOCAL_NAV_ADMIN_TOKEN || "" : process.env.R267_CUSTOMER_TOKEN || "").trim();
  assert.ok(token, "SELECTED_CONTROLLED_SESSION_REQUIRED");
  const request = async (pathname, init = {}) => {
    const response = await fetch(origin + pathname, { ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
    const body = await response.json();
    assert.ok(response.ok, "SELECTED_API_REQUEST_FAILED");
    return body;
  };
  const readProject = async () => (await request(`/api/storyboard/projects?id=${encodeURIComponent(v["project-id"])}`)).project;
  const billing = async () => {
    const [cash, rows, credits] = await Promise.all([
      request("/api/cash/balance"), request("/api/user/transactions?type=cash&transactionType=consume&page=1&pageSize=50"),
      request(`/api/credits?user_id=${encodeURIComponent(paid.userId)}&include_transactions=0`),
    ]);
    const value = { balance: Number(cash.balance), credits: Number(credits.credits), reservedCredits: Number(credits.reservedCredits),
      rows: (rows.data?.transactions || []).filter(row => row.category === "cash") };
    assert.ok([value.balance, value.credits, value.reservedCredits].every(Number.isFinite), "SELECTED_BILLING_SNAPSHOT_INVALID");
    return value;
  };
  const pins = { origin, expectedSourceVersion: v["expected-source-version"], expectedBuildId: v["expected-build-id"] };
  const runtimeBefore = await runtimeIdentity(pins);
  const readiness = await readPaidDatabaseReadiness(paid, runtimeBefore);
  const identity = await request("/api/auth/me");
  const actor = assertPaidActor(identity, paid);
  const officialHandoffVerified = await verifyOfficialHandoffSource(official, pkg, contracts, runtimeBefore, actor, request);
  const { rawModel, model, quote } = await readPhaseModel(generationContract,
    () => request("/api/cover-models?surface=storyboard-workbench"), paid);
  if (generationContract) assertReferenceCapacity(rawModel, isAsset ? 0 : Math.max(...plan.segments.map(segment => segment.visualAssetRefs.length)));
  const prior = {};
  for (const previous of phases.slice(0, phases.indexOf(phase))) {
    const previousDir = path.join(workflowDir, previous);
    const files = await Promise.all(["dispatch.json", "request.json", "terminal-readback.json", "report.json"]
      .map(name => fs.readFile(path.join(previousDir, name), "utf8").then(JSON.parse)));
    const bundle = { dispatch: files[0], request: files[1], terminal: files[2], report: files[3] };
    if (previous.startsWith("asset-")) bundle.assetBinding = JSON.parse(await fs.readFile(path.join(previousDir, "asset-binding.json"), "utf8"));
    prior[previous] = assertPhaseEvidence(previous, bundle, { projectId: v["project-id"], actorId: actor.id,
      packageSha256: v["package-sha256"], provenance, cardOrderMap });
  }
  assertPhasePredecessors(phase, prior, plan.segments.length);
  const firstDispatch = phase === phases[0] ? null : JSON.parse(await fs.readFile(path.join(workflowDir, phases[0], "dispatch.json"), "utf8"));
  const initialBudget = firstDispatch?.workflowBudget || paid.remainingBudget;
  const spent = money(Object.values(prior).reduce((sum, report) => sum + Number(report.billing?.balanceDelta || 0), 0));
  assert.ok(isBind || quote <= money(initialBudget - spent), "SELECTED_WORKFLOW_BUDGET_EXCEEDED");
  const before = await billing();
  await fs.mkdir(phaseDir, { recursive: true });
  // This is the durable, stage-scoped occupancy. A different run-id cannot replay the same phase.
  await writeEvidence(path.join(phaseDir, "dispatch.json"), {
    phase, runId: v["run-id"], projectId: v["project-id"], packageSha256: v["package-sha256"], provenance, planning,
    actor, generationContract, cardOrderMap, modelId: generationContract?.modelId ?? null, resolution: generationContract?.resolution ?? null,
    aspectRatio: generationContract?.aspectRatio ?? null, quote,
    allocatedBudget: isBind ? 0 : paid.maxCharge, workflowBudget: isBind ? 0 : initialBudget, spentBefore: spent,
    generationLimit: isBind ? 0 : 1, automaticRetries: 0, runtimeBefore, createdAt: new Date().toISOString(),
  });
  if (isBind) await writeEvidence(path.join(phaseDir, "request.json"), { phase, runId: v["run-id"],
    projectId: v["project-id"], actor, packageSha256: v["package-sha256"], provenance,
    generationContract: null, cardOrderMap, quote: 0, allocatedBudget: 0, generationPosts: 0, dispatchState: "generation-forbidden" });
  let browser, page, receipt, boundary, assetBinding = null;
  let stage = "load-project", generationPosts = 0, armed = false, accepted = false;
  let requestBody, imageResponseBody;
  const admission = { generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0 };
  const routeEvidence = {}, blockedWrites = [];
  const writes = { projects: 0, imageExports: 0, visualAssets: 0 };
  let expectedGeneration, expectedConfirm, currentAsset, expectedReferenceSources;
  try {
    if (phase === "asset-character" && !official) {
      await request("/api/storyboard/projects", { method: "POST", body: JSON.stringify({ document: staging, expectedRevision: 0 }) });
      writes.projects++;
    }
    let project = await readProject();
    if (official) {
      assert.equal(project.id, v["existing-project-id"], "SELECTED_EXISTING_PROJECT_READBACK_DRIFT");
      if (phase === "asset-character") {
        assert.equal(project.revision, official.summary.originalProjectRevision, "SELECTED_EXISTING_PROJECT_REVISION_DRIFT");
        assertFreshImportedDocument(project.document, plan, v);
      }
    }
    assertDocumentInputs(project.document, plan, v);
    if (phase.startsWith("storyboard-")) assertSelectedBindings(project.document, plan, v, prior);
    if (isBind) assertAssetCandidatePins(project.document, plan, v, prior);
    if (isAsset) {
      currentAsset = plan.visualAssetPlan.assets.find(asset => asset.role === phase.slice(6));
      assert.ok(!project.document.visualAssetWorkspace?.candidates.some(c => c.planId === currentAsset.id), "SELECTED_ASSET_ALREADY_HAS_CANDIDATE");
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    await installPaidAuthCookie(context, origin, token);
    await context.addInitScript(({ sessionToken, user }) => {
      localStorage.setItem("auth_token", sessionToken);
      localStorage.setItem("auth_user", JSON.stringify(user));
      sessionStorage.setItem("entered_app", "1");
    }, { sessionToken: token, user: identity.user });
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (["GET", "HEAD", "OPTIONS"].includes(req.method())) return route.continue();
      if (url.origin === origin && ["/api/product-usage/events", "/api/announcements/events"].includes(url.pathname)) return route.abort("blockedbyclient");
      let body;
      try { body = req.postDataJSON(); } catch {
        blockedWrites.push({ method: req.method(), path: url.pathname });
        return route.abort("blockedbyclient");
      }
      let allowed = false;
      if (url.origin === origin && req.method() === "POST") {
        if (url.pathname === "/api/storyboard/projects" && body?.document?.id === v["project-id"]) {
          try { assertDocumentInputs(body.document, plan, v);
            if (!isAsset) assertAssetCandidatePins(body.document, plan, v, prior, !isBind);
            allowed = true; writes.projects++; } catch { /* fail closed */ }
        } else if (isAsset && receipt && writes.imageExports === 0 && url.pathname === "/api/image-workbench/persist"
          && body?.intent === "user_asset_export" && body.index === 0
          && body.clientTraceId === `visual-asset-save-${receipt.assetId || `generated_${receipt.recordId}`}`) {
          allowed = true; writes.imageExports++;
        } else if (isAsset && receipt && writes.visualAssets === 0 && url.pathname === "/api/storyboard/visual-assets"
          && body?.projectId === v["project-id"] && body.role === currentAsset.role && body.name === currentAsset.name) {
          allowed = true; writes.visualAssets++;
        }
      }
      if (!allowed) { blockedWrites.push({ method: req.method(), path: url.pathname }); return route.abort("blockedbyclient"); }
      return route.continue();
    });
    const paidHandler = makeWorkbenchPaidPostHandler({
      diagnostics: admission, isArmed: () => armed && accepted && !isBind,
      expected: {}, checkFresh: async route => {
        const body = route.request().postDataJSON();
        assert.ok(!isBind && generationContract && expectedGeneration, "SELECTED_NO_FROZEN_REQUEST");
        if (phase.startsWith("storyboard-")) assertSelectedBindings((await readProject()).document, plan, v, prior);
        for (const [key, value] of Object.entries(expectedGeneration)) assert.deepEqual(body[key], value, "SELECTED_GENERATION_CONTRACT_DRIFT");
        if (expectedReferenceSources) {
          const urls = body.referenceImageUrls;
          assert.ok(Array.isArray(urls) && urls.length === expectedReferenceSources.length, "SELECTED_SUBMITTED_REFERENCE_COUNT");
          assert.ok(expectedReferenceSources.every(source => urls.filter(url => contracts.urlMatchesSource(url, source)).length === 1)
            && urls.every(url => expectedReferenceSources.filter(source => contracts.urlMatchesSource(url, source)).length === 1),
          "SELECTED_SUBMITTED_REFERENCE_OWNERSHIP");
        }
        for (const key of [body.clientIdempotencyKey, body.clientTraceId]) {
          assert.match(key || "", /^[A-Za-z0-9._:-]{1,200}$/u, "SELECTED_REQUEST_KEYS_MISSING");
        }
        const fresh = await request("/api/cover-models?surface=storyboard-workbench");
        const freshRawModel = fresh.models?.find(item => item.id === model.id);
        assertReferenceCapacity(freshRawModel, body.referenceImageUrls.length);
        const freshModel = publicModelProjection(freshRawModel);
        assert.deepEqual(freshModel, model, "SELECTED_CATALOG_DRIFT");
        assert.equal(quotedModelPrice(freshModel, v.resolution), quote, "SELECTED_PRICE_DRIFT");
        assert.deepEqual(await runtimeIdentity(pins), runtimeBefore, "SELECTED_RUNTIME_DRIFT");
        await writeEvidence(path.join(phaseDir, "request.json"), {
          phase, runId: v["run-id"], projectId: v["project-id"], actor, packageSha256: v["package-sha256"], provenance,
          generationContract, cardOrderMap, quote, allocatedBudget: paid.maxCharge, resolution: body.resolution, aspectRatio: body.aspectRatio, clientIdempotencyKey: body.clientIdempotencyKey,
          clientTraceId: body.clientTraceId, clientNodeId: body.clientNodeId, modelId: body.modelId,
          promptSha256: hash(body.prompt), referenceCount: body.referenceImageUrls.length,
          dispatchState: "persisted-before-forwarding", providerDispatchCount: "unknown",
        });
        requestBody = body;
      },
    });
    boundary = makeMediaPaidRouteBoundary(paidHandler, routeEvidence);
    await context.route("**/api/image/generate", boundary.handler);
    page = await context.newPage();
    page.on("request", req => {
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/image/generate") generationPosts++;
    });
    let confirmResolve, confirmReject, confirmations = 0;
    const confirmed = observeMediaPromise(new Promise((resolve, reject) => { confirmResolve = resolve; confirmReject = reject; }));
    page.on("dialog", async dialog => {
      try {
        confirmations++;
        assert.equal(confirmations, 1, "SELECTED_EXTRA_CONFIRMATION");
        assert.ok(armed && !isBind, "SELECTED_UNARMED_CONFIRMATION");
        assert.equal(dialog.type(), "confirm", "SELECTED_DIALOG_TYPE");
        assert.equal(dialog.message(), expectedConfirm, "SELECTED_CONFIRMATION_DRIFT");
        accepted = true;
        await dialog.accept();
        confirmResolve();
      } catch (error) {
        accepted = false;
        await dialog.dismiss().catch(() => undefined);
        confirmReject(error);
      }
    });
    stage = "open-exact-project";
    await page.goto(`${origin}/storyboard-workbench?projectId=${encodeURIComponent(v["project-id"])}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    const firstCard = page.locator(`[data-sbw-card-id="${staging.cards[0].id}"]`);
    await firstCard.waitFor({ state: "visible", timeout: 45000 });
    assert.equal(await page.locator("article.sbw-shot-card").count(), plan.segments.length, "SELECTED_UI_CARD_COUNT");
    for (let index = 0; index < plan.segments.length; index++) {
      const card = page.locator(`[data-sbw-card-id="${staging.cards[index].id}"]`);
      assert.equal(await card.getByRole("textbox", { name: `分段${index + 1}生图提示词`, exact: true }).inputValue(), plan.segments[index].imagePrompt, "SELECTED_UI_PROMPT_DRIFT");
    }
    let modelName = "";
    if (generationContract && isAsset) {
      const settings = page.getByRole("region", { name: "参考图生成设置", exact: true });
      const boardSettings = await readProject();
      const beforeBoard = { modelId: boardSettings.document.imageModelId, resolution: boardSettings.document.imageResolution,
        imageRatio: boardSettings.document.imageRatio, ratio: boardSettings.document.ratio };
      await settings.getByRole("combobox", { name: "参考图生图模型", exact: true }).selectOption(model.id);
      modelName = (await settings.getByRole("combobox", { name: "参考图生图模型", exact: true }).locator("option:checked").innerText()).replace(/ · ¥[0-9.]+$/u, "").trim();
      assert.ok(modelName, "SELECTED_UI_MODEL_NAME_MISSING");
      await settings.getByRole("combobox", { name: "参考图比例", exact: true }).selectOption(generationContract.aspectRatio);
      await settings.getByRole("combobox", { name: "参考图清晰度", exact: true }).selectOption(v.resolution);
      const afterBoard = await readProject();
      assert.deepEqual({ modelId: afterBoard.document.imageModelId, resolution: afterBoard.document.imageResolution,
        imageRatio: afterBoard.document.imageRatio, ratio: afterBoard.document.ratio }, beforeBoard, "SELECTED_REFERENCE_CHANGED_BOARD_SETTINGS");
    } else if (generationContract) {
      const modelButton = page.locator(`.sbw-image-model-list button[data-model-id="${model.id}"]`);
      await modelButton.click();
      await poll(() => modelButton.getAttribute("class"), value => /\bis-active\b/u.test(value || ""), "SELECTED_MODEL_NOT_ACTIVE");
      modelName = (await modelButton.locator(".sbw-model-name").innerText()).trim();
      assert.ok(modelName, "SELECTED_UI_MODEL_NAME_MISSING");
      const settings = page.getByRole("region", { name: "分镜工作台全局设置", exact: true }).locator(".sbw-control-group.is-image");
      await settings.getByRole("button", { name: generationContract.aspectRatio, exact: true }).click();
      const resolutionSelect = settings.getByRole("combobox", { name: "图片分辨率" });
      if (await resolutionSelect.count()) await resolutionSelect.selectOption(v.resolution);
      else await settings.getByText(v.resolution, { exact: true }).waitFor();
    }

    if (isBind) {
      stage = "bind-real-assets";
      for (const asset of identityAssets(plan.visualAssetPlan)) {
        const slot = page.locator(`.svad-reference-slot[data-plan-id="${asset.id}"]`);
        await slot.getByRole("button", { name: "使用这张", exact: true }).click();
        await poll(readProject, item => item.document.visualAssetPlan.assets.find(a => a.id === asset.id)?.source?.librarySaved === true, "SELECTED_ASSET_APPLICATION_NOT_SAVED");
      }
      for (const [index, segment] of plan.segments.entries()) {
        const card = page.locator(`[data-sbw-card-id="${staging.cards[index].id}"]`);
        const details = card.locator(`details[aria-label="分段${index + 1}参考选择"]`);
        if (!await details.evaluate(element => element.open)) await details.locator("summary").click();
        for (const ref of segment.visualAssetRefs) {
          const asset = plan.visualAssetPlan.assets.find(a => a.id === ref.assetId);
          await details.getByRole("checkbox", { name: `分段${index + 1}选择${asset.name}`, exact: true }).check();
          await poll(readProject, item => item.document.cards[index].visualAssetRefs?.some(r => r.assetId === asset.id), "SELECTED_SEGMENT_REFERENCE_NOT_SAVED");
        }
      }
      project = await readProject();
      assertSelectedBindings(project.document, plan, v, prior);
    } else {
      let button, imageLocator, formatterSha256;
      const common = { ...generationContract,
        historySurface: "storyboard-workbench", noRetry: true, strictSingleSubmit: true };
      if (isAsset) {
        stage = `prepare-${phase}`;
        const slot = page.locator(`.svad-reference-slot[data-plan-id="${currentAsset.id}"]`);
        const roleLabel = currentAsset.role === "character" ? "人物" : "宠物";
        assert.equal(await slot.getByRole("textbox", { name: `${roleLabel}参考提示词`, exact: true }).inputValue(), currentAsset.referencePrompts[0].prompt, "SELECTED_ASSET_PROMPT_DRIFT");
        const formatter = await readAssetPromptBuilder();
        formatterSha256 = formatter.sha256;
        expectedGeneration = { ...common, prompt: formatter.format(currentAsset.role, currentAsset.referencePrompts[0].prompt.trim()),
          referenceImageUrls: [], referenceUsage: "character-identity", clientNodeId: `${v["project-id"]}-${currentAsset.id}` };
        expectedConfirm = `生成${roleLabel}参考图：${currentAsset.name}\n模型：${modelName} · ${v.resolution}\n预计费用：¥${quote.toFixed(2)}，仅提交一次，不自动重试。`;
        button = slot.getByRole("button", { name: "生成参考图", exact: true });
        imageLocator = slot.locator(".svad-slot-result img");
      } else {
        stage = `prepare-${phase}`;
        const index = assertMediaPhase(phase, plan.segments.length) - 1;
        project = await readProject();
        assertSelectedBindings(project.document, plan, v, prior);
        const card = project.document.cards[index], segment = plan.segments[index];
        assert.equal(card.imageStatus, "idle", "SELECTED_CARD_ALREADY_ATTEMPTED");
        // Resolve exactly the persisted sources again; signed URLs are compared to the current UI request below.
        expectedReferenceSources = segment.visualAssetRefs.map(ref => project.document.visualAssetPlan.assets.find(a => a.id === ref.assetId).source);
        expectedGeneration = { ...common, prompt: segment.imagePrompt, referenceUsage: "character-identity",
          clientNodeId: `${v["project-id"]}-shot-${index + 1}`, resumeDeliveryOnly: false };
        expectedConfirm = `生成段落${index + 1}分镜图 · ${modelName}\n参考图 ${segment.visualAssetRefs.length}张，预计 ¥${quote.toFixed(2)}。仅提交一次，不自动重试。`;
        const cardElement = page.locator(`[data-sbw-card-id="${card.id}"]`);
        button = cardElement.getByRole("button", { name: "生成图片", exact: true });
        imageLocator = cardElement.getByRole("img", { name: `任务${index + 1}故事板`, exact: true });
      }
      assert.equal(await button.isEnabled(), true, "SELECTED_GENERATE_BUTTON_DISABLED");
      stage = "single-generation";
      armed = true;
      const result = await awaitMediaGenerationResponse({ page, click: () => button.click(), failure: boundary.failure,
        pathname: "/api/image/generate", timeoutMs: 360000, capture: confirmed, captureTimeoutMs: 15000 });
      armed = false;
      imageResponseBody = await result.response.json();
      assert.equal(result.response.status(), 200, "SELECTED_GENERATION_RESPONSE_FAILED");
      receipt = projectImageDelivery(imageResponseBody);
      assert.equal(receipt.cashCharged, quote, "SELECTED_CHARGE_DRIFT");
      assert.match(receipt.recordId || "", /^[a-f0-9]{64}$/u, "SELECTED_GENERATION_RECORD_REQUIRED");
      const query = new URLSearchParams({ clientIdempotencyKey: requestBody.clientIdempotencyKey, clientTraceId: requestBody.clientTraceId });
      const status = await request(`/api/image/status?${query}`);
      assertImageReceiptBinding(receipt, status);
      const afterGeneration = await poll(billing, value => value.rows.some(row => !before.rows.some(old => old.id === row.id)), "SELECTED_LEDGER_NOT_VISIBLE");
      const newRows = afterGeneration.rows.filter(row => !before.rows.some(old => old.id === row.id));
      assert.equal(afterGeneration.credits, before.credits, "SELECTED_CREDIT_DRIFT");
      assert.equal(afterGeneration.reservedCredits, before.reservedCredits, "SELECTED_RESERVED_CREDIT_DRIFT");
      assertPaidFinalPass({ actor, expectedRole: paid.actorRole, completed: status.state === "completed",
        cashDelta: money(before.balance - afterGeneration.balance), quote, newCashRows: newRows.length, generationPosts });
      assert.equal(newRows[0].referenceId, receipt.billingReferenceId, "SELECTED_LEDGER_RECEIPT_DRIFT");
      assert.equal(money(Math.abs(Number(newRows[0].amount))), quote, "SELECTED_LEDGER_AMOUNT_DRIFT");
      await writePaidTerminalReadback(phaseDir, { phase, runId: v["run-id"], projectId: v["project-id"], actor, runtimeBefore,
        packageSha256: v["package-sha256"], provenance, planning, generationContract, cardOrderMap, quote, allocatedBudget: paid.maxCharge, terminalStatus: status.state, deliveryReceipt: receipt, admission,
        ...routeEvidence, formatterSha256, generationPosts,
        billing: { balanceDelta: money(before.balance - afterGeneration.balance), referenceId: newRows[0].referenceId } });
      stage = "inspect-and-persist-output";
      await waitForImageDecoded(imageLocator, { timeout: 60000 });
      if (isAsset) {
        const slot = page.locator(`.svad-reference-slot[data-plan-id="${currentAsset.id}"]`);
        await poll(readProject, item => item.document.visualAssetWorkspace?.candidates.some(c => c.planId === currentAsset.id && c.historyRecordId === receipt.recordId), "SELECTED_CANDIDATE_NOT_SAVED");
        const generated = (await readProject()).document.visualAssetWorkspace.candidates.filter(candidate => candidate.planId === currentAsset.id);
        assert.equal(generated.length, 1, "SELECTED_ASSET_CANDIDATE_AMBIGUOUS");
        assert.equal(generated[0].assetId, receipt.assetId || `generated_${receipt.recordId}`, "SELECTED_GENERATED_ASSET_DRIFT");
        assert.equal(generated[0].historyRecordId, receipt.recordId, "SELECTED_ASSET_RECEIPT_DRIFT");
        assert.equal(generated[0].projectId, v["project-id"], "SELECTED_ASSET_PROJECT_DRIFT");
        assert.equal(generated[0].role, currentAsset.role, "SELECTED_ASSET_ROLE_DRIFT");
        await writeEvidence(path.join(phaseDir, "generated-candidate.json"), { planId: currentAsset.id,
          assetId: generated[0].assetId, historyRecordId: receipt.recordId });
        await slot.getByRole("button", { name: "保存到图库", exact: true }).click();
        project = await poll(readProject, item => item.document.visualAssetWorkspace?.candidates.some(c => c.planId === currentAsset.id && c.saved && c.storageKey && c.historyRecordId === receipt.recordId), "SELECTED_LIBRARY_NOT_SAVED");
        assetBinding = pinAssetCandidate(project.document, currentAsset, receipt, v["project-id"], generated[0].assetId);
        await writeEvidence(path.join(phaseDir, "asset-binding.json"), assetBinding);
      } else {
        const index = assertMediaPhase(phase, plan.segments.length) - 1;
        project = await poll(readProject, item => item.document.cards[index].imageStatus === "done" && item.document.cards[index].imageRecordId === receipt.recordId, "SELECTED_STORYBOARD_RECEIPT_NOT_SAVED");
      }
      // Download through the authenticated owned-media endpoint, never a supplied arbitrary URL.
      const media = await context.request.get(`${origin}/api/media-history/content?recordId=${receipt.recordId}`, {
        headers: { Authorization: `Bearer ${token}` }, timeout: 60000, maxRedirects: 0,
      });
      assert.equal(media.status(), 200, "SELECTED_ORIGINAL_MEDIA_UNAVAILABLE");
      const bytes = await media.body();
      assert.ok(bytes.length > 0 && bytes.length <= 30 * 1024 * 1024, "SELECTED_MEDIA_SIZE");
      const metadata = await sharp(bytes).metadata();
      assert.ok(["png", "jpeg", "webp"].includes(metadata.format) && metadata.width > 0 && metadata.height > 0, "SELECTED_MEDIA_INVALID");
      await fs.writeFile(path.join(phaseDir, `original.${metadata.format === "jpeg" ? "jpg" : metadata.format}`), bytes, { flag: "wx" });
      await writeEvidence(path.join(phaseDir, "media.json"), { sha256: hash(bytes), bytes: bytes.length, format: metadata.format,
        width: metadata.width, height: metadata.height, recordId: receipt.recordId, visualQualityVerified: false });
    }
    stage = "final-readback";
    project = await readProject();
    assertDocumentInputs(project.document, plan, v);
    const after = await billing(), runtimeAfter = await runtimeIdentity(pins);
    assert.deepEqual(runtimeAfter, runtimeBefore, "SELECTED_RUNTIME_CHANGED");
    assert.equal(after.credits, before.credits, "SELECTED_FINAL_CREDITS_DRIFT");
    assert.equal(after.reservedCredits, before.reservedCredits, "SELECTED_FINAL_RESERVATION_DRIFT");
    assert.equal(money(before.balance - after.balance), isBind ? 0 : quote, "SELECTED_FINAL_BALANCE_DRIFT");
    const newRows = after.rows.filter(row => !before.rows.some(old => old.id === row.id));
    assert.equal(newRows.length, isBind ? 0 : 1, "SELECTED_FINAL_LEDGER_COUNT");
    if (isBind) {
      assert.equal(generationPosts, 0, "SELECTED_BIND_GENERATION_FORBIDDEN");
      assert.deepEqual(admission, { generationPostAttempts: 0, generationPostsContinued: 0, duplicateGenerationPostsBlocked: 0 }, "SELECTED_BIND_ADMISSION_DRIFT");
      assertAssetCandidatePins(project.document, plan, v, prior, true);
      await writePaidTerminalReadback(phaseDir, { phase, runId: v["run-id"], projectId: v["project-id"], actor,
        runtimeBefore, packageSha256: v["package-sha256"], provenance, planning, generationContract: null, cardOrderMap, quote: 0, allocatedBudget: 0,
        terminalStatus: "no-generation", deliveryReceipt: null, generationPosts: 0, admission,
        billing: { balanceDelta: 0, newTransactionCount: 0 } });
    }
    await page.screenshot({ path: path.join(phaseDir, "desktop.png"), fullPage: true });
    await context.close();
    assert.equal(generationPosts, isBind ? 0 : 1, "SELECTED_FINAL_GENERATION_COUNT");
    assert.equal(admission.generationPostAttempts, isBind ? 0 : 1, "SELECTED_FINAL_ATTEMPT_COUNT");
    assert.equal(admission.generationPostsContinued, isBind ? 0 : 1, "SELECTED_FINAL_FORWARD_COUNT");
    assert.equal(blockedWrites.length, 0, "SELECTED_UNEXPECTED_WRITE_ATTEMPT");
    const report = { success: true, phase, runId: v["run-id"], projectId: v["project-id"], packageSha256: v["package-sha256"],
      actor, generationContract, cardOrderMap, modelId: generationContract?.modelId ?? null, resolution: generationContract?.resolution ?? null,
      aspectRatio: generationContract?.aspectRatio ?? null, quote, allocatedBudget: isBind ? 0 : paid.maxCharge, runtimeBefore, runtimeAfter, readiness, provenance, planning, assetBinding,
      projectLoadMode: official ? "existing-official-ui-project" : "stable-v1-bridge-to-real-project-api", officialAgentHandoffVerified: officialHandoffVerified,
      stagedEmptyReferences: false, plannedSourcesPending: isAsset,
      sourceBindingPath: "incremental-planned-source-preparation",
      selectedBindingsVerified: !isAsset, visualQualityVerified: false, fullAcceptancePassed: false,
      deliveryReceipt: receipt || null, request: routeEvidence.request, admission, generationPosts, writes,
      providerDispatchCount: "unknown", automaticRetries: 0,
      billing: { balanceBefore: before.balance, balanceAfter: after.balance, balanceDelta: money(before.balance - after.balance), newTransactionCount: newRows.length },
      savedAssets: (project.document.visualAssetWorkspace?.candidates || []).map(c => ({ planId: c.planId, assetId: c.assetId, historyRecordId: c.historyRecordId, saved: c.saved })),
      cards: project.document.cards.map(c => ({ id: c.id, order: c.order, imageStatus: c.imageStatus, imageRecordId: c.imageRecordId,
        requestedAssetIds: (c.visualAssetRefs || []).map(ref => ref.assetId), actualReferenceCount: c.referenceImageUrls.length })),
    };
    await writeEvidence(path.join(phaseDir, "report.json"), report);
    console.log(JSON.stringify({ success: true, phase, generationPosts, cashCharged: report.billing.balanceDelta,
      visualQualityVerified: false, report: path.join(phaseDir, "report.json") }));
  } catch {
    armed = false;
    await writeEvidence(path.join(phaseDir, "failure.json"), { success: false, phase, stage, runId: v["run-id"],
      projectId: v["project-id"], packageSha256: v["package-sha256"], provenance, planning, runtimeBefore, actor, admission, generationPosts,
      deliveryReceipt: receipt || null, generationContract, assetBinding, ...routeEvidence, blockedWrites, writes, automaticRetries: 0,
      budgetDisposition: isBind ? "no paid generation authorized" : "allocation occupied until original request reconciled" }).catch(() => undefined);
    if (page) await page.screenshot({ path: path.join(phaseDir, "failure.png"), fullPage: true }).catch(() => undefined);
    throw new Error("SELECTED_PHASE_STOPPED_READ_FAILURE_EVIDENCE");
  } finally { await browser?.close().catch(() => undefined); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error(JSON.stringify({ success: false, errorCode: "SELECTED_MEDIA_STOPPED", automaticRetries: 0 })); process.exitCode = 1; });
}
