type DatabaseClient = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string; code?: string; details?: string } | null }>;
};

export type SessionAuthorityResult =
  | { ok: true }
  | { ok: false; unavailable: boolean };

/**
 * 会话权威 schema 缺席判定（2026-10-08 R868 生产事故修复）。
 * 生产数据库尚未应用 user_auth_sessions 迁移时，PostgREST 返回
 * PGRST205（缺表）/ PGRST202（缺函数）。此时回退 legacy 单会话模型
 * （users.session_id，v2.23 生产验证过的行为），而不是把全站登录态
 * 打成 503。迁移应用后新权威自动接管，本回退不再触发。
 */
const SESSION_SCHEMA_ABSENT_CODES = new Set(["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"]);

function isSessionAuthoritySchemaAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; message?: string; details?: string };
  const code = String(value.code || "");
  const message = `${value.message || ""} ${value.details || ""}`;
  return SESSION_SCHEMA_ABSENT_CODES.has(code)
    || /user_auth_sessions|issue_user_auth_session|revoke_user_auth_session/iu.test(message);
}

async function legacySessionActive(
  client: DatabaseClient,
  userId: string,
  sessionId: string,
): Promise<SessionAuthorityResult> {
  try {
    if (!sessionId) return { ok: false, unavailable: false };
    const { data, error } = await client
      .from("users")
      .select("session_id")
      .eq("id", userId)
      .maybeSingle();
    if (error) return { ok: false, unavailable: true };
    return data?.session_id && data.session_id === sessionId
      ? { ok: true }
      : { ok: false, unavailable: false };
  } catch {
    return { ok: false, unavailable: true };
  }
}

async function legacyIssueSession(
  client: DatabaseClient,
  params: { userId: string; sessionId: string },
): Promise<{ ok: true; activeCount: number; evictedCount: number } | { ok: false; code: string }> {
  try {
    const { error } = await client
      .from("users")
      .update({ session_id: params.sessionId, updated_at: new Date().toISOString() })
      .eq("id", params.userId);
    if (error) return { ok: false, code: error.code || "LEGACY_SESSION_ISSUE_FAILED" };
    return { ok: true, activeCount: 1, evictedCount: 1 };
  } catch {
    return { ok: false, code: "LEGACY_SESSION_ISSUE_FAILED" };
  }
}

async function legacyRevokeSession(
  client: DatabaseClient,
  params: { userId: string; sessionId: string },
): Promise<boolean> {
  try {
    const { error } = await client
      .from("users")
      .update({ session_id: null, updated_at: new Date().toISOString() })
      .eq("id", params.userId)
      .eq("session_id", params.sessionId);
    return !error;
  } catch {
    return false;
  }
}

export async function isUserAuthSessionActive(
  client: DatabaseClient,
  userId: string,
  sessionId: string,
): Promise<SessionAuthorityResult> {
  try {
    const { data, error } = await client
      .from("user_auth_sessions")
      .select("session_id")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .limit(1)
      .maybeSingle();
    if (error) {
      if (isSessionAuthoritySchemaAbsent(error)) {
        return legacySessionActive(client, userId, sessionId);
      }
      return { ok: false, unavailable: true };
    }
    return data?.session_id === sessionId
      ? { ok: true }
      : { ok: false, unavailable: false };
  } catch {
    return { ok: false, unavailable: true };
  }
}

export async function issueUserAuthSession(
  client: DatabaseClient,
  params: {
    userId: string;
    sessionId: string;
    ipHash?: string | null;
    userAgentHash?: string | null;
    expiresAt?: string | null;
  },
): Promise<{ ok: true; activeCount: number; evictedCount: number } | { ok: false; code: string }> {
  try {
    const { data, error } = await client.rpc("issue_user_auth_session", {
      p_user_id: params.userId,
      p_session_id: params.sessionId,
      p_ip_hash: params.ipHash || null,
      p_user_agent_hash: params.userAgentHash || null,
      p_expires_at: params.expiresAt || null,
    });
    if (error) {
      if (isSessionAuthoritySchemaAbsent(error)) {
        return legacyIssueSession(client, params);
      }
      return { ok: false, code: error.code || "SESSION_AUTHORITY_UNAVAILABLE" };
    }
    const result = data as { ok?: boolean; code?: string; activeCount?: number; evictedCount?: number } | null;
    if (!result?.ok) return { ok: false, code: result?.code || "SESSION_ISSUE_FAILED" };
    return {
      ok: true,
      activeCount: Number(result.activeCount || 0),
      evictedCount: Number(result.evictedCount || 0),
    };
  } catch {
    return { ok: false, code: "SESSION_AUTHORITY_UNAVAILABLE" };
  }
}

export async function revokeUserAuthSession(
  client: DatabaseClient,
  params: { userId: string; sessionId: string; reason?: string },
): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("revoke_user_auth_session", {
      p_user_id: params.userId,
      p_session_id: params.sessionId,
      p_reason: params.reason || "logout",
    });
    if (error) {
      if (isSessionAuthoritySchemaAbsent(error)) {
        return legacyRevokeSession(client, params);
      }
      return false;
    }
    return (data as { ok?: boolean } | null)?.ok === true;
  } catch {
    return false;
  }
}
