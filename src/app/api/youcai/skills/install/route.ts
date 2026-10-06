import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTokenFromHeaders, verifyToken } from "@/lib/auth";
import { InstallSkillRequestSchema, type SkillActor } from "@/lib/server/skill-package-contract";
import {
  SkillRepositoryError,
  installUserSkill,
  normalizeSkillRepositoryError,
} from "@/lib/server/skill-package-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

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

function invalid(error: z.ZodError): NextResponse {
  return json(
    {
      ok: false,
      code: "INVALID_REQUEST",
      error: "安装参数不合法",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
    400,
  );
}

export async function POST(request: NextRequest) {
  const actor = await requireActor(request);
  if (actor instanceof NextResponse) return actor;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "INVALID_JSON", error: "请求体不是有效 JSON" }, 400);
  }
  const parsed = InstallSkillRequestSchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const installation = await installUserSkill({
      actor,
      packageId: parsed.data.packageId,
      versionId: parsed.data.versionId,
      enabled: parsed.data.enabled,
      priority: parsed.data.priority,
      installConfig: parsed.data.installConfig,
    });
    return json({ ok: true, installation }, 200);
  } catch (error) {
    const normalized =
      error instanceof SkillRepositoryError
        ? error
        : normalizeSkillRepositoryError(error, "install");
    return json(
      { ok: false, code: normalized.code, error: normalized.message, operation: normalized.operation },
      normalized.status,
    );
  }
}

