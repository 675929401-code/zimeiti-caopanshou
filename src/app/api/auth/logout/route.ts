import { NextResponse } from "next/server";
import { COMMERCE_MAIN_SESSION_COOKIE, revokeSession as revokeCommerceSession } from "@/commerce/server/auth";
import { getTokenFromHeaders, verifyTokenSignature } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { revokeUserAuthSession } from "@/lib/auth-session-store";

export async function POST(request: Request) {
  revokeCommerceSession(request);
  let serverSessionRevoked = true;
  const token = getTokenFromHeaders(request.headers);
  if (token) {
    const payload = await verifyTokenSignature(token);
    if (payload?.userId && payload.sessionId && !payload.sessionId.startsWith("sandbox-")) {
      try {
        serverSessionRevoked = await revokeUserAuthSession(getSupabaseAdminClient(), {
          userId: payload.userId,
          sessionId: payload.sessionId,
          reason: "logout",
        });
      } catch {
        serverSessionRevoked = false;
      }
    }
  }
  const response = NextResponse.json(
    serverSessionRevoked
      ? { success: true }
      : { success: false, error: "服务器会话暂未撤销，请稍后再次退出", code: "SESSION_REVOKE_FAILED" },
    { status: serverSessionRevoked ? 200 : 503 },
  );
  response.cookies.set("auth_token", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  response.cookies.set(COMMERCE_MAIN_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return response;
}
