import "server-only";

import {
  BACKUP_EXECUTION_BOUNDARY,
  BACKUP_RESTORE_SCHEMA_VERSION,
  inspectBackupRestoreConsistency,
  type BackupArtifactRecord,
  type BackupControlEventRecord,
  type BackupControlRequestRecord,
  type BackupEvidenceStatus,
  type BackupRestoreIssue,
  type BackupRpoRtoReceiptRecord,
  type BackupRunRecord,
  type BackupRunStatus,
  type BackupTargetOperationalStatus,
  type BackupTargetRecord,
  type RestoreCheckStatus,
  type RestoreDrillRecord,
  type RestoreDrillStatus,
  type RestoreVerificationCheckRecord,
  type BackupRetentionEvidenceRecord,
} from "@/lib/backup-restore-control-plane-domain";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

type DatabaseRow = Record<string, unknown>;

export interface AdminBackupRestoreSnapshot {
  schemaVersion: typeof BACKUP_RESTORE_SCHEMA_VERSION;
  generatedAt: string;
  schemaState: "available" | "unavailable";
  evidenceState: "available" | "partial" | "unavailable";
  executionBoundary: typeof BACKUP_EXECUTION_BOUNDARY;
  targets: BackupTargetRecord[];
  requests: BackupControlRequestRecord[];
  runs: BackupRunRecord[];
  artifacts: BackupArtifactRecord[];
  retentionEvidence: BackupRetentionEvidenceRecord[];
  drills: RestoreDrillRecord[];
  verificationChecks: RestoreVerificationCheckRecord[];
  rpoRtoReceipts: BackupRpoRtoReceiptRecord[];
  events: BackupControlEventRecord[];
  consistency: ReturnType<typeof inspectBackupRestoreConsistency>;
  readOnly: true;
  backupExecutions: 0;
  restoreExecutions: 0;
  externalUploads: 0;
  destructiveActions: 0;
  productionWrites: 0;
}

const TARGET_SELECT = [
  "target_key", "display_name", "data_class", "policy_system_of_record", "policy_backup_method",
  "objective_rpo_label", "objective_rto_label", "objective_rpo_seconds", "objective_rto_seconds",
  "operational_status", "status_reason", "provider_name", "external_account_ref", "external_region",
  "storage_locator", "retention_evidence_status", "immutability_evidence_status", "encryption_evidence_status",
  "replication_evidence_status", "pitr_evidence_status", "latest_successful_backup_at", "latest_verified_at",
  "source_evidence", "revision", "updated_at",
].join(",");

const REQUEST_SELECT = [
  "request_id", "target_key", "operation_kind", "request_status", "execution_mode", "plan",
  "requested_by", "requested_at", "approved_by", "approved_at", "approval_reason",
  "execution_enabled", "external_upload_enabled", "restore_enabled", "delete_enabled",
  "service_switch_enabled", "expires_at", "created_at", "updated_at",
].join(",");

const RUN_SELECT = [
  "run_id", "target_key", "request_id", "run_kind", "environment", "status", "started_at", "finished_at",
  "restore_point_at", "artifact_count", "total_bytes", "manifest_sha256", "evidence_uri", "external_run_ref",
  "error_code", "metadata", "created_at",
].join(",");

const ARTIFACT_SELECT = [
  "artifact_id", "run_id", "artifact_key", "artifact_kind", "storage_uri", "size_bytes", "sha256",
  "checksum_verified_at", "evidence_status", "retention_until", "immutable_until", "metadata", "created_at",
].join(",");

const RETENTION_SELECT = [
  "evidence_id", "target_key", "run_id", "artifact_id", "evidence_kind", "evidence_status", "observed_at",
  "valid_until", "evidence_uri", "checksum_sha256", "details", "created_at",
].join(",");

const DRILL_SELECT = [
  "drill_id", "target_key", "source_run_id", "request_id", "status", "environment_kind", "restore_point_at",
  "started_at", "finished_at", "isolation_verified", "production_write_count", "evidence_uri",
  "evidence_sha256", "error_code", "details", "created_at",
].join(",");

const CHECK_SELECT = [
  "check_id", "drill_id", "check_key", "check_scope", "status", "expected_count", "observed_count",
  "expected_digest", "observed_digest", "checked_at", "evidence_uri", "evidence_sha256", "details", "created_at",
].join(",");

const RECEIPT_SELECT = [
  "receipt_id", "drill_id", "target_key", "status", "observed_rpo_seconds", "observed_rto_seconds",
  "measured_at", "evidence_uri", "evidence_sha256", "details", "created_at",
].join(",");

const EVENT_SELECT = [
  "event_id", "target_key", "entity_type", "entity_id", "event_kind", "event_status", "actor_id",
  "happened_at", "details", "evidence_uri", "evidence_sha256",
].join(",");

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  const normalized = text(value).trim();
  return normalized || null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function integerTextOrNull(value: unknown): string | null {
  if (typeof value === "bigint") return value >= BigInt(0) ? value.toString() : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function evidenceArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function evidenceStatus(value: unknown): BackupEvidenceStatus {
  return value === "recorded" || value === "verified" || value === "failed" || value === "expired"
    ? value
    : "unavailable";
}

function operationalStatus(value: unknown): BackupTargetOperationalStatus {
  return value === "configured" || value === "healthy" || value === "degraded" || value === "failed"
    ? value
    : "unavailable";
}

function runStatus(value: unknown): BackupRunStatus {
  return value === "planned" || value === "requested" || value === "approved" || value === "running"
    || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : "unavailable";
}

function drillStatus(value: unknown): RestoreDrillStatus {
  return runStatus(value);
}

function checkStatus(value: unknown): RestoreCheckStatus {
  return value === "passed" || value === "failed" || value === "unavailable" ? value : "not_run";
}

function targetFromRow(row: DatabaseRow): BackupTargetRecord {
  return {
    targetKey: text(row.target_key),
    displayName: text(row.display_name),
    dataClass: text(row.data_class),
    policySystemOfRecord: text(row.policy_system_of_record),
    policyBackupMethod: text(row.policy_backup_method),
    objectiveRpoLabel: text(row.objective_rpo_label),
    objectiveRtoLabel: text(row.objective_rto_label),
    objectiveRpoSeconds: integerOrNull(row.objective_rpo_seconds),
    objectiveRtoSeconds: integerOrNull(row.objective_rto_seconds),
    operationalStatus: operationalStatus(row.operational_status),
    statusReason: text(row.status_reason),
    providerName: nullableText(row.provider_name),
    externalAccountRef: nullableText(row.external_account_ref),
    externalRegion: nullableText(row.external_region),
    storageLocator: nullableText(row.storage_locator),
    retentionEvidenceStatus: evidenceStatus(row.retention_evidence_status),
    immutabilityEvidenceStatus: evidenceStatus(row.immutability_evidence_status),
    encryptionEvidenceStatus: evidenceStatus(row.encryption_evidence_status),
    replicationEvidenceStatus: evidenceStatus(row.replication_evidence_status),
    pitrEvidenceStatus: evidenceStatus(row.pitr_evidence_status),
    latestSuccessfulBackupAt: nullableText(row.latest_successful_backup_at),
    latestVerifiedAt: nullableText(row.latest_verified_at),
    sourceEvidence: evidenceArray(row.source_evidence),
    revision: integerOrNull(row.revision) || 1,
    updatedAt: nullableText(row.updated_at),
  };
}

function requestFromRow(row: DatabaseRow): BackupControlRequestRecord {
  const requestStatus = text(row.request_status);
  return {
    requestId: text(row.request_id),
    targetKey: text(row.target_key),
    operationKind: row.operation_kind === "restore_drill_plan" ? "restore_drill_plan" : "backup_plan",
    requestStatus: requestStatus === "requested" || requestStatus === "approved" || requestStatus === "rejected"
      || requestStatus === "cancelled" || requestStatus === "expired" ? requestStatus : "planned",
    executionMode: "plan_request_approval_only",
    plan: objectValue(row.plan),
    requestedBy: nullableText(row.requested_by),
    requestedAt: nullableText(row.requested_at),
    approvedBy: nullableText(row.approved_by),
    approvedAt: nullableText(row.approved_at),
    approvalReason: nullableText(row.approval_reason),
    executionEnabled: row.execution_enabled === true,
    externalUploadEnabled: row.external_upload_enabled === true,
    restoreEnabled: row.restore_enabled === true,
    deleteEnabled: row.delete_enabled === true,
    serviceSwitchEnabled: row.service_switch_enabled === true,
    expiresAt: nullableText(row.expires_at),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function runFromRow(row: DatabaseRow): BackupRunRecord {
  return {
    runId: text(row.run_id), targetKey: text(row.target_key), requestId: nullableText(row.request_id),
    runKind: text(row.run_kind), environment: text(row.environment), status: runStatus(row.status),
    startedAt: nullableText(row.started_at), finishedAt: nullableText(row.finished_at),
    restorePointAt: nullableText(row.restore_point_at), artifactCount: integerOrNull(row.artifact_count),
    totalBytes: integerTextOrNull(row.total_bytes), manifestSha256: nullableText(row.manifest_sha256),
    evidenceUri: nullableText(row.evidence_uri), externalRunRef: nullableText(row.external_run_ref),
    errorCode: nullableText(row.error_code), metadata: objectValue(row.metadata), createdAt: text(row.created_at),
  };
}

function artifactFromRow(row: DatabaseRow): BackupArtifactRecord {
  return {
    artifactId: text(row.artifact_id), runId: text(row.run_id), artifactKey: text(row.artifact_key),
    artifactKind: text(row.artifact_kind), storageUri: nullableText(row.storage_uri),
    sizeBytes: integerTextOrNull(row.size_bytes), sha256: nullableText(row.sha256),
    checksumVerifiedAt: nullableText(row.checksum_verified_at), evidenceStatus: evidenceStatus(row.evidence_status),
    retentionUntil: nullableText(row.retention_until), immutableUntil: nullableText(row.immutable_until),
    metadata: objectValue(row.metadata), createdAt: text(row.created_at),
  };
}

function retentionFromRow(row: DatabaseRow): BackupRetentionEvidenceRecord {
  const kind = text(row.evidence_kind);
  return {
    evidenceId: text(row.evidence_id), targetKey: text(row.target_key), runId: nullableText(row.run_id),
    artifactId: nullableText(row.artifact_id),
    evidenceKind: kind === "immutability" || kind === "encryption" || kind === "replication" || kind === "pitr" ? kind : "retention",
    evidenceStatus: evidenceStatus(row.evidence_status), observedAt: nullableText(row.observed_at),
    validUntil: nullableText(row.valid_until), evidenceUri: nullableText(row.evidence_uri),
    checksumSha256: nullableText(row.checksum_sha256), details: objectValue(row.details), createdAt: text(row.created_at),
  };
}

function drillFromRow(row: DatabaseRow): RestoreDrillRecord {
  const environmentKind = text(row.environment_kind);
  return {
    drillId: text(row.drill_id), targetKey: text(row.target_key), sourceRunId: nullableText(row.source_run_id),
    requestId: nullableText(row.request_id), status: drillStatus(row.status),
    environmentKind: environmentKind === "isolated" || environmentKind === "production" ? environmentKind : "unavailable",
    restorePointAt: nullableText(row.restore_point_at), startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at), isolationVerified: typeof row.isolation_verified === "boolean" ? row.isolation_verified : null,
    productionWriteCount: integerOrNull(row.production_write_count), evidenceUri: nullableText(row.evidence_uri),
    evidenceSha256: nullableText(row.evidence_sha256), errorCode: nullableText(row.error_code),
    details: objectValue(row.details), createdAt: text(row.created_at),
  };
}

function checkFromRow(row: DatabaseRow): RestoreVerificationCheckRecord {
  const scope = text(row.check_scope);
  return {
    checkId: text(row.check_id), drillId: text(row.drill_id), checkKey: text(row.check_key),
    checkScope: scope === "users" || scope === "auth" || scope === "ledger" || scope === "config"
      || scope === "objects" || scope === "schema" ? scope : "other",
    status: checkStatus(row.status), expectedCount: integerTextOrNull(row.expected_count),
    observedCount: integerTextOrNull(row.observed_count), expectedDigest: nullableText(row.expected_digest),
    observedDigest: nullableText(row.observed_digest), checkedAt: nullableText(row.checked_at),
    evidenceUri: nullableText(row.evidence_uri), evidenceSha256: nullableText(row.evidence_sha256),
    details: objectValue(row.details), createdAt: text(row.created_at),
  };
}

function receiptFromRow(row: DatabaseRow): BackupRpoRtoReceiptRecord {
  return {
    receiptId: text(row.receipt_id), drillId: text(row.drill_id), targetKey: text(row.target_key),
    status: evidenceStatus(row.status), observedRpoSeconds: integerOrNull(row.observed_rpo_seconds),
    observedRtoSeconds: integerOrNull(row.observed_rto_seconds), measuredAt: nullableText(row.measured_at),
    evidenceUri: nullableText(row.evidence_uri), evidenceSha256: nullableText(row.evidence_sha256),
    details: objectValue(row.details), createdAt: text(row.created_at),
  };
}

function eventFromRow(row: DatabaseRow): BackupControlEventRecord {
  return {
    eventId: text(row.event_id), targetKey: nullableText(row.target_key), entityType: text(row.entity_type),
    entityId: nullableText(row.entity_id), eventKind: text(row.event_kind), eventStatus: text(row.event_status),
    actorId: nullableText(row.actor_id), happenedAt: text(row.happened_at), details: objectValue(row.details),
    evidenceUri: nullableText(row.evidence_uri), evidenceSha256: nullableText(row.evidence_sha256),
  };
}

function emptyInput() {
  return { targets: [], requests: [], runs: [], artifacts: [], retentionEvidence: [], drills: [], checks: [], receipts: [], events: [] };
}

function unavailableSnapshot(generatedAt: string, issue: BackupRestoreIssue): AdminBackupRestoreSnapshot {
  const consistency = inspectBackupRestoreConsistency(emptyInput());
  consistency.issues.unshift(issue);
  return {
    schemaVersion: BACKUP_RESTORE_SCHEMA_VERSION, generatedAt, schemaState: "unavailable", evidenceState: "unavailable",
    executionBoundary: BACKUP_EXECUTION_BOUNDARY, targets: [], requests: [], runs: [], artifacts: [], retentionEvidence: [],
    drills: [], verificationChecks: [], rpoRtoReceipts: [], events: [], consistency, readOnly: true,
    backupExecutions: 0, restoreExecutions: 0, externalUploads: 0, destructiveActions: 0, productionWrites: 0,
  };
}

export async function readAdminBackupRestoreSnapshot(): Promise<AdminBackupRestoreSnapshot> {
  const generatedAt = new Date().toISOString();
  try {
    const database = getSupabaseAdminClient();
    const results = await Promise.all([
      database.from("backup_control_targets").select(TARGET_SELECT).order("target_key", { ascending: true }),
      database.from("backup_control_requests").select(REQUEST_SELECT).order("created_at", { ascending: false }).limit(200),
      database.from("backup_runs").select(RUN_SELECT).order("created_at", { ascending: false }).limit(500),
      database.from("backup_artifacts").select(ARTIFACT_SELECT).order("created_at", { ascending: false }).limit(1000),
      database.from("backup_retention_evidence").select(RETENTION_SELECT).order("created_at", { ascending: false }).limit(1000),
      database.from("restore_drills").select(DRILL_SELECT).order("created_at", { ascending: false }).limit(500),
      database.from("restore_verification_checks").select(CHECK_SELECT).order("created_at", { ascending: false }).limit(1000),
      database.from("backup_rpo_rto_receipts").select(RECEIPT_SELECT).order("created_at", { ascending: false }).limit(500),
      database.from("backup_control_events").select(EVENT_SELECT).order("happened_at", { ascending: false }).limit(200),
    ]);
    const error = results.find((result) => result.error)?.error;
    if (error) {
      return unavailableSnapshot(generatedAt, {
        code: "BACKUP_RESTORE_SCHEMA_UNAVAILABLE", severity: "error", subject: "backup_restore_control_plane",
        message: "备份与恢复控制面迁移尚未可读，未使用本地文件或政策声明伪装运行成功。",
      });
    }

    const [targetResult, requestResult, runResult, artifactResult, retentionResult, drillResult, checkResult, receiptResult, eventResult] = results;
    const targets = (targetResult.data || []).map((row: unknown) => targetFromRow(row as DatabaseRow));
    const requests = (requestResult.data || []).map((row: unknown) => requestFromRow(row as DatabaseRow));
    const runs = (runResult.data || []).map((row: unknown) => runFromRow(row as DatabaseRow));
    const artifacts = (artifactResult.data || []).map((row: unknown) => artifactFromRow(row as DatabaseRow));
    const retentionEvidence = (retentionResult.data || []).map((row: unknown) => retentionFromRow(row as DatabaseRow));
    const drills = (drillResult.data || []).map((row: unknown) => drillFromRow(row as DatabaseRow));
    const verificationChecks = (checkResult.data || []).map((row: unknown) => checkFromRow(row as DatabaseRow));
    const rpoRtoReceipts = (receiptResult.data || []).map((row: unknown) => receiptFromRow(row as DatabaseRow));
    const events = (eventResult.data || []).map((row: unknown) => eventFromRow(row as DatabaseRow));
    const consistency = inspectBackupRestoreConsistency({
      targets, requests, runs, artifacts, retentionEvidence, drills, checks: verificationChecks, receipts: rpoRtoReceipts, events,
    });

    return {
      schemaVersion: BACKUP_RESTORE_SCHEMA_VERSION, generatedAt, schemaState: "available",
      evidenceState: consistency.evidenceState, executionBoundary: BACKUP_EXECUTION_BOUNDARY,
      targets, requests, runs, artifacts, retentionEvidence, drills, verificationChecks, rpoRtoReceipts, events,
      consistency, readOnly: true, backupExecutions: 0, restoreExecutions: 0, externalUploads: 0,
      destructiveActions: 0, productionWrites: 0,
    };
  } catch {
    return unavailableSnapshot(generatedAt, {
      code: "BACKUP_RESTORE_READ_FAILED", severity: "error", subject: "backup_restore_control_plane",
      message: "备份与恢复控制面读取失败，当前备份、RPO、RTO 与恢复演练状态不可用。",
    });
  }
}
