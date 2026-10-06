import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  SecurityCaseValidationError,
  boundedSecurityCasePage,
  parseSecurityCaseIngestRequest,
} from "@/lib/security-case-contracts";
import {
  SecurityCaseControlError,
  ingestSecurityCaseEvent,
  listSecurityCases,
  securityCaseControlErrorStatus,
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

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...PRIVATE_HEADERS, ...headers } });
}

function requestKey(request: NextRequest): string {
  const supplied = request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "";
  return (supplied.trim() || crypto.randomUUID()).slice(0, 200);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof SecurityCaseValidationError) {
    return json({ ok: false, error: error.message, code: error.code }, 400);
  }
  if (error instanceof SecurityCaseControlError) {
    return json({ ok: false, error: error.message, code: error.code }, securityCaseControlErrorStatus(error));
  }
  return json({ ok: false, error: "安全案件操作失败", code: "SECURITY_CASE_UNKNOWN_FAILURE" }, 500);
}

function allowed(result: AdminCapabilityResult): Extract<AdminCapabilityResult, { ok: true }> {
  if (!result.ok) throw new Error("authorization result is not allowed");
  return result;
}

async function audit(
  request: NextRequest,
  authorization: Extract<AdminCapabilityResult, { ok: true }>,
  result: "success" | "failure",
  reasonCode: string,
  key: string,
): Promise<void> {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "security.manage",
    action: "security_case_ingest",
    result,
    reasonCode,
    resource: "security_case",
    request,
    requestKey: key,
    metadata: {},
  });
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "security.view", {
    operation: "security_case_list",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;
  const url = request.nextUrl;
  try {
    const input = {
      page: boundedSecurityCasePage(url.searchParams.get("page"), 1, 1, 100_000),
      pageSize: boundedSecurityCasePage(url.searchParams.get("pageSize"), 30, 10, 100),
      status: url.searchParams.get("status")?.trim() || undefined,
      riskLevel: url.searchParams.get("riskLevel")?.trim() || undefined,
      assignedTo: url.searchParams.get("assignedTo")?.trim().slice(0, 200) || undefined,
    };
    const governed = await governedSecurityCaseRead({
      actorId: authorization.actor.userId,
      queryKey: `security-case-list:${JSON.stringify(input)}`,
      loader: () => listSecurityCases(input),
    });
    return json({
      ok: true,
      ...governed.value,
      executionPolicy: { executorAvailable: false, destructiveExecutionEnabled: false },
      ...governed.metadata,
    }, 200, securityCaseRateLimitHeaders(governed.metadata));
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
    console.error("[security-case] list failed", error instanceof SecurityCaseControlError ? error.code : "unknown");
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authorizationResult = await authorizeAdminCapability(request, "security.manage", {
    operation: "security_case_ingest",
    requireStepUp: true,
  });
  if (!authorizationResult.ok) return authorizationResult.response;
  const authorization = allowed(authorizationResult);
  const key = requestKey(request);
  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 16 * 1024) {
      throw new SecurityCaseValidationError("请求体超过 16KB", "SECURITY_CASE_REQUEST_TOO_LARGE");
    }
    const body = await request.json().catch(() => null);
    const input = parseSecurityCaseIngestRequest(body);
    const result = await ingestSecurityCaseEvent({
      ...input,
      actorId: authorization.actor.userId,
      requestKey: key,
    });
    invalidateSecurityCaseReadCache(authorization.actor.userId);
    await audit(request, authorization, "success", result.duplicate === true ? "SECURITY_EVENT_ALREADY_LINKED" : "SECURITY_EVENT_INGESTED", key);
    return json({ ok: true, result, requestKey: key }, result.createdCase === true ? 201 : 200);
  } catch (error) {
    const code = error instanceof SecurityCaseValidationError || error instanceof SecurityCaseControlError
      ? error.code
      : "SECURITY_CASE_UNKNOWN_FAILURE";
    await audit(request, authorization, "failure", code, key);
    console.error("[security-case] ingest failed", code);
    return errorResponse(error);
  }
}
