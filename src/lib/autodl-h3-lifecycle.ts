import { createHash, randomUUID } from "node:crypto";

import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

/**
 * Durable lifecycle primitives for the exact AutoDL self-hosted MiniMax H3
 * channel. This module does not select models and never exposes a release API.
 * Network, tunnel and H3 dispatch operations are dependency-injected so unit
 * tests and the default runtime cannot spend money.
 */

export const AUTODL_H3_JOB_STATES = [
  "ACCEPTED",
  "WAITING_POWER",
  "WAITING_READY",
  "DISPATCHING",
  "QUEUED",
  "RUNNING",
  "RESULT_STAGING",
  "PERSISTING",
  "FINALIZING",
  "SUCCEEDED",
  "RETRY_WAIT",
  "FAILED_TERMINAL",
  "CANCELLED",
  "RECOVERY_REQUIRED",
] as const;

export type AutodlH3JobState = (typeof AUTODL_H3_JOB_STATES)[number];

export const AUTODL_H3_INSTANCE_STATES = [
  "OFF",
  "START_REQUESTED",
  "STARTING",
  "BOOTSTRAPPING",
  "READY",
  "BUSY",
  "IDLE_GRACE",
  "DRAINING",
  "STOP_REQUESTED",
  "STOPPING",
  "UNKNOWN",
  "FAULTED",
] as const;

export type AutodlH3InstanceState = (typeof AUTODL_H3_INSTANCE_STATES)[number];
export type AutodlH3PowerState = "running" | "stopped" | "starting" | "stopping" | "unknown";

const TERMINAL_JOB_STATES = new Set<AutodlH3JobState>([
  "SUCCEEDED",
  "FAILED_TERMINAL",
  "CANCELLED",
]);

const SECRET_KEY_PATTERN = /(?:api[_-]?key|access[_-]?key|token|secret|password|authorization|cookie|credential|endpoint)/iu;
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u;
const MAX_PAYLOAD_BYTES = 128 * 1024;
const MIN_IDLE_GRACE_MS = 300_000;

export interface AutodlH3Job {
  id: string;
  publicTaskId: string;
  clientRequestId: string;
  videoTaskInternalId: string | null;
  userId: string;
  modelId: string;
  instanceUuid: string;
  requestPayload: Record<string, unknown>;
  state: AutodlH3JobState;
  upstreamTaskId: string | null;
  contentUrl: string | null;
  resultAssetUrl: string | null;
  progress: number;
  attemptCount: number;
  notBefore: string | null;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AutodlH3InstanceLease {
  instanceUuid: string;
  lifecycleState: AutodlH3InstanceState;
  lastActivityAt: string | null;
  idleSince: string | null;
  leaseOwner: string;
  leaseToken: number;
  leaseExpiresAt: string;
  activityEpoch: number;
  shutdownEpoch: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  stateChangedAt: string;
  updatedAt: string;
}

export interface EnqueueAutodlH3VideoJobInput {
  userId: string;
  modelId: string;
  idempotencyKey: string;
  publicTaskId?: string;
  videoTaskInternalId?: string | null;
  requestPayload: Record<string, unknown>;
  instanceUuid?: string;
}

export interface EnqueueAutodlH3VideoJobResult {
  job: AutodlH3Job;
  publicTaskId: string;
  state: AutodlH3JobState;
  created: boolean;
}

export interface AutodlH3JobProgressInput {
  jobId: string;
  publicTaskId: string;
  userId: string;
  leaseOwner: string;
  leaseToken: number;
  state: AutodlH3JobState;
  upstreamTaskId?: string | null;
  contentUrl?: string | null;
  resultAssetUrl?: string | null;
  progress?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface AutodlH3LifecycleStore {
  enqueueJob(input: Required<Pick<EnqueueAutodlH3VideoJobInput,
    "userId" | "modelId" | "idempotencyKey" | "publicTaskId" | "requestPayload" | "instanceUuid"
  >> & { videoTaskInternalId: string | null }): Promise<{ job: AutodlH3Job; created: boolean }>;
  getJobByPublicTaskId(publicTaskId: string, userId?: string): Promise<AutodlH3Job | null>;
  markJobProgress(input: AutodlH3JobProgressInput): Promise<AutodlH3Job | null>;
  countBlockingJobs(instanceUuid: string): Promise<number>;
  acquireInstanceLease(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3InstanceLease | null>;
  renewInstanceLease(instanceUuid: string, owner: string, leaseToken: number, leaseSeconds: number): Promise<boolean>;
  renewJobLease(jobId: string, owner: string, leaseToken: number, leaseSeconds: number): Promise<boolean>;
  updateInstanceState(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    lifecycleState: AutodlH3InstanceState;
    lastActivityAt: string | null;
    idleSince: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }): Promise<AutodlH3InstanceLease | null>;
  prepareShutdown(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    expectedActivityEpoch: number;
    idleGraceSeconds: number;
  }): Promise<AutodlH3InstanceLease | null>;
  confirmShutdown(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    expectedShutdownEpoch: number;
  }): Promise<AutodlH3InstanceLease | null>;
  claimNextJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null>;
  claimActiveJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null>;
  claimUnknownDispatchJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null>;
  transitionClaimedJob(input: {
    jobId: string;
    owner: string;
    leaseToken: number;
    state: AutodlH3JobState;
    upstreamTaskId?: string | null;
    contentUrl?: string | null;
    resultAssetUrl?: string | null;
    progress?: number;
    notBefore?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<AutodlH3Job | null>;
}

export interface AutodlH3SafeSnapshot {
  instanceUuid: string;
  sshHost?: string;
  sshPort?: number;
  status?: string;
}

/** Deliberately omits release/delete. */
export interface AutodlH3InstanceClient {
  getStatus(instanceUuid: string): Promise<{ powerState: AutodlH3PowerState }>;
  getSnapshot(instanceUuid: string): Promise<AutodlH3SafeSnapshot>;
  powerOn(instanceUuid: string): Promise<{ accepted: boolean }>;
  powerOff(instanceUuid: string): Promise<{ accepted: boolean }>;
}

export interface AutodlH3TunnelSupervisor {
  ensureReady(input: { instanceUuid: string; snapshot: AutodlH3SafeSnapshot }): Promise<{ ready: boolean; reason?: string }>;
  isReady(input: { instanceUuid: string }): Promise<boolean>;
}

export interface AutodlH3RuntimeActivity {
  queued: number;
  running: number;
  resultStaging: number;
  persisting: number;
  finalizing: number;
  recovery: number;
}

export interface AutodlH3JobDispatcher {
  dispatch(job: AutodlH3Job): Promise<{ upstreamTaskId: string; contentUrl?: string | null }>;
  recoverUnknownDispatch(job: AutodlH3Job): Promise<
    | { outcome: "found"; upstreamTaskId: string; contentUrl?: string | null }
    | { outcome: "not_found" }
    | { outcome: "unknown"; errorCode?: string; errorMessage?: string }
  >;
  reconcile(job: AutodlH3Job): Promise<{
    state: Extract<AutodlH3JobState,
      "QUEUED" | "RUNNING" | "RESULT_STAGING" | "PERSISTING" | "FINALIZING" | "SUCCEEDED" | "FAILED_TERMINAL" | "RECOVERY_REQUIRED"
    >;
    progress?: number;
    contentUrl?: string | null;
    resultAssetUrl?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }>;
  getActivity(instanceUuid: string): Promise<AutodlH3RuntimeActivity>;
}

export interface AutodlH3LifecycleControllerConfig {
  enabled: boolean;
  dryRun: boolean;
  allowPowerActions: boolean;
  instanceUuid: string;
  ownerId: string;
  leaseSeconds: number;
  idleGraceMs: number;
  retryDelayMs: number;
  maxDispatchAttempts: number;
  startupDeadlineMs: number;
  powerActionDeadlineMs: number;
}

export type AutodlH3LifecycleTickResult =
  | { action: "disabled" | "lease_busy" | "local_tick_busy" | "idle_wait" | "power_on_blocked" | "power_off_blocked" | "starting" | "stopping" | "not_ready" | "no_job" }
  | { action: "power_on_requested" | "power_off_requested" | "dispatched" | "recovered" | "reconciled" | "recovery_wait"; publicTaskId?: string; upstreamTaskId?: string }
  | { action: "faulted"; code: string };

function requireNonEmpty(value: unknown, field: string, max = 256): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > max) {
    throw new Error(`AUTODL_H3_INVALID_${field.toUpperCase()}`);
  }
  return normalized;
}

function sanitizeDiagnostic(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/((?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:sig|sign|signature|token|key|auth|authorization|expires)=)[^&#\s]+/giu, "$1[REDACTED]")
    .replace(/((?:%3F|%26)(?:sig|sign|signature|token|key|auth|authorization|expires)%3D)[^%\s]+/giu, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/gu, "[REDACTED]")
    .slice(0, max);
}

export function sanitizeAutodlH3Diagnostic(value: unknown, max = 500): string {
  return sanitizeDiagnostic(value, max);
}

const ALLOWED_JOB_TRANSITIONS: Record<AutodlH3JobState, ReadonlySet<AutodlH3JobState>> = {
  ACCEPTED: new Set(["WAITING_POWER", "WAITING_READY", "DISPATCHING", "FAILED_TERMINAL", "CANCELLED"]),
  WAITING_POWER: new Set(["WAITING_READY", "DISPATCHING", "FAILED_TERMINAL", "CANCELLED"]),
  WAITING_READY: new Set(["DISPATCHING", "FAILED_TERMINAL", "CANCELLED"]),
  DISPATCHING: new Set(["QUEUED", "RETRY_WAIT", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  QUEUED: new Set(["RUNNING", "RESULT_STAGING", "PERSISTING", "FINALIZING", "SUCCEEDED", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  RUNNING: new Set(["RESULT_STAGING", "PERSISTING", "FINALIZING", "SUCCEEDED", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  RESULT_STAGING: new Set(["PERSISTING", "FINALIZING", "SUCCEEDED", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  PERSISTING: new Set(["FINALIZING", "SUCCEEDED", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  FINALIZING: new Set(["SUCCEEDED", "RECOVERY_REQUIRED", "FAILED_TERMINAL", "CANCELLED"]),
  SUCCEEDED: new Set(),
  RETRY_WAIT: new Set(["WAITING_POWER", "WAITING_READY", "DISPATCHING", "FAILED_TERMINAL", "CANCELLED"]),
  FAILED_TERMINAL: new Set(),
  CANCELLED: new Set(),
  RECOVERY_REQUIRED: new Set(["RETRY_WAIT", "QUEUED", "RUNNING", "RESULT_STAGING", "PERSISTING", "FINALIZING", "SUCCEEDED", "FAILED_TERMINAL", "CANCELLED"]),
};

const MONOTONIC_JOB_RANK: Partial<Record<AutodlH3JobState, number>> = {
  ACCEPTED: 0,
  WAITING_POWER: 1,
  WAITING_READY: 2,
  DISPATCHING: 3,
  QUEUED: 4,
  RUNNING: 5,
  RESULT_STAGING: 6,
  PERSISTING: 7,
  FINALIZING: 8,
  SUCCEEDED: 9,
};

function canTransitionJob(current: AutodlH3JobState, next: AutodlH3JobState): boolean {
  return current === next || ALLOWED_JOB_TRANSITIONS[current].has(next);
}

function isStaleBackwardProgress(current: AutodlH3JobState, next: AutodlH3JobState): boolean {
  const currentRank = MONOTONIC_JOB_RANK[current];
  const nextRank = MONOTONIC_JOB_RANK[next];
  return typeof currentRank === "number" && typeof nextRank === "number" && nextRank < currentRank;
}

export function isStableAutodlH3ResultAssetUrl(value: unknown): boolean {
  try {
    const raw = String(value || "");
    if (raw.startsWith("object://")) {
      const prefix = "object://tencent_cos/";
      if (!raw.startsWith(prefix) || raw.length <= prefix.length || /[?#\\\u0000-\u001f]/u.test(raw)) return false;
      let decoded = raw.slice(prefix.length);
      for (let pass = 0; pass < 3; pass += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      if (decoded.split("/").some(segment => segment === "." || segment === "..")) return false;
    }
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol === "object:") {
      return host === "tencent_cos"
        && Boolean(url.pathname && url.pathname !== "/")
        && !url.username
        && !url.password
        && !url.search
        && !url.hash;
    }
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".seetacloud.com")) return false;
    if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(host)) return false;
    for (const key of url.searchParams.keys()) {
      if (/^(?:sig|sign|signature|token|key|auth|authorization|expires|x-cos-security-token|x-cos-signature)$/iu.test(key)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function validatePayloadNode(value: unknown, path: string, depth: number): unknown {
  if (depth > 10) throw new Error("AUTODL_H3_PAYLOAD_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error("AUTODL_H3_PAYLOAD_ARRAY_TOO_LARGE");
    return value.map((item, index) => validatePayloadNode(item, `${path}[${index}]`, depth + 1));
  }
  if (typeof value !== "object") {
    if (typeof value === "undefined") return undefined;
    throw new Error(`AUTODL_H3_PAYLOAD_UNSUPPORTED_AT_${path}`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error("AUTODL_H3_PAYLOAD_CONTAINS_SECRET_FIELD");
    const sanitized = validatePayloadNode(child, `${path}.${key}`, depth + 1);
    if (typeof sanitized !== "undefined") result[key] = sanitized;
  }
  return result;
}

export function sanitizeAutodlH3RequestPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const sanitized = validatePayloadNode(payload, "payload", 0) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("AUTODL_H3_PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function isAutodlH3LifecycleEnabled(): boolean {
  return process.env.AUTODL_H3_LIFECYCLE_ENABLED === "true";
}

export function buildAutodlH3ClientRequestId(input: {
  userId: string;
  idempotencyKey?: string | null;
  publicTaskId?: string | null;
}): string {
  const userId = requireNonEmpty(input.userId, "user_id");
  const source = String(input.idempotencyKey || input.publicTaskId || "").trim();
  if (!CLIENT_REQUEST_ID_PATTERN.test(source)) {
    throw new Error("AUTODL_H3_CLIENT_REQUEST_ID_REQUIRED");
  }
  return `h3cr_${createHash("sha256").update(`${userId}\u0000${source}`).digest("hex").slice(0, 48)}`;
}

export function createAutodlH3PublicTaskId(input: { userId: string; clientRequestId: string }): string {
  const userId = requireNonEmpty(input.userId, "user_id");
  const clientRequestId = requireNonEmpty(input.clientRequestId, "client_request_id");
  return `h3q_${createHash("sha256").update(`${userId}\u0000${clientRequestId}`).digest("hex").slice(0, 40)}`;
}

function assertJobState(value: unknown): AutodlH3JobState {
  if (!AUTODL_H3_JOB_STATES.includes(value as AutodlH3JobState)) {
    throw new Error("AUTODL_H3_INVALID_JOB_STATE");
  }
  return value as AutodlH3JobState;
}

function assertInstanceState(value: unknown): AutodlH3InstanceState {
  if (!AUTODL_H3_INSTANCE_STATES.includes(value as AutodlH3InstanceState)) {
    throw new Error("AUTODL_H3_INVALID_INSTANCE_STATE");
  }
  return value as AutodlH3InstanceState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function mapJobRow(raw: unknown): AutodlH3Job {
  const row = asRecord(raw);
  return {
    id: requireNonEmpty(row.id, "job_id"),
    publicTaskId: requireNonEmpty(row.public_task_id, "public_task_id"),
    clientRequestId: requireNonEmpty(row.client_request_id, "client_request_id"),
    videoTaskInternalId: row.video_task_internal_id ? String(row.video_task_internal_id) : null,
    userId: requireNonEmpty(row.user_id, "user_id"),
    modelId: requireNonEmpty(row.model_id, "model_id"),
    instanceUuid: requireNonEmpty(row.instance_uuid, "instance_uuid"),
    requestPayload: asRecord(row.request_payload),
    state: assertJobState(row.state),
    upstreamTaskId: row.upstream_task_id ? String(row.upstream_task_id) : null,
    contentUrl: row.content_url ? String(row.content_url) : null,
    resultAssetUrl: row.result_asset_url ? String(row.result_asset_url) : null,
    progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
    attemptCount: Math.max(0, Number(row.attempt_count) || 0),
    notBefore: row.not_before ? String(row.not_before) : null,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseToken: Math.max(0, Number(row.lease_token) || 0),
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    errorMessage: row.error_message ? sanitizeDiagnostic(row.error_message) : null,
    createdAt: String(row.created_at || new Date(0).toISOString()),
    updatedAt: String(row.updated_at || row.created_at || new Date(0).toISOString()),
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapInstanceRow(raw: unknown): AutodlH3InstanceLease {
  const row = asRecord(raw);
  return {
    instanceUuid: requireNonEmpty(row.instance_uuid, "instance_uuid"),
    lifecycleState: assertInstanceState(row.lifecycle_state),
    lastActivityAt: row.last_activity_at ? String(row.last_activity_at) : null,
    idleSince: row.idle_since ? String(row.idle_since) : null,
    leaseOwner: requireNonEmpty(row.lease_owner, "lease_owner"),
    leaseToken: Math.max(0, Number(row.lease_token) || 0),
    leaseExpiresAt: requireNonEmpty(row.lease_expires_at, "lease_expires_at"),
    activityEpoch: Math.max(0, Number(row.activity_epoch) || 0),
    shutdownEpoch: row.shutdown_epoch === null || typeof row.shutdown_epoch === "undefined"
      ? null
      : Math.max(0, Number(row.shutdown_epoch) || 0),
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    lastErrorMessage: row.last_error_message ? sanitizeDiagnostic(row.last_error_message) : null,
    stateChangedAt: String(row.state_changed_at || row.updated_at || new Date(0).toISOString()),
    updatedAt: String(row.updated_at || new Date(0).toISOString()),
  };
}

function unwrapRpcJson(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return data.length > 0 ? asRecord(data[0]) : null;
  return data && typeof data === "object" ? asRecord(data) : null;
}

function throwStoreError(operation: string, error: unknown): never {
  const message = sanitizeDiagnostic(asRecord(error).message || error, 240);
  throw new Error(`AUTODL_H3_STORE_${operation.toUpperCase()}_FAILED${message ? `: ${message}` : ""}`);
}

export function createSupabaseAutodlH3LifecycleStore(client = getSupabaseAdminClient()): AutodlH3LifecycleStore {
  return {
    async enqueueJob(input) {
      const { data, error } = await client.rpc("autodl_h3_enqueue_job", {
        p_public_task_id: input.publicTaskId,
        p_client_request_id: input.idempotencyKey,
        p_video_task_internal_id: input.videoTaskInternalId,
        p_user_id: input.userId,
        p_model_id: input.modelId,
        p_instance_uuid: input.instanceUuid,
        p_request_payload: input.requestPayload,
      });
      if (error) throwStoreError("enqueue", error);
      const result = unwrapRpcJson(data);
      if (!result?.job) throwStoreError("enqueue_empty", "missing job");
      return { job: mapJobRow(result.job), created: result.created === true };
    },

    async getJobByPublicTaskId(publicTaskId, userId) {
      let query = client.from("autodl_h3_jobs").select("*").eq("public_task_id", publicTaskId);
      if (userId) query = query.eq("user_id", userId);
      const { data, error } = await query.maybeSingle();
      if (error) throwStoreError("load", error);
      return data ? mapJobRow(data) : null;
    },

    async markJobProgress(input) {
      // Progress is a worker-only mutation. The database validates the active
      // lease and fencing token under row lock; browser pollers cannot write.
      if (input.state === "SUCCEEDED") {
        throw new Error("AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT");
      }
      const { data, error } = await client.rpc("autodl_h3_mark_claimed_job_progress", {
        p_job_id: input.jobId,
        p_public_task_id: input.publicTaskId,
        p_user_id: input.userId,
        p_owner: input.leaseOwner,
        p_lease_token: input.leaseToken,
        p_state: assertJobState(input.state),
        p_upstream_task_id: input.upstreamTaskId ?? null,
        p_content_url: input.contentUrl ?? null,
        p_result_asset_url: input.resultAssetUrl ?? null,
        p_progress: typeof input.progress === "number" ? Math.max(0, Math.min(100, Math.round(input.progress))) : null,
        p_error_code: input.errorCode ? sanitizeDiagnostic(input.errorCode, 80) : null,
        p_error_message: input.errorMessage ? sanitizeDiagnostic(input.errorMessage) : null,
      });
      if (error) throwStoreError("progress", error);
      const result = unwrapRpcJson(data);
      return result ? mapJobRow(result) : null;
    },

    async countBlockingJobs(instanceUuid) {
      const { count, error } = await client
        .from("autodl_h3_jobs")
        .select("id", { count: "exact", head: true })
        .eq("instance_uuid", instanceUuid)
        .not("state", "in", "(SUCCEEDED,FAILED_TERMINAL,CANCELLED)");
      if (error) throwStoreError("count", error);
      return Math.max(0, Number(count) || 0);
    },

    async acquireInstanceLease(instanceUuid, owner, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_acquire_instance_lease", {
        p_instance_uuid: instanceUuid,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("acquire_lease", error);
      const result = unwrapRpcJson(data);
      return result ? mapInstanceRow(result) : null;
    },

    async renewInstanceLease(instanceUuid, owner, leaseToken, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_renew_instance_lease", {
        p_instance_uuid: instanceUuid,
        p_owner: owner,
        p_lease_token: leaseToken,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("renew_lease", error);
      return data === true;
    },

    async renewJobLease(jobId, owner, leaseToken, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_renew_job_lease", {
        p_job_id: jobId,
        p_owner: owner,
        p_lease_token: leaseToken,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("renew_job_lease", error);
      return data === true;
    },

    async updateInstanceState(input) {
      const { data, error } = await client.rpc("autodl_h3_update_instance_state", {
        p_instance_uuid: input.instanceUuid,
        p_owner: input.owner,
        p_lease_token: input.leaseToken,
        p_lifecycle_state: input.lifecycleState,
        p_last_activity_at: input.lastActivityAt,
        p_idle_since: input.idleSince,
        p_last_error_code: input.lastErrorCode,
        p_last_error_message: input.lastErrorMessage ? sanitizeDiagnostic(input.lastErrorMessage) : null,
      });
      if (error) throwStoreError("instance_state", error);
      const result = unwrapRpcJson(data);
      return result ? mapInstanceRow(result) : null;
    },

    async prepareShutdown(input) {
      const { data, error } = await client.rpc("autodl_h3_prepare_shutdown", {
        p_instance_uuid: input.instanceUuid,
        p_owner: input.owner,
        p_lease_token: input.leaseToken,
        p_expected_activity_epoch: input.expectedActivityEpoch,
        p_idle_grace_seconds: Math.max(300, Math.ceil(input.idleGraceSeconds)),
      });
      if (error) throwStoreError("prepare_shutdown", error);
      const result = unwrapRpcJson(data);
      return result ? mapInstanceRow(result) : null;
    },

    async confirmShutdown(input) {
      const { data, error } = await client.rpc("autodl_h3_confirm_shutdown", {
        p_instance_uuid: input.instanceUuid,
        p_owner: input.owner,
        p_lease_token: input.leaseToken,
        p_expected_shutdown_epoch: input.expectedShutdownEpoch,
      });
      if (error) throwStoreError("confirm_shutdown", error);
      const result = unwrapRpcJson(data);
      return result ? mapInstanceRow(result) : null;
    },

    async claimNextJob(instanceUuid, owner, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_claim_job", {
        p_instance_uuid: instanceUuid,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("claim_job", error);
      const result = unwrapRpcJson(data);
      return result ? mapJobRow(result) : null;
    },

    async claimActiveJob(instanceUuid, owner, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_claim_active_job", {
        p_instance_uuid: instanceUuid,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("claim_active_job", error);
      const result = unwrapRpcJson(data);
      return result ? mapJobRow(result) : null;
    },

    async claimUnknownDispatchJob(instanceUuid, owner, leaseSeconds) {
      const { data, error } = await client.rpc("autodl_h3_claim_unknown_dispatch_job", {
        p_instance_uuid: instanceUuid,
        p_owner: owner,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throwStoreError("claim_unknown_dispatch", error);
      const result = unwrapRpcJson(data);
      return result ? mapJobRow(result) : null;
    },

    async transitionClaimedJob(input) {
      const { data: currentData, error: currentError } = await client
        .from("autodl_h3_jobs")
        .select("*")
        .eq("id", input.jobId)
        .eq("lease_owner", input.owner)
        .eq("lease_token", input.leaseToken)
        .maybeSingle();
      if (currentError) throwStoreError("transition_load", currentError);
      if (!currentData) return null;
      const current = mapJobRow(currentData);
      if (!canTransitionJob(current.state, input.state)) {
        if (isStaleBackwardProgress(current.state, input.state)) return current;
        throw new Error(`AUTODL_H3_ILLEGAL_JOB_TRANSITION_${current.state}_TO_${input.state}`);
      }
      if (input.state === "SUCCEEDED" && current.state !== "SUCCEEDED") {
        throw new Error("AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT");
      }
      if (input.state === "SUCCEEDED"
        && !isStableAutodlH3ResultAssetUrl(input.resultAssetUrl ?? current.resultAssetUrl)) {
        throw new Error("AUTODL_H3_SUCCEEDED_REQUIRES_STABLE_RESULT_ASSET");
      }
      const { data, error } = await client.rpc("autodl_h3_transition_claimed_job", {
        p_job_id: input.jobId,
        p_owner: input.owner,
        p_lease_token: input.leaseToken,
        p_state: assertJobState(input.state),
        p_upstream_task_id: input.upstreamTaskId ?? null,
        p_content_url: input.contentUrl ?? null,
        p_result_asset_url: input.resultAssetUrl ?? null,
        p_progress: typeof input.progress === "number" ? Math.max(0, Math.min(100, Math.round(input.progress))) : null,
        p_not_before: input.notBefore ?? null,
        p_error_code: input.errorCode ? sanitizeDiagnostic(input.errorCode, 80) : null,
        p_error_message: input.errorMessage ? sanitizeDiagnostic(input.errorMessage) : null,
      });
      if (error) throwStoreError("transition_job", error);
      const result = unwrapRpcJson(data);
      return result ? mapJobRow(result) : null;
    },
  };
}

export async function enqueueAutodlH3VideoJob(
  input: EnqueueAutodlH3VideoJobInput,
  options: { store?: AutodlH3LifecycleStore } = {},
): Promise<EnqueueAutodlH3VideoJobResult> {
  const userId = requireNonEmpty(input.userId, "user_id");
  const modelId = requireNonEmpty(input.modelId, "model_id");
  const instanceUuid = requireNonEmpty(input.instanceUuid || process.env.AUTODL_H3_INSTANCE_UUID, "instance_uuid");
  const clientRequestId = input.idempotencyKey.startsWith("h3cr_")
    ? requireNonEmpty(input.idempotencyKey, "client_request_id")
    : buildAutodlH3ClientRequestId({ userId, idempotencyKey: input.idempotencyKey });
  const expectedPublicTaskId = createAutodlH3PublicTaskId({ userId, clientRequestId });
  if (input.publicTaskId && input.publicTaskId !== expectedPublicTaskId) {
    throw new Error("AUTODL_H3_PUBLIC_TASK_ID_MISMATCH");
  }
  const requestPayload = sanitizeAutodlH3RequestPayload(input.requestPayload);
  const store = options.store || createSupabaseAutodlH3LifecycleStore();
  const result = await store.enqueueJob({
    userId,
    modelId,
    idempotencyKey: clientRequestId,
    publicTaskId: expectedPublicTaskId,
    videoTaskInternalId: input.videoTaskInternalId || null,
    requestPayload,
    instanceUuid,
  });
  return {
    job: result.job,
    publicTaskId: result.job.publicTaskId,
    state: result.job.state,
    created: result.created,
  };
}

export async function getAutodlH3VideoJobForUser(
  input: { publicTaskId: string; userId: string },
  options: { store?: AutodlH3LifecycleStore } = {},
): Promise<AutodlH3Job | null> {
  const store = options.store || createSupabaseAutodlH3LifecycleStore();
  return store.getJobByPublicTaskId(
    requireNonEmpty(input.publicTaskId, "public_task_id"),
    requireNonEmpty(input.userId, "user_id"),
  );
}

export async function resolveAutodlH3UpstreamId(
  input: { publicTaskId: string; userId: string },
  options: { store?: AutodlH3LifecycleStore } = {},
): Promise<string | null> {
  const job = await getAutodlH3VideoJobForUser(input, options);
  return job?.upstreamTaskId || null;
}

export async function markAutodlH3JobProgress(
  input: AutodlH3JobProgressInput,
  options: { store?: AutodlH3LifecycleStore } = {},
): Promise<AutodlH3Job | null> {
  const store = options.store || createSupabaseAutodlH3LifecycleStore();
  const leaseToken = Number(input.leaseToken);
  if (!Number.isSafeInteger(leaseToken) || leaseToken < 1) {
    throw new Error("AUTODL_H3_INVALID_LEASE_TOKEN");
  }
  return store.markJobProgress({
    ...input,
    jobId: requireNonEmpty(input.jobId, "job_id"),
    publicTaskId: requireNonEmpty(input.publicTaskId, "public_task_id"),
    userId: requireNonEmpty(input.userId, "user_id"),
    leaseOwner: requireNonEmpty(input.leaseOwner, "lease_owner"),
    leaseToken,
    state: assertJobState(input.state),
  });
}

function cloneJob(job: AutodlH3Job): AutodlH3Job {
  return { ...job, requestPayload: JSON.parse(JSON.stringify(job.requestPayload)) as Record<string, unknown> };
}

function cloneLease(lease: AutodlH3InstanceLease): AutodlH3InstanceLease {
  return { ...lease };
}

/**
 * Single-process store for deterministic, zero-network tests. Production uses
 * the Supabase/RPC store because only PostgreSQL can fence multiple processes.
 */
export class InMemoryAutodlH3LifecycleStore implements AutodlH3LifecycleStore {
  private readonly jobs = new Map<string, AutodlH3Job>();
  private readonly publicIndex = new Map<string, string>();
  private readonly requestIndex = new Map<string, string>();
  private readonly instances = new Map<string, AutodlH3InstanceLease>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private iso(): string {
    return this.now().toISOString();
  }

  private ensureInstance(instanceUuid: string): AutodlH3InstanceLease {
    const existing = this.instances.get(instanceUuid);
    if (existing) return existing;
    const created: AutodlH3InstanceLease = {
      instanceUuid,
      lifecycleState: "UNKNOWN",
      lastActivityAt: null,
      idleSince: null,
      leaseOwner: "",
      leaseToken: 0,
      leaseExpiresAt: new Date(0).toISOString(),
      activityEpoch: 0,
      shutdownEpoch: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      stateChangedAt: this.iso(),
      updatedAt: this.iso(),
    };
    this.instances.set(instanceUuid, created);
    return created;
  }

  private bumpActivity(instanceUuid: string): void {
    const instance = this.ensureInstance(instanceUuid);
    instance.activityEpoch += 1;
    instance.lastActivityAt = this.iso();
    instance.idleSince = null;
    if (instance.lifecycleState === "READY" || instance.lifecycleState === "IDLE_GRACE") {
      instance.lifecycleState = "BUSY";
      instance.stateChangedAt = this.iso();
    }
    instance.updatedAt = this.iso();
  }

  async enqueueJob(input: Required<Pick<EnqueueAutodlH3VideoJobInput,
    "userId" | "modelId" | "idempotencyKey" | "publicTaskId" | "requestPayload" | "instanceUuid"
  >> & { videoTaskInternalId: string | null }): Promise<{ job: AutodlH3Job; created: boolean }> {
    const requestKey = `${input.userId}\u0000${input.idempotencyKey}`;
    const existingId = this.requestIndex.get(requestKey);
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (existing.publicTaskId !== input.publicTaskId
        || existing.modelId !== input.modelId
        || existing.instanceUuid !== input.instanceUuid
        || JSON.stringify(existing.requestPayload) !== JSON.stringify(input.requestPayload)) {
        throw new Error("AUTODL_H3_IDEMPOTENCY_CONFLICT");
      }
      return { job: cloneJob(existing), created: false };
    }

    const instance = this.ensureInstance(input.instanceUuid);
    const createdAt = this.iso();
    const job: AutodlH3Job = {
      id: randomUUID(),
      publicTaskId: input.publicTaskId,
      clientRequestId: input.idempotencyKey,
      videoTaskInternalId: input.videoTaskInternalId,
      userId: input.userId,
      modelId: input.modelId,
      instanceUuid: input.instanceUuid,
      requestPayload: JSON.parse(JSON.stringify(input.requestPayload)) as Record<string, unknown>,
      state: ["DRAINING", "STOP_REQUESTED", "STOPPING"].includes(instance.lifecycleState)
        ? "WAITING_POWER"
        : "ACCEPTED",
      upstreamTaskId: null,
      contentUrl: null,
      resultAssetUrl: null,
      progress: 0,
      attemptCount: 0,
      notBefore: null,
      leaseOwner: null,
      leaseToken: 0,
      leaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      completedAt: null,
    };
    this.jobs.set(job.id, job);
    this.publicIndex.set(job.publicTaskId, job.id);
    this.requestIndex.set(requestKey, job.id);
    this.bumpActivity(job.instanceUuid);
    return { job: cloneJob(job), created: true };
  }

  async getJobByPublicTaskId(publicTaskId: string, userId?: string): Promise<AutodlH3Job | null> {
    const id = this.publicIndex.get(publicTaskId);
    const job = id ? this.jobs.get(id) : null;
    if (!job || (userId && job.userId !== userId)) return null;
    return cloneJob(job);
  }

  async markJobProgress(input: AutodlH3JobProgressInput): Promise<AutodlH3Job | null> {
    const job = this.jobs.get(input.jobId);
    if (!job
      || job.publicTaskId !== input.publicTaskId
      || job.userId !== input.userId
      || job.leaseOwner !== input.leaseOwner
      || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt
      || new Date(job.leaseExpiresAt).getTime() <= this.now().getTime()) return null;
    if (TERMINAL_JOB_STATES.has(job.state)) return cloneJob(job);
    if (isStaleBackwardProgress(job.state, input.state)) return cloneJob(job);
    if (!canTransitionJob(job.state, input.state)) {
      throw new Error(`AUTODL_H3_ILLEGAL_JOB_TRANSITION_${job.state}_TO_${input.state}`);
    }
    if (input.state === "SUCCEEDED") throw new Error("AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT");
    job.state = input.state;
    if (typeof input.upstreamTaskId !== "undefined") job.upstreamTaskId = input.upstreamTaskId;
    if (typeof input.contentUrl !== "undefined") job.contentUrl = input.contentUrl;
    if (typeof input.resultAssetUrl !== "undefined") job.resultAssetUrl = input.resultAssetUrl;
    if (typeof input.progress === "number") {
      job.progress = Math.max(job.progress, Math.max(0, Math.min(100, Math.round(input.progress))));
    }
    if (typeof input.errorCode !== "undefined") job.errorCode = input.errorCode ? sanitizeDiagnostic(input.errorCode, 80) : null;
    if (typeof input.errorMessage !== "undefined") job.errorMessage = input.errorMessage ? sanitizeDiagnostic(input.errorMessage) : null;
    job.updatedAt = this.iso();
    if (TERMINAL_JOB_STATES.has(job.state)) job.completedAt = this.iso();
    this.bumpActivity(job.instanceUuid);
    return cloneJob(job);
  }

  async countBlockingJobs(instanceUuid: string): Promise<number> {
    return [...this.jobs.values()].filter(job => job.instanceUuid === instanceUuid && !TERMINAL_JOB_STATES.has(job.state)).length;
  }

  async acquireInstanceLease(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3InstanceLease | null> {
    const instance = this.ensureInstance(instanceUuid);
    const nowMs = this.now().getTime();
    const leaseExpired = new Date(instance.leaseExpiresAt).getTime() <= nowMs;
    if (instance.leaseOwner && instance.leaseOwner !== owner && !leaseExpired) return null;
    if (instance.leaseOwner !== owner || leaseExpired) instance.leaseToken += 1;
    instance.leaseOwner = owner;
    instance.leaseExpiresAt = new Date(nowMs + Math.max(5, Math.min(leaseSeconds, 300)) * 1000).toISOString();
    instance.updatedAt = this.iso();
    return cloneLease(instance);
  }

  async renewInstanceLease(instanceUuid: string, owner: string, leaseToken: number, leaseSeconds: number): Promise<boolean> {
    const instance = this.ensureInstance(instanceUuid);
    if (instance.leaseOwner !== owner
      || instance.leaseToken !== leaseToken
      || new Date(instance.leaseExpiresAt).getTime() <= this.now().getTime()) return false;
    instance.leaseExpiresAt = new Date(this.now().getTime() + Math.max(5, Math.min(leaseSeconds, 300)) * 1000).toISOString();
    instance.updatedAt = this.iso();
    return true;
  }

  async updateInstanceState(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    lifecycleState: AutodlH3InstanceState;
    lastActivityAt: string | null;
    idleSince: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
  }): Promise<AutodlH3InstanceLease | null> {
    const instance = this.ensureInstance(input.instanceUuid);
    if (instance.leaseOwner !== input.owner
      || instance.leaseToken !== input.leaseToken
      || new Date(instance.leaseExpiresAt).getTime() <= this.now().getTime()) return null;
    instance.lastActivityAt = input.lastActivityAt;
    instance.idleSince = input.idleSince;
    instance.lastErrorCode = input.lastErrorCode;
    instance.lastErrorMessage = input.lastErrorMessage ? sanitizeDiagnostic(input.lastErrorMessage) : null;
    if (instance.lifecycleState !== input.lifecycleState) instance.stateChangedAt = this.iso();
    instance.lifecycleState = input.lifecycleState;
    instance.updatedAt = this.iso();
    return cloneLease(instance);
  }

  async renewJobLease(jobId: string, owner: string, leaseToken: number, leaseSeconds: number): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job
      || job.leaseOwner !== owner
      || job.leaseToken !== leaseToken
      || !job.leaseExpiresAt
      || new Date(job.leaseExpiresAt).getTime() <= this.now().getTime()) return false;
    job.leaseExpiresAt = new Date(this.now().getTime() + Math.max(5, Math.min(leaseSeconds, 300)) * 1000).toISOString();
    job.updatedAt = this.iso();
    return true;
  }

  async prepareShutdown(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    expectedActivityEpoch: number;
    idleGraceSeconds: number;
  }): Promise<AutodlH3InstanceLease | null> {
    const instance = this.ensureInstance(input.instanceUuid);
    const idleAgeMs = instance.idleSince ? this.now().getTime() - new Date(instance.idleSince).getTime() : -1;
    if (instance.leaseOwner !== input.owner
      || instance.leaseToken !== input.leaseToken
      || new Date(instance.leaseExpiresAt).getTime() <= this.now().getTime()
      || instance.activityEpoch !== input.expectedActivityEpoch
      || idleAgeMs < Math.max(300, input.idleGraceSeconds) * 1000
      || await this.countBlockingJobs(input.instanceUuid) > 0) return null;
    if (instance.lifecycleState !== "DRAINING") instance.stateChangedAt = this.iso();
    instance.lifecycleState = "DRAINING";
    instance.shutdownEpoch = instance.activityEpoch;
    instance.updatedAt = this.iso();
    return cloneLease(instance);
  }

  async confirmShutdown(input: {
    instanceUuid: string;
    owner: string;
    leaseToken: number;
    expectedShutdownEpoch: number;
  }): Promise<AutodlH3InstanceLease | null> {
    const instance = this.ensureInstance(input.instanceUuid);
    if (instance.leaseOwner !== input.owner
      || instance.leaseToken !== input.leaseToken
      || new Date(instance.leaseExpiresAt).getTime() <= this.now().getTime()
      || instance.lifecycleState !== "DRAINING"
      || instance.shutdownEpoch !== input.expectedShutdownEpoch
      || instance.activityEpoch !== input.expectedShutdownEpoch
      || await this.countBlockingJobs(input.instanceUuid) > 0) return null;
    instance.lifecycleState = "STOP_REQUESTED";
    instance.stateChangedAt = this.iso();
    instance.updatedAt = this.iso();
    return cloneLease(instance);
  }

  private leaseJob(job: AutodlH3Job, owner: string, leaseSeconds: number): AutodlH3Job {
    job.leaseOwner = owner;
    job.leaseToken += 1;
    job.leaseExpiresAt = new Date(this.now().getTime() + Math.max(5, Math.min(leaseSeconds, 300)) * 1000).toISOString();
    job.updatedAt = this.iso();
    return cloneJob(job);
  }

  async claimNextJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null> {
    const nowMs = this.now().getTime();
    const job = [...this.jobs.values()]
      .filter(candidate => candidate.instanceUuid === instanceUuid
        && !candidate.upstreamTaskId
        && ["ACCEPTED", "WAITING_POWER", "WAITING_READY", "RETRY_WAIT"].includes(candidate.state)
        && (!candidate.notBefore || new Date(candidate.notBefore).getTime() <= nowMs)
        && (!candidate.leaseExpiresAt || new Date(candidate.leaseExpiresAt).getTime() <= nowMs))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return null;
    job.state = "DISPATCHING";
    job.attemptCount += 1;
    job.startedAt ||= this.iso();
    job.errorCode = null;
    job.errorMessage = null;
    return this.leaseJob(job, owner, leaseSeconds);
  }

  async claimActiveJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null> {
    const nowMs = this.now().getTime();
    const activeStates: AutodlH3JobState[] = ["QUEUED", "RUNNING", "RESULT_STAGING", "PERSISTING", "FINALIZING", "RECOVERY_REQUIRED"];
    const job = [...this.jobs.values()]
      .filter(candidate => candidate.instanceUuid === instanceUuid
        && Boolean(candidate.upstreamTaskId)
        && activeStates.includes(candidate.state)
        && (!candidate.notBefore || new Date(candidate.notBefore).getTime() <= nowMs)
        && (!candidate.leaseExpiresAt || new Date(candidate.leaseExpiresAt).getTime() <= nowMs))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    return job ? this.leaseJob(job, owner, leaseSeconds) : null;
  }

  async claimUnknownDispatchJob(instanceUuid: string, owner: string, leaseSeconds: number): Promise<AutodlH3Job | null> {
    const nowMs = this.now().getTime();
    const job = [...this.jobs.values()]
      .filter(candidate => candidate.instanceUuid === instanceUuid
        && (candidate.state === "DISPATCHING" || candidate.state === "RECOVERY_REQUIRED")
        && !candidate.upstreamTaskId
        && (!candidate.notBefore || new Date(candidate.notBefore).getTime() <= nowMs)
        && (!candidate.leaseExpiresAt || new Date(candidate.leaseExpiresAt).getTime() <= nowMs))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (!job) return null;
    job.state = "RECOVERY_REQUIRED";
    job.errorCode = "UNKNOWN_DISPATCH_RESULT";
    job.errorMessage = "提交结果未知，正在按稳定请求编号恢复";
    return this.leaseJob(job, owner, leaseSeconds);
  }

  async transitionClaimedJob(input: {
    jobId: string;
    owner: string;
    leaseToken: number;
    state: AutodlH3JobState;
    upstreamTaskId?: string | null;
    contentUrl?: string | null;
    resultAssetUrl?: string | null;
    progress?: number;
    notBefore?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<AutodlH3Job | null> {
    const job = this.jobs.get(input.jobId);
    if (!job
      || job.leaseOwner !== input.owner
      || job.leaseToken !== input.leaseToken
      || !job.leaseExpiresAt
      || new Date(job.leaseExpiresAt).getTime() <= this.now().getTime()) return null;
    if (!canTransitionJob(job.state, input.state)) {
      throw new Error(`AUTODL_H3_ILLEGAL_JOB_TRANSITION_${job.state}_TO_${input.state}`);
    }
    if (input.state === "SUCCEEDED" && job.state !== "SUCCEEDED") {
      throw new Error("AUTODL_H3_SUCCESS_REQUIRES_ATOMIC_SETTLEMENT");
    }
    const stableAsset = input.resultAssetUrl ?? job.resultAssetUrl;
    if (input.state === "SUCCEEDED" && !isStableAutodlH3ResultAssetUrl(stableAsset)) {
      throw new Error("AUTODL_H3_SUCCEEDED_REQUIRES_STABLE_RESULT_ASSET");
    }
    job.state = input.state;
    if (typeof input.upstreamTaskId !== "undefined") job.upstreamTaskId = input.upstreamTaskId;
    if (typeof input.contentUrl !== "undefined") job.contentUrl = input.contentUrl;
    if (typeof input.resultAssetUrl !== "undefined") job.resultAssetUrl = input.resultAssetUrl;
    if (typeof input.progress === "number") {
      job.progress = Math.max(job.progress, Math.max(0, Math.min(100, Math.round(input.progress))));
    }
    job.notBefore = input.notBefore ?? null;
    job.errorCode = input.errorCode ? sanitizeDiagnostic(input.errorCode, 80) : null;
    job.errorMessage = input.errorMessage ? sanitizeDiagnostic(input.errorMessage) : null;
    job.leaseOwner = null;
    job.leaseExpiresAt = null;
    job.updatedAt = this.iso();
    if (TERMINAL_JOB_STATES.has(job.state)) job.completedAt = this.iso();
    this.bumpActivity(job.instanceUuid);
    return cloneJob(job);
  }
}

function activityCount(activity: AutodlH3RuntimeActivity): number {
  return activity.queued
    + activity.running
    + activity.resultStaging
    + activity.persisting
    + activity.finalizing
    + activity.recovery;
}

const POWER_ON_MANUAL_REVIEW_CODES = new Set([
  "POWER_ON_REPLAY_IN_FLIGHT",
  "POWER_ON_UNCONFIRMED",
  "POWER_ON_REPLAY_FAILED",
]);
const POWER_OFF_MANUAL_REVIEW_CODES = new Set([
  "POWER_OFF_REPLAY_IN_FLIGHT",
  "POWER_OFF_UNCONFIRMED",
  "POWER_OFF_REPLAY_FAILED",
]);

export class AutodlH3LifecycleController {
  private ticking = false;

  constructor(private readonly dependencies: {
    store: AutodlH3LifecycleStore;
    instanceClient: AutodlH3InstanceClient;
    tunnel: AutodlH3TunnelSupervisor;
    dispatcher: AutodlH3JobDispatcher;
    config: AutodlH3LifecycleControllerConfig;
    now?: () => Date;
  }) {}

  private now(): Date {
    return this.dependencies.now?.() || new Date();
  }

  private stateAgeMs(lease: AutodlH3InstanceLease): number {
    return Math.max(0, this.now().getTime() - new Date(lease.stateChangedAt).getTime());
  }

  private async setInstanceState(
    lease: AutodlH3InstanceLease,
    lifecycleState: AutodlH3InstanceState,
    options: {
      lastActivityAt?: string | null;
      idleSince?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<AutodlH3InstanceLease> {
    const updated = await this.dependencies.store.updateInstanceState({
      instanceUuid: lease.instanceUuid,
      owner: lease.leaseOwner,
      leaseToken: lease.leaseToken,
      lifecycleState,
      lastActivityAt: typeof options.lastActivityAt === "undefined" ? lease.lastActivityAt : options.lastActivityAt,
      idleSince: typeof options.idleSince === "undefined" ? lease.idleSince : options.idleSince,
      lastErrorCode: typeof options.errorCode === "undefined" ? lease.lastErrorCode : options.errorCode,
      lastErrorMessage: typeof options.errorMessage === "undefined" ? lease.lastErrorMessage : options.errorMessage,
    });
    if (!updated) throw new Error("AUTODL_H3_INSTANCE_LEASE_LOST");
    return updated;
  }

  private async failClosedManualPowerReview(
    lease: AutodlH3InstanceLease,
    code: string,
  ): Promise<AutodlH3LifecycleTickResult> {
    if (lease.lifecycleState !== "FAULTED") {
      await this.setInstanceState(lease, "FAULTED", { idleSince: null });
    }
    return { action: "faulted", code };
  }

  private async withClaimHeartbeat<T>(
    lease: AutodlH3InstanceLease,
    job: AutodlH3Job,
    operation: () => Promise<T>,
  ): Promise<T> {
    const { store, config } = this.dependencies;
    const renew = async () => {
      const [instanceOk, jobOk] = await Promise.all([
        store.renewInstanceLease(config.instanceUuid, config.ownerId, lease.leaseToken, config.leaseSeconds),
        store.renewJobLease(job.id, config.ownerId, job.leaseToken, config.leaseSeconds),
      ]);
      return instanceOk && jobOk;
    };
    if (!await renew()) throw new Error("AUTODL_H3_LEASE_LOST_BEFORE_OPERATION");
    let lost = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renew().then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }).finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(config.leaseSeconds * 1000 / 3)));
    timer.unref?.();
    try {
      const result = await operation();
      if (lost) throw new Error("AUTODL_H3_LEASE_LOST_DURING_OPERATION");
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  private async withInstanceLeaseHeartbeat<T>(
    lease: AutodlH3InstanceLease,
    operation: () => Promise<T>,
  ): Promise<T> {
    const { store, config } = this.dependencies;
    const renew = () => store.renewInstanceLease(
      config.instanceUuid,
      config.ownerId,
      lease.leaseToken,
      config.leaseSeconds,
    );
    if (!await renew()) throw new Error("AUTODL_H3_INSTANCE_LEASE_LOST_BEFORE_POWER_ACTION");
    let lost = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renew().then(ok => { if (!ok) lost = true; }).catch(() => { lost = true; }).finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(config.leaseSeconds * 1000 / 3)));
    timer.unref?.();
    try {
      const result = await operation();
      if (lost) throw new Error("AUTODL_H3_INSTANCE_LEASE_LOST_DURING_POWER_ACTION");
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Persist intent before the external call, then persist the accepted phase.
   * A process that dies in either gap can reconcile official status first and
   * replay only the idempotent state command after the action deadline.
   */
  private async requestPowerOn(
    lease: AutodlH3InstanceLease,
    options: { replay?: boolean } = {},
  ): Promise<AutodlH3LifecycleTickResult> {
    const { instanceClient, config } = this.dependencies;
    const nowIso = this.now().toISOString();
    let requested = lease.lifecycleState === "START_REQUESTED"
      ? lease
      : await this.setInstanceState(lease, "START_REQUESTED", {
        lastActivityAt: nowIso,
        idleSince: null,
        errorCode: null,
        errorMessage: null,
      });
    if (options.replay) {
      // This marker is durable even though START_REQUESTED itself is unchanged.
      // A second crash before STARTING is persisted must not trigger a third call.
      requested = await this.setInstanceState(requested, "START_REQUESTED", {
        errorCode: "POWER_ON_REPLAY_IN_FLIGHT",
        errorMessage: "开机意图已进入唯一一次安全重放，等待官方状态收敛",
        idleSince: null,
      });
    }
    try {
      const accepted = await this.withInstanceLeaseHeartbeat(
        requested,
        () => instanceClient.powerOn(config.instanceUuid),
      );
      if (!accepted.accepted) throw new Error("AUTODL_H3_POWER_ON_NOT_ACCEPTED");
    } catch (error) {
      if (options.replay) {
        await this.setInstanceState(requested, "FAULTED", {
          errorCode: "POWER_ON_REPLAY_FAILED",
          errorMessage: "开机意图安全重放仍未确认，已停止自动动作并等待人工检查",
          idleSince: null,
        }).catch(() => null);
        throw new Error("POWER_ON_REPLAY_FAILED");
      }
      throw error;
    }
    await this.setInstanceState(requested, "STARTING", {
      lastActivityAt: nowIso,
      idleSince: null,
      errorCode: null,
      errorMessage: null,
    });
    return { action: "power_on_requested" };
  }

  private async requestPowerOff(
    lease: AutodlH3InstanceLease,
    options: { errorCode?: string | null; errorMessage?: string | null; replay?: boolean } = {},
  ): Promise<AutodlH3LifecycleTickResult> {
    const { instanceClient, config } = this.dependencies;
    let requested = lease.lifecycleState === "STOP_REQUESTED"
      ? lease
      : await this.setInstanceState(lease, "STOP_REQUESTED", {
        errorCode: typeof options.errorCode === "undefined" ? lease.lastErrorCode : options.errorCode,
        errorMessage: typeof options.errorMessage === "undefined" ? lease.lastErrorMessage : options.errorMessage,
      });
    if (options.replay) {
      // See requestPowerOn: persist the single replay before the external side
      // effect so a second crash cannot create an unbounded power-off loop.
      requested = await this.setInstanceState(requested, "STOP_REQUESTED", {
        errorCode: "POWER_OFF_REPLAY_IN_FLIGHT",
        errorMessage: "关机意图已进入唯一一次安全重放，等待官方状态收敛",
        idleSince: null,
      });
    }
    try {
      const accepted = await this.withInstanceLeaseHeartbeat(
        requested,
        () => instanceClient.powerOff(config.instanceUuid),
      );
      if (!accepted.accepted) throw new Error("AUTODL_H3_POWER_OFF_NOT_ACCEPTED");
    } catch (error) {
      if (options.replay) {
        await this.setInstanceState(requested, "FAULTED", {
          errorCode: "POWER_OFF_REPLAY_FAILED",
          errorMessage: "关机意图安全重放仍未确认，已停止自动动作并等待人工检查",
          idleSince: null,
        }).catch(() => null);
        throw new Error("POWER_OFF_REPLAY_FAILED");
      }
      throw error;
    }
    await this.setInstanceState(requested, "STOPPING", {
      errorCode: options.replay
        ? null
        : (typeof options.errorCode === "undefined" ? requested.lastErrorCode : options.errorCode),
      errorMessage: options.replay
        ? null
        : (typeof options.errorMessage === "undefined" ? requested.lastErrorMessage : options.errorMessage),
    });
    return { action: "power_off_requested" };
  }

  private async reconcilePendingPowerOff(
    lease: AutodlH3InstanceLease,
  ): Promise<AutodlH3LifecycleTickResult | null> {
    const { config } = this.dependencies;
    if (lease.lifecycleState === "STOP_REQUESTED") {
      if (this.stateAgeMs(lease) < config.powerActionDeadlineMs) return { action: "stopping" };
      if (config.dryRun || !config.allowPowerActions) {
        await this.setInstanceState(lease, "FAULTED", {
          errorCode: "POWER_OFF_UNCONFIRMED",
          errorMessage: "关机意图未执行，且当前运行模式禁止安全重放",
          idleSince: null,
        });
        return { action: "faulted", code: "POWER_OFF_UNCONFIRMED" };
      }
      return this.requestPowerOff(lease, { replay: true });
    }
    if (lease.lifecycleState === "STOPPING") {
      if (this.stateAgeMs(lease) < config.powerActionDeadlineMs) return { action: "stopping" };
      await this.setInstanceState(lease, "FAULTED", {
        errorCode: "POWER_OFF_UNCONFIRMED",
        errorMessage: "关机请求未在安全时限内生效，已停止自动重放并等待人工检查",
        idleSince: null,
      });
      return { action: "faulted", code: "POWER_OFF_UNCONFIRMED" };
    }
    return null;
  }

  private async recoverUnknownDispatch(lease: AutodlH3InstanceLease): Promise<AutodlH3LifecycleTickResult | null> {
    const { store, dispatcher, config } = this.dependencies;
    const job = await store.claimUnknownDispatchJob(config.instanceUuid, config.ownerId, config.leaseSeconds);
    if (!job) return null;
    try {
      const recovery = await this.withClaimHeartbeat(lease, job, () => dispatcher.recoverUnknownDispatch(job));
      if (recovery.outcome === "found") {
        const updated = await store.transitionClaimedJob({
          jobId: job.id,
          owner: config.ownerId,
          leaseToken: job.leaseToken,
          state: "QUEUED",
          upstreamTaskId: requireNonEmpty(recovery.upstreamTaskId, "upstream_task_id"),
          contentUrl: recovery.contentUrl ?? null,
          progress: job.progress,
        });
        if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST");
        return { action: "recovered", publicTaskId: job.publicTaskId, upstreamTaskId: updated.upstreamTaskId || undefined };
      }
      if (recovery.outcome === "not_found") {
        const updated = await store.transitionClaimedJob({
          jobId: job.id,
          owner: config.ownerId,
          leaseToken: job.leaseToken,
          state: "RETRY_WAIT",
          notBefore: new Date(this.now().getTime() + config.retryDelayMs).toISOString(),
          errorCode: "DISPATCH_NOT_FOUND_SAFE_TO_RETRY",
          errorMessage: "未发现上游任务，等待使用原请求编号重试",
        });
        if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST");
        return { action: "recovery_wait", publicTaskId: job.publicTaskId };
      }
      const updated = await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: "RECOVERY_REQUIRED",
        notBefore: new Date(this.now().getTime() + config.retryDelayMs).toISOString(),
        errorCode: recovery.errorCode || "DISPATCH_RECOVERY_UNCERTAIN",
        errorMessage: recovery.errorMessage || "提交结果仍不确定，禁止盲目重发",
      });
      if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST");
      return { action: "recovery_wait", publicTaskId: job.publicTaskId };
    } catch (error) {
      await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: "RECOVERY_REQUIRED",
        notBefore: new Date(this.now().getTime() + config.retryDelayMs).toISOString(),
        errorCode: "DISPATCH_RECOVERY_FAILED",
        errorMessage: sanitizeDiagnostic(error),
      }).catch(() => null);
      return { action: "recovery_wait", publicTaskId: job.publicTaskId };
    }
  }

  private async reconcileActiveJob(lease: AutodlH3InstanceLease): Promise<AutodlH3LifecycleTickResult | null> {
    const { store, dispatcher, config } = this.dependencies;
    const job = await store.claimActiveJob(config.instanceUuid, config.ownerId, config.leaseSeconds);
    if (!job) return null;
    try {
      const result = await this.withClaimHeartbeat(lease, job, () => dispatcher.reconcile(job));
      if (!canTransitionJob(job.state, result.state) && !isStaleBackwardProgress(job.state, result.state)) {
        throw new Error(`AUTODL_H3_ILLEGAL_RECONCILE_${job.state}_TO_${result.state}`);
      }
      const targetState = isStaleBackwardProgress(job.state, result.state) ? job.state : result.state;
      const updated = await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: targetState,
        upstreamTaskId: job.upstreamTaskId,
        contentUrl: result.contentUrl ?? job.contentUrl,
        resultAssetUrl: result.resultAssetUrl ?? job.resultAssetUrl,
        progress: result.progress ?? job.progress,
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
      });
      if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST");
      return { action: "reconciled", publicTaskId: job.publicTaskId, upstreamTaskId: job.upstreamTaskId || undefined };
    } catch (error) {
      await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: "RECOVERY_REQUIRED",
        upstreamTaskId: job.upstreamTaskId,
        notBefore: new Date(this.now().getTime() + config.retryDelayMs).toISOString(),
        errorCode: "ACTIVE_RECONCILE_FAILED",
        errorMessage: sanitizeDiagnostic(error),
      }).catch(() => null);
      return { action: "recovery_wait", publicTaskId: job.publicTaskId };
    }
  }

  private async dispatchNextJob(lease: AutodlH3InstanceLease): Promise<AutodlH3LifecycleTickResult> {
    const { store, dispatcher, config } = this.dependencies;
    const job = await store.claimNextJob(config.instanceUuid, config.ownerId, config.leaseSeconds);
    if (!job) return { action: "no_job" };
    if (job.attemptCount > config.maxDispatchAttempts) {
      await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: "FAILED_TERMINAL",
        errorCode: "MAX_DISPATCH_ATTEMPTS_EXCEEDED",
        errorMessage: "已达到安全重试上限，请人工检查后重新提交",
      });
      return { action: "recovery_wait", publicTaskId: job.publicTaskId };
    }
    try {
      const result = await this.withClaimHeartbeat(lease, job, () => dispatcher.dispatch(job));
      const upstreamTaskId = requireNonEmpty(result.upstreamTaskId, "upstream_task_id");
      const updated = await store.transitionClaimedJob({
        jobId: job.id,
        owner: config.ownerId,
        leaseToken: job.leaseToken,
        state: "QUEUED",
        upstreamTaskId,
        contentUrl: result.contentUrl ?? null,
        progress: 0,
      });
      if (!updated) throw new Error("AUTODL_H3_JOB_LEASE_LOST_AFTER_DISPATCH");
      return { action: "dispatched", publicTaskId: job.publicTaskId, upstreamTaskId };
    } catch {
      // A thrown dispatch may have happened after H3 accepted the request.
      // Preserve DISPATCHING until its lease expires; recovery must query by
      // clientRequestId before a stable-id retry is permitted.
      return { action: "recovery_wait", publicTaskId: job.publicTaskId };
    }
  }

  private async handleBlockingJobs(lease: AutodlH3InstanceLease): Promise<AutodlH3LifecycleTickResult> {
    const { instanceClient, tunnel, config } = this.dependencies;
    const nowIso = this.now().toISOString();
    const status = await instanceClient.getStatus(config.instanceUuid);

    if (status.powerState === "stopping") {
      if (POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
        return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
      }
      if (lease.lifecycleState === "STOPPING"
        && this.stateAgeMs(lease) >= config.powerActionDeadlineMs) {
        await this.setInstanceState(lease, "FAULTED", {
          errorCode: "POWER_OFF_UNCONFIRMED",
          errorMessage: "实例长时间停留在关机中，已停止自动动作并等待人工检查",
          idleSince: null,
        });
        return { action: "faulted", code: "POWER_OFF_UNCONFIRMED" };
      }
      await this.setInstanceState(lease, "STOPPING", {
        lastActivityAt: nowIso,
        idleSince: null,
        errorCode: POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorCode,
        errorMessage: POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorMessage,
      });
      return { action: "stopping" };
    }
    if (status.powerState === "starting") {
      if (POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
        return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
      }
      if (lease.lifecycleState === "STARTING"
        && this.stateAgeMs(lease) >= config.startupDeadlineMs) {
        if (!config.dryRun && config.allowPowerActions) {
          return this.requestPowerOff(lease, {
            errorCode: "STARTUP_DEADLINE_EXCEEDED",
            errorMessage: "实例启动超过安全时限，已请求关机并等待人工检查",
          });
        }
        await this.setInstanceState(lease, "FAULTED", { errorCode: "STARTUP_DEADLINE_EXCEEDED", errorMessage: "实例启动超过安全时限" });
        return { action: "faulted", code: "STARTUP_DEADLINE_EXCEEDED" };
      }
      await this.setInstanceState(lease, "STARTING", {
        lastActivityAt: nowIso,
        idleSince: null,
        errorCode: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorCode,
        errorMessage: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorMessage,
      });
      return { action: "starting" };
    }
    if (status.powerState === "unknown") {
      const manualCode = String(lease.lastErrorCode || "");
      if (POWER_ON_MANUAL_REVIEW_CODES.has(manualCode) || POWER_OFF_MANUAL_REVIEW_CODES.has(manualCode)) {
        return this.failClosedManualPowerReview(lease, manualCode);
      }
      await this.setInstanceState(lease, "UNKNOWN", { errorCode: "INSTANCE_STATUS_UNKNOWN", errorMessage: "实例状态未知，禁止执行电源动作" });
      return { action: "faulted", code: "INSTANCE_STATUS_UNKNOWN" };
    }
    if (status.powerState === "stopped") {
      if (lease.lastErrorCode === "STARTUP_DEADLINE_EXCEEDED") {
        await this.setInstanceState(lease, "FAULTED");
        return { action: "faulted", code: "STARTUP_DEADLINE_EXCEEDED" };
      }
      if (lease.lifecycleState === "START_REQUESTED") {
        if (POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
          return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
        }
        if (this.stateAgeMs(lease) < config.powerActionDeadlineMs) return { action: "starting" };
        if (config.dryRun || !config.allowPowerActions) {
          await this.setInstanceState(lease, "FAULTED", { errorCode: "POWER_ON_UNCONFIRMED", errorMessage: "开机意图未执行，且当前运行模式禁止安全重放" });
          return { action: "faulted", code: "POWER_ON_UNCONFIRMED" };
        }
        return this.requestPowerOn(lease, { replay: true });
      }
      if (POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
        return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
      }
      if (lease.lifecycleState === "STARTING") {
        if (this.stateAgeMs(lease) < config.powerActionDeadlineMs) return { action: "starting" };
        await this.setInstanceState(lease, "FAULTED", { errorCode: "POWER_ON_UNCONFIRMED", errorMessage: "开机请求未在安全时限内生效，已停止自动重放并等待人工检查" });
        return { action: "faulted", code: "POWER_ON_UNCONFIRMED" };
      }
      if (config.dryRun || !config.allowPowerActions) {
        await this.setInstanceState(lease, "OFF", { lastActivityAt: nowIso, idleSince: null });
        return { action: "power_on_blocked" };
      }
      return this.requestPowerOn(lease);
    }

    if (POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
      return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
    }

    const pendingPowerOff = await this.reconcilePendingPowerOff(lease);
    if (pendingPowerOff) return pendingPowerOff;
    // DRAINING means the power-off request has not passed the final atomic
    // gate; a new job cancels that drain and may use the still-running host.
    lease = await this.setInstanceState(lease, "BOOTSTRAPPING", {
      lastActivityAt: nowIso,
      idleSince: null,
      errorCode: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorCode,
      errorMessage: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorMessage,
    });
    const snapshot = await instanceClient.getSnapshot(config.instanceUuid);
    if (snapshot.instanceUuid !== config.instanceUuid) throw new Error("AUTODL_H3_SNAPSHOT_INSTANCE_MISMATCH");
    const tunnelState = await tunnel.ensureReady({ instanceUuid: config.instanceUuid, snapshot });
    if (!tunnelState.ready || !await tunnel.isReady({ instanceUuid: config.instanceUuid })) {
      if (this.stateAgeMs(lease) >= config.startupDeadlineMs) {
        if (!config.dryRun && config.allowPowerActions) {
          return this.requestPowerOff(lease, {
            errorCode: "STARTUP_DEADLINE_EXCEEDED",
            errorMessage: "隧道就绪超过安全时限，已请求关机并等待人工检查",
          });
        }
        await this.setInstanceState(lease, "FAULTED", { errorCode: "STARTUP_DEADLINE_EXCEEDED", errorMessage: "隧道就绪超过安全时限" });
        return { action: "faulted", code: "STARTUP_DEADLINE_EXCEEDED" };
      }
      await this.setInstanceState(lease, "BOOTSTRAPPING", {
        lastActivityAt: nowIso,
        idleSince: null,
        errorCode: "TUNNEL_NOT_READY",
        errorMessage: tunnelState.reason || "安全隧道尚未就绪",
      });
      return { action: "not_ready" };
    }
    lease = await this.setInstanceState(lease, "BUSY", { lastActivityAt: nowIso, idleSince: null });

    const recovered = await this.recoverUnknownDispatch(lease);
    if (recovered) return recovered;
    const reconciled = await this.reconcileActiveJob(lease);
    if (reconciled) return reconciled;
    return this.dispatchNextJob(lease);
  }

  private async handleNoBlockingJobs(lease: AutodlH3InstanceLease): Promise<AutodlH3LifecycleTickResult> {
    const { store, instanceClient, dispatcher, config } = this.dependencies;
    const status = await instanceClient.getStatus(config.instanceUuid);
    if (status.powerState === "stopped") {
      await this.setInstanceState(lease, "OFF", { idleSince: null, errorCode: null, errorMessage: null });
      return { action: "no_job" };
    }
    if (status.powerState === "stopping") {
      if (POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
        return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
      }
      if (lease.lifecycleState === "STOPPING"
        && this.stateAgeMs(lease) >= config.powerActionDeadlineMs) {
        await this.setInstanceState(lease, "FAULTED", {
          errorCode: "POWER_OFF_UNCONFIRMED",
          errorMessage: "实例长时间停留在关机中，已停止自动动作并等待人工检查",
          idleSince: null,
        });
        return { action: "faulted", code: "POWER_OFF_UNCONFIRMED" };
      }
      await this.setInstanceState(lease, "STOPPING", {
        errorCode: POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorCode,
        errorMessage: POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorMessage,
      });
      return { action: "stopping" };
    }
    if (status.powerState === "starting") {
      if (POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
        return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
      }
      await this.setInstanceState(lease, "STARTING", {
        errorCode: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorCode,
        errorMessage: POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || "")) ? null : lease.lastErrorMessage,
      });
      return { action: "starting" };
    }
    if (status.powerState !== "running") {
      const manualCode = String(lease.lastErrorCode || "");
      if (POWER_ON_MANUAL_REVIEW_CODES.has(manualCode) || POWER_OFF_MANUAL_REVIEW_CODES.has(manualCode)) {
        return this.failClosedManualPowerReview(lease, manualCode);
      }
      await this.setInstanceState(lease, "UNKNOWN", { errorCode: "INSTANCE_STATUS_UNKNOWN", errorMessage: "实例状态未知，禁止关机" });
      return { action: "faulted", code: "INSTANCE_STATUS_UNKNOWN" };
    }
    if (POWER_OFF_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
      return this.failClosedManualPowerReview(lease, String(lease.lastErrorCode));
    }
    if (POWER_ON_MANUAL_REVIEW_CODES.has(String(lease.lastErrorCode || ""))) {
      lease = await this.setInstanceState(lease, "READY", { errorCode: null, errorMessage: null });
    }
    const pendingPowerOff = await this.reconcilePendingPowerOff(lease);
    if (pendingPowerOff) return pendingPowerOff;

    const firstActivity = await dispatcher.getActivity(config.instanceUuid);
    if (activityCount(firstActivity) > 0) {
      await this.setInstanceState(lease, "BUSY", { lastActivityAt: this.now().toISOString(), idleSince: null });
      return { action: "idle_wait" };
    }

    const now = this.now();
    if (!lease.idleSince) {
      await this.setInstanceState(lease, "IDLE_GRACE", { idleSince: now.toISOString() });
      return { action: "idle_wait" };
    }
    if (now.getTime() - new Date(lease.idleSince).getTime() < Math.max(MIN_IDLE_GRACE_MS, config.idleGraceMs)) {
      return { action: "idle_wait" };
    }
    if (config.dryRun || !config.allowPowerActions) return { action: "power_off_blocked" };

    const prepared = await store.prepareShutdown({
      instanceUuid: config.instanceUuid,
      owner: config.ownerId,
      leaseToken: lease.leaseToken,
      expectedActivityEpoch: lease.activityEpoch,
      idleGraceSeconds: Math.ceil(Math.max(MIN_IDLE_GRACE_MS, config.idleGraceMs) / 1000),
    });
    if (!prepared) return { action: "idle_wait" };

    // External H3 queue/finalizer and durable DB blockers are both read again
    // after DRAINING. Any read error escapes and therefore fails closed.
    const secondActivity = await dispatcher.getActivity(config.instanceUuid);
    const secondBlockingCount = await store.countBlockingJobs(config.instanceUuid);
    if (activityCount(secondActivity) > 0 || secondBlockingCount > 0) {
      await this.setInstanceState(prepared, "BUSY", { lastActivityAt: this.now().toISOString(), idleSince: null });
      return { action: "idle_wait" };
    }
    const renewed = await store.renewInstanceLease(
      config.instanceUuid,
      config.ownerId,
      prepared.leaseToken,
      config.leaseSeconds,
    );
    if (!renewed) return { action: "lease_busy" };
    const confirmed = await store.confirmShutdown({
      instanceUuid: config.instanceUuid,
      owner: config.ownerId,
      leaseToken: prepared.leaseToken,
      expectedShutdownEpoch: prepared.shutdownEpoch ?? -1,
    });
    if (!confirmed) {
      // A new enqueue advanced activity_epoch. DRAINING is pre-request and can
      // safely be cancelled; WAITING_POWER jobs become eligible next tick.
      const freshLease = await store.acquireInstanceLease(config.instanceUuid, config.ownerId, config.leaseSeconds);
      if (freshLease && freshLease.lifecycleState === "DRAINING") {
        await this.setInstanceState(freshLease, "BUSY", { lastActivityAt: this.now().toISOString(), idleSince: null });
      }
      return { action: "idle_wait" };
    }
    return this.requestPowerOff(confirmed);
  }

  async tick(): Promise<AutodlH3LifecycleTickResult> {
    if (this.ticking) return { action: "local_tick_busy" };
    this.ticking = true;
    const { store, config } = this.dependencies;
    try {
      if (!config.enabled) return { action: "disabled" };
      const lease = await store.acquireInstanceLease(config.instanceUuid, config.ownerId, config.leaseSeconds);
      if (!lease) return { action: "lease_busy" };
      const blockingCount = await store.countBlockingJobs(config.instanceUuid);
      return blockingCount > 0
        ? await this.handleBlockingJobs(lease)
        : await this.handleNoBlockingJobs(lease);
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : error;
      return { action: "faulted", code: sanitizeDiagnostic(diagnostic, 80) || "AUTODL_H3_LIFECYCLE_FAULT" };
    } finally {
      this.ticking = false;
    }
  }
}

export interface AutodlH3LifecycleRuntimeDependencies {
  store: AutodlH3LifecycleStore;
  instanceClient: AutodlH3InstanceClient;
  tunnel: AutodlH3TunnelSupervisor;
  dispatcher: AutodlH3JobDispatcher;
  now?: () => Date;
}

export interface AutodlH3LifecycleWorkerHandle {
  started: boolean;
  mode: "disabled" | "dry-run" | "active";
  tick(): Promise<AutodlH3LifecycleTickResult>;
  stop(): void;
}

type AutodlH3WorkerGlobalState = {
  dependencies?: AutodlH3LifecycleRuntimeDependencies;
  handle?: AutodlH3LifecycleWorkerHandle;
};

const WORKER_GLOBAL_KEY = Symbol.for("agent-hub.autodl-h3-lifecycle-worker.v1");

function workerGlobalState(): AutodlH3WorkerGlobalState {
  const target = globalThis as typeof globalThis & { [WORKER_GLOBAL_KEY]?: AutodlH3WorkerGlobalState };
  target[WORKER_GLOBAL_KEY] ||= {};
  return target[WORKER_GLOBAL_KEY]!;
}

/** Install real adapters before starting the worker. No adapter is inferred. */
export function installAutodlH3LifecycleRuntimeDependencies(
  dependencies: AutodlH3LifecycleRuntimeDependencies,
): void {
  const state = workerGlobalState();
  if (state.handle?.started) throw new Error("AUTODL_H3_WORKER_ALREADY_STARTED");
  state.dependencies = dependencies;
}

function failClosedRuntimeDependencies(): AutodlH3LifecycleRuntimeDependencies {
  const unavailable = async (): Promise<never> => {
    throw new Error("AUTODL_H3_RUNTIME_ADAPTERS_NOT_INSTALLED");
  };
  return {
    store: createSupabaseAutodlH3LifecycleStore(),
    instanceClient: {
      async getStatus() { return { powerState: "unknown" }; },
      getSnapshot: unavailable,
      async powerOn() { return { accepted: false }; },
      async powerOff() { return { accepted: false }; },
    },
    tunnel: {
      async ensureReady() { return { ready: false, reason: "运行时隧道适配器未安装" }; },
      async isReady() { return false; },
    },
    dispatcher: {
      dispatch: unavailable,
      recoverUnknownDispatch: unavailable,
      reconcile: unavailable,
      async getActivity() {
        // Unknown activity must block shutdown.
        return { queued: 0, running: 0, resultStaging: 0, persisting: 0, finalizing: 0, recovery: 1 };
      },
    },
  };
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function startAutodlH3LifecycleWorkerFromEnvironment(): AutodlH3LifecycleWorkerHandle {
  const globalState = workerGlobalState();
  if (globalState.handle) return globalState.handle;

  if (!isAutodlH3LifecycleEnabled()) {
    const disabled: AutodlH3LifecycleWorkerHandle = {
      started: false,
      mode: "disabled",
      async tick() { return { action: "disabled" }; },
      stop() {},
    };
    globalState.handle = disabled;
    return disabled;
  }

  const instanceUuid = String(process.env.AUTODL_H3_INSTANCE_UUID || "").trim();
  if (!instanceUuid) {
    const missingInstance: AutodlH3LifecycleWorkerHandle = {
      started: false,
      mode: "disabled",
      async tick() { return { action: "faulted", code: "AUTODL_H3_INSTANCE_UUID_MISSING" }; },
      stop() {},
    };
    globalState.handle = missingInstance;
    return missingInstance;
  }

  const hasInjectedDependencies = Boolean(globalState.dependencies);
  const dependencies = globalState.dependencies || failClosedRuntimeDependencies();
  const dryRun = process.env.AUTODL_H3_LIFECYCLE_DRY_RUN !== "false" || !hasInjectedDependencies;
  const allowPowerActions = hasInjectedDependencies
    && !dryRun
    && process.env.AUTODL_H3_LIFECYCLE_ALLOW_POWER_ACTIONS === "true";
  // Always random per process. A configured/shared owner id would defeat
  // fencing when two PM2/Next processes overlap during restart.
  const ownerId = `h3-worker-${process.pid}-${randomUUID()}`;
  const controller = new AutodlH3LifecycleController({
    ...dependencies,
    config: {
      enabled: true,
      dryRun,
      allowPowerActions,
      instanceUuid,
      ownerId,
      leaseSeconds: integerEnv("AUTODL_H3_LIFECYCLE_LEASE_SECONDS", 30, 15, 300),
      idleGraceMs: integerEnv("AUTODL_H3_IDLE_SECONDS", 300, 300, 86_400) * 1000,
      retryDelayMs: integerEnv("AUTODL_H3_RETRY_SECONDS", 30, 5, 3600) * 1000,
      maxDispatchAttempts: integerEnv("AUTODL_H3_MAX_DISPATCH_ATTEMPTS", 3, 1, 10),
      startupDeadlineMs: integerEnv("AUTODL_H3_STARTUP_DEADLINE_SECONDS", 720, 60, 3600) * 1000,
      powerActionDeadlineMs: integerEnv("AUTODL_H3_POWER_ACTION_DEADLINE_SECONDS", 180, 30, 900) * 1000,
    },
  });

  let stopped = false;
  const intervalMs = integerEnv("AUTODL_H3_WORKER_INTERVAL_MS", 5000, 1000, 60_000);
  const runTick = async () => {
    if (stopped) return { action: "disabled" } as AutodlH3LifecycleTickResult;
    const result = await controller.tick();
    // Log only fixed internal state/code; never log provider responses, URLs,
    // snapshots, request payloads or credentials.
    if (result.action === "faulted") {
      console.warn("[AutoDL H3 Lifecycle] fail-closed", result.code);
    }
    return result;
  };
  const timer = setInterval(() => { void runTick(); }, intervalMs);
  timer.unref?.();

  const handle: AutodlH3LifecycleWorkerHandle = {
    started: true,
    mode: allowPowerActions ? "active" : "dry-run",
    tick: runTick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      const state = workerGlobalState();
      if (state.handle === handle) state.handle = undefined;
    },
  };
  globalState.handle = handle;
  void runTick();
  return handle;
}
