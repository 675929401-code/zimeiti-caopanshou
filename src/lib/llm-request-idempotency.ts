import { createHash, randomUUID } from "node:crypto";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { STORY_DIRECTOR_MOVIE_AGENT_ID, STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID } from "./story-director-overtime-gate";

const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_LEASE_SECONDS = 900;
const MAX_PERSISTED_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STORY_DIRECTOR_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Select only from the persisted server-loaded row, never request-body metadata. */
export function resolveLlmResponsePersistenceLimit(serverAgentRow?: { id?: unknown } | null): number {
  return serverAgentRow?.id === STORY_DIRECTOR_MOVIE_AGENT_ID || serverAgentRow?.id === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID
    ? MAX_STORY_DIRECTOR_RESPONSE_BYTES : MAX_PERSISTED_RESPONSE_BYTES;
}

/** Only a persisted server-loaded agent row may select the longer lease. */
export function resolveLlmRequestLeaseSeconds(serverAgentRow: { id?: unknown } | null | undefined): number {
  return serverAgentRow?.id === STORY_DIRECTOR_MOVIE_AGENT_ID || serverAgentRow?.id === STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID
    ? 2400 : DEFAULT_LEASE_SECONDS;
}

type JsonObject = Record<string, unknown>;

export type LlmBillingPhase =
  | "response"
  | "thinking"
  | "answer"
  | "skill-detect"
  | "skill-answer"
  | "coze-response";

export type LlmRequestAttemptState =
  | "running"
  | "succeeded"
  | "failed"
  | "failed_unknown"
  | "reconciliation_required";

export type LlmRequestAttemptRecord = {
  recordId: string;
  userId: string;
  clientRequestId: string;
  payloadFingerprint: string;
  state: LlmRequestAttemptState;
  attemptNo: number;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  providerCallStartedAt: string | null;
  httpStatus: number | null;
  responseHeaders: JsonObject;
  responseBody: string | null;
  responseFingerprint: string | null;
  resultReference: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LlmRequestAttemptExecution = {
  record: LlmRequestAttemptRecord;
  leaseOwner: string;
  leaseToken: number;
};

export type LlmRequestAttemptClaim =
  | { action: "execute"; execution: LlmRequestAttemptExecution }
  | { action: "replay"; record: LlmRequestAttemptRecord }
  | { action: "in_progress" | "reconciliation_required"; record: LlmRequestAttemptRecord };

type DatabaseLlmAttemptRow = {
  record_id?: string;
  user_id?: string;
  client_request_id?: string;
  payload_fingerprint?: string;
  state?: LlmRequestAttemptState;
  attempt_no?: number;
  lease_owner?: string | null;
  lease_token?: number;
  lease_expires_at?: string | null;
  provider_call_started_at?: string | null;
  http_status?: number | null;
  response_headers?: JsonObject | null;
  response_body?: string | null;
  response_fingerprint?: string | null;
  result_reference?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  created_at?: string;
  updated_at?: string;
};

export class LlmRequestIdempotencyError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "LlmRequestIdempotencyError";
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordIdFor(userId: string, clientRequestId: string): string {
  return sha256(`${userId}\u0000${clientRequestId}`);
}

export function validateLlmClientRequestId(clientRequestId: string): void {
  if (!CLIENT_REQUEST_ID_PATTERN.test(clientRequestId)) {
    throw new LlmRequestIdempotencyError("LLM_IDEMPOTENCY_KEY_INVALID", "对话请求标识格式无效", 400);
  }
}

export function buildLlmBillingIdempotencyKey(clientRequestId: string, phase: LlmBillingPhase): string {
  validateLlmClientRequestId(clientRequestId);
  return `llm:${clientRequestId}:${phase}`;
}

export function fingerprintLlmRequest(payload: Record<string, unknown>): string {
  return sha256(JSON.stringify(canonicalize(payload)));
}

export function createLlmAttemptLeaseOwner(): string {
  return randomUUID();
}

function rowToRecord(row: DatabaseLlmAttemptRow): LlmRequestAttemptRecord {
  if (
    !row.record_id || !SHA256_PATTERN.test(row.record_id) || !row.user_id
    || !row.client_request_id || !CLIENT_REQUEST_ID_PATTERN.test(row.client_request_id)
    || !row.payload_fingerprint || !SHA256_PATTERN.test(row.payload_fingerprint)
    || !row.state || !["running", "succeeded", "failed", "failed_unknown", "reconciliation_required"].includes(row.state)
    || !Number.isSafeInteger(row.attempt_no) || Number(row.attempt_no) < 1
    || !Number.isSafeInteger(row.lease_token) || Number(row.lease_token) < 1
    || !row.created_at || !row.updated_at
  ) {
    throw new LlmRequestIdempotencyError("LLM_ATTEMPT_RECORD_INVALID", "对话幂等记录无效，已停止调用上游模型", 503);
  }
  return {
    recordId: row.record_id,
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    payloadFingerprint: row.payload_fingerprint,
    state: row.state,
    attemptNo: Number(row.attempt_no),
    leaseOwner: row.lease_owner || null,
    leaseToken: Number(row.lease_token),
    leaseExpiresAt: row.lease_expires_at || null,
    providerCallStartedAt: row.provider_call_started_at || null,
    httpStatus: Number.isInteger(row.http_status) ? Number(row.http_status) : null,
    responseHeaders: isPlainObject(row.response_headers) ? row.response_headers : {},
    responseBody: typeof row.response_body === "string" ? row.response_body : null,
    responseFingerprint: row.response_fingerprint || null,
    resultReference: row.result_reference || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String((error as { message?: unknown } | null)?.message || "");
}

function normalizeStoreError(error: unknown): never {
  if (error instanceof LlmRequestIdempotencyError) throw error;
  const message = storeErrorMessage(error);
  if (/LLM_ATTEMPT_(?:PAYLOAD_CONFLICT|LEASE_CONFLICT|TERMINAL_CONFLICT|RESULT_CONFLICT)/i.test(message)) {
    throw new LlmRequestIdempotencyError("LLM_IDEMPOTENCY_CONFLICT", "同一对话请求标识已绑定其他内容或执行终态", 409);
  }
  if (/llm_request_attempts|claim_llm_request_attempt_atomic|mark_llm_request_provider_started_atomic|finalize_llm_request_attempt_atomic|schema cache|does not exist|could not find/i.test(message)) {
    throw new LlmRequestIdempotencyError(
      "LLM_IDEMPOTENCY_MIGRATION_NOT_READY",
      "对话提交保护服务正在准备中，本次未调用模型或产生费用，请稍后重试",
      503,
    );
  }
  throw new LlmRequestIdempotencyError(
    "LLM_IDEMPOTENCY_STORE_UNAVAILABLE",
    "对话提交保护服务暂时不可用，本次未调用模型或产生费用，请稍后重试",
    503,
  );
}

export interface LlmRequestAttemptStore {
  claim(input: {
    userId: string;
    clientRequestId: string;
    payloadFingerprint: string;
    leaseOwner: string;
    leaseSeconds?: number;
  }): Promise<LlmRequestAttemptClaim>;
  markProviderCallStarted(execution: LlmRequestAttemptExecution): Promise<LlmRequestAttemptExecution>;
  finalize(input: {
    execution: LlmRequestAttemptExecution;
    state: Exclude<LlmRequestAttemptState, "running">;
    httpStatus?: number;
    responseHeaders?: JsonObject;
    responseBody?: string;
    responseFingerprint?: string;
    resultReference?: string;
    errorCode?: string;
    errorMessage?: string;
  }): Promise<LlmRequestAttemptRecord>;
}

export class DatabaseLlmRequestAttemptStore implements LlmRequestAttemptStore {
  /** Read-only completed replay shortcut. All lease/retry decisions remain in atomic claim. */
  async readSucceededReplay(input: {
    userId: string; clientRequestId: string; payloadFingerprint: string;
  }): Promise<Extract<LlmRequestAttemptClaim, { action: "replay" }> | null> {
    validateLlmClientRequestId(input.clientRequestId);
    if (!input.userId || !SHA256_PATTERN.test(input.payloadFingerprint)) {
      throw new LlmRequestIdempotencyError("LLM_ATTEMPT_INPUT_INVALID", "对话幂等请求参数无效", 400);
    }
    const expectedRecordId = recordIdFor(input.userId, input.clientRequestId);
    try {
      const { data, error } = await getSupabaseAdminClient().from("llm_request_attempts")
        .select("record_id,user_id,client_request_id,payload_fingerprint,state,attempt_no,lease_owner,lease_token,lease_expires_at,provider_call_started_at,http_status,response_headers,response_body,response_fingerprint,result_reference,error_code,error_message,created_at,updated_at")
        .eq("record_id", expectedRecordId).eq("user_id", input.userId).eq("client_request_id", input.clientRequestId).maybeSingle();
      if (error) normalizeStoreError(error);
      if (!data) return null;
      const record = rowToRecord(data as DatabaseLlmAttemptRow);
      if (record.recordId !== expectedRecordId || record.userId !== input.userId || record.clientRequestId !== input.clientRequestId || record.payloadFingerprint !== input.payloadFingerprint) {
        throw new LlmRequestIdempotencyError("LLM_IDEMPOTENCY_CONFLICT", "同一对话请求标识已绑定其他内容或执行终态", 409);
      }
      return record.state === "succeeded" ? { action: "replay", record } : null;
    } catch (error) { normalizeStoreError(error); }
  }

  async claim(input: {
    userId: string;
    clientRequestId: string;
    payloadFingerprint: string;
    leaseOwner: string;
    leaseSeconds?: number;
  }): Promise<LlmRequestAttemptClaim> {
    validateLlmClientRequestId(input.clientRequestId);
    if (!input.userId || !SHA256_PATTERN.test(input.payloadFingerprint) || !input.leaseOwner) {
      throw new LlmRequestIdempotencyError("LLM_ATTEMPT_INPUT_INVALID", "对话幂等请求参数无效", 400);
    }
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("claim_llm_request_attempt_atomic", {
        p_record_id: recordIdFor(input.userId, input.clientRequestId),
        p_user_id: input.userId,
        p_client_request_id: input.clientRequestId,
        p_payload_fingerprint: input.payloadFingerprint,
        p_lease_owner: input.leaseOwner,
        p_lease_seconds: Math.max(30, Math.min(input.leaseSeconds || DEFAULT_LEASE_SECONDS, 2400)),
      });
      if (error) normalizeStoreError(error);
      const result = data as { action?: string; record?: DatabaseLlmAttemptRow } | null;
      if (!result?.record || !["execute", "replay", "in_progress", "reconciliation_required"].includes(result.action || "")) {
        throw new LlmRequestIdempotencyError("LLM_ATTEMPT_CLAIM_INVALID", "对话幂等服务返回无效占位结果", 503);
      }
      const record = rowToRecord(result.record);
      if (result.action === "execute") {
        if (record.leaseOwner !== input.leaseOwner) {
          throw new LlmRequestIdempotencyError("LLM_ATTEMPT_LEASE_INVALID", "对话执行租约无效", 503);
        }
        return { action: "execute", execution: { record, leaseOwner: input.leaseOwner, leaseToken: record.leaseToken } };
      }
      return { action: result.action as "replay" | "in_progress" | "reconciliation_required", record };
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  async markProviderCallStarted(execution: LlmRequestAttemptExecution): Promise<LlmRequestAttemptExecution> {
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("mark_llm_request_provider_started_atomic", {
        p_record_id: execution.record.recordId,
        p_payload_fingerprint: execution.record.payloadFingerprint,
        p_lease_owner: execution.leaseOwner,
        p_lease_token: execution.leaseToken,
      });
      if (error) normalizeStoreError(error);
      const saved = (data as { record?: DatabaseLlmAttemptRow } | null)?.record;
      if (!saved) throw new LlmRequestIdempotencyError("LLM_ATTEMPT_MARK_INVALID", "上游调用标记未确认持久化", 503);
      return { ...execution, record: rowToRecord(saved) };
    } catch (error) {
      normalizeStoreError(error);
    }
  }

  async finalize(input: Parameters<LlmRequestAttemptStore["finalize"]>[0]): Promise<LlmRequestAttemptRecord> {
    try {
      const db = getSupabaseAdminClient();
      const { data, error } = await db.rpc("finalize_llm_request_attempt_atomic", {
        p_record_id: input.execution.record.recordId,
        p_payload_fingerprint: input.execution.record.payloadFingerprint,
        p_lease_owner: input.execution.leaseOwner,
        p_lease_token: input.execution.leaseToken,
        p_state: input.state,
        p_http_status: input.httpStatus ?? null,
        p_response_headers: input.responseHeaders || {},
        p_response_body: input.responseBody ?? null,
        p_response_fingerprint: input.responseFingerprint || null,
        p_result_reference: input.resultReference || null,
        p_error_code: input.errorCode || null,
        p_error_message: input.errorMessage || null,
      });
      if (error) normalizeStoreError(error);
      const saved = (data as { record?: DatabaseLlmAttemptRow } | null)?.record;
      if (!saved) throw new LlmRequestIdempotencyError("LLM_ATTEMPT_FINALIZE_INVALID", "对话终态未确认持久化", 503);
      return rowToRecord(saved);
    } catch (error) {
      normalizeStoreError(error);
    }
  }
}

function replayHeaders(record: LlmRequestAttemptRecord): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record.responseHeaders)) {
    if (typeof value === "string" && !["set-cookie", "content-length", "transfer-encoding"].includes(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("Cache-Control", "no-store");
  headers.set("X-LLM-Replayed", "true");
  headers.set("X-LLM-Attempt-Id", record.recordId);
  if (record.resultReference) headers.set("X-LLM-Result-Reference", record.resultReference);
  return headers;
}

export function responseForLlmAttemptClaim(claim: Exclude<LlmRequestAttemptClaim, { action: "execute" }>): Response {
  if (claim.action === "replay") {
    if (claim.record.state !== "succeeded" || claim.record.httpStatus === null || claim.record.responseBody === null
      || Buffer.byteLength(claim.record.responseBody, "utf8") > MAX_STORY_DIRECTOR_RESPONSE_BYTES
      || claim.record.responseFingerprint !== sha256(claim.record.responseBody)) {
      throw new LlmRequestIdempotencyError("LLM_ATTEMPT_REPLAY_INVALID", "已完成对话缺少可回放结果", 503);
    }
    return new Response(claim.record.responseBody, { status: claim.record.httpStatus, headers: replayHeaders(claim.record) });
  }
  const reconciliation = claim.action === "reconciliation_required";
  return new Response(JSON.stringify({
    error: reconciliation
      ? "这条对话的结果暂未确认，原请求已保留。请稍后查看聊天记录。"
      : "该对话请求正在由另一实例处理，本次不会重复调用模型",
    code: reconciliation ? "LLM_ATTEMPT_RECONCILIATION_REQUIRED" : "LLM_ATTEMPT_IN_PROGRESS",
    retryable: false,
    retry_safe: false,
    attempt_id: claim.record.recordId,
    state: claim.record.state,
  }), {
    status: 409,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": "3",
      "X-LLM-Attempt-Id": claim.record.recordId,
    },
  });
}

function persistedHeaders(response: Response): JsonObject {
  const headers: JsonObject = {};
  for (const [key, value] of response.headers.entries()) {
    if (!["set-cookie", "content-length", "transfer-encoding", "connection"].includes(key.toLowerCase())) headers[key] = value;
  }
  return headers;
}

function resultReference(execution: LlmRequestAttemptExecution, bodyFingerprint: string): string {
  return `llm-result:${execution.record.recordId}:${execution.record.attemptNo}:${bodyFingerprint}`;
}

async function finalizeWithRetry(
  store: LlmRequestAttemptStore,
  input: Parameters<LlmRequestAttemptStore["finalize"]>[0],
): Promise<LlmRequestAttemptRecord> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await store.finalize(input);
    } catch (error) {
      lastError = error;
      if (error instanceof LlmRequestIdempotencyError && ["LLM_IDEMPOTENCY_CONFLICT", "LLM_IDEMPOTENCY_MIGRATION_NOT_READY"].includes(error.code)) throw error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
  throw lastError;
}

function frozenResponse(execution: LlmRequestAttemptExecution, message: string): Response {
  return new Response(JSON.stringify({
    error: message,
    code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED",
    retryable: false,
    retry_safe: false,
    attempt_id: execution.record.recordId,
  }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-LLM-Attempt-Id": execution.record.recordId },
  });
}

function inspectLlmSseFrame(frame: string) {
  const dataLines: string[] = [];
  let event = "";
  for (const line of frame.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /u, "");
    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
  }
  const data = dataLines.join("\n");
  let payload: JsonObject | undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (isPlainObject(parsed)) payload = parsed;
  } catch {
    // Text deltas, comments and [DONE] are valid non-JSON SSE content.
  }
  const doneSignal = data.trim() === "[DONE]";
  const completionEvent = event === "done" || event === "conversation.chat.completed";
  const billingComplete = payload?.billing_complete === true;
  return {
    doneSignal,
    completionEvent,
    billingComplete,
    errorCode: typeof payload?.code === "string" ? payload.code : undefined,
    // Only protocol fields may delay delivery; model text can mention these markers.
    withhold: doneSignal || completionEvent || billingComplete
      || event === "billing.completed" || event === "conversation.message.completed",
  };
}

function streamTerminalState(frames: ReturnType<typeof inspectLlmSseFrame>[]): {
  state: "succeeded" | "failed" | "failed_unknown" | "reconciliation_required";
  errorCode?: string;
} {
  if (frames.some((frame) => frame.errorCode === "LLM_BILLING_FAILED")) return { state: "reconciliation_required", errorCode: "LLM_BILLING_FAILED" };
  // Once execution is uncertain, another generic failure frame must not make
  // the attempt replayable. A settlement receipt requires explicit reconciliation.
  if (frames.some((frame) => frame.errorCode === "LLM_UPSTREAM_RESULT_UNKNOWN")) {
    return frames.some((frame) => frame.billingComplete)
      ? { state: "reconciliation_required", errorCode: "LLM_STREAM_BILLING_CONFLICT" }
      : { state: "failed_unknown", errorCode: "LLM_UPSTREAM_RESULT_UNKNOWN" };
  }
  if (frames.some((frame) => frame.errorCode === "LLM_EMPTY_RESPONSE")) return { state: "failed", errorCode: "LLM_EMPTY_RESPONSE" };
  const knownFailure = frames.find((frame) => frame.errorCode && [
    "LLM_UPSTREAM_ERROR", "LLM_UPSTREAM_BALANCE", "LLM_UPSTREAM_BILLING", "LLM_UPSTREAM_AUTH",
    "LLM_UPSTREAM_BUSY", "LLM_UPSTREAM_CONCURRENCY_LIMIT", "LLM_UPSTREAM_TIMEOUT", "LLM_UPSTREAM_CONTENT_REJECTED",
    "LLM_STREAM_INTERRUPTED",
  ].includes(frame.errorCode));
  if (knownFailure) {
    // These errors are emitted before settlement by the stream handler. Preserve
    // a repeatable failure receipt; a billing receipt in the same stream is a conflict.
    return frames.some((frame) => frame.billingComplete)
      ? { state: "reconciliation_required", errorCode: "LLM_STREAM_BILLING_CONFLICT" }
      : { state: "failed", errorCode: knownFailure.errorCode };
  }
  const hasCompletionFrame = frames.some((frame) => frame.doneSignal || frame.completionEvent);
  if (hasCompletionFrame && frames.some((frame) => frame.billingComplete)) return { state: "succeeded" };
  return { state: "failed_unknown", errorCode: "LLM_STREAM_TERMINAL_UNKNOWN" };
}

export async function completeLlmAttemptResponse(
  store: LlmRequestAttemptStore,
  execution: LlmRequestAttemptExecution,
  response: Response,
  serverAgentRow?: { id?: unknown } | null,
): Promise<Response> {
  const maxPersistedResponseBytes = resolveLlmResponsePersistenceLimit(serverAgentRow);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/event-stream") || !response.body) {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > maxPersistedResponseBytes) {
      await finalizeWithRetry(store, { execution, state: "reconciliation_required", errorCode: "LLM_RESPONSE_TOO_LARGE", errorMessage: "response exceeded durable replay limit" }).catch(() => undefined);
      return frozenResponse(execution, "回复内容过大，暂未完成保存。原请求已保留。");
    }
    const headers = persistedHeaders(response);
    if (response.ok) {
      const responseFingerprint = sha256(raw);
      try {
        const saved = await finalizeWithRetry(store, {
          execution,
          state: "succeeded",
          httpStatus: response.status,
          responseHeaders: headers,
          responseBody: raw,
          responseFingerprint,
          resultReference: resultReference(execution, responseFingerprint),
        });
        const outgoing = new Headers(response.headers);
        outgoing.set("Cache-Control", "no-store");
        outgoing.set("X-LLM-Replayed", "false");
        outgoing.set("X-LLM-Attempt-Id", saved.recordId);
        if (saved.resultReference) outgoing.set("X-LLM-Result-Reference", saved.resultReference);
        return new Response(raw, { status: response.status, headers: outgoing });
      } catch {
        return frozenResponse(execution, "回复已生成，保存结果暂未确认。请稍后查看聊天记录。");
      }
    }
    const definitive = response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
    try {
      await finalizeWithRetry(store, {
        execution,
        state: definitive ? "failed" : "failed_unknown",
        ...(definitive ? { httpStatus: response.status, responseHeaders: headers, responseBody: raw, responseFingerprint: sha256(raw) } : {}),
        errorCode: definitive ? "LLM_DEFINITIVE_FAILURE" : "LLM_RESPONSE_TERMINAL_UNKNOWN",
        errorMessage: raw.slice(0, 500),
      });
      if (!definitive) return frozenResponse(execution, "这条对话的结果暂未确认，原请求已保留。请稍后查看聊天记录。");
      const outgoing = new Headers(response.headers);
      outgoing.set("Cache-Control", "no-store");
      outgoing.set("X-LLM-Attempt-Id", execution.record.recordId);
      outgoing.set("X-LLM-Retry-Safe", "true");
      return new Response(raw, { status: response.status, headers: outgoing });
    } catch {
      return frozenResponse(execution, "这次对话未完成，失败状态暂未保存。原请求已保留。");
    }
  }

  const reader = response.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rawParts: string[] = [];
  const withheldTerminalFrames: string[] = [];
  let totalBytes = 0;
  let exceeded = false;
  const continueAfterDisconnect = response.headers.get("X-LLM-Continue-After-Disconnect") === "true";
  let detached = false;
  const wrapped = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: Uint8Array) => {
        if (detached) return;
        try { controller.enqueue(chunk); } catch (error) {
          if (!continueAfterDisconnect) throw error;
          detached = true;
        }
      };
      const close = () => { if (!detached) controller.close(); };
      let pendingFrameText = "";
      const releaseCompleteFrames = (flushRemainder = false) => {
        while (pendingFrameText) {
          const boundary = /\r?\n\r?\n/u.exec(pendingFrameText);
          if (!boundary && !flushRemainder) return;
          const frameEnd = boundary ? boundary.index + boundary[0].length : pendingFrameText.length;
          const frame = pendingFrameText.slice(0, frameEnd);
          pendingFrameText = pendingFrameText.slice(frameEnd);
          if (inspectLlmSseFrame(frame).withhold) withheldTerminalFrames.push(frame);
          else enqueue(encoder.encode(frame));
        }
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          const decoded = decoder.decode(value, { stream: true });
          if (totalBytes <= maxPersistedResponseBytes) {
            rawParts.push(decoded);
            pendingFrameText += decoded;
            releaseCompleteFrames();
          } else {
            // Drain the upstream for its existing billing/finalization path, but
            // retain and deliver no more data after the durable byte budget.
            exceeded = true;
            rawParts.length = 0;
            withheldTerminalFrames.length = 0;
            pendingFrameText = "";
          }
        }
        const decoderTail = decoder.decode();
        if (!exceeded) rawParts.push(decoderTail);
        pendingFrameText += decoderTail;
        releaseCompleteFrames(true);
        const raw = rawParts.join("");
        if (exceeded) {
          await finalizeWithRetry(store, { execution, state: "reconciliation_required", errorCode: "LLM_STREAM_RESPONSE_TOO_LARGE", errorMessage: "stream exceeded durable replay limit" });
          enqueue(encoder.encode(`data: ${JSON.stringify({ error: "回复内容过大，暂未完成保存。原请求已保留。", code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED", done: false })}\n\n`));
          close();
          return;
        }
        const frames = raw.split(/\r?\n\r?\n/u).map(inspectLlmSseFrame);
        const terminal = streamTerminalState(frames);
        if (terminal.state === "succeeded") {
          const persistedRaw = frames.some((frame) => frame.doneSignal)
            ? raw
            : `${raw}${raw.endsWith("\n") ? "" : "\n"}data: [DONE]\n\n`;
          // Completion synthesis is part of the stored bytes and must fit too.
          if (Buffer.byteLength(persistedRaw, "utf8") > maxPersistedResponseBytes) {
            await finalizeWithRetry(store, { execution, state: "reconciliation_required", errorCode: "LLM_STREAM_RESPONSE_TOO_LARGE", errorMessage: "stream completion exceeded durable replay limit" });
            enqueue(encoder.encode(`data: ${JSON.stringify({ error: "回复内容过大，暂未完成保存。原请求已保留。", code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED", done: false })}\n\n`));
            close();
            return;
          }
          const responseFingerprint = sha256(persistedRaw);
          await finalizeWithRetry(store, {
            execution,
            state: "succeeded",
            httpStatus: response.status,
            responseHeaders: persistedHeaders(response),
            responseBody: persistedRaw,
            responseFingerprint,
            resultReference: resultReference(execution, responseFingerprint),
          });
          for (const terminalFrame of withheldTerminalFrames) enqueue(encoder.encode(terminalFrame));
          if (!withheldTerminalFrames.some((frame) => inspectLlmSseFrame(frame).doneSignal)) {
            enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          close();
          return;
        }
        await finalizeWithRetry(store, {
          execution,
          state: terminal.state,
          ...(terminal.state === "failed" ? { httpStatus: 422, responseHeaders: persistedHeaders(response), responseBody: raw, responseFingerprint: sha256(raw) } : {}),
          errorCode: terminal.errorCode,
          errorMessage: terminal.errorCode === "LLM_STREAM_TERMINAL_UNKNOWN"
            ? "stream closed without a durable successful completion marker"
            : `stream failed: ${terminal.errorCode}`,
        });
        if (terminal.state !== "failed") {
          enqueue(encoder.encode(`data: ${JSON.stringify({ error: "这次回复未完成，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。", code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED", done: false, retry_safe: false })}\n\n`));
        }
        close();
      } catch (error) {
        await finalizeWithRetry(store, {
          execution,
          state: "failed_unknown",
          errorCode: "LLM_STREAM_PERSISTENCE_UNKNOWN",
          errorMessage: error instanceof Error ? error.message : "unknown",
        }).catch(() => undefined);
        try {
          enqueue(encoder.encode(`data: ${JSON.stringify({ error: "回复中断，最终结果暂未确认。原请求已保留，请稍后查看聊天记录。", code: "LLM_ATTEMPT_RECONCILIATION_REQUIRED", done: false })}\n\n`));
          close();
        } catch {
          // Client disconnected; the durable row remains fail-closed.
        }
      }
    },
    async cancel(reason) {
      if (continueAfterDisconnect) { detached = true; return; }
      await reader.cancel(reason).catch(() => undefined);
      await finalizeWithRetry(store, {
        execution,
        state: "failed_unknown",
        errorCode: "LLM_STREAM_CLIENT_DISCONNECTED",
        errorMessage: "client disconnected before durable completion",
      }).catch(() => undefined);
    },
  });
  const outgoing = new Headers(response.headers);
  outgoing.set("Cache-Control", "no-store");
  outgoing.set("X-LLM-Replayed", "false");
  outgoing.set("X-LLM-Attempt-Id", execution.record.recordId);
  return new Response(wrapped, { status: response.status, headers: outgoing });
}

export async function finalizeLlmAttemptFromThrownError(
  store: LlmRequestAttemptStore,
  execution: LlmRequestAttemptExecution,
  providerCallStarted: boolean,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error || "unknown");
  const ambiguousTransport = /ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|aborted|aborterror|network error|524|gateway timeout/i.test(message);
  const statusMatch = message.match(/(?:http(?:_status)?|status|response|code)[=:\s_-]*(4\d{2})\b/i)
    || message.match(/\b(4\d{2})\b/);
  const explicitStatus = !ambiguousTransport && statusMatch ? Number(statusMatch[1]) : null;
  const explicitProviderRejection = providerCallStarted && (
    explicitStatus !== null
    || /invalid api key|authentication|unauthorized|forbidden|rate limit|too many requests|balance exhausted|not a chat model|model not found/i.test(message)
  );
  const definitiveFailure = !providerCallStarted || explicitProviderRejection;
  const failureCode = !providerCallStarted
    ? "LLM_PRE_PROVIDER_FAILURE"
    : "LLM_UPSTREAM_DEFINITIVE_FAILURE";
  const failureBody = JSON.stringify({ code: failureCode, ...(explicitStatus ? { upstream_status: explicitStatus } : {}) });
  await finalizeWithRetry(store, {
    execution,
    state: definitiveFailure ? "failed" : "failed_unknown",
    ...(definitiveFailure ? {
      httpStatus: explicitStatus || 500,
      responseHeaders: { "content-type": "application/json" },
      responseBody: failureBody,
      responseFingerprint: sha256(failureBody),
    } : {}),
    errorCode: definitiveFailure ? failureCode : "LLM_UPSTREAM_TERMINAL_UNKNOWN",
    errorMessage: message.slice(0, 500),
  });
}
