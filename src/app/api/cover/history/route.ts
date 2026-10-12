import { NextRequest, NextResponse } from "next/server";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { storageManager, type StorageProviderType } from "@/storage/object";
import type { CoverCompositionPlan } from "@/lib/cover-composition";
import { DatabaseImageExactlyOnceStore } from "@/lib/image-exactly-once";
import { coverGeneratedReceipt, COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR } from "@/lib/cover-generated-delivery";
import {
  COVER_FAILURE_HISTORY_SURFACE,
  imageFailureBillingReferenceId,
  imageFailureBillingStateFromOperations,
  imageFailureRetryEligibility,
  imageTerminalFailureMessage,
  isImageFailureHistoryMigrationMissing,
  parseImageFailureRequestSnapshot,
  parseImageTerminalFailure,
  type ImageFailureBillingState,
} from "@/lib/image-failure-history";
import {
  COVER_ATTEMPT_ACTIVE_STATES,
  coverAttemptProjection,
  isCoverAttemptRow,
  type CoverAttemptRow,
} from "@/lib/cover-durable-attempt";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 20;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const RECORD_ID = /^[a-f0-9]{64}$/u;

function beijingThreeDayWindowStart(now = new Date()) {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate() - 2,
  ) - 8 * 60 * 60 * 1000).toISOString();
}

type CoverHistoryRow = {
  asset_id: string;
  background_asset_id: string;
  history_record_id: string;
  plan: CoverCompositionPlan;
  authoring_context?: { briefText?: string; prompt?: string };
  created_at: string;
  task_no: number;
  output_width: number;
  output_height: number;
  source_width: number;
  source_height: number;
};
type CoverAsset = { id: string; storage_key: string; storage_provider: StorageProviderType };
type FailureRow = {
  record_id: string;
  client_idempotency_key: string;
  client_trace_id: string;
  request_snapshot: unknown;
  payload_fingerprint: string;
  response: unknown;
  created_at: string;
};
type WalletOperationRow = {
  idempotency_key: string;
  operation_kind: string;
  amount: number | string | null;
  status: string;
};

type CoverTaskRecord = ReturnType<typeof coverAttemptProjection>["task"] & {
  assetId?: string;
  failureRecordId?: string;
  historyRecordId?: string;
};

function coverTaskStableKey(record: CoverTaskRecord) {
  return record.clientTraceId
    ? `request:${record.clientTraceId}`
    : record.clientIdempotencyKey
      ? `request:${record.clientIdempotencyKey}`
      : record.assetId
        ? `asset:${record.assetId}`
        : record.failureRecordId
          ? `failure:${record.failureRecordId}`
          : record.historyRecordId
            ? `history:${record.historyRecordId}`
            : `local:${record.id}`;
}

function coverAttemptMigrationUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error || "");
  return /cover_generation_attempts|reconcile_stale_cover_generation_attempts|schema cache/iu.test(message);
}

function failureHistoryUnavailable(error: unknown) {
  return {
    ready: false,
    code: isImageFailureHistoryMigrationMissing(error)
      ? "IMAGE_FAILURE_HISTORY_MIGRATION_NOT_READY"
      : "IMAGE_FAILURE_HISTORY_UNAVAILABLE",
    message: isImageFailureHistoryMigrationMissing(error)
      ? "失败记录服务正在准备中；现有已完成封面仍可查看，新的生成会在提交前安全停止。"
      : "失败历史暂时无法读取；现有已完成封面仍可查看。",
  };
}

async function loadFailedCoverHistory(
  db: ReturnType<typeof getSupabaseClient>,
  userId: string,
  page: number,
  windowStart: string,
  attemptsByKey: Map<string, ReturnType<typeof coverAttemptProjection>>,
) {
  const offset = (page - 1) * PAGE_SIZE;
  const loaded = await db
    .from("image_generation_requests")
    .select("record_id,client_idempotency_key,client_trace_id,request_snapshot,payload_fingerprint,response,created_at")
    .eq("user_id", userId)
    .eq("state", "failed_unknown")
    .eq("response->>schema", "image_request_rejection.v1")
    .eq("request_snapshot->>surface", COVER_FAILURE_HISTORY_SURFACE)
    .is("failure_hidden_at", null)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .order("record_id", { ascending: false })
    .range(offset, offset + PAGE_SIZE);

  if (loaded.error) {
    return { records: [], hasMore: false, state: failureHistoryUnavailable(loaded.error) };
  }

  const parsedRows = ((loaded.data || []) as FailureRow[])
    .slice(0, PAGE_SIZE)
    .flatMap((row) => {
      const snapshot = parseImageFailureRequestSnapshot(row.request_snapshot);
      const failure = parseImageTerminalFailure(row.response, row.payload_fingerprint);
      const integrityMatches = !snapshot?.payloadFingerprint || snapshot.payloadFingerprint === row.payload_fingerprint;
      return snapshot?.surface === COVER_FAILURE_HISTORY_SURFACE && integrityMatches && failure ? [{ row, snapshot, failure }] : [];
    });

  const billingReferences = parsedRows.map(({ row }) => imageFailureBillingReferenceId(userId, row.client_idempotency_key));
  const walletKeys = billingReferences.flatMap((reference) => [reference, `${reference}:release`]);
  const wallet = walletKeys.length
    ? await db
      .from("wallet_operations")
      .select("idempotency_key,operation_kind,amount,status")
      .eq("user_id", userId)
      .in("operation_kind", ["cash_charge", "cash_refund"])
      .in("idempotency_key", walletKeys)
    : { data: [], error: null };
  const walletRows = (wallet.data || []) as WalletOperationRow[];

  const records = parsedRows.map(({ row, snapshot, failure }) => {
    const attempt = attemptsByKey.get(row.client_trace_id) || attemptsByKey.get(row.client_idempotency_key);
    const task = attempt?.task;
    const billingReferenceId = imageFailureBillingReferenceId(userId, row.client_idempotency_key);
    const resolvedBilling = imageFailureBillingStateFromOperations({
      billingReferenceId,
      billingExempt: snapshot.billingExempt,
      operations: walletRows,
      queryFailed: Boolean(wallet.error),
    });
    const billingState: ImageFailureBillingState = resolvedBilling.state;
    const eligibility = imageFailureRetryEligibility(billingState);
    return {
      id: `cover-failure-${row.record_id}`,
      failureRecordId: row.record_id,
      ratio: task?.ratio || snapshot.aspectRatio,
      title: task?.title || "失败的封面生成",
      subtitle: task?.subtitle || "",
      prompt: task?.prompt || snapshot.prompt,
      ...(task?.briefText ? { briefText: task.briefText } : {}),
      ...(task?.renderPlan ? { renderPlan: task.renderPlan } : {}),
      source: "生成",
      createdAt: row.created_at,
      taskNo: task?.taskNo || 0,
      status: "failed",
      error: imageTerminalFailureMessage(failure),
      clientIdempotencyKey: row.client_idempotency_key,
      clientTraceId: row.client_trace_id,
      failureCode: failure.code,
      publicModelId: snapshot.publicModelId,
      modelName: snapshot.modelName,
      resolution: snapshot.resolution,
      requestIntegrity: {
        schema: snapshot.schema,
        payloadFingerprint: snapshot.payloadFingerprint || row.payload_fingerprint,
        effectivePrompt: snapshot.effectivePrompt || snapshot.prompt,
        style: snapshot.style || "",
        referenceUsage: snapshot.referenceUsage || "general",
        providerProtocol: snapshot.providerProtocol || "legacy_unknown",
        outputPixelSize: snapshot.outputPixelSize || "",
        imageCount: snapshot.imageCount || 1,
      },
      referenceAssetRefs: snapshot.referenceAssetRefs,
      referenceCount: snapshot.referenceAssetRefs.length,
      quotedPriceYuan: snapshot.quotedPriceYuan,
      billing: {
        state: billingState,
        referenceId: billingReferenceId,
        ...(resolvedBilling.chargedAmount !== undefined ? { chargedAmount: resolvedBilling.chargedAmount } : {}),
      },
      requiresReferenceReupload: snapshot.referenceAssetRefs.length > 0 && task?.renderPlan?.materialSourceId !== "template",
      ...eligibility,
    };
  });

  return {
    records,
    hasMore: (loaded.data || []).length > PAGE_SIZE,
    state: {
      ready: true,
      message: wallet.error
        ? "失败记录已载入，但账务查询暂不可用；相关记录已禁止重试。"
        : "",
    },
  };
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const page = Number(request.nextUrl.searchParams.get("page") || 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) {
    return NextResponse.json({ error: "历史页码无效" }, { status: 400 });
  }

  const userId = authorization.user.userId;
  const windowStart = beijingThreeDayWindowStart();
  const db = getSupabaseClient();
  const reconciled = await db.rpc("reconcile_stale_cover_generation_attempts", {
    p_user_id: userId,
    p_stale_after_seconds: 600,
  });
  const attemptReconciliationReady = !reconciled.error;
  const attemptsLoaded = await db.from("cover_generation_attempts")
    .select("id,user_id,surface,client_idempotency_key,client_trace_id,state,task,generation_input,requires_reference_reupload,background_asset_id,result_asset_id,history_record_id,error_code,created_at,updated_at,dispatched_at,completed_at,cancelled_at")
    .eq("user_id", userId).eq("surface", "cover-studio")
    .in("state", [...COVER_ATTEMPT_ACTIVE_STATES, "failed", "cancelled"])
    .gte("created_at", windowStart).order("created_at", { ascending: false }).limit(60);
  const attemptProjections = !attemptsLoaded.error
    ? ((attemptsLoaded.data || []) as unknown[])
      .filter((attempt): attempt is CoverAttemptRow => isCoverAttemptRow(attempt))
      .map(coverAttemptProjection)
    : [];
  const attemptsByKey = new Map<string, ReturnType<typeof coverAttemptProjection>>();
  for (const attempt of attemptProjections) {
    attemptsByKey.set(attempt.clientIdempotencyKey, attempt);
    attemptsByKey.set(attempt.clientTraceId, attempt);
  }
  const activeAttempts = attemptProjections.filter((attempt: ReturnType<typeof coverAttemptProjection>) => (
    COVER_ATTEMPT_ACTIVE_STATES.includes(attempt.state as typeof COVER_ATTEMPT_ACTIVE_STATES[number])
  ));
  const activeAttempt = activeAttempts[0] || null;
  const terminalAttemptRecords = attemptProjections
    .filter((attempt: ReturnType<typeof coverAttemptProjection>) => attempt.state === "failed" || attempt.state === "cancelled")
    .map((attempt: ReturnType<typeof coverAttemptProjection>) => attempt.task);
  const loaded = await db
    .from("cover_generation_history")
    .select("*")
    .eq("user_id", userId)
    .is("hidden_at", null)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false })
    .order("asset_id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  if (loaded.error) {
    return NextResponse.json({ error: "封面历史暂时无法读取，请稍后刷新" }, { status: 503 });
  }

  const rows = (loaded.data || []).slice(0, PAGE_SIZE) as CoverHistoryRow[];
  const assets = rows.length
    ? await db
      .from("user_files")
      .select("id,storage_key,storage_provider")
      .eq("user_id", userId)
      .eq("file_category", "image")
      .in("id", rows.map((row) => row.asset_id))
    : { data: [], error: null };
  if (assets.error) {
    return NextResponse.json({ error: "封面图片暂时无法读取，请稍后刷新" }, { status: 503 });
  }

  const owned = new Map<string, CoverAsset>(((assets.data || []) as CoverAsset[]).map((asset) => [asset.id, asset]));
  const completedRecords = await Promise.all(rows.map(async (row) => {
    const asset = owned.get(row.asset_id);
    let url = "";
    if (asset) {
      try {
        url = await storageManager.getSignedUrl(
          asset.storage_key,
          { expireTime: 3600 },
          asset.storage_provider as StorageProviderType,
        );
      } catch {
        // Retain editable history when signing is temporarily unavailable.
      }
    }
    const displayReady = Boolean(asset && url);
    return {
      id: `cover-render-${row.asset_id}`,
      assetId: row.asset_id,
      historyRecordId: row.history_record_id,
      backgroundAssetId: row.background_asset_id,
      renderPlan: row.plan,
      title: row.plan.title,
      subtitle: row.plan.subtitle,
      ratio: row.plan.aspectRatio,
      briefText: row.authoring_context?.briefText || "",
      prompt: row.authoring_context?.prompt || "",
      source: "生成",
      status: displayReady ? "done" : "display_pending",
      error: displayReady ? undefined : "封面文件已保存，展示地址暂未取得；系统会自动重试",
      createdAt: row.created_at,
      taskNo: row.task_no,
      outputWidth: row.output_width,
      outputHeight: row.output_height,
      sourceWidth: row.source_width,
      sourceHeight: row.source_height,
      storageKey: asset?.storage_key || "",
      url,
      cloudStored: true,
    };
  }));

  const failed = await loadFailedCoverHistory(db, userId, page, windowStart, attemptsByKey);
  const temporaryReceipts = [];
  const imageStore = new DatabaseImageExactlyOnceStore();
  for (const value of attemptsLoaded.error ? [] : attemptsLoaded.data || []) {
    if (!isCoverAttemptRow(value) || value.user_id !== userId || value.state !== "failed"
      || ![COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(value.error_code || "")) continue;
    const image = await imageStore.get({ userId, clientIdempotencyKey: value.client_idempotency_key, clientTraceId: value.client_trace_id });
    const receipt = coverGeneratedReceipt(image, { userId, clientIdempotencyKey: value.client_idempotency_key });
    if (!receipt) continue;
    temporaryReceipts.push({ ...coverAttemptProjection(value).task, status: "done", cloudStored: false, cancellable: false,
      canLoadForRetry: false, imageDeliveryReceipt: receipt,
      billing: { state: receipt.cashCharged > 0 ? "charged" : "exempt", referenceId: receipt.billingReferenceId || receipt.recordId, chargedAmount: receipt.cashCharged },
      error: "封面生成费用收据已保留；临时素材仅原页面可用，刷新后无法恢复" });
  }
  const recordCandidates = [...completedRecords, ...failed.records, ...terminalAttemptRecords, ...temporaryReceipts] as CoverTaskRecord[];
  const recordsByKey = new Map<string, CoverTaskRecord>();
  for (const record of recordCandidates) {
    const key = coverTaskStableKey(record);
    const existing = recordsByKey.get(key);
    // A provider failure record carries billing and retry evidence. Keep it
    // when the same durable attempt also appears as a terse terminal record.
    if (!existing || record.failureRecordId || !existing.failureRecordId) recordsByKey.set(key, record);
  }
  const records = [...recordsByKey.values()].sort((left, right) => {
    const byTime = (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
    return byTime || right.id.localeCompare(left.id);
  });

  return NextResponse.json({
    records,
    activeAttempt,
    activeAttempts,
    activeAttemptReady: attemptReconciliationReady && !attemptsLoaded.error,
    ...(reconciled.error ? {
      attemptState: {
        ready: false,
        code: coverAttemptMigrationUnavailable(reconciled.error)
          ? "COVER_ATTEMPT_MIGRATION_NOT_READY"
          : "COVER_ATTEMPT_RECONCILIATION_UNAVAILABLE",
      },
    } : {}),
    failureHistory: failed.state,
    nextPage: (loaded.data || []).length > PAGE_SIZE || failed.hasMore ? page + 1 : null,
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请确认要移除的封面历史" }, { status: 400 });
  }

  if (typeof body.failureRecordId === "string") {
    if (body.confirmation !== "REMOVE_COVER_FAILURE_HISTORY" || !RECORD_ID.test(body.failureRecordId)) {
      return NextResponse.json({ error: "请确认要隐藏的封面失败记录" }, { status: 400 });
    }
    const result = await getSupabaseClient()
      .from("image_generation_requests")
      .update({ failure_hidden_at: new Date().toISOString() })
      .eq("user_id", authorization.user.userId)
      .eq("record_id", body.failureRecordId)
      .eq("state", "failed_unknown")
      .eq("response->>schema", "image_request_rejection.v1")
      .eq("request_snapshot->>surface", COVER_FAILURE_HISTORY_SURFACE)
      .is("failure_hidden_at", null)
      .select("record_id");
    if (result.error) {
      const state = failureHistoryUnavailable(result.error);
      return NextResponse.json({ error: state.message, code: state.code }, { status: 503 });
    }
    if (!result.data?.length) {
      return NextResponse.json({ error: "封面失败记录不存在或无权访问" }, { status: 404 });
    }
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "private, no-store" } });
  }

  if (body.confirmation !== "REMOVE_COVER_HISTORY"
    || (body.clearAll !== true && (typeof body.assetId !== "string" || !UUID.test(body.assetId)))) {
    return NextResponse.json({ error: "请确认要移除的封面历史" }, { status: 400 });
  }
  const result = await getSupabaseClient().rpc("hide_cover_history", {
    p_user_id: authorization.user.userId,
    p_asset_id: body.clearAll === true ? null : body.assetId,
  });
  if (result.error) {
    const missing = /COVER_HISTORY_NOT_FOUND/u.test(result.error.message);
    return NextResponse.json(
      { error: missing ? "封面记录不存在或无权访问" : "封面历史移除未完成，请稍后重试" },
      { status: missing ? 404 : 503 },
    );
  }
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "private, no-store" } });
}
