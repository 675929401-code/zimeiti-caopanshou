import { NextRequest, NextResponse } from "next/server";
import { requireCommerceAdmin } from "@/lib/commerce-admin-auth";
import {
  createPlatformConfigurationCandidate,
  createPlatformConfigurationRollbackCandidate,
  platformConfigurationOverview,
  PlatformConfigurationError,
  previewPlatformConfigurationRelease,
  publishPlatformConfigurationRelease,
  validatePlatformConfigurationCandidate,
  readPlatformModelMutationReceipt,
} from "@/lib/server/platform-configuration-admin";
import { modelPoolMutationFailure } from "@/lib/server/model-pool-mutation-http";
import { modelPoolCredentialStatus } from "@/lib/server/model-pool-credential-status";
import { stageInitialModelPoolCandidate } from "@/lib/server/platform-configuration-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kind = "model-pool" as const;
const noStore = { "Cache-Control": "no-store, max-age=0" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failure(error: unknown, fallback: string, status = 409) {
  const classified = modelPoolMutationFailure(error);
  if (classified) return classified;
  const code = error instanceof PlatformConfigurationError ? error.code : "PLATFORM_CONFIGURATION_OPERATION_FAILED";
  return NextResponse.json({ ok: false, code, error: fallback }, { status, headers: noStore });
}

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request);
  if ("response" in auth) return auth.response;
  try {
    const requestId = request.nextUrl.searchParams.get("requestId");
    if (requestId) return NextResponse.json({ ok: true, requestId, receipt: await readPlatformModelMutationReceipt(auth.actor.userId, requestId) }, { headers: noStore });
    const credentialReleaseId = request.nextUrl.searchParams.get("credentialReleaseId");
    if (credentialReleaseId) return NextResponse.json({ ok: true, releaseId: credentialReleaseId,
      credentialChanges: await modelPoolCredentialStatus(credentialReleaseId) }, { headers: noStore });
    const releaseId = request.nextUrl.searchParams.get("previewReleaseId");
    if (releaseId) return NextResponse.json({ ok: true, preview: await previewPlatformConfigurationRelease(kind, releaseId) }, { headers: noStore });
    return NextResponse.json({ ok: true, ...(await platformConfigurationOverview(kind)) }, { headers: noStore });
  } catch (error) {
    return failure(error, "读取模型池版本失败", 503);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, true);
  if ("response" in auth) return auth.response;
  try {
    const body = record(await request.json());
    const action = String(body.action || "draft");
    const release = action === "bootstrap"
      ? await stageInitialModelPoolCandidate({ actorId: auth.actor.userId, changeNote: String(body.changeNote || "") || undefined })
      : action === "draft"
      ? await createPlatformConfigurationCandidate(auth.actor.userId, kind, body.snapshot, body.changeNote)
      : action === "validate"
        ? await validatePlatformConfigurationCandidate(auth.actor.userId, kind, String(body.releaseId || ""))
        : action === "publish"
          ? await publishPlatformConfigurationRelease(auth.actor.userId, kind, String(body.releaseId || ""), String(body.previewSha256 || ""))
          : action === "rollback"
            ? await createPlatformConfigurationRollbackCandidate(auth.actor.userId, kind, String(body.targetId || ""), body.changeNote)
            : null;
    if (!release) return failure(new PlatformConfigurationError("PLATFORM_CONFIGURATION_ACTION_INVALID", "未知模型池版本操作"), "操作无效", 400);
    return NextResponse.json({ ok: true, release }, { status: action === "bootstrap" || action === "draft" || action === "rollback" ? 201 : 200, headers: noStore });
  } catch (error) {
    return failure(error, "模型池版本操作失败");
  }
}
