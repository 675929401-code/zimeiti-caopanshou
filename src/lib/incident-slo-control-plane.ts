export const INCIDENT_SLO_MIGRATION = "20261002170000" as const;

export const INCIDENT_SLO_SOURCE_BOUNDARIES = [
  {
    source: "health_checks",
    state: "not_connected",
    note: "Existing diagnostic snapshots are not measurement windows.",
  },
  {
    source: "system_logs",
    state: "not_connected",
    note: "Existing log counts are not alert or incident state.",
  },
  {
    source: "diagnostic_logs",
    state: "not_connected",
    note: "Browser diagnostic reports remain an independent workflow.",
  },
  {
    source: "operation_flight_events",
    state: "not_connected",
    note: "The append-only flight recorder remains independent.",
  },
  {
    source: "worker_and_queue_runtime",
    state: "not_connected",
    note: "Process-local worker snapshots and workload-specific leases have no shared heartbeat source.",
  },
  {
    source: "admin_command_center",
    state: "not_connected",
    note: "The command center remains a bounded read model and does not create SLO state.",
  },
] as const;

export const INCIDENT_SLO_ACTION_KINDS = [
  "read_only_probe",
  "resume_side_effect_free_polling",
  "pause_confirmed_fault_channel",
] as const;

export const INCIDENT_SLO_PROBE_KINDS = [
  "read_only_health",
  "read_only_consistency",
  "worker_heartbeat",
  "external_dependency_read",
] as const;

type UnknownRecord = Record<string, unknown>;

export interface IncidentSloTableCounts {
  services: number;
  definitions: number;
  measurements: number;
  alerts: number;
  incidents: number;
  incidentEvents: number;
  maintenanceWindows: number;
  recoveryProbes: number;
  postmortems: number;
  actionRequests: number;
  auditEvents: number;
}

export interface IncidentSloDefinitionStatus {
  serviceKey: string;
  sloKey: string;
  indicatorKind: string;
  objectiveRatio: number;
  objectiveWindowSeconds: number;
  sourceStatus: "available" | "partial" | "unavailable";
  value: number | null;
  asOf: string | null;
  freshnessSeconds: number | null;
  coverageRatio: number | null;
  partial: boolean;
  measurementId: string | null;
}

export interface IncidentSloDatabaseStatus {
  schemaVersion: 1;
  migration: typeof INCIDENT_SLO_MIGRATION;
  asOf: string;
  tableCounts: IncidentSloTableCounts;
  measurements: { available: number; partial: number; unavailable: number };
  alerts: { open: number; acknowledged: number; suppressed: number; resolved: number };
  incidents: { active: number; resolved: number; falsePositive: number; leased: number };
  actions: {
    previewed: number;
    requested: number;
    executorAvailable: false;
    paidExecutionEnabled: false;
    serviceRestartEnabled: false;
    productionRemediationEnabled: false;
  };
  definitions: IncidentSloDefinitionStatus[];
}

export interface IncidentSloStatus {
  schemaVersion: 1;
  controlPlane: "incident_slo";
  phase: "foundation_only";
  migrationApplied: true;
  database: IncidentSloDatabaseStatus;
  integration: {
    collectorsConnected: false;
    alertNotificationConnected: false;
    commandCenterConnected: false;
    workerHeartbeatConnected: false;
    actionExecutorConnected: false;
    postmortemPublisherConnected: false;
    connectedSources: [];
    pendingSources: typeof INCIDENT_SLO_SOURCE_BOUNDARIES;
  };
  executionPolicy: {
    registrationOnly: true;
    executorAvailable: false;
    paidExecutionEnabled: false;
    serviceRestartEnabled: false;
    productionRemediationEnabled: false;
  };
}

export type IncidentSloErrorCode =
  | "INCIDENT_SLO_SCHEMA_REQUIRED"
  | "INCIDENT_SLO_STATUS_INVALID"
  | "INCIDENT_SLO_STATUS_UNAVAILABLE"
  | "INCIDENT_SLO_REQUEST_INVALID"
  | "INCIDENT_SLO_NOT_FOUND"
  | "INCIDENT_SLO_CONFLICT"
  | "INCIDENT_SLO_LEASE_INVALID"
  | "INCIDENT_SLO_CONTROL_UNAVAILABLE";

export class IncidentSloError extends Error {
  readonly code: IncidentSloErrorCode;
  readonly status: number;

  constructor(code: IncidentSloErrorCode, message: string, status = 500) {
    super(message);
    this.name = "IncidentSloError";
    this.code = code;
    this.status = status;
  }
}

export type IncidentSloControlCommand =
  | {
      kind: "claim_incident";
      incidentId: string;
      expectedRevision: number;
      leaseSeconds: number;
    }
  | {
      kind: "transition_incident";
      incidentId: string;
      leaseToken: string;
      expectedRevision: number;
      targetStatus: "triaged" | "mitigating" | "monitoring" | "resolved" | "false_positive";
      note: string | null;
    }
  | {
      kind: "request_recovery_probe";
      incidentId: string;
      leaseToken: string;
      expectedRevision: number;
      probeKey: string;
      probeKind: typeof INCIDENT_SLO_PROBE_KINDS[number];
      parameters: UnknownRecord;
    }
  | {
      kind: "record_recovery_probe_result";
      incidentId: string;
      probeId: string;
      leaseToken: string;
      expectedRevision: number;
      resultStatus: "passed" | "failed";
      summary: string;
      evidence: UnknownRecord;
    }
  | {
      kind: "register_action";
      incidentId: string;
      leaseToken: string;
      expectedRevision: number;
      mode: "preview" | "request";
      actionKind: typeof INCIDENT_SLO_ACTION_KINDS[number];
      parameters: UnknownRecord;
    }
  | {
      kind: "link_postmortem";
      incidentId: string;
      expectedRevision: number;
      status: "draft" | "in_review" | "published" | "waived";
      summary: string | null;
      rootCause: UnknownRecord;
      actionItems: unknown[];
      externalReference: string | null;
    };

export function incidentSloExecutionPolicy(): IncidentSloStatus["executionPolicy"] {
  return {
    registrationOnly: true,
    executorAvailable: false,
    paidExecutionEnabled: false,
    serviceRestartEnabled: false,
    productionRemediationEnabled: false,
  };
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableFinite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sourceStatus(value: unknown): IncidentSloDefinitionStatus["sourceStatus"] {
  return value === "available" || value === "partial" ? value : "unavailable";
}

function definition(value: unknown): IncidentSloDefinitionStatus | null {
  const row = record(value);
  if (!row || typeof row.serviceKey !== "string" || typeof row.sloKey !== "string") return null;
  const status = sourceStatus(row.sourceStatus);
  return {
    serviceKey: row.serviceKey,
    sloKey: row.sloKey,
    indicatorKind: typeof row.indicatorKind === "string" ? row.indicatorKind : "custom",
    objectiveRatio: nullableFinite(row.objectiveRatio) ?? 0,
    objectiveWindowSeconds: count(row.objectiveWindowSeconds),
    sourceStatus: status,
    value: status === "unavailable" ? null : nullableFinite(row.value),
    asOf: status === "unavailable" ? null : stringOrNull(row.asOf),
    freshnessSeconds: status === "unavailable" ? null : nullableFinite(row.freshnessSeconds),
    coverageRatio: status === "unavailable" ? null : nullableFinite(row.coverageRatio),
    partial: status === "partial",
    measurementId: stringOrNull(row.measurementId),
  };
}

export function normalizeIncidentSloDatabaseStatus(value: unknown): IncidentSloDatabaseStatus {
  const root = record(value);
  if (!root || Number(root.schemaVersion) !== 1 || root.migration !== INCIDENT_SLO_MIGRATION) {
    throw new IncidentSloError("INCIDENT_SLO_STATUS_INVALID", "事故与 SLO 控制平面状态回执无效", 503);
  }
  const tableCounts = record(root.tableCounts) || {};
  const measurements = record(root.measurements) || {};
  const alerts = record(root.alerts) || {};
  const incidents = record(root.incidents) || {};
  const actions = record(root.actions) || {};
  const definitions = Array.isArray(root.definitions)
    ? root.definitions.map(definition).filter((item): item is IncidentSloDefinitionStatus => item !== null)
    : [];
  return {
    schemaVersion: 1,
    migration: INCIDENT_SLO_MIGRATION,
    asOf: typeof root.asOf === "string" ? root.asOf : new Date().toISOString(),
    tableCounts: {
      services: count(tableCounts.services),
      definitions: count(tableCounts.definitions),
      measurements: count(tableCounts.measurements),
      alerts: count(tableCounts.alerts),
      incidents: count(tableCounts.incidents),
      incidentEvents: count(tableCounts.incidentEvents),
      maintenanceWindows: count(tableCounts.maintenanceWindows),
      recoveryProbes: count(tableCounts.recoveryProbes),
      postmortems: count(tableCounts.postmortems),
      actionRequests: count(tableCounts.actionRequests),
      auditEvents: count(tableCounts.auditEvents),
    },
    measurements: {
      available: count(measurements.available),
      partial: count(measurements.partial),
      unavailable: count(measurements.unavailable),
    },
    alerts: {
      open: count(alerts.open),
      acknowledged: count(alerts.acknowledged),
      suppressed: count(alerts.suppressed),
      resolved: count(alerts.resolved),
    },
    incidents: {
      active: count(incidents.active),
      resolved: count(incidents.resolved),
      falsePositive: count(incidents.falsePositive),
      leased: count(incidents.leased),
    },
    actions: {
      previewed: count(actions.previewed),
      requested: count(actions.requested),
      executorAvailable: false,
      paidExecutionEnabled: false,
      serviceRestartEnabled: false,
      productionRemediationEnabled: false,
    },
    definitions,
  };
}

export function incidentSloSchemaUnavailable(error: unknown): boolean {
  const detail = record(error) || {};
  const code = typeof detail.code === "string" ? detail.code : "";
  const message = [detail.message, detail.details, detail.hint]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
  return ["42P01", "42883", "PGRST202", "PGRST204"].includes(code)
    || /get_incident_slo_status|incident_slo_/iu.test(message);
}

function requiredUuid(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(text)) {
    throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", `${field} 无效`, 400);
  }
  return text;
}

function requiredRevision(value: unknown): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "expectedRevision 无效", 400);
  }
  return revision;
}

function boundedText(value: unknown, field: string, min: number, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min || text.length > max) {
    throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", `${field} 无效`, 400);
  }
  return text;
}

function optionalText(value: unknown, max: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return boundedText(value, "text", 1, max);
}

function objectOrEmpty(value: unknown, field: string): UnknownRecord {
  if (value === undefined || value === null) return {};
  const parsed = record(value);
  if (!parsed) throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", `${field} 必须是对象`, 400);
  return parsed;
}

export function parseIncidentSloControlCommand(value: unknown): IncidentSloControlCommand {
  const input = record(value);
  if (!input || typeof input.kind !== "string") {
    throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "控制请求无效", 400);
  }
  const incidentId = requiredUuid(input.incidentId, "incidentId");
  const expectedRevision = requiredRevision(input.expectedRevision);
  if (input.kind === "claim_incident") {
    const leaseSeconds = Number(input.leaseSeconds ?? 300);
    if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "leaseSeconds 必须在 30 至 3600 之间", 400);
    }
    return { kind: input.kind, incidentId, expectedRevision, leaseSeconds };
  }
  if (input.kind === "transition_incident") {
    const allowed = new Set(["triaged", "mitigating", "monitoring", "resolved", "false_positive"]);
    if (typeof input.targetStatus !== "string" || !allowed.has(input.targetStatus)) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "targetStatus 无效", 400);
    }
    return {
      kind: input.kind,
      incidentId,
      leaseToken: requiredUuid(input.leaseToken, "leaseToken"),
      expectedRevision,
      targetStatus: input.targetStatus as Extract<IncidentSloControlCommand, { kind: "transition_incident" }>["targetStatus"],
      note: optionalText(input.note, 1000),
    };
  }
  if (input.kind === "request_recovery_probe") {
    if (typeof input.probeKind !== "string" || !(INCIDENT_SLO_PROBE_KINDS as readonly string[]).includes(input.probeKind)) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "probeKind 无效", 400);
    }
    return {
      kind: input.kind,
      incidentId,
      leaseToken: requiredUuid(input.leaseToken, "leaseToken"),
      expectedRevision,
      probeKey: boundedText(input.probeKey, "probeKey", 8, 200),
      probeKind: input.probeKind as typeof INCIDENT_SLO_PROBE_KINDS[number],
      parameters: objectOrEmpty(input.parameters, "parameters"),
    };
  }
  if (input.kind === "record_recovery_probe_result") {
    if (input.resultStatus !== "passed" && input.resultStatus !== "failed") {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "resultStatus 无效", 400);
    }
    return {
      kind: input.kind,
      incidentId,
      probeId: requiredUuid(input.probeId, "probeId"),
      leaseToken: requiredUuid(input.leaseToken, "leaseToken"),
      expectedRevision,
      resultStatus: input.resultStatus,
      summary: boundedText(input.summary, "summary", 1, 1000),
      evidence: objectOrEmpty(input.evidence, "evidence"),
    };
  }
  if (input.kind === "register_action") {
    if ((input.mode !== "preview" && input.mode !== "request")
      || typeof input.actionKind !== "string"
      || !(INCIDENT_SLO_ACTION_KINDS as readonly string[]).includes(input.actionKind)) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "动作登记参数无效", 400);
    }
    return {
      kind: input.kind,
      incidentId,
      leaseToken: requiredUuid(input.leaseToken, "leaseToken"),
      expectedRevision,
      mode: input.mode,
      actionKind: input.actionKind as typeof INCIDENT_SLO_ACTION_KINDS[number],
      parameters: objectOrEmpty(input.parameters, "parameters"),
    };
  }
  if (input.kind === "link_postmortem") {
    const allowed = new Set(["draft", "in_review", "published", "waived"]);
    if (typeof input.status !== "string" || !allowed.has(input.status)) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "postmortem status 无效", 400);
    }
    if (input.actionItems !== undefined && !Array.isArray(input.actionItems)) {
      throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "actionItems 必须是数组", 400);
    }
    return {
      kind: input.kind,
      incidentId,
      expectedRevision,
      status: input.status as Extract<IncidentSloControlCommand, { kind: "link_postmortem" }>["status"],
      summary: optionalText(input.summary, 4000),
      rootCause: objectOrEmpty(input.rootCause, "rootCause"),
      actionItems: input.actionItems || [],
      externalReference: optionalText(input.externalReference, 1000),
    };
  }
  throw new IncidentSloError("INCIDENT_SLO_REQUEST_INVALID", "不支持的控制请求", 400);
}

export function validateIncidentSloRequestKey(value: string | null): string {
  const key = value?.trim() || "";
  if (key.length < 8 || key.length > 200 || !/^[A-Za-z0-9._:-]+$/u.test(key)) {
    throw new IncidentSloError(
      "INCIDENT_SLO_REQUEST_INVALID",
      "必须提供 8 至 200 字符的 Idempotency-Key",
      400,
    );
  }
  return key;
}
