import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import {
  DatabaseImageExactlyOnceStore,
  ImageExactlyOnceError,
  getImageProviderCheckpointState,
  getImageRequestRejection,
  ImageRequestRejectedError,
} from "@/lib/image-exactly-once";
import { parseImageFailureRequestSnapshot } from "@/lib/image-failure-history";
import { COVER_ATTEMPT_ACTIVE_STATES, coverAttemptProjection, isCoverAttemptRow } from "@/lib/cover-durable-attempt";
import { getSupabaseClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const store = new DatabaseImageExactlyOnceStore();
const STALE_IMAGE_INTENT_SECONDS = 10 * 60;

function response(body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", ...headers },
  });
}

function resumeInput(record: Awaited<ReturnType<DatabaseImageExactlyOnceStore["get"]>>) {
  const snapshot = parseImageFailureRequestSnapshot(record?.requestSnapshot);
  if (!snapshot || !["image-workbench", "cover-studio", "storyboard-workbench"].includes(snapshot.surface)) return {};
  return {
    resumeInput: {
      prompt: snapshot.prompt,
      modelId: snapshot.publicModelId,
      mode: snapshot.publicModelId.startsWith("workflow:") ? "workflow" : "local",
      style: "",
      aspectRatio: snapshot.aspectRatio,
      resolution: snapshot.resolution,
      coverText: snapshot.exactCoverText || "",
      referenceImageUrls: [],
      referenceUsage: "general",
      historySurface: snapshot.surface,
      resumeDeliveryOnly: true,
    },
  };
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user) => {

  const clientIdempotencyKey = request.nextUrl.searchParams.get("clientIdempotencyKey")?.trim() || "";
  const clientTraceId = request.nextUrl.searchParams.get("clientTraceId")?.trim() || "";

  try {
    let record = await store.get({
      userId: user.id,
      clientIdempotencyKey,
      clientTraceId,
    });

    if (!record) {
      if (clientIdempotencyKey.startsWith("cover_") && clientTraceId.startsWith("cover_")) {
        const attempt = await getSupabaseClient().from("cover_generation_attempts")
          .select("id,user_id,surface,client_idempotency_key,client_trace_id,state,task,generation_input,requires_reference_reupload,background_asset_id,result_asset_id,history_record_id,error_code,created_at,updated_at,dispatched_at,completed_at")
          .eq("user_id", user.id).eq("surface", "cover-studio")
          .eq("client_idempotency_key", clientIdempotencyKey).eq("client_trace_id", clientTraceId)
          .in("state", [...COVER_ATTEMPT_ACTIVE_STATES]).maybeSingle();
        if (!attempt.error && isCoverAttemptRow(attempt.data)) {
          const projection = coverAttemptProjection(attempt.data);
          return response({
            success: true,
            state: attempt.data.state === "claimed" ? "claimed_not_dispatched" : "processing",
            canRecover: true,
            canResubmit: false,
            sameKeyCanResubmit: false,
            activeAttempt: projection,
            ...(projection.dispatchInput ? { resumeInput: projection.dispatchInput } : {}),
            message: attempt.data.state === "claimed"
              ? "封面任务已安全认领，确认尚未调用生图服务。"
              : "封面任务已提交，系统正在核验原结果，请勿重复提交。",
            updatedAt: attempt.data.updated_at,
          });
        }
      }
      return response({
        success: true,
        state: "not_found",
        canRecover: false,
        canResubmit: false,
        message: "暂未查到这次请求的结果，请稍后刷新状态。",
      });
    }

    if ((record.state === "intent" || record.state === "failed_unknown")
      && !record.response
      && parseImageFailureRequestSnapshot(record.requestSnapshot)
      && Date.now() - Date.parse(record.updatedAt) >= STALE_IMAGE_INTENT_SECONDS * 1000) {
      record = await store.reconcileStaleIntent(record, user.id, STALE_IMAGE_INTENT_SECONDS) || record;
    }

    const rejection = getImageRequestRejection(record);
    if (rejection) {
      return response({ success: true, state: "rejected", code: rejection.code,
        canRecover: false, canResubmit: true, sameKeyCanResubmit: false,
        ...(rejection.upstreamStatus ? { upstreamStatus: rejection.upstreamStatus } : {}),
        message: new ImageRequestRejectedError(rejection).message, updatedAt: record.updatedAt });
    }

    if (record.state === "completed" && record.response) {
      const delivered = record.deliveryState === "delivered" && Boolean(record.deliveryAssetId);
      return response({
        success: true,
        state: delivered ? "completed" : "provider_completed_pending_delivery",
        canRecover: true,
        canResubmit: false,
        deliveryReady: delivered,
        ...(delivered ? { assetId: record.deliveryAssetId } : {}),
        ...resumeInput(record),
        message: delivered
          ? "图片已保存，可以直接查看。"
          : "图片已生成，系统将继续完成保存和展示。",
        updatedAt: record.updatedAt,
      });
    }

    const checkpoint = getImageProviderCheckpointState(record);
    if (checkpoint.hasCheckpoint) {
      return response({
        success: true,
        state: "provider_completed_pending_delivery",
        canRecover: !checkpoint.persistenceInProgress,
        canResubmit: false,
        deliveryReady: false,
        ...(checkpoint.retryAfterMs > 0 ? { retryAfterMs: checkpoint.retryAfterMs } : {}),
        ...(!checkpoint.persistenceInProgress ? resumeInput(record) : {}),
        message: checkpoint.persistenceInProgress
          ? "图片已生成，系统正在保存原结果；请稍后刷新，不要重复提交。"
          : "图片已生成，系统将自动继续保存并展示原结果。",
        updatedAt: record.updatedAt,
      }, 200, checkpoint.retryAfterMs > 0
        ? { "Retry-After": String(Math.max(1, Math.ceil(checkpoint.retryAfterMs / 1000))) }
        : {});
    }

    if (record.state === "intent") {
      return response({
        success: true,
        state: "processing",
        canRecover: false,
        canResubmit: false,
        message: "暂未取得生成结果，请稍后刷新状态。",
        updatedAt: record.updatedAt,
      });
    }

    return response({
      success: true,
      state: "unknown",
      canRecover: false,
      canResubmit: false,
      message: "图片结果待确认，原请求已保留。请稍后刷新状态。",
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    if (error instanceof ImageExactlyOnceError) {
      return response({ error: error.message, code: error.code }, error.status);
    }
    console.error("[Image/Status] read failed:", error instanceof Error ? error.name : "UnknownError");
    return response({
      error: "生图状态暂时无法确认；勿重复提交",
      code: "IMAGE_STATUS_UNAVAILABLE",
    }, 503);
  }
  });
}
