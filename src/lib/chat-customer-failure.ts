type ChatFailurePayload = {
  code?: unknown;
  error?: unknown;
  retry_safe?: unknown;
  provider_call_started?: unknown;
  charged?: unknown;
};

/**
 * Maps only failures whose server-side execution outcome is explicit.
 * Ambiguous transport errors must continue through classifyError so the UI
 * blocks duplicate submission instead of pretending the message was unsent.
 */
export function knownChatFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as ChatFailurePayload;
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
