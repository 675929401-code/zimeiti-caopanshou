import "server-only";

import crypto from "node:crypto";
import type { ParsedReliableSecurityEvent } from "@/lib/security-event-reliability-contracts";
import { getSecurityEventProducerConfigurationStatus } from "@/lib/server/security-event-producer";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseError = { code?: string; message?: string; details?: string };
type RpcResponse = { data: unknown; error: DatabaseError | null };

export class SecurityEventReliabilityError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message);
    this.name = "SecurityEventReliabilityError";
  }
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function keyedHash(secret: string, value: string, length = 32): string {
  return crypto.createHmac("sha256", secret).update(value).digest("hex").slice(0, length);
}

function backendCode(error: DatabaseError | null): string {
  const message = `${error?.code || ""}:${error?.message || ""}:${error?.details || ""}`;
  return message.match(/SECURITY_[A-Z0-9_]+/u)?.[0]
    || (/PGRST202|schema cache|does not exist/iu.test(message) ? "SECURITY_EVENT_RELIABILITY_MIGRATION_REQUIRED" : "SECURITY_EVENT_RELIABILITY_BACKEND_FAILURE");
}

function resultRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityEventReliabilityError("安全事件可靠链返回无效", "SECURITY_EVENT_RELIABILITY_RESULT_INVALID");
  }
  return value as Record<string, unknown>;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = getSupabaseAdminClient() as unknown as {
    rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<RpcResponse>;
  };
  const { data, error } = await client.rpc(name, args);
  if (error) throw new SecurityEventReliabilityError("安全事件可靠链暂不可用", backendCode(error), error);
  const result = resultRecord(data);
  if (result.success !== true) {
    throw new SecurityEventReliabilityError("安全事件未被可靠接收", String(result.code || "SECURITY_EVENT_RELIABILITY_REJECTED"), result);
  }
  return result;
}

function minuteBucket(at: Date): Date {
  const bucket = new Date(at);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

function safeFingerprint(event: ParsedReliableSecurityEvent, ipHash: string | null, actorRefHash: string | null, userAgentHash: string | null): string {
  const parts: Record<string, string | boolean | null> = {
    eventType: event.eventType,
    riskLevel: event.riskLevel,
    ipHash,
    actorRefHash,
    userAgentHash,
    path: event.path || null,
    method: event.method || null,
    details: event.details || null,
    blocked: event.blocked,
    source: event.source,
  };
  return hash(Object.keys(parts).sort().map((key) => `${key}=${String(parts[key] ?? "")}`).join("\n"));
}

export async function enqueueReliableSecurityEvent(params: {
  event: ParsedReliableSecurityEvent;
  secret: string;
  idempotencyKey: string | null;
  observedAt?: Date;
}) {
  const observedAt = params.observedAt || new Date();
  const ipHash = params.event.ip ? keyedHash(params.secret, `ip:${params.event.ip}`) : null;
  const actorRefHash = params.event.actorReference ? keyedHash(params.secret, `actor:${params.event.actorReference}`) : null;
  const userAgentHash = params.event.userAgent ? keyedHash(params.secret, `ua:${params.event.userAgent}`) : null;
  const eventFingerprint = safeFingerprint(params.event, ipHash, actorRefHash, userAgentHash);
  const bucket = minuteBucket(observedAt);
  const eventKey = params.idempotencyKey
    ? keyedHash(params.secret, `idempotency:${params.idempotencyKey}`, 64)
    : hash(`semantic:${eventFingerprint}:${bucket.toISOString()}`);
  return rpc("enqueue_security_event_atomic", {
    p_event_key: eventKey,
    p_event_fingerprint: eventFingerprint,
    p_dedupe_bucket_start: bucket.toISOString(),
    p_event_type: params.event.eventType,
    p_risk_level: params.event.riskLevel,
    p_ip_hash: ipHash,
    p_actor_ref_hash: actorRefHash,
    p_user_agent_hash: userAgentHash,
    p_path: params.event.path || null,
    p_method: params.event.method || null,
    p_details: params.event.details || null,
    p_blocked: params.event.blocked,
    p_source: params.event.source,
    p_occurred_at: observedAt.toISOString(),
  });
}

interface ClaimedEvent {
  id: string;
  lease_token: string;
}

export async function drainReliableSecurityEventOutbox(limit = 10): Promise<{
  claimed: number;
  materialized: number;
  deferred: number;
}> {
  const client = getSupabaseAdminClient() as unknown as {
    rpc: (rpcName: string, rpcArgs: Record<string, unknown>) => Promise<RpcResponse>;
  };
  const workerId = `receiver-${crypto.randomUUID()}`;
  const claim = await client.rpc("claim_security_event_outbox_batch", {
    p_worker_id: workerId,
    p_limit: Math.max(1, Math.min(50, Math.floor(limit))),
    p_lease_seconds: 30,
  });
  if (claim.error) {
    throw new SecurityEventReliabilityError("安全事件出队失败", backendCode(claim.error), claim.error);
  }
  const rows = Array.isArray(claim.data) ? claim.data as ClaimedEvent[] : [];
  let materialized = 0;
  let deferred = 0;
  for (const row of rows) {
    const settlement = await client.rpc("settle_security_event_outbox_attempt", {
      p_outbox_id: row.id,
      p_lease_token: row.lease_token,
      p_success: true,
      p_error_code: null,
      p_error_summary: null,
      p_retry_delay_seconds: 30,
    });
    if (settlement.error) {
      // A failed materialization transaction leaves the same lease valid. Record
      // the failure in a second transaction so retry/dead-letter state is durable.
      const failed = await client.rpc("settle_security_event_outbox_attempt", {
        p_outbox_id: row.id,
        p_lease_token: row.lease_token,
        p_success: false,
        p_error_code: backendCode(settlement.error),
        p_error_summary: "Materialization unavailable",
        p_retry_delay_seconds: 30,
      });
      if (failed.error) {
        deferred += 1;
        continue;
      }
      resultRecord(failed.data);
      deferred += 1;
      continue;
    }
    const receipt = resultRecord(settlement.data);
    if (receipt.success === true && (receipt.status === "materialized" || receipt.alreadySettled === true)) materialized += 1;
    else deferred += 1;
  }
  return { claimed: rows.length, materialized, deferred };
}

export async function readReliableSecurityEventReceipt(outboxId: string) {
  const client = getSupabaseAdminClient();
  const { data, error } = await client
    .from("security_event_outbox")
    .select("id,status,observation_count,attempt_count,materialized_event_id,materialized_at,last_error_code,created_at,updated_at")
    .eq("id", outboxId)
    .maybeSingle();
  if (error) throw new SecurityEventReliabilityError("安全事件回执读取失败", backendCode(error), error);
  if (!data) throw new SecurityEventReliabilityError("安全事件回执不存在", "SECURITY_EVENT_OUTBOX_NOT_FOUND");
  return data;
}

export async function acceptReliableSecurityEvent(params: {
  event: ParsedReliableSecurityEvent;
  secret: string;
  idempotencyKey: string | null;
}) {
  const enqueue = await enqueueReliableSecurityEvent(params);
  let drain = { claimed: 0, materialized: 0, deferred: 0 };
  let drainCode: string | null = null;
  try {
    drain = await drainReliableSecurityEventOutbox(10);
  } catch (error) {
    drainCode = error instanceof SecurityEventReliabilityError ? error.code : "SECURITY_EVENT_DRAIN_FAILED";
  }
  const receipt = await readReliableSecurityEventReceipt(String(enqueue.outboxId));
  return {
    enqueue,
    receipt,
    drain,
    drainCode,
    durable: true,
    materialized: receipt.status === "materialized",
  };
}

export async function getSecurityEventReliabilityStatus() {
  const status = await rpc("get_security_event_reliability_status", {});
  return {
    ...status,
    producerConfiguration: getSecurityEventProducerConfigurationStatus(),
    integrationGaps: [
      "proxy_producer_bounded_retry_has_no_durable_pre_receiver_spool",
      "legacy_server_logSecurityEvent_still_writes_directly",
      "locked_proxy_still_uses_process_local_rate_and_ip_state",
      "legacy_security_events_may_contain_unmasked_pii",
      "outbox_retry_worker_not_scheduled",
      "retention_purge_executor_not_connected",
    ],
  };
}

export async function consumeSharedSecurityRateLimit(params: {
  scopeHash: string;
  routeKey: string;
  windowSeconds: number;
  requestLimit: number;
  cost?: number;
}) {
  return rpc("consume_security_rate_limit_atomic", {
    p_scope_hash: params.scopeHash,
    p_route_key: params.routeKey,
    p_window_seconds: params.windowSeconds,
    p_request_limit: params.requestLimit,
    p_cost: params.cost || 1,
  });
}

export function securityEventReliabilityErrorStatus(error: unknown): number {
  if (!(error instanceof SecurityEventReliabilityError)) return 500;
  if (error.code.endsWith("_NOT_FOUND")) return 404;
  if (error.code.includes("MIGRATION_REQUIRED") || error.code.includes("BACKEND_FAILURE") || error.code.includes("DRAIN_FAILED")) return 503;
  if (error.code.includes("CONFLICT")) return 409;
  if (error.code.includes("INVALID") || error.code.includes("REJECTED") || error.code.includes("MISSING")) return 400;
  return 500;
}
