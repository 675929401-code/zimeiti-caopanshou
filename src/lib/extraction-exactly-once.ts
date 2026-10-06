import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest, NextResponse } from "next/server";
import { authorizeExtractionRequest } from "@/lib/extraction-auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { sanitizeOwnedExtractionResponse } from "@/lib/extraction-history";
import { sanitizeExtractionErrorFields } from "@/lib/extraction-provider-error";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_PERSISTED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_SNAPSHOT_BYTES = 128 * 1024;

export type ExtractionRequestKind = "single" | "batch" | "search" | "coze" | "semantic";
export type ExtractionAttemptState = "running" | "succeeded" | "failed" | "failed_unknown";

type JsonObject = Record<string, unknown>;

export type ExtractionAttemptRecord = {
  recordId: string;
  userId: string;
  clientRequestId: string;
  requestKind: ExtractionRequestKind;
  payloadFingerprint: string;
  state: ExtractionAttemptState;
  httpStatus?: number;
  response?: unknown;
  requestSnapshot: JsonObject;
  providerTaskId?: string;
  providerCheckpoint: JsonObject;
  providerEvidence: JsonObject;
  billingEvidence: JsonObject;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

type DatabaseExtractionAttemptRow = {
  record_id?: string;
  user_id?: string;
  client_request_id?: string;
  request_kind?: ExtractionRequestKind;
  payload_fingerprint?: string;
  state?: ExtractionAttemptState;
  http_status?: number | null;
  response?: unknown;
  request_snapshot?: JsonObject | null;
  provider_task_id?: string | null;
  provider_checkpoint?: JsonObject | null;
  provider_evidence?: JsonObject | null;
  billing_evidence?: JsonObject | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
};

export class ExtractionExactlyOnceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ExtractionExactlyOnceError";
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([key, nested]) => key !== "client_request_id" && nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

export function extractionPayloadFingerprint(kind: ExtractionRequestKind, payload: unknown) {
  return sha256(JSON.stringify({ kind, payload: canonicalize(payload) }));
}

function recordIdFor(userId: string, clientRequestId: string) {
  return sha256(`${userId}\u0000${clientRequestId}`);
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizedErrorMessage(value: unknown): string {
  const sanitized = sanitizeExtractionErrorFields({ error: String(value || "") });
  return isPlainObject(sanitized) && typeof sanitized.error === "string" ? sanitized.error : "";
}

function rowToRecord(row: DatabaseExtractionAttemptRow): ExtractionAttemptRecord {
  if (
    !row.record_id
    || !SHA256_PATTERN.test(row.record_id)
    || !row.user_id
    || !row.client_request_id
    || !CLIENT_REQUEST_ID_PATTERN.test(row.client_request_id)
    || !row.request_kind
    || !["single", "batch", "search", "coze", "semantic"].includes(row.request_kind)
    || !row.payload_fingerprint
    || !SHA256_PATTERN.test(row.payload_fingerprint)
    || !row.state
    || !["running", "succeeded", "failed", "failed_unknown"].includes(row.state)
    || !row.created_at
    || !row.updated_at
  ) {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_RECORD_INVALID",
      "文案提取幂等记录无效，已停止调用上游服务",
      503,
    );
  }
  return {
    recordId: row.record_id,
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    requestKind: row.request_kind,
    payloadFingerprint: row.payload_fingerprint,
    state: row.state,
    ...(Number.isInteger(row.http_status) ? { httpStatus: Number(row.http_status) } : {}),
    ...(row.response !== null && row.response !== undefined ? { response: sanitizeOwnedExtractionResponse(row.response) } : {}),
    requestSnapshot: isPlainObject(row.request_snapshot) ? row.request_snapshot : {},
    ...(row.provider_task_id ? { providerTaskId: row.provider_task_id } : {}),
    providerCheckpoint: isPlainObject(row.provider_checkpoint)
      ? sanitizeExtractionErrorFields(row.provider_checkpoint) as JsonObject
      : {},
    providerEvidence: isPlainObject(row.provider_evidence)
      ? sanitizeExtractionErrorFields(row.provider_evidence) as JsonObject
      : {},
    billingEvidence: isPlainObject(row.billing_evidence) ? row.billing_evidence : {},
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: sanitizedErrorMessage(row.error_message) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isMigrationMissing(error: unknown) {
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  return /extraction_attempts|request_snapshot|claim_extraction_attempt_atomic|checkpoint_extraction_request_atomic|finalize_extraction_attempt_atomic|schema cache|does not exist|could not find/i.test(message);
}

function normalizeStoreError(error: unknown): never {
  if (error instanceof ExtractionExactlyOnceError) throw error;
  const message = error instanceof Error
    ? error.message
    : String((error as { message?: unknown } | null)?.message || "");
  if (/EXTRACTION_ATTEMPT_(?:CONFLICT|TERMINAL_CONFLICT)/i.test(message)) {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_CONFLICT",
      "同一文案提取请求号已绑定不同内容或终态",
      409,
    );
  }
  if (isMigrationMissing(error)) {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_MIGRATION_NOT_READY",
      "文案提取精确一次迁移尚未部署，本次未调用上游服务",
      503,
    );
  }
  throw new ExtractionExactlyOnceError(
    "EXTRACTION_ATTEMPT_STORE_UNAVAILABLE",
    "文案提取幂等服务暂时不可用，本次未调用上游服务",
    503,
  );
}

export class DatabaseExtractionAttemptStore {
  async claim(input: {
    userId: string;
    clientRequestId: string;
    requestKind: ExtractionRequestKind;
    payloadFingerprint: string;
  }): Promise<{ created: boolean; record: ExtractionAttemptRecord }> {
    if (
      !input.userId
      || !CLIENT_REQUEST_ID_PATTERN.test(input.clientRequestId)
      || !SHA256_PATTERN.test(input.payloadFingerprint)
    ) {
      throw new ExtractionExactlyOnceError(
        "EXTRACTION_ATTEMPT_INPUT_INVALID",
        "文案提取请求标识无效",
        400,
      );
    }
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("claim_extraction_attempt_atomic", {
        p_record_id: recordIdFor(input.userId, input.clientRequestId),
        p_user_id: input.userId,
        p_client_request_id: input.clientRequestId,
        p_request_kind: input.requestKind,
        p_payload_fingerprint: input.payloadFingerprint,
      });
      if (error) normalizeStoreError(error);
      const result = data as { created?: boolean; record?: DatabaseExtractionAttemptRow } | null;
      if (typeof result?.created !== "boolean" || !result.record) {
        throw new ExtractionExactlyOnceError(
          "EXTRACTION_ATTEMPT_CLAIM_INVALID",
          "文案提取幂等服务返回无效占位结果",
          503,
        );
      }
      return { created: result.created, record: rowToRecord(result.record) };
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  async checkpointRequest(input: {
    record: ExtractionAttemptRecord;
    requestSnapshot: JsonObject;
  }): Promise<ExtractionAttemptRecord> {
    try {
      const { data, error } = await getSupabaseAdminClient().rpc("checkpoint_extraction_request_atomic", {
        p_record_id: input.record.recordId,
        p_user_id: input.record.userId,
        p_payload_fingerprint: input.record.payloadFingerprint,
        p_request_snapshot: input.requestSnapshot,
      });
      if (error) normalizeStoreError(error);
      const saved = (data as { record?: DatabaseExtractionAttemptRow } | null)?.record;
      if (!saved) {
        throw new ExtractionExactlyOnceError(
          "EXTRACTION_REQUEST_SNAPSHOT_INVALID",
          "提取原始输入未确认保存，本次未调用上游服务",
          503,
        );
      }
      return rowToRecord(saved);
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  async checkpoint(input: { record: ExtractionAttemptRecord; providerTaskId?: string; providerResult?: JsonObject }): Promise<ExtractionAttemptRecord> {
    const { data, error } = await getSupabaseAdminClient().rpc("checkpoint_extraction_provider_atomic", {
      p_record_id: input.record.recordId, p_user_id: input.record.userId,
      p_payload_fingerprint: input.record.payloadFingerprint,
      p_provider_task_id: input.providerTaskId || null,
      p_provider_result: input.providerResult
        ? sanitizeExtractionErrorFields(input.providerResult) as JsonObject
        : null,
    });
    if (error || !(data as { record?: unknown } | null)?.record) {
      throw new ExtractionExactlyOnceError("EXTRACTION_PROVIDER_CHECKPOINT_UNCONFIRMED", "原提取任务的保存结果暂未确认，请稍后刷新状态。", 503);
    }
    return rowToRecord((data as { record: DatabaseExtractionAttemptRow }).record);
  }

  async finalize(input: {
    record: ExtractionAttemptRecord;
    state: Exclude<ExtractionAttemptState, "running">;
    httpStatus?: number;
    response?: unknown;
    providerTaskId?: string;
    providerEvidence?: JsonObject;
    billingEvidence?: JsonObject;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<ExtractionAttemptRecord> {
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("finalize_extraction_attempt_atomic", {
        p_record_id: input.record.recordId,
        p_payload_fingerprint: input.record.payloadFingerprint,
        p_state: input.state,
        p_http_status: input.httpStatus ?? null,
        p_response: input.state === "failed_unknown" ? null : sanitizeOwnedExtractionResponse(input.response) ?? null,
        p_provider_task_id: input.providerTaskId || null,
        p_provider_evidence: sanitizeExtractionErrorFields(input.providerEvidence || {}) as JsonObject,
        p_billing_evidence: input.billingEvidence || {},
        p_error_code: input.errorCode || null,
        p_error_message: input.errorMessage ? sanitizedErrorMessage(input.errorMessage) : null,
      });
      if (error) normalizeStoreError(error);
      const saved = (data as { record?: DatabaseExtractionAttemptRow } | null)?.record;
      if (!saved) {
        throw new ExtractionExactlyOnceError(
          "EXTRACTION_ATTEMPT_FINALIZE_INVALID",
          "文案提取结果未确认持久化，已停止发放结果",
          503,
        );
      }
      return rowToRecord(saved);
    } catch (error) {
      normalizeStoreError(error);
    }
  }
}

const extractionExecution = new AsyncLocalStorage<{ store: DatabaseExtractionAttemptStore; record: ExtractionAttemptRecord }>();

async function checkpointProvider(input: { providerTaskId?: string; providerResult?: JsonObject }) {
  const execution = extractionExecution.getStore();
  if (!execution) throw new ExtractionExactlyOnceError("EXTRACTION_PROVIDER_CONTEXT_REQUIRED", "提取任务上下文不可用，已停止后续处理。", 503);
  if (input.providerResult && Buffer.byteLength(JSON.stringify(input.providerResult), "utf8") > MAX_PERSISTED_RESPONSE_BYTES) {
    throw new ExtractionExactlyOnceError("EXTRACTION_PROVIDER_RESULT_TOO_LARGE", "提取内容过大，暂时无法保存，原请求已保留。", 503);
  }
  execution.record = await execution.store.checkpoint({ record: execution.record, ...input });
}

export function checkpointExtractionProviderTask(providerTaskId: string) {
  return checkpointProvider({ providerTaskId });
}

export function checkpointExtractionProviderResult(providerResult: JsonObject) {
  return checkpointProvider({ providerResult });
}

type FinalizeAttemptInput = Parameters<DatabaseExtractionAttemptStore["finalize"]>[0];

function shouldRetryFinalize(error: unknown) {
  if (!(error instanceof ExtractionExactlyOnceError)) return true;
  return ![
    "EXTRACTION_ATTEMPT_CONFLICT",
    "EXTRACTION_ATTEMPT_MIGRATION_NOT_READY",
    "EXTRACTION_ATTEMPT_INPUT_INVALID",
    "EXTRACTION_ATTEMPT_RECORD_INVALID",
  ].includes(error.code);
}

async function finalizeWithRetry(
  store: DatabaseExtractionAttemptStore,
  input: FinalizeAttemptInput,
  maxAttempts = 3,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await store.finalize(input);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetryFinalize(error)) throw error;
      // The finalize RPC is idempotent. If PostgreSQL committed but the network
      // acknowledgement was lost, a bounded retry returns the same terminal row
      // instead of issuing another provider request.
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
  throw lastError;
}

function errorResponse(
  error: ExtractionExactlyOnceError,
  options: { attemptId?: string } = {},
) {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (options.attemptId) headers["X-Extraction-Attempt-Id"] = options.attemptId;
  return NextResponse.json(
    {
      success: false,
      error: error.message,
      error_code: error.code,
      charged: false,
      ...(options.attemptId ? { attempt_id: options.attemptId } : {}),
    },
    { status: error.status, headers },
  );
}

function unresolvedAttemptResponse(
  error: ExtractionExactlyOnceError,
  attemptId: string,
  knownUncharged = false,
) {
  return NextResponse.json(
    {
      success: false,
      error: error.message,
      error_code: error.code,
      attempt_id: attemptId,
      charged: knownUncharged ? false : null,
      billing_unknown: !knownUncharged,
      pending_confirmation: true,
      provider_call_started: null,
      retry_safe: false,
    },
    {
      status: error.status,
      headers: {
        "Cache-Control": "no-store",
        "X-Extraction-Attempt-Id": attemptId,
      },
    },
  );
}

function resolveClientRequestId(
  request: NextRequest,
  body: JsonObject,
): { clientRequestId: string } | { error: ExtractionExactlyOnceError } {
  const headerValue = request.headers.get("Idempotency-Key")?.trim() || "";
  const bodyValue = typeof body.client_request_id === "string"
    ? body.client_request_id.trim()
    : "";
  if (headerValue && bodyValue && headerValue !== bodyValue) {
    return {
      error: new ExtractionExactlyOnceError(
        "EXTRACTION_CLIENT_REQUEST_ID_CONFLICT",
        "Idempotency-Key 与 client_request_id 不一致，本次未调用上游服务",
        409,
      ),
    } as const;
  }
  const value = headerValue || bodyValue;
  if (!value) {
    return {
      error: new ExtractionExactlyOnceError(
        "EXTRACTION_CLIENT_REQUEST_ID_REQUIRED",
        "缺少 client_request_id 或 Idempotency-Key，本次未调用上游服务",
        400,
      ),
    } as const;
  }
  if (!CLIENT_REQUEST_ID_PATTERN.test(value)) {
    return {
      error: new ExtractionExactlyOnceError(
        "EXTRACTION_CLIENT_REQUEST_ID_INVALID",
        "client_request_id 格式无效，本次未调用上游服务",
        400,
      ),
    } as const;
  }
  return { clientRequestId: value } as const;
}

function buildExtractionRequestSnapshot(
  requestKind: ExtractionRequestKind,
  body: JsonObject,
): JsonObject {
  const payload: JsonObject = {};
  const copyString = (key: string) => {
    if (typeof body[key] === "string") payload[key] = body[key];
  };
  const copyFiniteNumber = (key: string) => {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) payload[key] = body[key];
  };

  if (requestKind === "single") {
    if (Array.isArray(body.links)) payload.links = body.links.filter(value => typeof value === "string");
    copyString("extraction_mode");
    copyString("douyin_share_text");
  } else if (requestKind === "batch") {
    copyString("creator_url");
    copyFiniteNumber("likes_threshold");
    copyFiniteNumber("max_count");
  } else if (requestKind === "search") {
    copyString("keyword");
    copyFiniteNumber("likes_threshold");
    copyFiniteNumber("max_count");
  } else if (requestKind === "coze") {
    copyString("share_text");
    copyFiniteNumber("min_likes");
    copyFiniteNumber("max_count");
    copyString("mode");
  } else {
    copyString("text");
    copyFiniteNumber("duration");
  }

  const snapshot = { schema: "extraction_request_snapshot.v1", request_kind: requestKind, payload };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_REQUEST_SNAPSHOT_BYTES) {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_REQUEST_SNAPSHOT_TOO_LARGE",
      "提取原始输入过大，无法建立安全重试记录，本次未调用上游服务",
      413,
    );
  }
  return snapshot;
}

async function readJsonResponse(response: Response) {
  const raw = await response.clone().text();
  if (Buffer.byteLength(raw, "utf8") > MAX_PERSISTED_RESPONSE_BYTES) {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_RESPONSE_TOO_LARGE",
      "提取内容过大，暂时无法保存。原请求已保留。",
      503,
    );
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_RESPONSE_NOT_JSON",
      "提取服务返回的数据无法保存，原请求已保留。",
      503,
    );
  }
}

function findStringByKeys(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 4 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) {
      const found = findStringByKeys(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isPlainObject(value)) return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && (typeof nested === "string" || typeof nested === "number")) {
      const candidate = String(nested).trim();
      if (candidate) return candidate.slice(0, 240);
    }
  }
  for (const nested of Object.values(value)) {
    const found = findStringByKeys(nested, keys, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function pickEvidence(body: unknown, keys: string[]): JsonObject {
  if (!isPlainObject(body)) return {};
  const result: JsonObject = {};
  for (const key of keys) {
    const value = body[key];
    if (
      value === null
      || typeof value === "string"
      || typeof value === "number"
      || typeof value === "boolean"
    ) {
      result[key] = value;
    } else if (isPlainObject(value)) {
      const safeNested = Object.fromEntries(
        Object.entries(value)
          .filter(([, nested]) => nested === null || ["string", "number", "boolean"].includes(typeof nested))
          .slice(0, 30),
      );
      result[key] = safeNested;
    }
  }
  return result;
}

function replayResponse(record: ExtractionAttemptRecord) {
  if ((record.state === "succeeded" || record.state === "failed") && record.httpStatus && record.response !== undefined) {
    return NextResponse.json(sanitizeOwnedExtractionResponse(record.response), {
      status: record.httpStatus,
      headers: {
        "Cache-Control": "no-store",
        "X-Extraction-Replayed": "true",
        "X-Extraction-Attempt-Id": record.recordId,
      },
    });
  }
  if (record.state === "running") {
    return unresolvedAttemptResponse(new ExtractionExactlyOnceError(
      "EXTRACTION_ATTEMPT_RUNNING",
      "这次提取仍在处理，原请求已保留，请稍后查看状态。",
      409,
    ), record.recordId);
  }
  return unresolvedAttemptResponse(new ExtractionExactlyOnceError(
    "EXTRACTION_ATTEMPT_FAILED_UNKNOWN",
    record.billingEvidence.charged === false
      ? "结果暂未确认，原请求已保留，本次未扣费。"
      : "结果暂未确认，原请求已保留，可查看当前处理和扣费状态。",
    409,
  ), record.recordId, record.billingEvidence.charged === false);
}

function isDefinitiveFailureStatus(status: number) {
  return status >= 400
    && status < 500
    && ![408, 409, 425, 429].includes(status);
}

function providerCallDefinitelyNotStarted(body: unknown) {
  return isPlainObject(body)
    && body.provider_call_started === false
    && body.billing_unknown !== true;
}

export function classifyExtractionOutcome(status: number, body: unknown): Exclude<ExtractionAttemptState, "running"> {
  const payload = isPlainObject(body) ? body : undefined;
  if (payload?.billing_unknown === true || (payload?.success === false && payload?.retry_safe === false)) return "failed_unknown";
  // A usable no-charge fallback can be delivered with HTTP 200 while the paid
  // business action still failed. Persist it as a terminal failure so history
  // and operations do not report provider success. Replaying the same request
  // id returns this exact fallback; only an explicit retry creates a new id.
  if (
    payload?.success === false
    && payload?.fallback_delivered === true
    && payload?.retry_safe === true
    && payload?.charged === false
  ) return "failed";
  const confirmedFailure = providerCallDefinitelyNotStarted(body) || isDefinitiveFailureStatus(status)
    || (payload?.upstream_completed === true && payload?.success === false && payload?.charged === false);
  if (payload?.success === false) return confirmedFailure ? "failed" : "failed_unknown";
  if (status >= 200 && status < 300) return "succeeded";
  return confirmedFailure ? "failed" : "failed_unknown";
}

export function withExtractionExactlyOnce(
  requestKind: ExtractionRequestKind,
  handler: (request: NextRequest) => Promise<Response>,
  options: {
    /**
     * Resume post-provider work from the durable checkpoint. This callback must
     * never submit upstream work; returning null keeps the ordinary replay gate.
     */
    recoverFromProviderCheckpoint?: (
      request: NextRequest,
      record: ExtractionAttemptRecord,
    ) => Promise<Response | null>;
  } = {},
) {
  return async function exactlyOncePost(request: NextRequest) {
    const recoveryModeHeader = request.headers.get("x-extraction-recovery-mode");
    const checkpointOnly = recoveryModeHeader?.trim().toLowerCase() === "checkpoint-only";
    const withCheckpointOnlyProof = (response: Response) => {
      response.headers.delete("X-Extraction-Recovery-Mode");
      response.headers.delete("X-Extraction-Provider-Handler");
      if (checkpointOnly) {
        response.headers.set("X-Extraction-Recovery-Mode", "checkpoint-only");
        response.headers.set("X-Extraction-Provider-Handler", "skipped");
      }
      return response;
    };
    if (recoveryModeHeader !== null && !checkpointOnly) {
      return withCheckpointOnlyProof(errorResponse(new ExtractionExactlyOnceError(
        "EXTRACTION_RECOVERY_MODE_INVALID",
        "恢复模式无效，本次未调用上游服务",
        400,
      )));
    }
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) {
      return withCheckpointOnlyProof(errorResponse(new ExtractionExactlyOnceError(
        "EXTRACTION_AUTH_REQUIRED",
        "请先登录后使用文案提取服务",
        401,
      )));
    }

    const actor = await authorizeExtractionRequest(request);
    if (!actor.ok) return withCheckpointOnlyProof(actor.response);

    let body: JsonObject;
    try {
      const parsed = await request.clone().json();
      if (!isPlainObject(parsed)) {
        return withCheckpointOnlyProof(errorResponse(new ExtractionExactlyOnceError(
          "EXTRACTION_REQUEST_BODY_INVALID",
          "请求体必须是 JSON 对象，本次未调用上游服务",
          400,
        )));
      }
      body = parsed;
    } catch {
      return withCheckpointOnlyProof(errorResponse(new ExtractionExactlyOnceError(
        "EXTRACTION_REQUEST_BODY_INVALID",
        "请求体不是有效 JSON，本次未调用上游服务",
        400,
      )));
    }

    const requestIdentity = resolveClientRequestId(request, body);
    if ("error" in requestIdentity) return withCheckpointOnlyProof(errorResponse(requestIdentity.error));
    const { clientRequestId } = requestIdentity;

    let requestSnapshot: JsonObject;
    try {
      requestSnapshot = buildExtractionRequestSnapshot(requestKind, body);
    } catch (error) {
      return withCheckpointOnlyProof(errorResponse(error instanceof ExtractionExactlyOnceError
        ? error
        : new ExtractionExactlyOnceError("EXTRACTION_REQUEST_SNAPSHOT_INVALID", "提取原始输入无效，本次未调用上游服务", 400)));
    }

    const payloadFingerprint = extractionPayloadFingerprint(requestKind, body);
    const store = new DatabaseExtractionAttemptStore();
    let claimed: { created: boolean; record: ExtractionAttemptRecord };
    try {
      claimed = await store.claim({
        userId: actor.userId,
        clientRequestId,
        requestKind,
        payloadFingerprint,
      });
    } catch (error) {
      return withCheckpointOnlyProof(errorResponse(error instanceof ExtractionExactlyOnceError
        ? error
        : new ExtractionExactlyOnceError("EXTRACTION_ATTEMPT_STORE_UNAVAILABLE", "文案提取幂等服务不可用", 503)));
    }

    if (checkpointOnly && claimed.created) {
      const blockedBody = {
        success: false,
        error: "未找到可恢复的既有供应商检查点，本次未调用供应商。",
        error_code: "EXTRACTION_CHECKPOINT_REQUIRED",
        attempt_id: claimed.record.recordId,
        provider_call_started: false,
        charged: false,
        retry_safe: true,
      };
      try {
        const saved = await finalizeWithRetry(store, {
          record: claimed.record,
          state: "failed",
          httpStatus: 409,
          response: blockedBody,
          providerEvidence: { checkpoint_only: true, provider_handler_reached: false },
          billingEvidence: { charged: false },
          errorCode: blockedBody.error_code,
          errorMessage: blockedBody.error,
        });
        return withCheckpointOnlyProof(NextResponse.json(blockedBody, {
          status: 409,
          headers: {
            "Cache-Control": "no-store",
            "X-Extraction-Replayed": "false",
            "X-Extraction-Attempt-Id": saved.recordId,
          },
        }));
      } catch {
        return withCheckpointOnlyProof(unresolvedAttemptResponse(new ExtractionExactlyOnceError(
          "EXTRACTION_CHECKPOINT_REQUIRED_FINALIZE_FAILED",
          "未找到可恢复的既有供应商检查点，本次未调用供应商；拒绝状态暂未保存。",
          503,
        ), claimed.record.recordId, true));
      }
    }

    if (claimed.created) {
      try {
        claimed.record = await store.checkpointRequest({ record: claimed.record, requestSnapshot });
      } catch (error) {
        const normalized = error instanceof ExtractionExactlyOnceError
          ? error
          : new ExtractionExactlyOnceError(
            "EXTRACTION_REQUEST_SNAPSHOT_STORE_UNAVAILABLE",
            "提取原始输入无法保存，本次未调用上游服务",
            503,
          );
        if (normalized.code === "EXTRACTION_ATTEMPT_CONFLICT") {
          return errorResponse(normalized, { attemptId: claimed.record.recordId });
        }
        // The request snapshot only enables a later user-confirmed retry. It is
        // not part of the existing exactly-once, asset or settlement contract,
        // so an unactivated migration must not interrupt ordinary extraction.
        console.warn("[extract] 原始输入快照不可用，本次继续既有安全主链:", normalized.code);
      }
    }

    let response: Response;
    if (!claimed.created) {
      // The only automatic resume path starts after a completed provider result
      // has been checkpointed. Request handlers are never called again here.
      const checkpointResult = claimed.record.providerCheckpoint.result;
      if (
        claimed.record.state !== "running"
        || !isPlainObject(checkpointResult)
        || !options.recoverFromProviderCheckpoint
      ) {
        return withCheckpointOnlyProof(replayResponse(claimed.record));
      }
      try {
        const recovered = await extractionExecution.run(
          { store, record: claimed.record },
          () => options.recoverFromProviderCheckpoint!(request, claimed.record),
        );
        if (!recovered) return withCheckpointOnlyProof(replayResponse(claimed.record));
        response = recovered;
      } catch {
        return withCheckpointOnlyProof(unresolvedAttemptResponse(new ExtractionExactlyOnceError(
          "EXTRACTION_CHECKPOINT_RECOVERY_FAILED",
          "供应商结果已保留，本站资产仍在保存中。本次不会重新调用供应商。",
          503,
        ), claimed.record.recordId, true));
      }
    } else {
      try {
        response = await extractionExecution.run({ store, record: claimed.record }, () => handler(request));
      } catch (error) {
        try {
          const saved = await finalizeWithRetry(store, {
            record: claimed.record,
            state: "failed_unknown",
            providerEvidence: { handler_threw: true },
            errorCode: "EXTRACTION_HANDLER_THROWN",
            errorMessage: error instanceof Error ? error.message : "unknown",
          });
          return withCheckpointOnlyProof(replayResponse(saved));
        } catch {
          return withCheckpointOnlyProof(unresolvedAttemptResponse(new ExtractionExactlyOnceError(
            "EXTRACTION_ATTEMPT_FINALIZE_FAILED",
            "提取中断，最终结果暂未保存。原请求已保留，请稍后刷新状态。",
            503,
          ), claimed.record.recordId));
        }
      }
    }

    let bodyEvidence: unknown;
    try {
      bodyEvidence = sanitizeOwnedExtractionResponse(await readJsonResponse(response));
    } catch (error) {
      try {
        const saved = await finalizeWithRetry(store, {
          record: claimed.record,
          state: "failed_unknown",
          httpStatus: response.status,
          providerEvidence: { response_unpersistable: true },
          errorCode: error instanceof ExtractionExactlyOnceError ? error.code : "EXTRACTION_RESPONSE_UNPERSISTABLE",
          errorMessage: error instanceof Error ? error.message : "unknown",
        });
        return withCheckpointOnlyProof(replayResponse(saved));
      } catch {
        return withCheckpointOnlyProof(unresolvedAttemptResponse(new ExtractionExactlyOnceError(
          "EXTRACTION_ATTEMPT_FINALIZE_FAILED",
          "提取结果暂未完成保存，原请求已保留。请稍后刷新状态。",
          503,
        ), claimed.record.recordId));
      }
    }

    const safeHeaders = new Headers(response.headers);
    safeHeaders.delete("content-length");
    const responseForClient = NextResponse.json(bodyEvidence, {
      status: response.status,
      headers: safeHeaders,
    });
    const state = classifyExtractionOutcome(response.status, bodyEvidence);
    if (
      options.recoverFromProviderCheckpoint
      && isPlainObject(bodyEvidence)
      && bodyEvidence.recovery_pending === true
      && bodyEvidence.upstream_completed === true
      && bodyEvidence.provider_call_started === true
      && bodyEvidence.retry_safe === false
    ) {
      // Keep provider-complete attempts running while local asset or idempotent
      // settlement work is pending. A retry with the same identity can only
      // enter the checkpoint recovery callback above; it never calls the
      // provider handler again, even when charge acknowledgement is unknown.
      responseForClient.headers.set("Cache-Control", "no-store");
      responseForClient.headers.set("X-Extraction-Replayed", claimed.created ? "false" : "true");
      responseForClient.headers.set("X-Extraction-Attempt-Id", claimed.record.recordId);
      return withCheckpointOnlyProof(responseForClient);
    }
    const providerTaskId = findStringByKeys(
      bodyEvidence,
      new Set(["provider_task_id", "task_id", "run_id", "execute_id", "workflow_run_id"]),
    );
    const providerEvidence = pickEvidence(bodyEvidence, [
      "source",
      "channel",
      "run_id",
      "provider_task_id",
      "task_id",
      "upstream_completed",
      "provider_call_started",
      "semantic_status",
      "success_count",
      "filtered_count",
      "total_search_results",
      "total_videos",
    ]);
    const billingEvidence = pickEvidence(bodyEvidence, [
      "charged",
      "billing_replayed",
      "price",
      "cost",
      "chargeInfo",
    ]);
    const errorMessage = isPlainObject(bodyEvidence) && typeof bodyEvidence.error === "string"
      ? bodyEvidence.error
      : isPlainObject(bodyEvidence) && bodyEvidence.success === false && typeof bodyEvidence.message === "string"
        ? bodyEvidence.message
      : undefined;
    const errorCode = isPlainObject(bodyEvidence) && typeof bodyEvidence.code === "string"
      ? bodyEvidence.code : "EXTRACTION_RESPONSE_ERROR";

    try {
      const saved = await finalizeWithRetry(store, {
        record: claimed.record,
        state,
        httpStatus: response.status,
        ...(state === "failed_unknown" ? {} : { response: bodyEvidence }),
        providerTaskId,
        providerEvidence,
        billingEvidence,
        ...(errorMessage ? { errorCode, errorMessage } : {}),
      });
      if (state === "failed_unknown") {
        return withCheckpointOnlyProof(replayResponse(saved));
      }
      responseForClient.headers.set("Cache-Control", "no-store");
      responseForClient.headers.set("X-Extraction-Replayed", claimed.created ? "false" : "true");
      responseForClient.headers.set("X-Extraction-Attempt-Id", saved.recordId);
      return withCheckpointOnlyProof(responseForClient);
    } catch (error) {
      const normalized = error instanceof ExtractionExactlyOnceError
        ? error
        : new ExtractionExactlyOnceError("EXTRACTION_ATTEMPT_FINALIZE_FAILED", "提取结果未确认持久化", 503);
      return withCheckpointOnlyProof(unresolvedAttemptResponse(normalized, claimed.record.recordId));
    }
  };
}
