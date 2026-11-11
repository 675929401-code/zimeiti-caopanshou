import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { coverPublicImageFailure } from "@/lib/server/cover-public-error";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  COVER_ATTEMPT_ACTIVE_STATES,
  coverAttemptProjection,
  isCoverAttemptRow,
  parseCoverAttemptClaim,
  parseCoverAttemptKeys,
  parseCoverDispatchPayload,
  sameCoverGenerationInput,
  type CoverAttemptRow,
} from "@/lib/cover-durable-attempt";
import {
  DatabaseImageExactlyOnceStore,
  getImageProviderCheckpointState,
  getImageRequestRejection,
  ImageRequestRejectedError,
  type ImageExactlyOnceRecord,
} from "@/lib/image-exactly-once";
import { isConfirmedTerminalImageFailure } from "@/lib/image-workbench-attempt-guard";
import { validatePreparedCoverGeneration } from "@/lib/server/cover-prepared-generation";
import { CoverPrepareError, coverMaterialFingerprint } from "@/lib/server/cover-prepare-repository";
import { CoverGeneratedExportError, exportGeneratedCoverBackground } from "@/lib/server/cover-generated-export";
import { coverCompositionMatches } from "@/lib/cover-composition";
import { deliveryBinding, completedCoverResult } from "@/lib/server/cover-completed-receipt";
import { coverGeneratedReceipt, composeGeneratedCover, COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR } from "@/lib/cover-generated-delivery";
// The durable wrapper must own the CAS dispatch before invoking the existing paid route.
// eslint-disable-next-line no-restricted-imports
import { POST as generateImage } from "@/app/api/image/generate/route";
// Composition remains in its existing account-owned route and is idempotent by render fingerprint.
// eslint-disable-next-line no-restricted-imports
import { POST as renderCover } from "@/app/api/cover/render/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ATTEMPT_COLUMNS = "id,user_id,surface,client_idempotency_key,client_trace_id,state,task,generation_input,requires_reference_reupload,background_asset_id,result_asset_id,history_record_id,error_code,created_at,updated_at,dispatched_at,completed_at,cancelled_at";
const imageStore = new DatabaseImageExactlyOnceStore();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const temporaryCodes = [COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function terminalAttemptPayload(row: CoverAttemptRow, message?: string) {
  const projected = coverAttemptProjection(row);
  return {
    activeAttempt: null,
    terminalAttempt: projected,
    completed: false,
    state: row.state,
    canResubmit: true,
    message: message || projected.task.error,
  };
}

function isTerminalAttempt(row: CoverAttemptRow) {
  return row.state === "completed" || row.state === "failed" || row.state === "cancelled";
}

function rpcRecord(value: unknown) {
  const root = Array.isArray(value) ? value[0] : value;
  if (!root || typeof root !== "object") return null;
  const record = (root as Record<string, unknown>).record;
  return isCoverAttemptRow(record) ? record : null;
}

function migrationUnavailable(error: unknown) {
  const message = String((error as { message?: unknown })?.message || error || "");
  return /cover_generation_attempts|claim_cover_generation_attempt|begin_cover_generation_dispatch|settle_cover_generation_attempt|cancel_cover_generation_attempt|reconcile_stale_cover_generation_attempts|schema cache/iu.test(message);
}

async function activeAttempt(userId: string) {
  const loaded = await getSupabaseClient().from("cover_generation_attempts").select(ATTEMPT_COLUMNS)
    .eq("user_id", userId).eq("surface", "cover-studio").in("state", [...COVER_ATTEMPT_ACTIVE_STATES])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (loaded.error) throw loaded.error;
  return isCoverAttemptRow(loaded.data) ? loaded.data : null;
}

async function exactAttempt(userId: string, keys: { clientIdempotencyKey: string; clientTraceId: string }) {
  const loaded = await getSupabaseClient().from("cover_generation_attempts").select(ATTEMPT_COLUMNS)
    .eq("user_id", userId).eq("surface", "cover-studio")
    .eq("client_idempotency_key", keys.clientIdempotencyKey).eq("client_trace_id", keys.clientTraceId).maybeSingle();
  if (loaded.error) throw loaded.error;
  return isCoverAttemptRow(loaded.data) ? loaded.data : null;
}

async function settle(userId: string, row: CoverAttemptRow, state: "delivery_pending" | "completed" | "failed", input: {
  backgroundAssetId?: string; resultAssetId?: string; historyRecordId?: string; errorCode?: string;
} = {}) {
  const result = await getSupabaseClient().rpc("settle_cover_generation_attempt", {
    p_user_id: userId,
    p_client_idempotency_key: row.client_idempotency_key,
    p_client_trace_id: row.client_trace_id,
    p_state: state,
    p_background_asset_id: input.backgroundAssetId || null,
    p_result_asset_id: input.resultAssetId || null,
    p_history_record_id: input.historyRecordId || null,
    p_error_code: input.errorCode || null,
  });
  if (result.error) throw result.error;
  return rpcRecord(result.data) || row;
}

async function completedAttemptResponse(request: NextRequest, userId: string, row: CoverAttemptRow) {
  return json({ success: true, completed: true, activeAttempt: null, backgroundAssetId: row.background_asset_id,
    result: await completedCoverResult(request, userId, row) });
}

function isV2ProviderResult(row: CoverAttemptRow, image: ImageExactlyOnceRecord | null) {
  return row.task.renderPlan.planVersion === 2 && image?.state === "completed" && image.deliveryState === "delivered"
    && image.response?.deliveryMode === "provider_url";
}

async function validateOriginalProviderResult(request: NextRequest, userId: string, row: CoverAttemptRow, image: ImageExactlyOnceRecord) {
  await deliveryBinding(request, userId, row);
  const snapshot = image.requestSnapshot;
  if (row.user_id !== userId || image.recordId !== sha256(`${userId}\0${row.client_idempotency_key}`)
    || image.userHash !== sha256(userId) || image.clientIdempotencyKey !== row.client_idempotency_key
    || image.clientTraceId !== row.client_trace_id || !isV2ProviderResult(row, image)
    || snapshot?.publicModelId !== row.generation_input.modelId || snapshot.surface !== "cover-studio"
    || snapshot.prompt !== row.generation_input.prompt.trim() || snapshot.aspectRatio !== row.generation_input.aspectRatio
    || snapshot.resolution !== row.generation_input.resolution || snapshot.payloadFingerprint !== image.payloadFingerprint
    || snapshot.style !== row.generation_input.style.trim() || snapshot.referenceUsage !== row.generation_input.referenceUsage) {
    throw new CoverPrepareError("COVER_ORIGINAL_IMAGE_BINDING_INVALID", "原图片与已确认封面任务不一致，已停止交付", 409);
  }
}

/** Only the two obsolete temporary outcomes may move back into delivery. */
async function recoverTemporaryDelivery(userId: string, row: CoverAttemptRow, backgroundAssetId: string) {
  if (row.task.renderPlan.planVersion !== 2 || row.state !== "failed" || !temporaryCodes.includes(row.error_code || "")
    || row.result_asset_id || row.history_record_id || row.cancelled_at) {
    throw new CoverPrepareError("COVER_DELIVERY_RECOVERY_NOT_ALLOWED", "原任务状态不允许恢复交付，请查询原任务", 409);
  }
  const recovered = await getSupabaseClient().from("cover_generation_attempts")
    .update({ state: "delivery_pending", background_asset_id: backgroundAssetId, completed_at: null,
      error_code: null, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("user_id", userId).eq("surface", "cover-studio")
    .eq("client_idempotency_key", row.client_idempotency_key).eq("client_trace_id", row.client_trace_id)
    .eq("state", "failed").eq("error_code", row.error_code).eq("updated_at", row.updated_at)
    .is("result_asset_id", null).is("history_record_id", null).is("cancelled_at", null)
    .select(ATTEMPT_COLUMNS).maybeSingle();
  if (recovered.error && recovered.error.code !== "23505") throw recovered.error;
  if (isCoverAttemptRow(recovered.data)) return { acquired: true, row: recovered.data };
  const latest = await exactAttempt(userId, { clientIdempotencyKey: row.client_idempotency_key, clientTraceId: row.client_trace_id });
  return { acquired: false, row: latest || row };
}

async function deliverV2ProviderResult(request: NextRequest, userId: string, row: CoverAttemptRow, image: ImageExactlyOnceRecord) {
  await validateOriginalProviderResult(request, userId, row, image);
  const exported = await exportGeneratedCoverBackground({ request, userId, recordId: image.recordId,
    clientIdempotencyKey: row.client_idempotency_key, clientTraceId: row.client_trace_id, plan: row.task.renderPlan });
  if (exported.success !== true || exported.persisted !== true || exported.cloudStored !== true || exported.provider !== "tencent_cos"
    || exported.userId !== userId || exported.recordId !== image.recordId || !UUID.test(exported.assetId)
    || (row.background_asset_id && row.background_asset_id !== exported.assetId)) {
    throw new CoverPrepareError("COVER_BACKGROUND_EXPORT_UNCONFIRMED", "原底图保存回执尚未确认，请查询原任务，勿重新生成", 503);
  }
  if (row.state === "failed") {
    const recovered = await recoverTemporaryDelivery(userId, row, exported.assetId);
    if (!recovered.acquired) {
      if (recovered.row.state === "completed") return completedAttemptResponse(request, userId, recovered.row);
      if (recovered.row.state === "cancelled" || recovered.row.state === "failed") return json({ success: true,
        ...terminalAttemptPayload(recovered.row), canResubmit: false, message: "原任务状态已变化，请查询原任务；不会重新生图" });
      return json({ success: true, completed: false, activeAttempt: coverAttemptProjection(recovered.row),
        message: "原封面的交付已由另一请求接手，请查询原任务；不会重复生图" }, 202);
    }
    row = recovered.row;
  }
  const rendered = await renderDelivered(request, userId, row, exported.assetId);
  if (rendered.complete) return json({ success: true, completed: true, activeAttempt: null,
    backgroundAssetId: rendered.row.background_asset_id || exported.assetId, result: rendered.result });
  if (rendered.terminal) return json({ success: true, ...terminalAttemptPayload(rendered.row),
    canResubmit: rendered.row.state === "failed" && !temporaryCodes.includes(rendered.row.error_code || "") });
  return json({ success: true, completed: false, activeAttempt: coverAttemptProjection(rendered.row),
    message: "原底图已保存，正在完成标题与封面历史；不会重新生图" }, 202);
}

async function renderDelivered(request: NextRequest, userId: string, row: CoverAttemptRow, backgroundAssetId: string) {
  const latestBeforeDelivery = await exactAttempt(userId, {
    clientIdempotencyKey: row.client_idempotency_key,
    clientTraceId: row.client_trace_id,
  });
  if (latestBeforeDelivery?.state === "completed") return { complete: true as const, terminal: true as const,
    row: latestBeforeDelivery, result: await completedCoverResult(request, userId, latestBeforeDelivery) };
  if (latestBeforeDelivery && isTerminalAttempt(latestBeforeDelivery)) {
    return { complete: false as const, terminal: true as const, row: latestBeforeDelivery, result: {} };
  }
  const deliveryPending = await settle(userId, latestBeforeDelivery || row, "delivery_pending", { backgroundAssetId });
  if (deliveryPending.state === "completed") return { complete: true as const, terminal: true as const,
    row: deliveryPending, result: await completedCoverResult(request, userId, deliveryPending) };
  if (isTerminalAttempt(deliveryPending)) {
    return { complete: false as const, terminal: true as const, row: deliveryPending, result: {} };
  }
  const latestBeforeRender = await exactAttempt(userId, {
    clientIdempotencyKey: row.client_idempotency_key,
    clientTraceId: row.client_trace_id,
  }) || deliveryPending;
  if (latestBeforeRender.state === "completed") return { complete: true as const, terminal: true as const,
    row: latestBeforeRender, result: await completedCoverResult(request, userId, latestBeforeRender) };
  if (isTerminalAttempt(latestBeforeRender)) {
    return { complete: false as const, terminal: true as const, row: latestBeforeRender, result: {} };
  }
  row = latestBeforeRender;
  const body = JSON.stringify({
    sourceAssetId: backgroundAssetId,
    plan: row.task.renderPlan,
    authoring: { briefText: row.task.briefText || "", prompt: row.task.prompt },
  });
  const response = await renderCover(new NextRequest(new URL("/api/cover/render", request.url), {
    method: "POST",
    headers: {
      Authorization: request.headers.get("authorization") || "",
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  }));
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || result.persisted !== true || result.cloudStored !== true
    || typeof result.assetId !== "string" || typeof result.historyRecordId !== "string" || typeof result.url !== "string"
    || !coverCompositionMatches(result, row.task.renderPlan, backgroundAssetId)) {
    const pending = await settle(userId, row, "delivery_pending", {
      backgroundAssetId,
      errorCode: typeof result.code === "string" ? result.code : "COVER_COMPOSITION_PENDING",
    });
    return { complete: false as const, terminal: isTerminalAttempt(pending), row: pending, result };
  }
  const completed = await settle(userId, row, "completed", {
    backgroundAssetId,
    resultAssetId: result.assetId,
    historyRecordId: result.historyRecordId,
  });
  if (completed.state !== "completed") {
    return { complete: false as const, terminal: true as const, row: completed, result };
  }
  if (completed.background_asset_id !== backgroundAssetId || completed.result_asset_id !== result.assetId
    || completed.history_record_id !== result.historyRecordId) {
    return { complete: true as const, terminal: true as const, row: completed,
      result: await completedCoverResult(request, userId, completed) };
  }
  return { complete: true as const, terminal: true as const, row: completed, result };
}

async function reconcile(request: NextRequest, userId: string, row: CoverAttemptRow) {
  if (row.state === "completed") return completedAttemptResponse(request, userId, row);
  if (row.state === "cancelled") return json({ success: true, ...terminalAttemptPayload(row) });
  const boundImage = await imageStore.get({ userId, clientIdempotencyKey: row.client_idempotency_key, clientTraceId: row.client_trace_id });
  const v2Provider = isV2ProviderResult(row, boundImage);
  if (v2Provider && boundImage && (COVER_ATTEMPT_ACTIVE_STATES.includes(row.state as typeof COVER_ATTEMPT_ACTIVE_STATES[number])
    || (row.state === "failed" && temporaryCodes.includes(row.error_code || "") && !row.result_asset_id && !row.history_record_id && !row.cancelled_at))) {
    return deliverV2ProviderResult(request, userId, row, boundImage);
  }
  const temporaryReceipt = coverGeneratedReceipt(boundImage, { userId, clientIdempotencyKey: row.client_idempotency_key });
  if (!v2Provider && temporaryReceipt && (COVER_ATTEMPT_ACTIVE_STATES.includes(row.state as typeof COVER_ATTEMPT_ACTIVE_STATES[number])
    || (row.state === "failed" && [COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(row.error_code || "")))) {
    if (row.state !== "failed") row = await settle(userId, row, "failed", { errorCode: COVER_TEMPORARY_DELIVERY_CODE });
    if (row.state === "failed" && [COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(row.error_code || "")) {
      return json({ success: true, completed: true, activeAttempt: null, ...temporaryReceipt, images: [],
        message: "底图生成已完成，费用收据已保留；临时封面仅原页面可用，刷新后无法恢复" });
    }
  }
  if (row.state === "cancelled" || row.state === "failed") {
    return json({ success: true, ...terminalAttemptPayload(row,
      row.state === "cancelled" ? "封面任务已终止，可以继续创建新任务" : undefined) });
  }
  const image = boundImage;
  if (image && row.state === "claimed") {
    const begun = await getSupabaseClient().rpc("begin_cover_generation_dispatch", {
      p_user_id: userId,
      p_client_idempotency_key: row.client_idempotency_key,
      p_client_trace_id: row.client_trace_id,
    });
    if (begun.error) throw begun.error;
    row = rpcRecord(begun.data) || row;
  }
  const rejection = image ? getImageRequestRejection(image) : null;
  if (rejection) {
    const failed = await settle(userId, row, "failed", { errorCode: rejection.code });
    if (failed.state === "cancelled") {
      return json({ success: true, ...terminalAttemptPayload(failed,
        "任务已终止；生成服务返回后不会继续封面排版") });
    }
    return json({ success: true, ...terminalAttemptPayload(failed,
      new ImageRequestRejectedError(rejection).message),
      state: "rejected", code: rejection.code, sameKeyCanResubmit: false });
  }
  let backgroundAssetId = row.background_asset_id || (image?.deliveryState === "delivered" ? image.deliveryAssetId : undefined);
  const checkpoint = image ? getImageProviderCheckpointState(image) : null;
  if (!backgroundAssetId && image && (image.state === "completed" || checkpoint?.hasCheckpoint)
    && checkpoint?.persistenceInProgress !== true) {
    const deliveryBody = JSON.stringify({
      ...row.generation_input,
      referenceImageUrls: [],
      resumeDeliveryOnly: true,
      clientIdempotencyKey: row.client_idempotency_key,
      clientTraceId: row.client_trace_id,
    });
    const deliveryResponse = await generateImage(new NextRequest(new URL("/api/image/generate", request.url), {
      method: "POST",
      headers: {
        Authorization: request.headers.get("authorization") || "",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(deliveryBody)),
      },
      body: deliveryBody,
    }));
    const delivery = await deliveryResponse.json().catch(() => ({})) as Record<string, unknown>;
    const deliveredImage = Array.isArray(delivery.images) ? delivery.images[0] as Record<string, unknown> | undefined : undefined;
    if (deliveryResponse.ok && delivery.success === true && delivery.status === "completed" && typeof deliveredImage?.assetId === "string") {
      backgroundAssetId = deliveredImage.assetId;
    }
  }
  if (backgroundAssetId) {
    if (row.task.renderPlan.planVersion === 2 && image?.state === "completed") await deliveryBinding(request, userId, row);
    const rendered = await renderDelivered(request, userId, row, backgroundAssetId);
    if (rendered.complete) return json({ success: true, activeAttempt: null, completed: true,
      backgroundAssetId, result: rendered.result });
    if (rendered.terminal) {
      return json({ success: true, ...terminalAttemptPayload(rendered.row,
        rendered.row.state === "cancelled" ? "任务已终止；不会继续封面排版" : undefined) });
    }
    return json({ success: true, activeAttempt: coverAttemptProjection(rendered.row), completed: false,
      message: "底图已保存，封面排版与历史仍在自动同步" });
  }
  return json({ success: true, activeAttempt: coverAttemptProjection(row), completed: false,
    imageState: image?.state || "not_found",
    message: row.state === "claimed" ? "封面任务已安全认领，尚未调用生图服务" : "原封面任务仍在后台核验，系统不会重复生图" });
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  try {
    const reconciled = await getSupabaseClient().rpc("reconcile_stale_cover_generation_attempts", {
      p_user_id: authorization.user.userId,
      p_stale_after_seconds: 600,
    });
    if (reconciled.error) throw reconciled.error;
    const requestedKeys = parseCoverAttemptKeys({
      clientIdempotencyKey: request.nextUrl.searchParams.get("clientIdempotencyKey"),
      clientTraceId: request.nextUrl.searchParams.get("clientTraceId"),
    });
    const row = requestedKeys
      ? await exactAttempt(authorization.user.userId, requestedKeys)
      : await activeAttempt(authorization.user.userId);
    if (!row) return json({ success: true, activeAttempt: null });
    return await reconcile(request, authorization.user.userId, row);
  } catch (error) {
    if (error instanceof CoverPrepareError || error instanceof CoverGeneratedExportError) return json({ error: error.message, code: error.code }, error.status);
    return json({ error: migrationUnavailable(error) ? "封面任务服务正在准备中，本次不会提交生图" : "封面任务状态暂时无法确认，请勿重复提交",
      code: migrationUnavailable(error) ? "COVER_ATTEMPT_MIGRATION_NOT_READY" : "COVER_ATTEMPT_STATUS_UNAVAILABLE" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  const maximumInputBytes = 8 * 1024 * 1024;
  if (Number(request.headers.get("content-length")) > maximumInputBytes) return json({ error: "封面任务参数过大" }, 413);
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "封面任务参数无效" }, 400);
  const userId = authorization.user.userId;

  try {
    if (body.action === "cancel") {
      const keys = parseCoverAttemptKeys(body);
      if (!keys) return json({ error: "封面终止参数无效" }, 400);
      const cancelled = await getSupabaseClient().rpc("cancel_cover_generation_attempt", {
        p_user_id: userId,
        p_client_idempotency_key: keys.clientIdempotencyKey,
        p_client_trace_id: keys.clientTraceId,
      });
      if (cancelled.error) throw cancelled.error;
      const row = rpcRecord(cancelled.data);
      if (!row) return json({ error: "封面任务不存在或无权终止" }, 404);
      return json({ success: true, ...terminalAttemptPayload(row,
        row.state === "cancelled" ? "任务已终止，当前编辑区已释放" : "任务已经结束，无需重复终止") });
    }

    if (body.action === "claim" || body.action === "adopt") {
      const claim = parseCoverAttemptClaim(body);
      const suppliedKeys = parseCoverAttemptKeys(body);
      if (!claim || (body.action === "adopt" && !suppliedKeys)) return json({ error: "封面任务安全快照无效" }, 400);
      const proposedKey = suppliedKeys?.clientIdempotencyKey || `cover_${randomUUID()}`;
      const proposedTrace = suppliedKeys?.clientTraceId || proposedKey;
      const existing = suppliedKeys ? await exactAttempt(userId, { clientIdempotencyKey: proposedKey, clientTraceId: proposedTrace }) : null;
      if (existing) {
        // Re-entering an original order is recovery, even when its caller has
        // lost browser tracking and still sends claim/adopt. Compare only the
        // immutable original snapshot; today's model price cannot revoke it.
        if (coverMaterialFingerprint(existing.task) !== coverMaterialFingerprint(claim.task)
          || !sameCoverGenerationInput(existing.generation_input, claim.generationInput)
          || existing.requires_reference_reupload !== (claim.referenceCount > 0)) {
          return json({ error: "这次认领与原封面任务快照不一致，已停止重入", code: "COVER_PREPARED_INPUT_CONFLICT" }, 409);
        }
        await validatePreparedCoverGeneration({ userId, task: existing.task, generationInput: existing.generation_input,
          clientIdempotencyKey: proposedKey, clientTraceId: proposedTrace, requestUrl: request.url, phase: "delivery" });
        return await reconcile(request, userId, existing);
      }
      await validatePreparedCoverGeneration({ userId, task: claim.task, generationInput: claim.generationInput,
        clientIdempotencyKey: proposedKey, clientTraceId: proposedTrace, requestUrl: request.url });
      const result = await getSupabaseClient().rpc("claim_cover_generation_attempt", {
        p_user_id: userId,
        p_client_idempotency_key: proposedKey,
        p_client_trace_id: proposedTrace,
        p_task: claim.task,
        p_generation_input: claim.generationInput,
        p_requires_reference_reupload: claim.referenceCount > 0,
      });
      if (result.error) throw result.error;
      let row = rpcRecord(result.data);
      if (!row) throw new Error("COVER_ATTEMPT_CLAIM_INVALID");

      if (body.action === "adopt" && row.client_idempotency_key === proposedKey) {
        const existingImage = await imageStore.get({ userId, clientIdempotencyKey: proposedKey, clientTraceId: proposedTrace });
        if (existingImage && row.state === "claimed") {
          const begun = await getSupabaseClient().rpc("begin_cover_generation_dispatch", {
            p_user_id: userId, p_client_idempotency_key: proposedKey, p_client_trace_id: proposedTrace,
          });
          if (begun.error) throw begun.error;
          row = rpcRecord(begun.data) || row;
        }
      }
      return await reconcile(request, userId, row);
    }

    if (body.action !== "dispatch") return json({ error: "封面任务动作无效" }, 400);
    const keys = parseCoverAttemptKeys(body);
    const payload = parseCoverDispatchPayload(body.payload);
    if (!keys || !payload) return json({ error: "封面首次提交参数无效" }, 400);
    const row = await exactAttempt(userId, keys);
    if (!row) return json({ error: "封面任务认领记录不存在，已停止提交" }, 409);
    if (!sameCoverGenerationInput(row.generation_input, payload.safe)
      || row.requires_reference_reupload !== (payload.references.length > 0)) {
      return json({ error: "封面首次提交与已认领快照不一致，已停止提交" }, 409);
    }
    if (row.task.renderPlan.planVersion === 2 && row.state !== "claimed") return await reconcile(request, userId, row);
    const preparedReferences = await validatePreparedCoverGeneration({ userId, task: row.task, generationInput: payload.safe,
      ...keys, requestUrl: request.url, resolveReferences: true });
    const begun = await getSupabaseClient().rpc("begin_cover_generation_dispatch", {
      p_user_id: userId,
      p_client_idempotency_key: keys.clientIdempotencyKey,
      p_client_trace_id: keys.clientTraceId,
    });
    if (begun.error) throw begun.error;
    const begunRoot = Array.isArray(begun.data) ? begun.data[0] : begun.data;
    const acquired = Boolean((begunRoot as Record<string, unknown> | null)?.acquired);
    const dispatched = rpcRecord(begun.data) || row;
    if (!acquired && dispatched.state === "failed") return await reconcile(request, userId, dispatched);
    if (!acquired) return dispatched.state === "cancelled"
      ? json({ success: true, ...terminalAttemptPayload(dispatched) })
      : json({ success: true, completed: false, activeAttempt: coverAttemptProjection(dispatched),
        message: "原封面任务已提交，系统不会再次调用生图服务" }, 202);

    const generationBody = JSON.stringify({
      ...payload.safe,
      referenceImageUrls: preparedReferences || payload.references,
      clientIdempotencyKey: keys.clientIdempotencyKey,
      clientTraceId: keys.clientTraceId,
    });
    const generatedResponse = await generateImage(new NextRequest(new URL("/api/image/generate", request.url), {
      method: "POST",
      headers: {
        Authorization: request.headers.get("authorization") || "",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(generationBody)),
      },
      body: generationBody,
    }));
    const generated = await generatedResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!generatedResponse.ok || generated.success !== true || generated.status !== "completed") {
      let latest = await exactAttempt(userId, keys);
      if (latest && isTerminalAttempt(latest)) {
        return json({ ...(latest.state === "cancelled" ? { success: true } : coverPublicImageFailure(generated, true)), ...terminalAttemptPayload(latest,
          latest.state === "cancelled" ? "任务已终止；生成服务返回后不会继续封面排版" : undefined) },
        latest.state === "cancelled" ? 200 : generatedResponse.status);
      }
      if (isConfirmedTerminalImageFailure(generated)) {
        const settled = await settle(userId, latest || dispatched, "failed", {
          errorCode: typeof generated.code === "string" ? generated.code : "IMAGE_REQUEST_REJECTED",
        });
        latest = await exactAttempt(userId, keys) || settled;
        return json({ ...coverPublicImageFailure(generated, true), ...terminalAttemptPayload(latest) }, generatedResponse.status);
      }
      return json(coverPublicImageFailure(generated), generatedResponse.status);
    }
    const latest = await exactAttempt(userId, keys);
    if (latest?.state === "completed") return await completedAttemptResponse(request, userId, latest);
    const temporaryTerminal = latest?.state === "failed"
      && [COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(latest.error_code || "");
    if (latest && isTerminalAttempt(latest) && !temporaryTerminal) {
      return json({ success: true, ...terminalAttemptPayload(latest,
        latest.state === "cancelled" ? "任务已终止；生成返回后不会继续封面排版" : undefined) });
    }
    const image = Array.isArray(generated.images) ? generated.images[0] as Record<string, unknown> | undefined : undefined;
    const completedImage = await imageStore.get({ userId, clientIdempotencyKey: keys.clientIdempotencyKey, clientTraceId: keys.clientTraceId });
    if (completedImage && isV2ProviderResult(latest || dispatched, completedImage)) {
      return await reconcile(request, userId, latest || dispatched);
    }
    const receipt = coverGeneratedReceipt(completedImage, { userId, clientIdempotencyKey: keys.clientIdempotencyKey });
    if (receipt && completedImage) {
      let delivery: Record<string, unknown> = { ...receipt, images: [], message: "底图生成已完成；封面排版暂不可用，原费用收据已保留，请勿重复生成" };
      let outcomeCode = COVER_TEMPORARY_COMPOSITION_ERROR;
      try {
        delivery = { ...await composeGeneratedCover({ userId, record: completedImage, response: generated, plan: dispatched.task.renderPlan }),
          message: "封面已完成；仅当前页面可预览下载，请及时下载保存" };
        outcomeCode = COVER_TEMPORARY_DELIVERY_CODE;
      } catch { /* A composition problem does not invalidate or regenerate the completed paid image. */ }
      try {
        const settled = await settle(userId, dispatched, "failed", { errorCode: outcomeCode });
        if (settled.state !== "failed" || ![COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(settled.error_code || "")) return json({ success: true, ...terminalAttemptPayload(settled) });
      }
      catch {
        const acknowledged = await exactAttempt(userId, keys);
        if (!acknowledged || acknowledged.state !== "failed" || ![COVER_TEMPORARY_DELIVERY_CODE, COVER_TEMPORARY_COMPOSITION_ERROR].includes(acknowledged.error_code || "")) return json({ success: true, completed: true,
          ...delivery, activeAttempt: null, receiptAcknowledgementPending: true });
      }
      return json({ success: true, completed: true, activeAttempt: null, ...delivery });
    }
    if (!image || typeof image.assetId !== "string") return json({ success: true, completed: false,
      activeAttempt: coverAttemptProjection(dispatched), message: "底图交付仍在核验，系统不会重复生图" }, 202);
    const rendered = await renderDelivered(request, userId, dispatched, image.assetId);
    if (!rendered.complete) return rendered.terminal
      ? json({ success: true, ...terminalAttemptPayload(rendered.row,
        rendered.row.state === "cancelled" ? "任务已终止；底图返回后不会继续封面排版" : undefined) })
      : json({ success: true, completed: false, activeAttempt: coverAttemptProjection(rendered.row),
        message: "底图已完成，封面排版与历史正在自动同步" }, 202);
    return json({ success: true, completed: true, traceId: generated.traceId, operationId: generated.operationId,
      backgroundAssetId: image.assetId, result: rendered.result });
  } catch (error) {
    if (error instanceof CoverPrepareError || error instanceof CoverGeneratedExportError) return json({ error: error.message, code: error.code }, error.status);
    console.error("[Cover/Attempt] request failed:", error instanceof Error ? error.name : "UnknownError");
    return json({ error: migrationUnavailable(error) ? "封面任务服务正在准备中，本次不会提交生图" : "封面任务状态暂时无法确认，请勿重复提交",
      code: migrationUnavailable(error) ? "COVER_ATTEMPT_MIGRATION_NOT_READY" : "COVER_ATTEMPT_UNAVAILABLE" }, 503);
  }
}
