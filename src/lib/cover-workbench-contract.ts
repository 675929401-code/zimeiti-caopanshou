import { z } from "zod";
import { CoverMaterialUsageSchema, validateCoverMaterialUsage, CoverMaterialUsageError } from "./cover-material-usage";
import { COVER_OUTPUT_SPECS, type CoverOutputSpec } from "./cover-composition";
import { COVER_BENCHMARK_STYLE_PROFILES } from "./cover-benchmark-profiles";
import { hydrateCoverAnalysisEvidence, CoverSourceSpanError } from "./cover-source-spans";
import { coverNumbersAreGrounded, coverNumericClaims } from "./cover-number-evidence";
import { normalizeCoverNarrativeSummary } from "./cover-narrative-summary";
import { CoverMaterialImageModeSchema, CoverMaterialImageNumberSchema, resolveCoverMaterialBindings, CoverMaterialCompositionError } from "./cover-material-composition";
export { COVER_OUTPUT_SPECS, type CoverOutputSpec } from "./cover-composition";

export class CoverWorkbenchContractError extends Error {
  constructor(readonly code: string, message: string, readonly details?: { fieldPath?: string; evidenceId?: string }) { super(message); this.name = "CoverWorkbenchContractError"; }
}
const refuse = (code: string, message: string, details?: { fieldPath?: string; evidenceId?: string }): never => { throw new CoverWorkbenchContractError(code, message, details); };
const clean = (max: number) => z.string().max(max).refine(value => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value), "包含不支持的控制字符");
const nonempty = (max: number) => clean(max).refine(value => Boolean(value.trim()), "不能为空");
export const CoverRatioSchema = z.enum(["16:9", "9:16", "4:3", "3:4"]);
export type CoverRatio = z.infer<typeof CoverRatioSchema>;
export const CoverResolutionSchema = z.enum(["1K", "2K", "4K"]);
export type CoverResolution = z.infer<typeof CoverResolutionSchema>;
export const CoverAssetRoleSchema = z.enum(["style_reference", "identity_subject", "background_canvas"]);
const titleText = nonempty(80).refine(value => value.split(/\r?\n/u).length <= 3, "标题最多三行");
export const CoverPrepareInputSchema = z.object({
  schemaVersion: z.literal("cover-prepare/1").default("cover-prepare/1"),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u),
  materialRevision: z.number().int().positive().default(1),
  text: clean(20_000).default(""),
  // Absence retains the original script material/fingerprint representation.
  contentKind: z.enum(["script", "product"]).optional(),
  assets: z.array(z.object({ assetId: z.string().uuid(), role: CoverAssetRoleSchema, imageNumber: CoverMaterialImageNumberSchema.optional() }).strict()).max(3).default([]),
  imageMode: CoverMaterialImageModeSchema.optional(),
  styleKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).default("cartoon"),
  styleVersion: z.string().regex(/^\d+\.\d+\.\d+$/u).optional(),
  outputRatio: CoverRatioSchema.default("3:4"),
  modelId: z.string().regex(/^pm_[A-Za-z0-9_-]+$/u).optional(),
  resolution: CoverResolutionSchema.optional(),
  manualTitle: titleText.optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.text.trim() && !value.manualTitle && !value.assets.length) ctx.addIssue({ code: "custom", message: "请提供文案、标题或图片" });
  if (new Set(value.assets.map(asset => asset.assetId)).size !== value.assets.length) ctx.addIssue({ code: "custom", path: ["assets"], message: "同一资产不能重复绑定" });
  if (value.imageMode !== "compose" && value.assets.filter(asset => asset.role === "background_canvas").length > 1) ctx.addIssue({ code: "custom", path: ["assets"], message: "请明确选择一张需要完整保留的背景" });
});
export type CoverPrepareInput = z.infer<typeof CoverPrepareInputSchema>;
export function parseCoverPrepareInput(value: unknown): CoverPrepareInput {
  const parsed = CoverPrepareInputSchema.safeParse(value);
  if (!parsed.success) return refuse("COVER_INPUT_INVALID", parsed.error.issues.map(issue => issue.message).join("；"));
  if (parsed.data.manualTitle && parsed.data.manualTitle.split(/\r?\n/u).length > 2) {
    return refuse("COVER_TITLE_LINE_LIMIT", "封面标题最多使用两行，请先精简标题或调整换行；本次未调用模型");
  }
  try { resolveCoverMaterialBindings(parsed.data); }
  catch (error) { if (error instanceof CoverMaterialCompositionError) return refuse(error.code, error.message); throw error; }
  return parsed.data;
}

export type OwnedCoverAsset = { id: string; user_id: string; file_category?: string };
/** rows must come from authenticated server storage; this does not accept a client assertion of ownership. */
export function assertCoverOwnedAssets(input: CoverPrepareInput, userId: string, rows: readonly OwnedCoverAsset[]): void {
  if (!userId) refuse("COVER_ASSET_OWNER_REQUIRED", "缺少当前账号");
  for (const asset of input.assets) {
    const found = rows.filter(row => row.id === asset.assetId);
    if (found.length !== 1 || found[0].user_id !== userId || (found[0].file_category !== undefined && found[0].file_category !== "image")) {
      refuse("COVER_ASSET_NOT_OWNED", "图片不存在或不属于当前账号");
    }
  }
}
export type CoverMaterialRoute = "original_layout" | "subject_composite" | "reference_visual" | "new_visual";
export function resolveCoverMaterialRoute(input: CoverPrepareInput): CoverMaterialRoute {
  if (input.imageMode === "compose") return input.assets.some(asset => asset.role === "identity_subject") ? "subject_composite" : "reference_visual";
  if (input.assets.some(asset => asset.role === "background_canvas")) return "original_layout";
  if (input.assets.some(asset => asset.role === "identity_subject")) return "subject_composite";
  if (input.assets.some(asset => asset.role === "style_reference")) return "reference_visual";
  return "new_visual";
}

export function coverOutputSpec(ratio: CoverRatio): CoverOutputSpec {
  const parsed = CoverRatioSchema.parse(ratio), { width, height } = COVER_OUTPUT_SPECS[parsed];
  return { aspectRatio: parsed, width, height, format: "png" };
}
/** Check actual decoded source dimensions. Mapping permission never authorizes upscaling. */
export function assertCoverSourceCanDeliver(ratio: CoverRatio, sourceWidth: number, sourceHeight: number) {
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return refuse("COVER_SOURCE_DIMENSIONS_INVALID", "底图像素无效");
  const output = coverOutputSpec(ratio), target = output.width / output.height;
  const cropWidth = Math.floor(Math.min(sourceWidth, sourceHeight * target));
  const cropHeight = Math.floor(Math.min(sourceHeight, sourceWidth / target));
  if (cropWidth < output.width || cropHeight < output.height) return refuse("COVER_SOURCE_PIXELS_INSUFFICIENT", "底图不足以交付所选标准像素，请选择其他规格或另行处理图片");
  return { cropWidth, cropHeight, outputWidth: output.width, outputHeight: output.height, allowUpscale: false as const };
}

export const CoverStyleDefinitionSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u), version: z.string().regex(/^\d+\.\d+\.\d+$/u), displayName: nonempty(80),
  researchSources: z.array(z.object({ creator: nonempty(100), sampleCount: z.number().int().nonnegative() }).strict()).max(20),
  visualGrammar: z.array(nonempty(500)).max(20), palette: z.array(nonempty(80)).min(1).max(12),
  // Old frozen profiles remain readable; newly constructed styles use two.
  typography: z.object({ profile: nonempty(80), maxLines: z.union([z.literal(2), z.literal(3)]), respectExplicitLineBreaks: z.literal(true) }).strict(),
}).strict();
export type CoverStyleDefinition = z.infer<typeof CoverStyleDefinitionSchema>;
export const COVER_STYLE_REGISTRY: readonly CoverStyleDefinition[] = COVER_BENCHMARK_STYLE_PROFILES.map(style => CoverStyleDefinitionSchema.parse(style));
/** Internal material-driven profile; reference input never silently inherits an animation author. */
export const COVER_REFERENCE_STYLE_PROFILE: CoverStyleDefinition = {
  key: "reference-adaptive", version: "1.0.0", displayName: "参考图片风格", researchSources: [],
  visualGrammar: ["以真实参考图及已核验视觉观察决定画面风格、主体关系与构图", "学习配色和布局，不复制原图的标题、Logo、水印或无关主体", "依据新文案形成新画面，不套用固定动画角色"],
  palette: ["以参考图片的已观察配色为准"], typography: { profile: "reference_adaptive", maxLines: 2, respectExplicitLineBreaks: true },
};
export function resolveCoverStyle(key: string, version?: string, registry: readonly CoverStyleDefinition[] = COVER_STYLE_REGISTRY): CoverStyleDefinition {
  const parsed = registry.map(style => CoverStyleDefinitionSchema.parse(style));
  const matches = parsed.filter(style => style.key === key && (!version || style.version === version));
  if (!matches.length) return refuse("COVER_STYLE_UNAVAILABLE", "所选风格或版本不可用");
  if (new Set(parsed.map(style => `${style.key}@${style.version}`)).size !== parsed.length) return refuse("COVER_STYLE_REGISTRY_CONFLICT", "风格注册表存在重复版本");
  return matches.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
}

export const CoverModelDtoSchema = z.object({ id: z.string().regex(/^pm_[A-Za-z0-9_-]+$/u), displayName: nonempty(200), capabilities: z.record(z.string(), z.unknown()) }).passthrough();
export type CoverModelDto = z.infer<typeof CoverModelDtoSchema>;
/** Public catalog DTO only. No capability filtering, reconstruction or canary-based hiding. */
export function parseCoverModelCatalog(value: unknown): CoverModelDto[] { return z.array(CoverModelDtoSchema).parse(value); }
export const CoverVerifiedRatioFallbackSchema = z.object({
  modelId: z.string().regex(/^pm_[A-Za-z0-9_-]+$/u), outputRatio: CoverRatioSchema, generationRatio: CoverRatioSchema,
  resolution: CoverResolutionSchema, policyId: nonempty(100), evidence: nonempty(1000), allowUpscale: z.literal(false),
}).strict();
export type CoverVerifiedRatioFallback = z.infer<typeof CoverVerifiedRatioFallbackSchema>;
export const CoverGenerationSpecSchema = z.object({
  modelId: z.string().regex(/^pm_[A-Za-z0-9_-]+$/u), resolution: CoverResolutionSchema, aspectRatio: CoverRatioSchema, outputRatio: CoverRatioSchema,
  ratioEvidence: z.enum(["declared_native", "gateway_validation_required", "application_crop_mapping", "application_contain_mapping"]),
  crop: z.object({ strategy: z.literal("center_crop"), allowUpscale: z.literal(false), policyId: nonempty(100), evidence: nonempty(1000) }).strict().optional(),
}).strict();
export type CoverGenerationSpec = z.infer<typeof CoverGenerationSpecSchema>;
export type CoverGenerationResolution = { ready: true; generationSpec: CoverGenerationSpec; notices: string[] } | { ready: false; code: string; message: string };
export function resolveCoverGenerationSpec(input: CoverPrepareInput, rawModel: CoverModelDto, verifiedFallbacks: readonly CoverVerifiedRatioFallback[] = []): CoverGenerationResolution {
  const model = CoverModelDtoSchema.parse(rawModel), cap = model.capabilities;
  const blocked = (code: string, message: string): CoverGenerationResolution => ({ ready: false, code, message });
  if (resolveCoverMaterialRoute(input) === "original_layout") return blocked("COVER_GENERATION_NOT_REQUIRED", "原图排版不使用生图模型");
  if (input.modelId && input.modelId !== model.id) return blocked("COVER_MODEL_SELECTION_MISMATCH", "模型与当前选择不一致，请确认后提交");
  if (cap.available !== true || cap.generationReady !== true || cap.protocolBindingReady !== true || cap.priceReady !== true) return blocked("COVER_MODEL_NOT_READY", "当前模型暂不能提交，请查看配置或费用状态");
  const resolution = CoverResolutionSchema.safeParse(input.resolution ?? cap.defaultResolution);
  if (!resolution.success) return blocked("COVER_RESOLUTION_UNKNOWN", "当前模型未明确可用分辨率");
  const options = Array.isArray(cap.resolutionOptions) ? cap.resolutionOptions : [];
  if (options.length && !options.includes(resolution.data)) return blocked("COVER_RESOLUTION_UNSUPPORTED", "所选模型不支持当前分辨率");
  const references = input.assets.filter(asset => asset.role === "style_reference").length;
  if (references && cap.supportsReferenceInput !== true) return blocked("COVER_REFERENCE_UNSUPPORTED", "当前模型不支持参考图片，请显式调整模型或图片用途");
  if (typeof cap.minReferenceImages === "number" && references < cap.minReferenceImages) return blocked("COVER_REFERENCE_REQUIRED", "当前模型需要参考图片");
  if (typeof cap.maxReferenceImages === "number" && references > cap.maxReferenceImages) return blocked("COVER_REFERENCE_LIMIT", "参考图片数量超过所选模型限制");
  const native = Array.isArray(cap.aspectRatios) ? cap.aspectRatios.filter((ratio): ratio is string => typeof ratio === "string") : [];
  const base = { modelId: model.id, resolution: resolution.data, outputRatio: input.outputRatio };
  if (!native.length) return { ready: true, generationSpec: { ...base, aspectRatio: input.outputRatio, ratioEvidence: "gateway_validation_required" }, notices: ["目录未明确原生比例，将按所选比例提交并由生图网关校验实际结果；不代表该原生比例已验证"] };
  if (native.includes(input.outputRatio)) return { ready: true, generationSpec: { ...base, aspectRatio: input.outputRatio, ratioEvidence: "declared_native" }, notices: [] };
  const matches = verifiedFallbacks.map(item => CoverVerifiedRatioFallbackSchema.parse(item)).filter(item => item.modelId === model.id && item.outputRatio === input.outputRatio && item.resolution === resolution.data && native.includes(item.generationRatio));
  if (matches.length !== 1) return blocked("COVER_RATIO_MAPPING_REQUIRED", "当前比例需要明确的应用裁切映射，请确认可行规格");
  const mapping = matches[0];
  return { ready: true, generationSpec: { ...base, aspectRatio: mapping.generationRatio, ratioEvidence: "application_crop_mapping",
    crop: { strategy: "center_crop", allowUpscale: false, policyId: mapping.policyId, evidence: mapping.evidence } },
    notices: [`先按 ${mapping.generationRatio} 生成底图，再裁切为 ${input.outputRatio}；实际底图不足标准像素时停止交付，不自动放大`] };
}

const RegionSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine(region => region.x + region.width <= 1 + 1e-12 && region.y + region.height <= 1 + 1e-12, "区域超出画布");
export const CoverVisualObservationSchema = z.object({
  schemaVersion: z.literal("cover-visual-analysis/1"), assetId: z.string().uuid(), assetRevision: z.number().int().positive(),
  status: z.enum(["ready", "partial", "capability_unavailable"]),
  observations: z.array(z.object({ id: nonempty(100), kind: z.enum(["subject", "title_zone", "negative_space", "background", "color", "other"]), description: nonempty(1000), region: RegionSchema.nullable() }).strict()).max(60),
  ocr: z.array(z.object({ id: nonempty(100), text: clean(2000), readability: z.enum(["readable", "partial", "unreadable"]), region: RegionSchema }).strict()).max(50),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/u)).max(8), uncertainties: z.array(nonempty(500)).max(20),
}).strict().superRefine((value, ctx) => {
  const ids = [...value.observations, ...value.ocr].map(item => item.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "观察和OCR标识必须唯一" });
  for (const item of value.ocr) if ((item.readability === "unreadable") !== !item.text.trim()) ctx.addIssue({ code: "custom", path: ["ocr"], message: "不可读OCR必须为空，可读OCR必须有实际文字" });
  if (value.status === "capability_unavailable" && (value.observations.length || value.ocr.length || value.palette.length || !value.uncertainties.length)) ctx.addIssue({ code: "custom", message: "能力不可用时不得伪造观察" });
  if (value.status === "ready" && !value.observations.length && !value.ocr.length && !value.palette.length) ctx.addIssue({ code: "custom", message: "就绪观察不能全空" });
});
export type CoverVisualObservation = z.infer<typeof CoverVisualObservationSchema>;
const analysisFields = ["topic", "primaryTitle", "secondaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"] as const;
const evidenceBase = { id: nonempty(100), quote: nonempty(2000), fields: z.array(z.enum(analysisFields)).min(1).max(7) };
const EvidenceSchema = z.discriminatedUnion("source", [
  z.object({ ...evidenceBase, source: z.literal("text") }).strict(),
  z.object({ ...evidenceBase, source: z.literal("manual_title") }).strict(),
  z.object({ ...evidenceBase, source: z.literal("visual_observation"), assetId: z.string().uuid(), observationId: nonempty(100) }).strict(),
]);
export const CoverLayoutIntentSchema = z.object({
  structure: z.enum(["single", "relationship", "comparison", "list"]),
  focus: z.enum(["expression", "action", "object"]),
  evidenceRefs: z.array(nonempty(100)).min(1).max(20),
}).strict();
export type CoverLayoutIntent = z.infer<typeof CoverLayoutIntentSchema>;
const GroundedCoverConclusionSchema = z.object({
  text: nonempty(600), evidenceRefs: z.array(nonempty(100)).min(1).max(20),
}).strict();
export const CoverContentBreakdownSchema = z.object({
  summary: GroundedCoverConclusionSchema,
  keyPoints: z.array(GroundedCoverConclusionSchema).min(1).max(4),
  logic: GroundedCoverConclusionSchema,
  coverFocus: GroundedCoverConclusionSchema,
}).strict();
export const CoverContentAnalysisSchema = z.object({
  schemaVersion: z.literal("cover-content-analysis/1"), status: z.enum(["ready", "needs_input"]),
  topic: clean(500), primaryTitle: clean(80).refine(value => value.split(/\r?\n/u).length <= 3, "标题最多三行"), secondaryTitle: nonempty(120).nullable(),
  visualBrief: z.object({ subject: clean(500), action: clean(500), scene: clean(500), emotion: clean(300) }).strict(),
  titleCandidates: z.array(z.object({ id: nonempty(100), text: titleText, evidenceRefs: z.array(nonempty(100)).min(1).max(20) }).strict()).max(3),
  evidence: z.array(EvidenceSchema).max(100), missingInformation: z.array(nonempty(500)).max(1),
  // Old canonical paid replies remain valid and must be labelled as fallback
  // by the layout planner, rather than pretending new semantic inference.
  layoutIntent: CoverLayoutIntentSchema.optional(),
  // Optional only for already-paid historical replies. New analyses request
  // these public content conclusions, not the model's private reasoning.
  contentBreakdown: CoverContentBreakdownSchema.optional(),
  /** Historical paid replies may lack semantic image-role conclusions. */
  materialUsage: CoverMaterialUsageSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "ready" && (!value.topic.trim() || !value.primaryTitle.trim() || !value.titleCandidates.length || !value.visualBrief.subject.trim() || value.missingInformation.length)) ctx.addIssue({ code: "custom", message: "就绪计划缺少主题、标题或画面主体" });
  if (value.status === "needs_input" && value.missingInformation.length !== 1) ctx.addIssue({ code: "custom", message: "材料不足时需要一个明确问题" });
});
export type CoverContentAnalysis = z.infer<typeof CoverContentAnalysisSchema>;
const commercialMarkers = ["全网最低", "医用级", "根治", "包治", "永久有效", "绝对安全", "零风险", "稳赚", "保证销量", "销量第一"];
const sceneArticleUnits = "个|只|位|名|杯|张|台|盏|本|把|辆|棵|朵|幅|扇|座|间|条|件";
const countUnits = `${sceneArticleUnits}|款|瓶|包|箱|套|盒|袋|桶|罐|份`;
const countNumber = "[+\\-−负正]?(?:[0-9０-９]+(?:,[0-9]{3})*(?:\\.[0-9]+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?)";
function explicitEntityCounts(text: string) {
  return [...text.matchAll(new RegExp(`(${countNumber})\\s*(${countUnits})`, "gu"))].map(match => {
    const prefix = text.slice(Math.max(0, match.index - 24), match.index);
    return { value: coverNumericClaims(`${match[1]}个`)[0]?.value ?? match[1], unit: match[2],
      excludesThisCount: /(?:没有|没|无|并非|不是|非|不到|不足|不满|少于|低于|超过|多于|大于)(?:任何|哪怕)?\s*$/u.test(prefix) };
  });
}
export function prepareCoverContentAnalysisEvidence(value: unknown, materials: CoverPrepareInput, visualObservations: readonly CoverVisualObservation[] = []) {
  try {
    const prepared = hydrateCoverAnalysisEvidence(value, materials, visualObservations);
    const normalized = normalizeCoverNarrativeSummary(prepared.value, materials);
    return { ...prepared, value: normalized.value, sourceAudit: { ...prepared.sourceAudit,
      ...(normalized.normalization ? { narrativeSummaryNormalization: normalized.normalization } : {}) } };
  }
  catch (error) {
    if (error instanceof CoverSourceSpanError) return refuse(error.code, error.message, { fieldPath: error.fieldPath, evidenceId: error.evidenceId });
    throw error;
  }
}
/** Provenance checks are deterministic safeguards, not a substitute for semantic model/quality evaluation. */
export function parseCoverContentAnalysis(value: unknown, materials: CoverPrepareInput, visualObservations: readonly CoverVisualObservation[] = []): CoverContentAnalysis {
  let raw = value;
  if (typeof raw === "string") {
    if (raw.length > 256_000) return refuse("ANALYSIS_SCHEMA_INVALID", "分析响应过大");
    try { raw = JSON.parse(raw); } catch { return refuse("ANALYSIS_SCHEMA_INVALID", "分析响应必须为完整JSON对象"); }
  }
  raw = prepareCoverContentAnalysisEvidence(raw, materials, visualObservations).value;
  // Some paid structured replies encode the inapplicable image-role field as
  // null. Only a request with no images can omit it; image requests still need
  // the original strict validation and must never gain invented role evidence.
  if (materials.assets.length === 0 && raw && typeof raw === "object" && !Array.isArray(raw)
      && "materialUsage" in raw && raw.materialUsage === null) {
    const { materialUsage: _inapplicable, ...withoutImageUsage } = raw;
    void _inapplicable;
    raw = withoutImageUsage;
  }
  const parsed = CoverContentAnalysisSchema.safeParse(raw);
  if (!parsed.success) return refuse("ANALYSIS_SCHEMA_INVALID", "分析响应不符合封面结构合同", { fieldPath: parsed.error.issues[0]?.path.map(String).join(".") });
  const result = parsed.data, visuals = visualObservations.map(item => CoverVisualObservationSchema.parse(item));
  if (new Set(result.evidence.map(item => item.id)).size !== result.evidence.length || new Set(result.titleCandidates.map(item => item.id)).size !== result.titleCandidates.length) refuse("ANALYSIS_EVIDENCE_INVALID", "依据和候选标识必须唯一");
  if (new Set(visuals.map(item => item.assetId)).size !== visuals.length || visuals.some(item => !materials.assets.some(asset => asset.assetId === item.assetId))) refuse("ANALYSIS_EVIDENCE_INVALID", "视觉观察不属于本次材料");
  if (result.status === "ready" && resolveCoverMaterialRoute(materials) !== "original_layout" && materials.assets.some(asset => !visuals.some(item => item.assetId === asset.assetId && item.status !== "capability_unavailable" && (item.observations.length || item.ocr.length || item.palette.length)))) refuse("COVER_VISUAL_OBSERVATION_REQUIRED", "尚无有效图片观察，不能声称已理解参考或主体");
  if (materials.manualTitle && result.primaryTitle !== materials.manualTitle) refuse("ANALYSIS_LOCKED_TITLE_CHANGED", "分析不得改写用户锁定标题");
  for (const [index, evidence] of result.evidence.entries()) {
    if (new Set(evidence.fields).size !== evidence.fields.length) refuse("ANALYSIS_EVIDENCE_INVALID", "依据字段不能重复");
    let source = evidence.source === "text" ? materials.text : evidence.source === "manual_title" ? materials.manualTitle || "" : "";
    if (evidence.source === "visual_observation") {
      const visual = visuals.find(item => item.assetId === evidence.assetId && item.status !== "capability_unavailable");
      source = visual?.observations.find(item => item.id === evidence.observationId)?.description || visual?.ocr.find(item => item.id === evidence.observationId && item.readability !== "unreadable")?.text || "";
    }
    if (!source.includes(evidence.quote)) refuse("ANALYSIS_EVIDENCE_INVALID", "依据引文不在对应原始材料或有效观察中", { fieldPath: `evidence.${index}.quote`, evidenceId: evidence.id });
  }
  if (result.materialUsage) {
    try { validateCoverMaterialUsage(result.materialUsage, materials, result.evidence); }
    catch (error) { if (error instanceof CoverMaterialUsageError) return refuse(error.code, error.message, { fieldPath: "materialUsage" }); throw error; }
  }
  const check = (text: string, quoted: string, fieldPath: string) => {
    let factText = text;
    try {
      // These offsets come from the original owned material-number bindings,
      // not from an arbitrary regexp removing digits or picture-like words.
      const references = resolveCoverMaterialBindings({ ...materials, text }).references;
      const titleField = fieldPath === "primaryTitle" || fieldPath === "secondaryTitle" || fieldPath.startsWith("titleCandidates.");
      const lockedTitle = fieldPath !== "secondaryTitle" && materials.manualTitle !== undefined && text === materials.manualTitle;
      if (references.length && titleField && !lockedTitle) {
        refuse("ANALYSIS_IMAGE_REFERENCE_IN_TITLE", "自动封面标题不能包含图片绑定编号，请仅将编号用于画面关联", { fieldPath });
      }
      for (const reference of references.slice().reverse()) factText = factText.slice(0, reference.start) + factText.slice(reference.end);
    } catch (error) {
      if (error instanceof CoverMaterialCompositionError) return refuse(error.code, error.message, { fieldPath });
      throw error;
    }
    const sourceCounts = explicitEntityCounts(quoted);
    // A depicted singular object is not a package/bonus quantity. Explicit
    // allocation, contents, packaging and numeric assertions remain intact.
    const numericText = fieldPath.startsWith("visualBrief.")
      ? factText.replace(new RegExp(`(?<![零〇一二两三四五六七八九十百千万亿\\d])一(${sceneArticleUnits})(?=[\\p{Script=Han}A-Za-z0-9])`, "gu"), (match: string, unit: string, offset: number) => {
        const prefix = factText.slice(Math.max(0, offset - 24), offset);
        const suffix = factText.slice(offset + match.length, offset + match.length + 12);
        if (/唯一|仅有|只有|总共|共计|各有|至多|至少|不足|超过|少于|多于|第$|没|无|不|非|每(?:人|盒|包|袋|套|箱|份|件|只|个)|内含|包含|含有|装有|赠送|附赠|附送|加赠|买赠|标配|配有|数量|装数|购买即送|买一送/u.test(prefix)
          || /^(?:装|赠品|套装|组合)/u.test(suffix)) return match;
        if (sourceCounts.some(count => count.unit === unit && (count.value !== "1" || count.excludesThisCount))) {
          return refuse("ANALYSIS_UNGROUNDED_CLAIM", "创意画面的单个示意不能改动引用中的明确数量", { fieldPath });
        }
        if (materials.contentKind === "product" && /^(?:个|只|件)$/u.test(unit)
          && sourceCounts.some(count => /^(?:个|只|件|款)$/u.test(count.unit) && (count.value !== "1" || count.excludesThisCount))) return match;
        return "";
      }) : factText;
    const changedCount = explicitEntityCounts(numericText).some(count => !sourceCounts.some(source => source.unit === count.unit && source.value === count.value));
    if (changedCount || !coverNumbersAreGrounded(numericText, quoted) || commercialMarkers.some(marker => text.includes(marker) && !quoted.includes(marker))) {
      refuse("ANALYSIS_UNGROUNDED_CLAIM", "分析增加了没有引用依据的数字、单位或商业承诺", { fieldPath });
    }
  };
  for (const field of analysisFields) {
    const text = field.startsWith("visualBrief.") ? result.visualBrief[field.slice(12) as keyof CoverContentAnalysis["visualBrief"]] : result[field as "topic" | "primaryTitle" | "secondaryTitle"];
    if (!text?.trim()) continue;
    const evidence = result.evidence.filter(item => item.fields.some(reference => reference === field));
    if (!evidence.length) refuse("ANALYSIS_EVIDENCE_INVALID", "每个非空分析字段都必须绑定原始依据", { fieldPath: field });
    check(text, evidence.map(item => item.quote).join("\n"), field);
  }
  for (const [index, candidate] of result.titleCandidates.entries()) {
    if (new Set(candidate.evidenceRefs).size !== candidate.evidenceRefs.length) refuse("ANALYSIS_EVIDENCE_INVALID", "候选依据不能重复");
    const evidence = candidate.evidenceRefs.map(id => result.evidence.find(item => item.id === id));
    if (evidence.some(item => !item)) refuse("ANALYSIS_EVIDENCE_INVALID", "标题候选引用了不存在的依据");
    check(candidate.text, evidence.map(item => item!.quote).join("\n"), `titleCandidates.${index}.text`);
  }
  if (result.layoutIntent && (new Set(result.layoutIntent.evidenceRefs).size !== result.layoutIntent.evidenceRefs.length
    || result.layoutIntent.evidenceRefs.some(id => !result.evidence.some(item => item.id === id)))) {
    refuse("ANALYSIS_EVIDENCE_INVALID", "语义版式必须引用已存在且不重复的原始依据", { fieldPath: "layoutIntent.evidenceRefs" });
  }
  if (result.contentBreakdown) {
    const conclusions = [
      ["summary", result.contentBreakdown.summary],
      ...result.contentBreakdown.keyPoints.map((point, index) => [`keyPoints.${index}`, point] as const),
      ["logic", result.contentBreakdown.logic], ["coverFocus", result.contentBreakdown.coverFocus],
    ] as const;
    for (const [field, conclusion] of conclusions) {
      const evidence = conclusion.evidenceRefs.map(id => result.evidence.find(item => item.id === id));
      const fieldPath = `contentBreakdown.${field}`;
      if (new Set(conclusion.evidenceRefs).size !== conclusion.evidenceRefs.length || evidence.some(item => !item)) {
        refuse("ANALYSIS_EVIDENCE_INVALID", "文案拆解必须引用已存在且不重复的原始依据", { fieldPath });
      }
      check(conclusion.text, evidence.map(item => item!.quote).join("\n"), fieldPath);
    }
  }
  if (result.status === "ready" && !result.titleCandidates.some(item => item.text === result.primaryTitle)) refuse("ANALYSIS_EVIDENCE_INVALID", "主标题必须存在于当前候选中");
  return result;
}
