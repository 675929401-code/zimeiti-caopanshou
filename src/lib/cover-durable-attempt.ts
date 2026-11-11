import { coverCompositionValidationError, type CoverCompositionPlan } from "@/lib/cover-composition";

export const COVER_ATTEMPT_SURFACE = "cover-studio" as const;
export const COVER_ATTEMPT_ACTIVE_STATES = ["claimed", "dispatched", "delivery_pending"] as const;
export type CoverAttemptState = typeof COVER_ATTEMPT_ACTIVE_STATES[number] | "completed" | "failed" | "cancelled";

export type CoverAttemptTaskSnapshot = {
  prepareOperationId?: string;
  id: string;
  ratio: "16:9" | "9:16" | "4:3" | "3:4";
  title: string;
  subtitle: string;
  prompt: string;
  briefText?: string;
  source: "生成";
  createdAt: string;
  taskNo: number;
  renderPlan: CoverCompositionPlan;
};

export type CoverAttemptGenerationInput = {
  prompt: string;
  modelId: string;
  mode: "local";
  style: string;
  aspectRatio: "16:9" | "9:16" | "4:3" | "3:4";
  resolution: "1K" | "2K" | "4K";
  coverText: string;
  referenceImageUrls: [];
  referenceUsage: "general";
  historySurface: "cover-studio";
};

export type CoverAttemptRow = {
  id: string;
  user_id: string;
  surface: "cover-studio";
  client_idempotency_key: string;
  client_trace_id: string;
  state: CoverAttemptState;
  task: CoverAttemptTaskSnapshot;
  generation_input: CoverAttemptGenerationInput;
  requires_reference_reupload: boolean;
  background_asset_id?: string | null;
  result_asset_id?: string | null;
  history_record_id?: string | null;
  error_code?: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at?: string | null;
  completed_at?: string | null;
  cancelled_at?: string | null;
};

const KEY = /^[A-Za-z0-9_-]{8,128}$/u;
const RATIOS = ["16:9", "9:16", "4:3", "3:4"] as const;
const RESOLUTIONS = ["1K", "2K", "4K"] as const;
const unsafeReference = /data:[^,\s]*;base64,|(?:^|["'\s])blob:https?:\/\//iu;

export function projectCoverCompositionPlan(plan: CoverCompositionPlan): CoverCompositionPlan {
  return { title: plan.title, subtitle: plan.subtitle, aspectRatio: plan.aspectRatio,
    layoutTemplateId: plan.layoutTemplateId, animationStyleId: plan.animationStyleId,
    ...(plan.coverModeId ? { coverModeId: plan.coverModeId } : {}),
    ...(plan.materialSourceId ? { materialSourceId: plan.materialSourceId } : {}),
    ...(plan.subjectModeId ? { subjectModeId: plan.subjectModeId } : {}),
    ...(plan.planVersion === 2 ? { planVersion: 2 as const } : {}),
    ...(plan.outputSpec ? { outputSpec: { aspectRatio: plan.outputSpec.aspectRatio, width: plan.outputSpec.width,
      height: plan.outputSpec.height, format: plan.outputSpec.format, ...(plan.outputSpec.fit ? { fit: plan.outputSpec.fit } : {}) } } : {}),
    ...(plan.titleStyle ? { titleStyle: { x: plan.titleStyle.x, y: plan.titleStyle.y, width: plan.titleStyle.width,
      scale: plan.titleStyle.scale, color: plan.titleStyle.color, colorMode: plan.titleStyle.colorMode } } : {}),
    ...(plan.textRendering ? { textRendering: { mode: plan.textRendering.mode, version: plan.textRendering.version } } : {}),
    ...(plan.originalLayout ? { originalLayout: { version: plan.originalLayout.version, sourceWidth: plan.originalLayout.sourceWidth,
      sourceHeight: plan.originalLayout.sourceHeight, structure: plan.originalLayout.structure, focus: plan.originalLayout.focus } } : {}),
    ...(plan.generatedOverlayLayout ? { generatedOverlayLayout: { version: plan.generatedOverlayLayout.version, placement: plan.generatedOverlayLayout.placement,
      canvasColor: plan.generatedOverlayLayout.canvasColor } } : {}), };
}

function stringValue(value: unknown, maximum: number, required = true) {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()) || /[\x00-\x08\x0b-\x1f]/u.test(value)) return null;
  if (unsafeReference.test(value)) return null;
  return value;
}

function generationInput(value: unknown): CoverAttemptGenerationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const prompt = stringValue(row.prompt, 50_000);
  const modelId = stringValue(row.modelId, 240);
  const style = stringValue(row.style, 2_000, false);
  const coverText = stringValue(row.coverText, 200, false);
  if (!prompt || !modelId?.startsWith("pm_") || style === null || coverText === null
    || row.mode !== "local" || !RATIOS.includes(row.aspectRatio as typeof RATIOS[number])
    || !RESOLUTIONS.includes(row.resolution as typeof RESOLUTIONS[number])
    || row.referenceUsage !== "general" || row.historySurface !== COVER_ATTEMPT_SURFACE) return null;
  if (row.referenceImageUrls !== undefined && (!Array.isArray(row.referenceImageUrls) || row.referenceImageUrls.length !== 0)) return null;
  return {
    prompt,
    modelId,
    mode: "local",
    style,
    aspectRatio: row.aspectRatio as CoverAttemptGenerationInput["aspectRatio"],
    resolution: row.resolution as CoverAttemptGenerationInput["resolution"],
    coverText,
    referenceImageUrls: [],
    referenceUsage: "general",
    historySurface: COVER_ATTEMPT_SURFACE,
  };
}

function taskSnapshot(value: unknown): CoverAttemptTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = stringValue(row.id, 200);
  const title = stringValue(row.title, 200);
  const subtitle = stringValue(row.subtitle, 500, false);
  const prompt = stringValue(row.prompt, 50_000);
  const briefText = row.briefText === undefined ? undefined : stringValue(row.briefText, 20_000, false);
  const prepareOperationId = row.prepareOperationId === undefined ? undefined : stringValue(row.prepareOperationId, 36);
  if (!id || !title || subtitle === null || !prompt || briefText === null || row.source !== "生成"
    || !RATIOS.includes(row.ratio as typeof RATIOS[number]) || typeof row.createdAt !== "string"
    || !Number.isFinite(Date.parse(row.createdAt)) || !Number.isSafeInteger(row.taskNo) || Number(row.taskNo) < 0
    || coverCompositionValidationError(row.renderPlan as CoverCompositionPlan)
    || (prepareOperationId !== undefined && (!prepareOperationId || !/^[a-f0-9-]{36}$/iu.test(prepareOperationId)))) return null;
  return {
    ...(prepareOperationId ? { prepareOperationId } : {}),
    id,
    ratio: row.ratio as CoverAttemptTaskSnapshot["ratio"],
    title,
    subtitle,
    prompt,
    ...(briefText !== undefined ? { briefText } : {}),
    source: "生成",
    createdAt: row.createdAt,
    taskNo: Number(row.taskNo),
    renderPlan: projectCoverCompositionPlan(row.renderPlan as CoverCompositionPlan),
  };
}

export function parseCoverAttemptClaim(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const task = taskSnapshot(row.task);
  const input = generationInput(row.payload);
  const referenceCount = Number(row.referenceCount ?? 0);
  if (!task || !input || !Number.isSafeInteger(referenceCount) || referenceCount < 0 || referenceCount > 5
    || (task.renderPlan.planVersion !== 2 && task.ratio !== input.aspectRatio)
    || (task.renderPlan.planVersion === 2 && (!task.prepareOperationId || task.renderPlan.aspectRatio !== task.ratio))
    || task.prompt !== input.prompt) return null;
  return { task, generationInput: input, referenceCount };
}

export function parseCoverAttemptKeys(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return KEY.test(String(row.clientIdempotencyKey || "")) && KEY.test(String(row.clientTraceId || ""))
    ? { clientIdempotencyKey: String(row.clientIdempotencyKey), clientTraceId: String(row.clientTraceId) }
    : null;
}

export function parseCoverDispatchPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const references = row.referenceImageUrls;
  if (!Array.isArray(references) || references.length > 5 || references.some(item => typeof item !== "string" || !item || item.length > 8 * 1024 * 1024)) return null;
  const safe = generationInput({ ...row, referenceImageUrls: [] });
  return safe ? { safe, references: references as string[] } : null;
}

export function isCoverAttemptRow(value: unknown): value is CoverAttemptRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.user_id === "string" && row.surface === COVER_ATTEMPT_SURFACE
    && KEY.test(String(row.client_idempotency_key || "")) && KEY.test(String(row.client_trace_id || ""))
    && ["claimed", "dispatched", "delivery_pending", "completed", "failed", "cancelled"].includes(String(row.state))
    && Boolean(taskSnapshot(row.task)) && Boolean(generationInput(row.generation_input))
    && typeof row.requires_reference_reupload === "boolean" && typeof row.created_at === "string" && typeof row.updated_at === "string";
}

export function coverAttemptProjection(row: CoverAttemptRow) {
  const status: "running" | "unknown" | "failed" | "cancelled" = row.state === "claimed"
    ? "running"
    : row.state === "failed"
      ? "failed"
      : row.state === "cancelled" ? "cancelled" : "unknown";
  const task = {
    ...taskSnapshot(row.task)!,
    // The persisted snapshot remains private authority for original delivery.
    // Browsers receive their own brief, never the platform-compiled prompt.
    prompt: "" as const,
    imageOrigin: "generated" as const,
    publicModelId: row.generation_input.modelId,
    resolution: row.generation_input.resolution,
    ...(row.result_asset_id ? { assetId: row.result_asset_id } : {}),
    ...(row.history_record_id ? { historyRecordId: row.history_record_id } : {}),
    ...(row.background_asset_id ? { backgroundAssetId: row.background_asset_id } : {}),
    ...(row.result_asset_id && row.history_record_id ? { cloudStored: true } : {}),
    status,
    clientIdempotencyKey: row.client_idempotency_key,
    clientTraceId: row.client_trace_id,
    attemptState: row.state,
    cancellable: COVER_ATTEMPT_ACTIVE_STATES.includes(row.state as typeof COVER_ATTEMPT_ACTIVE_STATES[number]),
    error: row.state === "claimed"
      ? "封面任务已由账号安全认领，正在等待首次提交"
      : row.state === "delivery_pending"
        ? "底图已保存，正在完成封面排版与历史同步"
        : row.state === "failed"
          ? row.error_code === "COVER_CLAIM_EXPIRED_BEFORE_DISPATCH"
            ? "任务等待提交超时，未调用模型、未产生扣费"
            : row.error_code === "COVER_DISPATCH_INTENT_MISSING"
              ? "任务提交链路中断，未发现模型请求、未产生扣费"
              : "封面任务已明确结束"
          : row.state === "cancelled"
            ? "任务已终止；若模型尚未调用则不会扣费，已调用任务按实际账单核对"
            : "封面任务已提交，正在核验原结果",
  };
  return {
    clientIdempotencyKey: row.client_idempotency_key,
    clientTraceId: row.client_trace_id,
    state: row.state,
    updatedAt: Date.parse(row.updated_at) || Date.now(),
    task,
    dispatchInput: undefined,
    canDispatch: row.state === "claimed" && !row.requires_reference_reupload,
    requiresReferenceReupload: row.requires_reference_reupload,
    backgroundAssetId: row.background_asset_id || undefined,
  };
}

export function sameCoverGenerationInput(left: CoverAttemptGenerationInput, right: CoverAttemptGenerationInput) {
  // PostgreSQL jsonb does not preserve the insertion order of object keys.
  // Compare the closed input contract field by field so a round trip through
  // jsonb remains equal while any changed generation parameter still fails
  // closed before the paid provider dispatch.
  return left.prompt === right.prompt
    && left.modelId === right.modelId
    && left.mode === right.mode
    && left.style === right.style
    && left.aspectRatio === right.aspectRatio
    && left.resolution === right.resolution
    && left.coverText === right.coverText
    && left.referenceUsage === right.referenceUsage
    && left.historySurface === right.historySurface
    && left.referenceImageUrls.length === right.referenceImageUrls.length
    && left.referenceImageUrls.every((reference, index) => reference === right.referenceImageUrls[index]);
}
