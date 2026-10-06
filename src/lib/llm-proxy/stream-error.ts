/** Public errors deliberately exclude provider payloads, URLs and credentials. */
export class LlmStreamError extends Error {
  constructor(message: string, readonly code = "LLM_UPSTREAM_ERROR") {
    super(message);
    this.name = "LlmStreamError";
  }
}

const CONTENT_REJECTION_TERMINAL_REASONS = new Set([
  "blocked",
  "content_filter",
  "content_filtered",
  "content_policy",
  "moderation",
  "refusal",
  "safety",
]);

function normalizedTerminalReason(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/gu, "_")
    : "";
}

/**
 * Providers sometimes return HTTP 200 and end the stream with a moderation
 * finish reason. That is a rejected answer, not a successful empty response.
 */
export function upstreamContentRejection(payload: unknown): LlmStreamError | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const choices = Array.isArray(row.choices) ? row.choices : [];
  const choice = choices[0] && typeof choices[0] === "object"
    ? choices[0] as Record<string, unknown>
    : {};
  const delta = choice.delta && typeof choice.delta === "object"
    ? choice.delta as Record<string, unknown>
    : {};
  const message = choice.message && typeof choice.message === "object"
    ? choice.message as Record<string, unknown>
    : {};
  const topLevelDelta = row.delta && typeof row.delta === "object"
    ? row.delta as Record<string, unknown>
    : {};
  const reasons = [
    row.finish_reason,
    row.stop_reason,
    choice.finish_reason,
    choice.stop_reason,
    delta.stop_reason,
    topLevelDelta.stop_reason,
  ].map(normalizedTerminalReason);
  const explicitRefusal = typeof message.refusal === "string" && message.refusal.trim().length > 0;
  if (!explicitRefusal && !reasons.some((reason) => CONTENT_REJECTION_TERMINAL_REASONS.has(reason))) return null;
  return new LlmStreamError("该模型未通过内容审核，请调整输入后重试", "LLM_UPSTREAM_CONTENT_REJECTED");
}

/** Failures before response headers may have reached the provider. Never retry them blindly. */
export function responseStartError(cause: unknown): LlmStreamError {
  if (cause instanceof LlmStreamError) return cause;
  const diagnostic = cause instanceof Error ? cause.message : String(cause);
  const status = diagnostic.match(/(?:LLM API|HTTP|status)[\s:=]+(4\d{2})\b/iu)?.[1];
  const knownRejection = (status && status !== "408")
    || /UPSTREAM_(?:QUOTA|BALANCE)_EXHAUSTED|ZHIPU_BALANCE_EXHAUSTED/iu.test(diagnostic);
  if (knownRejection) return upstreamStreamError({ error: diagnostic });
  return new LlmStreamError("这次回复未完成，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。", "LLM_UPSTREAM_RESULT_UNKNOWN");
}

export function upstreamStreamError(payload: unknown): LlmStreamError {
  const terminalRejection = upstreamContentRejection(payload);
  if (terminalRejection) return terminalRejection;
  const row = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const detail = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : row;
  const diagnostic = [detail.type, detail.code, detail.message, typeof row.error === "string" ? row.error : ""]
    .filter(value => typeof value === "string").join(" ");
  if (/insufficient[_\s-]*(?:user[_\s-]*)?quota|QUOTA_EXHAUSTED|balance|arrear|余额不足|欠费|无可用资源包|BALANCE_EXHAUSTED/iu.test(diagnostic)) {
    return new LlmStreamError("该模型的上游账户额度不足，请联系管理员或选择其他模型", "LLM_UPSTREAM_BALANCE");
  }
  if (/content[._\s-]*(?:filter|policy)|moderation|safety|refusal|blocked|敏感|审核|内容.*(?:拦截|拒绝)/iu.test(diagnostic)) {
    return new LlmStreamError("该模型未通过内容审核，请调整输入后重试", "LLM_UPSTREAM_CONTENT_REJECTED");
  }
  if (/invalid.*(?:key|token)|authentication|unauthorized|forbidden|LLM_UPSTREAM_AUTH|授权失效|401|403/iu.test(diagnostic)) {
    return new LlmStreamError("该模型的上游授权失效，请联系管理员检查配置", "LLM_UPSTREAM_AUTH");
  }
  if (/rate.limit|too.many|429|繁忙/iu.test(diagnostic)) {
    return new LlmStreamError("该模型上游服务暂时繁忙，请稍后重试", "LLM_UPSTREAM_BUSY");
  }
  if (/timeout|timed.out|超时/iu.test(diagnostic)) {
    return new LlmStreamError("该模型响应超时，未完成本次回复，请稍后重试", "LLM_UPSTREAM_TIMEOUT");
  }
  if (/interrupted|回复中断|连接中断/iu.test(diagnostic)) {
    return new LlmStreamError("该模型回复中断，未收到完整结果，请稍后重试", "LLM_STREAM_INTERRUPTED");
  }
  return new LlmStreamError("该模型上游服务暂时不可用，未完成本次回复，请稍后重试");
}
