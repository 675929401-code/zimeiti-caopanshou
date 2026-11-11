import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { buildMangaAgentModelCatalog } from "../manga-agent-model-policy";
import { publicModelDisplayName, toPublicModelId } from "../public-model-dto";
import { isTextModelEligible } from "../text-model-eligibility";
import { isImageParsingEnabled } from "../llm-input-capability";
import { COVER_ANALYSIS_PROMPT_VERSION } from "../cover-workbench-prompts";
import { CoverStyleDraftInputSchema, CoverWorkflowDraftInputSchema, CoverStyleStoreError, coverStyleHash, coverStyleReleaseHash,
  coverWorkflowReleaseHash, runtimeCoverStyle, type CoverStyleCatalog, type CoverWorkflowDraftInput, type CoverWorkflowRelease } from "./cover-style-config";
import { compileCoverAdminPreview, coverAdminPreviewMaterials, type CoverAdminPreviewMode } from "./cover-workflow-publication";
import { createDefaultCoverWorkflowRelease } from "./cover-style-defaults";

export type CoverAnalysisModelOption = { id: string; displayName: string; imageParsing: boolean; available: boolean; reason?: string };
export type CoverAdminPreviewInput = { mode: CoverAdminPreviewMode; styleKey?: string; releaseId?: string;
  workflowReleaseId?: string; text?: string; workflowDraft?: CoverWorkflowDraftInput; styleDraft?: z.infer<typeof CoverStyleDraftInputSchema> };
export type CoverAdminRuntimePreview = { systemPrompt: string; userMessage: string; mode: CoverAdminPreviewMode;
  model: { id: string | null; displayName: string; source: "automatic" | "configured"; available: boolean; reason?: string };
  styleApplied: boolean; readonlyProtocolVersion: string; textUnits: number; syntheticImages: boolean };
export type CoverAnalysisModelSelection = { internalId: string; id: string; displayName: string; imageParsing: boolean;
  maxContextTokens: number; maxReplyTokens: number; fingerprint: string };
type ModelRow = Record<string, unknown>;
const MODEL_FIELDS = "id,name,model_name,description,category,icon_url,deep_thinking_type,enable_web_search,image_parsing,file_parsing,is_active,is_hidden,sort_order,user_access,token_billing_enabled,input_cost_per_million,output_cost_per_million,cached_cost_per_million,profit_margin,token_rounding_unit,max_context_tokens,max_reply_tokens";
const previewSchema = z.object({ mode: z.enum(["script", "product", "reference", "compose"]),
  styleKey: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).optional(), releaseId: z.string().min(1).max(120).optional(),
  workflowReleaseId: z.string().min(1).max(120).optional(), text: z.string().max(20_000).optional(),
  workflowDraft: CoverWorkflowDraftInputSchema.optional(), styleDraft: CoverStyleDraftInputSchema.optional() }).strict();

async function readModelRows(db: SupabaseClient): Promise<ModelRow[]> {
  const response = await db.from("llm_models").select(MODEL_FIELDS).order("sort_order", { ascending: true });
  if (response.error) throw new CoverStyleStoreError("COVER_ANALYSIS_MODEL_UNAVAILABLE", "暂时无法读取分析模型目录", 503);
  return response.data || [];
}

/** The same published/visible/priced pool backs admin preview and real prepare. */
export function selectCoverAnalysisModel(rows: ModelRow[], workflow: CoverWorkflowDraftInput, needsVision: boolean): CoverAnalysisModelSelection {
  const catalog = buildMangaAgentModelCatalog(rows);
  const configured = needsVision ? workflow.imageModelId : workflow.textModelId;
  const candidate = configured === null
    ? catalog.models.find(model => !needsVision || rows.some(row => toPublicModelId("chat", String(row.id)) === model.id && isImageParsingEnabled(row.image_parsing)))
    : catalog.models.find(model => model.id === toPublicModelId("chat", configured));
  const row = candidate ? rows.find(value => toPublicModelId("chat", String(value.id)) === candidate.id) : undefined;
  if (!candidate || !row || needsVision && !isImageParsingEnabled(row.image_parsing)) {
    throw new CoverStyleStoreError(configured !== null ? "COVER_ANALYSIS_CONFIGURED_MODEL_UNAVAILABLE" : needsVision ? "COVER_VISION_MODEL_UNAVAILABLE" : "COVER_ANALYSIS_MODEL_UNAVAILABLE",
      configured !== null ? "所配置的分析模型未发布、计费未就绪或不支持当前材料，请管理员核对配置" : needsVision ? "当前没有可用的图片解析分析模型" : "当前没有可用的文案分析模型", 422);
  }
  const modelLimit = (value: unknown) => value === null || value === undefined ? 0 : Number(value);
  const identity = { internalId: String(row.id), modelName: String(row.model_name), imageParsing: isImageParsingEnabled(row.image_parsing),
    maxContextTokens: modelLimit(row.max_context_tokens), maxReplyTokens: modelLimit(row.max_reply_tokens) };
  if (![identity.maxContextTokens, identity.maxReplyTokens].every(value => Number.isSafeInteger(value) && value >= 0))
    throw new CoverStyleStoreError("COVER_ANALYSIS_MODEL_LIMIT_INVALID", "分析模型上下文配置无效，请管理员核对", 422);
  return { internalId: identity.internalId, id: candidate.id, displayName: candidate.displayName, imageParsing: identity.imageParsing,
    maxContextTokens: identity.maxContextTokens, maxReplyTokens: identity.maxReplyTokens, fingerprint: coverStyleHash(identity) };
}

export async function resolveCoverAnalysisModel(workflow: CoverWorkflowDraftInput, needsVision: boolean, db: SupabaseClient = getSupabaseClient()) {
  return selectCoverAnalysisModel(await readModelRows(db), workflow, needsVision);
}

export async function readCoverAnalysisModelOptions(db: SupabaseClient = getSupabaseClient()): Promise<CoverAnalysisModelOption[]> {
  const rows = await readModelRows(db);
  return rows.filter(row => isTextModelEligible(row)).map(row => {
    const candidate = buildMangaAgentModelCatalog([row]).models[0];
    return { id: String(row.id), displayName: candidate?.displayName || publicModelDisplayName(row),
      imageParsing: isImageParsingEnabled(row.image_parsing), available: Boolean(candidate),
      ...(!candidate ? { reason: "模型未发布、已隐藏或计费配置未就绪" } : {}) };
  });
}

export async function validateCoverWorkflowModels(input: CoverWorkflowDraftInput, db: SupabaseClient = getSupabaseClient(), catalog?: CoverStyleCatalog): Promise<void> {
  const parsed = CoverWorkflowDraftInputSchema.safeParse({ sharedRules: input.sharedRules, textModelId: input.textModelId, imageModelId: input.imageModelId });
  if (!parsed.success) throw new CoverStyleStoreError("COVER_WORKFLOW_INPUT_INVALID", "共用拆解规则或模型选择无效", 422);
  const rows = input.textModelId === null && input.imageModelId === null ? [] : await readModelRows(db);
  const text = input.textModelId !== null ? selectCoverAnalysisModel(rows, input, false) : undefined;
  const image = input.imageModelId !== null ? selectCoverAnalysisModel(rows, input, true) : undefined;
  const payload = { ...createDefaultCoverWorkflowRelease(), ...parsed.data };
  const workflow = { ...payload, snapshotSha256: coverWorkflowReleaseHash(payload) };
  for (const mode of ["product", "reference", "compose"] as const)
    compileCoverAdminPreview(coverAdminPreviewMaterials(mode), workflow, undefined, mode === "product" ? text : image);
  for (const entry of catalog?.entries.filter(item => item.enabled && item.current) ?? []) {
    const release = entry.releases.find(item => item.releaseId === entry.current!.releaseId);
    if (release) compileCoverAdminPreview(coverAdminPreviewMaterials("script", entry.styleKey), workflow,
      runtimeCoverStyle(release, entry.current!.publishedAt), text);
  }
}

export async function previewCoverAnalysisRuntime(raw: unknown, db: SupabaseClient = getSupabaseClient()): Promise<CoverAdminRuntimePreview> {
  const parsed = previewSchema.safeParse(raw);
  if (!parsed.success) throw new CoverStyleStoreError("COVER_PREVIEW_INPUT_INVALID", "预览材料或规则格式无效", 422);
  const input = parsed.data;
  // Lazy lookup avoids a store -> publication guard -> store dependency cycle.
  const { loadCoverStyleCatalog, publishedCoverWorkflow } = await import("./cover-style-store");
  const { catalog } = await loadCoverStyleCatalog(db);
  const active = publishedCoverWorkflow(catalog);
  let workflow: CoverWorkflowRelease = input.workflowReleaseId
    ? catalog.workflow?.releases.find(release => release.releaseId === input.workflowReleaseId) ?? (active.releaseId === input.workflowReleaseId ? active : undefined) as CoverWorkflowRelease
    : active;
  if (!workflow) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "预览的共用规则版本不存在", 404);
  if (input.workflowDraft) {
    const payload = { ...workflow, ...input.workflowDraft, releaseId: "preview:workflow" };
    workflow = { ...payload, snapshotSha256: coverWorkflowReleaseHash(payload) };
  }
  const styleKey = input.styleKey ?? catalog.entries.find(entry => entry.enabled && entry.current)?.styleKey ?? "cartoon";
  const entry = catalog.entries.find(item => item.styleKey === styleKey);
  if (input.mode === "script" && !input.styleDraft && !input.releaseId && (!entry?.enabled || !entry.current))
    throw new CoverStyleStoreError("COVER_STYLE_UNAVAILABLE", "该风格尚未发布或已停用，请选择当前可用风格", 409);
  const chosen = entry?.releases.find(release => release.releaseId === (input.releaseId ?? entry.current?.releaseId));
  if (input.releaseId && !chosen) throw new CoverStyleStoreError("COVER_STYLE_RELEASE_INVALID", "预览的风格版本不存在", 404);
  let styleRelease = chosen;
  if (input.styleDraft) {
    const payload = { ...input.styleDraft, styleKey, releaseId: "preview:style", version: chosen?.version ?? "1.0.0", sequence: chosen?.sequence ?? 1,
      createdAt: chosen?.createdAt ?? "2026-11-06T00:00:00.000Z", createdBy: "preview" };
    styleRelease = { ...payload, snapshotSha256: coverStyleReleaseHash(payload) };
  }
  const styleApplied = input.mode === "script";
  if (styleApplied && !styleRelease) throw new CoverStyleStoreError("COVER_STYLE_UNAVAILABLE", "请选择已发布风格或提供待预览风格", 409);
  const runtime = styleApplied && styleRelease ? runtimeCoverStyle(styleRelease, entry?.current?.publishedAt ?? styleRelease.createdAt) : undefined;
  const materials = coverAdminPreviewMaterials(input.mode, styleKey, input.text);
  let selected: CoverAnalysisModelSelection | undefined, reason: string | undefined;
  try { selected = await resolveCoverAnalysisModel(workflow, materials.assets.length > 0, db); }
  catch (error) { if (!(error instanceof CoverStyleStoreError)) throw error; reason = error.message; }
  const compiled = compileCoverAdminPreview(materials, workflow, runtime, selected);
  const configured = materials.assets.length ? workflow.imageModelId : workflow.textModelId;
  return { mode: input.mode, systemPrompt: compiled.template.systemPrompt, userMessage: compiled.template.userMessage,
    model: { id: selected?.internalId ?? configured, displayName: selected?.displayName ?? "分析模型暂不可用", source: configured === null ? "automatic" : "configured",
      available: Boolean(selected), ...(reason ? { reason } : {}) }, styleApplied, readonlyProtocolVersion: COVER_ANALYSIS_PROMPT_VERSION,
    textUnits: compiled.textUnits, syntheticImages: materials.assets.length > 0 };
}
