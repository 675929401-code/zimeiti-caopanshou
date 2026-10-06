import { verifyTokenSignature, type JWTPayload } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";
import { isUserAuthSessionActive } from "@/lib/auth-session-store";

/** The database, not the three-day JWT claim, owns current administrator access. */
export interface CurrentAdminUser {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  status: string | null;
  is_active: boolean | null;
  display_name: string | null;
  member_status: string | null;
  credits: number;
  cash_balance: number;
  allowed_categories: string[] | null;
  session_id: string | null;
}

export type AdminAuthorizationResult =
  | { ok: true; actor: JWTPayload; user: CurrentAdminUser }
  | { ok: false; status: 401 | 403 | 503; code: string; error: string };

interface AdminAuthDependencies {
  verifySignature: (token: string) => Promise<JWTPayload | null>;
  findCurrentUser: (userId: string) => Promise<CurrentAdminUser | null>;
  isSessionActive?: (userId: string, sessionId: string) => Promise<{ ok: boolean; unavailable?: boolean }>;
}

/** Isolated dependency injection is for contract tests; production uses the default below. */
export function createAdminTokenAuthorizer(dependencies: AdminAuthDependencies) {
  return async (token: string | null | undefined): Promise<AdminAuthorizationResult> => {
    if (!token) {
      return { ok: false, status: 401, code: "AUTH_REQUIRED", error: "请先登录" };
    }
    let payload: JWTPayload | null;
    try {
      payload = await dependencies.verifySignature(token);
    } catch {
      payload = null;
    }
    if (!payload || typeof payload.userId !== "string" || !payload.userId.trim()) {
      return { ok: false, status: 401, code: "UNAUTHENTICATED", error: "登录状态无效或已过期" };
    }

    let user: CurrentAdminUser | null;
    try {
      // Never cache authorization by token: revocation must apply on the next request.
      user = await dependencies.findCurrentUser(payload.userId);
    } catch {
      // Do not leak database errors or fall back to the JWT's stale administrator role.
      return { ok: false, status: 503, code: "ADMIN_AUTH_UNAVAILABLE", error: "管理员权限校验暂不可用，请稍后重试" };
    }
    if (!user || user.id !== payload.userId) {
      return { ok: false, status: 401, code: "UNAUTHENTICATED", error: "账户不存在或登录状态无效" };
    }
    // A null legacy status is accepted only with explicit is_active=true.
    if (user.is_active !== true || (user.status != null && user.status !== "active")) {
      return { ok: false, status: 403, code: "ACCOUNT_DISABLED", error: "账户已停用，请联系管理员" };
    }
    if (user.role !== "admin") {
      return { ok: false, status: 403, code: "ADMIN_REQUIRED", error: "仅管理员可访问" };
    }
    const sandboxSession = process.env.NODE_ENV !== "production"
      && payload.sessionId?.startsWith("sandbox-") === true;
    if (!sandboxSession) {
      if (!payload.sessionId) {
        return { ok: false, status: 401, code: "SESSION_REVOKED", error: "登录状态已失效，请重新登录" };
      }
      let sessionResult: { ok: boolean; unavailable?: boolean };
      try {
        sessionResult = dependencies.isSessionActive
          ? await dependencies.isSessionActive(payload.userId, payload.sessionId)
          : { ok: Boolean(user.session_id && payload.sessionId === user.session_id) };
      } catch {
        sessionResult = { ok: false, unavailable: true };
      }
      if (!sessionResult.ok) {
        return sessionResult.unavailable
          ? { ok: false, status: 503, code: "ADMIN_AUTH_UNAVAILABLE", error: "管理员权限校验暂不可用，请稍后重试" }
          : { ok: false, status: 401, code: "SESSION_REVOKED", error: "登录状态已失效，请重新登录" };
      }
    }
    return {
      ok: true,
      user,
      actor: {
        ...payload,
        role: "admin",
        username: user.username || payload.username,
        displayName: user.display_name || payload.displayName,
      },
    };
  };
}

export const authorizeAdminToken = createAdminTokenAuthorizer({
  verifySignature: verifyTokenSignature,
  async findCurrentUser(userId) {
    const { data, error } = await getSupabaseAdminClient()
      .from("users")
      .select("id, username, email, role, status, is_active, display_name, member_status, credits, cash_balance, allowed_categories, session_id")
      .eq("id", userId)
      .abortSignal(AbortSignal.timeout(10_000))
      .maybeSingle();
    if (error) throw new Error("ADMIN_USER_LOOKUP_FAILED");
    return data as CurrentAdminUser | null;
  },
  async isSessionActive(userId, sessionId) {
    return isUserAuthSessionActive(getSupabaseAdminClient(), userId, sessionId);
  },
});

/** Compatibility bridge for legacy admin routes; failure never yields a principal. */
export async function verifyAdminToken(token: string): Promise<JWTPayload | null> {
  const result = await authorizeAdminToken(token);
  return result.ok ? result.actor : null;
}
