import "server-only";
import { createHash } from "node:crypto";
import { CoverContentAnalysisSchema, CoverPrepareInputSchema } from "@/lib/cover-workbench-contract";
import { CoverReviewPlanSchema, coverReviewPlanFromAnalysis, type CoverReviewSafeTask } from "@/lib/cover-review-contract";
import { COVER_BUILTIN_STYLE_METADATA } from "@/lib/cover-style-catalog";
import { projectCoverCompositionPlan } from "@/lib/cover-durable-attempt";
import { coverCompositionValidationError, coverTextRendering, type CoverCompositionPlan } from "@/lib/cover-composition";
import { canRecoverPaidCoverAnalysis } from "./cover-analysis-recovery";
import type { CoverPrepareRow } from "./cover-prepare-repository";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const pick = (value: unknown, keys: readonly string[]): Obj => {
  const source = object(value);
  return Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]]]));
};
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Bind the original paid analysis, not its mutable public presentation. */
export function coverReviewAnalysisHash(row: CoverPrepareRow): string {
  return fingerprint({ schema: "cover-review-analysis/1", operationId: row.id, revision: row.revision,
    materialFingerprint: row.material_fingerprint, analysis: object(row.result).analysis ?? null,
    promptDependenciesFingerprint: row.preparation.promptDependenciesFingerprint ?? null });
}
export function coverReviewImageQuoteHash(imageQuote: unknown, generationSpec?: unknown, outputSpec?: unknown): string {
  return fingerprint({ schema: "cover-review-image-quote/1", imageQuote: imageQuote ?? null,
    generationSpec: generationSpec ?? null, outputSpec: outputSpec ?? null });
}

function publicBilling(value: unknown): Obj {
  const billing = object(value);
  return { ...(finite(billing.credits_charged) !== undefined ? { credits_charged: billing.credits_charged } : {}),
    ...(string(billing.operation_id) ? { operation_id: billing.operation_id } : {}),
    ...(string(billing.reused_from_operation_id) ? { reused_from_operation_id: billing.reused_from_operation_id } : {}) };
}
function publicImageQuote(value: unknown): Obj {
  const quote = object(value);
  return { modelId: string(quote.modelId) || "", modelName: string(quote.modelName) || "",
    amount: finite(quote.amount) ?? null, unit: quote.unit === "credits" ? "credits" : "yuan",
    ...(string(quote.resolution) ? { resolution: quote.resolution } : {}), ready: quote.ready === true };
}
function publicAnalysisQuote(value: unknown): Obj {
  const quote = object(value);
  return { modelId: string(quote.modelId) || "", modelName: string(quote.modelName) || "", amount: finite(quote.amount) ?? null,
    unit: "credits", policy: quote.policy === "reuse_completed_analysis" ? "reuse_completed_analysis" : "actual_usage" };
}
function publicStyle(preparation: Obj) {
  const style = object(preparation.style), runtime = object(preparation.frozenStyleRuntime), release = object(runtime.release);
  const styleKey = string(style.key) || "reference-adaptive";
  const builtin = COVER_BUILTIN_STYLE_METADATA.find(item => item.styleKey === styleKey);
  return { styleKey, version: string(release.version) || string(style.version) || "1.0.0",
    displayName: string(release.displayName) || builtin?.displayName || (styleKey === "custom-composition" ? "自定义画面" : "参考图片风格"),
    ...(string(release.releaseId) ? { releaseId: release.releaseId } : {}),
    ...(runtime.sceneBriefVersion === 1 ? { sceneBriefVersion: 1 } : {}) };
}
function publicOrigins(value: unknown): Obj {
  return Object.fromEntries(Object.entries(object(value)).flatMap(([key, raw]) => {
    const origin = object(raw);
    if (!/^(?:topic|primaryTitle|secondaryTitle|contentBreakdown|visualBrief|layoutIntent|materialUsage)(?:\.[A-Za-z0-9_-]+)*$/u.test(key)
      || !["analysis", "user_override"].includes(String(origin.source))) return [];
    return [[key, { source: origin.source,
      ...(origin.source === "analysis" && Array.isArray(origin.evidenceRefs)
        ? { evidenceRefs: origin.evidenceRefs.filter(item => typeof item === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(item)) } : {}) }]];
  }));
}
function publicIssue(row: CoverPrepareRow, analysis: Obj) {
  const chargesPreserved = (finite(row.billing.credits_charged) || 0) > 0;
  if (row.state === "unknown" || row.state === "analyzing") return { category: "unknown", code: row.error_code || "COVER_ANALYSIS_RESULT_UNKNOWN",
    action: "wait_original", message: "文案分析结果尚未确认，请查询原任务；系统不会重复提交。", canRecoverFromReceipt: false, chargesPreserved };
  if (row.state === "needs_input" || (row.state === "failed" && analysis.status === "needs_input")) return { category: "materials", code: "COVER_MATERIALS_NEED_INPUT", action: "edit_materials",
    message: Array.isArray(analysis.missingInformation) && typeof analysis.missingInformation[0] === "string"
      ? analysis.missingInformation[0] : "请补充一项关键材料后再继续。", canRecoverFromReceipt: false, chargesPreserved };
  if (row.state !== "failed") return undefined;
  const stored = object(object(row.result).analysisIssue);
  const invalidReceipt = stored.code === "COVER_ANALYSIS_REPLAY_INVALID";
  const recoverable = !invalidReceipt && canRecoverPaidCoverAnalysis(row);
  const point = typeof stored.fieldPath === "string" && /^contentBreakdown\.keyPoints\.([0-3])$/u.exec(stored.fieldPath);
  const reference = point ? `第${Number(point[1]) + 1}条拆解重点` : stored.fieldPath === "contentBreakdown.logic" ? "逻辑说明" : "内容拆解";
  const reason = row.error_code === "ANALYSIS_EVIDENCE_INVALID" ? `${reference}引用了无法核对的依据。` : "原分析回复未通过校验。";
  return { category: "analysis", code: row.error_code || "COVER_ANALYSIS_FAILED", action: recoverable ? "query_original" : "edit_materials",
    message: invalidReceipt ? "原回复与收费记录未能核对，请保留订单并联系支持。"
      : recoverable ? `${reason}查询原任务可尝试从已付费的回复恢复，不会再次计费。`
        : object(object(row.result).analysisRecovery).outcome === "not_recoverable"
          ? `${reason}已核对原回复，无法据此生成方案。若调整材料重新分析，系统会先请你确认费用。`
          : "原分析未完成，请核对材料；原回复和费用记录已保留。",
    ...(typeof stored.fieldPath === "string" && /^[A-Za-z0-9_.]{1,160}$/u.test(stored.fieldPath) ? { fieldPath: stored.fieldPath } : {}),
    ...(typeof stored.evidenceId === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(stored.evidenceId) ? { evidenceId: stored.evidenceId } : {}),
    canRecoverFromReceipt: recoverable, chargesPreserved };
}

/** Only verified delivery fields are copied; target output dimensions do not
 * masquerade as measured output. The raw task/receipt are never spread. */
export function projectCoverReviewSafeTask(value: unknown, options: {
  receipt?: Obj; imageOrigin?: "original" | "generated"; prepareOperationId?: string;
} = {}): CoverReviewSafeTask {
  const task = object(value), receipt = object(options.receipt), rawPlan = task.renderPlan as CoverCompositionPlan;
  if (!rawPlan || coverCompositionValidationError(rawPlan)) throw new Error("COVER_PUBLIC_TASK_PLAN_INVALID");
  const plan = projectCoverCompositionPlan(rawPlan);
  const receiptString = (key: string, taskKey = key) => string(receipt[key]) ?? string(task[taskKey]);
  const receiptNumber = (key: string, taskKey = key) => finite(receipt[key]) ?? finite(task[taskKey]);
  const assetId = receiptString("assetId"), historyRecordId = receiptString("historyRecordId");
  const cloudStored = typeof receipt.cloudStored === "boolean" ? receipt.cloudStored : typeof task.cloudStored === "boolean" ? task.cloudStored : undefined;
  const url = receiptString("url") || receiptString("imageUrl");
  const statuses = ["running", "done", "display_pending", "failed", "unknown", "cancelled"];
  const status: CoverReviewSafeTask["status"] = receipt.persisted === true && cloudStored === true && assetId && historyRecordId
    ? url ? "done" : "display_pending" : statuses.includes(String(task.status)) ? task.status as CoverReviewSafeTask["status"] : "unknown";
  const result: CoverReviewSafeTask = {
    id: string(task.id) || `cover-review-${options.prepareOperationId || "unknown"}`,
    prepareOperationId: options.prepareOperationId || string(task.prepareOperationId) || "",
    title: plan.title, subtitle: plan.subtitle, ratio: plan.aspectRatio, prompt: "", briefText: string(task.briefText) || "",
    source: "生成", createdAt: receiptString("createdAt") || "", taskNo: receiptNumber("taskNo") ?? 0,
    status, renderPlan: plan, imageOrigin: options.imageOrigin || (task.imageOrigin === "original" ? "original" : "generated"),
    ...(assetId ? { assetId } : {}), ...(historyRecordId ? { historyRecordId } : {}),
    ...(cloudStored !== undefined ? { cloudStored } : {}), ...(url ? { url, imageUrl: url } : {}),
    ...(receiptString("sourceAssetId", "backgroundAssetId") ? { backgroundAssetId: receiptString("sourceAssetId", "backgroundAssetId") } : {}),
    ...(receiptString("key", "storageKey") ? { storageKey: receiptString("key", "storageKey") } : {}),
    ...(receiptNumber("width", "outputWidth") !== undefined ? { outputWidth: receiptNumber("width", "outputWidth") } : {}),
    ...(receiptNumber("height", "outputHeight") !== undefined ? { outputHeight: receiptNumber("height", "outputHeight") } : {}),
    ...(receiptNumber("sourceWidth") !== undefined ? { sourceWidth: receiptNumber("sourceWidth") } : {}),
    ...(receiptNumber("sourceHeight") !== undefined ? { sourceHeight: receiptNumber("sourceHeight") } : {}),
    ...(string(task.publicModelId) ? { publicModelId: task.publicModelId as string } : {}),
    ...(string(task.modelName) ? { modelName: task.modelName as string } : {}),
    ...(string(task.resolution) ? { resolution: task.resolution as string } : {}),
    ...(coverTextRendering(plan).mode === "native" ? { textVerification: "unverified" as const } : {}),
  };
  return result;
}

/** This is the shared public boundary for old and new operation routes. */
export function projectCoverReviewOperation(row: CoverPrepareRow, options: {
  imageQuote?: Obj; generationSpec?: unknown; generationStarted?: boolean;
} = {}) {
  const preparation = row.preparation, result = object(row.result), confirmation = preparation.recordKind === "confirmation";
  const v3 = preparation.workflowVersion === 3;
  const materialKeys = ["schemaVersion", "clientRequestId", "materialRevision", "text", "contentKind", "imageMode", "styleKey", "styleVersion", "outputRatio", "modelId", "resolution", "manualTitle"];
  const materials = CoverPrepareInputSchema.parse({ ...pick(row.materials, materialKeys), assets: row.materials.assets.map(asset => pick(asset, ["assetId", "role", "imageNumber"])) });
  const parsedAnalysis = result.analysis ? CoverContentAnalysisSchema.safeParse(result.analysis) : undefined;
  if (parsedAnalysis && !parsedAnalysis.success) throw new Error("COVER_PUBLIC_ANALYSIS_INVALID");
  const analysis = parsedAnalysis?.success ? parsedAnalysis.data : undefined;
  const privateQuote = object(preparation.quote), imageQuote = options.imageQuote || object(privateQuote.image);
  const generationSpec = options.generationSpec === undefined ? preparation.generationSpec : options.generationSpec;
  const quote = { analysis: publicAnalysisQuote(privateQuote.analysis), image: publicImageQuote(imageQuote),
    imageQuoteHash: coverReviewImageQuoteHash(imageQuote, generationSpec, preparation.outputSpec) };
  const plan = result.renderPlan as CoverCompositionPlan | undefined;
  const renderPlan = plan && !coverCompositionValidationError(plan) ? projectCoverCompositionPlan(plan) : undefined;
  const issue = publicIssue(row, object(analysis));
  const billing = publicBilling(row.billing);
  const analysisBilling = { creditsCharged: finite(row.billing.credits_charged) ?? null,
    operationId: string(row.billing.operation_id) || null,
    ...(string(row.billing.reused_from_operation_id) ? { reusedFromOperationId: row.billing.reused_from_operation_id } : {}) };
  const reviewReady = row.state === "plan_ready" && options.generationStarted !== true
    && (v3 || options.generationStarted === false);
  const common = { success: true, operationId: row.id, ...(v3 ? { workflowVersion: 3 as const } : {}),
    kind: confirmation ? "confirmation" as const : "analysis" as const,
    status: confirmation ? "confirmed" : reviewReady ? "review_ready" : row.state,
    revision: row.revision, materialFingerprint: row.material_fingerprint, materials,
    route: string(preparation.route) || "", style: publicStyle(preparation), quote, billing, analysisBilling,
    ...(string(preparation.sourceAssetId) ? { sourceAssetId: preparation.sourceAssetId } : {}),
    ...(renderPlan ? { renderPlan } : {}), ...(options.generationStarted !== undefined ? { generationStarted: options.generationStarted } : {}),
    ...(issue ? { error: issue.message, analysisIssue: issue, code: issue.code } : {}), updatedAt: row.updated_at };
  if (confirmation) {
    const originalBilling = object(preparation.originalAnalysisBilling);
    return { ...common, confirmationId: row.id, originalAnalysisOperationId: string(preparation.originalAnalysisOperationId) || "",
      confirmedPlan: CoverReviewPlanSchema.parse(preparation.confirmedPlan), confirmedPlanHash: string(preparation.confirmedPlanHash) || "",
      fieldOrigins: publicOrigins(preparation.fieldOrigins), originalAnalysisBilling: {
        operationId: string(originalBilling.operationId) || string(preparation.originalAnalysisOperationId) || "",
        creditsCharged: finite(originalBilling.creditsCharged) ?? null, chargedAgain: false,
        ...(string(originalBilling.billingOperationId) ? { billingOperationId: originalBilling.billingOperationId } : {}) },
      ...(result.task ? { task: projectCoverReviewSafeTask(result.task, { prepareOperationId: row.id,
        imageOrigin: preparation.route === "original_layout" ? "original" : "generated" }) } : {}) };
  }
  const identity = object(result.generationIdentity);
  return { ...common, ...(analysis ? { analysis,
    ...(options.generationStarted !== true ? { analysisHash: coverReviewAnalysisHash(row),
      ...(analysis.status === "ready" ? { editablePlan: coverReviewPlanFromAnalysis(analysis) } : {}) } : {}) } : {}),
    // Historical paid generation retains its original query keys. No browser
    // payload is needed to reconcile the private durable attempt.
    ...(!v3 && typeof identity.clientIdempotencyKey === "string" && typeof identity.clientTraceId === "string"
      ? { generationIdentity: { clientIdempotencyKey: identity.clientIdempotencyKey, clientTraceId: identity.clientTraceId } } : {}),
    ...(!v3 && result.task ? { task: projectCoverReviewSafeTask(result.task, { prepareOperationId: row.id,
      imageOrigin: preparation.route === "original_layout" ? "original" : "generated" }) } : {}) };
}
