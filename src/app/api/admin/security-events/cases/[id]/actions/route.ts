import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  SecurityCaseValidationError,
  parseSecurityCaseActionRequest,
  parseSecurityCaseId,
  parseSecurityCaseRequestKey,
} from "@/lib/security-case-contracts";
import {
  SecurityCaseControlError,
  cancelSecurityCaseAction,
  previewSecurityCaseAction,
  requestSecurityCaseAction,
  securityCaseControlErrorStatus,
} from "@/lib/server/security-case-control-plane";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import { invalidateSecurityCaseReadCache } from "@/lib/server/security-case-read-governor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function suppliedRequestKey(request: NextRequest): string {
  return request.headers.get("idempotency-key")?.trim() || request.headers.get("x-request-id")?.trim() || "";
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SecurityCaseValidationError) return json({ ok: false, error: error.message, code: error.code }, 400);
  if (error instanceof SecurityCaseControlError) return json({ ok: false, error: error.message, code: error.code }, securityCaseControlErrorStatus(error));
  return json({ ok: false, error: "安全处置请求失败", code: "SECURITY_CASE_UNKNOWN_FAILURE" }, 500);
}

function allowed(result: AdminCapabilityResult): Extract<AdminCapabilityResult, { ok: true }> {
  if (!result.ok) throw new Error("authorization result is not allowed");
  return result;
}

async function audit(
  request: NextRequest,
  authorization: Extract<AdminCapabilityResult, { ok: true }>,
  operation: string,
  result: "success" | "failure",
  reasonCode: string,
  key: string,
  caseId: string,
): Promise<void> {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "security.manage",
    action: `security_case_action_${operation}`,
    result,
    reasonCode,
    resource: "security_case_action",
    request,
    requestKey: key,
    metadata: { caseId, executionSupported: false },
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const authorizationResult = await authorizeAdminCapability(request, "security.manage", {
    operation: "security_case_action",
    requireStepUp: true,
  });
  if (!authorizationResult.ok) return authorizationResult.response;
  const authorization = allowed(authorizationResult);
  let caseId = "invalid";
  let operation = "invalid";
  let key = suppliedRequestKey(request) || crypto.randomUUID();
  try {
    caseId = parseSecurityCaseId((await context.params).id);
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      throw new SecurityCaseValidationError("请求体超过 16KB", "SECURITY_CASE_REQUEST_TOO_LARGE");
    }
    const action = parseSecurityCaseActionRequest(await request.json().catch(() => null));
    operation = action.operation;
    if (action.operation === "preview") {
      const preview = await previewSecurityCaseAction({
        caseId,
        expectedRevision: action.expectedRevision,
        actionType: action.actionType,
        targetRef: action.targetRef,
      });
      await audit(request, authorization, operation, "success", "SECURITY_CASE_ACTION_PREVIEWED", key, caseId);
      return json({
        ok: true,
        preview,
        boundary: {
          persisted: false,
          executed: false,
          executorAvailable: false,
          nextStep: "提交 request 只会创建 pending_executor 请求",
        },
      });
    }

    key = parseSecurityCaseRequestKey(suppliedRequestKey(request));
    if (action.operation === "cancel") {
      const result = await cancelSecurityCaseAction({
        caseId,
        actionId: action.actionId,
        expectedActionRevision: action.expectedActionRevision,
        actorId: authorization.actor.userId,
        reason: action.reason,
        requestKey: key,
      });
      invalidateSecurityCaseReadCache(authorization.actor.userId);
      await audit(request, authorization, operation, "success", "SECURITY_CASE_ACTION_CANCELLED", key, caseId);
      return json({ ok: true, result, executed: false, requestKey: key });
    }

    const preview = await previewSecurityCaseAction({
      caseId,
      expectedRevision: action.expectedRevision,
      actionType: action.actionType,
      targetRef: action.targetRef,
    });
    const result = await requestSecurityCaseAction({
      caseId,
      expectedRevision: action.expectedRevision,
      actionType: action.actionType,
      targetRef: action.targetRef,
      actorId: authorization.actor.userId,
      reason: action.reason,
      requestKey: key,
      impactPreview: preview,
    });
    invalidateSecurityCaseReadCache(authorization.actor.userId);
    await audit(request, authorization, operation, "success", "SECURITY_CASE_ACTION_PENDING_EXECUTOR", key, caseId);
    return json({
      ok: true,
      result,
      preview,
      boundary: {
        persisted: true,
        executed: false,
        status: "pending_executor",
        executorAvailable: false,
      },
      requestKey: key,
    }, result.duplicate === true ? 200 : 202);
  } catch (error) {
    const code = error instanceof SecurityCaseValidationError || error instanceof SecurityCaseControlError
      ? error.code
      : "SECURITY_CASE_UNKNOWN_FAILURE";
    await audit(request, authorization, operation, "failure", code, key.slice(0, 200), caseId);
    console.error("[security-case] action failed", { operation, code });
    return errorResponse(error);
  }
}
