type ChatFailurePayload = {
  code?: unknown;
  error?: unknown;
  retry_safe?: unknown;
  provider_call_started?: unknown;
  charged?: unknown;
};

/**
 * Maps stable server error codes to their account or channel owner.
 * Only LOCAL_BUILD_DRAINING with explicit evidence makes a no-charge claim.
 * Ambiguous transport errors must continue through classifyError so the UI
 * blocks duplicate submission instead of pretending the message was unsent.
 */
export function knownChatFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as ChatFailurePayload;
  // Stable server codes identify whose account needs attention. Never infer
  // site credits, provider acceptance, or charges from an HTTP status alone.
  const code = typeof payload.code === "string" ? payload.code : "";
  const detail = typeof payload.error === "string" ? payload.error
    : payload.error && typeof payload.error === "object" && "code" in payload.error && typeof payload.error.code === "string" ? payload.error.code : "";
  if (/RESULT_UNKNOWN|RECONCILIATION_REQUIRED|最终结果暂未确认/u.test(`${code} ${detail}`)) {
    return "与模型通道的连接中断，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。";
  }
  const messages: Record<string, string> = {
    INSUFFICIENT_CREDITS: "站内积分不足，当前无法发起这次回复。请补充站内积分后再试。",
    LLM_UPSTREAM_BALANCE: "模型中转账户余额或额度不足，请管理员补充额度后再发起新请求。",
    LLM_UPSTREAM_BILLING: "模型中转账户的额度或计费状态暂不可用，请管理员核对后再发起新请求。",
    LLM_UPSTREAM_AUTH: "模型中转通道授权失效，请管理员检查通道配置。",
    LLM_UPSTREAM_BUSY: "模型通道当前繁忙，本次未自动重试，请稍后再试。",
    LLM_UPSTREAM_CONCURRENCY_LIMIT: "模型通道当前排队已满，本次未自动重试，请稍后再试。",
  };
  if (Object.hasOwn(messages, code)) return messages[code];
  if (
    payload.code === "LOCAL_BUILD_DRAINING"
    && payload.retry_safe === true
    && payload.provider_call_started === false
    && payload.charged === false
  ) {
    return "本地版本正在更新，本次未调用模型或扣费。更新完成后可安全重新发送。";
  }
  return null;
}
