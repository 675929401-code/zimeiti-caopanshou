type DatabaseClient = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

export type SessionAuthorityResult =
  | { ok: true }
  | { ok: false; unavailable: boolean };

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
    if (error) return { ok: false, unavailable: true };
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
    if (error) return { ok: false, code: error.code || "SESSION_AUTHORITY_UNAVAILABLE" };
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
    if (error) return false;
    return (data as { ok?: boolean } | null)?.ok === true;
  } catch {
    return false;
  }
}
