import "server-only";

import { buildVideoTaskIdentity, normalizeVideoClientRequestId } from "@/lib/video-terminal-finalizer";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type LookupResult = { data: unknown; error?: unknown };
interface RetryQuery extends PromiseLike<LookupResult> {
  eq(column: string, value: unknown): RetryQuery;
  in(column: string, values: readonly string[]): RetryQuery;
  limit(count: number): RetryQuery;
  abortSignal(signal: AbortSignal): RetryQuery;
  maybeSingle(): PromiseLike<LookupResult>;
}
export interface VideoManualRetryDatabase {
  from(table: string): { select(columns: string): RetryQuery };
}

const TASK_FIELDS = [
  "id", "user_id", "client_request_id", "model_id", "request_fingerprint", "request_snapshot_hash", "routing_snapshot_hash",
  "status", "billing_state", "billing_unit", "price_charged", "billing_operation_id", "billing_idempotency_key",
  "billing_reserved_yuan", "billing_token_quote", "billing_token_usage", "submission_error_code",
  "task_id_external", "video_url", "storage_url", "provider_result_url", "content_url",
  "provider_acknowledged_at", "provider_reconciliation_state", "provider_submission_receipt", "provider_dispatch_receipt",
  "provider_dispatch_started_at", "created_at", "completed_at",
] as const;
const empty = (value: unknown) => value === null || value === undefined || value === "";

function eligibleTask(value: unknown, taskId: string, userId: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (task.id !== taskId || task.user_id !== userId || task.status !== "failed" || task.billing_state !== "submission_failed"
    || !["per_use", "output_second"].includes(String(task.billing_unit)) || task.price_charged !== 0
    || !empty(task.billing_operation_id) || !empty(task.billing_token_quote) || !empty(task.billing_token_usage)
    || (task.billing_reserved_yuan != null && task.billing_reserved_yuan !== 0)
    || typeof task.client_request_id !== "string" || normalizeVideoClientRequestId(task.client_request_id) !== task.client_request_id
    || typeof task.request_fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(task.request_fingerprint)
    || typeof task.submission_error_code !== "string" || !task.submission_error_code.trim()
    || /UNKNOWN|UNCONFIRMED|RECONCILIATION/iu.test(task.submission_error_code)) return null;
  // A dispatch receipt alone does not mean acceptance: an explicit HTTP rejection
  // can leave dispatch_recorded. Acknowledgement/unknown evidence always blocks.
  if ((!empty(task.provider_reconciliation_state) && task.provider_reconciliation_state !== "dispatch_recorded")
    || ["task_id_external", "video_url", "storage_url", "provider_result_url", "content_url", "provider_acknowledged_at", "provider_submission_receipt"].some(key => !empty(task[key]))) return null;
  const identity = buildVideoTaskIdentity(userId, task.client_request_id);
  // The reservation SQL persists video-terminal:<vt_id>; older application
  // identities expose the full digest. Both must derive from this same task.
  const knownBillingKeys = [identity.billingIdempotencyKey, `video-terminal:${identity.taskIdInternal}`];
  return identity.taskIdInternal === taskId && knownBillingKeys.includes(String(task.billing_idempotency_key)) ? task : null;
}

/**
 * Permission for a user-confirmed NEW request, not an automatic provider retry.
 * Fail closed on incomplete task/ledger reads. Readback narrows races but is not
 * an atomic lock against a later provider acknowledgement or wallet operation.
 */
export async function canManuallyRetryUnsubmittedVideoTask(input: {
  taskId: string;
  userId: string;
  db?: VideoManualRetryDatabase;
}): Promise<boolean> {
  if (typeof input.taskId !== "string" || !input.taskId || input.taskId !== input.taskId.trim()
    || typeof input.userId !== "string" || !input.userId || input.userId !== input.userId.trim()) return false;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>(resolve => { timeout = setTimeout(() => { controller.abort(); resolve(false); }, 10_000); });
  try {
    const db = input.db || getSupabaseAdminClient() as VideoManualRetryDatabase;
    const readTask = async () => {
      const result = await db.from("video_tasks").select(TASK_FIELDS.join(","))
        .eq("id", input.taskId).eq("user_id", input.userId).abortSignal(controller.signal).maybeSingle();
      return !controller.signal.aborted && !result.error ? eligibleTask(result.data, input.taskId, input.userId) : null;
    };
    const verify = async () => {
      const before = await readTask();
      if (!before) return false;
      const identity = buildVideoTaskIdentity(input.userId, before.client_request_id as string);
      const keys = [...new Set([before.billing_idempotency_key as string, identity.billingIdempotencyKey, `video-terminal:${identity.taskIdInternal}`])]
        .flatMap(key => [key, `${key}:release`]);
      // ANY operation/status is a blocker, including incomplete charges and
      // refunds under either verified identity alias or its release suffix.
      const ledger = await db.from("wallet_operations").select("id")
        .eq("user_id", input.userId).in("idempotency_key", keys)
        .limit(1).abortSignal(controller.signal);
      if (controller.signal.aborted || ledger.error || !Array.isArray(ledger.data) || ledger.data.length !== 0) return false;
      const after = await readTask();
      return Boolean(after) && JSON.stringify(TASK_FIELDS.map(key => before[key])) === JSON.stringify(TASK_FIELDS.map(key => after![key]));
    };
    return await Promise.race([verify(), expired]);
  } catch { return false; }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
}
