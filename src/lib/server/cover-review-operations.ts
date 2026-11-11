import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET as readLegacyPreparation } from "@/app/api/cover/prepare/route";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { parseCoverPrepareInput, type CoverContentAnalysis, type CoverVisualObservation } from "@/lib/cover-workbench-contract";
import { resolveCoverMaterialBindings } from "@/lib/cover-material-composition";
import { CoverConfirmationRequestSchema, applyCoverReviewEdits, coverReviewPlanFromAnalysis,
  type CoverConfirmationRequest, type CoverReviewPlan, type CoverReviewFieldOrigins } from "@/lib/cover-review-contract";
import { buildCoverPreparation, compileCoverPlanFromAnalysis, coverGenerationSpecForTextMode, coverImageSelection, coverOwnedAssets, readCoverOriginalSourceDimensions, object } from "./cover-prepare-service";
import { COVER_ORIGINAL_LAYOUT_VERSION } from "@/lib/cover-composition";
import { CoverPrepareError, CoverConfirmationQueryOriginalError, coverConfirmationPlanId, coverMaterialFingerprint, insertCoverConfirmation, loadCoverConfirmationsForAnalysis, loadCoverPreparation, loadCoverPreparationByKey, prepareCoverOperation, type CoverPrepareRow } from "./cover-prepare-repository";
import { coverReviewAnalysisHash, coverReviewImageQuoteHash, projectCoverReviewOperation } from "./cover-review-projection";
import { assertNoUncertainCoverReviewSibling } from "./cover-review-generation-fence";

export class CoverReviewError extends CoverPrepareError {
  constructor(code: string, message: string, status = 409, readonly publicData: Record<string, unknown> = {}) { super(code, message, status); }
}

export function rethrowCoverReviewConfirmationError(error: unknown): never {
  if (error instanceof CoverConfirmationQueryOriginalError) {
    throw new CoverReviewError(error.code, error.message, error.status,
      { action: "query_original", originalConfirmationId: error.originalConfirmationId });
  }
  throw error;
}

/** Match JSONB's extra separator whitespace, with margin for numeric spelling. */
export function assertCoverSnapshotBudget(value: unknown, maximum: number, field: string) {
  const json = JSON.stringify(value); let inside = false, escaped = false, separators = 0;
  for (const char of json) {
    if (inside) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inside = false; }
    else if (char === '"') inside = true; else if (char === "," || char === ":") separators++;
  }
  if (Buffer.byteLength(json, "utf8") + separators + 512 > maximum) {
    throw new CoverReviewError("COVER_SNAPSHOT_TOO_LARGE", `当前${field}超过安全保存上限，请缩短内容后再确认；本次未调用模型`, 422);
  }
}

export function reviewInternalRequest(request: NextRequest, pathname: string, method: "GET" | "POST", body?: unknown) {
  const headers = new Headers();
  for (const key of ["authorization", "cookie"]) { const value = request.headers.get(key); if (value) headers.set(key, value); }
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded !== undefined) { headers.set("Content-Type", "application/json"); headers.set("Content-Length", String(Buffer.byteLength(encoded))); }
  return new NextRequest(new URL(pathname, request.url), { method, headers, ...(encoded !== undefined ? { body: encoded } : {}) });
}

export async function loadOwnedReviewOperation(userId: string, operationId?: string, clientRequestId?: string) {
  const row = clientRequestId ? await loadCoverPreparationByKey(userId, clientRequestId) : await loadCoverPreparation(userId, operationId);
  if (!row || row.user_id !== userId) throw new CoverReviewError("COVER_OPERATION_NOT_FOUND", "封面任务不存在或不属于当前账号", 404);
  return row;
}

export async function readCoverReviewImageQuote(row: CoverPrepareRow, requestUrl: string) {
  const previous = object(object(row.preparation.quote).image);
  if (row.preparation.route === "original_layout") return { imageQuote: { ...previous, amount: 0, unit: "yuan", ready: true }, generationSpec: undefined };
  const selected = await coverImageSelection(requestUrl, row.materials);
  const generationSpec = coverGenerationSpecForTextMode(selected.generation.generationSpec, object(row.preparation.textRendering).mode === "native");
  return { imageQuote: { modelId: row.materials.modelId || "", modelName: String(object(selected.model).displayName || ""),
    amount: selected.amount, unit: "yuan", resolution: selected.resolution, ready: true }, generationSpec };
}

async function hasOriginalImageAttempt(row: CoverPrepareRow) {
  const result = await getSupabaseClient().from("cover_generation_attempts").select("id,state")
    .eq("user_id", row.user_id).eq("surface", "cover-studio").eq("client_idempotency_key", `coverwb_${row.id}`).limit(1).maybeSingle();
  if (result.error) throw new CoverReviewError("COVER_ORIGINAL_ATTEMPT_UNAVAILABLE", "原图片任务状态尚未确认，请查询原单", 503);
  return Boolean(result.data);
}

export async function prepareCoverReviewOperation(request: NextRequest, userId: string, rawMaterials: unknown) {
  const materials = parseCoverPrepareInput(rawMaterials);
  const previous = await loadCoverPreparationByKey(userId, materials.clientRequestId);
  if (previous) {
    if (previous.preparation.recordKind === "confirmation" || previous.material_fingerprint !== coverMaterialFingerprint(materials)) {
      throw new CoverReviewError("COVER_MATERIAL_CONFLICT", "这份材料已更改，请使用新的准备标识");
    }
    return projectCoverReviewOperation(previous);
  }
  const preparation = await buildCoverPreparation(request.url, userId, materials, { workflowVersion: 3 });
  assertCoverSnapshotBudget(materials, 98_304, "材料");
  assertCoverSnapshotBudget(preparation, 131_072, "风格与分析快照");
  return projectCoverReviewOperation(await prepareCoverOperation(userId, materials, preparation));
}

/** Reconcile only the original billed response. Reading never dispatches an image. */
export async function getCoverReviewOperation(request: NextRequest, userId: string, operationId?: string, clientRequestId?: string) {
  let row = await loadOwnedReviewOperation(userId, operationId, clientRequestId);
  if (row.preparation.recordKind !== "confirmation" && ["analyzing", "unknown", "failed"].includes(row.state)) {
    const response = await readLegacyPreparation(reviewInternalRequest(request, `/api/cover/prepare?operationId=${encodeURIComponent(row.id)}`, "GET"));
    if (!response.ok) throw new CoverReviewError("COVER_ORIGINAL_ANALYSIS_UNAVAILABLE", "原分析回执暂时无法读取，请查询原任务", response.status);
    row = await loadOwnedReviewOperation(userId, row.id);
  }
  if (row.preparation.recordKind === "confirmation") return projectCoverReviewOperation(row);
  const generationStarted = row.preparation.workflowVersion !== 3 ? await hasOriginalImageAttempt(row) : false;
  if (generationStarted) return { ...projectCoverReviewOperation(row, { generationStarted: true }), generationStarted: true };
  try {
    const quote = await readCoverReviewImageQuote(row, request.url);
    return projectCoverReviewOperation(row, { ...quote, generationStarted: false });
  } catch (error) {
    // Paid analysis remains editable when the current image catalog is down.
    const issue = error instanceof CoverPrepareError ? { code: error.code, message: error.message } : { code: "COVER_IMAGE_QUOTE_UNAVAILABLE", message: "图片报价暂时无法读取，请稍后查询" };
    return { ...projectCoverReviewOperation(row, { generationStarted: false }), imageQuoteIssue: issue };
  }
}

function fieldOrigins(original: CoverReviewPlan, plan: CoverReviewPlan, analysis: CoverContentAnalysis): CoverReviewFieldOrigins {
  const result: CoverReviewFieldOrigins = {};
  const put = (path: string, before: unknown, after: unknown, refs: string[] = []) => {
    const changed = coverMaterialFingerprint(before ?? null) !== coverMaterialFingerprint(after ?? null);
    result[path] = changed ? { source: "user_override" } : { source: "analysis", ...(refs.length ? { evidenceRefs: refs } : {}) };
  };
  for (const key of ["topic", "primaryTitle", "secondaryTitle"] as const) put(key, original[key], plan[key], analysis.evidence.filter(item => item.fields.includes(key)).map(item => item.id));
  for (const key of ["subject", "action", "scene", "emotion"] as const) put(`visualBrief.${key}`, original.visualBrief[key], plan.visualBrief[key], analysis.evidence.filter(item => item.fields.includes(`visualBrief.${key}`)).map(item => item.id));
  for (const key of ["summary", "keyPoints", "logic", "coverFocus"] as const) put(`contentBreakdown.${key}`, original.contentBreakdown[key], plan.contentBreakdown[key]);
  for (const key of ["structure", "focus"] as const) put(`layoutIntent.${key}`, original.layoutIntent[key], plan.layoutIntent[key], analysis.layoutIntent?.evidenceRefs);
  if (plan.materialUsage) for (const usage of plan.materialUsage) put(`materialUsage.${usage.assetId}`, original.materialUsage?.find(item => item.assetId === usage.assetId), usage);
  return result;
}

function validateReviewAssets(parent: CoverPrepareRow, plan: CoverReviewPlan) {
  if (!plan.materialUsage) return parent.materials;
  const bindings = resolveCoverMaterialBindings(parent.materials).images;
  if (plan.materialUsage.length !== bindings.length || new Set(plan.materialUsage.map(item => item.assetId)).size !== bindings.length
    || plan.materialUsage.some(item => !bindings.some(binding => binding.assetId === item.assetId && binding.imageNumber === item.imageNumber))) {
    throw new CoverReviewError("COVER_CONFIRMATION_ASSET_BINDING_INVALID", "审核后的图片用途必须完整对应原素材编号，不能新增、交换或重复图片", 422);
  }
  const assets = parent.materials.assets.map(asset => ({ ...asset, role: plan.materialUsage!.find(item => item.assetId === asset.assetId)!.role }));
  if (parent.materials.imageMode !== "compose") {
    const nonReferences = assets.filter(asset => asset.role !== "style_reference");
    const original = parent.preparation.route === "original_layout";
    if (original ? nonReferences.length !== 1 || nonReferences[0]?.assetId !== parent.preparation.sourceAssetId : nonReferences.length !== 0) {
      throw new CoverReviewError("COVER_CONFIRMATION_MODE_CHANGE_REQUIRED", "当前模式不能把参考图改为合成主体。请保留分析和审核内容，明确切换合成模式重新准备", 422);
    }
  }
  if (parent.preparation.route === "original_layout" && !assets.some(asset => asset.assetId === parent.preparation.sourceAssetId && asset.role !== "style_reference")) {
    throw new CoverReviewError("COVER_CONFIRMATION_SOURCE_REQUIRED", "保留原图模式须保留原背景图用途，请明确后继续", 422);
  }
  return { ...parent.materials, assets };
}

function reviewedAnalysis(original: CoverContentAnalysis, plan: CoverReviewPlan, origins: CoverReviewFieldOrigins): CoverContentAnalysis {
  const conclusion = (path: string, value: string, old?: { evidenceRefs: string[] }) => ({ text: value, evidenceRefs: origins[path]?.source === "analysis" ? old?.evidenceRefs || [] : [] });
  return { ...original, topic: plan.topic, primaryTitle: plan.primaryTitle, secondaryTitle: plan.secondaryTitle,
    visualBrief: plan.visualBrief, materialUsage: undefined,
    contentBreakdown: { summary: conclusion("contentBreakdown.summary", plan.contentBreakdown.summary, original.contentBreakdown?.summary),
      keyPoints: plan.contentBreakdown.keyPoints.map((value, index) => conclusion("contentBreakdown.keyPoints", value, original.contentBreakdown?.keyPoints[index])),
      logic: conclusion("contentBreakdown.logic", plan.contentBreakdown.logic, original.contentBreakdown?.logic),
      coverFocus: conclusion("contentBreakdown.coverFocus", plan.contentBreakdown.coverFocus, original.contentBreakdown?.coverFocus) },
    layoutIntent: { ...plan.layoutIntent, evidenceRefs: origins["layoutIntent.structure"]?.source === "analysis" && origins["layoutIntent.focus"]?.source === "analysis" ? original.layoutIntent?.evidenceRefs || [] : [] },
    // These remain the original source records. The distinct confirmedReview
    // compiler uses fieldOrigins, never these old field links, for user edits.
    evidence: original.evidence,
  };
}

export async function confirmCoverReviewOperation(request: NextRequest, userId: string, rawRequest: unknown) {
  const input: CoverConfirmationRequest = CoverConfirmationRequestSchema.parse(rawRequest);
  const requestHash = coverMaterialFingerprint(input);
  const previous = await loadCoverPreparationByKey(userId, input.clientRequestId);
  if (previous) {
    if (previous.user_id !== userId || previous.preparation.recordKind !== "confirmation"
      || previous.preparation.originalAnalysisOperationId !== input.operationId || previous.preparation.confirmationRequestHash !== requestHash) {
      throw new CoverReviewError("COVER_CONFIRMATION_KEY_CONFLICT", "该确认标识已用于其他方案，请查询原确认记录");
    }
    return projectCoverReviewOperation(previous);
  }
  const parent = await loadOwnedReviewOperation(userId, input.operationId);
  if (parent.preparation.recordKind === "confirmation" || parent.state !== "plan_ready" || object(parent.result?.analysis).status !== "ready" || parent.consent?.analysis !== true) {
    throw new CoverReviewError("COVER_ANALYSIS_REVIEW_REQUIRED", "请先完成原内容分析，再审核确认方案");
  }
  if (await hasOriginalImageAttempt(parent)) throw new CoverReviewError("COVER_ORIGINAL_GENERATION_EXISTS", "原图片任务已经开始，请查询原单；不会用新确认重复生图");
  const analysisHash = coverReviewAnalysisHash(parent);
  if (analysisHash !== input.expectedAnalysisHash) throw new CoverReviewError("COVER_ANALYSIS_REVIEW_STALE", "原分析版本已变化，请重新读取审核方案");
  const analysis = parent.result!.analysis as CoverContentAnalysis;
  const original = coverReviewPlanFromAnalysis(analysis);
  const plan = applyCoverReviewEdits(original, input.edits);
  const materials = validateReviewAssets(parent, plan);
  const owned = await coverOwnedAssets(userId, materials);
  const fresh = await readCoverReviewImageQuote(parent, request.url);
  const quoteHash = coverReviewImageQuoteHash(fresh.imageQuote, fresh.generationSpec, parent.preparation.outputSpec);
  if (quoteHash !== input.expectedImageQuoteHash) {
    throw new CoverReviewError("COVER_IMAGE_QUOTE_CHANGED", "图片报价已变化，已保留原分析和审核内容，请确认当前费用", 409,
      { quote: projectCoverReviewOperation(parent, { ...fresh, generationStarted: false }).quote });
  }
  const origins = fieldOrigins(original, plan, analysis);
  const confirmedPlanHash = coverMaterialFingerprint({ schema: "cover-confirmed-plan/1", originalAnalysisOperationId: parent.id, originalAnalysisHash: analysisHash, plan, fieldOrigins: origins, imageQuoteHash: quoteHash,
    ...(parent.preparation.generatedOverlayLayout ? { generatedOverlayLayout: parent.preparation.generatedOverlayLayout } : {}) });
  const paid = parent.preparation.route !== "original_layout";
  if (paid) {
    try {
      const samePlan = (await loadCoverConfirmationsForAnalysis(userId, parent.id))
        .find(child => child.preparation.confirmedPlanHash === confirmedPlanHash);
      if (samePlan) {
        if (samePlan.client_request_id === input.clientRequestId && samePlan.preparation.confirmationRequestHash === requestHash) return projectCoverReviewOperation(samePlan);
        throw new CoverConfirmationQueryOriginalError(samePlan.id);
      }
      await assertNoUncertainCoverReviewSibling(request, userId, parent.id);
    } catch (error) { rethrowCoverReviewConfirmationError(error); }
  }
  const now = new Date().toISOString(); const id = paid ? coverConfirmationPlanId(userId, parent.id, confirmedPlanHash) : randomUUID();
  // A new confirmation of a legacy paid analysis also gets the safe policy;
  // never mutate its parent, existing confirmations, or saved historical plan.
  const originalLayout = parent.preparation.route === "original_layout" ? {
    version: COVER_ORIGINAL_LAYOUT_VERSION,
    ...(parent.preparation.originalLayout ? {
      sourceWidth: object(parent.preparation.originalLayout).sourceWidth,
      sourceHeight: object(parent.preparation.originalLayout).sourceHeight,
    } : await readCoverOriginalSourceDimensions(userId, materials, String(parent.preparation.sourceAssetId), owned)),
    ...plan.layoutIntent,
  } : undefined;
  const preparation: Record<string, unknown> = { recordKind: "confirmation", workflowVersion: 3,
    originalAnalysisOperationId: parent.id, originalAnalysisHash: analysisHash, confirmationRequestHash: requestHash,
    ...(paid ? { confirmationIdentityVersion: "plan-identity/v1" } : {}),
    confirmedPlan: plan, confirmedPlanHash, fieldOrigins: origins,
    originalAnalysisBilling: { operationId: parent.id, ...(typeof parent.billing.credits_charged === "number" ? { creditsCharged: parent.billing.credits_charged } : {}),
      ...(parent.billing.operation_id ? { billingOperationId: String(parent.billing.operation_id) } : {}), chargedAgain: false },
    ...Object.fromEntries(["route", "style", "frozenStyleRuntime", "frozenWorkflowRuntime", "analysisModelSnapshot", "outputSpec", "textRendering", "sourceAssetId", "promptDependencies", "generatedOverlayLayout"].filter(key => parent.preparation[key] !== undefined).map(key => [key, parent.preparation[key]])),
    ...(originalLayout ? { originalLayout, outputSpec: { ...object(parent.preparation.outputSpec), fit: "contain" } } : {}),
    ...(fresh.generationSpec ? { generationSpec: fresh.generationSpec } : {}),
    quote: { analysis: { amount: 0, unit: "credits", policy: "original_analysis" }, image: fresh.imageQuote, imageQuoteHash: quoteHash } };
  const child: CoverPrepareRow = { id, user_id: userId, client_request_id: input.clientRequestId, material_fingerprint: coverMaterialFingerprint(materials),
    revision: 1, state: "plan_ready", materials, preparation, result: null, analysis_request_id: `cover_confirmation_${id.replaceAll("-", "")}`,
    analysis_attempt_id: null, billing: { credits_charged: 0, reused_from_operation_id: parent.id }, consent: { image: true, at: now, imageQuoteHash: quoteHash },
    error_code: null, created_at: now, updated_at: now };
  const compiled: Record<string, unknown> = compileCoverPlanFromAnalysis(child, reviewedAnalysis(analysis, plan, origins), (parent.result!.visualObservations || []) as CoverVisualObservation[]);
  const task = object(compiled.task);
  child.result = Object.fromEntries(["renderPlan", "generationInput", "task", "generationPromptVersion", "generationIdentity"].filter(key => compiled[key] !== undefined).map(key => [key, compiled[key]]));
  if (preparation.route === "original_layout") child.result.task = { id: `cover-review-${id}`, prepareOperationId: id,
    ratio: materials.outputRatio, title: plan.primaryTitle, subtitle: plan.secondaryTitle || "", prompt: "", briefText: materials.text,
    source: "生成", createdAt: now, taskNo: 0, status: "running", renderPlan: compiled.renderPlan };
  else if (task.prepareOperationId !== id) throw new CoverReviewError("COVER_CONFIRMATION_COMPILATION_INVALID", "确认方案未能绑定原任务，本次未提交生成", 422);
  assertCoverSnapshotBudget(materials, 98_304, "材料"); assertCoverSnapshotBudget(preparation, 131_072, "确认快照"); assertCoverSnapshotBudget(child.result, 196_608, "生成计划");
  try { return projectCoverReviewOperation(await insertCoverConfirmation(child)); }
  catch (error) { rethrowCoverReviewConfirmationError(error); }
}
