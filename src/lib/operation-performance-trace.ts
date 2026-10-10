import { createHash, randomUUID } from "node:crypto";

export const operationPerformancePhases = [
  "request.received",
  "auth.permission",
  "database.read",
  "upstream.wait",
  "response.first_byte",
  "result.persistence",
  "response.terminal",
] as const;

export type OperationPerformancePhase = (typeof operationPerformancePhases)[number];
export type OperationPerformanceOutcome = "in_progress" | "success" | "warning" | "error" | "cancelled" | "unknown";
export type OperationPerformanceDomain = "chat" | "extract" | "admin" | "image" | "video" | "voice" | "storage" | "other";

export interface OperationPerformanceCorrelation {
  request_id: string;
  trace_id: string;
  user_ref: string | null;
  account_ref: string | null;
  task_id: string | null;
  agent_id: string | null;
}

export interface OperationPerformanceEvent extends OperationPerformanceCorrelation {
  domain: OperationPerformanceDomain;
  operation: string;
  route: string;
  phase: OperationPerformancePhase;
  outcome: OperationPerformanceOutcome;
  duration_ms: number;
  elapsed_ms: number;
  http_status: number | null;
  error_code: string | null;
  occurred_at: string;
}

export type OperationPerformanceEmitter = (event: OperationPerformanceEvent) => void | Promise<void>;

interface CreateOperationPerformanceTraceInput {
  domain: OperationPerformanceDomain;
  operation: string;
  route: string;
  requestId?: unknown;
  traceId?: unknown;
  userId?: unknown;
  accountId?: unknown;
  taskId?: unknown;
  agentId?: unknown;
}

type OperationPerformanceIdentityUpdate = Pick<
  CreateOperationPerformanceTraceInput,
  "userId" | "accountId" | "taskId" | "agentId"
>;

interface PerformanceClock {
  now(): number;
  isoNow(): string;
}

const TRACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$/u;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;
const SAFE_OPERATION_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/u;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedCorrelationId(value: unknown, prefix: "req" | "trace"): string {
  if (typeof value === "string") {
    const candidate = value.trim();
    if (TRACE_PATTERN.test(candidate)) return candidate;
    if (candidate) return `${prefix}_${sha256(candidate).slice(0, 24)}`;
  }
  return `${prefix}_${randomUUID()}`;
}

function opaqueRef(prefix: "usr" | "acct", value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return `${prefix}_${sha256(value.trim()).slice(0, 16)}`;
}

function safeStableId(value: unknown, prefix: "task" | "agent"): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = value.trim();
  if (TRACE_PATTERN.test(candidate)) return candidate;
  return `${prefix}_${sha256(candidate).slice(0, 24)}`;
}

function safeOperation(value: string): string {
  const candidate = value.trim();
  return SAFE_OPERATION_PATTERN.test(candidate) ? candidate : `operation_${sha256(candidate).slice(0, 24)}`;
}

function safeRoute(value: string): string {
  try {
    const path = new URL(value, "http://operation.local").pathname.replace(/\/{2,}/gu, "/");
    return path.startsWith("/") ? path.slice(0, 512) : "/unknown";
  } catch {
    return "/unknown";
  }
}

function safeDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(86_400_000, Math.round(value)));
}

function safeHttpStatus(value: number | null | undefined): number | null {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : null;
}

function safeErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  return SAFE_CODE_PATTERN.test(candidate) ? candidate : "OPERATION_ERROR";
}

const systemClock: PerformanceClock = {
  now: () => performance.now(),
  isoNow: () => new Date().toISOString(),
};

/**
 * Builds a bounded, content-free performance trace. Raw user/account values are
 * one-way hashed and arbitrary metadata is deliberately unsupported, so prompts,
 * response bodies, credentials and signed URLs cannot enter the event contract.
 */
export function createOperationPerformanceTrace(
  input: CreateOperationPerformanceTraceInput,
  emit: OperationPerformanceEmitter,
  clock: PerformanceClock = systemClock,
) {
  const requestId = normalizedCorrelationId(input.requestId, "req");
  const traceId = normalizedCorrelationId(input.traceId ?? requestId, "trace");
  let correlation: OperationPerformanceCorrelation = Object.freeze({
    request_id: requestId,
    trace_id: traceId,
    user_ref: opaqueRef("usr", input.userId),
    account_ref: opaqueRef("acct", input.accountId ?? input.userId),
    task_id: safeStableId(input.taskId, "task"),
    agent_id: safeStableId(input.agentId, "agent"),
  });
  const domain = input.domain;
  const operation = safeOperation(input.operation);
  const route = safeRoute(input.route);
  const startedAt = clock.now();
  let checkpointAt = startedAt;

  function enrichIdentity(update: OperationPerformanceIdentityUpdate): OperationPerformanceCorrelation {
    correlation = Object.freeze({
      ...correlation,
      ...(update.userId !== undefined ? { user_ref: opaqueRef("usr", update.userId) } : {}),
      ...(update.accountId !== undefined || update.userId !== undefined
        ? { account_ref: opaqueRef("acct", update.accountId ?? update.userId) }
        : {}),
      ...(update.taskId !== undefined ? { task_id: safeStableId(update.taskId, "task") } : {}),
      ...(update.agentId !== undefined ? { agent_id: safeStableId(update.agentId, "agent") } : {}),
    });
    return correlation;
  }

  function checkpoint(
    phase: OperationPerformancePhase,
    options: {
      outcome?: OperationPerformanceOutcome;
      httpStatus?: number | null;
      errorCode?: string | null;
    } = {},
  ): OperationPerformanceEvent {
    const now = clock.now();
    const event: OperationPerformanceEvent = Object.freeze({
      ...correlation,
      domain,
      operation,
      route,
      phase,
      outcome: options.outcome ?? "success",
      duration_ms: safeDuration(now - checkpointAt),
      elapsed_ms: safeDuration(now - startedAt),
      http_status: safeHttpStatus(options.httpStatus),
      error_code: safeErrorCode(options.errorCode),
      occurred_at: clock.isoNow(),
    });
    checkpointAt = now;
    try {
      Promise.resolve(emit(event)).catch(() => undefined);
    } catch {
      // Observability is best-effort and must never change the business result.
    }
    return event;
  }

  return {
    get correlation() { return correlation; },
    enrichIdentity,
    checkpoint,
  };
}

export type OperationPerformanceTrace = ReturnType<typeof createOperationPerformanceTrace>;
