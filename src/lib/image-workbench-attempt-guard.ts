type ImageDraftAttempt = {
  status: string;
  assetId?: string;
  historyRecordId?: string;
  storageKey?: string;
};

/** Keep the original card and request identity until its outcome is known. */
export function hasUnresolvedImageAttempt(job: ImageDraftAttempt): boolean {
  return ["queued", "generating", "storing", "recoverable", "unknown"].includes(job.status)
    || (job.status === "done" && (!job.assetId || !job.storageKey));
}

export function retainUnresolvedImageAttempts<T extends ImageDraftAttempt>(jobs: T[]): T[] {
  return jobs.filter(hasUnresolvedImageAttempt);
}

export type BrowserImageAttemptReference = {
  schema: "image_workbench_attempt_reference.v1";
  id: string;
  generationKey: string;
  generationTraceId: string;
  generationModelId?: string;
  generationFingerprint?: string;
  historyBatchId?: string;
  expiresAt: number;
};

const OPAQUE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
export const BROWSER_IMAGE_ATTEMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createBrowserImageAttemptReferences<T extends ImageDraftAttempt & {
  id?: string;
  generationKey?: string;
  generationTraceId?: string;
  generationModelId?: string;
  generationFingerprint?: string;
  historyBatchId?: string;
}>(
  jobs: T[],
  now = Date.now(),
): BrowserImageAttemptReference[] {
  return jobs.flatMap((job) => {
    if (!hasUnresolvedImageAttempt(job)
      || !OPAQUE_ID.test(job.id || "")
      || !OPAQUE_ID.test(job.generationKey || "")
      || !OPAQUE_ID.test(job.generationTraceId || "")) return [];
    const generationModelId = typeof job.generationModelId === "string" && job.generationModelId.length <= 200
      ? job.generationModelId : undefined;
    const generationFingerprint = typeof job.generationFingerprint === "string"
      && job.generationFingerprint.length <= 128 * 1024 ? job.generationFingerprint : undefined;
    const historyBatchId = OPAQUE_ID.test(job.historyBatchId || "") ? job.historyBatchId : undefined;
    return [{
      schema: "image_workbench_attempt_reference.v1",
      id: job.id!,
      generationKey: job.generationKey!,
      generationTraceId: job.generationTraceId!,
      ...(generationModelId && generationFingerprint ? { generationModelId, generationFingerprint } : {}),
      ...(historyBatchId ? { historyBatchId } : {}),
      expiresAt: now + BROWSER_IMAGE_ATTEMPT_TTL_MS,
    }];
  });
}

export function parseBrowserImageAttemptReferences(value: unknown, now = Date.now()): BrowserImageAttemptReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Partial<BrowserImageAttemptReference>;
    if (row.schema !== "image_workbench_attempt_reference.v1"
      || !OPAQUE_ID.test(row.id || "")
      || !OPAQUE_ID.test(row.generationKey || "")
      || !OPAQUE_ID.test(row.generationTraceId || "")
      || !Number.isFinite(row.expiresAt)
      || Number(row.expiresAt) <= now
      || Number(row.expiresAt) > now + BROWSER_IMAGE_ATTEMPT_TTL_MS + 60_000) return [];
    const generationModelId = typeof row.generationModelId === "string" && row.generationModelId.length <= 200
      ? row.generationModelId : undefined;
    const generationFingerprint = typeof row.generationFingerprint === "string"
      && row.generationFingerprint.length <= 128 * 1024 ? row.generationFingerprint : undefined;
    const historyBatchId = OPAQUE_ID.test(row.historyBatchId || "") ? row.historyBatchId : undefined;
    return [{
      schema: row.schema,
      id: row.id!,
      generationKey: row.generationKey!,
      generationTraceId: row.generationTraceId!,
      ...(generationModelId && generationFingerprint ? { generationModelId, generationFingerprint } : {}),
      ...(historyBatchId ? { historyBatchId } : {}),
      expiresAt: Number(row.expiresAt),
    }];
  });
}

const CONFIRMED_IMAGE_PREFLIGHT_CODES = new Set([
  "IMAGE_IDEMPOTENCY_KEY_REQUIRED",
  "IMAGE_TRACE_ID_REQUIRED",
  "IMAGE_PRICE_NOT_CONFIGURED",
  "IMAGE_MODEL_CONFIGURATION_REQUIRED",
  "IMAGE_REFERENCE_UNSUPPORTED",
  "IMAGE_REFERENCE_LIMIT_EXCEEDED",
  "AUTODL_H3_IMAGE_ASPECT_UNVERIFIED",
  "AUTODL_H3_IMAGE_RESOLUTION_UNVERIFIED",
  "IMAGE_RESOLUTION_UNSUPPORTED",
  "IMAGE_STRICT_MODE_UNSUPPORTED",
  "MEMBERSHIP_REQUIRED",
  "INSUFFICIENT_BALANCE",
  "OUTSTANDING_CASH_DEBT",
]);

/** Explicit server evidence that no provider task can still be running. */
export function isConfirmedUnsubmittedImageFailure(error: {
  code?: string;
  upstreamCalled?: boolean;
  billed?: boolean;
  taskSubmitted?: boolean;
}): boolean {
  if (error.upstreamCalled === false && error.billed === false) return true;
  if (error.taskSubmitted === false && error.upstreamCalled !== true && error.billed !== true) return true;
  return CONFIRMED_IMAGE_PREFLIGHT_CODES.has(error.code || "");
}

/** A definitive rejection may have reached a provider, but cannot later produce an asset. */
export function isConfirmedTerminalImageFailure(error: {
  code?: string;
  upstreamCalled?: boolean;
  billed?: boolean;
  taskSubmitted?: boolean;
  state?: string;
  canRecover?: boolean;
  canResubmit?: boolean;
  sameKeyCanResubmit?: boolean;
}): boolean {
  return isConfirmedUnsubmittedImageFailure(error)
    || (error.state === "rejected" && error.canRecover === false
      && error.canResubmit === true && error.sameKeyCanResubmit === false);
}
