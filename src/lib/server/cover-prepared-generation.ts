import { storageManager } from "@/storage/object";
import type { CoverAttemptTaskSnapshot, CoverAttemptGenerationInput } from "@/lib/cover-durable-attempt";
import { loadCoverPreparation, CoverPrepareError, coverMaterialFingerprint } from "./cover-prepare-repository";
import { coverOwnedAssets, coverImageSelection, coverGenerationSpecForTextMode, object } from "./cover-prepare-service";
import { resolveCoverMaterialBindings } from "@/lib/cover-material-composition";
import { coverReviewAnalysisHash } from "./cover-review-projection";

/** Legacy callers retain their old path. Every V2 request is bound to its
 * authenticated prepared parent, exact prompt/model and stable request key. */
export async function validatePreparedCoverGeneration(input: {
  userId: string; task: CoverAttemptTaskSnapshot; generationInput: CoverAttemptGenerationInput;
  clientIdempotencyKey: string; clientTraceId: string; requestUrl: string; resolveReferences?: boolean;
  /** Delivery of an already successful original image uses its frozen quote. */
  phase?: "generation" | "delivery";
}): Promise<string[] | null> {
  if (input.task.renderPlan.planVersion !== 2) {
    if (input.task.prepareOperationId || input.clientIdempotencyKey.startsWith("coverwb_") || input.clientTraceId.startsWith("coverwb_")) {
      throw new CoverPrepareError("COVER_PREPARED_INPUT_CONFLICT", "新版封面不能移除计划版本或文字模式后提交");
    }
    return null;
  }
  const row = await loadCoverPreparation(input.userId, input.task.prepareOperationId);
  const confirmation = row?.preparation.recordKind === "confirmation" && row.preparation.workflowVersion === 3;
  if (!row || row.user_id !== input.userId || row.state !== "plan_ready" || !row.result || row.preparation.route === "original_layout"
    || !input.task.prepareOperationId || row.id !== input.task.prepareOperationId
    || input.clientIdempotencyKey !== `coverwb_${row.id}` || input.clientTraceId !== `coverwb_${row.id}`
    || (!confirmation && row.consent?.analysis !== true) || row.consent?.image !== true
    || row.preparation.workflowVersion === 3 && !confirmation) {
    throw new CoverPrepareError("COVER_PREPARED_OPERATION_REQUIRED", "封面任务尚未完成内容分析或费用确认，已停止生图");
  }
  if (confirmation) {
    const parent = await loadCoverPreparation(input.userId, String(row.preparation.originalAnalysisOperationId || ""));
    if (!parent || parent.preparation.recordKind === "confirmation" || parent.state !== "plan_ready" || parent.consent?.analysis !== true
      || coverReviewAnalysisHash(parent) !== row.preparation.originalAnalysisHash) {
      throw new CoverPrepareError("COVER_CONFIRMATION_PARENT_CHANGED", "原分析与确认方案未能对应，请保留原任务查询");
    }
  }
  const expected = object(row.result.generationInput);
  const frozenPlan = object(row.result.renderPlan);
  // Positions, scale and color remain editable; the meaning, text and output
  // of a generation must still belong to the original analyzed parent.
  const boundPlanFields = ["title", "subtitle", "aspectRatio", "layoutTemplateId", "animationStyleId", "coverModeId", "materialSourceId", "subjectModeId", "planVersion", "outputSpec", "textRendering", "generatedOverlayLayout"] as const;
  const planBinding = (plan: Record<string, unknown>) => Object.fromEntries(boundPlanFields.map(key => [key, plan[key]]));
  if (coverMaterialFingerprint(input.generationInput) !== coverMaterialFingerprint(expected)
    || coverMaterialFingerprint(input.task.renderPlan.outputSpec) !== coverMaterialFingerprint(row.preparation.outputSpec)
    || coverMaterialFingerprint(planBinding(input.task.renderPlan)) !== coverMaterialFingerprint(planBinding(frozenPlan))
    || input.task.title !== input.task.renderPlan.title || input.task.subtitle !== input.task.renderPlan.subtitle
    || input.task.ratio !== input.task.renderPlan.aspectRatio || input.task.prompt !== expected.prompt) {
    throw new CoverPrepareError("COVER_PREPARED_INPUT_CONFLICT", "生图参数与已确认材料不一致，已停止提交");
  }
  // No present-day model directory, price or signed-reference lookup may block
  // recovery of a provider result which has already completed and been paid.
  if (input.phase === "delivery") return [];
  const selection = await coverImageSelection(input.requestUrl, row.materials);
  const quote = object(object(row.preparation.quote).image);
  if (selection.amount !== quote.amount) {
    throw new CoverPrepareError("COVER_IMAGE_QUOTE_CHANGED", "图片生成价格已变化，请确认当前费用后再提交");
  }
  if (row.preparation.promptDependencies) {
    const currentSpec = coverGenerationSpecForTextMode(selection.generation.generationSpec, object(row.preparation.textRendering).mode === "native");
    if (quote.unit !== "yuan" || quote.modelId !== row.materials.modelId || quote.resolution !== selection.resolution
      || coverMaterialFingerprint(currentSpec) !== coverMaterialFingerprint(row.preparation.generationSpec)) {
      throw new CoverPrepareError("COVER_IMAGE_CONFIGURATION_CHANGED", "图片模型、分辨率或生成比例已变化，请重新准备并确认当前方案");
    }
    const capabilities = object(selection.model.capabilities);
    if (row.materials.assets.length && (capabilities.supportsReferenceInput !== true
      || !Number.isSafeInteger(Number(capabilities.maxReferenceImages)) || Number(capabilities.maxReferenceImages) < row.materials.assets.length)) {
      throw new CoverPrepareError("COVER_REFERENCE_MODEL_UNSUPPORTED", "当前模型的图片输入能力已变化，请重新选择支持全部材料的模型");
    }
  }
  if (!input.resolveReferences) return [];
  const assets = await coverOwnedAssets(input.userId, row.materials);
  // Supply the exact frozen order used by the numbered analysis/prompt binding.
  // A subject or scene is an image input in composition mode, not a retained
  // original canvas. Legacy style-only references keep their existing behavior.
  const references = row.materials.imageMode === "compose"
    ? resolveCoverMaterialBindings(row.materials).images : row.materials.assets.filter(asset => asset.role === "style_reference");
  return Promise.all(references.map(async reference => {
    const owned = assets.find(asset => asset.id === reference.assetId)!;
    return storageManager.getSignedUrl(owned.storage_key, { expireTime: 600 }, "tencent_cos");
  }));
}
