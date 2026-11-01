/** Public errors deliberately exclude provider payloads, URLs and credentials. */
export class LlmStreamError extends Error {
  constructor(message: string, readonly code = "LLM_UPSTREAM_ERROR", readonly diagnostics?: unknown) {
    super(message);
    this.name = "LlmStreamError";
  }
}

/** Only these small, enumerated fields may cross the public SSE boundary. */
export interface LlmSafeDiagnostics {
  phase: "sse_event" | "response_headers";
  transportStatus?: number;
  providerCode?: string;
  providerType?: string;
  parameter?: string;
  elapsedMs?: number;
  receivedChars?: number;
}

const PROVIDER_ERROR_VALUES = new Set([
  "invalid_request_error", "invalid_request", "invalid_parameter", "unsupported_parameter", "unsupported_value",
  "model_not_found", "invalid_model", "quota", "insufficient_quota", "insufficient_user_quota",
  "quota_exceeded", "quota_exhausted", "balance", "insufficient_balance", "balance_exhausted",
  "permission", "permission_denied", "permission_error", "authentication_error", "invalid_api_key",
  "rate_limit", "rate_limit_error", "rate_limit_exceeded", "server_error", "api_error",
  "internal_server_error", "overloaded_error", "context_length", "context_length_exceeded",
  "gateway_concurrency_limit", "concurrency_limit_exceeded", "content_filter", "content_policy_violation",
  "new_api_error", "upstream_error", "response_error", "request_error", "gateway_error",
]);
const PROVIDER_PARAMETERS = new Set([
  "model", "max_tokens", "max_completion_tokens", "stream", "stream_options", "temperature",
  "response_format", "reasoning_effort", "messages", "top_p", "stop", "tools", "tool_choice",
  "frequency_penalty", "presence_penalty", "thinking", "stream_options.include_usage",
  "reasoning.effort", "thinking.type", "thinking.budget_tokens",
]);
function diagnosticRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Unwrap only the relay error envelopes supported by this boundary. */
function providerErrorRecords(payload: unknown): Record<string, unknown>[] {
  const row = diagnosticRecord(payload);
  const outer = diagnosticRecord(row.error);
  const nested = diagnosticRecord(outer.error);
  const response = diagnosticRecord(diagnosticRecord(row.response).error);
  return [row, outer, nested, response];
}
function providerErrorDetail(payload: unknown): Record<string, unknown> {
  // Some relays put request metadata in a deeper error envelope. Descend only
  // when that node actually contributes error semantics; metadata must not
  // erase an explicit outer quota/authentication rejection.
  return providerErrorRecords(payload).filter(row => [row.code, row.type, row.message]
    .some(value => typeof value === "string" && value.trim().length > 0)).at(-1) || diagnosticRecord(payload);
}
function boundedDiagnosticNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
    ? Math.trunc(value) : undefined;
}
function safeProviderValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return value.length <= 64 && PROVIDER_ERROR_VALUES.has(value) ? value : "unknown";
}

/** Rebuild instead of spreading untrusted objects, including diagnostics from an internal hop. */
export function sanitizeLlmSafeDiagnostics(value: unknown): Readonly<LlmSafeDiagnostics> | undefined {
  const row = diagnosticRecord(value);
  if (row.phase !== "sse_event" && row.phase !== "response_headers") return undefined;
  const result: LlmSafeDiagnostics = { phase: row.phase };
  const status = boundedDiagnosticNumber(row.transportStatus, 599);
  if (status !== undefined && status >= 100 && status === row.transportStatus) result.transportStatus = status;
  const code = safeProviderValue(row.providerCode);
  const type = safeProviderValue(row.providerType);
  if (code) result.providerCode = code;
  if (type) result.providerType = type;
  if (typeof row.parameter === "string" && row.parameter) {
    result.parameter = row.parameter.length <= 32 && PROVIDER_PARAMETERS.has(row.parameter) ? row.parameter : "unknown";
  }
  const elapsed = boundedDiagnosticNumber(row.elapsedMs, 86_400_000);
  const chars = boundedDiagnosticNumber(row.receivedChars, 100_000_000);
  if (elapsed !== undefined) result.elapsedMs = elapsed;
  if (chars !== undefined) result.receivedChars = chars;
  return Object.freeze(result);
}

/** Capture provider fields before generic mapping; supplied nested diagnostics are ignored. */
export function buildLlmSafeDiagnostics(payload: unknown, measured: LlmSafeDiagnostics): Readonly<LlmSafeDiagnostics> {
  const detail = providerErrorDetail(payload);
  return sanitizeLlmSafeDiagnostics({
    phase: measured.phase, transportStatus: measured.transportStatus,
    elapsedMs: measured.elapsedMs, receivedChars: measured.receivedChars,
    providerCode: detail.code, providerType: detail.type, parameter: detail.param,
  })!;
}

const RESPONSE_START_UNKNOWN_MESSAGE = "这次回复未完成，最终结果暂未确认。原请求已保留，请先查看聊天记录，避免重复发送。";

/** A local read failure says nothing about the provider's final execution state. */
export class LlmStreamReadError extends LlmStreamError {
  readonly diagnostics: Readonly<{
    phase: "response_body";
    outcome: "idle_deadline_exceeded" | "transport_error" | "incomplete_eof";
  }>;

  constructor(outcome: "idle_deadline_exceeded" | "transport_error" | "incomplete_eof") {
    super(RESPONSE_START_UNKNOWN_MESSAGE, "LLM_UPSTREAM_RESULT_UNKNOWN");
    this.name = "LlmStreamReadError";
    this.diagnostics = Object.freeze({
      phase: "response_body",
      outcome: outcome === "idle_deadline_exceeded" || outcome === "incomplete_eof" ? outcome : "transport_error",
    });
  }
}

/** Internal response-header diagnostics contain only measured, allowlisted fields. */
export class LlmResponseStartError extends LlmStreamError {
  readonly diagnostics: Readonly<{
    phase: "response_headers";
    outcome: "deadline_exceeded" | "transport_error";
    elapsedMs: number;
    timeoutMs: number;
  }>;

  constructor(outcome: "deadline_exceeded" | "transport_error", elapsedMs: number, timeoutMs: number) {
    super(RESPONSE_START_UNKNOWN_MESSAGE, "LLM_UPSTREAM_RESULT_UNKNOWN");
    this.name = "LlmResponseStartError";
    this.diagnostics = Object.freeze({
      phase: "response_headers",
      outcome: outcome === "deadline_exceeded" ? "deadline_exceeded" : "transport_error",
      elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.trunc(elapsedMs)) : 0,
      timeoutMs: Number.isFinite(timeoutMs) ? Math.max(0, Math.trunc(timeoutMs)) : 0,
    });
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
  const safe = sanitizeLlmSafeDiagnostics(diagnosticRecord(cause).diagnostics);
  const status = safe?.transportStatus ?? Number(diagnostic.match(/(?:LLM API|HTTP|status)[\s:=]+(4\d{2})\b/iu)?.[1]);
  const knownRejection = (status >= 400 && status < 500 && status !== 408)
    || /UPSTREAM_(?:QUOTA|BALANCE)_EXHAUSTED|ZHIPU_BALANCE_EXHAUSTED/iu.test(diagnostic);
  const failure = knownRejection ? classifyUpstreamStreamError({ error: diagnostic }, status)
    : new LlmStreamError(RESPONSE_START_UNKNOWN_MESSAGE, "LLM_UPSTREAM_RESULT_UNKNOWN");
  return safe ? new LlmStreamError(failure.message, failure.code, safe) : failure;
}

export function upstreamStreamError(payload: unknown, measured?: LlmSafeDiagnostics): LlmStreamError {
  const safe = measured ? buildLlmSafeDiagnostics(payload, measured)
    : sanitizeLlmSafeDiagnostics(diagnosticRecord(payload).diagnostics);
  const failure = classifyUpstreamStreamError(payload, safe?.transportStatus);
  return safe ? new LlmStreamError(failure.message, failure.code, safe) : failure;
}

function classifyUpstreamStreamError(payload: unknown, transportStatus?: number): LlmStreamError {
  const row = diagnosticRecord(payload);
  const records = providerErrorRecords(payload);
  // Proxy errors cross an internal SSE boundary before the durable attempt is
  // finalized. Preserve uncertainty rather than reclassifying its safe message.
  if (records.some(detail => detail.code === "LLM_UPSTREAM_RESULT_UNKNOWN")) {
    return new LlmStreamError(RESPONSE_START_UNKNOWN_MESSAGE, "LLM_UPSTREAM_RESULT_UNKNOWN");
  }
  const terminalRejection = upstreamContentRejection(payload);
  if (terminalRejection) return terminalRejection;
  const detail = providerErrorDetail(payload);
  const diagnostic = [detail.type, detail.code, detail.message, typeof row.error === "string" ? row.error : ""]
    .filter(value => typeof value === "string").join(" ");
  if (/insufficient[_\s-]*(?:user[_\s-]*)?quota|QUOTA_EXHAUSTED|balance|arrear|余额不足|预扣费额度失败|欠费|无可用资源包|BALANCE_EXHAUSTED/iu.test(diagnostic)) {
    return new LlmStreamError("模型中转账户余额或额度不足，请管理员补充额度后再发起新请求。", "LLM_UPSTREAM_BALANCE");
  }
  if (transportStatus === 402 || detail.code === "LLM_UPSTREAM_BILLING") {
    return new LlmStreamError("模型中转账户的额度或计费状态暂不可用，请管理员核对后再发起新请求。", "LLM_UPSTREAM_BILLING");
  }
  if (/content[._\s-]*(?:filter|policy)|moderation|safety|refusal|blocked|敏感|审核|内容.*(?:拦截|拒绝)/iu.test(diagnostic)) {
    return new LlmStreamError("该模型未通过内容审核，请调整输入后重试", "LLM_UPSTREAM_CONTENT_REJECTED");
  }
  if (/invalid.*(?:key|token)|authentication|unauthorized|forbidden|LLM_UPSTREAM_AUTH|授权失效|401|403/iu.test(diagnostic)) {
    return new LlmStreamError("该模型的上游授权失效，请联系管理员检查配置", "LLM_UPSTREAM_AUTH");
  }
  // Relay gateways accept the HTTP request (200) and only then reject the SSE
  // stream while the account's concurrency slot is busy. That is a queue
  // rejection, not a model fault, and nothing has been generated yet.
  if (/gateway[_ -]?concurrency|concurrency[._\s-]*limit|concurrency limit exceeded|排队已满|通道排队/iu.test(diagnostic)) {
    return new LlmStreamError("该模型上游通道排队已满，请稍后重试", "LLM_UPSTREAM_CONCURRENCY_LIMIT");
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

/**
 * Server-only summary of a provider error. Never returns raw text, arbitrary
 * field names, URLs, identifiers or provider-supplied nested diagnostics.
 * Categories are diagnostic hypotheses from explicit error text, not proof of
 * billing outcome; callers keep the existing terminal and retry decisions.
 */
export function summarizeLlmProviderFailure(payload: unknown, fingerprint: (text: string) => string) {
  const row = diagnosticRecord(payload);
  const outer = diagnosticRecord(row.error);
  const response = diagnosticRecord(row.response);
  let location = "root";
  let detail = row;
  if (outer.error && typeof outer.error === "object") { location = "error.error"; detail = diagnosticRecord(outer.error); }
  else if (response.error && typeof response.error === "object") { location = "response.error"; detail = diagnosticRecord(response.error); }
  else if (row.error && typeof row.error === "object") { location = "error"; detail = outer; }
  const message = typeof detail.message === "string" ? detail.message
    : typeof row.error === "string" ? row.error : "";
  const type = typeof detail.type === "string" ? detail.type : "";
  const code = typeof detail.code === "string" ? detail.code : "";
  const diagnostic = [type, code, message].join(" ").slice(0, 131072);
  const categories: Array<[string, RegExp]> = [
    ["channel_unavailable", /no available channel|no available provider|no available account|无可用渠道|无可用账号|渠道.*不可用|distributor/iu],
    ["context_limit", /context[._ -]*length|maximum context|context window|上下文.*(?:超|长|限制)/iu],
    ["output_limit", /(?:max[_ -]*(?:completion[_ -]*)?tokens|output tokens).*(?:exceed|maximum|limit|large)|输出.*(?:上限|超限)/iu],
    ["unsupported_parameter", /unsupported.*(?:parameter|value)|unknown parameter|unrecognized.*(?:field|parameter)|not permitted|不支持.*参数/iu],
    ["invalid_request", /invalid[_ -]*request|bad request|validation error|malformed|请求.*(?:格式|参数).*错误/iu],
    ["model_unavailable", /model.*(?:not found|does not exist|not supported|unavailable)|invalid model|模型.*(?:不存在|不支持|不可用)/iu],
    ["quota", /insufficient.*(?:quota|balance)|quota.*(?:exceed|exhaust)|余额不足|预扣费|无可用资源包/iu],
    ["authentication", /invalid.*(?:key|token)|authentication|unauthorized|forbidden|授权失效/iu],
    ["concurrency", /concurrency|并发|排队已满/iu],
    ["rate_limit", /rate[._ -]*limit|too many requests|限流/iu],
    ["content_policy", /content[._ -]*(?:filter|policy)|moderation|safety|refusal|内容.*(?:审核|拒绝|拦截)/iu],
    ["timeout", /timeout|timed out|超时/iu],
    ["transport", /disconnect|connection.*(?:reset|closed)|socket|broken pipe|unexpected eof|incomplete stream|连接.*(?:中断|关闭)/iu],
    ["response_processing", /(?:process|pars|decod|convert).*response|response.*(?:process|pars|decod|convert)|处理.*响应/iu],
    ["upstream_unavailable", /service.*unavailable|bad gateway|upstream.*(?:error|failed)|internal.*error|server error|服务.*不可用/iu],
  ];
  const category = categories.find(([, pattern]) => pattern.test(diagnostic))?.[0]
    || (diagnostic.trim() ? "unclassified" : "missing_error_detail");
  const valueType = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array"
    : ["string", "number", "boolean", "object", "undefined"].includes(typeof value) ? typeof value : "other";
  const shape = Object.fromEntries(["message", "type", "code", "param", "status", "status_code"].map(key => [key, valueType(detail[key])]));
  const digest = (value: string) => {
    if (!value) return undefined;
    const result = fingerprint(value);
    return /^[a-f0-9]{64}$/u.test(result) ? result : undefined;
  };
  const numericCode = boundedDiagnosticNumber(detail.code, 999999);
  return Object.freeze({
    category, location, shape, messageChars: message.length, typeChars: type.length,
    messageSha256: digest(message), typeSha256: digest(type), codeSha256: digest(code),
    ...(numericCode !== undefined && numericCode === detail.code ? { numericCode } : {}),
  });
}
