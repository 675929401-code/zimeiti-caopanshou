import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/api-middleware";
import { beijingCalendarDayWindowStart } from "@/lib/beijing-history-window";
import {
  IMAGE_FAILURE_HISTORY_PAGE_SIZE,
  IMAGE_FAILURE_HISTORY_SURFACE,
  STORYBOARD_FAILURE_HISTORY_SURFACE,
  imageFailureBillingReferenceId,
  imageFailureBillingStateFromOperations,
  imageFailureRetryEligibility,
  imageTerminalFailureMessage,
  isImageFailureHistoryMigrationMissing,
  parseImageFailureRequestSnapshot,
  parseImageTerminalFailure,
} from "@/lib/image-failure-history";

export const dynamic = "force-dynamic";

const RECORD_ID = /^[a-f0-9]{64}$/u;

function requestedSurface(request: NextRequest) {
  return request.nextUrl.searchParams.get("surface") === STORYBOARD_FAILURE_HISTORY_SURFACE
    ? STORYBOARD_FAILURE_HISTORY_SURFACE
    : IMAGE_FAILURE_HISTORY_SURFACE;
}

type FailureRow = {
  record_id: string;
  client_idempotency_key: string;
  client_trace_id: string;
  payload_fingerprint: string;
  state: string;
  response: Record<string, unknown> | null;
  request_snapshot: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type BillingRow = {
  idempotency_key: string;
  operation_kind: string;
  amount: number | string | null;
  status: string;
};

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function failure(error: unknown) {
  if (isImageFailureHistoryMigrationMissing(error)) {
    return response({
      error: "失败记录暂时不可用，请稍后重试",
      code: "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY",
    }, 503);
  }
  return response({
    error: "生图失败历史暂时无法同步，请稍后重试",
    code: "IMAGE_FAILURE_HISTORY_UNAVAILABLE",
  }, 503);
}

export async function GET(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const page = Number(request.nextUrl.searchParams.get("page") || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) {
      return response({ error: "页码无效", code: "IMAGE_FAILURE_HISTORY_PAGE_INVALID" }, 400);
    }
    const db = authenticatedDb as SupabaseClient;
    const surface = requestedSurface(request);
    try {
      const offset = (page - 1) * IMAGE_FAILURE_HISTORY_PAGE_SIZE;
      const rows = await db.from("image_generation_requests")
        .select("record_id,client_idempotency_key,client_trace_id,payload_fingerprint,state,response,request_snapshot,created_at,updated_at")
        .eq("user_id", user.id)
        .eq("state", "failed_unknown")
        .eq("response->>schema", "image_request_rejection.v1")
        .eq("request_snapshot->>surface", surface)
        .is("failure_hidden_at", null)
        .gte("created_at", beijingCalendarDayWindowStart())
        .order("created_at", { ascending: false })
        .order("record_id", { ascending: false })
        .range(offset, offset + IMAGE_FAILURE_HISTORY_PAGE_SIZE);
      if (rows.error) throw rows.error;

      const loaded = (rows.data || []) as FailureRow[];
      const visible = loaded.slice(0, IMAGE_FAILURE_HISTORY_PAGE_SIZE).flatMap(row => {
        const snapshot = parseImageFailureRequestSnapshot(row.request_snapshot);
        const terminal = parseImageTerminalFailure(row.response, row.payload_fingerprint);
        return snapshot?.surface === surface && terminal ? [{ row, snapshot, terminal }] : [];
      });
      const billingReferences = visible.map(({ row }) => imageFailureBillingReferenceId(user.id, row.client_idempotency_key));
      const billingKeys = billingReferences.flatMap((reference) => [reference, `${reference}:release`]);
      const billing = billingKeys.length
        ? await db.from("wallet_operations")
          .select("idempotency_key,operation_kind,amount,status")
          .eq("user_id", user.id)
          .in("operation_kind", ["cash_charge", "cash_refund"])
          .in("idempotency_key", billingKeys)
        : { data: [], error: null };
      if (billing.error) throw billing.error;
      const billingRows = (billing.data || []) as BillingRow[];

      const records = visible.map(({ row, snapshot, terminal }) => {
        const billingReferenceId = imageFailureBillingReferenceId(user.id, row.client_idempotency_key);
        const resolvedBilling = imageFailureBillingStateFromOperations({
          billingReferenceId,
          billingExempt: snapshot.billingExempt,
          operations: billingRows,
        });
        const billingState = resolvedBilling.state;
        const retry = imageFailureRetryEligibility(billingState);
        return {
          id: row.record_id,
          createdAt: new Date(row.created_at).getTime(),
          updatedAt: new Date(row.updated_at).getTime(),
          prompt: snapshot.prompt,
          publicModelId: snapshot.publicModelId,
          modelName: snapshot.modelName,
          mode: snapshot.mode,
          aspectRatio: snapshot.aspectRatio,
          resolution: snapshot.resolution,
          referenceAssetRefs: snapshot.referenceAssetRefs,
          referenceCount: snapshot.referenceAssetRefs.length,
          quotedPriceYuan: snapshot.quotedPriceYuan,
          traceId: row.client_trace_id,
          error: {
            code: terminal.code,
            source: terminal.source,
            ...(terminal.upstreamStatus ? { upstreamStatus: terminal.upstreamStatus } : {}),
            message: imageTerminalFailureMessage(terminal),
          },
          billing: {
            state: billingState,
            referenceId: billingReferenceId,
            ...(resolvedBilling.chargedAmount !== undefined ? { chargedAmount: resolvedBilling.chargedAmount } : {}),
          },
          ...retry,
        };
      });
      return response({
        records,
        nextPage: loaded.length > IMAGE_FAILURE_HISTORY_PAGE_SIZE ? page + 1 : null,
      });
    } catch (error) {
      return failure(error);
    }
  });
}

export async function DELETE(request: NextRequest) {
  return withAuth(request, async (user, authenticatedDb) => {
    const id = request.nextUrl.searchParams.get("id")?.trim() || "";
    if (!RECORD_ID.test(id)) {
      return response({ error: "请选择需要隐藏的失败记录", code: "IMAGE_FAILURE_HISTORY_ID_INVALID" }, 400);
    }
    const db = authenticatedDb as SupabaseClient;
    const surface = requestedSurface(request);
    try {
      const result = await db.from("image_generation_requests")
        .update({ failure_hidden_at: new Date().toISOString() })
        .eq("record_id", id)
        .eq("user_id", user.id)
        .eq("state", "failed_unknown")
        .eq("response->>schema", "image_request_rejection.v1")
        .eq("request_snapshot->>surface", surface)
        .is("failure_hidden_at", null)
        .select("record_id")
        .maybeSingle();
      if (result.error) throw result.error;
      if (!result.data) {
        return response({ error: "失败记录不存在或无权访问", code: "IMAGE_FAILURE_HISTORY_NOT_FOUND" }, 404);
      }
      return response({ success: true, hiddenId: id });
    } catch (error) {
      return failure(error);
    }
  });
}
