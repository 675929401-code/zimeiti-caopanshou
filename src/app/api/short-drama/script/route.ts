import {
  GENERAL_SCRIPT_CONTRACT_VERSION,
  GENERAL_SCRIPT_PROFILE_VERSION,
  GeneralScriptContractError,
  parseGeneralScriptRequest,
  parseGeneralScriptResult,
  validateGeneralScriptResultForRequest,
  type GeneralScriptApiError,
  type GeneralScriptApiSuccess,
  type GeneralScriptResult,
} from "@/lib/short-drama/general-script-contract";
import { createGeneralScriptFixture } from "@/lib/short-drama/general-script-fixtures";
import {
  extractUpstreamError,
  bindGeneralScriptRequestSettings,
  parseGeneralScriptLlmPayload,
} from "@/lib/short-drama/general-script-llm";
import {
  GeneralScriptHistoryError,
  GeneralScriptHistoryRepository,
  normalizeGeneralScriptHistorySurface,
} from "@/lib/short-drama/general-script-history";
import {
  buildGeneralScriptUserPrompt,
  getGeneralScriptPromptProfile,
} from "@/lib/short-drama/general-script-profile";
import { hashShortDramaRequest } from "@/lib/short-drama/idempotency";
import {
  ShortDramaAccessError,
  authorizeShortDramaRequest,
} from "@/lib/short-drama/permissions";
import { assertShortDramaReadyForPaidModelCall } from "@/lib/short-drama/readiness";
import { requireShortDramaPaidRequestId } from "@/lib/short-drama/paid-request-idempotency";
import { selectShortDramaTextModel } from "@/lib/short-drama/text-model-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fixtureModeEnabled(): boolean {
  return process.env.SHORT_DRAMA_FIXTURE_MODE === "1"
    && process.env.NODE_ENV !== "production";
}

function jsonResponse(
  payload: GeneralScriptApiSuccess | GeneralScriptApiError | Record<string, unknown>,
  status = 200,
  privateResponse = false,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": privateResponse ? "private, no-store" : "no-store",
    },
  });
}

function errorResponse(error: string, code: string, status: number, privateResponse = false): Response {
  return jsonResponse({ ok: false, error, code }, status, privateResponse);
}

async function readJsonSafely(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function upstreamCode(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const code = payload.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,80}$/.test(code) ? code : "";
}

function upstreamIsInProgress(payload: unknown): boolean {
  return upstreamCode(payload) === "LLM_ATTEMPT_IN_PROGRESS";
}

function upstreamIsRetrySafe(response: Response): boolean {
  // Only the inner exactly-once route may declare an immediate response safe
  // to retry. Missing headers are ambiguous; GET history later reconciles the
  // durable attempt row without issuing another provider request.
  return response.headers.get("x-llm-retry-safe") === "true";
}

function parseSettledBilling(payload: unknown): Record<string, unknown> {
  const billing = isRecord(payload) && isRecord(payload._billing) ? payload._billing : null;
  const creditsCharged = Number(billing?.credits_charged);
  const operationId = typeof billing?.operation_id === "string"
    ? billing.operation_id.trim()
    : typeof billing?.operation_id === "number"
      ? String(billing.operation_id)
      : "";
  if (!billing || !Number.isFinite(creditsCharged) || creditsCharged < 0 || (creditsCharged > 0 && !operationId)) {
    throw new GeneralScriptHistoryError(
      "GENERAL_SCRIPT_BILLING_RECEIPT_INVALID",
      "模型已返回，但账务终态回执无法核对。原请求已保留，请勿重复提交。",
      503,
    );
  }
  return {
    state: "settled",
    creditsCharged,
    operationId: operationId || null,
    alreadyFulfilled: billing.already_fulfilled === true,
  };
}

function publicError(error: unknown, privateResponse = false): Response {
  if (error instanceof GeneralScriptHistoryError || error instanceof ShortDramaAccessError) {
    return errorResponse(error.message, error.code, error.status, privateResponse);
  }
  if (error instanceof GeneralScriptContractError) {
    return errorResponse(error.message, "INVALID_GENERAL_SCRIPT_CONTRACT", 400, privateResponse);
  }
  const typed = error as { status?: unknown; code?: unknown } | null;
  const status = Number(typed?.status || 0);
  const code = typeof typed?.code === "string" ? typed.code : "";
  if (status >= 400 && status <= 599 && /^[A-Z0-9_]{3,80}$/.test(code)) {
    return errorResponse(error instanceof Error ? error.message : "影视工坊服务暂时不可用", code, status, privateResponse);
  }
  return errorResponse("通用编剧处理失败，请稍后重试。", "GENERAL_SCRIPT_FAILED", 500, privateResponse);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await authorizeShortDramaRequest(request);
    const url = new URL(request.url);
    const surface = normalizeGeneralScriptHistorySurface(url.searchParams.get("surface"));
    const limitValue = Number(url.searchParams.get("limit") || 20);
    const offsetValue = Number(url.searchParams.get("offset") || 0);
    const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(limitValue, 50)) : 20;
    const offset = Number.isInteger(offsetValue) ? Math.max(0, Math.min(offsetValue, 10_000)) : 0;
    const id = url.searchParams.get("id")?.trim() || undefined;
    const profileId = url.searchParams.get("profile")?.trim() || undefined;
    if (id && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(id)) {
      return errorResponse("历史记录编号无效", "GENERAL_SCRIPT_HISTORY_INPUT_INVALID", 400, true);
    }
    const history = await new GeneralScriptHistoryRepository(auth.db).list({
      userId: auth.userId,
      surface,
      profileId,
      limit,
      offset,
      id,
    });
    return jsonResponse({ ok: true, historyReady: true, ...history }, 200, true);
  } catch (error) {
    if (error instanceof GeneralScriptHistoryError && error.code === "GENERAL_SCRIPT_HISTORY_MIGRATION_NOT_READY") {
      // 历史读取属于页面的辅助能力。迁移未就绪时返回明确的可降级状态，
      // 避免五个别名页面都制造 503 控制台噪音；POST 仍保持失败关闭，
      // 不会在缺少幂等历史账本时提交模型或产生费用。
      return jsonResponse({
        ok: true,
        historyReady: false,
        code: error.code,
        unavailableReason: error.message,
        items: [],
        total: 0,
      }, 200, true);
    }
    return publicError(error, true);
  }
}

export async function POST(request: Request): Promise<Response> {
  let repository: GeneralScriptHistoryRepository | null = null;
  let historyContext: {
    userId: string;
    clientRequestId: string;
    requestHash: string;
  } | null = null;
  let llmDispatchStarted = false;
  let historyTerminalSaved = false;

  try {
    const body = await request.json();
    const scriptRequest = parseGeneralScriptRequest(body);
    const promptProfile = getGeneralScriptPromptProfile(scriptRequest.profile.id);

    if (fixtureModeEnabled()) {
      const result = validateGeneralScriptResultForRequest(
        scriptRequest,
        parseGeneralScriptResult(createGeneralScriptFixture(scriptRequest)),
      );
      return jsonResponse({
        ok: true,
        executionMode: "fixture",
        profile: {
          id: scriptRequest.profile.id,
          version: GENERAL_SCRIPT_PROFILE_VERSION,
        },
        contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
        result,
      });
    }

    const auth = await authorizeShortDramaRequest(request);
    await assertShortDramaReadyForPaidModelCall();
    const clientRequestId = requireShortDramaPaidRequestId(request);
    const requestHash = hashShortDramaRequest({
      contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
      request: scriptRequest,
    });
    repository = new GeneralScriptHistoryRepository(auth.db);
    historyContext = { userId: auth.userId, clientRequestId, requestHash };
    const claim = await repository.claim({
      userId: auth.userId,
      clientRequestId,
      requestHash,
      requestSnapshot: scriptRequest,
      surface: request.headers.get("x-general-script-surface") || "api",
    });
    if (claim.action === "replay") {
      historyTerminalSaved = true;
      if (!claim.record.result || claim.record.billingSnapshot.state !== "settled") {
        throw new GeneralScriptHistoryError(
          "GENERAL_SCRIPT_HISTORY_RECEIPT_INVALID",
          "已完成剧本缺少可核对的结果或账务回执。",
        );
      }
      const replayedResult = validateGeneralScriptResultForRequest(scriptRequest, claim.record.result);
      return jsonResponse({
        ok: true,
        executionMode: "real",
        profile: {
          id: scriptRequest.profile.id,
          version: GENERAL_SCRIPT_PROFILE_VERSION,
        },
        contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
        result: replayedResult,
      });
    }
    if (claim.action === "failed") {
      return errorResponse(
        "原请求已明确失败且未扣费。请载入历史参数，确认后使用新的请求编号提交。",
        "GENERAL_SCRIPT_NEW_REQUEST_ID_REQUIRED",
        409,
      );
    }
    if (claim.action === "reconciliation_required") {
      return errorResponse(
        "原请求的执行或账务终态尚未确认，请勿重复提交。",
        "GENERAL_SCRIPT_RECONCILIATION_REQUIRED",
        409,
      );
    }

    const selectedModel = await selectShortDramaTextModel(
      request.headers.get("x-short-drama-model-id")?.trim() || "",
    );
    const authorization = request.headers.get("authorization") || "";
    const llmUrl = new URL("/api/llm", request.url);
    llmDispatchStarted = true;
    const upstream = await fetch(llmUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
        "Idempotency-Key": clientRequestId,
      },
      body: JSON.stringify({
        // The shared LLM route replaces message-level system entries when it
        // constructs the named agent context; carry the same profile explicitly.
        system_prompt: promptProfile.systemPrompt,
        messages: [
          {
            role: "system",
            content: promptProfile.systemPrompt,
          },
          {
            role: "user",
            content: buildGeneralScriptUserPrompt(scriptRequest),
          },
        ],
        stream: false,
        response_format: "json_object",
        temperature: 0.7,
        max_reply_tokens: 32_768,
        timeout: 120,
        agentName: "通用短剧编剧",
        modelId: selectedModel.id,
        model_overridden: true,
        client_request_id: clientRequestId,
      }),
      cache: "no-store",
      signal: request.signal,
    });

    const upstreamPayload = await readJsonSafely(upstream);
    if (!upstream.ok) {
      if (!upstreamIsInProgress(upstreamPayload)) {
        const retrySafe = upstreamIsRetrySafe(upstream);
        await repository.finalize({
          ...historyContext,
          state: retrySafe ? "failed" : "reconciliation_required",
          billingSnapshot: { state: retrySafe ? "not_charged" : "reconciliation_required" },
          errorCode: upstreamCode(upstreamPayload) || "LLM_UPSTREAM_FAILED",
          errorMessage: retrySafe
            ? "本次生成明确未完成且未扣费，可载入参数后手动重新提交。"
            : "模型请求的执行或账务终态尚未确认，请勿重复提交。",
        });
        historyTerminalSaved = true;
      }
      return errorResponse(
        extractUpstreamError(upstreamPayload, "主站文案模型暂时不可用"),
        upstreamCode(upstreamPayload) || "LLM_UPSTREAM_FAILED",
        upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502,
      );
    }

    const billingSnapshot = parseSettledBilling(upstreamPayload);
    let result: GeneralScriptResult;
    try {
      result = validateGeneralScriptResultForRequest(
        scriptRequest,
        bindGeneralScriptRequestSettings(scriptRequest, parseGeneralScriptLlmPayload(upstreamPayload)),
      );
    } catch {
      await repository.finalize({
        ...historyContext,
        state: "reconciliation_required",
        billingSnapshot: { state: "reconciliation_required", observedSettlement: billingSnapshot },
        errorCode: "GENERAL_SCRIPT_RESULT_INVALID_AFTER_SETTLEMENT",
        errorMessage: "模型已结算，但返回内容未通过剧本结构校验，请勿重复提交。",
      });
      historyTerminalSaved = true;
      throw new GeneralScriptHistoryError(
        "GENERAL_SCRIPT_RESULT_RECONCILIATION_REQUIRED",
        "模型已返回并结算，但剧本结构校验失败。原请求已保留，请勿重复提交。",
        503,
      );
    }
    await repository.finalize({
      ...historyContext,
      state: "succeeded",
      result,
      resultHash: hashShortDramaRequest(result),
      billingSnapshot,
    });
    historyTerminalSaved = true;
    return jsonResponse({
      ok: true,
      executionMode: "real",
      profile: {
        id: scriptRequest.profile.id,
        version: GENERAL_SCRIPT_PROFILE_VERSION,
      },
      contractVersion: GENERAL_SCRIPT_CONTRACT_VERSION,
      result,
    });
  } catch (error: unknown) {
    if (repository && historyContext && !historyTerminalSaved) {
      try {
        // Errors before the inner LLM dispatch are proven uncharged. Once the
        // local LLM route was dispatched, a transport exception is ambiguous.
        await repository.finalize({
          ...historyContext,
          state: llmDispatchStarted ? "reconciliation_required" : "failed",
          billingSnapshot: {
            state: llmDispatchStarted ? "reconciliation_required" : "not_charged",
          },
          errorCode: llmDispatchStarted ? "GENERAL_SCRIPT_DISPATCH_TERMINAL_UNKNOWN" : "GENERAL_SCRIPT_PRE_PROVIDER_FAILURE",
          errorMessage: llmDispatchStarted
            ? "模型请求的执行或账务终态尚未确认，请勿重复提交。"
            : "本次请求在调用模型前失败，未扣费。",
        });
      } catch (finalizeError) {
        if (finalizeError instanceof GeneralScriptHistoryError) return publicError(finalizeError);
      }
    }
    return publicError(error);
  }
}
