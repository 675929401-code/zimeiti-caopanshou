export const RELIABLE_SECURITY_EVENT_TYPES = [
  "rate_limit",
  "brute_force",
  "bot_detected",
  "sql_injection",
  "xss_attempt",
  "path_traversal",
  "prompt_injection",
  "unauthorized_access",
  "suspicious_behavior",
  "api_abuse",
] as const;

export const RELIABLE_SECURITY_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const RELIABLE_SECURITY_SOURCES = ["user_client", "admin_panel", "api_direct", "anonymous"] as const;

export type ReliableSecurityEventType = (typeof RELIABLE_SECURITY_EVENT_TYPES)[number];
export type ReliableSecurityRiskLevel = (typeof RELIABLE_SECURITY_RISK_LEVELS)[number];
export type ReliableSecuritySource = (typeof RELIABLE_SECURITY_SOURCES)[number];

export interface ParsedReliableSecurityEvent {
  eventType: ReliableSecurityEventType;
  riskLevel: ReliableSecurityRiskLevel;
  ip: string;
  userAgent: string;
  path: string;
  method: string;
  details: string;
  blocked: boolean;
  source: ReliableSecuritySource;
  actorReference: string;
}

export class SecurityEventReliabilityValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SecurityEventReliabilityValidationError";
  }
}

const ALLOWED_KEYS = new Set([
  "event_type",
  "risk_level",
  "ip",
  "user_agent",
  "path",
  "method",
  "details",
  "blocked",
  "source",
  "user_id",
  "username",
  "display_name",
  "phone",
]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?)\s*:\/\/[^\s]+/giu;
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu;
const SECRET_HEADER = /\b(?:authorization|cookie)\s*:\s*[^\r\n]+/giu;
const SECRET_ASSIGNMENT = /\b(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization|cookie)["']?\s*[:=]\s*[^,;\r\n]+/giu;
const SIGNED_QUERY = /([?&](?:token|access_token|signature|sig|credential|x-amz-[^=&#\s]+|x-goog-[^=&#\s]+|q-sign-[^=&#\s]+)=)[^&#\s]+/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE = /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu;
const IPV4 = /(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/gu;
const LONG_IDENTIFIER = /\b[0-9a-f]{24,}\b/giu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityEventReliabilityValidationError("安全事件必须是对象", "SECURITY_EVENT_INPUT_INVALID");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new SecurityEventReliabilityValidationError("安全事件包含未支持字段", "SECURITY_EVENT_FIELD_UNKNOWN");
  }
  return result;
}

function optionalString(value: unknown, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    CONTROL_CHARACTERS.lastIndex = 0;
    throw new SecurityEventReliabilityValidationError("安全事件字段无效", "SECURITY_EVENT_INPUT_INVALID");
  }
  CONTROL_CHARACTERS.lastIndex = 0;
  return value.trim();
}

export function redactReliableSecurityText(value: unknown, maximum = 500): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONNECTION_STRING, "[REDACTED_CONNECTION]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_HEADER, "[REDACTED_SECRET]")
    .replace(SECRET_ASSIGNMENT, "[REDACTED_SECRET]")
    .replace(SIGNED_QUERY, (_match, prefix: string) => `${prefix[0]}[REDACTED_QUERY]`)
    .replace(EMAIL, "[REDACTED_EMAIL]")
    .replace(PHONE, "[REDACTED_PHONE]")
    .replace(IPV4, "[REDACTED_IP]")
    .replace(LONG_IDENTIFIER, "[REDACTED_IDENTIFIER]")
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, maximum);
}

export function normalizeReliableSecurityPath(value: unknown): string {
  const path = optionalString(value, 1_024).split(/[?#]/u, 1)[0] || "";
  return redactReliableSecurityText(path, 500)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, ":uuid")
    .replace(/\/(?:\d{4,})(?=\/|$)/gu, "/:id");
}

export function parseReliableSecurityIdempotencyKey(value: string | null): string | null {
  if (!value) return null;
  const key = value.trim();
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new SecurityEventReliabilityValidationError("幂等键无效", "SECURITY_EVENT_IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

export function parseReliableSecurityEvent(value: unknown): ParsedReliableSecurityEvent {
  const input = record(value);
  if (typeof input.event_type !== "string" || !RELIABLE_SECURITY_EVENT_TYPES.includes(input.event_type as ReliableSecurityEventType)) {
    throw new SecurityEventReliabilityValidationError("安全事件类型无效", "SECURITY_EVENT_TYPE_INVALID");
  }
  const riskLevel = input.risk_level ?? "medium";
  const source = input.source ?? "anonymous";
  const blocked = input.blocked ?? true;
  if (typeof riskLevel !== "string" || !RELIABLE_SECURITY_RISK_LEVELS.includes(riskLevel as ReliableSecurityRiskLevel)) {
    throw new SecurityEventReliabilityValidationError("风险等级无效", "SECURITY_EVENT_RISK_INVALID");
  }
  if (typeof source !== "string" || !RELIABLE_SECURITY_SOURCES.includes(source as ReliableSecuritySource)) {
    throw new SecurityEventReliabilityValidationError("事件来源无效", "SECURITY_EVENT_SOURCE_INVALID");
  }
  if (typeof blocked !== "boolean") {
    throw new SecurityEventReliabilityValidationError("拦截状态无效", "SECURITY_EVENT_INPUT_INVALID");
  }

  const method = optionalString(input.method, 32).toUpperCase();
  if (method && !/^[A-Z]{3,10}$/u.test(method)) {
    throw new SecurityEventReliabilityValidationError("请求方法无效", "SECURITY_EVENT_INPUT_INVALID");
  }
  const userId = optionalString(input.user_id, 128);
  const username = optionalString(input.username, 128);
  const phone = optionalString(input.phone, 32);
  return {
    eventType: input.event_type as ReliableSecurityEventType,
    riskLevel: riskLevel as ReliableSecurityRiskLevel,
    ip: optionalString(input.ip, 64),
    userAgent: optionalString(input.user_agent, 512),
    path: normalizeReliableSecurityPath(input.path),
    method,
    details: redactReliableSecurityText(optionalString(input.details, 2_048), 500),
    blocked,
    source: source as ReliableSecuritySource,
    actorReference: userId || username || phone,
  };
}
