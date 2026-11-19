export const SESSION_ENDED_REASON = "登录状态已失效，请重新登录";

export const UNAVAILABLE_ACCOUNT_MESSAGES = {
  ACCOUNT_DISABLED: "账户已停用，请联系管理员",
  USER_DISABLED: "账户已停用，请联系管理员",
  USER_BLOCKED: "您的账户已被管理员拉黑",
  ROLE_INVALID: "账户权限无效",
} as const;

export async function readConfirmedSessionEnd(response: Response): Promise<string | null> {
  if (response.status !== 401 && response.status !== 403 && response.status !== 404) return null;

  const body = await response.json().catch(() => null);
  const code = body?.code;
  if (response.status === 401 && (code === "SESSION_REVOKED" || code === "UNAUTHENTICATED")) {
    return SESSION_ENDED_REASON;
  }
  if (response.status === 404 && code === "USER_NOT_FOUND") return SESSION_ENDED_REASON;
  if (response.status === 403 && typeof code === "string" && Object.hasOwn(UNAVAILABLE_ACCOUNT_MESSAGES, code)) {
    return UNAVAILABLE_ACCOUNT_MESSAGES[code as keyof typeof UNAVAILABLE_ACCOUNT_MESSAGES];
  }
  return null;
}
