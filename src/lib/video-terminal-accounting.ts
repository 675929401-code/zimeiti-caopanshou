import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { classifyVideoProviderError, sanitizeVideoProviderDiagnostic } from "./video-error-policy";

export type VideoTerminalOutcome = "success" | "fail";

type TerminalOutcomeInput = {
  modelId: string;
  outcome: VideoTerminalOutcome;
  responseMs: number;
  errorMessage?: string;
  countSubmission?: boolean;
};

const accountingQueues = new Map<string, Promise<void>>();

function toCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function videoHealthAfterOutcome(
  previous: { is_healthy?: boolean | null; consecutive_failures?: unknown } | null,
  outcome: VideoTerminalOutcome,
  errorMessage?: string,
): boolean {
  if (outcome === "success") return true;
  // A failed recovery must never reopen a suspended or unverified model.
  if (!previous || previous.is_healthy !== true) return false;
  const category = classifyVideoProviderError(errorMessage).category;
  // Account funding does not invalidate a previously verified endpoint or
  // credential binding. A recharge must make the next request usable without
  // an administrator reopening the model.
  if (category === "account_quota") return true;
  if (["authentication", "model_channel", "provider_unavailable"].includes(category)) return false;
  if (["asset_input", "content_policy"].includes(category)) return true;
  return toCount(previous.consecutive_failures) + 1 < 3;
}

export function videoHealthVerificationAfterOutcome(
  previous: {
    verification_state?: unknown;
    verification_evidence?: unknown;
  } | null,
  outcome: VideoTerminalOutcome,
  nextHealthy: boolean,
  now: string,
  errorMessage?: string,
): Record<string, unknown> {
  const evidence = previous?.verification_evidence
    && typeof previous.verification_evidence === "object"
    && !Array.isArray(previous.verification_evidence)
    ? previous.verification_evidence as Record<string, unknown>
    : {};
  if (outcome === "fail" && classifyVideoProviderError(errorMessage).category === "account_quota") {
    return {};
  }
  if (outcome === "success" && previous?.verification_state === "verified") {
    return {
      // The successful terminal outcome is newer than the publication canary.
      // Advance the verification timestamp with last_success_at so the release
      // protocol's verified_at >= last_success_at invariant stays true.
      verified_at: now,
      verification_evidence: { ...evidence, latest_success_at: now },
    };
  }
  if (!nextHealthy && previous?.verification_state === "verified") {
    return {
      verification_state: "revoked",
      verified_at: null,
      verification_evidence: {
        ...evidence,
        revoked_at: now,
        revocation_category: classifyVideoProviderError(errorMessage).category,
      },
    };
  }
  return {};
}

async function serializeModelUpdate(modelId: string, work: () => Promise<void>) {
  const previous = accountingQueues.get(modelId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  accountingQueues.set(modelId, current);
  try {
    await current;
  } finally {
    if (accountingQueues.get(modelId) === current) accountingQueues.delete(modelId);
  }
}

export async function recordVideoSubmission(modelId: string) {
  await serializeModelUpdate(modelId, async () => {
    const db = getSupabaseAdminClient();
    const { data: model, error } = await db
      .from("video_models")
      .select("total_requests")
      .eq("id", modelId)
      .maybeSingle();
    if (error) throw error;
    if (!model) return;

    const { error: updateError } = await db
      .from("video_models")
      .update({ total_requests: toCount(model.total_requests) + 1 })
      .eq("id", modelId);
    if (updateError) throw updateError;
  });
}

export async function recordVideoTerminalOutcome({
  modelId,
  outcome,
  responseMs,
  errorMessage,
  countSubmission = false,
}: TerminalOutcomeInput) {
  await serializeModelUpdate(modelId, async () => {
    const db = getSupabaseAdminClient();
    const now = new Date().toISOString();
    const safeResponseMs = Math.max(0, Math.round(responseMs));

    const { data: model, error: modelError } = await db
      .from("video_models")
      .select("total_requests, success_count, fail_count")
      .eq("id", modelId)
      .maybeSingle();
    if (modelError) throw modelError;
    if (model) {
      const modelPatch: Record<string, unknown> = {
        success_count: toCount(model.success_count) + (outcome === "success" ? 1 : 0),
        fail_count: toCount(model.fail_count) + (outcome === "fail" ? 1 : 0),
      };
      if (countSubmission) modelPatch.total_requests = toCount(model.total_requests) + 1;
      if (outcome === "success") modelPatch.last_success_at = now;

      const { error: updateError } = await db.from("video_models").update(modelPatch).eq("id", modelId);
      if (updateError) throw updateError;
    }

    const { data: health, error: healthError } = await db
      .from("video_channel_health")
      .select("*")
      .eq("channel_id", modelId)
      .maybeSingle();
    if (healthError) throw healthError;

    if (health) {
      const failureCategory = outcome === "fail" ? classifyVideoProviderError(errorMessage).category : null;
      const countsTowardCircuit = outcome === "fail" && failureCategory !== "account_quota";
      const consecutiveFailures = outcome === "success"
        ? 0
        : countsTowardCircuit
          ? toCount(health.consecutive_failures) + 1
          : toCount(health.consecutive_failures);
      const timeoutIncrement = outcome === "fail" && /超时|timeout/iu.test(errorMessage || "") ? 1 : 0;
      const averageBase = toCount(health.avg_response_ms);
      const averageResponseMs = averageBase > 0
        ? Math.round(averageBase * 0.7 + safeResponseMs * 0.3)
        : safeResponseMs;
      const nextHealthy = videoHealthAfterOutcome(health, outcome, errorMessage);
      const verificationPatch = videoHealthVerificationAfterOutcome(
        health,
        outcome,
        nextHealthy,
        now,
        errorMessage,
      );

      const { error: updateError } = await db.from("video_channel_health").update({
        total_requests: toCount(health.total_requests) + 1,
        success_count: toCount(health.success_count) + (outcome === "success" ? 1 : 0),
        fail_count: toCount(health.fail_count) + (outcome === "fail" ? 1 : 0),
        timeout_count: toCount(health.timeout_count) + timeoutIncrement,
        avg_response_ms: averageResponseMs,
        last_success_at: outcome === "success" ? now : health.last_success_at,
        last_fail_at: outcome === "fail" ? now : health.last_fail_at,
        last_error: outcome === "fail" ? sanitizeVideoProviderDiagnostic(errorMessage) : null,
        consecutive_failures: consecutiveFailures,
        is_healthy: nextHealthy,
        ...verificationPatch,
        updated_at: now,
      }).eq("channel_id", modelId);
      if (updateError) throw updateError;
      return;
    }

    const { error: insertError } = await db.from("video_channel_health").insert({
      channel_id: modelId,
      total_requests: 1,
      success_count: outcome === "success" ? 1 : 0,
      fail_count: outcome === "fail" ? 1 : 0,
      timeout_count: outcome === "fail" && /超时|timeout/iu.test(errorMessage || "") ? 1 : 0,
      avg_response_ms: safeResponseMs,
      last_success_at: outcome === "success" ? now : null,
      last_fail_at: outcome === "fail" ? now : null,
      last_error: outcome === "fail" ? sanitizeVideoProviderDiagnostic(errorMessage) : null,
      consecutive_failures: outcome === "fail" ? 1 : 0,
      is_healthy: outcome === "success",
      updated_at: now,
    });
    if (insertError) throw insertError;
  });
}
