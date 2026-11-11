"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { COVER_OUTPUT_SPECS as coverOutputSizes, coverTextRendering, coverGeneratedOverlayPolicy, coverGeneratedOverlayTitleStyle, type CoverCompositionPlan, type CoverTitleStyle as SharedTitleStyle } from "@/lib/cover-composition";
import type { CoverContentAnalysis, CoverPrepareInput, CoverResolution } from "@/lib/cover-workbench-contract";
import type { BenchmarkCoverLayoutPlan } from "@/lib/cover-benchmark-layout";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import {
  fetchCoverAccountHistory, fetchCoverResultBlob, runCoverGeneration, saveCoverCompositionEdit,
  type CoverGenerationPayload, type CoverGenerationState, type CoverGenerationTask,
} from "@/lib/cover-generation-attempt";
import type { WorkbenchIdentity } from "@/lib/workbench-user-storage";
import { chooseCoverFile, coverExportName, writeCoverFile } from "@/lib/cover-file-export";
import type { CoverStyleChoice } from "./cover-style-picker";
import { reviewDraftFromAnalysis, type CoverReviewDraft } from "./cover-plan-review";
import { CoverStylePublicCatalogSchema } from "@/lib/cover-style-catalog";

export type CoverOutputRatio = CoverCompositionPlan["aspectRatio"];
export type CoverMaterialRole = "style_reference" | "identity_subject" | "background_canvas";
export type CoverVisualStyle = string;
export type CoverCreationScenario = "script" | "product" | "reference" | "background";
export type CoverImageMode = "preserve" | "compose";
export const COVER_CREATION_SCENARIOS: Record<CoverCreationScenario, {
  label: string; description: string; textLabel: string; placeholder: string; imagesLabel: string; imagesHint: string; steps: string[];
}> = {
  script: { label: "动画封面", description: "文案拆解，按风格创作", textLabel: "完整口播文案",
    placeholder: "粘贴完整口播。先拆解主体、关系、事件和核心观点，提炼标题与画面方案。你可以修改方案，确认后再生成封面。", imagesLabel: "无需上传图片", imagesHint: "人物、宠物和场景根据文案确定。", steps: ["拆解内容", "编辑确认方案", "生成并保存"] },
  product: { label: "商品封面", description: "提供商品介绍，可结合商品、人物和场景图片制作封面。", textLabel: "商品介绍与制作要求",
    placeholder: "介绍商品名称、用途和已知特点。添加图片后可写：@图1 使用商品外观，@图2 作为场景，让商品放在桌面右侧。", imagesLabel: "商品与其他素材", imagesHint: "最多 3 张，可组合商品、人物、场景或参考封面。默认智能合成，也可选择保留原图；无照片时生成商品创意示意图。", steps: ["提炼商品信息与要求", "结合素材制作画面", "自动排版并保存"] },
  reference: { label: "参考封面", description: "添加图片并说明用途，结合新文案制作自定义封面。", textLabel: "文案与制作要求",
    placeholder: "粘贴口播或内容介绍，再说明图片用途。例如：@图1 保留人物外观，@图2 使用场景，把人物放在画面右侧，左侧留出标题位置。", imagesLabel: "图片素材", imagesHint: "添加 1–3 张图片，可组合人物、商品、场景和参考封面。使用 @图编号 说明要求，编号与图片一一对应。", steps: ["解析文案与图片用途", "按要求合成新画面", "自动排版并保存"] },
  background: { label: "原图排版", description: "提供背景图和文案，保留原图，自动提炼标题并排版。", textLabel: "封面文案",
    placeholder: "输入口播文案、内容介绍或现成标题。系统会自动提炼封面标题，结合原图安排文字。", imagesLabel: "背景图片", imagesHint: "第一张为需要保留的背景图，可再添加最多 2 张参考封面；完整保留原图，不重新生图。", steps: ["提炼封面标题", "分析原图留白", "自动排版并保存"] },
};
export function inferCoverScenario(assets: { role: CoverMaterialRole }[]): CoverCreationScenario {
  return assets.some((asset) => asset.role === "identity_subject") ? "product"
    : assets.some((asset) => asset.role === "background_canvas") ? "background" : assets.length ? "reference" : "script";
}
export function assignCoverScenarioRoles(assets: WorkbenchMaterial[], scenario: CoverCreationScenario): WorkbenchMaterial[] {
  if (scenario === "script") return assets;
  return assets.map((asset, index) => ({ ...asset, role: index === 0 && scenario !== "reference"
    ? scenario === "product" ? "identity_subject" : "background_canvas" : "style_reference" }));
}
export function ensureCoverImageNumbers(assets: WorkbenchMaterial[], start: number): { assets: WorkbenchMaterial[]; next: number } {
  let next = Math.max(start, 1, ...assets.map((asset) => (asset.imageNumber || 0) + 1));
  const numbered = assets.map((asset) => asset.imageNumber ? asset : { ...asset, imageNumber: next++ });
  return { assets: numbered, next };
}
// JSONB does not preserve object-key order. Compare rendering values rather than
// transport serialization so opening an unchanged saved cover never marks it dirty.
export function canonicalCoverValue(value: unknown): string {
  const normalize = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(normalize)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)])) : entry;
  return JSON.stringify(normalize(value));
}
export const coverMaterialLabels: Record<CoverMaterialRole, string> = {
  background_canvas: "保留整张图片", identity_subject: "保留主体外观", style_reference: "参考配色和布局",
};
export { coverOutputSizes };
export type CoverTitleStyle = Required<Omit<SharedTitleStyle, "colorMode">> & Pick<SharedTitleStyle, "colorMode">;
export function isSavedCoverTask(task: CoverGenerationTask | null | undefined): boolean {
  return Boolean(task && ["done", "display_pending"].includes(task.status)
    && task.cloudStored === true && task.assetId && task.historyRecordId);
}
export type WorkbenchRenderPlan = CoverCompositionPlan & {
  planVersion: 2;
  outputSpec: { aspectRatio: CoverOutputRatio; width: number; height: number; format: "png"; fit?: "cover" | "contain" };
  titleStyle: CoverTitleStyle;
};
export interface WorkbenchMaterial {
  id: string; name: string; role: CoverMaterialRole; previewUrl: string; imageNumber?: number;
  status: "uploading" | "ready" | "failed"; assetId?: string; width?: number; height?: number; error?: string;
}
export interface WorkbenchModel {
  id: string; name: string; available: boolean; priceReady: boolean; message: string;
  referenceSupport: boolean | null; maxReferences: number | null; resolutions: string[]; defaultResolution: string;
  prices: Record<string, number>; price: number | null;
}
type PrepareMaterials = CoverPrepareInput;
type GenerationIdentity = NonNullable<Parameters<typeof runCoverGeneration>[0]["identity"]>;
export interface PreparedCover {
  success?: boolean; operationId: string;
  workflowVersion?: 3; kind?: "analysis" | "confirmation";
  status: "prepared" | "analyzing" | "needs_input" | "plan_ready" | "review_ready" | "confirmed" | "unknown" | "failed";
  analysisHash?: string; confirmationId?: string; originalAnalysisOperationId?: string;
  confirmedPlan?: CoverReviewDraft;
  generationStarted?: boolean;
  analysisBilling?: { creditsCharged?: number; operationId?: string; reusedFromOperationId?: string };
  originalAnalysisBilling?: { operationId?: string; creditsCharged?: number | null; chargedAgain?: false };
  style?: { styleKey?: string; version?: string; displayName?: string; sceneBriefVersion?: 1 };
  materials?: PrepareMaterials; route?: string; sourceAssetId?: string;
  analysis?: CoverContentAnalysis;
  layoutPlan?: BenchmarkCoverLayoutPlan;
  renderPlan?: CoverCompositionPlan; generationInput?: CoverGenerationPayload; task?: CoverGenerationTask;
  generationIdentity?: GenerationIdentity;
  quote?: {
    imageQuoteHash?: string;
    analysis?: { modelId?: string; modelName?: string; amount: number | null; unit: "credits"; policy?: string };
    image?: { modelId?: string; modelName?: string; amount: number | null; unit?: "yuan" | "credits"; resolution?: string; ready: boolean };
  };
  notices?: string[]; error?: string; code?: string; reprepareRequired?: boolean;
  analysisIssue?: { category: string; fieldPath?: string; evidenceId?: string; message: string;
    action: "query_original" | "edit_materials" | "wait_original"; canRecoverFromReceipt: boolean; chargesPreserved: boolean };
}
/** A frozen order is a read-only view, never a new editable/request binding.
 * Do not fill missing fields from today's catalog, price, or browser draft. */
export function coverOriginalOrderDisplay(operation: PreparedCover, candidateTask?: CoverGenerationTask | null) {
  const confirmationId = operation.confirmationId || operation.operationId;
  const task = operation.task || (candidateTask?.prepareOperationId === confirmationId ? candidateTask : null);
  const saved = operation.materials;
  const quote = operation.quote?.image;
  const plan = operation.renderPlan || task?.renderPlan;
  const ratio = saved?.outputRatio || plan?.aspectRatio || task?.ratio;
  const output = ratio ? coverOutputSizes[ratio] : undefined;
  const assets = saved?.assets.map(asset => ({ ...asset })) || [];
  const amount = typeof quote?.amount === "number" && Number.isFinite(quote.amount) ? quote.amount : null;
  const original = operation.route === "original_layout";
  const credits = operation.originalAnalysisBilling?.creditsCharged;
  return {
    confirmationId,
    text: saved?.text || task?.briefText || "",
    title: operation.confirmedPlan?.primaryTitle || plan?.title || task?.title || "",
    subtitle: operation.confirmedPlan?.secondaryTitle || plan?.subtitle || task?.subtitle || "",
    scenario: saved?.contentKind === "product" ? "product" as const : inferCoverScenario(assets),
    assets, styleName: operation.style?.displayName || "原单风格",
    modelId: quote?.modelId || saved?.modelId || task?.publicModelId || "",
    modelName: original ? "保留原图，不调用生图模型" : quote?.modelName?.trim() || "原单模型名称尚未读取",
    resolution: quote?.resolution || saved?.resolution || "",
    ratio, width: plan?.outputSpec?.width || output?.width, height: plan?.outputSpec?.height || output?.height,
    imageFeeText: amount === null ? "原单报价待查询" : quote?.unit === "credits" ? `${amount} 积分` : `¥${amount.toFixed(2)}`,
    analysisFeeText: typeof credits === "number" && credits > 0
      ? `原内容分析已计费 ${credits} 积分；本页仅查询，不重新分析或生图。`
      : "原分析费用记录已保留；本页仅查询，不重新分析或生图。",
    analysisModelName: operation.quote?.analysis?.modelName || "",
    originalLayout: original,
  };
}
interface Snapshot { materials: PrepareMaterials; fingerprint: string; titleRevision: number; titleStyle: CoverTitleStyle; editorRevision?: number }
interface PreparedBinding { result: PreparedCover; snapshot: Snapshot }
interface PendingReference { operationId?: string; clientRequestId: string; phase?: "prepare" | "analysis" | "review" | "confirmation" | "generation"; materialRevision?: number; workflowVersion?: 3 }
interface SelectionGuard { fingerprint?: string; editorRevision?: number; select?: boolean }
interface CoverReviewExecution {
  success?: boolean; confirmationId: string;
  status: "confirmed" | "claimed" | "submitted" | "delivery_pending" | "completed" | "unknown" | "failed";
  task?: CoverGenerationTask; activeAttempt?: { task?: CoverGenerationTask }; canPoll?: boolean;
  error?: string; issue?: { message?: string };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, String(value)); } };
}
function message(error: unknown, fallback: string) { return error instanceof Error ? error.message : fallback; }
class CoverCatalogReadError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
type CoverCatalogLoader = { reload: () => Promise<void>; resume: () => void; pause: () => void; dispose: () => void };
/** Retries belong only to these public GETs, never to a workflow or paid request. */
function createCoverCatalogLoader<T>(options: {
  url: string; label: string; revision: { current: number }; isActive: () => boolean;
  parse: (value: unknown) => T; onLoading: () => void; onSuccess: (value: T) => void; onError: (text: string) => void;
}): CoverCatalogLoader {
  let disposed = false, retryPending = false, terminal = false, retryStep = 0, lastStarted = -Infinity;
  let retryTimer: number | null = null, requestTimer: number | null = null;
  let controller: AbortController | null = null, inFlight: Promise<void> | null = null;
  const clearRetry = () => { if (retryTimer !== null) window.clearTimeout(retryTimer); retryTimer = null; };
  const clearRequestTimer = () => { if (requestTimer !== null) window.clearTimeout(requestTimer); requestTimer = null; };
  const visible = () => document.visibilityState !== "hidden";
  const schedule = () => {
    if (disposed || !options.isActive() || terminal || !retryPending || !visible() || retryTimer !== null) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(retryStep++, 5));
    retryTimer = window.setTimeout(() => { retryTimer = null; void load("retry"); }, delay);
  };
  async function load(source: "manual" | "resume" | "retry" = "manual"): Promise<void> {
    if (disposed || !options.isActive()) return;
    if (source !== "manual" && terminal) return;
    if (!visible()) { if (!terminal) retryPending = true; clearRetry(); return; }
    if (inFlight) return inFlight;
    if (source === "resume" && Date.now() - lastStarted < 1000) { schedule(); return; }
    clearRetry(); retryPending = false; terminal = false;
    if (source === "manual") retryStep = 0;
    const revision = ++options.revision.current, requestController = new AbortController();
    controller = requestController; lastStarted = Date.now();
    let timedOut = false;
    options.onLoading();
    requestTimer = window.setTimeout(() => { timedOut = true; requestController.abort(); }, 12_000);
    const current = () => !disposed && options.isActive() && revision === options.revision.current;
    inFlight = (async () => {
      try {
        const response = await fetch(options.url, { method: "GET", cache: "no-store", signal: requestController.signal });
        let data: unknown = null;
        try { data = await response.json(); }
        catch { if (requestController.signal.aborted) throw new TypeError("catalog read interrupted"); }
        if (!response.ok) {
          const retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
          const publicError = isRecord(data) && typeof data.error === "string" && /[\u4e00-\u9fff]/u.test(data.error) ? data.error.slice(0, 240) : "";
          throw new CoverCatalogReadError(response.status === 401 || response.status === 403
            ? `${options.label}读取权限已失效，请重新登录后点击重新读取。`
            : publicError || `${options.label}${retryable ? "服务暂时不可用" : "暂时无法读取，请点击重新读取"}。`, retryable);
        }
        let parsed: T;
        try { parsed = options.parse(data); }
        catch { throw new CoverCatalogReadError(`${options.label}数据格式暂不可用，请点击重新读取或联系管理员。`, false); }
        if (!current()) return;
        retryStep = 0; options.onSuccess(parsed);
      } catch (cause) {
        if (!current() || requestController.signal.aborted && !timedOut) return;
        const retryable = timedOut || cause instanceof TypeError || cause instanceof CoverCatalogReadError && cause.retryable;
        const detail = cause instanceof CoverCatalogReadError ? cause.message : `${options.label}${timedOut ? "读取超时" : "暂时无法连接服务"}。`;
        options.onError(retryable ? `${detail}页面会自动重试，也可点击重新读取。` : detail);
        retryPending = retryable; terminal = !retryable;
      } finally {
        clearRequestTimer();
        if (controller === requestController) controller = null;
        inFlight = null; schedule();
      }
    })();
    return inFlight;
  }
  return {
    reload: () => load(), resume: () => { if (visible()) void load("resume"); },
    pause: () => { clearRetry(); if (controller) { retryPending = true; options.revision.current++; controller.abort(); } },
    dispose: () => { disposed = true; clearRetry(); clearRequestTimer(); options.revision.current++; controller?.abort(); },
  };
}
function uuid() { return crypto.randomUUID(); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function parseModels(value: unknown): WorkbenchModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.startsWith("pm_") || typeof item.displayName !== "string") return [];
    const caps = isRecord(item.capabilities) ? item.capabilities : {};
    const prices = parsePublicImageResolutionPrices(caps.resolutionPrices);
    return [{ id: item.id, name: [item.displayName, item.variantLabel].filter((part) => typeof part === "string" && part).join(" "),
      available: caps.available === true && caps.generationReady !== false && caps.protocolBindingReady !== false,
      priceReady: caps.priceReady === true,
      message: typeof caps.availabilityMessage === "string" ? caps.availabilityMessage : typeof caps.readinessMessage === "string" ? caps.readinessMessage : "",
      referenceSupport: typeof caps.supportsReferenceInput === "boolean" ? caps.supportsReferenceInput : null,
      maxReferences: typeof caps.maxReferenceImages === "number" ? caps.maxReferenceImages : null,
      resolutions: Array.isArray(caps.resolutionOptions) ? caps.resolutionOptions.filter((entry): entry is string => ["1K", "2K", "4K"].includes(String(entry))) : [],
      defaultResolution: typeof caps.defaultResolution === "string" ? caps.defaultResolution : "2K", prices,
      price: typeof item.publicPrice === "number" && Number.isFinite(item.publicPrice) && item.publicPrice >= 0 ? item.publicPrice : null }];
  });
}

export function useCoverWorkbench(identity: WorkbenchIdentity, mainWorkspace = false) {
  const [text, setText] = useState("");
  const [scenario, setScenarioState] = useState<CoverCreationScenario>("script");
  const [imageMode, setImageModeState] = useState<CoverImageMode>("preserve");
  const [preserveLegacyContentKind, setPreserveLegacyContentKind] = useState(false);
  const [storedMaterials, setMaterials] = useState<WorkbenchMaterial[]>([]);
  const materials = useMemo(() => scenario === "script" ? [] : storedMaterials, [scenario, storedMaterials]);
  const [styleKey, setStyleKey] = useState<CoverVisualStyle>("cartoon");
  const [ratio, setRatio] = useState<CoverOutputRatio>("3:4");
  const [modelId, setModelId] = useState("");
  const [resolution, setResolution] = useState<CoverResolution>("2K");
  const [models, setModels] = useState<WorkbenchModel[]>([]);
  const [modelsState, setModelsState] = useState<"loading" | "ready" | "error">("loading");
  const [modelsError, setModelsError] = useState("");
  const [styleChoices, setStyleChoices] = useState<CoverStyleChoice[]>([]);
  const [stylesLoading, setStylesLoading] = useState(true);
  const [stylesError, setStylesError] = useState("");
  const modelLoadRevision = useRef(0);
  const styleLoadRevision = useRef(0);
  const modelCatalogLoader = useRef<CoverCatalogLoader | null>(null);
  const styleCatalogLoader = useRef<CoverCatalogLoader | null>(null);
  const [title, setTitle] = useState("");
  const [manualTitle, setManualTitle] = useState(false);
  const [titleStyle, setTitleStyle] = useState<CoverTitleStyle>({ x: .08, y: .07, width: .84, scale: 1, color: "#583A27", colorMode: "palette" });
  const [materialRevision, setMaterialRevision] = useState(1);
  const [binding, setBinding] = useState<PreparedBinding | null>(null);
  const [reviewDraft, setReviewDraft] = useState<CoverReviewDraft | null>(null);
  const [confirmed, setConfirmed] = useState<PreparedCover | null>(null);
  const confirmationRequest = useRef<{ hash: string; key: string } | null>(null);
  const [analysisBinding, setAnalysisBinding] = useState<{ fingerprint: string; analysis: CoverContentAnalysis; layoutPlan?: BenchmarkCoverLayoutPlan } | null>(null);
  const [busy, setBusy] = useState<"preparing" | "analyzing" | "generating" | "rendering" | "downloading" | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [pending, setPending] = useState<PendingReference | null>(null);
  const [recoverable, setRecoverable] = useState<PreparedCover | null>(null);
  const [recoveryIssue, setRecoveryIssue] = useState<PreparedCover["analysisIssue"] | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [results, setResults] = useState<CoverGenerationTask[]>([]);
  const [selected, setSelected] = useState<CoverGenerationTask | null>(null);
  const [automaticLayoutTaskId, setAutomaticLayoutTaskId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyNext, setHistoryNext] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const previewFormat = useRef<{ task: CoverGenerationTask; mime: string } | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [renderedPreviewUrl, setRenderedPreviewUrl] = useState("");
  const [renderedPreviewStamp, setRenderedPreviewStamp] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [renderedPreviewError, setRenderedPreviewError] = useState("");
  const previewRevision = useRef(0);
  const storage = useRef(memoryStorage());
  const active = useRef(true);
  const owner = useRef(identity.userId + "\0" + identity.token);
  const titleRevision = useRef(0);
  const titleStyleTouched = useRef(false);
  const editorRevision = useRef(0);
  const manualTitleRef = useRef(false);
  const urls = useRef(new Set<string>());
  const requestGate = useRef(false);
  const referenceToReopen = useRef<PendingReference | null>(null);
  const hadBrowserDraft = useRef(false);
  const uploadBatchActive = useRef(false);
  const nextImageNumber = useRef(1);
  const submissionBindings = useRef(new Map<string, string>());
  const currentRequest = useRef<{ fingerprint: string; clientRequestId: string } | null>(null);
  const sessionKey = `cover-workbench-operation-v2:${identity.userId}`;
  const draftKey = `cover-workbench-draft-v2:${identity.userId}`;
  const customComposition = (scenario === "product" || scenario === "reference") && imageMode === "compose";
  const fingerprint = useMemo(() => canonicalCoverValue({ text, assets: materials.map(({ assetId, role, imageNumber }) => ({ assetId, role, ...(imageNumber ? { imageNumber } : {}) })), styleKey, ratio, modelId, resolution,
    ...(customComposition && materials.length ? { imageMode: "compose" } : {}), ...(scenario === "product" && !preserveLegacyContentKind ? { contentKind: "product" } : {}),
    ...(manualTitle ? { manualTitle: title } : {}) }), [text, materials, styleKey, ratio, modelId, resolution, manualTitle, title, scenario, customComposition, preserveLegacyContentKind]);
  const fingerprintRef = useRef(fingerprint);
  useLayoutEffect(() => {
    owner.current = identity.userId + "\0" + identity.token;
    manualTitleRef.current = manualTitle;
    fingerprintRef.current = fingerprint;
  }, [identity.userId, identity.token, manualTitle, fingerprint]);
  const activeModel = models.find((item) => item.id === modelId);
  const originalMaterial = materials.find((item) => item.role === "background_canvas")
    ?? materials.find((item) => item.role === "identity_subject");
  const originalLayout = scenario === "background" || !customComposition && Boolean(originalMaterial);
  const referenceCount = customComposition ? materials.length : materials.filter((item) => item.role === "style_reference").length;
  const freshBinding = binding?.snapshot.fingerprint === fingerprint ? binding : null;
  const originalOrderDisplay = confirmed && (uncertain || !freshBinding) ? coverOriginalOrderDisplay(confirmed, selected) : null;
  const selectedAnalysisFingerprint = selected ? submissionBindings.current.get(selected.id)
    || submissionBindings.current.get(selected.prepareOperationId || "") : undefined;
  const visibleAnalysisBinding = analysisBinding && (analysisBinding.fingerprint === fingerprint
    || selectedAnalysisFingerprint === analysisBinding.fingerprint) ? analysisBinding : null;
  const nativeSelected = Boolean(selected?.renderPlan && coverTextRendering(selected.renderPlan).mode === "native");
  const editableSelected = Boolean(!originalOrderDisplay && selected?.backgroundAssetId && selected.renderPlan && (selected.renderPlan as { planVersion?: number }).planVersion === 2 && !nativeSelected);
  const canApplyAutomaticLayout = Boolean(editableSelected && isSavedCoverTask(selected) && selected?.imageOrigin === "generated"
    && !selected.renderPlan?.originalLayout && ["upload", "template"].includes(selected.renderPlan?.materialSourceId || ""));
  const generatedOverlayLayout = selected?.renderPlan?.generatedOverlayLayout
    || (selected && automaticLayoutTaskId === selected.id ? coverGeneratedOverlayPolicy() : undefined);
  const outputSpec = { aspectRatio: ratio, ...coverOutputSizes[ratio], format: "png" as const,
    ...(generatedOverlayLayout ? { fit: "contain" as const } : selected ? selected.renderPlan?.outputSpec?.fit ? { fit: selected.renderPlan.outputSpec.fit } : {}
      : originalLayout ? { fit: "contain" as const } : {}) };
  const plan: WorkbenchRenderPlan = { ...(selected?.renderPlan || {}), title, subtitle: selected?.renderPlan?.subtitle || "", aspectRatio: ratio,
    layoutTemplateId: selected?.renderPlan?.layoutTemplateId || "gaoding-teacher-interview",
    animationStyleId: selected?.renderPlan?.animationStyleId || "pet-3d", coverModeId: styleKey,
    materialSourceId: selected?.renderPlan?.materialSourceId || (materials.length ? "upload" : "text"),
    subjectModeId: selected?.renderPlan?.subjectModeId || (materials.some((item) => item.role === "identity_subject") ? "product" : "semantic"),
    planVersion: 2, outputSpec, titleStyle: generatedOverlayLayout ? coverGeneratedOverlayTitleStyle() : titleStyle,
    ...(generatedOverlayLayout ? { generatedOverlayLayout } : {}) };
  const dirty = editableSelected && canonicalCoverValue(plan) !== canonicalCoverValue(selected?.renderPlan);
  const previewSourceAssetId = editableSelected ? selected?.backgroundAssetId : !selected && originalLayout ? originalMaterial?.assetId : undefined;
  const previewPlanFingerprint = canonicalCoverValue(plan);
  const requestedPreviewStamp = previewSourceAssetId ? `${previewSourceAssetId}\0${previewPlanFingerprint}` : "";
  const currentRenderedPreviewUrl = requestedPreviewStamp && renderedPreviewStamp === requestedPreviewStamp ? renderedPreviewUrl : "";
  const bump = () => { setMaterialRevision((value) => value + 1); setPreserveLegacyContentKind(false); editorRevision.current += 1; setError(""); };
  const ownedUrl = useCallback((blob: Blob) => { const url = URL.createObjectURL(blob); urls.current.add(url); return url; }, []);
  const currentOwner = () => active.current && owner.current === identity.userId + "\0" + identity.token;
  const authFetch = useCallback(async (assetId: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/storage/files/${encodeURIComponent(assetId)}/content`, { headers: { Authorization: `Bearer ${identity.token}` }, cache: "no-store", signal });
    if (!response.ok) throw new Error("图片暂时无法读取，请重新载入");
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp)$/u.test(blob.type) || !blob.size || blob.size > 30 * 1024 * 1024) throw new Error("图片格式或大小不符合预览要求");
    return blob;
  }, [identity.token]);
  const persistPending = (next: PendingReference | null) => {
    if (!currentOwner()) return;
    setPending(next);
    try { if (next) localStorage.setItem(sessionKey, JSON.stringify(next)); else localStorage.removeItem(sessionKey); } catch { /* Server operations remain authoritative. */ }
  };
  useEffect(() => {
    active.current = true;
    const ownedUrls = urls.current;
    return () => { active.current = false; for (const url of ownedUrls) URL.revokeObjectURL(url); ownedUrls.clear(); };
  }, [identity.userId]);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(sessionKey) || "null");
      if (isRecord(saved) && typeof saved.clientRequestId === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(saved.clientRequestId)
          && (saved.operationId === undefined || typeof saved.operationId === "string" && /^[a-f0-9-]{36}$/iu.test(saved.operationId))) {
        const phase = ["prepare", "generation", "review", "confirmation"].includes(String(saved.phase)) ? saved.phase as PendingReference["phase"] : "analysis";
        const reference: PendingReference = { clientRequestId: saved.clientRequestId, phase,
          ...(saved.workflowVersion === 3 ? { workflowVersion: 3 as const } : {}),
          ...(typeof saved.operationId === "string" ? { operationId: saved.operationId } : {}),
          ...(typeof saved.materialRevision === "number" && Number.isSafeInteger(saved.materialRevision) ? { materialRevision: saved.materialRevision } : {}) };
        const canReopen = mainWorkspace && (reference.workflowVersion === 3 || phase === "analysis" || phase === "review");
        referenceToReopen.current = canReopen ? reference : null;
        setPending(reference);
        setUncertain(phase !== "prepare" && phase !== "review");
        setNotice(canReopen ? "正在读取上次的封面任务…" : phase === "prepare" ? "上次制作方案尚未确认，可查询原任务或重新准备；准备方案不会调用付费模型。" : "发现尚未确认的制作任务，请先查询原任务状态。");
      }
    } catch { /* An unreadable local reference never starts another task. */ }
  }, [sessionKey, mainWorkspace]);
  const reopenOriginal = useEffectEvent(() => { void recover(true); });
  useEffect(() => {
    if (draftReady && pending && referenceToReopen.current === pending) {
      referenceToReopen.current = null;
      reopenOriginal();
    }
  }, [draftReady, pending]);
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(draftKey) || "null");
        if (!isRecord(saved) || saved.schemaVersion !== "cover-browser-draft/2" || saved.userId !== identity.userId) return;
        hadBrowserDraft.current = Boolean(saved.text || saved.title || saved.manualTitleStyle ||
          (Array.isArray(saved.assets) && saved.assets.length) || Number(saved.materialRevision) > 1);
        if (typeof saved.text === "string" && saved.text.length <= 20000) setText(saved.text);
        if (typeof saved.title === "string" && saved.title.length <= 80) setTitle(saved.title);
        if (typeof saved.materialRevision === "number" && Number.isSafeInteger(saved.materialRevision) && saved.materialRevision > 0) setMaterialRevision(saved.materialRevision);
        setManualTitle(saved.manualTitle === true);
        if (typeof saved.styleKey === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(saved.styleKey)) setStyleKey(saved.styleKey);
        if (typeof saved.ratio === "string" && Object.hasOwn(coverOutputSizes, saved.ratio)) setRatio(saved.ratio as CoverOutputRatio);
        if (typeof saved.modelId === "string" && /^pm_[A-Za-z0-9_-]+$/u.test(saved.modelId)) setModelId(saved.modelId);
        if (["1K", "2K", "4K"].includes(String(saved.resolution))) setResolution(saved.resolution as CoverResolution);
        if (isRecord(saved.titleStyle)) {
          const next = saved.titleStyle;
          if (typeof next.x === "number" && next.x >= .02 && next.x <= .7 && typeof next.y === "number" && next.y >= .02 && next.y <= .5
              && typeof next.width === "number" && next.width >= .2 && next.width + next.x <= .98 + 1e-12
              && typeof next.scale === "number" && next.scale >= .7 && next.scale <= 1.3 && typeof next.color === "string" && /^#[a-f0-9]{6}$/iu.test(next.color)) {
            setTitleStyle(next as CoverTitleStyle);
            titleStyleTouched.current = saved.manualTitleStyle === true;
          }
        }
        const draftRevision = editorRevision.current;
        const assets = Array.isArray(saved.assets) ? saved.assets.slice(0, 3).filter((asset): asset is Record<string, unknown> =>
          isRecord(asset) && typeof asset.assetId === "string" && /^[a-f0-9-]{36}$/iu.test(asset.assetId)
          && ["background_canvas", "style_reference", "identity_subject"].includes(String(asset.role))) : [];
        const restoredScenario = ["script", "product", "reference", "background"].includes(String(saved.scenario))
          ? saved.scenario as CoverCreationScenario : inferCoverScenario(assets as { role: CoverMaterialRole }[]);
        setScenarioState(restoredScenario);
        setPreserveLegacyContentKind(saved.preserveLegacyContentKind === true || saved.scenario === undefined && restoredScenario === "product");
        setImageModeState(saved.imageMode === "compose" && ["product", "reference"].includes(restoredScenario) ? "compose" : "preserve");
        const restored = await Promise.all(assets.map(async (asset): Promise<WorkbenchMaterial> => {
          const assetId = asset.assetId as string;
          const material: WorkbenchMaterial = { id: uuid(), assetId, name: typeof asset.name === "string" ? asset.name.slice(0, 200) : "已保存图片",
            role: asset.role as CoverMaterialRole, previewUrl: "", status: "ready",
            ...(typeof asset.imageNumber === "number" && Number.isInteger(asset.imageNumber) && asset.imageNumber >= 1 && asset.imageNumber <= 99 ? { imageNumber: asset.imageNumber } : {}),
            ...(typeof asset.width === "number" ? { width: asset.width } : {}), ...(typeof asset.height === "number" ? { height: asset.height } : {}) };
          try { material.previewUrl = ownedUrl(await authFetch(assetId)); }
          catch { material.status = "failed"; material.error = "草稿图片已过期或无法读取，请移除后重新添加。"; }
          return material;
        }));
        if (!cancelled && active.current && editorRevision.current === draftRevision) {
          const numbered = saved.imageMode === "compose" ? ensureCoverImageNumbers(restored, Number(saved.nextImageNumber) || 1) : null;
          setMaterials(numbered ? numbered.assets : restored);
          nextImageNumber.current = numbered?.next ?? Math.max(Number(saved.nextImageNumber) || 1, ...restored.map((asset) => (asset.imageNumber || 0) + 1));
        }
      } catch { /* Invalid browser drafts cannot replace account state. */ }
      finally { if (!cancelled && active.current) setDraftReady(true); }
    };
    void restore();
    return () => { cancelled = true; };
  // Account changes remount this editor. A token refresh must not reload an older browser draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, identity.userId]);
  useEffect(() => {
    if (!draftReady) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ schemaVersion: "cover-browser-draft/2", userId: identity.userId,
          text, title, manualTitle, titleStyle, manualTitleStyle: titleStyleTouched.current, styleKey, ratio, modelId, resolution, materialRevision, scenario, imageMode, preserveLegacyContentKind,
          nextImageNumber: nextImageNumber.current,
          assets: storedMaterials.filter((asset) => asset.status === "ready" && asset.assetId).map(({ assetId, role, name, width, height, imageNumber }) => ({ assetId, role, name, width, height, imageNumber })) }));
      } catch { /* Optional local persistence never invalidates a server result. */ }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftReady, draftKey, identity.userId, text, title, manualTitle, titleStyle, styleKey, ratio, modelId, resolution, storedMaterials, materialRevision, scenario, imageMode, preserveLegacyContentKind]);
  useEffect(() => { if (binding && binding.snapshot.fingerprint !== fingerprint) { setBinding(null); setReviewDraft(null); setConfirmed(null); } }, [binding, fingerprint]);

  const reloadModels = useCallback(async () => { await modelCatalogLoader.current?.reload(); }, []);
  const reloadStyles = useCallback(async () => { await styleCatalogLoader.current?.reload(); }, []);
  useEffect(() => {
    const modelsLoader = createCoverCatalogLoader({
      url: "/api/cover-models?surface=cover-studio", label: "图片模型目录", revision: modelLoadRevision, isActive: () => active.current,
      parse: (data) => { if (!isRecord(data) || !Array.isArray(data.models)) throw new Error("invalid models"); return parseModels(data.models); },
      onLoading: () => { setModelsState("loading"); setModelsError(""); },
      onSuccess: (next) => { setModels(next); setModelsState("ready"); setModelId(previous => previous || next[0]?.id || ""); },
      onError: (text) => { setModelsState("error"); setModelsError(text); },
    });
    const stylesLoader = createCoverCatalogLoader({
      url: "/api/cover-styles", label: "画面风格目录", revision: styleLoadRevision, isActive: () => active.current,
      parse: (data) => CoverStylePublicCatalogSchema.parse(data).styles,
      onLoading: () => { setStylesLoading(true); setStylesError(""); },
      onSuccess: (next) => { setStyleChoices(next); setStylesLoading(false); },
      onError: (text) => { setStylesError(text); setStylesLoading(false); },
    });
    modelCatalogLoader.current = modelsLoader; styleCatalogLoader.current = stylesLoader;
    void modelsLoader.reload(); void stylesLoader.reload();
    const refresh = () => { modelsLoader.resume(); stylesLoader.resume(); };
    const visibility = () => { if (document.visibilityState === "hidden") { modelsLoader.pause(); stylesLoader.pause(); } else refresh(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", visibility);
      modelsLoader.dispose(); stylesLoader.dispose();
      if (modelCatalogLoader.current === modelsLoader) modelCatalogLoader.current = null;
      if (styleCatalogLoader.current === stylesLoader) styleCatalogLoader.current = null;
    };
  }, []);
  const refreshHistory = useCallback(async (page = 1) => {
    setHistoryBusy(true); setHistoryError("");
    try {
      const next = await fetchCoverAccountHistory(identity.token, page);
      if (!active.current) return;
      setResults((previous) => page === 1 ? next.records : [...previous, ...next.records.filter((item) => !previous.some((record) => record.id === item.id))]);
      setHistoryNext(next.nextPage);
    } catch (cause) { if (active.current) setHistoryError(message(cause, "历史作品暂时无法读取")); }
    finally { if (active.current) setHistoryBusy(false); }
  }, [identity.token]);
  useEffect(() => { void refreshHistory(); }, [refreshHistory]);
  useEffect(() => {
    if (!selected || !["done", "display_pending"].includes(selected.status)) { setPreviewUrl(""); return; }
    let cancelled = false;
    let objectUrl = "";
    const ownedUrls = urls.current;
    setPreviewError(""); setPreviewUrl("");
    void fetchCoverResultBlob(selected, identity.token).then((blob) => {
      if (!cancelled && currentOwner()) { previewFormat.current = { task: selected, mime: blob.type.split(";")[0] }; objectUrl = ownedUrl(blob); setPreviewUrl(objectUrl); }
    }).catch((cause) => { if (!cancelled && currentOwner()) setPreviewError(message(cause, "封面预览暂时无法读取")); });
    return () => { cancelled = true; if (objectUrl) { URL.revokeObjectURL(objectUrl); ownedUrls.delete(objectUrl); } };
  // The account component remounts on user changes; token changes cancel the pending read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.assetId, identity.token, ownedUrl]);
  useEffect(() => {
    setBackgroundUrl("");
    if (!selected?.backgroundAssetId || !editableSelected) return;
    const controller = new AbortController();
    let objectUrl = "";
    const ownedUrls = urls.current;
    void authFetch(selected.backgroundAssetId, controller.signal).then((blob) => {
      if (!controller.signal.aborted && currentOwner()) { objectUrl = ownedUrl(blob); setBackgroundUrl(objectUrl); }
    }).catch(() => { /* Keep the saved final image usable when its editing source cannot be read. */ });
    return () => { controller.abort(); if (objectUrl) { URL.revokeObjectURL(objectUrl); ownedUrls.delete(objectUrl); } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.backgroundAssetId, editableSelected, authFetch, ownedUrl]);
  useEffect(() => {
    const revision = ++previewRevision.current;
    setRenderedPreviewUrl(""); setRenderedPreviewStamp(""); setRenderedPreviewError("");
    if (!previewSourceAssetId || !plan.title.trim() || selected && !dirty) { setPreviewBusy(false); return; }
    const controller = new AbortController();
    let objectUrl = "";
    const ownedUrls = urls.current;
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/cover/preview", { method: "POST", signal: controller.signal,
            headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sourceAssetId: previewSourceAssetId, plan: JSON.parse(previewPlanFingerprint) }) });
          if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "当前排版预览暂未完成，请稍后重试。"); }
          const blob = await response.blob();
          if (blob.type !== "image/png" || !blob.size || blob.size > 30 * 1024 * 1024) throw new Error("排版预览没有返回有效图片。");
          if (controller.signal.aborted || revision !== previewRevision.current || !currentOwner()) return;
          objectUrl = ownedUrl(blob); setRenderedPreviewUrl(objectUrl); setRenderedPreviewStamp(`${previewSourceAssetId}\0${previewPlanFingerprint}`);
        } catch (cause) {
          if (!controller.signal.aborted && revision === previewRevision.current && currentOwner()) setRenderedPreviewError(message(cause, "排版预览暂时无法更新。"));
        } finally { if (!controller.signal.aborted && revision === previewRevision.current && currentOwner()) setPreviewBusy(false); }
      })();
    }, 450);
    return () => { window.clearTimeout(timer); controller.abort(); if (objectUrl) { URL.revokeObjectURL(objectUrl); ownedUrls.delete(objectUrl); } };
  // The fingerprint contains every rendering field; unrelated task state must not restart the preview.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewSourceAssetId, previewPlanFingerprint, identity.token, dirty, ownedUrl]);

  async function addFiles(files: FileList | File[]) {
    if (scenario === "script") { setNotice("口播生成无需图片；如需使用图片，请先选择对应的制作方式。"); return; }
    if (busy || uncertain || requestGate.current) return;
    if (!draftReady) { setNotice("正在恢复当前账号草稿，请稍后添加图片。"); return; }
    if (uploadBatchActive.current) { setNotice("图片正在上传，请完成后再添加图片。"); return; }
    const available = 3 - materials.length;
    if (available <= 0) { setError("最多添加 3 张图片，请先移除不需要的图片。"); return; }
    const chosen = Array.from(files).slice(0, available);
    if (Array.from(files).length > available) setNotice(`本次最多还能添加 ${available} 张图片，其他图片未添加。`);
    const accepted = chosen.filter((file) => ["image/png", "image/jpeg", "image/webp"].includes(file.type) && file.size > 0 && file.size <= 5 * 1024 * 1024);
    if (accepted.length !== chosen.length) setError("图片须为 PNG、JPEG 或 WebP 格式，且单张不超过 5MB。");
    const additions: WorkbenchMaterial[] = accepted.map((file, index) => ({ id: uuid(), name: file.name,
      role: materials.length + index === 0 && scenario !== "reference" ? scenario === "product" ? "identity_subject" : "background_canvas" : "style_reference",
      imageNumber: nextImageNumber.current++, previewUrl: ownedUrl(file), status: "uploading" }));
    uploadBatchActive.current = true;
    if (additions.length) setSelected(null);
    setMaterials((previous) => [...previous, ...additions]); bump();
    try { await Promise.all(additions.map(async (asset, index) => {
      try {
        const form = new FormData(); form.set("file", accepted[index]); form.set("role", asset.role);
        const response = await fetch("/api/cover/materials", { method: "POST", headers: { Authorization: `Bearer ${identity.token}` }, body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true || typeof data.assetId !== "string") throw new Error(data.error || "图片上传未完成，请移除后重新添加");
        if (currentOwner()) setMaterials((previous) => previous.map((item) => item.id === asset.id ? { ...item, status: "ready", assetId: data.assetId, width: data.width, height: data.height } : item));
      } catch (cause) { if (currentOwner()) setMaterials((previous) => previous.map((item) => item.id === asset.id ? { ...item, status: "failed", error: message(cause, "图片上传失败") } : item)); }
    })); } finally { uploadBatchActive.current = false; }
  }
  function removeMaterial(id: string) {
    setMaterials((previous) => {
      const asset = previous.find((item) => item.id === id);
      if (asset) { URL.revokeObjectURL(asset.previewUrl); urls.current.delete(asset.previewUrl); }
      const remaining = previous.filter((item) => item.id !== id);
      return customComposition ? remaining : assignCoverScenarioRoles(remaining, scenario);
    }); bump();
  }
  function changeRole(id: string, role: CoverMaterialRole) {
    if (busy || uncertain || uploadBatchActive.current || !customComposition || !Object.hasOwn(coverMaterialLabels, role)) return;
    if (role !== "style_reference") setSelected(null);
    setMaterials((previous) => previous.map((item) => item.id === id ? { ...item, role } : item)); bump();
  }
  function setScenario(next: CoverCreationScenario) {
    if (next === scenario || !Object.hasOwn(COVER_CREATION_SCENARIOS, next) || busy || uncertain || uploadBatchActive.current || requestGate.current || !draftReady) return;
    const numbered = ensureCoverImageNumbers(assignCoverScenarioRoles(storedMaterials, next), nextImageNumber.current);
    setMaterials(next === "product" || next === "reference" ? numbered.assets : assignCoverScenarioRoles(storedMaterials, next));
    if (next === "product" || next === "reference") nextImageNumber.current = numbered.next;
    setScenarioState(next); setSelected(null); setBinding(null); setAnalysisBinding(null); setRecoverable(null);
    setImageModeState(next === "product" || next === "reference" ? "compose" : "preserve");
    currentRequest.current = null;
    if (!manualTitleRef.current) setTitle("");
    titleStyleTouched.current = false;
    setTitleStyle({ x: .08, y: .07, width: .84, scale: 1, color: "#583A27", colorMode: next === "script" ? "palette" : "single" });
    bump();
    setNotice(next === "script" && storedMaterials.length ? `已切换为口播生成。${storedMaterials.length} 张图片已保留在草稿中，本次不会使用。` : COVER_CREATION_SCENARIOS[next].description);
  }
  function setImageMode(next: CoverImageMode) {
    if (!["compose", "preserve"].includes(next) || next === imageMode || !["product", "reference"].includes(scenario)
      || busy || uncertain || uploadBatchActive.current || requestGate.current) return;
    setImageModeState(next); setSelected(null); setBinding(null); setAnalysisBinding(null); currentRequest.current = null;
    if (next === "preserve") setMaterials((previous) => assignCoverScenarioRoles(previous, scenario));
    else { const numbered = ensureCoverImageNumbers(storedMaterials, nextImageNumber.current); setMaterials(numbered.assets); nextImageNumber.current = numbered.next; }
    bump(); setNotice(next === "compose" ? "将结合图片编号、素材与文案要求生成新画面，再自动完成标题排版。" : "保留整张原图，自动提炼标题并排版。");
  }
  function changeTitle(value: string) {
    if (nativeSelected) { setNotice("这张封面的文字已融入图片。请制作下一张并指定新标题，系统会重新确认费用。"); return; }
    setTitle(value); setManualTitle(Boolean(value.trim())); manualTitleRef.current = Boolean(value.trim()); titleRevision.current += 1; bump();
  }
  function changeTitleStyle(patch: Partial<CoverTitleStyle>) {
    if (nativeSelected || generatedOverlayLayout) return;
    titleStyleTouched.current = true;
    setTitleStyle((previous) => { const next = { ...previous, ...patch, ...(patch.color ? { colorMode: "single" as const } : {}) }; next.width = Math.min(next.width, .98 - next.x); return next; });
    editorRevision.current += 1;
  }
  function applyAutomaticLayout() {
    if (!canApplyAutomaticLayout || !selected || busy || uncertain || requestGate.current) return;
    if (title.split(/\r?\n/u).length > 2) { setError("自动留白排版使用一至两行标题，请先调整换行。"); return; }
    setAutomaticLayoutTaskId(selected.id); setTitleStyle(coverGeneratedOverlayTitleStyle()); titleStyleTouched.current = true;
    editorRevision.current += 1; setError("");
    setNotice("已应用自动留白排版：标题在独立顶栏，完整图片位于下方。请检查预览后保存为新版本，不会重新生图。");
  }
  function adoptTask(task: CoverGenerationTask, guard: SelectionGuard = {}) {
    if (guard.fingerprint) submissionBindings.current.set(task.id, guard.fingerprint);
    setResults((previous) => [task, ...previous.filter((item) => item.id !== task.id && (!task.assetId || item.assetId !== task.assetId))]);
    const expected = guard.fingerprint || submissionBindings.current.get(task.id)
      || submissionBindings.current.get(task.prepareOperationId || "") || submissionBindings.current.get(task.clientTraceId || "");
    const canSelect = guard.select !== false && (!expected || fingerprintRef.current === expected)
      && (guard.editorRevision === undefined || guard.editorRevision === editorRevision.current);
    if (canSelect) setSelected(task);
    else if (["done", "display_pending"].includes(task.status)) setNotice("原任务已完成，当前草稿保留不变。请从历史作品打开该结果。");
  }
  function receiveState(state: CoverGenerationState, guard: SelectionGuard = {}) {
    if (!currentOwner()) return;
    const task = state.pending?.task || state.history[0];
    if (task) adoptTask(task, guard);
    if (task?.status === "unknown") setUncertain(true);
  }
  function makeSnapshot(): Snapshot {
    if (!currentRequest.current || currentRequest.current.fingerprint !== fingerprint) currentRequest.current = {
      fingerprint, clientRequestId: !currentRequest.current && pending?.phase === "prepare" && pending.materialRevision === materialRevision ? pending.clientRequestId : uuid(),
    };
    return { fingerprint, titleRevision: titleRevision.current, titleStyle: { ...titleStyle }, materials: {
      schemaVersion: "cover-prepare/1", clientRequestId: currentRequest.current.clientRequestId, materialRevision,
      text, assets: materials.flatMap((asset) => asset.assetId ? [{ assetId: asset.assetId, role: asset.role, ...(asset.imageNumber ? { imageNumber: asset.imageNumber } : {}) }] : []),
      styleKey, outputRatio: ratio, ...(modelId ? { modelId } : {}), resolution,
      ...(customComposition && materials.length ? { imageMode: "compose" as const } : {}), ...(scenario === "product" && !preserveLegacyContentKind ? { contentKind: "product" as const } : {}), ...(manualTitle && title.trim() ? { manualTitle: title } : {}),
    } };
  }
  async function prepareRequest(body: Record<string, unknown>): Promise<PreparedCover> {
    const action = body.action === "analyze" ? "analyze" : "prepare";
    const { action: _action, ...input } = body; void _action;
    const response = await fetch(`/api/cover-workbench/${action}`, { method: "POST", headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const data = await response.json().catch(() => ({})) as PreparedCover;
    if (!response.ok && data.code === "COVER_PREPARATION_STALE" && data.reprepareRequired === true) {
      throw Object.assign(new Error(data.error || "制作方案已更新，请重新准备。"), { code: data.code, reprepareRequired: true });
    }
    if (!response.ok && !["unknown", "needs_input", "failed"].includes(data.status)) throw new Error(data.error || "制作方案暂未准备完成");
    if (!data.operationId || !["prepared", "analyzing", "needs_input", "plan_ready", "review_ready", "unknown", "failed"].includes(data.status)) throw new Error("制作任务状态不完整，请查询原任务后再继续");
    return data;
  }
  function applyPrepared(result: PreparedCover, snapshot: Snapshot) {
    if (!currentOwner()) return;
    setRecoveryIssue(result.analysisIssue || null);
    persistPending({ operationId: result.operationId, clientRequestId: snapshot.materials.clientRequestId,
      materialRevision: snapshot.materials.materialRevision, workflowVersion: 3, phase: result.status === "prepared" ? "prepare" : result.status === "review_ready" ? "review" : "analysis" });
    if (fingerprintRef.current === snapshot.fingerprint) {
      setBinding({ result, snapshot });
      if (result.analysis?.status === "ready") {
        let nextDraft = reviewDraftFromAnalysis(result.analysis);
        try { const stored = JSON.parse(localStorage.getItem(`cover-review:${identity.userId}:${result.operationId}`) || "null");
          if (stored?.analysisHash === result.analysisHash && stored.draft?.primaryTitle && stored.draft?.visualBrief) nextDraft = stored.draft;
        } catch { /* Only a local editable draft; server validates every confirmed field. */ }
        setReviewDraft(nextDraft); setConfirmed(null);
      }
      if (result.analysis?.status === "ready") setAnalysisBinding({ fingerprint: snapshot.fingerprint, analysis: result.analysis, ...(result.layoutPlan ? { layoutPlan: result.layoutPlan } : {}) });
      if (result.renderPlan?.title && !manualTitleRef.current && titleRevision.current === snapshot.titleRevision) setTitle(result.renderPlan.title);
      if (result.renderPlan?.titleStyle && !titleStyleTouched.current) {
        setTitleStyle({ x: .08, y: .07, width: .84, scale: 1, color: "#FFF1B8", ...result.renderPlan.titleStyle });
      }
    }
    setNotice(result.notices?.join(" ") || "");
    if (result.status === "unknown" || result.status === "analyzing") { setUncertain(true); setError(result.error || "分析结果尚未确认，请查询原任务，避免重复费用。"); }
    else if (result.status === "failed" || result.status === "needs_input") {
      setError(result.error || result.notices?.join(" ") || "请补充材料后再继续。");
      if (!result.analysisIssue?.canRecoverFromReceipt) persistPending(null);
    }
  }
  async function renderOriginal(sourceAssetId: string, renderPlan: WorkbenchRenderPlan, briefText: string, prompt = "", guard: SelectionGuard = {}) {
    const response = await fetch("/api/cover/render", { method: "POST", headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceAssetId, plan: renderPlan, authoring: { briefText, prompt } }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.persisted !== true || data.cloudStored !== true || !data.assetId || !data.historyRecordId
        || data.renderedText?.title !== renderPlan.title || data.width !== renderPlan.outputSpec.width || data.height !== renderPlan.outputSpec.height) {
      throw new Error(data.error || "封面保存尚未确认，可重试排版；不会重新生成图片");
    }
    const task: CoverGenerationTask = { id: `cover-render-${data.assetId}`, title: renderPlan.title, subtitle: renderPlan.subtitle, ratio: renderPlan.aspectRatio,
      prompt, briefText, source: "生成", status: "done", createdAt: data.createdAt || new Date().toISOString(), taskNo: data.taskNo || 1,
      renderPlan, backgroundAssetId: sourceAssetId, assetId: data.assetId, historyRecordId: data.historyRecordId, storageKey: data.key,
      url: data.url, cloudStored: true, outputWidth: data.width, outputHeight: data.height, sourceWidth: data.sourceWidth, sourceHeight: data.sourceHeight };
    if (currentOwner()) adoptTask(task, guard);
    return task;
  }
  async function reviewRequest<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/cover-workbench/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${identity.token}`, "Content-Type": "application/json" }, cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "操作暂未完成，请查询原任务"), { code: data.code, status: response.status, quote: data.quote,
      action: data.action, originalConfirmationId: data.originalConfirmationId });
    return data as T;
  }
  function changeReviewDraft(next: CoverReviewDraft) {
    if (busy || uncertain || confirmed || !freshBinding) return;
    setReviewDraft(next); confirmationRequest.current = null;
    try { localStorage.setItem(`cover-review:${identity.userId}:${freshBinding.result.operationId}`,
      JSON.stringify({ analysisHash: freshBinding.result.analysisHash, draft: next })); } catch { /* Server confirmation remains authoritative. */ }
  }
  async function receiveReviewExecution(first: CoverReviewExecution, snapshot?: Snapshot) {
    let result = first;
    for (let poll = 0; currentOwner(); poll++) {
      if (result.status === "confirmed" || (result.status === "claimed" && result.canPoll === false)) {
        setUncertain(false); setError("");
        setNotice(result.issue?.message || "方案已保留，图片尚未提交。可继续已确认的生成。"); return;
      }
      const task = result.task || result.activeAttempt?.task;
      if (task) {
        if (snapshot) { submissionBindings.current.set(task.id, snapshot.fingerprint); submissionBindings.current.set(result.confirmationId, snapshot.fingerprint); }
        adoptTask(task, snapshot ? { fingerprint: snapshot.fingerprint, editorRevision: snapshot.editorRevision } : { select: true });
      }
      if (result.status === "completed" && task && isSavedCoverTask(task)) {
        const currentSubmission = snapshot && fingerprintRef.current === snapshot.fingerprint
          && snapshot.editorRevision !== undefined && editorRevision.current === snapshot.editorRevision;
        if (currentSubmission && task.backgroundAssetId && task.renderPlan && coverTextRendering(task.renderPlan).mode !== "native") {
          // The completed overlay is already saved. Its exact frozen editor
          // values prevent an untouched result from becoming a new dirty draft.
          setTitle(task.renderPlan.title); setRatio(task.ratio); setStyleKey(task.renderPlan.coverModeId || styleKey);
          if (task.renderPlan.titleStyle) setTitleStyle({ x: .08, y: .07, width: .84, scale: 1, color: "#583A27", ...task.renderPlan.titleStyle });
        }
        setUncertain(false); persistPending(null);
        setNotice(snapshot && !currentSubmission ? "原任务已完成，当前草稿保留不变。请从历史作品打开该结果。" : "封面已保存，可检查成品并下载。");
        void refreshHistory(); return;
      }
      if (result.status === "failed") {
        setUncertain(false); setConfirmed(null); confirmationRequest.current = null;
        persistPending(freshBinding ? { workflowVersion: 3, operationId: freshBinding.result.operationId,
          clientRequestId: freshBinding.snapshot.materials.clientRequestId, phase: "review", materialRevision } : null);
        setError(result.error || result.issue?.message || "本次生成已结束，未完成封面。原费用记录已保留。");
        setNotice("本次失败记录已保留。可回到拆解方案修改后，再明确确认新版本。"); return;
      }
      if (!result.canPoll || !["claimed", "submitted", "delivery_pending"].includes(result.status) || poll >= 90) {
        setUncertain(true); setError(result.error || result.issue?.message || "原任务仍待确认，请查询状态；不会重新提交生成。"); return;
      }
      await new Promise(resolve => window.setTimeout(resolve, 2000));
      if (!currentOwner()) return;
      result = await reviewRequest<CoverReviewExecution>(`execute?confirmationId=${encodeURIComponent(result.confirmationId)}`);
    }
  }
  async function confirmAndGenerate() {
    if (requestGate.current || busy || uncertain || !freshBinding || !reviewDraft) return;
    const parent = freshBinding.result;
    if (parent.status !== "review_ready" || !parent.analysisHash || !parent.quote?.imageQuoteHash) {
      setError("当前方案缺少确认依据，请查询原分析任务。"); return;
    }
    requestGate.current = true; setBusy("generating"); setError("");
    const requestHash = canonicalCoverValue({ operationId: parent.operationId, analysisHash: parent.analysisHash,
      imageQuoteHash: parent.quote.imageQuoteHash, edits: reviewDraft });
    if (confirmationRequest.current?.hash !== requestHash) confirmationRequest.current = { hash: requestHash, key: uuid() };
    const clientRequestId = confirmationRequest.current.key;
    const generationSnapshot = { ...freshBinding.snapshot, editorRevision: editorRevision.current };
    let executeStarted = false;
    try {
      let child = confirmed;
      if (!child) {
        persistPending({ workflowVersion: 3, clientRequestId, phase: "confirmation", materialRevision });
        child = await reviewRequest<PreparedCover>("confirm", { operationId: parent.operationId, clientRequestId,
          expectedAnalysisHash: parent.analysisHash, edits: reviewDraft, expectedImageQuoteHash: parent.quote.imageQuoteHash, consent: { image: true } });
        if (!currentOwner()) return;
        setConfirmed(child);
      }
      const confirmationId = child.confirmationId || child.operationId;
      persistPending({ workflowVersion: 3, operationId: confirmationId, clientRequestId, phase: "generation", materialRevision });
      executeStarted = true;
      const result = await reviewRequest<CoverReviewExecution>("execute", { confirmationId });
      if (currentOwner()) await receiveReviewExecution(result, generationSnapshot);
    } catch (cause) {
      if (currentOwner()) {
        if (cause instanceof Error && "status" in cause && cause.status === 409
          && "code" in cause && cause.code === "COVER_CONFIRMATION_QUERY_ORIGINAL"
          && "action" in cause && cause.action === "query_original"
          && "originalConfirmationId" in cause && typeof cause.originalConfirmationId === "string"
          && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(cause.originalConfirmationId)) {
          setConfirmed(null); confirmationRequest.current = null; setUncertain(true);
          persistPending({ workflowVersion: 3, operationId: cause.originalConfirmationId, clientRequestId, phase: "generation", materialRevision });
          setError(message(cause, "原确认订单仍待查询。"));
          setNotice("你的拆解修改已保留。请点击“查询原任务状态”读取原订单；不会重新分析或提交图片。");
          return;
        }
        const definitiveRejection = !executeStarted && cause instanceof Error && "status" in cause && typeof cause.status === "number" && cause.status >= 400 && cause.status < 500;
        setUncertain(!definitiveRejection); setError(message(cause, "确认或生成状态尚未确认，请查询原任务。"));
        if (definitiveRejection && "quote" in cause && isRecord(cause.quote) && typeof cause.quote.imageQuoteHash === "string") {
          const nextQuote = cause.quote as PreparedCover["quote"];
          setBinding(previous => previous?.result.operationId === parent.operationId
            ? { ...previous, result: { ...previous.result, quote: nextQuote } } : previous);
          confirmationRequest.current = null;
          setNotice("图片费用已更新，请核对后再次确认。原分析和你的修改均已保留。");
        }
        if (definitiveRejection) persistPending({ workflowVersion: 3, operationId: parent.operationId,
          clientRequestId: freshBinding.snapshot.materials.clientRequestId, phase: "review", materialRevision });
      }
    } finally { requestGate.current = false; if (currentOwner()) setBusy(null); }
  }
  async function primaryAction() {
    if (requestGate.current || busy || uncertain) return;
    if (freshBinding?.result.status === "review_ready") { setNotice("请检查右侧拆解方案，确认后再生成封面。"); return; }
    if (freshBinding && ["failed", "needs_input"].includes(freshBinding.result.status)) { setError(freshBinding.result.error || "请先查询原任务，或按提示调整材料。"); return; }
    if (!text.trim() && !title.trim()) { setError(scenario === "product" ? "请先填写商品介绍。" : "请先填写文案或封面标题。"); return; }
    if ((scenario === "reference" || scenario === "background") && !materials.length) {
      setError(scenario === "reference" ? "请先添加参考封面。" : "请先添加背景图片。"); return;
    }
    if (materials.some((asset) => asset.status !== "ready")) { setError("请等待图片上传完成，或移除失败的图片后重试。"); return; }
    if (originalLayout && referenceCount === 0 && manualTitle && title.trim()) { await saveOrDownload(false); return; }
    requestGate.current = true; setError("");
    const snapshot = freshBinding ? { ...freshBinding.snapshot, titleStyle: { ...titleStyle } } : makeSnapshot();
    const wasAnalysis = Boolean(freshBinding);
    setBusy(wasAnalysis ? "analyzing" : "preparing");
    persistPending({ clientRequestId: snapshot.materials.clientRequestId, materialRevision: snapshot.materials.materialRevision,
      phase: wasAnalysis ? "analysis" : "prepare", workflowVersion: 3, ...(freshBinding ? { operationId: freshBinding.result.operationId } : {}) });
    try {
      const result = await prepareRequest(freshBinding
        ? { action: "analyze", operationId: freshBinding.result.operationId, consent: { analysis: true } }
        : { action: "prepare", materials: snapshot.materials });
      if (!currentOwner()) return;
      applyPrepared(result, snapshot);
      if (result.status === "review_ready") setNotice("拆解已完成。请检查并编辑右侧方案，确认后再生成封面。");
      else if (result.status === "prepared") setNotice("已准备就绪，可以开始拆解。");
    } catch (cause) {
      if (currentOwner()) {
        if (cause instanceof Error && "code" in cause && cause.code === "COVER_PREPARATION_STALE" && "reprepareRequired" in cause && cause.reprepareRequired === true) {
          setBinding(null); persistPending(null); currentRequest.current = null; setUncertain(false);
          setError(message(cause, "制作方案已更新，请重新准备。"));
          setNotice("文案和图片已保留。此次未发起新的分析或生图，重新准备拆解并确认费用。");
        } else { setError(message(cause, "制作尚未完成，请查询原任务")); setUncertain(wasAnalysis); }
      }
    } finally { requestGate.current = false; if (currentOwner()) setBusy(null); }
  }
  async function recover(reopening = false) {
    if (!pending || requestGate.current) return;
    requestGate.current = true; setBusy("preparing"); setError("");
    try {
      const query = new URLSearchParams(pending.operationId ? { operationId: pending.operationId } : { clientRequestId: pending.clientRequestId });
      if (pending.workflowVersion === 3 || reopening) {
        const result = await reviewRequest<PreparedCover>(`operations?${query}`);
        if (!currentOwner()) return;
        if (result.generationStarted) {
          // These are pre-review-workflow images. The next explicit query must
          // use their original generation receipt, even if the browser stored a newer marker.
          persistPending({ operationId: result.operationId, clientRequestId: pending.clientRequestId,
            phase: "generation", materialRevision: pending.materialRevision });
          setUncertain(true); setNotice("原单已有生图记录，请查询原任务查看交付状态。"); return;
        }
        if (result.kind === "confirmation") {
          setConfirmed(result);
          const confirmationId = result.confirmationId || result.operationId;
          const execution = await reviewRequest<CoverReviewExecution>(`execute?confirmationId=${encodeURIComponent(confirmationId)}`);
          if (!currentOwner()) return;
          if (execution.status === "confirmed" || (execution.status === "claimed" && execution.canPoll === false)) {
            setUncertain(false); setRecoverable(result); setNotice("方案已确认，尚未提交图片。恢复方案后可继续生成。");
            if (reopening) await restorePrepared(result, true);
            return;
          }
          if (execution.status === "failed") {
            if (!result.originalAnalysisOperationId) throw new Error("失败记录缺少原分析关联，请保留原任务并联系管理员。");
            const original = await reviewRequest<PreparedCover>(`operations?operationId=${encodeURIComponent(result.originalAnalysisOperationId)}`);
            if (!currentOwner()) return;
            await receiveReviewExecution(execution);
            setRecoverable(original);
            persistPending({ workflowVersion: 3, operationId: original.operationId,
              clientRequestId: original.materials?.clientRequestId || pending.clientRequestId, phase: "review" });
            setNotice("本次生成失败。恢复原分析方案后可修改并确认新版本，原分析不重复收费。"); return;
          }
          await receiveReviewExecution(execution); return;
        }
        setRecoveryIssue(result.analysisIssue || null);
        if (["analyzing", "unknown"].includes(result.status)) { setUncertain(true); setError(result.error || "原分析仍在处理中，请稍后查询。"); return; }
        setUncertain(false);
        if (result.materials && ["prepared", "review_ready"].includes(result.status)) {
          setRecoverable(result); setNotice("原分析已找到。恢复方案即可继续编辑，不会重复分析。");
          if (reopening) await restorePrepared(result, true);
        } else { setError(result.error || "原分析未完成，请按提示处理。"); if (!result.analysisIssue?.canRecoverFromReceipt) persistPending(null); }
        return;
      }
      const response = await fetch(`/api/cover/prepare?${query}`, { headers: { Authorization: `Bearer ${identity.token}` }, cache: "no-store" });
      const result = await response.json().catch(() => ({})) as PreparedCover;
      if (!response.ok) throw new Error(result.error || "原任务状态暂时无法确认");
      if (!currentOwner()) return;
      setRecoveryIssue(result.analysisIssue || null);
      if (!result.operationId) {
        if (pending.operationId) throw new Error("原任务记录暂不可用，请稍后查询；不会重新提交生成。");
        setUncertain(false); persistPending(null); setNotice("未找到已提交的制作任务，可重新准备当前方案。"); return;
      }
      if (["unknown", "analyzing"].includes(result.status)) { setError(result.error || "原任务仍未确认，请稍后再次查询。不会重复提交分析。"); return; }
      setUncertain(false);
      if (result.status === "plan_ready" && result.route !== "original_layout" && result.generationIdentity) {
        const restored = await runCoverGeneration({ userId: identity.userId, token: identity.token, storage: storage.current, recovery: true,
          identity: result.generationIdentity, ...(result.task ? { task: result.task } : {}),
          isCurrentPageActive: currentOwner, onState: (state) => receiveState(state, { select: false }) });
        if (!currentOwner()) return;
        receiveState(restored.state, { select: false }); setNotice(restored.message);
        if (restored.state.pending) { setUncertain(true); return; }
        const existing = restored.state.history.find((task) => task.prepareOperationId === result.operationId);
        if (existing && ["done", "display_pending", "failed", "cancelled"].includes(existing.status)) {
          if (["done", "display_pending"].includes(existing.status) && !isSavedCoverTask(existing)) {
            setUncertain(true); setError("原图已经生成，成品保存仍待确认。请保留原任务，不要重复制作。"); return;
          }
          adoptTask(existing, { select: false }); persistPending(null); void refreshHistory(); return;
        }
      }
      if (["prepared", "plan_ready"].includes(result.status) && result.materials) {
        setRecoverable(result);
        setNotice(result.status === "plan_ready" ? "原任务分析已完成，可恢复原任务材料后继续；不会重复分析。" : "原任务尚未开始分析，可恢复其材料并确认费用。");
      } else { setError(result.error || "原任务已结束，请查看历史作品。"); if (!result.analysisIssue?.canRecoverFromReceipt) persistPending(null); }
      void refreshHistory();
    } catch (cause) {
      if (!currentOwner()) return;
      if (pending.phase === "prepare" && !pending.operationId && cause instanceof Error && "code" in cause && cause.code === "COVER_OPERATION_NOT_FOUND") {
        // Only a free preparation with no server ID can fall back to the entry form.
        if (pending.materialRevision === materialRevision) currentRequest.current = { fingerprint: fingerprintRef.current, clientRequestId: pending.clientRequestId };
        persistPending(null); setUncertain(false); setNotice("上次准备未创建任务，可继续准备当前文案。"); return;
      }
      setUncertain(true); setError(message(cause, "原任务尚未确认"));
    }
    finally { requestGate.current = false; if (currentOwner()) setBusy(null); }
  }
  async function restorePrepared(result = recoverable, reopening = false) {
    if (!result || (busy && !reopening)) return;
    setBusy("preparing"); setError("");
    try {
      const recoveredChild = result.kind === "confirmation" ? result : null;
      if (recoveredChild) {
        if (!recoveredChild.originalAnalysisOperationId) throw new Error("确认记录缺少原分析关联，请保留任务并联系管理员。");
        result = await reviewRequest<PreparedCover>(`operations?operationId=${encodeURIComponent(recoveredChild.originalAnalysisOperationId)}`);
      } else if (result.status === "plan_ready" && result.workflowVersion !== 3) {
        result = await reviewRequest<PreparedCover>(`operations?operationId=${encodeURIComponent(result.operationId)}`);
        if (result.generationStarted) throw new Error("这个历史任务已经提交图片，请查询原任务或从历史作品查看。");
      }
      const saved = result.materials;
      if (!saved) throw new Error("原任务材料尚未完整读取，请稍后查询。");
      const restoredTitle = saved.manualTitle || result.renderPlan?.title || "";
      const restoredStyle = saved.styleKey as CoverVisualStyle;
      const restoredResolution = saved.resolution || "2K";
      const restoredFingerprint = canonicalCoverValue({ text: saved.text, assets: saved.assets, styleKey: restoredStyle, ratio: saved.outputRatio,
        modelId: saved.modelId || "", resolution: restoredResolution, ...(saved.contentKind === "product" ? { contentKind: "product" } : {}),
        ...(saved.imageMode === "compose" ? { imageMode: "compose" } : {}),
        ...(saved.manualTitle ? { manualTitle: restoredTitle } : {}) });
      if (!currentOwner()) return;
      const canRestoreDraft = () => !reopening || (editorRevision.current === 0 &&
        (!hadBrowserDraft.current || fingerprintRef.current === restoredFingerprint));
      if (!canRestoreDraft()) { setNotice("原任务已找到，当前草稿有不同的内容。点击“恢复原任务材料”可切回原方案。"); return; }
      const restored = await Promise.all(saved.assets.map(async (asset, index): Promise<WorkbenchMaterial> => ({
        id: uuid(), assetId: asset.assetId, role: asset.role, name: `原任务图片 ${index + 1}`, status: "ready", previewUrl: ownedUrl(await authFetch(asset.assetId)),
        ...(asset.imageNumber ? { imageNumber: asset.imageNumber } : {}),
      })));
      if (!currentOwner()) return;
      if (!canRestoreDraft()) { setNotice("已保留刚刚修改的草稿，可手动恢复原任务材料。"); return; }
      setText(saved.text); setMaterials(restored); setScenarioState(saved.contentKind === "product" ? "product" : inferCoverScenario(restored)); setStyleKey(restoredStyle); setRatio(saved.outputRatio); setModelId(saved.modelId || ""); setResolution(restoredResolution);
      setImageModeState(saved.imageMode === "compose" ? "compose" : "preserve");
      setPreserveLegacyContentKind(saved.contentKind !== "product" && inferCoverScenario(restored) === "product");
      nextImageNumber.current = Math.max(1, ...restored.map((asset) => (asset.imageNumber || 0) + 1));
      setTitle(restoredTitle); setManualTitle(Boolean(saved.manualTitle)); manualTitleRef.current = Boolean(saved.manualTitle);
      titleRevision.current += 1; editorRevision.current += 1; setMaterialRevision(saved.materialRevision);
      currentRequest.current = { fingerprint: restoredFingerprint, clientRequestId: saved.clientRequestId };
      const restoredTitleStyle = { x: .08, y: .07, width: .84, scale: 1, color: "#583A27", ...result.renderPlan?.titleStyle };
      if (!reopening || !titleStyleTouched.current) setTitleStyle(restoredTitleStyle);
      titleStyleTouched.current = true; setSelected(null);
      setBinding({ result, snapshot: { materials: saved, fingerprint: restoredFingerprint, titleRevision: titleRevision.current, titleStyle: restoredTitleStyle } });
      if (result.analysis) {
        let draft = recoveredChild?.confirmedPlan || reviewDraftFromAnalysis(result.analysis);
        if (!recoveredChild) {
          try { const stored = JSON.parse(localStorage.getItem(`cover-review:${identity.userId}:${result.operationId}`) || "null");
            if (stored?.analysisHash === result.analysisHash && stored.draft?.primaryTitle && stored.draft?.visualBrief) draft = stored.draft;
          } catch { /* Restore the analysis if the optional draft is unreadable. */ }
        }
        setReviewDraft(draft); setConfirmed(recoveredChild);
      }
      if (result.analysis?.status === "ready") setAnalysisBinding({ fingerprint: restoredFingerprint, analysis: result.analysis, ...(result.layoutPlan ? { layoutPlan: result.layoutPlan } : {}) });
      persistPending({ workflowVersion: 3, operationId: recoveredChild?.operationId || result.operationId,
        clientRequestId: recoveredChild?.materials?.clientRequestId || saved.clientRequestId,
        materialRevision: saved.materialRevision, phase: recoveredChild ? "generation" : result.status === "prepared" ? "prepare" : "review" });
      setRecoverable(null); setNotice("已恢复原任务材料。确认后会继续原任务，不会重复购买同一次分析。");
    } catch (cause) { if (currentOwner()) setError(message(cause, "原任务图片无法读取，请保留任务记录后联系管理员。")); }
    finally { if (currentOwner()) setBusy(null); }
  }
  async function saveCurrent(): Promise<CoverGenerationTask> {
    const expectedRevision = editorRevision.current;
    if (selected && !editableSelected) return selected;
    if (!title.trim()) throw new Error("请先填写封面标题。");
    if (title.length > 80 || title.split(/\r?\n/u).length > 3) throw new Error("封面标题最多 80 字、3 行，请调整后再保存。");
    if (selected && editableSelected) {
      if (!dirty) return selected;
      const next = await saveCoverCompositionEdit({ userId: identity.userId, token: identity.token, task: selected, plan,
        storage: storage.current, onState: (state) => receiveState(state, { editorRevision: expectedRevision }) });
      const saved = next.history[0];
      if (!saved?.assetId || saved.status !== "done") throw new Error("排版保存尚未确认，请稍后查询。");
      return saved;
    }
    if (selected) return selected;
    if (!originalMaterial?.assetId) throw new Error("请先生成封面，或添加一张图片并选择保留原图。");
    return renderOriginal(originalMaterial.assetId, plan, text, "", { editorRevision: expectedRevision });
  }
  async function saveOrDownload(download: boolean) {
    if (busy || uncertain || requestGate.current) return;
    if (previewSourceAssetId && (!selected || dirty) && (previewBusy || !currentRenderedPreviewUrl || renderedPreviewError)) {
      setError(renderedPreviewError || "当前排版预览正在更新，请稍后保存。"); return;
    }
    requestGate.current = true; setBusy(download ? "downloading" : "rendering"); setError("");
    const revision = editorRevision.current;
    try {
      // Open before any network await, while the download click still has user activation.
      const file = download && mainWorkspace ? await chooseCoverFile(selected?.ratio || ratio,
        !dirty && previewFormat.current?.task === selected ? previewFormat.current.mime : undefined) : null;
      if (!currentOwner() || revision !== editorRevision.current) return;
      const saved = await saveCurrent();
      if (!currentOwner()) return;
      if (revision !== editorRevision.current) { setNotice("刚才的版本已保存，当前还有新修改，请再次保存或下载。"); return; }
      if (download) {
        const blob = await fetchCoverResultBlob(saved, identity.token);
        if (!currentOwner() || revision !== editorRevision.current) return;
        if (file) {
          await writeCoverFile(file, blob);
          if (currentOwner()) setNotice(`封面已保存为「${file.handle.name}」。`);
        } else {
          const anchor = document.createElement("a");
          anchor.href = ownedUrl(blob); anchor.download = coverExportName(saved.ratio, blob.type);
          anchor.click(); setNotice("已交给浏览器下载，保存位置遵循浏览器设置。");
        }
      } else setNotice("当前排版已保存，可从历史作品继续编辑。");
    } catch (cause) {
      if (currentOwner()) {
        if (download && cause instanceof DOMException && cause.name === "AbortError") setNotice("已取消下载。");
        else setError(message(cause, "保存或下载暂未完成"));
      }
    }
    finally { requestGate.current = false; if (currentOwner()) setBusy(null); }
  }
  function openHistory(task: CoverGenerationTask) {
    if (busy) return;
    setAutomaticLayoutTaskId("");
    setSelected(task); setHistoryOpen(false); setPreviewError("");
    setAnalysisBinding(null);
    setTitle(task.title); setManualTitle(true); titleRevision.current += 1;
    if (task.renderPlan && (task.renderPlan as { planVersion?: number }).planVersion === 2) {
      setRatio(task.ratio); setStyleKey(task.renderPlan.coverModeId || "cartoon");
      const savedStyle = task.renderPlan.titleStyle;
      if (savedStyle) { setTitleStyle({ x: .08, y: .07, width: .84, scale: 1, color: "#583A27", ...savedStyle }); titleStyleTouched.current = true; }
      setNotice(coverTextRendering(task.renderPlan).mode === "native"
        ? "已打开完整含字封面，可直接下载。请核对图片中的中文；更换标题需要制作新封面并确认费用。"
        : "已打开保存版本，修改标题和排版不会重新生成图片。");
    } else setNotice("此历史作品使用旧排版版本，可查看和下载；完整编辑需要原始图层。");
    editorRevision.current += 1;
  }
  function newDraft() {
    if (busy) return;
    setSelected(null); setBinding(null); setAnalysisBinding(null); setReviewDraft(null); setConfirmed(null); setPreviewError(""); currentRequest.current = null;
    editorRevision.current += 1; setNotice("已回到新封面草稿，可继续修改文案、图片和标题。");
  }

  let blockedReason = "";
  if (!draftReady) blockedReason = "正在恢复当前账号的草稿，请稍候。";
  else if (uncertain) blockedReason = "原任务结果尚未确认，请先查询原任务，避免重复费用。";
  else if (scenario === "background" && !materials.length) blockedReason = "请添加一张背景图片，再输入文案或封面标题。";
  else if (scenario === "reference" && !materials.length) blockedReason = "请添加至少一张参考封面，再输入新封面的文案。";
  else if (!text.trim() && !title.trim()) blockedReason = scenario === "product" ? "请先填写商品介绍。" : "请先填写文案或封面标题。";
  else if (materials.some((item) => item.status === "uploading")) blockedReason = "图片正在上传，请稍候。";
  else if (materials.some((item) => item.status === "failed")) blockedReason = "请移除上传失败的图片后重新添加。";
  else if (scenario === "script" && (stylesLoading || stylesError || !styleChoices.some(item => item.styleKey === styleKey))) blockedReason = stylesError || (stylesLoading ? "正在读取画面风格。" : "原风格已不在可选目录，请重新选择。" );
  else if (!customComposition && materials.filter((item) => item.role !== "style_reference").length > 1) blockedReason = "请选择一张需要完整保留的图片，将其余图片设为参考配色和布局。";
  else if (!originalLayout && modelsState !== "ready") blockedReason = modelsError || "正在读取图片生成模型。";
  else if (!originalLayout && (!activeModel || !activeModel.available || !activeModel.priceReady)) blockedReason = activeModel?.message || "当前模型或价格尚未就绪，请选择其他模型。";
  else if (!originalLayout && resolution === "1K") blockedReason = "标准封面需要 2K 或 4K 底图，请提高生成清晰度。";
  else if (!originalLayout && activeModel?.resolutions.length && !activeModel.resolutions.includes(resolution)) blockedReason = "当前模型不支持所选清晰度，请重新选择。";
  else if (!originalLayout && referenceCount && activeModel?.referenceSupport === false) blockedReason = "当前模型不支持参考图片，请更换模型或调整图片用途。";
  else if (!originalLayout && referenceCount && activeModel && activeModel.maxReferences !== null && referenceCount > activeModel.maxReferences) blockedReason = "参考图片数量超过当前模型限制，请调整图片用途或数量。";
  else if (freshBinding && ["needs_input", "failed"].includes(freshBinding.result.status)) blockedReason = freshBinding.result.error || "请补充或调整材料后重新准备方案。";
  const fee = confirmed?.quote || freshBinding?.result.quote;
  const imageAmount = fee?.image?.amount ?? activeModel?.prices[resolution] ?? (activeModel?.defaultResolution === resolution ? activeModel.price : null);
  const feeText = originalLayout && referenceCount === 0 && manualTitle && title.trim() ? "仅保存排版，无模型调用费用" : originalLayout ? "不生成新图片；分析费用以确认方案为准"
    : fee?.image?.unit === "credits" ? `图片 ${imageAmount ?? "待确认"} 积分` : imageAmount != null ? `图片${freshBinding ? "" : "预计"} ¥${Number(imageAmount).toFixed(2)}` : "图片费用待确认";
  const chargedAnalysis = freshBinding?.result.analysisBilling?.creditsCharged;
  const analysisFeeText = typeof chargedAnalysis === "number" && chargedAnalysis > 0 ? `内容分析已计费 ${chargedAnalysis} 积分；编辑方案不重复收费`
    : originalLayout && referenceCount === 0 && manualTitle && title.trim() ? "直接使用已填写的标题"
    : ["plan_ready", "review_ready"].includes(freshBinding?.result.status || "") ? "原任务分析已完成，编辑和确认方案不重复分析"
    : fee?.analysis?.amount === 0 ? "本次无需付费分析"
    : fee?.analysis?.amount != null ? `内容分析 ${fee.analysis.amount} 积分`
      : "内容分析按实际用量计费，无法预先确定总额";
  const processText = busy === "preparing" ? "正在准备制作方案" : busy === "analyzing" ? "正在分析文案与图片"
    : busy === "generating" ? "正在生成画面并完成排版" : busy === "rendering" ? "正在保存排版" : busy === "downloading" ? "正在准备当前版本下载"
      : selected?.status === "unknown" || uncertain ? "结果尚未确认" : selected?.status === "running" ? "任务处理中"
        : isSavedCoverTask(selected) ? dirty ? "有未保存的排版修改" : "已保存，可下载"
          : selected?.status === "done" || selected?.status === "display_pending" ? "画面已生成，成品保存尚未确认"
            : freshBinding?.result.status === "review_ready" ? "拆解已完成，等待你确认方案" : "添加内容后开始拆解";
  return {
    text, materials, scenario, setScenario, imageMode, setImageMode, customComposition, inactiveImageCount: scenario === "script" ? storedMaterials.length : 0,
    styleKey, ratio, modelId, resolution, models, modelsState, modelsError, activeModel,
    styleChoices, stylesLoading, stylesError, reloadStyles,
    title, titleStyle, selected, results, historyOpen, historyBusy, historyError, historyNext,
    previewUrl, backgroundUrl, previewError, renderedPreviewUrl: currentRenderedPreviewUrl, previewBusy, renderedPreviewError, originalMaterial, originalLayout, nativeSelected, editableSelected, dirty,
    generatedOverlayLayout, canApplyAutomaticLayout, applyAutomaticLayout,
    busy, notice, error, uncertain, pending, recoverable, draftReady, blockedReason, freshBinding, feeText, analysisFeeText, processText, originalOrderDisplay,
    analysisModelName: fee?.analysis?.modelName || "",
    analysisIssue: freshBinding?.result.analysisIssue || recoveryIssue || null,
    reviewDraft, confirmed, changeReviewDraft, confirmAndGenerate,
    reviewReady: freshBinding?.result.status === "review_ready" && Boolean(reviewDraft),
    resetReviewDraft: () => { if (freshBinding?.result.analysis) changeReviewDraft(reviewDraftFromAnalysis(freshBinding.result.analysis)); },
    analysis: visibleAnalysisBinding?.analysis || null,
    layoutPlan: visibleAnalysisBinding?.layoutPlan || null,
    setText: (value: string) => { setText(value); bump(); },
    setStyleKey: (value: CoverVisualStyle) => { setStyleKey(value); bump(); },
    setRatio: (value: CoverOutputRatio) => { setRatio(value); bump(); },
    setModelId: (value: string) => { setModelId(value); bump(); },
    setResolution: (value: string) => { if (["1K", "2K", "4K"].includes(value)) { setResolution(value as CoverResolution); bump(); } },
    changeTitle, changeTitleStyle, addFiles, removeMaterial, changeRole, reloadModels,
    primaryAction, recover, restorePrepared, saveOrDownload, openHistory, newDraft, refreshHistory, setHistoryOpen,
  };
}
