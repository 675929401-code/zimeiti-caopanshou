import { GET as coverModelCatalog } from "@/app/api/cover-models/route";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager } from "@/storage/object";
import sharp from "sharp";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import {
  assertCoverOwnedAssets, coverOutputSpec, parseCoverModelCatalog,
  resolveCoverGenerationSpec, resolveCoverMaterialRoute, resolveCoverStyle,
  parseCoverContentAnalysis, prepareCoverContentAnalysisEvidence, CoverVisualObservationSchema,
  CoverStyleDefinitionSchema, CoverContentBreakdownSchema, CoverContentAnalysisSchema,
  COVER_REFERENCE_STYLE_PROFILE,
  type CoverPrepareInput, type CoverVisualObservation, type CoverGenerationSpec, type CoverContentAnalysis,
} from "@/lib/cover-workbench-contract";
import { compileCoverAnalysisMessages, compileCoverAnalysisInputTemplate, compileCoverBackgroundPrompt, compileCoverNativePrompt, coverAnalysisDependencySnapshot, COVER_ANALYSIS_PROMPT_VERSION, COVER_BACKGROUND_PROMPT_VERSION, COVER_NATIVE_PROMPT_VERSION } from "@/lib/cover-workbench-prompts";
import { parseCoverAnalysisEnvelope, type CoverAnalysisTransportNormalization } from "@/lib/cover-analysis-envelope";
import { COVER_ORIGINAL_LAYOUT_VERSION, COVER_TEXT_RENDERING_VERSION, coverTextRendering, coverGeneratedOverlayPolicy, coverGeneratedOverlayTitleStyle, coverGeneratedOverlayLayoutMatches, coverCompositionValidationError, type CoverCompositionPlan } from "@/lib/cover-composition";
import { coverReferenceTitleStyle } from "@/lib/cover-reference-layout";
import { coverMaterialsWithUsage } from "@/lib/cover-material-usage";
import type { CoverGenerationPayload, CoverGenerationTask } from "@/lib/cover-generation-attempt";
import { resolveCoverMaterialBindings, CoverMaterialCompositionError, COVER_CUSTOM_COMPOSITION_STYLE_PROFILE } from "@/lib/cover-material-composition";
import { resolveBenchmarkCoverLayout } from "@/lib/cover-benchmark-layout";
import { CoverPrepareError, coverMaterialFingerprint, findReusableCoverAnalysis, type CoverPrepareRow } from "./cover-prepare-repository";
import { CoverStyleStoreError, type CoverStyleRuntime, type CoverWorkflowRelease } from "./cover-style-config";
import { resolveCoverAnalysisModel, type CoverAnalysisModelSelection } from "./cover-admin-runtime";
import { compileCoverAdminPreview, assertCoverPrivateSnapshotBudget } from "./cover-workflow-publication";
import { coverAnimationBrief } from "@/lib/cover-animation-brief";

type OwnedAsset = { id: string; user_id: string; storage_key: string; storage_provider: string; file_category: string; content_type: string; file_size: number };
export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const currentPromptDependencies = (materials: CoverPrepareInput, runtime?: CoverStyleRuntime, workflow?: CoverWorkflowRelease, analysisModel?: CoverAnalysisModelSelection) => ({
  ...(() => {
    const dependencies = coverAnalysisDependencySnapshot(materials, runtime, workflow);
    if (!runtime) return dependencies;
    const { promptPack, ...identity } = dependencies;
    void promptPack;
    return { ...identity, styleReleaseId: runtime.release.releaseId, styleReleaseHash: runtime.release.snapshotSha256,
      ...(runtime.sceneBriefVersion ? { sceneBriefVersion: runtime.sceneBriefVersion } : {}),
      promptPackFingerprint: coverMaterialFingerprint(runtime.promptPack) };
  })(),
  analysisCompilerFingerprint: coverMaterialFingerprint(compileCoverAnalysisMessages.toString()),
  analysisInputCompilerFingerprint: coverMaterialFingerprint(compileCoverAnalysisInputTemplate.toString()),
  backgroundCompilerFingerprint: coverMaterialFingerprint(compileCoverBackgroundPrompt.toString()),
  nativeCompilerFingerprint: coverMaterialFingerprint(compileCoverNativePrompt.toString()),
  visualBindingCompilerFingerprint: coverMaterialFingerprint(compileBoundCoverVisualObservations.toString()),
  ...(analysisModel ? { analysisModelId: analysisModel.id, analysisModelFingerprint: analysisModel.fingerprint } : {}),
});

/** Preserve image identity when observations arrive in a different array order.
 * This only projects validated observations into a new generation prompt; it
 * never rewrites source observations, images, or previously saved confirmations.
 */
export function compileBoundCoverVisualObservations(materials: CoverPrepareInput, observations: readonly CoverVisualObservation[]) {
  const bindings = resolveCoverMaterialBindings(materials).images;
  if (new Set(observations.map(observation => observation.assetId)).size !== observations.length
    || observations.some(observation => !bindings.some(binding => binding.assetId === observation.assetId))) {
    throw new CoverPrepareError("COVER_VISUAL_OBSERVATION_BINDING_INVALID", "图片观察与原素材编号无法核对，请保留原任务查询", 422);
  }
  return bindings.flatMap(binding => {
    const observation = observations.find(item => item.assetId === binding.assetId);
    return observation ? [{ assetId: observation.assetId, assetRevision: observation.assetRevision,
      inputIndex: binding.inputIndex, imageNumber: binding.imageNumber, reference: binding.reference, role: binding.role,
      observations: observation.observations, palette: observation.palette }] : [];
  });
}
export function coverGenerationSpecForTextMode(spec: CoverGenerationSpec, native: boolean): CoverGenerationSpec {
  if (!native || !spec.crop) return spec;
  const generation = { ...spec }; delete generation.crop;
  return { ...generation, ratioEvidence: "application_contain_mapping" };
}

/** Only fresh, unpaid analysis dispatches use the current compiler. Original
 * paid/unknown replies are recovered independently and never pass this gate. */
export function assertCoverPreparationCurrent(row: CoverPrepareRow): void {
  if (row.preparation.recordKind === "confirmation") throw new CoverPrepareError("COVER_CONFIRMATION_ANALYSIS_FORBIDDEN", "已确认方案不能重新调用分析");
  const runtime = row.preparation.frozenStyleRuntime as CoverStyleRuntime | undefined;
  const workflow = row.preparation.frozenWorkflowRuntime as CoverWorkflowRelease | undefined;
  const dependencies = currentPromptDependencies(row.materials, runtime, workflow, row.preparation.analysisModelSnapshot as CoverAnalysisModelSelection | undefined);
  const frozen = row.preparation.promptDependencies;
  const expected = coverMaterialFingerprint(dependencies);
  const preparationFingerprint = row.preparation.preparationFingerprint;
  const snapshot = Object.fromEntries(Object.entries(row.preparation).filter(([key]) => !["preparationFingerprint", "analysisPayloadFingerprint"].includes(key)));
  if (!frozen || row.preparation.promptDependenciesFingerprint !== expected
    || coverMaterialFingerprint(frozen) !== expected || row.preparation.analysisPromptVersion !== dependencies.analysisPromptVersion
    || row.preparation.analysisMessagesFingerprint !== coverMaterialFingerprint(compileCoverAnalysisInputTemplate(row.materials, [], runtime, workflow))
    || row.preparation.styleFingerprint !== coverMaterialFingerprint(row.preparation.style)
    || preparationFingerprint !== coverMaterialFingerprint(snapshot)) {
    throw new CoverPrepareError("COVER_PREPARATION_STALE", "制作方案已更新，请重新准备并确认费用；本次尚未调用模型或扣费", 409);
  }
}

export async function assertCoverStyleReleaseCurrent(row: CoverPrepareRow) {
  const workflow = row.preparation.frozenWorkflowRuntime as CoverWorkflowRelease | undefined;
  if (workflow) {
    try {
      const { resolvePublishedCoverWorkflow } = await import("./cover-style-store");
      const current = await resolvePublishedCoverWorkflow();
      const selected = await resolveCoverAnalysisModel(current, row.materials.assets.length > 0);
      const frozenModel = row.preparation.analysisModelSnapshot as CoverAnalysisModelSelection | undefined;
      if (current.releaseId !== workflow.releaseId || current.snapshotSha256 !== workflow.snapshotSha256
        || !frozenModel || selected.id !== frozenModel.id || selected.fingerprint !== frozenModel.fingerprint)
        throw new CoverPrepareError("COVER_PREPARATION_STALE", "共用规则或分析模型已有变化，请保留输入重新准备；本次未调用模型或扣费");
    } catch (error) {
      if (error instanceof CoverPrepareError) throw error;
      throw new CoverPrepareError("COVER_PREPARATION_STALE", "当前拆解配置暂不可用，请保留输入并核对配置；本次未调用模型或扣费");
    }
  }
  const frozen = row.preparation.frozenStyleRuntime as CoverStyleRuntime | undefined;
  if (!frozen) return;
  const { resolvePublishedCoverStyle } = await import("./cover-style-store");
  let current: CoverStyleRuntime;
  try { current = await resolvePublishedCoverStyle(row.materials.styleKey); }
  catch (error) {
    if (!(error instanceof CoverStyleStoreError)) throw error;
    throw new CoverPrepareError("COVER_PREPARATION_STALE", "所选风格已更新或停用，请保留输入重新准备；本次未调用模型或扣费", 409);
  }
  if (current.release.releaseId !== frozen.release.releaseId || current.release.snapshotSha256 !== frozen.release.snapshotSha256
    || coverMaterialFingerprint(current.promptPack) !== coverMaterialFingerprint(frozen.promptPack)) {
    throw new CoverPrepareError("COVER_PREPARATION_STALE", "所选风格已更新，请保留输入重新准备；本次未调用模型或扣费");
  }
}

export async function coverOwnedAssets(userId: string, materials: CoverPrepareInput): Promise<OwnedAsset[]> {
  if (!materials.assets.length) return [];
  const result = await getSupabaseClient().from("user_files")
    .select("id,user_id,storage_key,storage_provider,file_category,content_type,file_size")
    .eq("user_id", userId).in("id", materials.assets.map(asset => asset.assetId));
  if (result.error) throw new CoverPrepareError("COVER_MATERIAL_STORAGE_UNAVAILABLE", "暂时无法读取图片材料", 503);
  const assets = (result.data || []) as OwnedAsset[];
  assertCoverOwnedAssets(materials, userId, assets);
  if (assets.some(asset => asset.storage_provider !== "tencent_cos" || asset.file_size > 5 * 1024 * 1024
    || !/^image\/(png|jpeg|webp)$/u.test(asset.content_type))) {
    throw new CoverPrepareError("COVER_MATERIAL_UNSUPPORTED", "请重新上传 5 MB 以内的 PNG、JPG 或 WebP 图片", 422);
  }
  return assets;
}

export async function readCoverOriginalSourceDimensions(userId: string, materials: CoverPrepareInput, sourceAssetId: string, owned?: OwnedAsset[]) {
  const file = (owned || await coverOwnedAssets(userId, materials)).find(asset => asset.id === sourceAssetId);
  if (!file) throw new CoverPrepareError("COVER_MATERIAL_NOT_OWNED", "原图不存在或不属于当前账号", 404);
  const bytes = await storageManager.readBounded(file.storage_key, 5 * 1024 * 1024, 20_000, "tencent_cos");
  const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 }).metadata();
  const rotated = [5, 6, 7, 8].includes(Number(metadata.orientation) || 1);
  const sourceWidth = Number(rotated ? metadata.height : metadata.width) || 0, sourceHeight = Number(rotated ? metadata.width : metadata.height) || 0;
  if (sourceWidth < 256 || sourceHeight < 256) throw new CoverPrepareError("COVER_SOURCE_PIXELS_INSUFFICIENT", "原图像素不足，请更换清晰图片", 422);
  return { sourceWidth, sourceHeight };
}

export async function coverImageSelection(requestUrl: string, materials: CoverPrepareInput) {
  const response = await coverModelCatalog(new Request(new URL("/api/cover-models?surface=cover-studio", requestUrl)));
  const payload = object(await response.json());
  const models = parseCoverModelCatalog(payload.models);
  const model = models.find(entry => entry.id === materials.modelId);
  if (!model) throw new CoverPrepareError("COVER_IMAGE_MODEL_UNAVAILABLE", "请选择当前目录中的图片生成模型", 422);
  const cap = object(model.capabilities);
  if (cap.available === false || cap.generationReady === false || cap.priceReady === false || cap.protocolReady === false) {
    throw new CoverPrepareError("COVER_IMAGE_MODEL_NOT_READY", String(cap.availabilityMessage || "所选图片模型暂时不能生成，请选择其他模型"), 422);
  }
  const resolution = materials.resolution || "2K";
  if (resolution === "1K") throw new CoverPrepareError("COVER_OUTPUT_RESOLUTION_INSUFFICIENT", "标准封面导出需要 2K 或 4K 底图，请提高生成清晰度", 422);
  const ratios = Array.isArray(cap.aspectRatios) ? cap.aspectRatios : [];
  const fallback = materials.outputRatio === "3:4" && ratios.includes("9:16") ? "9:16"
    : materials.outputRatio === "4:3" && ratios.includes("16:9") ? "16:9" : null;
  const generation = resolveCoverGenerationSpec({ ...materials, resolution }, model, fallback ? [{
    modelId: model.id, outputRatio: materials.outputRatio, generationRatio: fallback,
    resolution, policyId: "cover-fixed-export-v2", evidence: "原生比例请求；应用合成器验证实际像素后裁切为固定封面尺寸", allowUpscale: false,
  }] : []);
  if (!generation.ready) throw new CoverPrepareError(generation.code, generation.message, 422);
  const prices = parsePublicImageResolutionPrices(cap.resolutionPrices);
  const price = prices?.[resolution as keyof typeof prices];
  const base = object(model).publicPrice;
  const amount = typeof price === "number" ? price : typeof base === "number" ? base : null;
  if (amount === null || !Number.isFinite(amount) || amount < 0) throw new CoverPrepareError("COVER_IMAGE_PRICE_UNAVAILABLE", "所选模型的当前价格尚未确认", 422);
  return { model, generation, amount, resolution };
}

export async function buildCoverPreparation(requestUrl: string, userId: string, materials: CoverPrepareInput, options: { workflowVersion?: 3 } = {}) {
  let materialBindings;
  try { materialBindings = resolveCoverMaterialBindings(materials); }
  catch (error) { if (error instanceof CoverMaterialCompositionError) throw new CoverPrepareError(error.code, error.message, 422); throw error; }
  const owned = await coverOwnedAssets(userId, materials);
  if (materialBindings.imageMode !== "compose" && materials.assets.filter(asset => asset.role !== "style_reference").length > 1) {
    throw new CoverPrepareError("COVER_MULTIPLE_PRESERVED_IMAGES_UNAVAILABLE", "当前可完整保留一张图片，请将其余图片设为参考配色和布局；本次没有调用分析模型", 422);
  }
  const requestedRoute = resolveCoverMaterialRoute(materials);
  // Without a verified segmentation service, preserve the complete source
  // photograph. Never describe a model redraw as identity preservation.
  const preserved = materialBindings.imageMode === "compose" ? undefined : materials.assets.find(asset => asset.role === "background_canvas")
    || materials.assets.find(asset => asset.role === "identity_subject");
  const route = preserved ? "original_layout" : requestedRoute;
  const usePublishedStyle = options.workflowVersion === 3 && materials.contentKind !== "product" && materialBindings.imageMode !== "compose" && !materials.assets.length;
  let runtime: CoverStyleRuntime | undefined;
  if (usePublishedStyle) {
    try { runtime = await (await import("./cover-style-store")).resolvePublishedCoverStyle(materials.styleKey, materials.styleVersion); }
    catch (error) {
      if (!(error instanceof CoverStyleStoreError)) throw error;
      throw new CoverPrepareError(error.code, error.message, error.status);
    }
  }
  const style = runtime?.style || (materialBindings.imageMode === "compose" || materials.contentKind === "product"
    ? CoverStyleDefinitionSchema.parse(COVER_CUSTOM_COMPOSITION_STYLE_PROFILE) : materials.assets.some(asset => asset.role === "style_reference")
    ? CoverStyleDefinitionSchema.parse(COVER_REFERENCE_STYLE_PROFILE) : resolveCoverStyle(materials.styleKey, materials.styleVersion));
  const native = route === "new_visual" && materials.contentKind !== "product" && materials.imageMode !== "compose"
    && (Boolean(runtime) || style.key === "cartoon" || style.key === "funny-cartoon");
  const textRendering = { mode: native ? "native" as const : "overlay" as const, version: COVER_TEXT_RENDERING_VERSION };
  const generatedOverlayLayout = !preserved && !native && materials.assets.length ? coverGeneratedOverlayPolicy() : undefined;
  const outputSpec = { ...coverOutputSpec(materials.outputRatio), ...(preserved || native || generatedOverlayLayout ? { fit: "contain" as const } : {}) };
  let originalLayout: CoverCompositionPlan["originalLayout"];
  if (preserved) {
    const { sourceWidth: width, sourceHeight: height } = await readCoverOriginalSourceDimensions(userId, materials, preserved.assetId, owned);
    if (!width || !height || Math.min(outputSpec.width / width, outputSpec.height / height) > 1 + 1e-12) {
      throw new CoverPrepareError("COVER_SOURCE_PIXELS_INSUFFICIENT", "原图像素不足以导出所选尺寸，请先更换清晰图片；本次没有调用分析模型", 422);
    }
    originalLayout = { version: COVER_ORIGINAL_LAYOUT_VERSION, sourceWidth: width, sourceHeight: height, structure: "single", focus: "object" };
  }
  const needsVision = materials.assets.length > 0;
  let workflow: CoverWorkflowRelease;
  let analysisModel: CoverAnalysisModelSelection;
  try {
    workflow = await (await import("./cover-style-store")).resolvePublishedCoverWorkflow();
    analysisModel = await resolveCoverAnalysisModel(workflow, needsVision);
    compileCoverAdminPreview(materials, workflow, runtime, analysisModel);
  } catch (error) {
    if (error instanceof CoverStyleStoreError) throw new CoverPrepareError(error.code, error.message, error.status);
    throw new CoverPrepareError("COVER_ANALYSIS_MODEL_UNAVAILABLE", "暂时无法确认拆解配置或分析模型，本次未调用模型", 503);
  }
  const content = { text: materials.text, assets: materials.assets, manualTitle: materials.manualTitle || null,
    ...(materials.contentKind === "product" ? { contentKind: "product" } : {}), ...(materials.imageMode ? { imageMode: materials.imageMode } : {}) };
  const promptDependencies = currentPromptDependencies(materials, runtime, workflow, analysisModel);
  const promptDependenciesFingerprint = coverMaterialFingerprint(promptDependencies);
  // The complete analysis includes style-specific headlines and visual intent.
  // Only the same style/pack/compiler can advertise a free reuse. Historical
  // paid operations stay recoverable under their own original operation IDs.
  const contentFingerprint = coverMaterialFingerprint({ ...content, promptDependenciesFingerprint });
  const reusable = await findReusableCoverAnalysis(userId, contentFingerprint);
  const image = preserved ? null : await coverImageSelection(requestUrl, materials);
  if (image && materials.assets.length && object(image.model.capabilities).supportsReferenceInput !== true) {
    throw new CoverPrepareError("COVER_REFERENCE_MODEL_UNSUPPORTED", "所选图片模型不支持参考图，请更换支持图片输入的模型", 422);
  }
  if (image && materialBindings.images.length) {
    const maximum = Number(object(image.model.capabilities).maxReferenceImages);
    if (!Number.isSafeInteger(maximum) || maximum < materialBindings.images.length) {
      throw new CoverPrepareError("COVER_REFERENCE_LIMIT_EXCEEDED", "当前模型支持的参考图片数量不足，请减少图片或更换模型后再继续", 422);
    }
  }
  const preparation = {
    ...(options.workflowVersion === 3 ? { workflowVersion: 3, recordKind: "analysis" } : {}),
    ...(runtime ? { frozenStyleRuntime: runtime } : {}),
    frozenWorkflowRuntime: workflow, analysisModelSnapshot: analysisModel,
    route, style, outputSpec, contentFingerprint, analysisPromptVersion: COVER_ANALYSIS_PROMPT_VERSION,
    promptDependencies, promptDependenciesFingerprint, textRendering,
    ...(generatedOverlayLayout ? { generatedOverlayLayout } : {}),
    analysisMessagesFingerprint: coverMaterialFingerprint(compileCoverAnalysisInputTemplate(materials, [], runtime, workflow)), styleFingerprint: coverMaterialFingerprint(style),
    ...(reusable?.result?.analysis ? { reuseAnalysisOperationId: reusable.id, reuseAnalysisContentFingerprint: reusable.preparation.contentFingerprint } : {}),
    ...(preserved ? { sourceAssetId: preserved.assetId, originalLayout } : {}),
    ...(image ? { generationSpec: coverGenerationSpecForTextMode(image.generation.generationSpec, native) } : {}),
    quote: {
      analysis: { modelId: analysisModel.id, modelName: analysisModel.displayName, amount: reusable?.result?.analysis ? 0 : null, unit: "credits", policy: reusable?.result?.analysis ? "reuse_completed_analysis" : "actual_usage" },
      image: { modelId: materials.modelId || "", modelName: image ? String(object(image.model).displayName || "") : "保留原图",
        amount: image?.amount ?? 0, unit: "yuan", resolution: image?.resolution || materials.resolution || "2K", ready: true },
    },
    notices: [
      ...(native && image?.generation.generationSpec.crop
        ? [`模型按 ${image.generation.generationSpec.aspectRatio} 生成完整封面，再完整保留到 ${materials.outputRatio} 并留白；不会裁切已生成的标题或放大不足像素的图片。`]
        : image?.generation.notices || []),
      ...(preserved ? ["保留整张原图并添加标题，不会重新绘制图片；尚未接入自动抠图，主体照片也按整图排版。"] : []),
      reusable?.result?.analysis ? "相同内容与风格已有分析结果，本次调整模型或尺寸无需重复分析；图片生成费用另计。"
        : "文案分析按实际用量计费，提交前无法确定总额；图片生成费用另计。",
    ],
  };
  const snapshot = { ...preparation, preparationFingerprint: coverMaterialFingerprint(preparation) };
  try { assertCoverPrivateSnapshotBudget(snapshot); }
  catch { throw new CoverPrepareError("COVER_SNAPSHOT_TOO_LARGE", "当前风格与分析规则超过保存预算，请缩短规则后重新准备；本次未调用模型", 422); }
  return snapshot;
}

const analysisTransportNormalizations = new WeakMap<object, CoverAnalysisTransportNormalization>();
export function extractCoverLlmJson(payload: unknown): unknown {
  const row = object(payload);
  const text = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value) || !value.length || !value.every(part => {
      const entry = object(part); return ["text", "output_text"].includes(String(entry.type)) && typeof entry.text === "string";
    })) return "";
    return value.map(part => String(object(part).text)).join("\n");
  };
  let content = text(row.output_text) || text(row.content);
  if (!content && Array.isArray(row.choices)) {
    const choice = object(row.choices[0]);
    const message = object(choice.message);
    content = text(message.content) || text(choice.text);
  }
  if (!content || content.length > 90_000) throw new CoverPrepareError("COVER_ANALYSIS_FORMAT_INVALID", "模型未返回可核对的分析结果，原请求与费用记录已保留", 422);
  const clean = content.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed = parseCoverAnalysisEnvelope(clean);
    if (parsed.normalization && parsed.value && typeof parsed.value === "object") analysisTransportNormalizations.set(parsed.value, parsed.normalization);
    return parsed.value;
  } catch { throw new CoverPrepareError("COVER_ANALYSIS_FORMAT_INVALID", "文案分析格式未通过检查，原请求与费用记录已保留", 422); }
}

export function readCoverAnalysisBilling(payload: unknown) {
  const receipt = object(object(payload)._billing);
  if (typeof receipt.credits_charged !== "number" || !Number.isFinite(receipt.credits_charged) || receipt.credits_charged < 0
    || (receipt.credits_charged > 0 && !receipt.operation_id)) {
    throw new CoverPrepareError("COVER_ANALYSIS_BILLING_UNKNOWN", "分析已返回，费用记录仍待确认，请勿再次提交", 503);
  }
  return receipt;
}

export async function coverAnalysisRequest(row: CoverPrepareRow) {
  assertCoverPreparationCurrent(row);
  const assets = await coverOwnedAssets(row.user_id, row.materials);
  const template = compileCoverAnalysisInputTemplate(row.materials, [], row.preparation.frozenStyleRuntime as CoverStyleRuntime | undefined,
    row.preparation.frozenWorkflowRuntime as CoverWorkflowRelease | undefined);
  if (!template.parts) return [{ role: "system", content: template.systemPrompt }, { role: "user", content: template.userMessage }];
  const parts: Array<Record<string, unknown>> = [];
  for (const part of template.parts) {
    if (part.type === "text") { parts.push(part); continue; }
    const owned = assets.find(asset => asset.id === part.assetId)!;
    // Transient provider input only. Signed URLs and bytes never enter the
    // durable material snapshot, response, logs or browser storage.
    const bytes = await storageManager.readBounded(owned.storage_key, 5 * 1024 * 1024, 20_000, "tencent_cos");
    parts.push({ type: "image_url", image_url: { url: `data:${owned.content_type};base64,${bytes.toString("base64")}` } });
  }
  return [{ role: "system", content: template.systemPrompt }, { role: "user", content: parts }];
}

// A provider can cite an evidence ID it never declared. An affected editorial
// conclusion can be replaced with its surviving, verbatim source excerpts.
// Never retain a paraphrase by merely dropping its unsupported references.
function groundProviderBreakdown(value: unknown, materials: CoverPrepareInput) {
  const analysis = object(value);
  const breakdown = CoverContentBreakdownSchema.safeParse(analysis.contentBreakdown);
  const evidence = CoverContentAnalysisSchema.shape.evidence.safeParse(analysis.evidence);
  const replacements: { fieldPath: string; missingRefs: string[]; sourceRefs: string[] }[] = [];
  if (!breakdown.success || !evidence.success) return { value, replacements };
  const byId = new Map(evidence.data.map(entry => [entry.id, entry]));
  const repair = (point: typeof breakdown.data.summary, fieldPath: string) => {
    const refs = point.evidenceRefs;
    const missingRefs = refs.filter(id => !byId.has(id));
    if (!missingRefs.length || new Set(refs).size !== refs.length) return point;
    const sourceRefs = refs.filter(id => byId.has(id));
    const excerpts = sourceRefs.map(id => byId.get(id)!);
    if (!excerpts.length || excerpts.some(entry => entry.source !== "text" || !materials.text.includes(entry.quote))) return point;
    const text = excerpts.map(entry => entry.quote).join("\n");
    if (text.length > 600) return point;
    replacements.push({ fieldPath, missingRefs, sourceRefs });
    return { text, evidenceRefs: sourceRefs };
  };
  const original = breakdown.data;
  const next = { summary: repair(original.summary, "summary"), keyPoints: original.keyPoints.map((point, i) => repair(point, `keyPoints.${i}`)),
    logic: repair(original.logic, "logic"), coverFocus: repair(original.coverFocus, "coverFocus") };
  return { value: replacements.length ? { ...analysis, contentBreakdown: next } : value, replacements };
}

export function completeCoverAnalysisPlan(row: CoverPrepareRow, raw: unknown) {
  if (row.preparation.recordKind === "confirmation") throw new CoverPrepareError("COVER_CONFIRMATION_ANALYSIS_FORBIDDEN", "已确认方案不允许重新分析");
  const envelope = object(raw);
  const observations: CoverVisualObservation[] = Array.isArray(envelope.visualObservations)
    ? envelope.visualObservations.map(value => CoverVisualObservationSchema.parse(value)) : [];
  if (row.materials.assets.some(reference => !observations.some(observation => observation.assetId === reference.assetId && observation.status === "ready"))
    || observations.some(observation => !row.materials.assets.some(reference => reference.assetId === observation.assetId))) {
    throw new CoverPrepareError("COVER_VISUAL_ANALYSIS_INCOMPLETE", "参考图未能完成可靠分析，原请求已保留，请补充清晰图片", 422);
  }
  const prepared = prepareCoverContentAnalysisEvidence(envelope.analysis || raw, row.materials, observations);
  const grounded = groundProviderBreakdown(prepared.value, row.materials);
  const analysis = parseCoverContentAnalysis(grounded.value, row.materials, observations);
  const transportNormalization = raw && typeof raw === "object" ? analysisTransportNormalizations.get(raw) : undefined;
  const analysisAudits = { analysisSourceAudit: { ...prepared.sourceAudit,
    ...(grounded.replacements.length ? { breakdownSourceReplacements: grounded.replacements } : {}) },
    ...(transportNormalization ? { analysisTransportNormalization: transportNormalization } : {}) };
  const preparation = row.preparation;
  if (analysis.status === "needs_input") return { ...(preparation.workflowVersion === 3 ? {} : preparation), analysis, visualObservations: observations, ...analysisAudits };
  if (preparation.analysisPromptVersion === COVER_ANALYSIS_PROMPT_VERSION && !preparation.reuseAnalysisOperationId
    && (!analysis.contentBreakdown || !analysis.layoutIntent)) {
    throw new CoverPrepareError("ANALYSIS_CONTENT_BREAKDOWN_MISSING", "文案分析未返回完整拆解，原请求与费用记录已保留，不会重新扣费分析", 422);
  }
  if (preparation.analysisPromptVersion === COVER_ANALYSIS_PROMPT_VERSION && row.materials.assets.length && !analysis.materialUsage) {
    throw new CoverPrepareError("COVER_MATERIAL_USAGE_INCOMPLETE", "本次分析没有说明每张图片的用途，原费用已保留，不会继续生图或自动再次分析", 422);
  }
  if (preparation.workflowVersion === 3 && preparation.recordKind === "analysis") return { analysis, visualObservations: observations, ...analysisAudits };
  return { ...compileCoverPlanFromAnalysis(row, analysis, observations), ...analysisAudits };
}

/** Pure compilation after validation or explicit user review; never an LLM call. */
export function compileCoverPlanFromAnalysis(row: CoverPrepareRow, analysis: CoverContentAnalysis, observations: CoverVisualObservation[] = []) {
  const preparation = row.preparation;
  if (Object.prototype.hasOwnProperty.call(preparation, "generatedOverlayLayout")
    && !coverGeneratedOverlayLayoutMatches(preparation.generatedOverlayLayout, coverGeneratedOverlayPolicy())) {
    throw new CoverPrepareError("COVER_GENERATED_LAYOUT_INVALID", "自动留白排版策略版本无效，请保留原任务查询", 422);
  }
  const refs = row.materials.assets.filter(asset => asset.role === "style_reference");
  const effectiveMaterials = coverMaterialsWithUsage(row.materials, analysis.materialUsage);
  const style = CoverStyleDefinitionSchema.parse(preparation.style);
  const native = object(preparation.textRendering).mode === "native";
  const layoutPlan = !preparation.generatedOverlayLayout && preparation.workflowVersion !== 3 && preparation.route !== "original_layout" && (style.key === "cartoon" || style.key === "funny-cartoon")
    ? resolveBenchmarkCoverLayout({ analysis, styleKey: style.key, ratio: row.materials.outputRatio }) : undefined;
  const automaticTitleStyle = coverReferenceTitleStyle({ materials: row.materials, observations,
    materialUsage: analysis.materialUsage,
    sourceAssetId: typeof preparation.sourceAssetId === "string" ? preparation.sourceAssetId : undefined });
  const joinedTitle = analysis.secondaryTitle ? `${analysis.primaryTitle}\n${analysis.secondaryTitle}` : analysis.primaryTitle;
  // The workbench exposes one editable title field. Keep every displayed word
  // in that field instead of adding an invisible, uneditable subtitle layer.
  const editableTitle = row.materials.manualTitle || (joinedTitle.length <= 80 && joinedTitle.split(/\r?\n/u).length <= 3 ? joinedTitle : analysis.primaryTitle);
  const reviewed = object(preparation.confirmedPlan);
  const renderPlan: CoverCompositionPlan = {
    planVersion: 2, title: typeof reviewed.primaryTitle === "string" ? reviewed.primaryTitle : native ? row.materials.manualTitle || analysis.primaryTitle : editableTitle,
    subtitle: preparation.recordKind === "confirmation" ? String(reviewed.secondaryTitle || "") : native && !row.materials.manualTitle ? analysis.secondaryTitle || "" : "",
    ...(preparation.textRendering ? { textRendering: preparation.textRendering as CoverCompositionPlan["textRendering"] } : {}),
    aspectRatio: row.materials.outputRatio, outputSpec: preparation.outputSpec as CoverCompositionPlan["outputSpec"],
    animationStyleId: style.key === "custom-composition" ? "photo-real" : "pixar-3d", layoutTemplateId: layoutPlan?.templateId || "gaoding-cover-workbench",
    coverModeId: preparation.workflowVersion === 3 ? style.key : row.materials.styleKey === "funny-cartoon" ? "funny-cartoon" : "cartoon",
    materialSourceId: refs.length ? "template" : row.materials.assets.length ? "upload" : "text",
    subjectModeId: row.materials.assets.some(asset => asset.role === "identity_subject") ? "product" : "semantic",
    titleStyle: { ...automaticTitleStyle, ...layoutPlan?.titleStyle, colorMode: refs.length || row.materials.assets.length || style.key === "custom-composition" ? "single" : "palette", color: automaticTitleStyle.color
      || (refs.length || style.key === "custom-composition" ? "#FFFFFF" : row.materials.styleKey === "funny-cartoon" ? "#FFCF4A" : "#FFF1B8") },
    ...(preparation.route === "original_layout" && preparation.originalLayout ? { originalLayout: {
      ...preparation.originalLayout as NonNullable<CoverCompositionPlan["originalLayout"]>,
      structure: analysis.layoutIntent?.structure || "single", focus: analysis.layoutIntent?.focus || "object",
    } } : {}),
    ...(preparation.generatedOverlayLayout ? { generatedOverlayLayout: preparation.generatedOverlayLayout as CoverCompositionPlan["generatedOverlayLayout"], titleStyle: coverGeneratedOverlayTitleStyle() } : {}),
  };
  if (preparation.generatedOverlayLayout && coverCompositionValidationError(renderPlan)) throw new CoverPrepareError("COVER_GENERATED_LAYOUT_INVALID", "自动留白排版策略与确认方案不一致，请保留原任务查询", 422);
  if (preparation.route === "original_layout") return { ...(preparation.workflowVersion === 3 ? {} : preparation), analysis, visualObservations: observations, renderPlan };
  const generationSpec = preparation.generationSpec as Parameters<typeof compileCoverBackgroundPrompt>[0]["generationSpec"];
  const frozenDependencies = object(preparation.promptDependencies);
  const materialExplicitConstraintsVersion = frozenDependencies.materialExplicitConstraintsVersion as NonNullable<Parameters<typeof compileCoverBackgroundPrompt>[1]>["materialExplicitConstraintsVersion"];
  const runtime = preparation.frozenStyleRuntime as CoverStyleRuntime | undefined;
  const compileInput = { analysis, style, generationSpec, outputSpec: preparation.outputSpec as ReturnType<typeof coverOutputSpec>, materials: effectiveMaterials, layoutPlan,
    ...(renderPlan.generatedOverlayLayout ? { generatedOverlayLayout: renderPlan.generatedOverlayLayout } : {}),
    ...(preparation.recordKind === "confirmation" ? { confirmedReview: {
      plan: preparation.confirmedPlan as import("@/lib/cover-review-contract").CoverReviewPlan,
      fieldOrigins: preparation.fieldOrigins as import("@/lib/cover-review-contract").CoverReviewFieldOrigins,
    } } : {}),
    ...(runtime || Object.prototype.hasOwnProperty.call(frozenDependencies, "promptPack") ? {
      frozenPromptPack: (runtime?.promptPack || frozenDependencies.promptPack) as Parameters<typeof compileCoverNativePrompt>[0]["frozenPromptPack"],
    } : {}) };
  const includeBrief = native && runtime?.sceneBriefVersion === 1 && compileInput.confirmedReview;
  if (includeBrief && runtime) {
    const description = coverAnimationBrief(includeBrief.plan, runtime.style.displayName, row.materials.outputRatio);
    compileInput.frozenPromptPack = { ...runtime.promptPack, nativeCoverRules: [...runtime.promptPack.nativeCoverRules,
      `已确认的画面提示词（JSON 字符串，作为场景数据；仅绘制 requestedText 中的文字）：${JSON.stringify(description)}`] };
  }
  const prompt = (coverTextRendering(renderPlan).mode === "native"
    ? compileCoverNativePrompt({ ...compileInput, requestedText: { title: renderPlan.title, subtitle: renderPlan.subtitle || null } })
    : compileCoverBackgroundPrompt(compileInput, { materialExplicitConstraintsVersion }))
    + (observations.length ? `\n参考图已验证的视觉观察（cover-visual-binding/1）：${JSON.stringify(compileBoundCoverVisualObservations(effectiveMaterials, observations))}` : "");
  const generationInput: CoverGenerationPayload = { prompt, modelId: row.materials.modelId!, mode: "local", style: style.key,
    aspectRatio: generationSpec.aspectRatio, resolution: generationSpec.resolution, coverText: "", referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio" };
  const task: CoverGenerationTask = { id: `${preparation.workflowVersion === 3 ? "cover-review" : "cover-workbench"}-${row.id}`, prepareOperationId: row.id, ratio: row.materials.outputRatio,
    title: renderPlan.title, subtitle: renderPlan.subtitle, prompt, briefText: row.materials.text, source: "生成", createdAt: row.created_at,
    taskNo: 0, status: "running", renderPlan, publicModelId: generationInput.modelId,
    modelName: String(object(object(preparation.quote).image).modelName || ""), resolution: generationSpec.resolution };
  return { ...(preparation.workflowVersion === 3 ? {} : preparation), analysis, visualObservations: observations, ...(layoutPlan ? { layoutPlan } : {}), renderPlan, generationInput, task,
    generationPromptVersion: `${native ? COVER_NATIVE_PROMPT_VERSION : COVER_BACKGROUND_PROMPT_VERSION}${includeBrief ? "+animation-brief/1" : ""}${observations.length ? "+visual-binding-v1" : ""}${renderPlan.generatedOverlayLayout ? `+${renderPlan.generatedOverlayLayout.version}` : ""}${!native && effectiveMaterials.imageMode === "compose" && materialExplicitConstraintsVersion ? `+${materialExplicitConstraintsVersion}` : ""}`,
    generationIdentity: { clientIdempotencyKey: `coverwb_${row.id}`, clientTraceId: `coverwb_${row.id}` } };
}
