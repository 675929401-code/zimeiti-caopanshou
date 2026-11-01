/**
 * Shared provider-adapter contract for image and video media gateways.
 *
 * This file intentionally contains types and small, side-effect-free helpers
 * only. Existing image/video routes keep their current behavior until a
 * protocol family is migrated behind this contract. The contract makes the
 * boundaries explicit: request construction, submission acknowledgement,
 * polling, status mapping, error mapping, and media URL extraction are owned
 * by an adapter; billing and platform asset persistence remain outside it.
 */

export type ProviderMediaKind = "image" | "video";

/** A stable registry key; provider-specific names may be added without changing the contract. */
export type ProviderProtocolFamily = string & {};

export type ProviderTaskState =
  | "created"
  | "queued"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export type ProviderErrorKind =
  | "validation"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "upstream"
  | "response"
  | "unknown";

export interface ProviderAdapterContext {
  mediaKind: ProviderMediaKind;
  /** Public platform model id used for tracing and capability binding. */
  publicModelId: string;
  /** Provider-side model/workflow name; never expose this in public DTOs. */
  providerModelId?: string;
  protocol: ProviderProtocolFamily;
  endpoint: string;
  requestId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  attempt: number;
  signal?: AbortSignal;
}

export interface ProviderRequestSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** The adapter owns serialization; callers must not assume JSON. */
  body?: unknown;
}

export interface ProviderSubmissionReceipt {
  schemaVersion: 1;
  provider: string;
  protocol: ProviderProtocolFamily;
  endpointHost: string;
  requestKeySha256: string;
  httpStatus?: number;
  responseBodySha256?: string;
  responseParseState?: "json_object" | "json_array" | "text" | "empty" | "malformed" | "unreadable";
  providerRequestId?: string;
}

export interface ProviderSubmissionResult {
  /** Provider task id. Missing task id means the submission must be reconciled, never blindly retried. */
  providerTaskId?: string;
  state: ProviderTaskState;
  progress?: number | null;
  contentUrl?: string;
  mediaUrl?: string;
  receipt?: ProviderSubmissionReceipt;
  raw?: unknown;
}

export interface ProviderPollResult extends ProviderSubmissionResult {
  providerTaskId: string;
}

export interface ProviderError {
  kind: ProviderErrorKind;
  code: string;
  message: string;
  retryable: boolean;
  upstreamStatus?: number;
  providerTaskId?: string;
  raw?: unknown;
}

export interface ProviderAdapter<Input = unknown, ModelConfig = unknown> {
  readonly id: string;
  readonly mediaKind: ProviderMediaKind;
  readonly protocol: ProviderProtocolFamily;

  /** Optional pure request projection. It must not perform network I/O. */
  buildSubmitRequest?: (
    input: Input,
    context: ProviderAdapterContext,
    modelConfig: ModelConfig,
  ) => Promise<ProviderRequestSpec> | ProviderRequestSpec;

  /** Submit exactly once for a given idempotency key. */
  submit: (
    input: Input,
    context: ProviderAdapterContext,
    modelConfig: ModelConfig,
  ) => Promise<ProviderSubmissionResult>;

  /** Poll an already acknowledged provider task. Polling may be repeated safely. */
  poll: (
    providerTaskId: string,
    context: ProviderAdapterContext,
    modelConfig: ModelConfig,
  ) => Promise<ProviderPollResult>;

  /** Convert provider-specific status values into the canonical state vocabulary. */
  mapStatus: (payload: unknown) => ProviderTaskState;

  /** Extract a stable provider task id from a submit or poll response. */
  extractTaskId: (payload: unknown) => string | null;

  /** Extract a provider media URL without persisting or downloading it. */
  extractMediaUrl: (payload: unknown) => string | null;

  /** Convert transport, HTTP, and provider response failures into a canonical error. */
  mapError: (error: unknown, payload?: unknown) => ProviderError;
}

export interface ProviderAdapterRegistry {
  get<TInput = unknown, TModelConfig = unknown>(
    mediaKind: ProviderMediaKind,
    protocol: ProviderProtocolFamily,
  ): ProviderAdapter<TInput, TModelConfig> | undefined;
  list(mediaKind?: ProviderMediaKind): readonly ProviderAdapter[];
}

export function isTerminalProviderState(state: ProviderTaskState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function clampProviderProgress(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  const percentage = numeric >= 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(percentage)));
}
