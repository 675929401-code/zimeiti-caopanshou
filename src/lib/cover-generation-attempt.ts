import { isConfirmedTerminalImageFailure } from "@/lib/image-workbench-attempt-guard";
import { coverCompositionMatches, coverCompositionValidationError, type CoverCompositionPlan } from "@/lib/cover-composition";
import { parsePublicImageResolutionPrices } from "@/lib/image-resolution-pricing";
import { projectGeneratedImageClientReceipt, resolveGeneratedImageClientDelivery, type GeneratedImageClientReceipt } from "@/lib/generated-image-client-delivery";
import { projectCoverCompositionPlan } from "@/lib/cover-durable-attempt";

export type CoverGenerationModel = {
  id: string;
  name: string;
  price: number | null;
  resolution: string;
  supportsReferenceInput: boolean;
  available: boolean;
  priceReady: boolean;
  availabilityMessage: string;
};

export function parseCoverGenerationModels(value: unknown): CoverGenerationModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id.startsWith("pm_") || typeof row.displayName !== "string") return [];
    const capabilities = (row.capabilities || {}) as Record<string, unknown>;
    const resolution = typeof capabilities.defaultResolution === "string" ? capabilities.defaultResolution : "1K";
    const resolutionPrices = parsePublicImageResolutionPrices(capabilities.resolutionPrices);
    const priceReady = capabilities.priceReady !== false;
    const available = capabilities.available !== false && priceReady;
    const basePrice = typeof row.publicPrice === "number" && Number.isFinite(row.publicPrice) && row.publicPrice >= 0
      ? row.publicPrice
      : null;
    return [{
      id: row.id,
      name: [row.displayName, row.variantLabel].filter(Boolean).join(" "),
      price: priceReady ? resolutionPrices[resolution] ?? basePrice : null,
      resolution,
      supportsReferenceInput: capabilities.supportsReferenceInput === true,
      available,
      priceReady,
      availabilityMessage: typeof capabilities.availabilityMessage === "string"
        ? capabilities.availabilityMessage
        : available ? "" : "模型配置尚未完成",
    }];
  });
}

export type CoverGenerationPayload = {
  prompt: string;
  modelId: string;
  mode: "local";
  style: string;
  aspectRatio: string;
  resolution: string;
  coverText: string;
  referenceImageUrls: string[];
  referenceUsage: "general";
  historySurface: "cover-studio";
  resumeDeliveryOnly?: true;
};

export type CoverGenerationTask = {
  id: string;
  ratio: "16:9" | "9:16" | "4:3" | "3:4";
  title: string;
  subtitle: string;
  prompt: string;
  source: "生成";
  briefText?: string;
  createdAt: string;
  taskNo: number;
  status: "running" | "done" | "display_pending" | "failed" | "unknown" | "cancelled";
  error?: string;
  url?: string;
  assetId?: string;
  storageKey?: string;
  historyRecordId?: string;
  operationId?: string;
  renderPlan?: CoverCompositionPlan;
  backgroundAssetId?: string;
  outputWidth?: number;
  outputHeight?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  cloudStored?: boolean;
  failureRecordId?: string;
  publicModelId?: string;
  modelName?: string;
  resolution?: "1K" | "2K" | "4K";
  referenceAssetRefs?: string[];
  referenceCount?: number;
  quotedPriceYuan?: number;
  billing?: {
    state: "charged" | "not_charged" | "exempt" | "unknown";
    referenceId: string;
    chargedAmount?: number;
  };
  canLoadForRetry?: boolean;
  retryBlockReason?: string;
  requiresReferenceReupload?: boolean;
  failureCode?: string;
  clientIdempotencyKey?: string;
  clientTraceId?: string;
  attemptState?: "claimed" | "dispatched" | "delivery_pending" | "completed" | "failed" | "cancelled";
  cancellable?: boolean;
  imageDeliveryReceipt?: GeneratedImageClientReceipt;
  revokePreview?: () => void;
  /** Current attempt RAM only; persistence projections deliberately omit this closure. */
  readPreviewBlob?: (binding: { recordId: string; url: string }) => Blob | null;
};

type PendingCoverGeneration = {
  payload?: CoverGenerationPayload;
  clientIdempotencyKey: string;
  clientTraceId: string;
  task: CoverGenerationTask;
  updatedAt: number;
};

type PersistedCoverAttemptReference = {
  clientIdempotencyKey: string;
  clientTraceId: string;
  updatedAt: number;
  task?: CoverGenerationTask;
  resumePayload?: CoverGenerationPayload;
};

type ServerCoverAttempt = {
  clientIdempotencyKey: string;
  clientTraceId: string;
  state: "claimed" | "dispatched" | "delivery_pending" | "completed" | "failed" | "cancelled";
  updatedAt: number;
  task: CoverGenerationTask;
  dispatchInput?: CoverGenerationPayload;
  canDispatch: boolean;
  requiresReferenceReupload: boolean;
  backgroundAssetId?: string;
};

export type CoverGenerationState = {
  version: 1;
  pending: PendingCoverGeneration | null;
  history: CoverGenerationTask[];
};

/** Read an already-owned history asset through the same-origin authenticated route. */
export async function fetchCoverResultBlob(
  task: Pick<CoverGenerationTask, "historyRecordId" | "url" | "imageDeliveryReceipt" | "readPreviewBlob">,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Blob> {
  let path: string;
  let headers: HeadersInit | undefined;
  if (task.imageDeliveryReceipt?.deliveryMode === "inline_ephemeral") {
    const blob = task.url?.startsWith("blob:") ? task.readPreviewBlob?.({ recordId: task.imageDeliveryReceipt.recordId, url: task.url }) : null;
    if (!blob || !/^image\/(?:png|jpeg|webp)$/u.test(blob.type) || !blob.size || blob.size > 30 * 1024 * 1024) throw new Error("临时封面仅原页面可下载；图片不可恢复，生成与费用收据仍保留");
    return blob;
  } else if (task.historyRecordId && /^[a-zA-Z0-9_.-]+$/u.test(task.historyRecordId)) {
    if (!token.trim()) throw new Error("请先登录后下载封面");
    path = `/api/media-history/content?${new URLSearchParams({ id: task.historyRecordId, index: "0", download: "1" })}`;
    headers = { Authorization: `Bearer ${token}` };
  } else if (task.url?.startsWith("/cover-generated-samples/") && !task.url.includes("..") && !/[?#\\]/u.test(task.url)) {
    path = task.url;
  } else {
    throw new Error("封面历史凭据不完整，请从图片历史中下载");
  }
  const response = await fetcher(path, { headers, cache: "no-store" });
  if (!response.ok) throw new Error("封面下载失败，请稍后重试");
  const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!/^image\/(?:png|jpeg|webp)$/u.test(contentType)) throw new Error("封面下载没有返回有效图片");
  const maximumBytes = 30 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximumBytes) throw new Error("封面图片超过下载上限");
  const blob = await response.blob();
  if (!blob.size || blob.size > maximumBytes) throw new Error("封面图片大小异常");
  return blob;
}

const stateKey = (userId: string) => `cover-generation:v1:${userId}`;
const PENDING_COVER_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const validKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const inMemoryPendingCoverRequests = new Map<string, PendingCoverGeneration>();

function parseClientCoverPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<CoverGenerationPayload>;
  if (typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 50_000
    || typeof row.modelId !== "string" || !row.modelId.startsWith("pm_") || row.modelId.length > 240
    || row.mode !== "local" || typeof row.style !== "string" || row.style.length > 2_000
    || !["16:9", "9:16", "4:3", "3:4"].includes(row.aspectRatio || "")
    || !["1K", "2K", "4K"].includes(row.resolution || "")
    || typeof row.coverText !== "string" || row.coverText.length > 200
    || !Array.isArray(row.referenceImageUrls) || row.referenceImageUrls.length > 5
    || row.referenceImageUrls.some(item => typeof item !== "string" || !item || item.length > 8 * 1024 * 1024)
    || row.referenceUsage !== "general" || row.historySurface !== "cover-studio") return null;
  const safe: CoverGenerationPayload = { prompt: row.prompt, modelId: row.modelId, mode: "local", style: row.style,
    aspectRatio: row.aspectRatio!, resolution: row.resolution!, coverText: row.coverText,
    referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio" };
  return { safe, references: row.referenceImageUrls };
}

function pendingPlaceholder(reference: PersistedCoverAttemptReference): PendingCoverGeneration {
  return {
    ...reference,
    task: {
      id: `cover-pending-${reference.clientTraceId}`,
      ratio: "3:4",
      title: "待确认的封面任务",
      subtitle: "",
      prompt: "",
      source: "生成",
      createdAt: new Date(reference.updatedAt).toISOString(),
      taskNo: 0,
      status: "unknown",
      error: "已提交任务仅保留安全追踪编号；请查询状态，终态结果从账号历史读取。",
    },
  };
}

function persistedCoverTask(value: unknown): CoverGenerationTask | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<CoverGenerationTask>;
  if (typeof row.id !== "string" || row.id.length > 200
    || !["16:9", "9:16", "4:3", "3:4"].includes(row.ratio || "")
    || typeof row.title !== "string" || row.title.length > 200
    || typeof row.subtitle !== "string" || row.subtitle.length > 500
    || typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 50_000
    || row.source !== "生成" || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || !Number.isSafeInteger(row.taskNo) || Number(row.taskNo) < 0
    || (row.briefText !== undefined && (typeof row.briefText !== "string" || row.briefText.length > 20_000))
    || (row.renderPlan !== undefined && Boolean(coverCompositionValidationError(row.renderPlan)))) return undefined;
  return {
    id: row.id,
    ratio: row.ratio!,
    title: row.title,
    subtitle: row.subtitle,
    prompt: row.prompt,
    source: "生成",
    createdAt: row.createdAt,
    taskNo: Number(row.taskNo),
    status: "unknown",
    error: "系统正在核验并完成封面保存和展示",
    ...(row.briefText !== undefined ? { briefText: row.briefText } : {}),
    ...(row.renderPlan ? { renderPlan: projectCoverCompositionPlan(row.renderPlan) } : {}),
  };
}

function persistedCoverResumePayload(value: unknown): CoverGenerationPayload | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<CoverGenerationPayload>;
  if (typeof row.prompt !== "string" || !row.prompt.trim() || row.prompt.length > 50_000
    || typeof row.modelId !== "string" || !row.modelId.startsWith("pm_") || row.modelId.length > 240
    || row.mode !== "local" || typeof row.style !== "string" || row.style.length > 2_000
    || !["16:9", "9:16", "4:3", "3:4"].includes(row.aspectRatio || "")
    || !["1K", "2K", "4K"].includes(row.resolution || "")
    || typeof row.coverText !== "string" || row.coverText.length > 200
    || !Array.isArray(row.referenceImageUrls) || row.referenceImageUrls.length !== 0
    || row.referenceUsage !== "general" || row.historySurface !== "cover-studio"
    || row.resumeDeliveryOnly !== true) return undefined;
  return { prompt: row.prompt, modelId: row.modelId, mode: "local", style: row.style,
    aspectRatio: row.aspectRatio!, resolution: row.resolution!, coverText: row.coverText,
    referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio", resumeDeliveryOnly: true };
}

function legacyCoverPayload(value: unknown): CoverGenerationPayload | undefined {
  const parsed = parseClientCoverPayload(value);
  if (!parsed) return undefined;
  return { ...parsed.safe, referenceImageUrls: parsed.references };
}

function serverCoverAttempt(value: unknown): ServerCoverAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const task = persistedCoverTask(row.task);
  const dispatch = parseClientCoverPayload(row.dispatchInput);
  if (!validKey(row.clientIdempotencyKey) || !validKey(row.clientTraceId) || !task
    || !["claimed", "dispatched", "delivery_pending", "failed", "cancelled"].includes(String(row.state))
    || !Number.isFinite(row.updatedAt) || typeof row.canDispatch !== "boolean"
    || typeof row.requiresReferenceReupload !== "boolean") return null;
  task.status = row.state === "claimed"
    ? "running"
    : row.state === "failed"
      ? "failed"
      : row.state === "cancelled" ? "cancelled" : "unknown";
  task.clientIdempotencyKey = row.clientIdempotencyKey;
  task.clientTraceId = row.clientTraceId;
  task.attemptState = row.state as ServerCoverAttempt["state"];
  task.cancellable = ["claimed", "dispatched", "delivery_pending"].includes(String(row.state));
  task.error = typeof (row.task as Record<string, unknown>).error === "string"
    ? String((row.task as Record<string, unknown>).error)
    : task.error;
  return {
    clientIdempotencyKey: row.clientIdempotencyKey,
    clientTraceId: row.clientTraceId,
    state: row.state as ServerCoverAttempt["state"],
    updatedAt: Number(row.updatedAt),
    task,
    ...(dispatch ? { dispatchInput: { ...dispatch.safe, referenceImageUrls: [] } } : {}),
    canDispatch: row.canDispatch,
    requiresReferenceReupload: row.requiresReferenceReupload,
    ...(typeof row.backgroundAssetId === "string" ? { backgroundAssetId: row.backgroundAssetId } : {}),
  };
}

function persistedReference(pending: PendingCoverGeneration): PersistedCoverAttemptReference {
  const task = persistedCoverTask(pending.task);
  const resumePayload = pending.payload ? persistedCoverResumePayload({
    ...pending.payload,
    referenceImageUrls: [],
    resumeDeliveryOnly: true,
  }) : undefined;
  return {
    clientIdempotencyKey: pending.clientIdempotencyKey,
    clientTraceId: pending.clientTraceId,
    updatedAt: Number.isFinite(pending.updatedAt) ? pending.updatedAt : Date.now(),
    ...(task ? { task } : {}),
    ...(resumePayload ? { resumePayload } : {}),
  };
}

function persistedCoverReceipt(value: unknown): CoverGenerationTask | null {
  const task = persistedCoverTask(value);
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const receipt = projectGeneratedImageClientReceipt(row.imageDeliveryReceipt);
  if (!task || receipt?.deliveryMode !== "inline_ephemeral") return null;
  return { ...task, status: "done", imageDeliveryReceipt: receipt, cloudStored: false, canLoadForRetry: false,
    error: "封面生成费用收据已保留；临时图片仅原页面可用，刷新后无法恢复",
    ...(validKey(row.clientIdempotencyKey) ? { clientIdempotencyKey: String(row.clientIdempotencyKey) } : {}),
    ...(validKey(row.clientTraceId) ? { clientTraceId: String(row.clientTraceId) } : {}),
    billing: { state: receipt.cashCharged > 0 ? "charged" : "exempt", referenceId: receipt.billingReferenceId || receipt.recordId, chargedAmount: receipt.cashCharged } };
}
function serializedAttemptState(reference: PersistedCoverAttemptReference | null, history: CoverGenerationTask[] = []) {
  return JSON.stringify({ version: 1, pending: reference, history: [], receipts: history.map(persistedCoverReceipt).filter(Boolean).slice(0,30) });
}

export function readCoverGenerationState(storage: Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>, userId: string): CoverGenerationState {
  const raw = storage.getItem(stateKey(userId));
  if (!raw) {
    inMemoryPendingCoverRequests.delete(userId);
    return { version: 1, pending: null, history: [] };
  }
  if (raw.length > 256 * 1024) throw new Error("封面任务记录过大，请保留记录并联系管理员");
  const parsed = JSON.parse(raw) as {
    version?: unknown;
    pending?: (Partial<PersistedCoverAttemptReference> & { payload?: unknown }) | null;
    receipts?: unknown[];
  };
  if (parsed.version !== 1) throw new Error("封面任务记录不可读取，请保留原记录并联系管理员");
  if (parsed.pending && (!validKey(parsed.pending.clientIdempotencyKey)
    || !validKey(parsed.pending.clientTraceId)
    || !Number.isFinite(parsed.pending.updatedAt))) {
    throw new Error("未完成的封面任务追踪编号不完整，请保留记录后查询，勿重新提交");
  }
  const reference = parsed.pending && Date.now() - Number(parsed.pending.updatedAt) <= PENDING_COVER_TTL_MS
    ? {
      clientIdempotencyKey: parsed.pending.clientIdempotencyKey!,
      clientTraceId: parsed.pending.clientTraceId!,
      updatedAt: Number(parsed.pending.updatedAt),
      ...(persistedCoverTask(parsed.pending.task) ? { task: persistedCoverTask(parsed.pending.task) } : {}),
      ...(persistedCoverResumePayload(parsed.pending.resumePayload) ? { resumePayload: persistedCoverResumePayload(parsed.pending.resumePayload) } : {}),
    }
    : null;
  if (!reference) inMemoryPendingCoverRequests.delete(userId);
  const memory = reference ? inMemoryPendingCoverRequests.get(userId) : null;
  const legacyPayload = parsed.pending ? legacyCoverPayload(parsed.pending.payload) : undefined;
  const pending = memory
    && memory.clientIdempotencyKey === reference?.clientIdempotencyKey
    && memory.clientTraceId === reference.clientTraceId
    ? memory
    : reference ? reference.task
      ? { ...reference, task: reference.task, ...(legacyPayload ? { payload: legacyPayload } : reference.resumePayload ? { payload: reference.resumePayload } : {}) }
      : pendingPlaceholder(reference) : null;
  if (pending && legacyPayload) inMemoryPendingCoverRequests.set(userId, pending);
  const history = Array.isArray(parsed.receipts) ? parsed.receipts.map(persistedCoverReceipt).filter((task): task is CoverGenerationTask => Boolean(task)) : [];
  const serialized = serializedAttemptState(reference, history);
  if (serialized !== raw && typeof storage.setItem === "function") {
    try {
      storage.setItem(stateKey(userId), serialized);
    } catch {
      // Reading stays safe even when a legacy sensitive record cannot be scrubbed.
    }
  }
  return { version: 1, pending, history };
}

function saveState(storage: Pick<Storage, "getItem" | "setItem">, userId: string, state: CoverGenerationState) {
  const reference = state.pending ? persistedReference(state.pending) : null;
  const serialized = serializedAttemptState(reference, state.history);
  storage.setItem(stateKey(userId), serialized);
  if (storage.getItem(stateKey(userId)) !== serialized) throw new Error("无法保存封面任务追踪，本次尚未提交");
  if (!state.pending) {
    inMemoryPendingCoverRequests.delete(userId);
  } else if (state.pending.payload) {
    inMemoryPendingCoverRequests.set(userId, { ...state.pending, updatedAt: reference!.updatedAt });
  }
}

export function saveCoverEphemeralReceipt(storage: Storage, userId: string, task: CoverGenerationTask) {
  const receipt = persistedCoverReceipt(task);
  if (!receipt) return;
  const state = readCoverGenerationState(storage, userId);
  saveState(storage, userId, { ...state, history: [receipt, ...state.history.filter(item => item.imageDeliveryReceipt?.recordId !== receipt.imageDeliveryReceipt?.recordId)] });
}

export function clearCompletedCoverHistory(storage: Storage, userId: string) {
  const current = readCoverGenerationState(storage, userId);
  if (current.pending) throw new Error("仍有结果待确认的封面任务，不能清除追踪记录");
  saveState(storage, userId, { version: 1, pending: null, history: [] });
}

/** Detach the editor from an in-flight task. The server remains authoritative and
 * the task continues to appear in account history after refresh. */
export function detachCoverGenerationTracking(storage: Storage, userId: string) {
  const current = readCoverGenerationState(storage, userId);
  saveState(storage, userId, { ...current, pending: null });
}

export type CoverFailureHistoryReadiness = {
  ready: boolean;
  code?: string;
  message?: string;
};

function isValidCoverFailureHistoryRecord(record: CoverGenerationTask) {
  return record.status === "failed"
    && typeof record.failureRecordId === "string" && /^[a-f0-9]{64}$/u.test(record.failureRecordId)
    && typeof record.prompt === "string" && Boolean(record.prompt.trim())
    && typeof record.publicModelId === "string" && record.publicModelId.startsWith("pm_")
    && typeof record.modelName === "string" && Boolean(record.modelName.trim())
    && ["16:9", "9:16", "4:3", "3:4"].includes(record.ratio)
    && ["1K", "2K", "4K"].includes(record.resolution || "")
    && Array.isArray(record.referenceAssetRefs)
    && record.referenceAssetRefs.every(item => /^ref_[a-f0-9]{32}$/u.test(item))
    && Number.isFinite(record.referenceCount) && record.referenceCount === record.referenceAssetRefs.length
    && Number.isFinite(record.quotedPriceYuan) && Number(record.quotedPriceYuan) >= 0
    && Boolean(record.billing) && ["charged", "not_charged", "exempt", "unknown"].includes(record.billing?.state || "")
    && typeof record.canLoadForRetry === "boolean"
    && (record.canLoadForRetry === true
      ? record.billing?.state === "not_charged" || record.billing?.state === "exempt"
      : Boolean(record.retryBlockReason));
}

function isValidCoverAttemptHistoryRecord(record: CoverGenerationTask) {
  return ["running", "unknown", "failed", "cancelled"].includes(record.status)
    && Boolean(record.clientIdempotencyKey)
    && Boolean(record.clientTraceId)
    && Boolean(record.attemptState);
}

export function coverHistoryStableKey(record: Pick<CoverGenerationTask,
  "id" | "clientTraceId" | "clientIdempotencyKey" | "assetId" | "failureRecordId" | "historyRecordId"
>) {
  return record.clientTraceId
    ? `request:${record.clientTraceId}`
    : record.clientIdempotencyKey
      ? `request:${record.clientIdempotencyKey}`
      : record.assetId
        ? `asset:${record.assetId}`
        : record.failureRecordId
          ? `failure:${record.failureRecordId}`
          : record.historyRecordId
            ? `history:${record.historyRecordId}`
            : `local:${record.id}`;
}

function coverHistoryPriority(record: CoverGenerationTask) {
  if (record.status === "done") return 6;
  if (record.status === "display_pending") return 5;
  if (record.failureRecordId) return 4;
  if (record.status === "failed" || record.status === "cancelled") return 3;
  return 1;
}

export function dedupeCoverHistory(records: CoverGenerationTask[]) {
  const selected = new Map<string, CoverGenerationTask>();
  for (const record of records) {
    const key = coverHistoryStableKey(record);
    const current = selected.get(key);
    if (!current || coverHistoryPriority(record) > coverHistoryPriority(current)) selected.set(key, record);
  }
  return sortCoverHistoryLatestFirst([...selected.values()]);
}

export function sortCoverHistoryLatestFirst(records: CoverGenerationTask[]) {
  return [...records].sort((left, right) => {
    const byTime = (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
    return byTime || right.id.localeCompare(left.id);
  });
}

export async function fetchCoverAccountHistory(token: string, page = 1, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`/api/cover/history?page=${page}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(data.records)) throw new Error(data.error || "封面历史暂时无法读取");
  const activeAttempts = Array.isArray(data.activeAttempts)
    ? (data.activeAttempts as unknown[]).map(serverCoverAttempt).filter((attempt): attempt is ServerCoverAttempt => Boolean(attempt))
    : [];
  const activeRecords = activeAttempts.map((attempt: ServerCoverAttempt) => attempt.task);
  const records = dedupeCoverHistory([...(data.records as CoverGenerationTask[]), ...activeRecords]);
  if (records.some(record => record.status === "done"
    ? record.imageDeliveryReceipt ? !persistedCoverReceipt(record) : !record.assetId || !record.historyRecordId || !record.backgroundAssetId || !record.renderPlan || !record.url
      || Boolean(coverCompositionValidationError(record.renderPlan)) || record.cloudStored !== true
    : record.status === "display_pending"
      ? !record.assetId || !record.historyRecordId || !record.backgroundAssetId || !record.renderPlan
        || Boolean(coverCompositionValidationError(record.renderPlan)) || record.cloudStored !== true
      : !isValidCoverAttemptHistoryRecord(record) && !isValidCoverFailureHistoryRecord(record))) {
    throw new Error("封面历史内容不完整，请稍后刷新");
  }
  const failureHistory = data.failureHistory && typeof data.failureHistory === "object"
    ? data.failureHistory as CoverFailureHistoryReadiness
    : { ready: false, code: "IMAGE_FAILURE_HISTORY_STATE_MISSING", message: "失败历史状态缺失" };
  return {
    records,
    activeAttempt: serverCoverAttempt(data.activeAttempt),
    activeAttempts,
    activeAttemptReady: data.activeAttemptReady === true,
    nextPage: Number.isSafeInteger(data.nextPage) && data.nextPage > page ? data.nextPage as number : null,
    failureHistory,
  };
}

/** Keep the original in-flight request and legacy local-only records while refreshing cloud assets. */
export function mergeCoverAccountHistory(
  storage: Storage,
  userId: string,
  records: CoverGenerationTask[],
  activeAttempt: ServerCoverAttempt | null = null,
): CoverGenerationState {
  const current = readCoverGenerationState(storage, userId);
  const identities = new Set(records.map(coverHistoryStableKey));
  const legacy = current.history.filter(record => !record.cloudStored && !identities.has(coverHistoryStableKey(record)));
  const serverPending: PendingCoverGeneration | null = activeAttempt ? {
    clientIdempotencyKey: activeAttempt.clientIdempotencyKey,
    clientTraceId: activeAttempt.clientTraceId,
    updatedAt: activeAttempt.updatedAt,
    task: activeAttempt.task,
    ...(current.pending?.clientIdempotencyKey === activeAttempt.clientIdempotencyKey && current.pending.payload
      ? { payload: current.pending.payload }
      : activeAttempt.dispatchInput ? { payload: activeAttempt.dispatchInput } : {}),
  } : null;
  const next = { ...current, pending: serverPending || current.pending, history: dedupeCoverHistory([...records, ...legacy]) };
  saveState(storage, userId, next);
  return next;
}

/** A submitted request remains durable until owned asset + history delivery is confirmed. */
export async function runCoverGeneration(input: {
  userId: string;
  token: string;
  payload?: CoverGenerationPayload;
  task?: CoverGenerationTask;
  recovery?: boolean;
  storage: Storage;
  fetcher?: typeof fetch;
  onState: (state: CoverGenerationState) => void;
  isCurrentPageActive?: () => boolean;
}): Promise<{ state: CoverGenerationState; message: string }> {
  const fetcher = input.fetcher || fetch;
  const execute = async () => {
    let current = readCoverGenerationState(input.storage, input.userId);
    const headers = { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" };
    const publish = (next: CoverGenerationState) => {
      if (!next.pending && next.history[0]?.imageDeliveryReceipt) {
        try { saveState(input.storage, input.userId, next); } catch { /* An optional local receipt cannot invalidate a completed paid result. */ }
      } else saveState(input.storage, input.userId, next);
      current = next;
      input.onState(next);
    };
    const requestAttempt = async (method: "GET" | "POST", body?: Record<string, unknown>, keys?: {
      clientIdempotencyKey: string; clientTraceId: string;
    }) => {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), method === "GET" ? 30_000 : body?.action === "dispatch" ? 330_000 : 30_000);
      const query = keys ? `?${new URLSearchParams(keys)}` : "";
      let response: Response;
      try {
        response = await fetcher(`/api/cover/attempt${query}`, {
        method,
        headers,
        cache: "no-store",
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } finally {
        globalThis.clearTimeout(timeout);
      }
      const data = await response.json().catch(() => ({}));
      return { response, data };
    };
    const responseMessage = (data: Record<string, unknown>, fallback: string) => typeof data.message === "string"
      ? data.message
      : typeof data.error === "string" ? data.error : fallback;
    const pendingFromServer = (attempt: ServerCoverAttempt, payload?: CoverGenerationPayload): PendingCoverGeneration => ({
      clientIdempotencyKey: attempt.clientIdempotencyKey,
      clientTraceId: attempt.clientTraceId,
      updatedAt: attempt.updatedAt,
      task: attempt.task,
      ...(payload ? { payload } : attempt.dispatchInput ? { payload: attempt.dispatchInput } : {}),
    });
    const complete = async (attempt: PendingCoverGeneration, data: Record<string, unknown>) => {
      if (data.success === true && data.completed === true && data.generationCompleted === true && data.deliveryMode === "inline_ephemeral") {
        const receipt = projectGeneratedImageClientReceipt(data);
        const delivery = await resolveGeneratedImageClientDelivery(data).catch(error => {
          if (receipt?.deliveryMode !== "inline_ephemeral") throw error;
          return { kind: "inline_ephemeral" as const, receipt, url: "", revoke: () => {} };
        });
        if (delivery.kind !== "inline_ephemeral" || !delivery.receipt) return false;
        let previewBlob = "blob" in delivery ? delivery.blob : undefined;
        const revokeDelivery = delivery.revoke;
        const revokePreview = () => { previewBlob = undefined; revokeDelivery(); };
        const pageActive = input.isCurrentPageActive?.() !== false;
        if (!pageActive) revokePreview();
        const url = pageActive ? delivery.url : "";
        const boundRecordId = delivery.receipt.recordId;
        const completed: CoverGenerationTask = { ...attempt.task, status: "done", url: url || undefined, imageDeliveryReceipt: delivery.receipt,
          cloudStored: false, cancellable: false, canLoadForRetry: false, attemptState: "failed",
          revokePreview, readPreviewBlob: binding => previewBlob && binding.recordId === boundRecordId && binding.url === url ? previewBlob : null,
          clientIdempotencyKey: attempt.clientIdempotencyKey, clientTraceId: attempt.clientTraceId,
          outputWidth: delivery.receipt.width, outputHeight: delivery.receipt.height,
          billing: { state: delivery.receipt.cashCharged > 0 ? "charged" : "exempt", referenceId: delivery.receipt.billingReferenceId || delivery.receipt.recordId, chargedAmount: delivery.receipt.cashCharged },
          error: url ? "临时封面仅当前页面可用，请及时下载；刷新后只保留费用收据" : "生成已完成且费用收据已保留；临时封面无法恢复" };
        publish({ version: 1, pending: null, history: [completed, ...current.history.filter(item => item.imageDeliveryReceipt?.recordId !== delivery.receipt?.recordId)].slice(0,30) });
        return true;
      }
      const stored = data.result && typeof data.result === "object" && !Array.isArray(data.result)
        ? data.result as Record<string, unknown>
        : null;
      const plan = attempt.task.renderPlan;
      if (!plan || data.completed !== true || !stored || stored.status !== "completed" || stored.persisted !== true
        || stored.cloudStored !== true || !text(stored.assetId) || !text(stored.key) || !text(stored.historyRecordId)
        || !text(stored.url) || !text(data.backgroundAssetId) || !coverCompositionMatches(stored, plan, data.backgroundAssetId)) return false;
      const completed: CoverGenerationTask = {
        ...attempt.task,
        id: `cover-render-${stored.assetId}`,
        status: "done",
        url: stored.url,
        assetId: stored.assetId,
        storageKey: stored.key,
        historyRecordId: stored.historyRecordId,
        operationId: typeof data.operationId === "string" ? data.operationId : attempt.task.operationId,
        cloudStored: true,
        createdAt: typeof stored.createdAt === "string" && Number.isFinite(Date.parse(stored.createdAt)) ? stored.createdAt : attempt.task.createdAt,
        taskNo: Number.isSafeInteger(stored.taskNo) ? Number(stored.taskNo) : attempt.task.taskNo,
        backgroundAssetId: data.backgroundAssetId,
        outputWidth: typeof stored.width === "number" && Number.isFinite(stored.width) ? stored.width : undefined,
        outputHeight: typeof stored.height === "number" && Number.isFinite(stored.height) ? stored.height : undefined,
        sourceWidth: typeof stored.sourceWidth === "number" && Number.isFinite(stored.sourceWidth) ? stored.sourceWidth : undefined,
        sourceHeight: typeof stored.sourceHeight === "number" && Number.isFinite(stored.sourceHeight) ? stored.sourceHeight : undefined,
        error: undefined,
      };
      publish({ version: 1, pending: null, history: [...(stored.historyVisible === false ? [] : [completed]),
        ...current.history.filter(item => item.id !== completed.id && item.assetId !== completed.assetId)].slice(0, 30) });
      return true;
    };

    if (!current.pending && !input.recovery) {
      if (!input.payload || !input.task || !input.task.renderPlan) throw new Error("封面提交参数不完整");
      const invalidPlan = coverCompositionValidationError(input.task.renderPlan);
      if (invalidPlan) throw new Error(`${invalidPlan}，本次尚未提交生图`);
      const ready = await fetcher("/api/cover/render", { cache: "no-store" });
      const readiness = await ready.json().catch(() => ({}));
      if (!ready.ok || readiness.ready !== true) throw new Error("封面字体排版服务尚未就绪，本次尚未提交生图");
      const proposedKey = `cover_${crypto.randomUUID()}`;
      let response: Response;
      let data: Record<string, unknown>;
      try {
        ({ response, data } = await requestAttempt("POST", {
          action: "claim",
          clientIdempotencyKey: proposedKey,
          clientTraceId: proposedKey,
          task: input.task,
          payload: { ...input.payload, referenceImageUrls: [], resumeDeliveryOnly: undefined },
          referenceCount: input.payload.referenceImageUrls.length,
        }));
      } catch {
        const pending: PendingCoverGeneration = { payload: input.payload, task: { ...input.task, status: "unknown",
          error: "账号认领结果暂时无法确认；稳定请求号已保留，系统将先查询原任务" },
        clientIdempotencyKey: proposedKey, clientTraceId: proposedKey, updatedAt: Date.now() };
        publish({ ...current, pending });
        return { state: current, message: pending.task.error || "封面任务认领结果待确认" };
      }
      const active = serverCoverAttempt(data.activeAttempt);
      if (!response.ok || !active) throw new Error(responseMessage(data, "封面任务未能在账号内安全认领，本次尚未提交生图"));
      const firstPayload = active.task.id === input.task.id ? input.payload : active.dispatchInput;
      publish({ ...current, pending: pendingFromServer(active, firstPayload) });
    } else if (!current.pending && input.recovery) {
      const { response, data } = await requestAttempt("GET");
      const active = response.ok ? serverCoverAttempt(data.activeAttempt) : null;
      if (!active) return { state: current, message: "当前没有待完成的封面任务" };
      publish({ ...current, pending: pendingFromServer(active, input.payload || active.dispatchInput) });
    } else if (current.pending && !input.recovery) {
      return { state: current, message: "上一条封面正在自动完成保存和展示" };
    }

    let attempt = current.pending!;
    if (input.recovery) {
      let { response, data } = await requestAttempt("GET", undefined, {
        clientIdempotencyKey: attempt.clientIdempotencyKey,
        clientTraceId: attempt.clientTraceId,
      });
      if (response.ok && await complete(attempt, data)) return { state: current, message: current.history[0]?.imageDeliveryReceipt ? "封面生成已完成；临时素材仅当前页面可用，费用收据已保留" : "封面已完成，图片与编辑历史已保存到账号" };
      if (response.ok && data.terminalAttempt) {
        const failed = serverCoverAttempt(data.terminalAttempt);
        const task = { ...(failed?.task || attempt.task), status: failed?.task.status === "cancelled" ? "cancelled" as const : "failed" as const,
          error: responseMessage(data, "原任务已明确结束，可调整后重新提交") };
        publish({ version: 1, pending: null, history: [task, ...current.history].slice(0, 30) });
        return { state: current, message: task.error || "原任务已明确结束" };
      }
      let active = response.ok ? serverCoverAttempt(data.activeAttempt) : null;

      if (!active) {
        const query = new URLSearchParams({ clientIdempotencyKey: attempt.clientIdempotencyKey, clientTraceId: attempt.clientTraceId });
        const statusResponse = await fetcher(`/api/image/status?${query}`, { headers, cache: "no-store" });
        const status = await statusResponse.json().catch(() => ({}));
        if (statusResponse.ok && isConfirmedTerminalImageFailure(status)) {
          const task = { ...attempt.task, status: "failed" as const, error: status.message || status.error || "原任务已明确结束，可调整后重新提交" };
          publish({ version: 1, pending: null, history: [task, ...current.history].slice(0, 30) });
          return { state: current, message: task.error || "原任务已明确结束" };
        }
        const trustedResume = legacyCoverPayload(status.resumeInput);
        const localPayload = legacyCoverPayload(input.payload) || attempt.payload;
        const adoptedPayload = trustedResume || localPayload;
        if (!adoptedPayload) return { state: current, message: "原任务追踪编号已保留；账号状态尚未确认，系统不会重复生图" };
        ({ response, data } = await requestAttempt("POST", {
          action: "adopt",
          clientIdempotencyKey: attempt.clientIdempotencyKey,
          clientTraceId: attempt.clientTraceId,
          task: attempt.task,
          payload: { ...adoptedPayload, referenceImageUrls: [], resumeDeliveryOnly: undefined },
          referenceCount: localPayload?.referenceImageUrls.length || 0,
        }));
        if (response.ok && await complete(attempt, data)) return { state: current, message: current.history[0]?.imageDeliveryReceipt ? "封面生成已完成；临时素材仅当前页面可用，费用收据已保留" : "封面已完成，图片与编辑历史已保存到账号" };
        active = response.ok ? serverCoverAttempt(data.activeAttempt) : null;
        if (!active) return { state: current, message: responseMessage(data, "原任务仍在后台核验，系统不会重复生图") };
        const usablePayload = trustedResume
          ? { ...trustedResume, referenceImageUrls: localPayload?.referenceImageUrls || [] }
          : localPayload || active.dispatchInput;
        attempt = pendingFromServer(active, usablePayload);
        publish({ ...current, pending: attempt });
      } else {
        const localPayload = legacyCoverPayload(input.payload) || attempt.payload;
        attempt = pendingFromServer(active, localPayload?.referenceImageUrls.length ? localPayload : active.dispatchInput || localPayload);
        publish({ ...current, pending: attempt });
      }
    }

    const activeResponse = await requestAttempt("GET", undefined, {
      clientIdempotencyKey: attempt.clientIdempotencyKey,
      clientTraceId: attempt.clientTraceId,
    });
    if (activeResponse.response.ok && await complete(attempt, activeResponse.data)) {
      return { state: current, message: current.history[0]?.imageDeliveryReceipt ? "封面生成已完成；临时素材仅当前页面可用，费用收据已保留" : "封面已完成，图片与编辑历史已保存到账号" };
    }
    if (activeResponse.response.ok && activeResponse.data.terminalAttempt) {
      const terminal = serverCoverAttempt(activeResponse.data.terminalAttempt);
      const task = { ...(terminal?.task || attempt.task),
        status: terminal?.task.status === "cancelled" ? "cancelled" as const : "failed" as const,
        error: responseMessage(activeResponse.data, "原任务已明确结束，可继续创建新任务") };
      publish({ version: 1, pending: null, history: dedupeCoverHistory([task, ...current.history]).slice(0, 30) });
      return { state: current, message: task.error || "原任务已明确结束" };
    }
    const active = activeResponse.response.ok ? serverCoverAttempt(activeResponse.data.activeAttempt) : null;
    if (!active) return { state: current, message: "原任务状态仍待确认，追踪编号已保留；请勿新建重复任务" };
    const candidatePayload = legacyCoverPayload(input.payload) || attempt.payload || active.dispatchInput;
    attempt = pendingFromServer(active, candidatePayload);
    publish({ ...current, pending: attempt });
    if (active.state !== "claimed") {
      return { state: current, message: active.state === "delivery_pending"
        ? "封面底图已完成，系统正在完成文字排版与历史保存"
        : "原任务已提交，系统正在核验和保存；不会重复生图" };
    }
    if (!candidatePayload || (active.requiresReferenceReupload && candidatePayload.referenceImageUrls.length === 0)) {
      return { state: current, message: active.requiresReferenceReupload
        ? "原任务确认尚未提交，但参考图未跨浏览器保存；请回到原浏览器或重新上传参考图"
        : "原任务确认尚未提交，安全参数暂不可用；系统不会创建新请求号" };
    }
    let response: Response;
    let data: Record<string, unknown>;
    try {
      ({ response, data } = await requestAttempt("POST", {
        action: "dispatch",
        clientIdempotencyKey: attempt.clientIdempotencyKey,
        clientTraceId: attempt.clientTraceId,
        payload: candidatePayload,
      }));
    } catch {
      const next = { ...current, pending: { ...attempt, task: { ...attempt.task, status: "unknown" as const,
        error: "提交响应中断，系统将仅查询同一稳定请求号，不会重复调用生图服务" } } };
      publish(next);
      return { state: current, message: next.pending.task.error || "原请求状态待确认" };
    }
    if (response.ok && await complete(attempt, data)) return { state: current, message: current.history[0]?.imageDeliveryReceipt ? "封面生成已完成；临时素材仅当前页面可用，费用收据已保留" : "封面已完成，图片与编辑历史已保存到账号" };
    if (data.terminalAttempt) {
      const terminal = serverCoverAttempt(data.terminalAttempt);
      const task = { ...(terminal?.task || attempt.task),
        status: terminal?.task.status === "cancelled" ? "cancelled" as const : "failed" as const,
        error: responseMessage(data, "本次任务已明确结束，可继续创建新任务") };
      publish({ version: 1, pending: null, history: dedupeCoverHistory([task, ...current.history]).slice(0, 30) });
      return { state: current, message: task.error || "本次任务已明确结束" };
    }
    if (isConfirmedTerminalImageFailure(data)) {
      const task = { ...attempt.task, status: "failed" as const, error: responseMessage(data, "本次请求已明确结束，可调整后重新提交") };
      publish({ version: 1, pending: null, history: [task, ...current.history].slice(0, 30) });
      return { state: current, message: task.error || "本次请求已明确结束" };
    }
    const projected = serverCoverAttempt(data.activeAttempt);
    if (projected) publish({ ...current, pending: pendingFromServer(projected, candidatePayload) });
    return { state: current, message: responseMessage(data, "封面结果仍在后台核验和保存，请勿重复提交") };
  };
  if (typeof navigator !== "undefined" && navigator.locks) {
    const scope = input.task?.id || readCoverGenerationState(input.storage, input.userId).pending?.clientTraceId || "recovery";
    return navigator.locks.request(`cover-generation:${input.userId}:${scope}`, execute);
  }
  return execute();
}

export async function saveCoverCompositionEdit(input: {
  userId: string; token: string; task: CoverGenerationTask; plan: CoverCompositionPlan; storage: Storage;
  onState: (state: CoverGenerationState) => void; fetcher?: typeof fetch;
}) {
  if (!input.task.backgroundAssetId || !input.task.renderPlan) throw new Error("这张历史图没有独立底图，请保留原图并新建封面");
  const invalidPlan = coverCompositionValidationError(input.plan);
  if (invalidPlan) throw new Error(invalidPlan);
  const current = readCoverGenerationState(input.storage, input.userId);
  if (current.pending) throw new Error("请先确认未完成任务");
  const response = await (input.fetcher || fetch)("/api/cover/render", { method: "POST",
    headers: { Authorization: `Bearer ${input.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sourceAssetId: input.task.backgroundAssetId, plan: input.plan, authoring: { briefText: input.task.briefText || '', prompt: input.task.prompt } }),
  });
  const stored = await response.json().catch(() => ({}));
  if (!response.ok || stored.persisted !== true || !text(stored.assetId) || !text(stored.key) || !text(stored.url) || !text(stored.historyRecordId)
    || stored.cloudStored !== true || !coverCompositionMatches(stored, input.plan, input.task.backgroundAssetId)) throw new Error("文字保存尚未确认，可重试保存；不会重新生成底图");
  if (stored.historyVisible === false) throw new Error("这个版本已从历史移除，修改文字后可另存为新版本");
  // Another tab may have started a generation while rendering this text edit.
  // Merge into its latest state so the in-flight request remains durable.
  const latest = readCoverGenerationState(input.storage, input.userId);
  const edited: CoverGenerationTask = { ...input.task, id: `cover-render-${stored.assetId}`, title: input.plan.title, subtitle: input.plan.subtitle,
    ratio: input.plan.aspectRatio, renderPlan: input.plan, url: stored.url, assetId: stored.assetId, storageKey: stored.key, historyRecordId: stored.historyRecordId,
    outputWidth: stored.width, outputHeight: stored.height, sourceWidth: stored.sourceWidth, sourceHeight: stored.sourceHeight,
    taskNo: stored.taskNo, createdAt: stored.createdAt, cloudStored: true };
  const next = { ...latest, history: [edited, ...latest.history.filter(item => item.assetId !== edited.assetId)].slice(0, 30) };
  saveState(input.storage, input.userId, next); input.onState(next);
  return next;
}
