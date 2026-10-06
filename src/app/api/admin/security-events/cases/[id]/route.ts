import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  SecurityCaseValidationError,
  parseSecurityCaseId,
  parseSecurityCaseMutationRequest,
} from "@/lib/security-case-contracts";
import {
  SecurityCaseControlError,
  claimSecurityCase,
  linkSecurityCaseEntity,
  readSecurityCaseDetail,
  securityCaseControlErrorStatus,
  transitionSecurityCase,
} from "@/lib/server/security-case-control-plane";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";
import {
  SecurityCaseReadRateLimitError,
  governedSecurityCaseRead,
  invalidateSecurityCaseReadCache,
  securityCaseRateLimitErrorHeaders,
  securityCaseRateLimitHeaders,
} from "@/lib/server/security-case-read-governor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

function requestKey(request: NextRequest): string {
  const supplied = request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "";
  return (supplied.trim() || crypto.randomUUID()).slice(0, 200);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SecurityCaseValidationError) return json({ ok: false, error: error.message, code: error.code }, 400);
  if (error instanceof SecurityCaseControlError) return json({ ok: false, error: error.message, code: error.code }, securityCaseControlErrorStatus(error));
  return json({ ok: false, error: "安全案件操作失败", code: "SECURITY_CASE_UNKNOWN_FAILURE" }, 500);
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
    action: `security_case_${operation}`,
    result,
    reasonCode,
    resource: "security_case",
    request,
    requestKey: key,
    metadata: { caseId },
  });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authorization = await authorizeAdminCapability(request, "security.view", {
    operation: "security_case_read",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const { id } = await context.params;
    const caseId = parseSecurityCaseId(id);
    const governed = await governedSecurityCaseRead({
      actorId: authorization.actor.userId,
      queryKey: `security-case-detail:${caseId}`,
      loader: () => readSecurityCaseDetail(caseId),
    });
    return json({ ok: true, ...governed.value, ...governed.metadata }, 200, securityCaseRateLimitHeaders(governed.metadata));
  } catch (error) {
    if (error instanceof SecurityCaseReadRateLimitError) {
      return json({
        ok: false,
        error: error.message,
        code: error.code,
        nextRefreshAt: error.nextRefreshAt,
        rateLimit: { scope: "per_admin_query", backend: "process_memory", limit: 1, remaining: 0 },
      }, 429, securityCaseRateLimitErrorHeaders(error));
    }
    console.error("[security-case] detail failed", error instanceof SecurityCaseControlError ? error.code : "invalid");
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const authorizationResult = await authorizeAdminCapability(request, "security.manage", {
    operation: "security_case_mutate",
    requireStepUp: true,
  });
  if (!authorizationResult.ok) return authorizationResult.response;
  const authorization = allowed(authorizationResult);
  const key = requestKey(request);
  let caseId = "invalid";
  let operation = "invalid";
  try {
    const params = await context.params;
    caseId = parseSecurityCaseId(params.id);
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      throw new SecurityCaseValidationError("请求体超过 16KB", "SECURITY_CASE_REQUEST_TOO_LARGE");
    }
    const mutation = parseSecurityCaseMutationRequest(await request.json().catch(() => null));
    operation = mutation.operation;
    const result = mutation.operation === "claim"
      ? await claimSecurityCase({
        caseId,
        expectedRevision: mutation.expectedRevision,
        actorId: authorization.actor.userId,
        reason: mutation.reason,
        requestKey: key,
      })
      : mutation.operation === "transition"
        ? await transitionSecurityCase({
          caseId,
          expectedRevision: mutation.expectedRevision,
          targetStatus: mutation.targetStatus,
          actorId: authorization.actor.userId,
          reason: mutation.reason,
          requestKey: key,
        })
        : await linkSecurityCaseEntity({
          caseId,
          expectedRevision: mutation.expectedRevision,
          entityType: mutation.entityType,
          entityRef: mutation.entityRef,
          entityLabel: mutation.entityLabel,
          actorId: authorization.actor.userId,
          reason: mutation.reason,
          requestKey: key,
        });
    invalidateSecurityCaseReadCache(authorization.actor.userId);
    await audit(request, authorization, operation, "success", "SECURITY_CASE_MUTATION_SUCCEEDED", key, caseId);
    return json({ ok: true, result, requestKey: key });
  } catch (error) {
    const code = error instanceof SecurityCaseValidationError || error instanceof SecurityCaseControlError
      ? error.code
      : "SECURITY_CASE_UNKNOWN_FAILURE";
    await audit(request, authorization, operation, "failure", code, key, caseId);
    console.error("[security-case] mutation failed", { operation, code });
    return errorResponse(error);
  }
}
