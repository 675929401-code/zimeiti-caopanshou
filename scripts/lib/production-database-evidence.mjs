// Pure consistency checks only. This module does not authenticate inputs, read
// files, connect to PostgreSQL, verify signatures or authorize an apply.
// The caller must independently establish every trusted value from trusted
// sources and must verify actual artifact bytes and report authenticity.

const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^[1-9][0-9]*$/u;
const MAX_SYSTEM_IDENTIFIER = (1n << 64n) - 1n;
const MAX_DATABASE_OID = (1n << 32n) - 1n;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

const RESTORE_CHECKS = Object.freeze([
  "schema", "functions", "owners", "acls", "searchPath", "extensions",
  "sequences", "rowCounts", "billingAggregates", "roles", "databaseProperties",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function sha(value) {
  return typeof value === "string" && SHA256.test(value) && value !== "0".repeat(64);
}
function positiveDecimal(value, maximum) {
  return typeof value === "string" && DECIMAL.test(value)
    && value.length <= maximum.toString().length && BigInt(value) <= maximum;
}
function databaseName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 63
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}
function sourceIdentity(value) {
  return plainObject(value) && positiveDecimal(value.systemIdentifier, MAX_SYSTEM_IDENTIFIER)
    && positiveDecimal(value.databaseOid, MAX_DATABASE_OID) && databaseName(value.databaseName)
    && sha(value.serverIdentitySha256);
}
function sameIdentity(a, b) {
  return a.systemIdentifier === b.systemIdentifier && a.databaseOid === b.databaseOid
    && a.databaseName === b.databaseName && a.serverIdentitySha256 === b.serverIdentitySha256;
}
const SNAPSHOT_FIELDS = Object.freeze(["ledgerSha256", "schemaSha256", "securitySha256", "migrationManifestSha256"]);
function validSnapshot(value) {
  return sourceIdentity(value) && SNAPSHOT_FIELDS.every((key) => sha(value[key]));
}
function sameSnapshot(a, b) {
  return sameIdentity(a, b) && SNAPSHOT_FIELDS.every((key) => a[key] === b[key]);
}

/**
 * Validate the consistency of candidate evidence against independently trusted
 * observations. No input is self-authenticating; a true result is NOT a backup,
 * restore, migration-readiness or production authorization decision.
 *
 * `trusted` must be produced outside the receipt: a freshly observed production
 * identity and fingerprints, independently checked artifact byte digests,
 * authenticated restore-report digest, and an independently observed restore
 * cluster identity. `now` is supplied by the caller from a trusted UTC clock.
 * Both the live checks and the result can go stale immediately after this call.
 */
export function checkProductionDatabaseEvidence(receipt, trusted, now) {
  const errors = [];
  if (!plainObject(receipt) || !plainObject(trusted)) {
    return { ok: false, errors: ["EVIDENCE_INPUT_INVALID"] };
  }
  if (receipt.schemaVersion !== "production-database-evidence.v1") errors.push("EVIDENCE_SCHEMA_INVALID");
  if (receipt.targetClass !== "production-postgresql") errors.push("TARGET_CLASS_INVALID");

  const source = receipt.source;
  const live = trusted.liveSource;
  if (!sourceIdentity(source) || !sourceIdentity(live)) errors.push("SOURCE_IDENTITY_INVALID");
  else if (!sameIdentity(source, live)) errors.push("SOURCE_IDENTITY_MISMATCH");

  for (const key of SNAPSHOT_FIELDS) {
    if (!sha(source?.[key]) || !sha(live?.[key])) errors.push(`SOURCE_${key.toUpperCase()}_INVALID`);
    else if (source[key] !== live[key]) errors.push(`SOURCE_${key.toUpperCase()}_MISMATCH`);
  }

  const backup = receipt.backup;
  const checked = trusted.checkedArtifacts;
  if (!plainObject(backup) || backup.encryption !== "age" || backup.format !== "postgres-custom"
      || backup.consistentSnapshot !== true || backup.retainsOwnerAndAcl !== true
      || backup.globalsAndDatabasePropertiesIncluded !== true) errors.push("BACKUP_CONTRACT_INVALID");
  for (const key of ["encryptedArchiveSha256", "dumpSha256", "globalsSha256"]) {
    if (!sha(backup?.[key]) || !sha(checked?.[key])) errors.push(`BACKUP_${key.toUpperCase()}_INVALID`);
    else if (backup[key] !== checked[key]) errors.push(`BACKUP_${key.toUpperCase()}_MISMATCH`);
  }
  if (!plainObject(checked) || checked.archiveBytesVerified !== true || checked.decryptedBytesVerified !== true
      || checked.globalsBytesVerified !== true || checked.authenticityVerified !== true
      || checked.receiptAuthenticityVerified !== true) {
    errors.push("BACKUP_INDEPENDENT_VERIFICATION_MISSING");
  }

  // A valid archive alone does not prove its claimed source. These values must
  // be independently parsed from authenticated backup metadata, not copied
  // from the candidate receipt; its hash and all byte digests bind that source
  // snapshot to this particular archive and its contents.
  const authenticatedBackup = trusted.authenticatedBackup;
  if (!plainObject(authenticatedBackup) || authenticatedBackup.metadataAuthenticityVerified !== true
      || !sha(backup?.metadataSha256) || !sha(authenticatedBackup?.metadataSha256)
      || backup.metadataSha256 !== authenticatedBackup.metadataSha256
      || !validSnapshot(authenticatedBackup?.source)
      || authenticatedBackup.encryption !== backup.encryption || authenticatedBackup.format !== backup.format
      || authenticatedBackup.consistentSnapshot !== true || authenticatedBackup.retainsOwnerAndAcl !== true
      || authenticatedBackup.globalsAndDatabasePropertiesIncluded !== true
      || authenticatedBackup.startedAt !== backup.startedAt || authenticatedBackup.completedAt !== backup.completedAt) {
    errors.push("AUTHENTICATED_BACKUP_METADATA_INVALID");
  } else {
    if (!validSnapshot(source) || !sameSnapshot(authenticatedBackup.source, source)
        || !validSnapshot(live) || !sameSnapshot(authenticatedBackup.source, live)) {
      errors.push("AUTHENTICATED_BACKUP_SOURCE_MISMATCH");
    }
    if (["encryptedArchiveSha256", "dumpSha256", "globalsSha256"].some(
      (key) => !sha(authenticatedBackup[key]) || authenticatedBackup[key] !== backup[key]
        || authenticatedBackup[key] !== checked?.[key],
    )) errors.push("AUTHENTICATED_BACKUP_CONTENT_MISMATCH");
  }

  const restore = receipt.restore;
  const observedRestore = trusted.observedRestore;
  if (!plainObject(restore) || !plainObject(observedRestore)
      || !positiveDecimal(restore?.systemIdentifier, MAX_SYSTEM_IDENTIFIER)
      || !positiveDecimal(observedRestore?.systemIdentifier, MAX_SYSTEM_IDENTIFIER)
      || !positiveDecimal(restore?.databaseOid, MAX_DATABASE_OID)
      || !positiveDecimal(observedRestore?.databaseOid, MAX_DATABASE_OID)
      || !databaseName(restore?.databaseName) || !databaseName(observedRestore?.databaseName)) {
    errors.push("RESTORE_IDENTITY_INVALID");
  } else {
    if (restore.systemIdentifier !== observedRestore.systemIdentifier
        || restore.databaseOid !== observedRestore.databaseOid
        || restore.databaseName !== observedRestore.databaseName) errors.push("RESTORE_IDENTITY_MISMATCH");
    if (sourceIdentity(source) && restore.systemIdentifier === source.systemIdentifier) errors.push("RESTORE_CLUSTER_NOT_INDEPENDENT");
  }
  if (!plainObject(restore) || restore.completed !== true || restore.isolated !== true
      || restore.archiveSha256 !== backup?.encryptedArchiveSha256 || restore.dumpSha256 !== backup?.dumpSha256
      || !sha(restore.reportSha256) || !sha(observedRestore?.reportSha256)
      || restore.reportSha256 !== observedRestore.reportSha256
      || observedRestore.reportAuthenticityVerified !== true
      || observedRestore.completed !== true || observedRestore.isolated !== true
      || restore.archiveSha256 !== observedRestore.archiveSha256
      || restore.dumpSha256 !== observedRestore.dumpSha256
      || restore.completedAt !== observedRestore.completedAt
      || !sha(restore.backupMetadataSha256) || restore.backupMetadataSha256 !== backup?.metadataSha256
      || restore.backupMetadataSha256 !== observedRestore.backupMetadataSha256
      || !validSnapshot(restore.source) || !validSnapshot(observedRestore.source)
      || !validSnapshot(authenticatedBackup?.source)
      || !sameSnapshot(restore.source, authenticatedBackup.source)
      || !sameSnapshot(observedRestore.source, authenticatedBackup.source)) errors.push("RESTORE_REPORT_INVALID");
  if (!plainObject(restore?.checks) || !plainObject(observedRestore?.checks)
      || RESTORE_CHECKS.some((key) => restore.checks[key] !== true || observedRestore.checks[key] !== true)) {
    errors.push("RESTORE_CHECKS_INCOMPLETE");
  }

  const currentTime = timestamp(now);
  const started = timestamp(backup?.startedAt);
  const completed = timestamp(backup?.completedAt);
  const restored = timestamp(restore?.completedAt);
  const observed = timestamp(trusted.observedAt);
  if (![currentTime, started, completed, restored, observed].every(Number.isFinite)
      || started > completed || completed > restored || restored > observed || observed > currentTime
      || currentTime - started > MAX_EVIDENCE_AGE_MS) errors.push("EVIDENCE_TIME_INVALID_OR_STALE");
  return { ok: errors.length === 0, errors };
}
