import { NextRequest } from "next/server";
import { GET as readAttempt, POST as writeAttempt } from "@/app/api/cover/attempt/route";
import { GET as renderReadiness, POST as renderOriginal } from "@/app/api/cover/render/route";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import type { CoverAttemptGenerationInput, CoverAttemptTaskSnapshot } from "@/lib/cover-durable-attempt";
import type { CoverReviewExecutionDto, CoverReviewExecutionStatus, CoverReviewSafeTask } from "@/lib/cover-review-contract";
import { coverTextRendering } from "@/lib/cover-composition";
import { validatePreparedCoverGeneration } from "./cover-prepared-generation";
import { loadOwnedReviewOperation, reviewInternalRequest, CoverReviewError, rethrowCoverReviewConfirmationError } from "./cover-review-operations";
import { projectCoverReviewSafeTask } from "./cover-review-projection";
import { object } from "./cover-prepare-service";
import type { CoverPrepareRow } from "./cover-prepare-repository";
import { coverMaterialFingerprint } from "./cover-prepare-repository";
import { coverPublicImageIssue } from "./cover-public-error";
import { assertNoUncertainCoverReviewSibling } from "./cover-review-generation-fence";

function safeTask(row: CoverPrepareRow, receipt?: Record<string, unknown>): CoverReviewSafeTask {
  const task = projectCoverReviewSafeTask(row.result?.task, { receipt, prepareOperationId: row.id,
    imageOrigin: row.preparation.route === "original_layout" ? "original" : "generated" });
  if (!task) throw new CoverReviewError("COVER_CONFIRMATION_TASK_INVALID", "原确认任务暂时无法核对，请保留原单查询", 503);
  return task;
}
function safeReceipt(value: unknown) {
  const source = object(value);
  const fields = ["status", "persisted", "cloudStored", "assetId", "key", "url", "historyRecordId", "sourceAssetId", "sourceWidth", "sourceHeight",
    "width", "height", "planVersion", "taskNo", "createdAt", "historyVisible", "nativeUpscaleApplied", "requestedText", "textVerification", "renderedText", "generatedOverlayLayout", "layoutGeometry", "textGeometry"];
  return Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
function executionDto(row: CoverPrepareRow, payload: Record<string, unknown>, httpOkay = true, fallbackStatus: "confirmed" | "unknown" = "confirmed"): CoverReviewExecutionDto {
  const active = object(payload.activeAttempt), terminal = object(payload.terminalAttempt);
  const receipt = object(payload.result);
  const rawState = String(active.state || terminal.state || payload.state || "");
  const imageUnknown = payload.imageState === "failed_unknown" || payload.imageState === "unknown";
  const completed = httpOkay && payload.completed === true && receipt.cloudStored === true && typeof receipt.assetId === "string" && typeof receipt.historyRecordId === "string";
  const status: CoverReviewExecutionStatus = completed ? "completed" : rawState === "claimed" ? "claimed"
    : rawState === "delivery_pending" ? imageUnknown ? "unknown" : "delivery_pending" : rawState === "dispatched" ? imageUnknown ? "unknown" : "submitted"
      : ["failed", "cancelled"].includes(rawState) ? "failed" : !httpOkay || payload.success === false ? "unknown" : fallbackStatus;
  const task = safeTask(row, completed ? receipt : undefined);
  if (!completed) task.status = status === "failed" ? rawState === "cancelled" ? "cancelled" : "failed" : status === "unknown" ? "unknown" : "running";
  const publicIssue = coverPublicImageIssue(payload);
  return { success: httpOkay, confirmationId: row.id, status, task, canPoll: ["submitted", "delivery_pending", "unknown"].includes(status),
    ...(rawState && active.state ? { activeAttempt: { id: row.id, state: rawState, task,
      ...(typeof active.updatedAt === "number" ? { updatedAt: new Date(active.updatedAt).toISOString() } : {}) } } : {}),
    ...(completed ? { result: safeReceipt(receipt) } : {}),
    ...(!httpOkay || status === "failed" || status === "unknown" ? { issue: { ...publicIssue, action: "query_original" as const } } : {}) };
}
function exactActive(row: CoverPrepareRow, payload: Record<string, unknown>) {
  const active = object(payload.activeAttempt); const task = object(active.task);
  return active.clientIdempotencyKey === `coverwb_${row.id}` && active.clientTraceId === `coverwb_${row.id}` && task.prepareOperationId === row.id && task.id === object(row.result?.task).id;
}
async function parseInternal(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CoverReviewError("COVER_ORIGINAL_RESULT_UNKNOWN", "原任务返回尚未确认，请查询原单；不会重复提交", 503);
  return object(body);
}
async function originalReceipt(row: CoverPrepareRow) {
  const db = getSupabaseClient();
  // record_cover_composition strips _authoring into authoring_context. Only the
  // small render plan enters this exact JSONB filter, never the full user text.
  const saved = await db.from("cover_generation_history").select("user_id,asset_id,history_record_id,background_asset_id,plan,output_width,output_height,source_width,source_height,task_no,created_at")
    .eq("user_id", row.user_id).eq("background_asset_id", row.preparation.sourceAssetId)
    .eq("plan", JSON.stringify(row.result?.renderPlan)).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (saved.error) throw new CoverReviewError("COVER_ORIGINAL_SAVE_UNKNOWN", "原图保存状态暂时无法确认，请查询原任务", 503);
  if (!saved.data) return null;
  const history = object(saved.data);
  const output = object(object(row.result?.renderPlan).outputSpec);
  if (history.user_id !== row.user_id || history.background_asset_id !== row.preparation.sourceAssetId
    || coverMaterialFingerprint(history.plan) !== coverMaterialFingerprint(row.result?.renderPlan)
    || typeof history.history_record_id !== "string" || !history.history_record_id
    || ![history.output_width, history.output_height, history.source_width, history.source_height, history.task_no].every(value => Number.isSafeInteger(value) && Number(value) > 0)
    || history.output_width !== output.width || history.output_height !== output.height) {
    throw new CoverReviewError("COVER_ORIGINAL_SAVE_UNKNOWN", "原图保存记录与确认方案尚未核对，请查询原任务", 503);
  }
  const file = await db.from("user_files").select("id,user_id,storage_key,storage_provider,content_type,file_size").eq("user_id", row.user_id).eq("id", history.asset_id).eq("file_category", "image").maybeSingle();
  if (file.error || !file.data) throw new CoverReviewError("COVER_ORIGINAL_SAVE_UNKNOWN", "原图文件保存凭据尚未确认，请查询原任务", 503);
  if (file.data.id !== history.asset_id || file.data.user_id !== row.user_id || file.data.storage_provider !== "tencent_cos"
    || file.data.content_type !== "image/png" || !file.data.storage_key || !Number.isSafeInteger(Number(file.data.file_size)) || Number(file.data.file_size) <= 0) {
    throw new CoverReviewError("COVER_ORIGINAL_SAVE_UNKNOWN", "原图文件与账号归属尚未核对，请查询原任务", 503);
  }
  return { status: "completed", persisted: true, cloudStored: true, assetId: history.asset_id, key: file.data.storage_key,
    url: `/api/storage/files/${encodeURIComponent(String(history.asset_id))}/content`, historyRecordId: history.history_record_id,
    sourceAssetId: history.background_asset_id, width: history.output_width, height: history.output_height,
    sourceWidth: history.source_width, sourceHeight: history.source_height, taskNo: history.task_no, createdAt: history.created_at };
}

/** GET performs only original-order reconciliation / persistence recovery. */
export async function executeCoverReviewOperation(request: NextRequest, userId: string, operationId: string, dispatch: boolean): Promise<CoverReviewExecutionDto> {
  const row = await loadOwnedReviewOperation(userId, operationId);
  const confirmation = row.preparation.workflowVersion === 3 && row.preparation.recordKind === "confirmation";
  if (row.state !== "plan_ready" || !row.result?.task || dispatch && !confirmation) {
    throw new CoverReviewError("COVER_CONFIRMATION_REQUIRED", "请先审核并确认方案，原已提交任务只能查询");
  }
  if (row.preparation.route === "original_layout") {
    const previous = await originalReceipt(row);
    if (previous) return executionDto(row, { success: true, completed: true, result: previous });
    if (!dispatch) return executionDto(row, { success: true });
    const rendered = await renderOriginal(reviewInternalRequest(request, "/api/cover/render", "POST", {
      sourceAssetId: row.preparation.sourceAssetId, plan: row.result.renderPlan, authoring: { briefText: row.materials.text, prompt: "" },
    }));
    const payload = await parseInternal(rendered);
    return executionDto(row, rendered.ok && payload.cloudStored === true ? { success: true, completed: true, result: payload } : payload, rendered.ok);
  }
  if (dispatch && confirmation) {
    try { await assertNoUncertainCoverReviewSibling(request, userId, String(row.preparation.originalAnalysisOperationId || ""), row.id); }
    catch (error) { rethrowCoverReviewConfirmationError(error); }
  }
  const identity = { clientIdempotencyKey: `coverwb_${row.id}`, clientTraceId: `coverwb_${row.id}` };
  const query = new URLSearchParams(identity);
  const currentResponse = await readAttempt(reviewInternalRequest(request, `/api/cover/attempt?${query}`, "GET"));
  const current = await parseInternal(currentResponse);
  const hasReadShape = current.success === true && (Object.hasOwn(current, "activeAttempt")
    || current.completed === true || Boolean(current.terminalAttempt));
  if (!hasReadShape || current.completed === true && (!object(current.result).cloudStored
    || typeof object(current.result).assetId !== "string" || typeof object(current.result).historyRecordId !== "string")) {
    return executionDto(row, {}, false, "unknown");
  }
  if (!currentResponse.ok || !dispatch || current.completed === true || current.terminalAttempt) return executionDto(row, current, currentResponse.ok);
  let active = current;
  if (!current.activeAttempt) {
    const result = await writeAttempt(reviewInternalRequest(request, "/api/cover/attempt", "POST", {
      action: "claim", ...identity, task: row.result.task, payload: row.result.generationInput,
      referenceCount: row.materials.imageMode === "compose" ? row.materials.assets.length : row.materials.assets.filter(asset => asset.role === "style_reference").length,
    }));
    active = await parseInternal(result);
    if (!result.ok || active.completed === true || active.terminalAttempt) return executionDto(row, active, result.ok);
    if (!active.activeAttempt) return executionDto(row, {}, false, "unknown");
  }
  if (!exactActive(row, active)) {
    return { ...executionDto(row, {}, true), issue: { code: "COVER_OTHER_ACTIVE_ATTEMPT", message: "账号中还有另一条封面任务，请先查询原任务；本次没有提交生成", action: "query_original" } };
  }
  if (object(active.activeAttempt).state !== "claimed") return executionDto(row, active);
  const textMode = coverTextRendering((row.result.task as CoverAttemptTaskSnapshot).renderPlan).mode;
  const readiness = await renderReadiness(reviewInternalRequest(request, `/api/cover/render${textMode === "native" ? "?textMode=native" : ""}`, "GET"));
  const ready = await parseInternal(readiness);
  if (!readiness.ok || ready.ready !== true) return { ...executionDto(row, active), issue: { code: "COVER_RENDER_NOT_READY", message: "封面保存服务尚未就绪，本次未提交生图；请稍后明确继续原确认方案", action: "query_original" } };
  const references = await validatePreparedCoverGeneration({ userId, task: row.result.task as CoverAttemptTaskSnapshot,
    generationInput: row.result.generationInput as CoverAttemptGenerationInput, ...identity, requestUrl: request.url, resolveReferences: true });
  const dispatched = await writeAttempt(reviewInternalRequest(request, "/api/cover/attempt", "POST", { action: "dispatch", ...identity,
    payload: { ...object(row.result.generationInput), referenceImageUrls: references || [] } }));
  const payload = await parseInternal(dispatched);
  // A missing/unknown dispatch receipt is never followed by another dispatch.
  return executionDto(row, payload, dispatched.ok, "unknown");
}
