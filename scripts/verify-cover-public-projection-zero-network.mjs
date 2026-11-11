#!/usr/bin/env node
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plain = value => JSON.parse(JSON.stringify(value));
const sources = new Map(), cache = new Map(), mocks = new Map();
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls += 1; throw new Error("External I/O is forbidden"); };
function load(relative) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = readFileSync(filename, "utf8"); sources.set(filename, source);
  const compiled = ts.transpileModule(source, { fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  const module = { exports: {} }; cache.set(filename, module);
  const require = specifier => {
    if (mocks.has(specifier)) return mocks.get(specifier);
    if (specifier === "server-only") return {};
    if (specifier === "zod") return { z };
    if (specifier === "node:crypto") return crypto;
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) return forbidden();
    const resolved = specifier.startsWith("@/") ? path.join(root, "src", specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
    assert.ok(resolved.startsWith(path.join(root, "src") + path.sep));
    return load(path.extname(resolved) ? resolved : `${resolved}.ts`);
  };
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, require, Error, Date, Buffer, URL, console, fetch: forbidden },
    { filename, timeout: 5_000 });
  return module.exports;
}
const projection = load("src/lib/server/cover-review-projection.ts");
const durable = load("src/lib/cover-durable-attempt.ts");
const contract = load("src/lib/cover-review-contract.ts");
const userId = "00000000-0000-4000-8000-000000000001", parentId = "00000000-0000-4000-8000-000000000002";
const childId = "00000000-0000-4000-8000-000000000003", assetId = "00000000-0000-4000-8000-000000000004";
const secret = "PRIVATE_PLATFORM_PROMPT_SENTINEL", userQuote = "用户自己的引文：好运降临。先做十分钟。";
const createdAt = "2026-11-06T00:00:00.000Z";
const plan = { planVersion: 2, title: "先做十分钟", subtitle: "", aspectRatio: "3:4", animationStyleId: "pixar-3d", layoutTemplateId: "gaoding-test",
  outputSpec: { aspectRatio: "3:4", width: 1080, height: 1440, format: "png", fit: "contain" },
  titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#FFFFFF", colorMode: "palette" },
  textRendering: { mode: "native", version: "cover-text-rendering/1" }, hiddenPrompt: secret };
const planWithPrivateExtras = { ...plan, outputSpec: { ...plan.outputSpec, hiddenPrompt: secret },
  titleStyle: { ...plan.titleStyle, hiddenPrompt: secret }, textRendering: { ...plan.textRendering, hiddenPrompt: secret } };
const analysis = { schemaVersion: "cover-content-analysis/1", status: "ready", topic: "先行动", primaryTitle: "先做十分钟", secondaryTitle: null,
  visualBrief: { subject: "一个人", action: "开始动手", scene: "桌前", emotion: "坚定" },
  titleCandidates: [{ id: "t1", text: "先做十分钟", evidenceRefs: ["e1"] }],
  evidence: [{ id: "e1", source: "text", quote: userQuote, fields: ["primaryTitle"] }], missingInformation: [] };
const generationInput = { prompt: secret, modelId: "pm_fixture", mode: "local", style: "cartoon", aspectRatio: "3:4", resolution: "2K",
  coverText: "", referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio" };
const task = { id: `cover-review-${childId}`, prepareOperationId: childId, title: plan.title, subtitle: "", ratio: "3:4", prompt: secret,
  briefText: userQuote, source: "生成", createdAt, taskNo: 1, status: "running", renderPlan: plan, hiddenPrompt: secret };
const parent = { id: parentId, user_id: userId, client_request_id: "fixture_parent_001", material_fingerprint: "a".repeat(64), revision: 1,
  state: "plan_ready", materials: { schemaVersion: "cover-prepare/1", clientRequestId: "fixture_parent_001", materialRevision: 1,
    text: userQuote, assets: [], styleKey: "cartoon", outputRatio: "3:4", modelId: "pm_fixture", resolution: "2K" },
  preparation: { workflowVersion: 3, recordKind: "analysis", route: "new_visual", sourcePrompt: secret,
    style: { key: "cartoon", version: "3.0.0", displayName: secret, researchSources: [{ creator: secret }] }, outputSpec: plan.outputSpec,
    promptDependencies: { promptPack: { systemPrompt: secret } }, promptDependenciesFingerprint: "b".repeat(64),
    generationSpec: { aspectRatio: "3:4", resolution: "2K", crop: { policyId: "fixture-policy" } },
    quote: { analysis: { amount: null, unit: "credits", policy: "actual_usage", internalPrompt: secret },
      image: { modelId: "pm_fixture", modelName: "图片模型", amount: .2, unit: "yuan", resolution: "2K", ready: true, internalPrompt: secret } } },
  result: { analysis, renderPlan: plan, task, generationInput, privateAudit: secret,
    generationIdentity: { clientIdempotencyKey: `coverwb_${parentId}`, clientTraceId: `coverwb_${parentId}`, secret } },
  analysis_request_id: "fixture_analysis_001", analysis_attempt_id: "c".repeat(64), billing: { credits_charged: 1.5, operation_id: "fixture-bill", secret },
  consent: { analysis: true }, error_code: null, created_at: createdAt, updated_at: createdAt };
const child = { ...plain(parent), id: childId, client_request_id: "fixture_child_001",
  preparation: { ...plain(parent.preparation), recordKind: "confirmation", originalAnalysisOperationId: parentId,
    confirmedPlan: contract.coverReviewPlanFromAnalysis(analysis), confirmedPlanHash: "d".repeat(64),
    fieldOrigins: { primaryTitle: { source: "user_override", evidenceRefs: [secret], secret }, visualBrief: { source: "analysis", evidenceRefs: ["e1"] },
      [`materialUsage.${assetId}`]: { source: "user_override" }, secret: { source: "analysis", secret } },
    originalAnalysisBilling: { operationId: parentId, creditsCharged: 1.5, chargedAgain: false, billingOperationId: "fixture-bill", secret } },
  result: { renderPlan: plan, task, generationInput, secret }, billing: { credits_charged: 0, reused_from_operation_id: parentId, secret } };
const checks = [];
function noPrivate(value) {
  assert.equal(JSON.stringify(value).includes(secret), false, "Internal prompt/source sentinel must not cross the public boundary");
  const walk = entry => {
    if (Array.isArray(entry)) return entry.forEach(walk);
    if (!entry || typeof entry !== "object") return;
    for (const [key, nested] of Object.entries(entry)) {
      assert.ok(!["generationInput", "dispatchInput", "preparation", "promptDependencies", "researchSources", "systemPrompt", "effectivePrompt", "providerProtocol"].includes(key), `Private key ${key}`);
      walk(nested);
    }
  };
  walk(plain(value));
}
{
  const dto = projection.projectCoverReviewOperation(parent);
  noPrivate(dto); assert.equal(dto.status, "review_ready"); assert.equal(dto.workflowVersion, 3);
  assert.equal(dto.materials.text, userQuote); assert.equal(dto.analysis.evidence[0].quote, userQuote);
  assert.equal(dto.style.displayName, "暖光叙事"); assert.equal(dto.task, undefined); assert.equal(dto.generationIdentity, undefined);
  assert.equal(dto.billing.credits_charged, 1.5); assert.equal(dto.analysisHash, projection.coverReviewAnalysisHash(parent));
  assert.deepEqual(plain(dto.analysisBilling), { creditsCharged: 1.5, operationId: "fixture-bill" });
  checks.push("new analysis projection hides prompt/research snapshots and keeps the user's exact text/evidence and original bill");
}
{
  const dto = projection.projectCoverReviewOperation(child);
  noPrivate(dto); assert.equal(dto.status, "confirmed"); assert.equal(dto.confirmationId, childId);
  assert.equal(dto.task.prompt, ""); assert.equal(dto.task.imageOrigin, "generated");
  assert.equal(dto.confirmedPlanHash, child.preparation.confirmedPlanHash); assert.equal(dto.billing.credits_charged, 0);
  assert.equal(dto.originalAnalysisBilling.creditsCharged, 1.5); assert.equal(dto.originalAnalysisBilling.chargedAgain, false);
  assert.deepEqual(plain(dto.fieldOrigins.primaryTitle), { source: "user_override" });
  assert.deepEqual(plain(dto.fieldOrigins[`materialUsage.${assetId}`]), { source: "user_override" });
  checks.push("confirmation projection keeps its reviewed plan and separate billing reference without private compiler input");
}
{
  const legacy = plain(parent); delete legacy.preparation.workflowVersion; delete legacy.preparation.recordKind;
  const dto = projection.projectCoverReviewOperation(legacy);
  noPrivate(dto); assert.equal(dto.status, "plan_ready"); assert.equal(dto.generationIdentity.clientIdempotencyKey, `coverwb_${parentId}`);
  assert.equal(dto.task.prompt, ""); assert.equal(dto.task.briefText, userQuote); assert.equal(legacy.result.task.prompt, secret);
  const review = projection.projectCoverReviewOperation(legacy, { generationStarted: false });
  assert.equal(review.status, "review_ready"); assert.equal(review.analysisHash, projection.coverReviewAnalysisHash(legacy));
  const paid = projection.projectCoverReviewOperation(legacy, { generationStarted: true });
  assert.equal(paid.status, "plan_ready"); assert.equal(paid.analysisHash, undefined); assert.equal(paid.editablePlan, undefined);
  assert.equal(paid.generationIdentity.clientIdempotencyKey, `coverwb_${parentId}`);
  checks.push("legacy paid operations retain exact query keys and private stored snapshots while public tasks contain no compiled prompt");
}
{
  const receipt = { persisted: true, cloudStored: true, assetId, historyRecordId: "fixture-history", key: "owned/final.png", url: "/api/owned-output",
    sourceAssetId: "fixture-background", width: 1080, height: 1440, sourceWidth: 2048, sourceHeight: 2732, taskNo: 7, createdAt, secret };
  const dto = projection.projectCoverReviewSafeTask(task, { receipt, prepareOperationId: childId, imageOrigin: "generated" });
  noPrivate(dto); assert.equal(dto.status, "done"); assert.equal(dto.assetId, assetId); assert.equal(dto.cloudStored, true);
  assert.equal(dto.historyRecordId, "fixture-history"); assert.equal(dto.outputWidth, 1080); assert.equal(dto.outputHeight, 1440);
  assert.equal(dto.sourceWidth, 2048); assert.equal(dto.sourceHeight, 2732); assert.equal(dto.textVerification, "unverified");
  assert.equal(dto.renderPlan.outputSpec.fit, "contain"); assert.equal(dto.renderPlan.titleStyle.colorMode, "palette");
  const unmeasured = projection.projectCoverReviewSafeTask(task);
  assert.equal(unmeasured.outputWidth, undefined); assert.equal(unmeasured.cloudStored, undefined);
  assert.equal(unmeasured.renderPlan.outputSpec.width, 1080, "Requested dimensions are distinct from actual measured delivery");
  assert.throws(() => projection.projectCoverReviewSafeTask({ ...task, renderPlan: planWithPrivateExtras }), /COVER_PUBLIC_TASK_PLAN_INVALID/u);
  noPrivate(durable.projectCoverCompositionPlan(planWithPrivateExtras));
  checks.push("safe completed task preserves actual persistence/history/dimensions/native metadata without inventing measured delivery facts");
}
{
  const input = parent.preparation.quote.image, generation = parent.preparation.generationSpec, output = parent.preparation.outputSpec;
  const first = projection.coverReviewImageQuoteHash(input, generation, output);
  assert.equal(first, projection.coverReviewImageQuoteHash(Object.fromEntries(Object.entries(input).reverse()), generation, output));
  for (const [quote, spec, pixels] of [[{ ...input, amount: .3 }, generation, output], [input, { ...generation, resolution: "4K" }, output], [input, generation, { ...output, fit: "cover" }]]) {
    assert.notEqual(first, projection.coverReviewImageQuoteHash(quote, spec, pixels));
  }
  const projected = projection.projectCoverReviewOperation(parent, { imageQuote: { ...input, amount: .3 }, generationSpec: { ...generation, resolution: "4K" } });
  assert.equal(projected.quote.imageQuoteHash, projection.coverReviewImageQuoteHash({ ...input, amount: .3 }, { ...generation, resolution: "4K" }, output));
  assert.notEqual(projection.coverReviewAnalysisHash(parent), projection.coverReviewAnalysisHash({ ...parent, result: { ...parent.result, analysis: { ...analysis, primaryTitle: "另一标题" } } }));
  checks.push("analysis/quote hashes bind original content, live quote, generation specification and output fit with stable JSON key order");
}
const attempt = { id: "00000000-0000-4000-8000-000000000005", user_id: userId, surface: "cover-studio",
  client_idempotency_key: `coverwb_${childId}`, client_trace_id: `coverwb_${childId}`, state: "claimed", task, generation_input: generationInput,
  requires_reference_reupload: false, created_at: createdAt, updated_at: createdAt };
{
  for (const state of ["claimed", "dispatched", "delivery_pending", "completed", "failed", "cancelled"]) {
    const dto = durable.coverAttemptProjection({ ...attempt, state, result_asset_id: state === "completed" ? assetId : null,
      history_record_id: state === "completed" ? "fixture-history" : null });
    noPrivate(dto); assert.equal(dto.task.prompt, ""); assert.equal(dto.task.briefText, userQuote);
    assert.equal(dto.clientTraceId, attempt.client_trace_id); assert.equal(dto.task.imageOrigin, "generated");
    if (state === "completed") { assert.equal(dto.task.cloudStored, true); assert.equal(dto.task.assetId, assetId); }
  }
  assert.ok(durable.parseCoverAttemptClaim({ task, payload: generationInput, referenceCount: 0 }));
  assert.equal(durable.parseCoverAttemptClaim({ task: { ...task, prompt: "" }, payload: { ...generationInput, prompt: "" } }), null);
  checks.push("all durable public states strip compiled prompt/dispatch input while private first-dispatch parsing remains strict");
}

// Exercise the real old history GET. Only authentication, database result sets,
// storage signing and the external temporary receipt service are fixture ports.
const fingerprint = "e".repeat(64), failureKey = "cover_fixture_failure_001", temporaryKey = "cover_fixture_temporary_001";
const failureSnapshot = { schema: "image_generation_request_snapshot.v2", surface: "cover-studio", prompt: secret,
  publicModelId: "pm_fixture", modelName: "图片模型", mode: "text-to-image", aspectRatio: "3:4", resolution: "2K", referenceAssetRefs: [],
  quotedPriceYuan: .2, billingExempt: false, style: secret, effectivePrompt: secret, providerProtocol: "images_generations",
  outputPixelSize: "1080x1440", imageCount: 1, referenceUsage: "general", payloadFingerprint: fingerprint };
const tables = {
  cover_generation_attempts: [attempt,
    { ...attempt, id: "fixture-failed", state: "failed", client_trace_id: failureKey, client_idempotency_key: failureKey },
    { ...attempt, id: "fixture-temporary", state: "failed", client_trace_id: temporaryKey, client_idempotency_key: temporaryKey, error_code: "COVER_DURABLE_DELIVERY_NOT_APPLICABLE" }],
  cover_generation_history: [{ asset_id: assetId, background_asset_id: "fixture-background", history_record_id: "fixture-history", plan: planWithPrivateExtras,
    authoring_context: { prompt: secret, briefText: userQuote }, output_width: 1080, output_height: 1440, source_width: 2048, source_height: 2732, task_no: 1, created_at: createdAt }],
  user_files: [{ id: assetId, storage_key: "owned/final.png", storage_provider: "tencent_cos" }],
  image_generation_requests: [{ record_id: "f".repeat(64), client_trace_id: failureKey, client_idempotency_key: failureKey,
    request_snapshot: failureSnapshot, payload_fingerprint: fingerprint, created_at: createdAt,
    response: { schema: "image_request_rejection.v1", source: "input", code: "IMAGE_REFERENCE_READ_FAILED", payloadFingerprint: fingerprint } }],
  wallet_operations: [],
};
const queries = [];
const db = { rpc: async name => { assert.equal(name, "reconcile_stale_cover_generation_attempts"); return { data: [], error: null }; },
  from: table => {
    assert.ok(table in tables); queries.push(table);
    const result = { data: tables[table], error: null };
    const chain = new Proxy({}, { get: (_, key) => key === "then" ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : () => chain });
    return chain;
  } };
mocks.set("next/server", { NextResponse: { json: (body, init) => Response.json(body, init) } });
mocks.set("@/lib/current-api-user", { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId } }) });
mocks.set("@/storage/database/supabase-client", { getSupabaseClient: () => db });
mocks.set("@/storage/object", { storageManager: { getSignedUrl: async () => "/api/fixture-owned-final" } });
mocks.set("@/lib/image-exactly-once", { DatabaseImageExactlyOnceStore: class { async get(binding) { assert.equal(binding.userId, userId); return { fixture: true }; } } });
mocks.set("@/lib/cover-generated-delivery", { COVER_TEMPORARY_DELIVERY_CODE: "COVER_DURABLE_DELIVERY_NOT_APPLICABLE",
  COVER_TEMPORARY_COMPOSITION_ERROR: "COVER_TEMPORARY_COMPOSITION_FAILED", coverGeneratedReceipt: () => ({ recordId: "fixture-temporary-receipt", cashCharged: .2,
    generationCompleted: true, deliveryMode: "inline_ephemeral", retention: "current_page_only", mediaAvailable: false, canRecover: false, canResubmit: false }) });
const history = load("src/app/api/cover/history/route.ts");
const response = await history.GET({ nextUrl: new URL("http://fixture.invalid/api/cover/history") });
assert.equal(response.status, 200);
const historyDto = await response.json(); noPrivate(historyDto);
assert.ok(historyDto.activeAttempt); assert.equal(historyDto.activeAttempt.task.prompt, "");
const completedHistory = historyDto.records.find(item => item.assetId === assetId);
assert.equal(completedHistory.cloudStored, true); assert.equal(completedHistory.historyRecordId, "fixture-history");
assert.equal(completedHistory.outputWidth, 1080); assert.equal(completedHistory.outputHeight, 1440);
assert.equal(completedHistory.briefText, userQuote); assert.equal(completedHistory.imageOrigin, "generated");
assert.equal(completedHistory.renderPlan.outputSpec.fit, "contain");
const failedHistory = historyDto.records.find(item => item.failureRecordId);
assert.ok(failedHistory); assert.equal(failedHistory.prompt, ""); assert.equal(failedHistory.requestIntegrity.payloadFingerprint, fingerprint);
assert.equal(failedHistory.requestIntegrity.effectivePrompt, undefined); assert.equal(failedHistory.requestIntegrity.providerProtocol, undefined);
const temporaryHistory = historyDto.records.find(item => item.imageDeliveryReceipt);
assert.ok(temporaryHistory); assert.equal(temporaryHistory.cloudStored, false); assert.equal(temporaryHistory.billing.chargedAmount, .2);
assert.ok(queries.includes("wallet_operations"));
checks.push("actual history GET covers completed, failure, active and temporary receipt branches without disclosing prompt or hidden plan fields");
assert.equal(forbiddenCalls, 0);
for (const [filename, source] of sources) assert.equal(readFileSync(filename, "utf8"), source, `Source changed during test: ${filename}`);
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: 0, providerCalls: 0, liveDatabaseCalls: 0,
  sources: [...sources].map(([filename, source]) => ({ path: path.relative(root, filename).replaceAll("\\", "/"), sha256: crypto.createHash("sha256").update(source).digest("hex") })),
  evidence: "Actual public projection, durable projection/parsers and old history GET. DB/auth/signing and temporary receipt dependency are fixture ports; no real provider, payment, database or browser acceptance.", cases: checks }, null, 2));
