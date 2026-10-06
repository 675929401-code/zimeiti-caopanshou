import { NextRequest, NextResponse } from "next/server";
import { getTokenFromHeaders } from "@/lib/auth";
import { verifyAdminToken } from "@/lib/admin-auth";
import { loadManjuPromptRegistry } from "@/lib/server/manju-prompt-registry";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Authorization, Cookie",
} as const;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: PRIVATE_NO_STORE_HEADERS,
  });
}

export async function GET(request: NextRequest) {
  const token = getTokenFromHeaders(request.headers);
  if (!token) {
    return json({ ok: false, code: "AUTH_REQUIRED", error: "未登录" }, 401);
  }

  const actor = await verifyAdminToken(token);
  if (!actor) {
    return json({ ok: false, code: "AUTH_INVALID", error: "登录状态无效或已过期" }, 401);
  }
  if (actor.role !== "admin") {
    return json({ ok: false, code: "ADMIN_REQUIRED", error: "仅管理员可查看提示词事实源" }, 403);
  }

  if (!process.env.COZE_SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return json(
      {
        ok: false,
        code: "PROMPT_REGISTRY_SERVICE_ROLE_REQUIRED",
        error: "提示词事实源暂时不可用",
      },
      503,
    );
  }

  try {
    const snapshot = await loadManjuPromptRegistry(getSupabaseAdminClient());
    return json(snapshot);
  } catch {
    return json(
      {
        ok: false,
        code: "PROMPT_REGISTRY_UNAVAILABLE",
        error: "提示词事实源暂时不可用",
      },
      503,
    );
  }
}
