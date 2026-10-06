import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  PlatformBrandValidationError,
  parseBrandRevisionId,
  parseExpectedBrandGeneration,
  parsePlatformBrandPayload,
} from "@/lib/branding/contracts";
import {
  PlatformBrandAuthorityError,
  appendPlatformBrandFailureEvent,
  platformBrandErrorCode,
  publishPlatformBrandRevision,
  readAdminPlatformBrandingState,
  rollbackPlatformBrandRevision,
  savePlatformBrandDraft,
} from "@/lib/server/brand-authority";
import {
  appendAdminGovernanceAudit,
  authorizeAdminCapability,
  type AdminCapabilityResult,
} from "@/lib/server/admin-governance-authority";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WriteAction = "save-draft" | "publish" | "rollback";

const ACTION_EVENT: Record<WriteAction, "draft_save" | "publish" | "rollback"> = {
  "save-draft": "draft_save",
  publish: "publish",
  rollback: "rollback",
};

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function requestKey(request: NextRequest): string {
  const supplied = request.headers.get("idempotency-key") || request.headers.get("x-request-id") || "";
  return (supplied.trim() || crypto.randomUUID()).slice(0, 200);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof PlatformBrandValidationError) {
    return json({ ok: false, error: error.message, code: error.code }, 400);
  }
  if (error instanceof PlatformBrandAuthorityError) {
    const status = error.code === "BRAND_GENERATION_CONFLICT" ? 409
      : error.code === "BRAND_REVISION_NOT_FOUND" ? 404
        : error.code === "BRAND_MIGRATION_REQUIRED" ? 503
          : error.code === "BRAND_AUTHORITY_FAILURE" || error.code === "BRAND_DATA_INVALID" ? 500
            : 409;
    return json({ ok: false, error: error.message, code: error.code }, status);
  }
  return json({ ok: false, error: "品牌中心操作失败", code: "BRAND_UNKNOWN_FAILURE" }, 500);
}

function authorizedActor(result: AdminCapabilityResult) {
  if (!result.ok) throw new Error("authorization result is not allowed");
  return result;
}

async function auditWrite(
  request: NextRequest,
  authorization: Extract<AdminCapabilityResult, { ok: true }>,
  action: WriteAction | "invalid",
  result: "success" | "failure",
  reasonCode: string,
  key: string,
): Promise<void> {
  await appendAdminGovernanceAudit({
    actorId: authorization.actor.userId,
    actorLevel: authorization.access.adminLevel,
    permissionKey: "brand.settings.manage",
    action: action === "invalid" ? "platform_brand_invalid_action" : `platform_brand_${action.replace("-", "_")}`,
    result,
    reasonCode,
    resource: "platform_branding",
    request,
    requestKey: key,
    metadata: {},
  });
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "platform_brand_read",
    auditAllowed: true,
  });
  if (!authorization.ok) return authorization.response;
  try {
    const state = await readAdminPlatformBrandingState();
    return json({ ok: true, state });
  } catch (error) {
    console.error("[branding] admin read failed", error instanceof Error ? error.message : error);
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const authorizationResult = await authorizeAdminCapability(request, "brand.settings.manage", {
    operation: "platform_brand_write",
  });
  if (!authorizationResult.ok) return authorizationResult.response;
  let authorization = authorizedActor(authorizationResult);
  const key = requestKey(request);
  let action: WriteAction | "invalid" = "invalid";
  let revisionId: string | null = null;

  try {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
      throw new PlatformBrandValidationError("品牌配置请求超过 64KB", "BRAND_REQUEST_TOO_LARGE");
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new PlatformBrandValidationError("请求体不是有效 JSON", "BRAND_REQUEST_INVALID");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PlatformBrandValidationError("请求体必须是对象", "BRAND_REQUEST_INVALID");
    }
    const body = raw as Record<string, unknown>;
    if (body.action === "save-draft" || body.action === "publish" || body.action === "rollback") {
      action = body.action;
    } else {
      throw new PlatformBrandValidationError("不支持的品牌操作", "BRAND_ACTION_INVALID");
    }
    if (action === "publish" || action === "rollback") {
      const elevatedResult = await authorizeAdminCapability(request, "brand.settings.manage", {
        operation: action === "publish" ? "platform_brand_publish" : "platform_brand_rollback",
        requireStepUp: true,
      });
      if (!elevatedResult.ok) return elevatedResult.response;
      authorization = authorizedActor(elevatedResult);
    }
    const expectedGeneration = parseExpectedBrandGeneration(body.expectedGeneration);
    let result: Record<string, unknown>;
    if (action === "save-draft") {
      result = await savePlatformBrandDraft({
        expectedGeneration,
        brand: parsePlatformBrandPayload(body.brand),
        actorId: authorization.actor.userId,
        requestKey: key,
      });
    } else {
      revisionId = parseBrandRevisionId(body.revisionId);
      result = action === "publish"
        ? await publishPlatformBrandRevision({
          expectedGeneration,
          revisionId,
          actorId: authorization.actor.userId,
          requestKey: key,
        })
        : await rollbackPlatformBrandRevision({
          expectedGeneration,
          revisionId,
          actorId: authorization.actor.userId,
          requestKey: key,
        });
    }
    await auditWrite(request, authorization, action, "success", "BRAND_WRITE_SUCCEEDED", key);
    return json({ ok: true, result, requestKey: key });
  } catch (error) {
    const code = error instanceof PlatformBrandValidationError ? error.code : platformBrandErrorCode(error);
    if (action !== "invalid") {
      await appendPlatformBrandFailureEvent({
        action: ACTION_EVENT[action],
        actorId: authorization.actor.userId,
        reasonCode: code,
        requestKey: key,
        revisionId,
      });
    }
    await auditWrite(request, authorization, action, "failure", code, key);
    console.error("[branding] write failed", { action, code });
    return errorResponse(error);
  }
}
