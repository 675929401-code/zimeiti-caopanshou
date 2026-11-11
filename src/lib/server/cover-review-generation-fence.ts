import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { isCoverAttemptRow, parseCoverAttemptClaim, type CoverAttemptRow } from "@/lib/cover-durable-attempt";
import { DatabaseImageExactlyOnceStore, getImageRequestRejection } from "@/lib/image-exactly-once";
import { completedCoverResult } from "./cover-completed-receipt";
import { CoverConfirmationQueryOriginalError, coverMaterialFingerprint, loadCoverConfirmationsForAnalysis, type CoverPrepareRow } from "./cover-prepare-repository";

const imageStore = new DatabaseImageExactlyOnceStore();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function boundAttempt(row: CoverAttemptRow, child: CoverPrepareRow) {
  const key = `coverwb_${child.id}`;
  const expected = parseCoverAttemptClaim({ task: child.result?.task, payload: child.result?.generationInput, referenceCount: 0 });
  return row.user_id === child.user_id && row.surface === "cover-studio" && row.client_idempotency_key === key && row.client_trace_id === key
    && row.task.prepareOperationId === child.id && Boolean(expected)
    && coverMaterialFingerprint(row.task) === coverMaterialFingerprint(expected?.task)
    && coverMaterialFingerprint(row.generation_input) === coverMaterialFingerprint(expected?.generationInput);
}

async function definitelyFailed(row: CoverAttemptRow) {
  const image = await imageStore.get({ userId: row.user_id, clientIdempotencyKey: row.client_idempotency_key, clientTraceId: row.client_trace_id });
  if (!image || image.recordId !== sha256(`${row.user_id}\0${row.client_idempotency_key}`) || image.userHash !== sha256(row.user_id)
    || image.clientIdempotencyKey !== row.client_idempotency_key || image.clientTraceId !== row.client_trace_id
    || !/^[a-f0-9]{64}$/u.test(image.payloadFingerprint) || !getImageRequestRejection(image)) return false;
  const snapshot = image.requestSnapshot;
  return Boolean(snapshot && snapshot.surface === "cover-studio" && snapshot.payloadFingerprint === image.payloadFingerprint
    && snapshot.publicModelId === row.generation_input.modelId && snapshot.prompt === row.generation_input.prompt.trim()
    && snapshot.aspectRatio === row.generation_input.aspectRatio && snapshot.resolution === row.generation_input.resolution
    && snapshot.style === row.generation_input.style.trim() && snapshot.referenceUsage === row.generation_input.referenceUsage);
}

/** SELECT/pure-proof only. Never call attempt GET, stale reconciliation or RPC.
 * Different plans with no attempt may coexist; this is not a parent-wide CAS.
 */
export async function assertNoUncertainCoverReviewSibling(request: NextRequest, userId: string, parentId: string, currentChildId?: string) {
  const siblings = await loadCoverConfirmationsForAnalysis(userId, parentId);
  for (const child of siblings) {
    if (child.id === currentChildId || child.preparation.route === "original_layout") continue;
    try {
      const key = `coverwb_${child.id}`;
      // Read by owner/key first so an invalid trace cannot disguise an attempt.
      const loaded = await getSupabaseClient().from("cover_generation_attempts").select("*")
        .eq("user_id", userId).eq("surface", "cover-studio").eq("client_idempotency_key", key).maybeSingle();
      if (loaded.error) throw loaded.error;
      if (!loaded.data) {
        // A persisted image intent without the cover wrapper is also unknown.
        const image = await imageStore.get({ userId, clientIdempotencyKey: key, clientTraceId: key });
        if (!image) continue;
        throw new CoverConfirmationQueryOriginalError(child.id);
      }
      if (!isCoverAttemptRow(loaded.data) || !boundAttempt(loaded.data, child)) throw new CoverConfirmationQueryOriginalError(child.id);
      const attempt = loaded.data;
      if (attempt.state === "completed") { await completedCoverResult(request, userId, attempt); continue; }
      if (attempt.state === "failed" && await definitelyFailed(attempt)) continue;
    } catch {
      // Missing/invalid proof and read uncertainty preserve the original ID.
      throw new CoverConfirmationQueryOriginalError(child.id);
    }
    throw new CoverConfirmationQueryOriginalError(child.id);
  }
}
