import { getSupabaseClient } from "@/storage/database/supabase-client";

export const VIDEO_SUBMISSION_CONFIRMATION_TIMEOUT_SECONDS = 30 * 60;
const VIDEO_SUBMISSION_RECONCILIATION_BATCH_SIZE = 64;

type ReconciliationResult = {
  expiredCount: number;
  protectedDispatchCount: number;
  taskIds: string[];
};

type ReconciliationBatchResult = ReconciliationResult & {
  scannedUserCount: number;
  failedUserCount: number;
};

function asObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return asObject(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function reconcileStaleVideoSubmissionsForUser(input: {
  userId: string;
  supabase?: ReturnType<typeof getSupabaseClient>;
}): Promise<ReconciliationResult> {
  const userId = String(input.userId || "").trim();
  if (!userId) throw new Error("VIDEO_SUBMISSION_RECONCILIATION_USER_REQUIRED");

  const db = input.supabase || getSupabaseClient();
  const { data, error } = await db.rpc("expire_video_submission_confirmations_atomic", {
    p_user_id: userId,
    p_timeout_seconds: VIDEO_SUBMISSION_CONFIRMATION_TIMEOUT_SECONDS,
  });
  if (error) {
    throw new Error(`VIDEO_SUBMISSION_RECONCILIATION_FAILED:${String(error.code || "UNKNOWN")}`);
  }

  const result = asObject(data);
  const taskIds = Array.isArray(result.task_ids)
    ? result.task_ids.map((value) => String(value || "")).filter(Boolean)
    : [];
  return {
    expiredCount: Math.max(0, Number(result.expired_count) || 0),
    protectedDispatchCount: Math.max(0, Number(result.protected_dispatch_count) || 0),
    taskIds,
  };
}

/**
 * Background reconciliation for submissions whose provider acknowledgement
 * was lost.  It never replays a provider POST.  The service-role RPC performs
 * the final row locks and refuses to expire any task that has provider, asset,
 * lifecycle, or billing evidence.
 */
export async function reconcileStaleVideoSubmissionBatch(input: {
  supabase: ReturnType<typeof getSupabaseClient>;
  now?: Date;
  batchSize?: number;
}): Promise<ReconciliationBatchResult> {
  const db = input.supabase;
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime())
    ? input.now
    : new Date();
  const requestedBatchSize = Math.floor(Number(input.batchSize) || VIDEO_SUBMISSION_RECONCILIATION_BATCH_SIZE);
  const batchSize = Math.max(1, Math.min(requestedBatchSize, 256));
  const cutoff = new Date(now.getTime() - VIDEO_SUBMISSION_CONFIRMATION_TIMEOUT_SECONDS * 1000).toISOString();
  const { data, error } = await db.from("video_tasks")
    .select("user_id")
    .in("status", ["pending", "queued"])
    .eq("billing_state", "reserved")
    .eq("submission_error_code", "VIDEO_SUBMIT_OUTCOME_UNKNOWN")
    .or("task_id_external.is.null,task_id_external.eq.")
    .or("task_label.is.null,task_label.not.like.digital-human:%")
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true })
    .range(0, batchSize - 1);
  if (error) throw new Error("VIDEO_SUBMISSION_RECONCILIATION_SCAN_FAILED");

  const userIds = [...new Set(((data || []) as Array<{ user_id?: unknown }>)
    .map((row) => String(row.user_id || "").trim())
    .filter(Boolean))];
  const settled = await Promise.allSettled(userIds.map((userId) =>
    reconcileStaleVideoSubmissionsForUser({ userId, supabase: db })));
  const taskIds: string[] = [];
  let expiredCount = 0;
  let protectedDispatchCount = 0;
  let failedUserCount = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      failedUserCount += 1;
      continue;
    }
    expiredCount += result.value.expiredCount;
    protectedDispatchCount += result.value.protectedDispatchCount;
    taskIds.push(...result.value.taskIds);
  }
  return {
    expiredCount,
    protectedDispatchCount,
    taskIds: [...new Set(taskIds)],
    scannedUserCount: userIds.length,
    failedUserCount,
  };
}
