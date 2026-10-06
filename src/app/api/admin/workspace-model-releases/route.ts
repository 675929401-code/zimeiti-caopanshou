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
} from "@/lib/server/platform-configuration-admin";
import { stageInitialWorkspaceModelCandidate } from "@/lib/server/platform-configuration-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const kind = "workspace-models" as const;
const noStore = { "Cache-Control": "no-store, max-age=0" };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failure(error: unknown, fallback: string, status = 409) {
  const code = error instanceof PlatformConfigurationError ? error.code : "PLATFORM_CONFIGURATION_OPERATION_FAILED";
  return NextResponse.json({ ok: false, code, error: error instanceof Error ? error.message : fallback }, { status, headers: noStore });
}

export async function GET(request: NextRequest) {
  const auth = await requireCommerceAdmin(request);
  if ("response" in auth) return auth.response;
  try {
    const releaseId = request.nextUrl.searchParams.get("previewReleaseId");
    if (releaseId) return NextResponse.json({ ok: true, preview: await previewPlatformConfigurationRelease(kind, releaseId) }, { headers: noStore });
    return NextResponse.json({ ok: true, ...(await platformConfigurationOverview(kind)) }, { headers: noStore });
  } catch (error) {
    return failure(error, "读取工作台模型版本失败", 503);
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireCommerceAdmin(request, true);
  if ("response" in auth) return auth.response;
  try {
    const body = record(await request.json());
    const action = String(body.action || "draft");
    const release = action === "bootstrap"
      ? await stageInitialWorkspaceModelCandidate({ actorId: auth.actor.userId, changeNote: String(body.changeNote || "") || undefined })
      : action === "draft"
      ? await createPlatformConfigurationCandidate(auth.actor.userId, kind, body.snapshot, body.changeNote)
      : action === "validate"
        ? await validatePlatformConfigurationCandidate(auth.actor.userId, kind, String(body.releaseId || ""))
        : action === "publish"
          ? await publishPlatformConfigurationRelease(auth.actor.userId, kind, String(body.releaseId || ""), String(body.previewSha256 || ""))
          : action === "rollback"
            ? await createPlatformConfigurationRollbackCandidate(auth.actor.userId, kind, String(body.targetId || ""), body.changeNote)
            : null;
    if (!release) return failure(new PlatformConfigurationError("PLATFORM_CONFIGURATION_ACTION_INVALID", "未知工作台模型版本操作"), "操作无效", 400);
    return NextResponse.json({ ok: true, release }, { status: action === "bootstrap" || action === "draft" || action === "rollback" ? 201 : 200, headers: noStore });
  } catch (error) {
    return failure(error, "工作台模型版本操作失败");
  }
}
