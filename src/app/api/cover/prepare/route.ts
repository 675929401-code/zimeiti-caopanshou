import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeCurrentApiUser } from "@/lib/current-api-user";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { fingerprintLlmRequest } from "@/lib/llm-request-idempotency";
import { readCoverRequestJson, CoverRequestBodyError } from "@/lib/server/cover-request-body";
// Preserve the existing authenticated, idempotent and billed gateway handler.
// A direct call also keeps this private workflow independent of the public host.
// eslint-disable-next-line no-restricted-imports
import { POST as handleLlmRequest } from "@/app/api/llm/route";
import { parseCoverPrepareInput, CoverWorkbenchContractError } from "@/lib/cover-workbench-contract";
import {
  CoverPrepareError, coverMaterialFingerprint, loadCoverPreparation, claimCoverAnalysis, finishCoverAnalysis, bindCoverAnalysisRequest,
  finishRecoveredCoverAnalysis,
  type CoverPrepareRow,
} from "@/lib/server/cover-prepare-repository";
import {
  assertCoverPreparationCurrent, assertCoverStyleReleaseCurrent, coverAnalysisRequest, completeCoverAnalysisPlan, extractCoverLlmJson, readCoverAnalysisBilling, object,
} from "@/lib/server/cover-prepare-service";
import { projectCoverReviewOperation } from "@/lib/server/cover-review-projection";
import { canRecoverPaidCoverAnalysis, verifyCoverAnalysisReplay, COVER_ANALYSIS_RECOVERY_VERSION, type VerifiedCoverAnalysisReplay } from "@/lib/server/cover-analysis-recovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const schema = z.object({
  action: z.enum(["prepare", "analyze", "get"]), materials: z.unknown().optional(),
  operationId: z.string().uuid().optional(), clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u).optional(),
  consent: z.object({ analysis: z.literal(true), image: z.literal(true).optional() }).strict().optional(),
}).strict();
const json = (value: unknown, status = 200) => NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });

function analysisIssue(code: string, details: { fieldPath?: string; evidenceId?: string } = {}, recoverable = false) {
  const entry = code === "COVER_MATERIAL_ROLE_CONFLICT" ? { category: "materials", message: "同一张图片的用途存在冲突，请明确保留外观、场景还是参考风格。" }
    : code.startsWith("COVER_MATERIAL_USAGE_") ? { category: "materials", message: "图片用途未能与当前材料和原文完整对应。" }
    : code === "ANALYSIS_EVIDENCE_INVALID" ? { category: "source_reference", message: "分析引用未能准确对应原文。" }
    : code === "ANALYSIS_UNGROUNDED_CLAIM" ? { category: "unsupported_claim", message: "分析中出现了缺少来源的数字、单位或承诺。" }
      : ["ANALYSIS_SCHEMA_INVALID", "COVER_ANALYSIS_FORMAT_INVALID", "COVER_ANALYSIS_CONTRACT_INVALID"].includes(code)
        ? { category: "format", message: "模型返回的分析格式未通过核验。" }
        : code === "ANALYSIS_LOCKED_TITLE_CHANGED" ? { category: "locked_title", message: "分析改动了已确定的标题，已停止制作。" }
          : { category: "upstream", message: "原分析结果暂时未能通过核验。" };
  return { code, ...entry, ...details, canRecoverFromReceipt: recoverable,
    action: recoverable || entry.category === "upstream" ? "query_original" : "edit_materials",
    message: `${entry.message}${recoverable ? "请先核验原结果，不会再次调用分析模型。" : "请核对材料后调整；本次原回复和费用记录已保留。"}` };
}

function project(row: CoverPrepareRow) {
  return projectCoverReviewOperation(row);
}

async function exact(userId: string, operationId?: string, clientRequestId?: string) {
  if (operationId) return loadCoverPreparation(userId, operationId);
  if (clientRequestId) {
    const result = await getSupabaseClient().from("cover_prepare_operations").select("*")
      .eq("user_id", userId).eq("client_request_id", clientRequestId).maybeSingle();
    if (result.error) throw new CoverPrepareError("COVER_PREPARE_STORAGE_UNAVAILABLE", "封面任务暂时无法读取", 503);
    return result.data as CoverPrepareRow | null;
  }
  return loadCoverPreparation(userId);
}

/** Reads the original child only; recovery never calls a provider. */
async function reconcile(row: CoverPrepareRow) {
  const paidRecovery = canRecoverPaidCoverAnalysis(row);
  if (row.state !== "analyzing" && row.state !== "unknown" && !paidRecovery) return row;
  const result = await getSupabaseClient().from("llm_request_attempts")
    .select("record_id,user_id,client_request_id,state,payload_fingerprint,attempt_no,http_status,response_body,response_fingerprint,result_reference,error_code,updated_at")
    .eq("user_id", row.user_id).eq("client_request_id", row.analysis_request_id).maybeSingle();
  if (result.error) return row;
  const child = object(result.data);
  if (child.state === "succeeded" && typeof child.response_body === "string") {
    const replay = verifyCoverAnalysisReplay(row, child);
    if (!replay) {
      if (paidRecovery) return { ...row, result: { ...row.result,
        analysisIssue: { ...analysisIssue("COVER_ANALYSIS_REPLAY_INVALID"), action: "query_original",
          message: "原分析回执未通过校验，已停止恢复。请保留原任务核查；系统不会重新调用模型。" } } };
      return finishCoverAnalysis(row, { state: "unknown", error_code: "COVER_ANALYSIS_REPLAY_INVALID" });
    }
    return acceptResponse(row, replay.payload, replay.recordId, paidRecovery ? replay : undefined);
  }
  if (paidRecovery) return row;
  if (["failed_unknown", "reconciliation_required"].includes(String(child.state))) {
    return finishCoverAnalysis(row, { state: "unknown", error_code: "COVER_ANALYSIS_RESULT_UNKNOWN", analysis_attempt_id: String(child.record_id || "") });
  }
  if (child.state === "failed") return finishCoverAnalysis(row, { state: "failed", error_code: String(child.error_code || "COVER_ANALYSIS_FAILED") });
  if (Date.now() - Date.parse(row.updated_at) > 5 * 60_000) return finishCoverAnalysis(row, { state: "unknown", error_code: "COVER_ANALYSIS_RESULT_UNKNOWN" });
  return row;
}

async function acceptResponse(row: CoverPrepareRow, payload: unknown, attemptId: string, replay?: VerifiedCoverAnalysisReplay) {
  let billing: Record<string, unknown> = {};
  try {
    billing = readCoverAnalysisBilling(payload);
    const result = completeCoverAnalysisPlan(row, extractCoverLlmJson(payload));
    if (replay && row.state === "failed" && object(result.analysis).status === "ready") {
      return await finishRecoveredCoverAnalysis(row, { ...result, analysisRecovery: { schemaVersion: COVER_ANALYSIS_RECOVERY_VERSION,
        childRecordId: replay.recordId, childResponseFingerprint: replay.responseFingerprint, originalFailureCode: row.error_code,
        reusedPaidResponse: true, newAnalysisCalls: 0 } }, replay);
    }
    if (replay && row.state === "failed") return finishCoverAnalysis(row, { state: "failed", result: { ...result,
      analysisRecovery: { schemaVersion: COVER_ANALYSIS_RECOVERY_VERSION, childRecordId: replay.recordId,
        childResponseFingerprint: replay.responseFingerprint, reusedPaidResponse: true, newAnalysisCalls: 0, outcome: "not_recoverable" },
      analysisIssue: { category: "materials", action: "edit_materials", canRecoverFromReceipt: false,
        message: String(object(result.analysis).missingInformation ? (object(result.analysis).missingInformation as unknown[])[0] : "请补充材料后再继续。") } } });
    return await finishCoverAnalysis(row, { state: object(result.analysis).status === "needs_input" ? "needs_input" : "plan_ready",
      result, billing, analysis_attempt_id: attemptId, error_code: null });
  } catch (error) {
    const unknown = error instanceof CoverPrepareError && error.code === "COVER_ANALYSIS_BILLING_UNKNOWN";
    const code = error instanceof CoverPrepareError || error instanceof CoverWorkbenchContractError ? error.code : "COVER_ANALYSIS_CONTRACT_INVALID";
    const details = error instanceof CoverWorkbenchContractError ? error.details : error instanceof z.ZodError ? { fieldPath: error.issues[0]?.path.map(String).join(".") } : {};
    return finishCoverAnalysis(row, { state: unknown ? "unknown" : "failed", billing: replay ? row.billing : Object.keys(billing).length ? billing : row.billing,
      result: { ...row.result, analysisIssue: analysisIssue(code, details), ...(replay ? { analysisRecovery: {
        schemaVersion: COVER_ANALYSIS_RECOVERY_VERSION, childRecordId: replay.recordId, childResponseFingerprint: replay.responseFingerprint,
        reusedPaidResponse: true, newAnalysisCalls: 0, outcome: "not_recoverable" } } : {}) },
      analysis_attempt_id: attemptId, error_code: code });
  }
}

function failure(error: unknown) {
  if (error instanceof CoverRequestBodyError) return json({ success: false, error: error.message, code: "COVER_INPUT_INVALID" }, error.status);
  if (error instanceof CoverPrepareError) return json({ success: false, error: error.message, code: error.code,
    ...(error.code === "COVER_PREPARATION_STALE" ? { reprepareRequired: true } : {}) }, error.status);
  if (error instanceof CoverWorkbenchContractError) return json({ success: false, error: error.message, code: error.code }, 422);
  if (error instanceof z.ZodError) return json({ success: false, error: "封面材料或操作参数不完整，请检查后再提交", code: "COVER_INPUT_INVALID" }, 422);
  return json({ success: false, error: "封面任务状态暂时无法确认，请查询原任务，避免重复提交", code: "COVER_PREPARE_UNAVAILABLE" }, 503);
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  try {
    const id = request.nextUrl.searchParams.get("operationId") || undefined;
    const key = request.nextUrl.searchParams.get("clientRequestId") || undefined;
    if (id) z.string().uuid().parse(id);
    if (key) z.string().regex(/^[A-Za-z0-9_-]{8,128}$/u).parse(key);
    const row = await exact(authorization.user.userId, id, key);
    return row ? json(project(await reconcile(row))) : json({ success: true, operationId: null, status: "empty" });
  } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest) {
  const authorization = await authorizeCurrentApiUser(request);
  if (!authorization.ok) return authorization.response;
  try {
    const body = schema.parse(await readCoverRequestJson(request, 100_000));
    if (body.action === "prepare") {
      const materials = parseCoverPrepareInput(body.materials);
      // A replay reads the frozen operation before consulting a changing model
      // catalog. Recovery must not depend on today's availability or pricing.
      const existing = await exact(authorization.user.userId, undefined, materials.clientRequestId);
      if (existing) {
        if (existing.material_fingerprint !== coverMaterialFingerprint(materials)) {
          throw new CoverPrepareError("COVER_MATERIAL_CONFLICT", "这份材料已经更改，请创建新的封面任务");
        }
        return json(project(await reconcile(existing)));
      }
      throw new CoverPrepareError("COVER_REVIEW_WORKFLOW_REQUIRED", "请使用新版封面工作台，先拆解内容并确认方案后再生成");
    }
    let row = await exact(authorization.user.userId, body.operationId, body.clientRequestId);
    if (!row) return json({ success: false, error: "封面任务不存在或不属于当前账号", code: "COVER_OPERATION_NOT_FOUND" }, 404);
    if (body.action === "get") return json(project(await reconcile(row)));
    if (row.preparation.recordKind === "confirmation") throw new CoverPrepareError("COVER_CONFIRMATION_ANALYSIS_FORBIDDEN", "已确认方案不能再次调用分析，请查询原任务");
    if (row.state !== "prepared") return json(project(await reconcile(row)), row.state === "analyzing" ? 202 : 200);
    if (row.preparation.workflowVersion !== 3) throw new CoverPrepareError("COVER_REVIEW_WORKFLOW_REQUIRED", "未收费的旧准备请转到新版工作台；已有收费结果仍可查询原单");
    await assertCoverStyleReleaseCurrent(row);
    assertCoverPreparationCurrent(row);
    if (!body.consent || body.consent.image) return json({ success: false, error: "请单独确认本次文案分析费用，图片费用将在审核后确认", code: "COVER_COST_CONFIRMATION_REQUIRED" }, 409);
    const claimed = await claimCoverAnalysis(row, { ...body.consent, at: new Date().toISOString(), quote: row.preparation.quote });
    if (!claimed) return json(project(await exact(authorization.user.userId, row.id) || row), 202);
    row = claimed;
    let llmDispatchStarted = false;
    try {
      if (typeof row.preparation.reuseAnalysisOperationId === "string") {
        const reusable = await loadCoverPreparation(row.user_id, row.preparation.reuseAnalysisOperationId);
        if (!reusable?.result || reusable.state !== "plan_ready" || reusable.preparation.contentFingerprint !== (row.preparation.reuseAnalysisContentFingerprint || row.preparation.contentFingerprint)
          || reusable.preparation.promptDependenciesFingerprint !== row.preparation.promptDependenciesFingerprint) {
          throw new CoverPrepareError("COVER_ANALYSIS_REUSE_UNAVAILABLE", "原内容分析暂时无法读取，本次不会重新调用模型", 503);
        }
        const result = completeCoverAnalysisPlan(row, { analysis: reusable.result.analysis, visualObservations: reusable.result.visualObservations || [] });
        return json(project(await finishCoverAnalysis(row, { state: "plan_ready", result,
          billing: { credits_charged: 0, reused_from_operation_id: reusable.id } })));
      }
      const messages = await coverAnalysisRequest(row);
      // Asset loading can take time. Recheck the publication after that work,
      // immediately before binding the first paid dispatch. Recovery of an
      // already claimed historical attempt never enters this branch again.
      await assertCoverStyleReleaseCurrent(row);
      const analysisModel = object(object(row.preparation.quote).analysis);
      const llmBody = { cover_operation_id: row.id, system_prompt: messages.find(message => message.role === "system")?.content,
        messages, stream: false, response_format: "json_object", temperature: 0.4, max_reply_tokens: 6000,
        timeout: 180, agentName: "封面内容分析", modelId: analysisModel.modelId, model_overridden: true, client_request_id: row.analysis_request_id };
      row = await bindCoverAnalysisRequest(row, fingerprintLlmRequest(Object.fromEntries(Object.entries(llmBody).filter(([key]) => key !== "client_request_id"))));
      llmDispatchStarted = true;
      const response = await handleLlmRequest(new NextRequest(new URL("/api/llm", request.url), {
        method: "POST", signal: AbortSignal.timeout(240_000),
        headers: { Authorization: request.headers.get("authorization") || "", "Content-Type": "application/json", "Idempotency-Key": row.analysis_request_id },
        body: JSON.stringify(llmBody),
      }));
      const payload = await response.json().catch(() => ({}));
      const attemptId = response.headers.get("x-llm-attempt-id") || "";
      if (response.ok) return json(project(await acceptResponse(row, payload, attemptId)));
      const inProgress = object(payload).code === "LLM_ATTEMPT_IN_PROGRESS";
      if (inProgress) return json(project(row), 202);
      const safe = response.headers.get("x-llm-retry-safe") === "true";
      const updated = await finishCoverAnalysis(row, { state: safe ? "failed" : "unknown", analysis_attempt_id: attemptId,
        error_code: safe ? String(object(payload).code || "COVER_ANALYSIS_FAILED") : "COVER_ANALYSIS_RESULT_UNKNOWN" });
      return json(project(updated));
    } catch (error) {
      if (!llmDispatchStarted && error instanceof CoverPrepareError && error.code === "COVER_PREPARATION_STALE") {
        await finishCoverAnalysis(row, { state: "failed", error_code: error.code, billing: { credits_charged: 0, operation_id: null } });
        return failure(error);
      }
      if (!llmDispatchStarted) return json(project(await finishCoverAnalysis(row, { state: "failed",
        error_code: "COVER_ANALYSIS_PREPARATION_FAILED", billing: { credits_charged: 0, operation_id: null } })));
      const recovered = await reconcile(row);
      if (recovered.state !== "analyzing") return json(project(recovered));
      return json(project(await finishCoverAnalysis(row, { state: "unknown", error_code: "COVER_ANALYSIS_RESULT_UNKNOWN" })));
    }
  } catch (error) { return failure(error); }
}
