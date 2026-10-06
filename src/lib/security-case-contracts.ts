export const SECURITY_CASE_STATUSES = [
  "open",
  "triaged",
  "assigned",
  "mitigating",
  "monitoring",
  "resolved",
  "false_positive",
] as const;

export const SECURITY_CASE_RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const SECURITY_CASE_SOURCE_KINDS = [
  "security_event",
  "prompt_guard_log",
  "login_log",
  "operation_flight_event",
] as const;
export const SECURITY_CASE_ENTITY_TYPES = [
  "user",
  "session",
  "ip_hash",
  "route",
  "trace",
  "credential",
  "channel",
] as const;
export const SECURITY_CASE_ACTION_TYPES = ["revoke_session", "disable_user"] as const;

export type SecurityCaseStatus = (typeof SECURITY_CASE_STATUSES)[number];
export type SecurityCaseRiskLevel = (typeof SECURITY_CASE_RISK_LEVELS)[number];
export type SecurityCaseSourceKind = (typeof SECURITY_CASE_SOURCE_KINDS)[number];
export type SecurityCaseEntityType = (typeof SECURITY_CASE_ENTITY_TYPES)[number];
export type SecurityCaseActionType = (typeof SECURITY_CASE_ACTION_TYPES)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?)\s*:\/\/[^\s]+/giu;
const BEARER_TOKEN = /\bbearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/giu;
const SECRET_ASSIGNMENT = /\b(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|authorization|cookie)\s*[:=]\s*([^\s,;]+)/giu;
const SIGNED_QUERY = /([?&](?:token|access_token|signature|sig|credential|x-amz-[^=&#\s]+|q-sign-[^=&#\s]+)=)[^&#\s]+/giu;

export class SecurityCaseValidationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SecurityCaseValidationError";
  }
}

function objectRecord(value: unknown, code = "SECURITY_CASE_INPUT_INVALID"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SecurityCaseValidationError("请求体必须是对象", code);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowlist = new Set(allowed);
  if (Object.keys(record).some((key) => !allowlist.has(key))) {
    throw new SecurityCaseValidationError("请求包含未支持字段", "SECURITY_CASE_FIELD_UNKNOWN");
  }
}

function requiredString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string") {
    throw new SecurityCaseValidationError(`${label}无效`, "SECURITY_CASE_INPUT_INVALID");
  }
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) {
    throw new SecurityCaseValidationError(`${label}无效`, "SECURITY_CASE_INPUT_INVALID");
  }
  return normalized;
}

export function redactSecurityCaseText(value: unknown, maximum = 500): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONNECTION_STRING, "[REDACTED_CONNECTION]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(SIGNED_QUERY, "$1[REDACTED]")
    .replace(CONTROL_CHARACTERS, " ")
    .trim()
    .slice(0, maximum);
}

export function parseSecurityCaseId(value: unknown): string {
  const id = requiredString(value, "案件 ID", 36, 36);
  if (!UUID_PATTERN.test(id)) {
    throw new SecurityCaseValidationError("案件 ID 无效", "SECURITY_CASE_ID_INVALID");
  }
  return id.toLowerCase();
}

export function parseSecurityCaseRevision(value: unknown): number {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new SecurityCaseValidationError("必须提供当前案件版本", "SECURITY_CASE_REVISION_REQUIRED");
  }
  return revision;
}

export function parseSecurityCaseSource(value: unknown): SecurityCaseSourceKind {
  if (typeof value !== "string" || !SECURITY_CASE_SOURCE_KINDS.includes(value as SecurityCaseSourceKind)) {
    throw new SecurityCaseValidationError("安全事件来源无效", "SECURITY_CASE_SOURCE_INVALID");
  }
  return value as SecurityCaseSourceKind;
}

export function parseSecurityCaseStatus(value: unknown): SecurityCaseStatus {
  if (typeof value !== "string" || !SECURITY_CASE_STATUSES.includes(value as SecurityCaseStatus)) {
    throw new SecurityCaseValidationError("案件状态无效", "SECURITY_CASE_STATUS_INVALID");
  }
  return value as SecurityCaseStatus;
}

export function parseSecurityCaseEntityType(value: unknown): SecurityCaseEntityType {
  if (typeof value !== "string" || !SECURITY_CASE_ENTITY_TYPES.includes(value as SecurityCaseEntityType)) {
    throw new SecurityCaseValidationError("关联实体类型无效", "SECURITY_CASE_ENTITY_INVALID");
  }
  return value as SecurityCaseEntityType;
}

export function parseSecurityCaseActionType(value: unknown): SecurityCaseActionType {
  if (typeof value !== "string" || !SECURITY_CASE_ACTION_TYPES.includes(value as SecurityCaseActionType)) {
    throw new SecurityCaseValidationError("处置动作不在白名单中", "SECURITY_CASE_ACTION_NOT_ALLOWED");
  }
  return value as SecurityCaseActionType;
}

export function parseSecurityCaseReference(value: unknown, label = "目标引用"): string {
  const reference = requiredString(value, label, 1, 200);
  if (!REFERENCE_PATTERN.test(reference)) {
    throw new SecurityCaseValidationError(`${label}格式无效`, "SECURITY_CASE_REFERENCE_INVALID");
  }
  return reference;
}

export function parseSecurityCaseReason(value: unknown, required = true): string {
  const raw = requiredString(value, "操作原因", required ? 3 : 0, 500);
  const redacted = redactSecurityCaseText(raw, 500);
  if (required && redacted.length < 3) {
    throw new SecurityCaseValidationError("操作原因至少 3 个字符", "SECURITY_CASE_REASON_REQUIRED");
  }
  return redacted;
}

export function parseSecurityCaseRequestKey(value: unknown): string {
  const key = requiredString(value, "幂等键", 8, 200);
  if (!REQUEST_KEY_PATTERN.test(key)) {
    throw new SecurityCaseValidationError("幂等键格式无效", "SECURITY_CASE_IDEMPOTENCY_KEY_INVALID");
  }
  return key;
}

export interface SecurityCaseIngestRequest {
  sourceKind: SecurityCaseSourceKind;
  sourceEventId: string;
}

export function parseSecurityCaseIngestRequest(value: unknown): SecurityCaseIngestRequest {
  const record = objectRecord(value);
  exactKeys(record, ["sourceKind", "sourceEventId"]);
  return {
    sourceKind: parseSecurityCaseSource(record.sourceKind),
    sourceEventId: parseSecurityCaseReference(record.sourceEventId, "来源事件 ID"),
  };
}

export type SecurityCaseMutationRequest =
  | { operation: "claim"; expectedRevision: number; reason: string }
  | { operation: "transition"; expectedRevision: number; targetStatus: SecurityCaseStatus; reason: string }
  | {
      operation: "link-entity";
      expectedRevision: number;
      entityType: SecurityCaseEntityType;
      entityRef: string;
      entityLabel: string;
      reason: string;
    };

export function parseSecurityCaseMutationRequest(value: unknown): SecurityCaseMutationRequest {
  const record = objectRecord(value);
  const operation = requiredString(record.operation, "案件操作", 1, 32);
  if (operation === "claim") {
    exactKeys(record, ["operation", "expectedRevision", "reason"]);
    return {
      operation,
      expectedRevision: parseSecurityCaseRevision(record.expectedRevision),
      reason: parseSecurityCaseReason(record.reason),
    };
  }
  if (operation === "transition") {
    exactKeys(record, ["operation", "expectedRevision", "targetStatus", "reason"]);
    const targetStatus = parseSecurityCaseStatus(record.targetStatus);
    if (targetStatus === "open" || targetStatus === "assigned") {
      throw new SecurityCaseValidationError("目标状态必须通过允许的状态迁移到达", "SECURITY_CASE_OPERATION_INVALID");
    }
    return {
      operation,
      expectedRevision: parseSecurityCaseRevision(record.expectedRevision),
      targetStatus,
      reason: parseSecurityCaseReason(record.reason),
    };
  }
  if (operation === "link-entity") {
    exactKeys(record, ["operation", "expectedRevision", "entityType", "entityRef", "entityLabel", "reason"]);
    return {
      operation,
      expectedRevision: parseSecurityCaseRevision(record.expectedRevision),
      entityType: parseSecurityCaseEntityType(record.entityType),
      entityRef: parseSecurityCaseReference(record.entityRef, "实体引用"),
      entityLabel: redactSecurityCaseText(requiredString(record.entityLabel, "实体标签", 0, 120), 120),
      reason: parseSecurityCaseReason(record.reason),
    };
  }
  throw new SecurityCaseValidationError("不支持的案件操作", "SECURITY_CASE_OPERATION_INVALID");
}

export type SecurityCaseActionRequest =
  | {
      operation: "preview";
      expectedRevision: number;
      actionType: SecurityCaseActionType;
      targetRef: string;
      reason: string;
    }
  | {
      operation: "request";
      expectedRevision: number;
      actionType: SecurityCaseActionType;
      targetRef: string;
      reason: string;
    }
  | {
      operation: "cancel";
      actionId: string;
      expectedActionRevision: number;
      reason: string;
    };

export function parseSecurityCaseActionRequest(value: unknown): SecurityCaseActionRequest {
  const record = objectRecord(value);
  const operation = requiredString(record.operation, "动作操作", 1, 32);
  if (operation === "preview" || operation === "request") {
    exactKeys(record, ["operation", "expectedRevision", "actionType", "targetRef", "reason"]);
    return {
      operation,
      expectedRevision: parseSecurityCaseRevision(record.expectedRevision),
      actionType: parseSecurityCaseActionType(record.actionType),
      targetRef: parseSecurityCaseReference(record.targetRef),
      reason: parseSecurityCaseReason(record.reason),
    };
  }
  if (operation === "cancel") {
    exactKeys(record, ["operation", "actionId", "expectedActionRevision", "reason"]);
    const expectedActionRevision = typeof record.expectedActionRevision === "number"
      ? record.expectedActionRevision
      : Number(record.expectedActionRevision);
    if (!Number.isSafeInteger(expectedActionRevision) || expectedActionRevision < 1) {
      throw new SecurityCaseValidationError("必须提供当前动作版本", "SECURITY_CASE_ACTION_REVISION_REQUIRED");
    }
    return {
      operation,
      actionId: parseSecurityCaseId(record.actionId),
      expectedActionRevision,
      reason: parseSecurityCaseReason(record.reason),
    };
  }
  throw new SecurityCaseValidationError("不支持的动作操作", "SECURITY_CASE_ACTION_OPERATION_INVALID");
}

export function boundedSecurityCasePage(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}
