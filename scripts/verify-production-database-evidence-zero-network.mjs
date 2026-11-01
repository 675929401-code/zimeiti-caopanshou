import assert from "node:assert/strict";
import { checkProductionDatabaseEvidence } from "./lib/production-database-evidence.mjs";

// Synthetic values only. No DB, network, files, real backup, keys or credentials.
const sha = (char) => char.repeat(64);
const source = {
  systemIdentifier: "700000000000000001", databaseOid: "1024", databaseName: "synthetic_source",
  serverIdentitySha256: sha("a"), ledgerSha256: sha("b"), schemaSha256: sha("c"),
  securitySha256: sha("d"), migrationManifestSha256: sha("e"),
};
const receipt = {
  schemaVersion: "production-database-evidence.v1", targetClass: "production-postgresql",
  source: structuredClone(source),
  backup: {
    encryption: "age", format: "postgres-custom", consistentSnapshot: true,
    retainsOwnerAndAcl: true, globalsAndDatabasePropertiesIncluded: true,
    encryptedArchiveSha256: sha("1"), dumpSha256: sha("2"), globalsSha256: sha("3"), metadataSha256: sha("5"),
    startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:10:00.000Z",
  },
  restore: {
    systemIdentifier: "700000000000000002", databaseOid: "1025", databaseName: "synthetic_restore",
    completed: true, isolated: true, archiveSha256: sha("1"), dumpSha256: sha("2"), reportSha256: sha("4"),
    backupMetadataSha256: sha("5"), source: structuredClone(source),
    completedAt: "2026-01-01T00:30:00.000Z",
    checks: {
      schema: true, functions: true, owners: true, acls: true, searchPath: true,
      extensions: true, sequences: true, rowCounts: true, billingAggregates: true,
      roles: true, databaseProperties: true,
    },
  },
};
const trusted = {
  observedAt: "2026-01-01T00:40:00.000Z", liveSource: structuredClone(source),
  checkedArtifacts: {
    encryptedArchiveSha256: sha("1"), dumpSha256: sha("2"), globalsSha256: sha("3"),
    archiveBytesVerified: true, decryptedBytesVerified: true, globalsBytesVerified: true, authenticityVerified: true,
    receiptAuthenticityVerified: true,
  },
  authenticatedBackup: {
    metadataAuthenticityVerified: true, metadataSha256: sha("5"), source: structuredClone(source),
    encryptedArchiveSha256: sha("1"), dumpSha256: sha("2"), globalsSha256: sha("3"),
    encryption: "age", format: "postgres-custom", consistentSnapshot: true, retainsOwnerAndAcl: true,
    globalsAndDatabasePropertiesIncluded: true, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:10:00.000Z",
  },
  observedRestore: {
    systemIdentifier: "700000000000000002", databaseOid: "1025", databaseName: "synthetic_restore",
    reportSha256: sha("4"), reportAuthenticityVerified: true, completed: true, isolated: true,
    archiveSha256: sha("1"), dumpSha256: sha("2"), completedAt: "2026-01-01T00:30:00.000Z",
    backupMetadataSha256: sha("5"), source: structuredClone(source),
    checks: structuredClone(receipt.restore.checks),
  },
};
const now = "2026-01-01T01:00:00.000Z";
const original = JSON.stringify({ receipt, trusted });
assert.deepEqual(checkProductionDatabaseEvidence(receipt, trusted, now), { ok: true, errors: [] });
assert.equal(JSON.stringify({ receipt, trusted }), original, "validator must not mutate input");
let negativeCases = 0;
function reject(change, expected) {
  const r = structuredClone(receipt);
  const t = structuredClone(trusted);
  const clock = { now };
  change(r, t, clock);
  const result = checkProductionDatabaseEvidence(r, t, clock.now);
  assert.equal(result.ok, false, expected);
  assert.ok(result.errors.includes(expected), `${expected}: ${result.errors.join(", ")}`);
  negativeCases += 1;
}
reject((r) => { r.schemaVersion = "future-version"; }, "EVIDENCE_SCHEMA_INVALID");
reject((r) => { r.targetClass = "local-loopback-only"; }, "TARGET_CLASS_INVALID");
reject((r) => { r.source.systemIdentifier = "0"; }, "SOURCE_IDENTITY_INVALID");
reject((r) => { r.source.systemIdentifier = "18446744073709551616"; }, "SOURCE_IDENTITY_INVALID");
reject((r) => { r.source.databaseOid = "4294967296"; }, "SOURCE_IDENTITY_INVALID");
reject((r) => { r.source.databaseName = ""; }, "SOURCE_IDENTITY_INVALID");
reject((r) => { r.source.serverIdentitySha256 = sha("0"); }, "SOURCE_IDENTITY_INVALID");
for (const [key, value] of [["systemIdentifier", "700000000000000003"], ["databaseOid", "1026"],
  ["databaseName", "another"], ["serverIdentitySha256", sha("f")]]) {
  reject((r) => { r.source[key] = value; }, "SOURCE_IDENTITY_MISMATCH");
}
for (const key of ["ledgerSha256", "schemaSha256", "securitySha256", "migrationManifestSha256"]) {
  reject((r) => { r.source[key] = "missing"; }, `SOURCE_${key.toUpperCase()}_INVALID`);
  reject((r) => { r.source[key] = sha("f"); }, `SOURCE_${key.toUpperCase()}_MISMATCH`);
}
reject((r) => { r.backup.encryption = "none"; }, "BACKUP_CONTRACT_INVALID");
reject((r) => { r.backup.consistentSnapshot = false; }, "BACKUP_CONTRACT_INVALID");
reject((r) => { r.backup.retainsOwnerAndAcl = false; }, "BACKUP_CONTRACT_INVALID");
reject((r) => { r.backup.globalsAndDatabasePropertiesIncluded = false; }, "BACKUP_CONTRACT_INVALID");
for (const key of ["encryptedArchiveSha256", "dumpSha256", "globalsSha256"]) {
  reject((r) => { r.backup[key] = "not-a-sha"; }, `BACKUP_${key.toUpperCase()}_INVALID`);
  reject((r) => { r.backup[key] = sha("f"); }, `BACKUP_${key.toUpperCase()}_MISMATCH`);
}
for (const key of ["archiveBytesVerified", "decryptedBytesVerified", "globalsBytesVerified", "authenticityVerified", "receiptAuthenticityVerified"]) {
  reject((r, t) => { t.checkedArtifacts[key] = false; }, "BACKUP_INDEPENDENT_VERIFICATION_MISSING");
}
reject((r, t) => { t.authenticatedBackup.metadataAuthenticityVerified = false; }, "AUTHENTICATED_BACKUP_METADATA_INVALID");
reject((r, t) => { t.authenticatedBackup.metadataSha256 = sha("6"); }, "AUTHENTICATED_BACKUP_METADATA_INVALID");
reject((r, t) => { t.authenticatedBackup.startedAt = "2025-12-30T00:00:00.000Z"; }, "AUTHENTICATED_BACKUP_METADATA_INVALID");
reject((r, t) => { t.authenticatedBackup.retainsOwnerAndAcl = false; }, "AUTHENTICATED_BACKUP_METADATA_INVALID");
for (const key of ["ledgerSha256", "schemaSha256", "securitySha256", "migrationManifestSha256"]) {
  reject((r, t) => { t.authenticatedBackup.source[key] = sha("f"); }, "AUTHENTICATED_BACKUP_SOURCE_MISMATCH");
}
reject((r, t) => { t.authenticatedBackup.source.systemIdentifier = "700000000000000003"; }, "AUTHENTICATED_BACKUP_SOURCE_MISMATCH");
reject((r, t) => { t.authenticatedBackup.source.databaseOid = "1026"; }, "AUTHENTICATED_BACKUP_SOURCE_MISMATCH");
reject((r, t) => { t.authenticatedBackup.encryptedArchiveSha256 = sha("6"); }, "AUTHENTICATED_BACKUP_CONTENT_MISMATCH");
// A real authenticated B archive/restore must not pass when spliced into an A
// receipt and compared to A's current live target. All B bindings agree among
// themselves; the decisive mismatch is the independently authenticated source.
reject((r, t) => {
  const b = { ...structuredClone(source), systemIdentifier: "700000000000000003", databaseOid: "1026", databaseName: "synthetic_b" };
  const values = { encryptedArchiveSha256: sha("6"), dumpSha256: sha("7"), globalsSha256: sha("8") };
  Object.assign(r.backup, values, { metadataSha256: sha("9") });
  Object.assign(t.checkedArtifacts, values);
  Object.assign(t.authenticatedBackup, values, { source: b, metadataSha256: sha("9") });
  Object.assign(r.restore, { source: structuredClone(b), backupMetadataSha256: sha("9"), archiveSha256: sha("6"), dumpSha256: sha("7") });
  Object.assign(t.observedRestore, { source: structuredClone(b), backupMetadataSha256: sha("9"), archiveSha256: sha("6"), dumpSha256: sha("7") });
}, "AUTHENTICATED_BACKUP_SOURCE_MISMATCH");
reject((r) => { r.restore.systemIdentifier = "not-physical"; }, "RESTORE_IDENTITY_INVALID");
reject((r) => { r.restore.systemIdentifier = "700000000000000003"; }, "RESTORE_IDENTITY_MISMATCH");
reject((r, t) => { r.restore.systemIdentifier = r.source.systemIdentifier; t.observedRestore.systemIdentifier = r.source.systemIdentifier; }, "RESTORE_CLUSTER_NOT_INDEPENDENT");
reject((r) => { r.restore.archiveSha256 = sha("f"); }, "RESTORE_REPORT_INVALID");
reject((r) => { r.restore.dumpSha256 = sha("f"); }, "RESTORE_REPORT_INVALID");
reject((r) => { r.restore.reportSha256 = sha("f"); }, "RESTORE_REPORT_INVALID");
reject((r, t) => { t.observedRestore.reportAuthenticityVerified = false; }, "RESTORE_REPORT_INVALID");
reject((r, t) => { t.observedRestore.archiveSha256 = sha("f"); }, "RESTORE_REPORT_INVALID");
reject((r, t) => { t.observedRestore.completedAt = "2026-01-01T00:35:00.000Z"; }, "RESTORE_REPORT_INVALID");
reject((r, t) => { t.observedRestore.backupMetadataSha256 = sha("6"); }, "RESTORE_REPORT_INVALID");
reject((r, t) => { t.observedRestore.source.systemIdentifier = "700000000000000003"; }, "RESTORE_REPORT_INVALID");
reject((r) => { r.restore.source.ledgerSha256 = sha("6"); }, "RESTORE_REPORT_INVALID");
reject((r) => { r.restore.isolated = false; }, "RESTORE_REPORT_INVALID");
for (const key of Object.keys(receipt.restore.checks)) {
  reject((r) => { r.restore.checks[key] = false; }, "RESTORE_CHECKS_INCOMPLETE");
  reject((r, t) => { t.observedRestore.checks[key] = false; }, "RESTORE_CHECKS_INCOMPLETE");
}
reject((r) => { r.backup.startedAt = "2025-12-30T00:00:00.000Z"; }, "EVIDENCE_TIME_INVALID_OR_STALE");
reject((r) => { r.backup.completedAt = "2026-01-01T00:35:00.000Z"; }, "EVIDENCE_TIME_INVALID_OR_STALE");
reject((r, t) => { t.observedAt = "2026-01-01T02:00:00.000Z"; }, "EVIDENCE_TIME_INVALID_OR_STALE");
reject((r, t, c) => { c.now = "2026-01-01T01:00:00Z"; }, "EVIDENCE_TIME_INVALID_OR_STALE");
assert.deepEqual(checkProductionDatabaseEvidence(null, trusted, now), { ok: false, errors: ["EVIDENCE_INPUT_INVALID"] });
negativeCases += 1;
console.log(JSON.stringify({ passed: true, negativeCases, syntheticOnly: true,
  realDatabaseConnections: 0, realDatabaseWrites: 0, networkCalls: 0,
  meaning: "Consistency checks only; no real backup, restore, provenance or production apply verified" }));
