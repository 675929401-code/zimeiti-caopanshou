#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BACKUP_EXECUTION_BOUNDARY,
  BACKUP_TARGET_DEFINITIONS,
  REQUIRED_RESTORE_CHECK_SCOPES,
  inspectBackupRestoreConsistency,
  isStableBackupKey,
  type BackupArtifactRecord,
  type BackupRetentionEvidenceRecord,
  type BackupRpoRtoReceiptRecord,
  type BackupRunRecord,
  type BackupTargetRecord,
  type RestoreDrillRecord,
  type RestoreVerificationCheckRecord,
} from "../src/lib/backup-restore-control-plane-domain";

let passed = 0;
function check(run: () => void) {
  run();
  passed += 1;
}

const policy = JSON.parse(readFileSync(new URL("../deploy/policies/backup-policy.json", import.meta.url), "utf8")) as {
  classes: Array<{ id: string; systemOfRecord: string; backup: string; rpo: string; rto: string }>;
  implementationStatus: Record<string, string>;
};
const policyById = new Map(policy.classes.map((item) => [item.id, item]));
const at = "2026-10-02T10:00:00.000Z";
const until = "2027-10-02T10:00:00.000Z";
const sha = "a".repeat(64);

const unavailableTargets: BackupTargetRecord[] = BACKUP_TARGET_DEFINITIONS.map((definition) => {
  const policyClass = policyById.get(definition.targetKey);
  assert.ok(policyClass, `missing backup policy class: ${definition.targetKey}`);
  return {
    targetKey: definition.targetKey,
    displayName: definition.displayName,
    dataClass: definition.targetKey,
    policySystemOfRecord: policyClass.systemOfRecord,
    policyBackupMethod: policyClass.backup,
    objectiveRpoLabel: definition.objectiveRpoLabel,
    objectiveRtoLabel: definition.objectiveRtoLabel,
    objectiveRpoSeconds: definition.objectiveRpoSeconds,
    objectiveRtoSeconds: definition.objectiveRtoSeconds,
    operationalStatus: "unavailable",
    statusReason: "NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE",
    providerName: null,
    externalAccountRef: null,
    externalRegion: null,
    storageLocator: null,
    retentionEvidenceStatus: "unavailable",
    immutabilityEvidenceStatus: "unavailable",
    encryptionEvidenceStatus: "unavailable",
    replicationEvidenceStatus: "unavailable",
    pitrEvidenceStatus: "unavailable",
    latestSuccessfulBackupAt: null,
    latestVerifiedAt: null,
    sourceEvidence: [{ source: "deploy/policies/backup-policy.json", evidenceType: "policy_declaration" }],
    revision: 1,
    updatedAt: null,
  };
});

const emptyEvidence = {
  targets: unavailableTargets,
  requests: [],
  runs: [],
  artifacts: [],
  retentionEvidence: [],
  drills: [],
  checks: [],
  receipts: [],
  events: [],
};

check(() => {
  assert.equal(BACKUP_TARGET_DEFINITIONS.length, 7);
  assert.deepEqual(BACKUP_TARGET_DEFINITIONS.map((item) => item.targetKey), policy.classes.map((item) => item.id));
  assert.deepEqual(BACKUP_TARGET_DEFINITIONS.map((item) => item.objectiveRpoLabel), policy.classes.map((item) => item.rpo));
  assert.deepEqual(BACKUP_TARGET_DEFINITIONS.map((item) => item.objectiveRtoLabel), policy.classes.map((item) => item.rto));
  assert.ok(BACKUP_TARGET_DEFINITIONS.every((item) => isStableBackupKey(item.targetKey)));
  assert.equal(isStableBackupKey("00000000-0000-4000-8000-000000000001"), false);
  assert.equal(isStableBackupKey("database/current"), false);
});

check(() => {
  assert.deepEqual(BACKUP_EXECUTION_BOUNDARY, {
    mode: "plan_request_approval_only",
    backupExecutionEnabled: false,
    restoreExecutionEnabled: false,
    externalUploadEnabled: false,
    deletionEnabled: false,
    serviceSwitchEnabled: false,
  });
  const result = inspectBackupRestoreConsistency(emptyEvidence);
  assert.equal(result.evidenceState, "unavailable");
  assert.deepEqual(result.targetCoverage, { expected: 7, registered: 7, externallyVerified: 0 });
  assert.deepEqual(result.backupRunCoverage, { expectedTargets: 7, verifiedTargets: 0 });
  assert.deepEqual(result.protectionCoverage, { expectedTargets: 7, verifiedTargets: 0 });
  assert.deepEqual(result.restoreDrillCoverage, { expectedTargets: 7, verifiedTargets: 0 });
  assert.equal(result.latestVerifiedRpoRto, null);
  assert.equal(result.issues.filter((issue) => issue.code === "BACKUP_TARGET_EXTERNAL_EVIDENCE_UNAVAILABLE").length, 7);
});

const healthyTargets = unavailableTargets.map((target) => ({
  ...target,
  operationalStatus: "healthy" as const,
  retentionEvidenceStatus: "verified" as const,
  immutabilityEvidenceStatus: "verified" as const,
  encryptionEvidenceStatus: "verified" as const,
  replicationEvidenceStatus: "verified" as const,
  latestSuccessfulBackupAt: at,
  latestVerifiedAt: at,
}));
const runs: BackupRunRecord[] = healthyTargets.map((target, index) => ({
  runId: `run-${index}`,
  targetKey: target.targetKey,
  requestId: null,
  runKind: "full",
  environment: "production",
  status: "succeeded",
  startedAt: at,
  finishedAt: at,
  restorePointAt: at,
  artifactCount: 1,
  totalBytes: "1",
  manifestSha256: sha,
  evidenceUri: `evidence://run/${index}`,
  externalRunRef: null,
  errorCode: null,
  metadata: {},
  createdAt: at,
}));
const artifacts: BackupArtifactRecord[] = runs.map((run, index) => ({
  artifactId: `artifact-${index}`,
  runId: run.runId,
  artifactKey: "manifest.json",
  artifactKind: "manifest",
  storageUri: `evidence://artifact/${index}`,
  sizeBytes: "1",
  sha256: sha,
  checksumVerifiedAt: at,
  evidenceStatus: "verified",
  retentionUntil: until,
  immutableUntil: until,
  metadata: {},
  createdAt: at,
}));
const retentionEvidence: BackupRetentionEvidenceRecord[] = healthyTargets.flatMap((target, index) => ([
  {
    evidenceId: `retention-${index}`,
    targetKey: target.targetKey,
    runId: runs[index].runId,
    artifactId: artifacts[index].artifactId,
    evidenceKind: "retention" as const,
    evidenceStatus: "verified" as const,
    observedAt: at,
    validUntil: until,
    evidenceUri: `evidence://retention/${index}`,
    checksumSha256: sha,
    details: {},
    createdAt: at,
  },
  {
    evidenceId: `immutability-${index}`,
    targetKey: target.targetKey,
    runId: runs[index].runId,
    artifactId: artifacts[index].artifactId,
    evidenceKind: "immutability" as const,
    evidenceStatus: "verified" as const,
    observedAt: at,
    validUntil: until,
    evidenceUri: `evidence://immutability/${index}`,
    checksumSha256: sha,
    details: {},
    createdAt: at,
  },
]));
const drills: RestoreDrillRecord[] = healthyTargets.map((target, index) => ({
  drillId: `drill-${index}`,
  targetKey: target.targetKey,
  sourceRunId: runs[index].runId,
  requestId: null,
  status: "succeeded",
  environmentKind: "isolated",
  restorePointAt: at,
  startedAt: at,
  finishedAt: at,
  isolationVerified: true,
  productionWriteCount: 0,
  evidenceUri: `evidence://drill/${index}`,
  evidenceSha256: sha,
  errorCode: null,
  details: {},
  createdAt: at,
}));
const checks: RestoreVerificationCheckRecord[] = drills.flatMap((drill) => REQUIRED_RESTORE_CHECK_SCOPES.map((scope) => ({
  checkId: `${drill.drillId}-${scope}`,
  drillId: drill.drillId,
  checkKey: `${scope}-check`,
  checkScope: scope,
  status: "passed" as const,
  expectedCount: "1",
  observedCount: "1",
  expectedDigest: null,
  observedDigest: null,
  checkedAt: at,
  evidenceUri: `evidence://check/${drill.drillId}/${scope}`,
  evidenceSha256: sha,
  details: {},
  createdAt: at,
})));
const receipts: BackupRpoRtoReceiptRecord[] = drills.map((drill, index) => ({
  receiptId: `receipt-${index}`,
  drillId: drill.drillId,
  targetKey: healthyTargets[index].targetKey,
  status: "verified",
  observedRpoSeconds: 1,
  observedRtoSeconds: 1,
  measuredAt: at,
  evidenceUri: `evidence://receipt/${index}`,
  evidenceSha256: sha,
  details: {},
  createdAt: at,
}));

check(() => {
  const result = inspectBackupRestoreConsistency({
    targets: healthyTargets,
    requests: [],
    runs,
    artifacts,
    retentionEvidence,
    drills,
    checks,
    receipts,
    events: [],
  });
  assert.equal(result.evidenceState, "available");
  assert.deepEqual(result.backupRunCoverage, { expectedTargets: 7, verifiedTargets: 7 });
  assert.deepEqual(result.protectionCoverage, { expectedTargets: 7, verifiedTargets: 7 });
  assert.deepEqual(result.restoreDrillCoverage, { expectedTargets: 7, verifiedTargets: 7 });
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.latestVerifiedRpoRto, {
    targetKey: "source",
    measuredAt: at,
    observedRpoSeconds: 1,
    observedRtoSeconds: 1,
  });
});

check(() => {
  const result = inspectBackupRestoreConsistency({
    ...emptyEvidence,
    requests: [{
      requestId: "unsafe-request",
      targetKey: "database",
      operationKind: "restore_drill_plan",
      requestStatus: "approved",
      executionMode: "plan_request_approval_only",
      plan: {},
      requestedBy: "one",
      requestedAt: at,
      approvedBy: "two",
      approvedAt: at,
      approvalReason: "fixture",
      executionEnabled: false,
      externalUploadEnabled: false,
      restoreEnabled: true,
      deleteEnabled: false,
      serviceSwitchEnabled: false,
      expiresAt: null,
      createdAt: at,
      updatedAt: at,
    }],
  });
  assert.ok(result.issues.some((issue) => issue.code === "BACKUP_EXECUTION_BOUNDARY_VIOLATED"));
});

check(() => {
  assert.equal(policy.implementationStatus.databasePitr, "must be verified on provider");
  assert.equal(policy.implementationStatus.objectVersioningAndReplication, "must be verified on provider");
  assert.equal(policy.implementationStatus.productionRestoreDrill, "not yet executed");

  const adminPage = readFileSync(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
  const unsupportedClaims = [/每天凌晨3点自动备份/u, /双端备份/u, /一键恢复/u].filter((pattern) => pattern.test(adminPage));
  assert.equal(unsupportedClaims.length, 0, "unsupported backup or direct-restore claim returned to the admin UI");

  const backupScript = readFileSync(new URL("../runtime-tools/backup-data.sh", import.meta.url), "utf8");
  const restoreScript = readFileSync(new URL("./restore-data.sh", import.meta.url), "utf8");
  const cosSnapshot = readFileSync(new URL("./cos-data-snapshot.mjs", import.meta.url), "utf8");
  assert.match(backupScript, /导出失败.*跳过/u);
  assert.doesNotMatch(backupScript, /sha256|checksum/u);
  assert.match(restoreScript, /resolution=merge-duplicates/u);
  assert.doesNotMatch(restoreScript, /isolated|隔离环境/u);
  assert.match(cosSnapshot, /skip \$\{table\}/u);
  assert.doesNotMatch(cosSnapshot, /sha256|checksum/u);
});

check(() => {
  const migration = readFileSync(new URL("../supabase/migrations/20261002180000_backup_restore_control_plane.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../supabase/rollbacks/20261002180000_backup_restore_control_plane.rollback.sql", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/admin/backup-restore-control-plane/route.ts", import.meta.url), "utf8");
  const server = readFileSync(new URL("../src/lib/server/backup-restore-control-plane.ts", import.meta.url), "utf8");
  const localProbe = readFileSync(new URL("./verify-backup-restore-control-plane-local.mjs", import.meta.url), "utf8");
  const tables = [
    "backup_control_targets", "backup_control_requests", "backup_runs", "backup_artifacts",
    "backup_retention_evidence", "restore_drills", "restore_verification_checks",
    "backup_rpo_rto_receipts", "backup_control_events",
  ];
  for (const table of tables) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\b`, "u"));
    assert.match(migration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "u"));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated`, "u"));
    assert.match(migration, new RegExp(`REVOKE ALL ON TABLE public\\.${table} FROM service_role`, "u"));
    assert.match(migration, new RegExp(`GRANT SELECT ON TABLE public\\.${table} TO service_role`, "u"));
    assert.match(rollback, new RegExp(`DROP TABLE IF EXISTS public\\.${table}`, "u"));
  }
  assert.match(migration, /plan_request_approval_only/u);
  assert.match(migration, /NO_CURRENT_EXTERNAL_BACKUP_EVIDENCE/u);
  assert.match(migration, /BACKUP_RESTORE_TARGET_SEED_CONFLICT/u);
  assert.doesNotMatch(migration, /CREATE(?: OR REPLACE)? FUNCTION|GRANT EXECUTE/u);
  assert.doesNotMatch(migration, /ALTER TABLE public\.(?:users|credit_transactions|cash_transactions|revenue_records|payment_orders|user_files|system_logs)\b/u);
  assert.match(rollback, /BACKUP_RESTORE_ROLLBACK_REQUIRES_EMPTY_EVIDENCE/u);
  assert.match(rollback, /BACKUP_RESTORE_ROLLBACK_REQUIRES_UNCHANGED_TARGET_SEED/u);
  assert.match(rollback, /^BEGIN;\s*/u);
  assert.match(rollback, /\sCOMMIT;\s*$/u);
  assert.match(route, /authorizeAdminCapability\(request, "backups\.manage"/u);
  assert.match(route, /export async function GET/u);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/u);
  assert.doesNotMatch(server, /\.insert\(|\.update\(|\.delete\(|\.rpc\(/u);
  assert.match(server, /BACKUP_RESTORE_SCHEMA_UNAVAILABLE/u);
  assert.match(localProbe, /runtime\.ownerConnection\?\.host, "127\.0\.0\.1"/u);
  assert.match(localProbe, /await client\.query\("ROLLBACK"\)/u);
  assert.match(localProbe, /LOCAL_PROBE_MUST_NOT_PERSIST_SCHEMA/u);
});

process.stdout.write(`${JSON.stringify({
  passed,
  failed: 0,
  policyTargets: BACKUP_TARGET_DEFINITIONS.length,
  currentExternalEvidence: "unavailable",
  currentVerifiedRpoSeconds: null,
  currentVerifiedRtoSeconds: null,
  unsupportedLegacyUiClaims: 0,
  backupExecutions: 0,
  restoreExecutions: 0,
  externalUploads: 0,
  destructiveActions: 0,
  productionWrites: 0,
})}\n`);
