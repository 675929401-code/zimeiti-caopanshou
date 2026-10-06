export const BACKUP_RESTORE_SCHEMA_VERSION = 1 as const;

const STABLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type BackupEvidenceState = "available" | "partial" | "unavailable";
export type BackupTargetOperationalStatus = "unavailable" | "configured" | "healthy" | "degraded" | "failed";
export type BackupEvidenceStatus = "unavailable" | "recorded" | "verified" | "failed" | "expired";
export type BackupRunStatus = "planned" | "requested" | "approved" | "running" | "succeeded" | "failed" | "cancelled" | "unavailable";
export type RestoreDrillStatus = BackupRunStatus;
export type RestoreCheckStatus = "not_run" | "passed" | "failed" | "unavailable";
export type BackupRequestStatus = "planned" | "requested" | "approved" | "rejected" | "cancelled" | "expired";

export interface BackupTargetRecord {
  targetKey: string;
  displayName: string;
  dataClass: string;
  policySystemOfRecord: string;
  policyBackupMethod: string;
  objectiveRpoLabel: string;
  objectiveRtoLabel: string;
  objectiveRpoSeconds: number | null;
  objectiveRtoSeconds: number | null;
  operationalStatus: BackupTargetOperationalStatus;
  statusReason: string;
  providerName: string | null;
  externalAccountRef: string | null;
  externalRegion: string | null;
  storageLocator: string | null;
  retentionEvidenceStatus: BackupEvidenceStatus;
  immutabilityEvidenceStatus: BackupEvidenceStatus;
  encryptionEvidenceStatus: BackupEvidenceStatus;
  replicationEvidenceStatus: BackupEvidenceStatus;
  pitrEvidenceStatus: BackupEvidenceStatus;
  latestSuccessfulBackupAt: string | null;
  latestVerifiedAt: string | null;
  sourceEvidence: Array<Record<string, unknown>>;
  revision: number;
  updatedAt: string | null;
}

export interface BackupControlRequestRecord {
  requestId: string;
  targetKey: string;
  operationKind: "backup_plan" | "restore_drill_plan";
  requestStatus: BackupRequestStatus;
  executionMode: "plan_request_approval_only";
  plan: Record<string, unknown>;
  requestedBy: string | null;
  requestedAt: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  approvalReason: string | null;
  executionEnabled: boolean;
  externalUploadEnabled: boolean;
  restoreEnabled: boolean;
  deleteEnabled: boolean;
  serviceSwitchEnabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRunRecord {
  runId: string;
  targetKey: string;
  requestId: string | null;
  runKind: string;
  environment: string;
  status: BackupRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  restorePointAt: string | null;
  artifactCount: number | null;
  totalBytes: string | null;
  manifestSha256: string | null;
  evidenceUri: string | null;
  externalRunRef: string | null;
  errorCode: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BackupArtifactRecord {
  artifactId: string;
  runId: string;
  artifactKey: string;
  artifactKind: string;
  storageUri: string | null;
  sizeBytes: string | null;
  sha256: string | null;
  checksumVerifiedAt: string | null;
  evidenceStatus: BackupEvidenceStatus;
  retentionUntil: string | null;
  immutableUntil: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface BackupRetentionEvidenceRecord {
  evidenceId: string;
  targetKey: string;
  runId: string | null;
  artifactId: string | null;
  evidenceKind: "retention" | "immutability" | "encryption" | "replication" | "pitr";
  evidenceStatus: BackupEvidenceStatus;
  observedAt: string | null;
  validUntil: string | null;
  evidenceUri: string | null;
  checksumSha256: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface RestoreDrillRecord {
  drillId: string;
  targetKey: string;
  sourceRunId: string | null;
  requestId: string | null;
  status: RestoreDrillStatus;
  environmentKind: "isolated" | "production" | "unavailable";
  restorePointAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  isolationVerified: boolean | null;
  productionWriteCount: number | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  errorCode: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface RestoreVerificationCheckRecord {
  checkId: string;
  drillId: string;
  checkKey: string;
  checkScope: "users" | "auth" | "ledger" | "config" | "objects" | "schema" | "other";
  status: RestoreCheckStatus;
  expectedCount: string | null;
  observedCount: string | null;
  expectedDigest: string | null;
  observedDigest: string | null;
  checkedAt: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface BackupRpoRtoReceiptRecord {
  receiptId: string;
  drillId: string;
  targetKey: string;
  status: BackupEvidenceStatus;
  observedRpoSeconds: number | null;
  observedRtoSeconds: number | null;
  measuredAt: string | null;
  evidenceUri: string | null;
  evidenceSha256: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface BackupControlEventRecord {
  eventId: string;
  targetKey: string | null;
  entityType: string;
  entityId: string | null;
  eventKind: string;
  eventStatus: string;
  actorId: string | null;
  happenedAt: string;
  details: Record<string, unknown>;
  evidenceUri: string | null;
  evidenceSha256: string | null;
}

export interface BackupRestoreIssue {
  code: string;
  severity: "warning" | "error";
  subject: string;
  message: string;
}

export const BACKUP_TARGET_DEFINITIONS = Object.freeze([
  { targetKey: "source", displayName: "源代码", objectiveRpoLabel: "24h", objectiveRtoLabel: "4h", objectiveRpoSeconds: 86_400, objectiveRtoSeconds: 14_400 },
  { targetKey: "artifacts", displayName: "发布产物", objectiveRpoLabel: "per release", objectiveRtoLabel: "1h", objectiveRpoSeconds: null, objectiveRtoSeconds: 3_600 },
  { targetKey: "public-assets", displayName: "公共静态资产", objectiveRpoLabel: "24h", objectiveRtoLabel: "4h", objectiveRpoSeconds: 86_400, objectiveRtoSeconds: 14_400 },
  { targetKey: "database", displayName: "主业务数据库", objectiveRpoLabel: "5m", objectiveRtoLabel: "2h", objectiveRpoSeconds: 300, objectiveRtoSeconds: 7_200 },
  { targetKey: "wallet-ledger", displayName: "钱包与账本", objectiveRpoLabel: "1m", objectiveRtoLabel: "4h", objectiveRpoSeconds: 60, objectiveRtoSeconds: 14_400 },
  { targetKey: "user-assets", displayName: "用户私有资产", objectiveRpoLabel: "15m", objectiveRtoLabel: "4h", objectiveRpoSeconds: 900, objectiveRtoSeconds: 14_400 },
  { targetKey: "secrets", displayName: "凭据与恢复包", objectiveRpoLabel: "24h", objectiveRtoLabel: "2h", objectiveRpoSeconds: 86_400, objectiveRtoSeconds: 7_200 },
] as const);

export const REQUIRED_RESTORE_CHECK_SCOPES = Object.freeze(["users", "ledger", "config", "objects"] as const);

export const BACKUP_EXECUTION_BOUNDARY = Object.freeze({
  mode: "plan_request_approval_only" as const,
  backupExecutionEnabled: false as const,
  restoreExecutionEnabled: false as const,
  externalUploadEnabled: false as const,
  deletionEnabled: false as const,
  serviceSwitchEnabled: false as const,
});

export function isStableBackupKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 2
    && value.length <= 80
    && STABLE_KEY_PATTERN.test(value);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const itemKey = key(item);
    result.set(itemKey, [...(result.get(itemKey) || []), item]);
  }
  return result;
}

function validSha256(value: string | null): boolean {
  return Boolean(value && SHA256_PATTERN.test(value));
}

function positiveIntegerText(value: string | null): boolean {
  if (!value || !/^\d+$/u.test(value)) return false;
  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

function validSuccessfulRun(run: BackupRunRecord): boolean {
  return run.status === "succeeded"
    && Boolean(run.startedAt && run.finishedAt && run.restorePointAt && run.evidenceUri)
    && Boolean(run.artifactCount && run.artifactCount > 0)
    && positiveIntegerText(run.totalBytes)
    && validSha256(run.manifestSha256);
}

function validVerifiedArtifact(artifact: BackupArtifactRecord): boolean {
  return artifact.evidenceStatus === "verified"
    && Boolean(artifact.storageUri && artifact.checksumVerifiedAt)
    && validSha256(artifact.sha256);
}

function validSuccessfulDrill(drill: RestoreDrillRecord): boolean {
  return drill.status === "succeeded"
    && drill.environmentKind === "isolated"
    && drill.isolationVerified === true
    && drill.productionWriteCount === 0
    && Boolean(drill.sourceRunId && drill.restorePointAt && drill.startedAt && drill.finishedAt && drill.evidenceUri)
    && validSha256(drill.evidenceSha256);
}

function validPassedCheck(check: RestoreVerificationCheckRecord): boolean {
  const countsMatch = check.expectedCount !== null
    && check.observedCount !== null
    && check.expectedCount === check.observedCount;
  const digestsMatch = Boolean(check.expectedDigest)
    && check.expectedDigest === check.observedDigest;
  return check.status === "passed"
    && Boolean(check.checkedAt && check.evidenceUri)
    && validSha256(check.evidenceSha256)
    && (countsMatch || digestsMatch);
}

function validReceipt(receipt: BackupRpoRtoReceiptRecord): boolean {
  return receipt.status === "verified"
    && receipt.observedRpoSeconds !== null
    && receipt.observedRpoSeconds >= 0
    && receipt.observedRtoSeconds !== null
    && receipt.observedRtoSeconds >= 0
    && Boolean(receipt.measuredAt && receipt.evidenceUri)
    && validSha256(receipt.evidenceSha256);
}

export function inspectBackupRestoreConsistency(input: {
  targets: readonly BackupTargetRecord[];
  requests: readonly BackupControlRequestRecord[];
  runs: readonly BackupRunRecord[];
  artifacts: readonly BackupArtifactRecord[];
  retentionEvidence: readonly BackupRetentionEvidenceRecord[];
  drills: readonly RestoreDrillRecord[];
  checks: readonly RestoreVerificationCheckRecord[];
  receipts: readonly BackupRpoRtoReceiptRecord[];
  events: readonly BackupControlEventRecord[];
}) {
  const issues: BackupRestoreIssue[] = [];
  const targetsByKey = groupBy(input.targets, (item) => item.targetKey);
  const artifactsByRun = groupBy(input.artifacts, (item) => item.runId);
  const checksByDrill = groupBy(input.checks, (item) => item.drillId);
  const receiptsByDrill = groupBy(input.receipts, (item) => item.drillId);
  const validRunIds = new Set<string>();
  const validRunTargets = new Map<string, string>();
  const backupTargetKeys = new Set<string>();
  const protectedTargetKeys = new Set<string>();
  const restoreTargetKeys = new Set<string>();

  for (const request of input.requests) {
    if (
      request.executionMode !== "plan_request_approval_only"
      || request.executionEnabled
      || request.externalUploadEnabled
      || request.restoreEnabled
      || request.deleteEnabled
      || request.serviceSwitchEnabled
    ) {
      issues.push({
        code: "BACKUP_EXECUTION_BOUNDARY_VIOLATED",
        severity: "error",
        subject: request.requestId,
        message: "一期控制面只能记录计划、申请和审批，不得开放执行或破坏性动作。",
      });
    }
  }

  for (const expected of BACKUP_TARGET_DEFINITIONS) {
    const matches = targetsByKey.get(expected.targetKey) || [];
    if (matches.length !== 1) {
      issues.push({
        code: matches.length === 0 ? "BACKUP_TARGET_MISSING" : "BACKUP_TARGET_DUPLICATED",
        severity: "error",
        subject: expected.targetKey,
        message: matches.length === 0 ? "政策目标尚未进入备份控制面。" : "同一备份目标出现多条记录。",
      });
      continue;
    }
    const target = matches[0];
    if (!isStableBackupKey(target.targetKey)) {
      issues.push({ code: "BACKUP_TARGET_KEY_INVALID", severity: "error", subject: target.targetKey, message: "备份目标 key 不稳定。" });
    }
    if (target.operationalStatus === "unavailable") {
      issues.push({
        code: "BACKUP_TARGET_EXTERNAL_EVIDENCE_UNAVAILABLE",
        severity: "warning",
        subject: target.targetKey,
        message: "当前没有可核验的外部备份运行证据，不能报告健康或当前 RPO/RTO。",
      });
    }
  }

  for (const run of input.runs) {
    if (run.status !== "succeeded") continue;
    if (!validSuccessfulRun(run)) {
      issues.push({ code: "BACKUP_SUCCESS_EVIDENCE_INVALID", severity: "error", subject: run.runId, message: "成功备份缺少恢复点、manifest checksum、产物或回执。" });
      continue;
    }
    const verifiedArtifacts = (artifactsByRun.get(run.runId) || []).filter(validVerifiedArtifact);
    if (verifiedArtifacts.length === 0) {
      issues.push({ code: "BACKUP_ARTIFACT_CHECKSUM_MISSING", severity: "error", subject: run.runId, message: "成功备份没有校验通过的产物。" });
      continue;
    }
    validRunIds.add(run.runId);
    validRunTargets.set(run.runId, run.targetKey);
    backupTargetKeys.add(run.targetKey);
  }

  for (const target of input.targets) {
    const kinds = new Set(input.retentionEvidence
      .filter((item) => item.targetKey === target.targetKey && item.evidenceStatus === "verified" && validSha256(item.checksumSha256) && item.evidenceUri)
      .map((item) => item.evidenceKind));
    if (kinds.has("retention") && kinds.has("immutability")) protectedTargetKeys.add(target.targetKey);
  }

  for (const drill of input.drills) {
    if (drill.status !== "succeeded") continue;
    if (
      !validSuccessfulDrill(drill)
      || !drill.sourceRunId
      || !validRunIds.has(drill.sourceRunId)
      || validRunTargets.get(drill.sourceRunId) !== drill.targetKey
    ) {
      issues.push({ code: "RESTORE_DRILL_EVIDENCE_INVALID", severity: "error", subject: drill.drillId, message: "恢复演练缺少隔离证明、有效源备份或零生产写入证据。" });
      continue;
    }
    const passedScopes = new Set((checksByDrill.get(drill.drillId) || []).filter(validPassedCheck).map((item) => item.checkScope));
    const missingScopes = REQUIRED_RESTORE_CHECK_SCOPES.filter((scope) => !passedScopes.has(scope));
    const receipt = (receiptsByDrill.get(drill.drillId) || [])
      .find((item) => item.targetKey === drill.targetKey && validReceipt(item));
    if (missingScopes.length > 0 || !receipt) {
      issues.push({
        code: !receipt ? "RPO_RTO_RECEIPT_MISSING" : "RESTORE_VERIFICATION_INCOMPLETE",
        severity: "error",
        subject: drill.drillId,
        message: !receipt ? "恢复演练没有可核验的 RPO/RTO 回执。" : `恢复演练缺少校验范围：${missingScopes.join(", ")}。`,
      });
      continue;
    }
    restoreTargetKeys.add(drill.targetKey);
  }

  const validReceipts = input.receipts.filter(validReceipt).sort((left, right) => String(right.measuredAt).localeCompare(String(left.measuredAt)));
  const latestReceipt = validReceipts[0] || null;
  if (backupTargetKeys.size === 0) {
    issues.push({ code: "VERIFIED_BACKUP_RUN_UNAVAILABLE", severity: "warning", subject: "backup_runs", message: "当前没有带 manifest 和 checksum 的成功备份运行回执。" });
  }
  if (restoreTargetKeys.size === 0) {
    issues.push({ code: "VERIFIED_RESTORE_DRILL_UNAVAILABLE", severity: "warning", subject: "restore_drills", message: "当前没有通过隔离恢复和关键检查的演练回执。" });
  }

  const expectedCount = BACKUP_TARGET_DEFINITIONS.length;
  const hasHardFailure = issues.some((issue) => issue.severity === "error");
  const evidenceState: BackupEvidenceState = backupTargetKeys.size === 0 && restoreTargetKeys.size === 0
    ? "unavailable"
    : !hasHardFailure
      && backupTargetKeys.size === expectedCount
      && protectedTargetKeys.size === expectedCount
      && restoreTargetKeys.size === expectedCount
      ? "available"
      : "partial";

  return {
    evidenceState,
    targetCoverage: {
      expected: expectedCount,
      registered: BACKUP_TARGET_DEFINITIONS.filter((item) => (targetsByKey.get(item.targetKey) || []).length === 1).length,
      externallyVerified: input.targets.filter((item) => item.operationalStatus === "healthy" && item.latestVerifiedAt).length,
    },
    backupRunCoverage: { expectedTargets: expectedCount, verifiedTargets: backupTargetKeys.size },
    protectionCoverage: { expectedTargets: expectedCount, verifiedTargets: protectedTargetKeys.size },
    restoreDrillCoverage: { expectedTargets: expectedCount, verifiedTargets: restoreTargetKeys.size },
    latestVerifiedRpoRto: latestReceipt ? {
      targetKey: latestReceipt.targetKey,
      measuredAt: latestReceipt.measuredAt,
      observedRpoSeconds: latestReceipt.observedRpoSeconds,
      observedRtoSeconds: latestReceipt.observedRtoSeconds,
    } : null,
    issues,
  };
}
