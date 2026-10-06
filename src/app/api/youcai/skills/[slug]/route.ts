import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { toPublicSkillPackage, type SkillActor } from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  getPublishedSkillPackageBySlug,
  normalizeSkillRepositoryError,
} from "@/lib/server/skill-package-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

async function optionalActor(request: NextRequest): Promise<SkillActor | null | NextResponse> {
  const token = getTokenFromHeaders(request.headers);
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return json({ ok: false, code: "UNAUTHENTICATED", error: "登录状态无效" }, 401);
  return { userId: payload.userId, role: payload.role, displayName: payload.displayName };
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const actor = await optionalActor(request);
  if (actor instanceof NextResponse) return actor;
  const { slug: rawSlug } = await context.params;
  let slug: string;
  try {
    slug = decodeURIComponent(rawSlug ?? "").trim().toLowerCase();
  } catch {
    return json({ ok: false, code: "INVALID_REQUEST", error: "Skill slug 不合法" }, 400);
  }
  if (!SLUG_PATTERN.test(slug) || slug.length > 80) {
    return json({ ok: false, code: "INVALID_REQUEST", error: "Skill slug 不合法" }, 400);
  }
  try {
    const skill = await getPublishedSkillPackageBySlug(slug, actor);
    return json({ ok: true, skill: toPublicSkillPackage(skill) });
  } catch (error) {
    const normalized =
      error instanceof SkillRepositoryError
        ? error
        : normalizeSkillRepositoryError(error, "public-detail");
    return json(
      { ok: false, code: normalized.code, error: normalized.message, operation: normalized.operation },
      normalized.status,
    );
  }
}
