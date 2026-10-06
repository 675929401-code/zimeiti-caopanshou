import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { type SkillActor } from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  normalizeSkillRepositoryError,
  uninstallUserSkill,
} from "@/lib/server/skill-package-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function requireActor(request: NextRequest): Promise<SkillActor | NextResponse> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return json({ ok: false, code: "AUTH_REQUIRED", error: "请先登录" }, 401);
  const payload = await verifyToken(token);
  if (!payload) return json({ ok: false, code: "UNAUTHENTICATED", error: "登录状态无效" }, 401);
  return { userId: payload.userId, role: payload.role, displayName: payload.displayName };
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;
  const { slug: rawPackageId } = await context.params;
  let packageId: string;
  try {
    packageId = decodeURIComponent(rawPackageId ?? "").trim();
  } catch {
    return json({ ok: false, code: "INVALID_REQUEST", error: "packageId 不合法" }, 400);
  }
  if (!UUID_PATTERN.test(packageId)) {
    return json({ ok: false, code: "INVALID_REQUEST", error: "packageId 不合法" }, 400);
  }
  try {
    await uninstallUserSkill({ actor, packageId });
    return json({ ok: true, packageId, uninstalled: true });
  } catch (error) {
    const normalized =
      error instanceof SkillRepositoryError
        ? error
        : normalizeSkillRepositoryError(error, "uninstall");
    return json(
      { ok: false, code: normalized.code, error: normalized.message, operation: normalized.operation },
      normalized.status,
    );
  }
}
