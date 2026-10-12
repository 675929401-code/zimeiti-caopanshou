#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const MANIFEST_SCHEMA = "zimeiti-backup-package.v1";
const BACKUP_RECEIPT_SCHEMA = "zimeiti-backup-receipt.v1";
const RESTORE_RECEIPT_SCHEMA = "zimeiti-restore-receipt.v1";
const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const SAFE_DATABASE = /^zimeiti_restore_[a-z0-9_]+$/u;
const SAFE_ROLE = /^[a-z_][a-z0-9_-]{0,62}$/u;
const SYSTEM_IDENTIFIER = /^[0-9]{10,20}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const NONCE = /^[a-f0-9]{32,128}$/u;

function fail(message) {
  throw new Error(message);
}

function argument(name, { multiple = false, required = true } = {}) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === name) values.push(process.argv[index + 1] || "");
  }
  if (required && values.length === 0) fail(`ARGUMENT_REQUIRED:${name}`);
  return multiple ? values : values.at(-1) || "";
}

function integerArgument(name, minimum = 0) {
  const value = Number(argument(name));
  if (!Number.isSafeInteger(value) || value < minimum) fail(`INTEGER_ARGUMENT_INVALID:${name}`);
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function safeName(name, relative) {
  if (!name || /[\u0000-\u001f\u007f]/u.test(name)) fail(`UNSAFE_FILE_NAME:${relative}`);
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDisjoint(leftInput, rightInput) {
  const left = fs.realpathSync(leftInput);
  const right = fs.realpathSync(rightInput);
  if (isInsideOrEqual(left, right) || isInsideOrEqual(right, left)) fail("PATHS_MUST_BE_BIDIRECTIONALLY_DISJOINT");
}

function regularFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      safeName(entry.name, relative);
      const info = fs.lstatSync(absolute);
      if (info.isSymbolicLink()) fail(`SYMLINK_NOT_ALLOWED:${relative}`);
      if (info.isDirectory()) walk(absolute);
      else if (info.isFile()) files.push(absolute);
      else fail(`NON_REGULAR_FILE_NOT_ALLOWED:${relative}`);
    }
  }
  walk(root);
  return files.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
}

function treeSnapshot(rootInput, excludedNames = new Set()) {
  const root = fs.realpathSync(rootInput);
  const files = regularFiles(root)
    .filter(file => !path.relative(root, file).split(path.sep).some(part => excludedNames.has(part)))
    .map(file => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    }));
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, item) => sum + item.bytes, 0),
    treeSha256: crypto.createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

function copyTree(sourceInput, destination, excludedNames) {
  const source = fs.realpathSync(sourceInput);
  if (!fs.statSync(source).isDirectory()) fail(`SOURCE_DIRECTORY_REQUIRED:${source}`);
  if (fs.existsSync(destination)) fail(`DESTINATION_MUST_NOT_EXIST:${destination}`);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  function copy(directory, targetDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludedNames.has(entry.name)) continue;
      const sourcePath = path.join(directory, entry.name);
      const targetPath = path.join(targetDirectory, entry.name);
      const relative = path.relative(source, sourcePath).split(path.sep).join("/");
      safeName(entry.name, relative);
      const info = fs.lstatSync(sourcePath);
      if (info.isSymbolicLink()) fail(`SOURCE_SYMLINK_NOT_ALLOWED:${relative}`);
      if (info.isDirectory()) {
        fs.mkdirSync(targetPath, { mode: 0o700 });
        copy(sourcePath, targetPath);
      } else if (info.isFile()) {
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(targetPath, 0o600);
      } else {
        fail(`SOURCE_NON_REGULAR_FILE_NOT_ALLOWED:${relative}`);
      }
    }
  }
  copy(source, destination);
}

function compareTree(expectedRoot, actualRoot, label) {
  if (!SAFE_ID.test(label)) fail("COMPONENT_LABEL_INVALID");
  assert.deepEqual(treeSnapshot(actualRoot), treeSnapshot(expectedRoot), `${label}_TREE_BYTES_HASH_MISMATCH`);
}

function makeComponentSnapshot(component, method, startedEpoch, completedEpoch, evidenceSha256) {
  if (!SAFE_ID.test(component) || !SAFE_ID.test(method)) fail("COMPONENT_SNAPSHOT_ID_INVALID");
  if (![startedEpoch, completedEpoch].every(Number.isSafeInteger) || startedEpoch < 1 || completedEpoch < startedEpoch) fail("COMPONENT_SNAPSHOT_TIME_INVALID");
  if (!SHA256.test(evidenceSha256)) fail("COMPONENT_SNAPSHOT_EVIDENCE_SHA256_INVALID");
  return {
    component,
    method,
    startedEpoch,
    completedEpoch,
    consistency: "verified",
    sharedWithOtherComponents: false,
    evidenceSha256,
  };
}

function stableCopyTree(source, destination, report, label, excludedNames) {
  if (!SAFE_ID.test(label)) fail("COMPONENT_LABEL_INVALID");
  const startedEpoch = Math.floor(Date.now() / 1000);
  const before = treeSnapshot(source, excludedNames);
  copyTree(source, destination, excludedNames);
  const after = treeSnapshot(source, excludedNames);
  const copied = treeSnapshot(destination);
  assert.deepEqual(after, before, `SOURCE_TREE_CHANGED_DURING_COPY:${label}`);
  assert.deepEqual(copied, before, `COPIED_TREE_MISMATCH:${label}`);
  const completedEpoch = Math.floor(Date.now() / 1000);
  const evidenceSha256 = crypto.createHash("sha256").update(JSON.stringify(before)).digest("hex");
  writeJson(report, {
    schemaVersion: "zimeiti-file-tree-snapshot.v1",
    component: label,
    stableBeforeAndAfter: true,
    destinationMatchesSource: true,
    fileCount: before.fileCount,
    totalBytes: before.totalBytes,
    treeSha256: before.treeSha256,
    componentSnapshot: makeComponentSnapshot(label, "pre-post-sha256-tree", startedEpoch, completedEpoch, evidenceSha256),
  });
}

function sqliteRows(database) {
  const integrity = database.prepare("PRAGMA integrity_check").all().map(row => String(row.integrity_check));
  if (integrity.length !== 1 || integrity[0] !== "ok") fail(`SQLITE_INTEGRITY_CHECK_FAILED:${integrity.slice(0, 3).join(",")}`);
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rowCounts = {};
  for (const row of tables) {
    const table = String(row.name);
    const quoted = `"${table.replaceAll('"', '""')}"`;
    rowCounts[table] = Number(database.prepare(`SELECT count(*) AS count FROM ${quoted}`).get().count);
  }
  return rowCounts;
}

async function sqliteBackup(sourceInput, destination, report, label) {
  if (!SAFE_ID.test(label)) fail("COMPONENT_LABEL_INVALID");
  const source = fs.realpathSync(sourceInput);
  if (!fs.statSync(source).isFile()) fail(`SQLITE_SOURCE_REQUIRED:${source}`);
  if (fs.existsSync(destination)) fail(`SQLITE_DESTINATION_MUST_NOT_EXIST:${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const startedEpoch = Math.floor(Date.now() / 1000);
  const sourceDatabase = new DatabaseSync(source, { readOnly: false, timeout: 30_000 });
  let checkpoint;
  try {
    checkpoint = sourceDatabase.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    await backup(sourceDatabase, destination, { rate: 1000 });
  } finally {
    sourceDatabase.close();
  }
  const copied = new DatabaseSync(destination, { readOnly: true });
  let rowCounts;
  try {
    rowCounts = sqliteRows(copied);
  } finally {
    copied.close();
  }
  const completedEpoch = Math.floor(Date.now() / 1000);
  const bytes = fs.statSync(destination).size;
  const digest = sha256(destination);
  writeJson(report, {
    schemaVersion: "zimeiti-sqlite-audit.v1",
    database: path.basename(source),
    walCheckpoint: checkpoint || {},
    integrityCheck: "ok",
    rowCounts,
    bytes,
    sha256: digest,
    componentSnapshot: makeComponentSnapshot(label, "sqlite-online-backup", startedEpoch, completedEpoch, digest),
  });
}

function sqliteAudit(sourceInput, report) {
  const source = fs.realpathSync(sourceInput);
  const database = new DatabaseSync(source, { readOnly: true });
  let rowCounts;
  try {
    rowCounts = sqliteRows(database);
  } finally {
    database.close();
  }
  writeJson(report, {
    schemaVersion: "zimeiti-sqlite-restore-audit.v1",
    database: path.basename(source),
    integrityCheck: "ok",
    rowCounts,
    bytes: fs.statSync(source).size,
    sha256: sha256(source),
  });
}

function buildManifest(root, metadataFile, output) {
  const outputPath = path.resolve(output);
  const files = regularFiles(root)
    .filter(file => path.resolve(file) !== outputPath)
    .map(file => ({
      path: path.relative(root, file).split(path.sep).join("/"),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    }));
  writeJson(output, {
    schemaVersion: MANIFEST_SCHEMA,
    createdAt: new Date().toISOString(),
    metadata: readJson(metadataFile),
    files,
  });
}

function verifyManifest(root, manifestFile) {
  const manifest = readJson(manifestFile);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA) fail("BACKUP_MANIFEST_SCHEMA_UNSUPPORTED");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("BACKUP_MANIFEST_FILES_REQUIRED");
  const expected = new Map();
  for (const entry of manifest.files) {
    const relative = String(entry?.path || "");
    if (!relative || path.isAbsolute(relative) || relative.split("/").includes("..") || expected.has(relative)) fail(`BACKUP_MANIFEST_PATH_INVALID:${relative}`);
    expected.set(relative, entry);
  }
  const actual = new Map(regularFiles(root)
    .filter(file => path.resolve(file) !== path.resolve(manifestFile))
    .map(file => [path.relative(root, file).split(path.sep).join("/"), file]));
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), "BACKUP_MANIFEST_FILE_SET_MISMATCH");
  for (const [relative, file] of actual) {
    const entry = expected.get(relative);
    if (Number(entry.bytes) !== fs.statSync(file).size || String(entry.sha256) !== sha256(file)) fail(`BACKUP_FILE_HASH_MISMATCH:${relative}`);
  }
}

function compareJson(expectedFile, actualFile, label) {
  assert.deepEqual(readJson(actualFile), readJson(expectedFile), `${label}_MISMATCH`);
}

function compareSqliteAudit(expectedFile, actualFile, label) {
  const expected = readJson(expectedFile);
  const actual = readJson(actualFile);
  if (expected.integrityCheck !== "ok" || actual.integrityCheck !== "ok") fail(`${label}_INTEGRITY_CHECK_FAILED`);
  assert.deepEqual(actual.rowCounts, expected.rowCounts, `${label}_ROW_COUNTS_MISMATCH`);
  assert.equal(actual.bytes, expected.bytes, `${label}_BYTES_MISMATCH`);
  assert.equal(actual.sha256, expected.sha256, `${label}_SHA256_MISMATCH`);
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("RECEIPT_OBJECT_REQUIRED");
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail(`RECEIPT_REQUIRED_PROPERTY_MISSING:${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`RECEIPT_ADDITIONAL_PROPERTY:${key}`);
}

function validateSnapshot(snapshot) {
  exactKeys(snapshot, ["component", "method", "startedEpoch", "completedEpoch", "consistency", "sharedWithOtherComponents", "evidenceSha256"]);
  if (!SAFE_ID.test(snapshot.component) || !SAFE_ID.test(snapshot.method)) fail("RECEIPT_COMPONENT_ID_INVALID");
  if (!Number.isSafeInteger(snapshot.startedEpoch) || !Number.isSafeInteger(snapshot.completedEpoch) || snapshot.startedEpoch < 1 || snapshot.completedEpoch < snapshot.startedEpoch) fail("RECEIPT_COMPONENT_TIME_INVALID");
  if (snapshot.consistency !== "verified" || snapshot.sharedWithOtherComponents !== false || !SHA256.test(snapshot.evidenceSha256)) fail("RECEIPT_COMPONENT_TRUTH_INVALID");
}

function validateBackupReceipt(receipt) {
  const required = [
    "schemaVersion", "status", "backupId", "sourceVersion", "createdEpoch", "completedEpoch",
    "artifactCreationDurationSeconds", "oldestComponentAgeAtCompletionSeconds", "encryptedPackage",
    "encryptedSha256", "manifestSha256", "componentSnapshots", "sharedSnapshot",
    "productionConsistency", "productionConsistencyComplete", "sourceTargetDisjoint",
    "expectedDeviceVerified", "plaintextFinalPackage", "finalPackageHashVerified",
    "manifestHashVerified", "atomicCommit",
  ];
  exactKeys(receipt, required);
  if (receipt.schemaVersion !== BACKUP_RECEIPT_SCHEMA || receipt.status !== "complete") fail("BACKUP_RECEIPT_IDENTITY_INVALID");
  if (!/^backup-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(receipt.backupId) || !SAFE_ID.test(receipt.sourceVersion)) fail("BACKUP_RECEIPT_ID_INVALID");
  for (const key of ["createdEpoch", "completedEpoch", "artifactCreationDurationSeconds", "oldestComponentAgeAtCompletionSeconds"]) {
    if (!Number.isSafeInteger(receipt[key]) || receipt[key] < (key.endsWith("Epoch") ? 1 : 0)) fail(`BACKUP_RECEIPT_INTEGER_INVALID:${key}`);
  }
  if (receipt.completedEpoch < receipt.createdEpoch || receipt.artifactCreationDurationSeconds !== receipt.completedEpoch - receipt.createdEpoch) fail("BACKUP_RECEIPT_DURATION_INVALID");
  if (receipt.encryptedPackage !== "package.tar.gz.age" || !SHA256.test(receipt.encryptedSha256) || !SHA256.test(receipt.manifestSha256)) fail("BACKUP_RECEIPT_HASH_INVALID");
  if (!Array.isArray(receipt.componentSnapshots) || receipt.componentSnapshots.length !== 8) fail("BACKUP_RECEIPT_COMPONENTS_INVALID");
  receipt.componentSnapshots.forEach(validateSnapshot);
  if (new Set(receipt.componentSnapshots.map(item => item.component)).size !== 8) fail("BACKUP_RECEIPT_COMPONENT_DUPLICATE");
  if (receipt.sharedSnapshot !== false || receipt.productionConsistency !== "incomplete" || receipt.productionConsistencyComplete !== false || receipt.plaintextFinalPackage !== false) fail("BACKUP_RECEIPT_CONSISTENCY_TRUTH_INVALID");
  for (const key of ["sourceTargetDisjoint", "expectedDeviceVerified", "finalPackageHashVerified", "manifestHashVerified", "atomicCommit"]) if (receipt[key] !== true) fail(`BACKUP_RECEIPT_SUCCESS_TRUTH_INVALID:${key}`);
}

function validateRestoreReceipt(receipt) {
  const base = ["schemaVersion", "status", "restoreId", "phase", "targetDatabase", "startedEpoch", "completedEpoch", "encryptedPackageSha256", "productionOverwriteAttempted"];
  const success = [
    "isolatedFileRootName", "backupAgeAtRestoreStartSeconds", "dataRestoreDurationSeconds",
    "packageHashVerifiedBeforeRestore", "packageHashVerifiedAfterRestore",
    "targetClusterDistinctFromProduction", "targetSystemIdentifierMatchesExpected",
    "provisioningNonceVerified", "minimumPrivilegeRoleVerified", "identityRecheckedAfterRestore",
    "postgresRowCountsMatch", "financialControlsMatch", "commerceSqliteBytesHashAndRowsMatch",
    "voiceSqliteBytesHashAndRowsMatch", "fileManifestVerified", "postgresGlobalsApplied",
    "plaintextWorkspaceOnControlledMount",
  ];
  exactKeys(receipt, base, receipt?.status === "complete" ? success : []);
  if (receipt.schemaVersion !== RESTORE_RECEIPT_SCHEMA || !["complete", "failed"].includes(receipt.status)) fail("RESTORE_RECEIPT_IDENTITY_INVALID");
  if (!/^restore-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(receipt.restoreId) || !SAFE_ID.test(receipt.phase)) fail("RESTORE_RECEIPT_ID_INVALID");
  if (receipt.targetDatabase !== "unknown" && !SAFE_DATABASE.test(receipt.targetDatabase)) fail("RESTORE_RECEIPT_DATABASE_INVALID");
  if (!Number.isSafeInteger(receipt.startedEpoch) || !Number.isSafeInteger(receipt.completedEpoch) || receipt.startedEpoch < 1 || receipt.completedEpoch < receipt.startedEpoch) fail("RESTORE_RECEIPT_TIME_INVALID");
  if (!SHA256.test(receipt.encryptedPackageSha256) || receipt.productionOverwriteAttempted !== false) fail("RESTORE_RECEIPT_SAFETY_INVALID");
  if (receipt.status === "complete") {
    for (const key of ["backupAgeAtRestoreStartSeconds", "dataRestoreDurationSeconds"]) if (!Number.isSafeInteger(receipt[key]) || receipt[key] < 0) fail(`RESTORE_RECEIPT_DURATION_INVALID:${key}`);
    const truthKeys = success.filter(key => !["isolatedFileRootName", "backupAgeAtRestoreStartSeconds", "dataRestoreDurationSeconds", "postgresGlobalsApplied"].includes(key));
    for (const key of truthKeys) if (receipt[key] !== true) fail(`RESTORE_RECEIPT_SUCCESS_TRUTH_INVALID:${key}`);
    if (!/^zimeiti-restore-[A-Za-z0-9._-]+$/u.test(receipt.isolatedFileRootName) || receipt.postgresGlobalsApplied !== false) fail("RESTORE_RECEIPT_SUCCESS_VALUE_INVALID");
  }
}

function collectComponentSnapshots(reportFiles) {
  const snapshots = reportFiles.map(file => readJson(file).componentSnapshot);
  snapshots.forEach(validateSnapshot);
  const required = new Set(["postgresql", "commerce-sqlite", "voice-sqlite", "app-data", "commerce-assets", "voice-reference-audio", "uploads", "public-assets"]);
  for (const snapshot of snapshots) required.delete(snapshot.component);
  if (required.size !== 0 || snapshots.length !== 8 || new Set(snapshots.map(item => item.component)).size !== 8) fail(`COMPONENT_SNAPSHOT_SET_INVALID:${[...required].join(",")}`);
  return snapshots;
}

function validateBackupMetadata(metadata) {
  exactKeys(metadata, [
    "schemaVersion", "backupId", "sourceVersion", "createdEpoch", "componentSnapshots",
    "sharedSnapshot", "productionConsistency", "productionConsistencyReason",
    "restorePolicy", "postgresGlobalsAutomaticRestore",
  ]);
  if (metadata.schemaVersion !== "zimeiti-backup-package-metadata.v2") fail("BACKUP_METADATA_SCHEMA_INVALID");
  if (!/^backup-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(metadata.backupId) || !SAFE_ID.test(metadata.sourceVersion)) fail("BACKUP_METADATA_ID_INVALID");
  if (!Number.isSafeInteger(metadata.createdEpoch) || metadata.createdEpoch < 1) fail("BACKUP_METADATA_TIME_INVALID");
  if (!Array.isArray(metadata.componentSnapshots) || metadata.componentSnapshots.length !== 8) fail("BACKUP_METADATA_COMPONENTS_INVALID");
  metadata.componentSnapshots.forEach(validateSnapshot);
  if (new Set(metadata.componentSnapshots.map(item => item.component)).size !== 8) fail("BACKUP_METADATA_COMPONENT_DUPLICATE");
  if (metadata.sharedSnapshot !== false || metadata.productionConsistency !== "incomplete" || metadata.productionConsistencyReason !== "NO_VERIFIED_CROSS_COMPONENT_QUIESCE_RECEIPT" || metadata.restorePolicy !== "new-isolated-cluster-only" || metadata.postgresGlobalsAutomaticRestore !== false) fail("BACKUP_METADATA_TRUTH_INVALID");
}

function writeBackupMetadata() {
  const output = argument("--output");
  const backupId = argument("--backup-id");
  const sourceVersion = argument("--source-version");
  const createdEpoch = integerArgument("--created-epoch", 1);
  if (!/^backup-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(backupId) || !SAFE_ID.test(sourceVersion)) fail("BACKUP_METADATA_ID_INVALID");
  writeJson(output, {
    schemaVersion: "zimeiti-backup-package-metadata.v2",
    backupId,
    sourceVersion,
    createdEpoch,
    componentSnapshots: collectComponentSnapshots(argument("--component-report", { multiple: true })),
    sharedSnapshot: false,
    productionConsistency: "incomplete",
    productionConsistencyReason: "NO_VERIFIED_CROSS_COMPONENT_QUIESCE_RECEIPT",
    restorePolicy: "new-isolated-cluster-only",
    postgresGlobalsAutomaticRestore: false,
  });
}

function writeBackupReceipt() {
  const output = argument("--output");
  const metadata = readJson(argument("--metadata"));
  validateBackupMetadata(metadata);
  const encryptedPackage = argument("--encrypted-package");
  const manifest = argument("--manifest");
  const completedEpoch = integerArgument("--completed-epoch", 1);
  const oldestComponentEpoch = Math.min(...metadata.componentSnapshots.map(item => item.completedEpoch));
  if (completedEpoch < metadata.createdEpoch || completedEpoch < oldestComponentEpoch) fail("BACKUP_RECEIPT_NEGATIVE_DURATION");
  const receipt = {
    schemaVersion: BACKUP_RECEIPT_SCHEMA,
    status: "complete",
    backupId: metadata.backupId,
    sourceVersion: metadata.sourceVersion,
    createdEpoch: metadata.createdEpoch,
    completedEpoch,
    artifactCreationDurationSeconds: completedEpoch - metadata.createdEpoch,
    oldestComponentAgeAtCompletionSeconds: completedEpoch - oldestComponentEpoch,
    encryptedPackage: path.basename(encryptedPackage),
    encryptedSha256: sha256(encryptedPackage),
    manifestSha256: sha256(manifest),
    componentSnapshots: metadata.componentSnapshots,
    sharedSnapshot: false,
    productionConsistency: "incomplete",
    productionConsistencyComplete: false,
    sourceTargetDisjoint: true,
    expectedDeviceVerified: true,
    plaintextFinalPackage: false,
    finalPackageHashVerified: true,
    manifestHashVerified: true,
    atomicCommit: true,
  };
  validateBackupReceipt(receipt);
  writeJson(output, receipt);
}

function canonicalAttestation(document) {
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v1") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, environment: document.environment, systemIdentifier: document.systemIdentifier, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
  }
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v2") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, environment: document.environment, systemIdentifier: document.systemIdentifier, database: document.database, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
  }
  if (document.schemaVersion === "zimeiti-restore-provisioning-receipt.v1") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, targetSystemIdentifier: document.targetSystemIdentifier, targetDatabase: document.targetDatabase, targetRole: document.targetRole, provisioningNonce: document.provisioningNonce, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
  }
  fail("ATTESTATION_SCHEMA_UNSUPPORTED");
}

function verifyAttestation(document, key, nowEpoch) {
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v1") {
    exactKeys(document, ["schemaVersion", "environment", "systemIdentifier", "issuedEpoch", "expiresEpoch", "signature"]);
  } else if (document.schemaVersion === "zimeiti-production-postgres-identity.v2") {
    exactKeys(document, ["schemaVersion", "environment", "systemIdentifier", "database", "issuedEpoch", "expiresEpoch", "signature"]);
    if (!validSourceDatabase(document.database)) fail("PRODUCTION_DATABASE_IDENTITY_REQUIRED");
    if (document.environment !== "production" || typeof document.systemIdentifier !== "string" || !SYSTEM_IDENTIFIER.test(document.systemIdentifier)) fail("PRODUCTION_IDENTITY_INVALID");
  } else if (document.schemaVersion === "zimeiti-restore-provisioning-receipt.v1") {
    exactKeys(document, ["schemaVersion", "targetSystemIdentifier", "targetDatabase", "targetRole", "provisioningNonce", "issuedEpoch", "expiresEpoch", "signature"]);
  } else {
    fail("ATTESTATION_SCHEMA_UNSUPPORTED");
  }
  if (!Number.isSafeInteger(document.issuedEpoch) || !Number.isSafeInteger(document.expiresEpoch) || document.issuedEpoch > nowEpoch + 300 || document.expiresEpoch < nowEpoch) fail("ATTESTATION_TIME_INVALID");
  if (!SHA256.test(String(document.signature || ""))) fail("ATTESTATION_SIGNATURE_INVALID");
  const expected = crypto.createHmac("sha256", key).update(canonicalAttestation(document)).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(document.signature, "hex"))) fail("ATTESTATION_SIGNATURE_MISMATCH");
}

function validSourceDatabase(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function readSourceIdentityJson(file, code) {
  try {
    return readJson(file);
  } catch {
    fail(code);
  }
}

function validateBackupSourceIdentity(backupVersionFile, productionIdentityFile, attestationKeyFile, nowEpoch) {
  const production = readSourceIdentityJson(productionIdentityFile, "PRODUCTION_DATABASE_IDENTITY_REQUIRED");
  if (production?.schemaVersion !== "zimeiti-production-postgres-identity.v2") fail("PRODUCTION_DATABASE_IDENTITY_REQUIRED");
  const key = fs.readFileSync(attestationKeyFile);
  if (key.length < 32) fail("ATTESTATION_KEY_TOO_SHORT");
  verifyAttestation(production, key, nowEpoch);
  if (production.environment !== "production" || typeof production.systemIdentifier !== "string" || !SYSTEM_IDENTIFIER.test(production.systemIdentifier)) fail("PRODUCTION_IDENTITY_INVALID");
  const source = readSourceIdentityJson(backupVersionFile, "BACKUP_SOURCE_IDENTITY_INVALID");
  if (typeof source?.systemIdentifier !== "string" || !SYSTEM_IDENTIFIER.test(source.systemIdentifier) || !validSourceDatabase(source.database)) fail("BACKUP_SOURCE_IDENTITY_INVALID");
  if (source.systemIdentifier !== production.systemIdentifier) fail("BACKUP_SOURCE_SYSTEM_IDENTIFIER_MISMATCH");
  if (source.database !== production.database) fail("BACKUP_SOURCE_DATABASE_MISMATCH");
}

function validateRestoreIdentity() {
  const identity = readJson(argument("--identity"));
  const production = readJson(argument("--production-identity"));
  const provisioning = readJson(argument("--provisioning-receipt"));
  const key = fs.readFileSync(argument("--attestation-key"));
  const expectedSystemIdentifier = argument("--expected-target-system-identifier");
  const expectedDatabase = argument("--expected-target-database");
  const expectedRole = argument("--expected-target-role");
  const phase = argument("--phase");
  const output = argument("--output");
  const nowEpoch = integerArgument("--now-epoch", 1);
  exactKeys(identity, [
    "systemIdentifier", "database", "role", "provisioningNonce", "roleSuper",
    "roleCreateRole", "roleCreateDb", "roleReplication", "roleBypassRls",
    "databaseConnect", "databaseCreate", "databaseTemporary", "publicSchemaCreate",
  ]);
  if (key.length < 32) fail("ATTESTATION_KEY_TOO_SHORT");
  if (!SYSTEM_IDENTIFIER.test(expectedSystemIdentifier) || !SAFE_DATABASE.test(expectedDatabase) || !SAFE_ROLE.test(expectedRole) || !["before", "after"].includes(phase)) fail("RESTORE_IDENTITY_EXPECTATION_INVALID");
  verifyAttestation(production, key, nowEpoch);
  verifyAttestation(provisioning, key, nowEpoch);
  if (production.environment !== "production" || !SYSTEM_IDENTIFIER.test(production.systemIdentifier)) fail("PRODUCTION_IDENTITY_INVALID");
  if (provisioning.targetSystemIdentifier !== expectedSystemIdentifier || provisioning.targetDatabase !== expectedDatabase || provisioning.targetRole !== expectedRole || !NONCE.test(provisioning.provisioningNonce)) fail("PROVISIONING_RECEIPT_MISMATCH");
  if (identity.systemIdentifier !== expectedSystemIdentifier || identity.database !== expectedDatabase || identity.role !== expectedRole || identity.provisioningNonce !== provisioning.provisioningNonce) fail("TARGET_IDENTITY_MISMATCH");
  if (identity.systemIdentifier === production.systemIdentifier) fail("RESTORE_TARGET_MUST_BE_DIFFERENT_CLUSTER");
  for (const keyName of ["roleSuper", "roleCreateRole", "roleCreateDb", "roleReplication", "roleBypassRls"]) if (identity[keyName] !== false) fail(`RESTORE_ROLE_TOO_PRIVILEGED:${keyName}`);
  for (const keyName of ["databaseConnect", "databaseCreate", "databaseTemporary", "publicSchemaCreate"]) if (identity[keyName] !== true) fail(`RESTORE_ROLE_REQUIRED_PRIVILEGE_MISSING:${keyName}`);
  const nonceSha256 = crypto.createHash("sha256").update(identity.provisioningNonce).digest("hex");
  const beforeReport = argument("--expected-before-report", { required: false });
  if (phase === "after") {
    if (!beforeReport) fail("RESTORE_BEFORE_IDENTITY_REPORT_REQUIRED");
    const before = readJson(beforeReport);
    const current = { systemIdentifier: identity.systemIdentifier, targetDatabase: identity.database, targetRole: identity.role, provisioningNonceSha256: nonceSha256 };
    for (const keyName of Object.keys(current)) if (before[keyName] !== current[keyName]) fail("RESTORE_IDENTITY_CHANGED_AFTER_RESTORE");
  }
  writeJson(output, {
    schemaVersion: "zimeiti-restore-target-identity-check.v1",
    phase,
    systemIdentifier: identity.systemIdentifier,
    targetDatabase: identity.database,
    targetRole: identity.role,
    provisioningNonceSha256: nonceSha256,
    targetSystemIdentifierMatchesExpected: true,
    targetClusterDistinctFromProduction: true,
    provisioningNonceVerified: true,
    minimumPrivilegeRoleVerified: true,
  });
}

function validateIdentityReport(report, expectedPhase) {
  exactKeys(report, [
    "schemaVersion", "phase", "systemIdentifier", "targetDatabase", "targetRole",
    "provisioningNonceSha256", "targetSystemIdentifierMatchesExpected",
    "targetClusterDistinctFromProduction", "provisioningNonceVerified",
    "minimumPrivilegeRoleVerified",
  ]);
  if (report.schemaVersion !== "zimeiti-restore-target-identity-check.v1" || report.phase !== expectedPhase) fail("RESTORE_IDENTITY_REPORT_INVALID");
  if (!SYSTEM_IDENTIFIER.test(report.systemIdentifier) || !SAFE_DATABASE.test(report.targetDatabase) || !SAFE_ROLE.test(report.targetRole) || !SHA256.test(report.provisioningNonceSha256)) fail("RESTORE_IDENTITY_REPORT_VALUE_INVALID");
  for (const key of ["targetSystemIdentifierMatchesExpected", "targetClusterDistinctFromProduction", "provisioningNonceVerified", "minimumPrivilegeRoleVerified"]) if (report[key] !== true) fail(`RESTORE_IDENTITY_REPORT_TRUTH_INVALID:${key}`);
}

function writeRestoreReceipt(status) {
  const output = argument("--output");
  const restoreId = argument("--restore-id");
  const phase = argument("--phase");
  const targetDatabase = argument("--target-database");
  const startedEpoch = integerArgument("--started-epoch", 1);
  const completedEpoch = integerArgument("--completed-epoch", 1);
  const packageSha = argument("--package-sha256").toLowerCase();
  const base = { schemaVersion: RESTORE_RECEIPT_SCHEMA, status, restoreId, phase, targetDatabase, startedEpoch, completedEpoch, encryptedPackageSha256: packageSha, productionOverwriteAttempted: false };
  if (status === "failed") {
    validateRestoreReceipt(base);
    writeJson(output, base);
    return;
  }
  validateBackupSourceIdentity(argument("--backup-version"), argument("--production-identity"), argument("--attestation-key"), completedEpoch);
  const metadata = readJson(argument("--metadata"));
  validateBackupMetadata(metadata);
  const before = readJson(argument("--before-identity"));
  const after = readJson(argument("--after-identity"));
  validateIdentityReport(before, "before");
  validateIdentityReport(after, "after");
  const oldestComponentEpoch = Math.min(...metadata.componentSnapshots.map(item => item.completedEpoch));
  if (startedEpoch < oldestComponentEpoch) fail("RESTORE_BACKUP_AGE_NEGATIVE");
  if (completedEpoch < startedEpoch) fail("RESTORE_DURATION_NEGATIVE");
  for (const key of ["systemIdentifier", "targetDatabase", "targetRole", "provisioningNonceSha256"]) if (before[key] !== after[key]) fail("RESTORE_IDENTITY_RECHECK_MISMATCH");
  const receipt = {
    ...base,
    isolatedFileRootName: path.basename(argument("--isolated-file-root")),
    backupAgeAtRestoreStartSeconds: startedEpoch - oldestComponentEpoch,
    dataRestoreDurationSeconds: completedEpoch - startedEpoch,
    packageHashVerifiedBeforeRestore: true,
    packageHashVerifiedAfterRestore: true,
    targetClusterDistinctFromProduction: true,
    targetSystemIdentifierMatchesExpected: true,
    provisioningNonceVerified: true,
    minimumPrivilegeRoleVerified: true,
    identityRecheckedAfterRestore: true,
    postgresRowCountsMatch: true,
    financialControlsMatch: true,
    commerceSqliteBytesHashAndRowsMatch: true,
    voiceSqliteBytesHashAndRowsMatch: true,
    fileManifestVerified: true,
    postgresGlobalsApplied: false,
    plaintextWorkspaceOnControlledMount: true,
  };
  validateRestoreReceipt(receipt);
  writeJson(output, receipt);
}

const command = process.argv[2];
if (command === "copy-tree") {
  copyTree(argument("--source"), argument("--destination"), new Set(argument("--exclude-name", { multiple: true, required: false })));
} else if (command === "compare-tree") {
  compareTree(argument("--expected-root"), argument("--actual-root"), argument("--label"));
} else if (command === "stable-copy-tree") {
  stableCopyTree(argument("--source"), argument("--destination"), argument("--report"), argument("--label"), new Set(argument("--exclude-name", { multiple: true, required: false })));
} else if (command === "assert-disjoint") {
  assertDisjoint(argument("--left"), argument("--right"));
} else if (command === "assert-path-absent") {
  const target = argument("--path");
  if (fs.existsSync(target)) fail("STAGING_RESIDUE_REQUIRES_MANUAL_REVIEW");
} else if (command === "sqlite-backup") {
  await sqliteBackup(argument("--source"), argument("--destination"), argument("--report"), argument("--label"));
} else if (command === "sqlite-audit") {
  sqliteAudit(argument("--source"), argument("--report"));
} else if (command === "build-manifest") {
  buildManifest(argument("--root"), argument("--metadata"), argument("--output"));
} else if (command === "verify-manifest") {
  verifyManifest(argument("--root"), argument("--manifest"));
} else if (command === "compare-json") {
  compareJson(argument("--expected"), argument("--actual"), argument("--label"));
} else if (command === "compare-sqlite-audit") {
  compareSqliteAudit(argument("--expected"), argument("--actual"), argument("--label"));
} else if (command === "write-backup-metadata") {
  writeBackupMetadata();
} else if (command === "write-backup-receipt") {
  writeBackupReceipt();
} else if (command === "validate-backup-metadata") {
  validateBackupMetadata(readJson(argument("--document")));
} else if (command === "validate-backup-source-identity") {
  validateBackupSourceIdentity(argument("--backup-version"), argument("--production-identity"), argument("--attestation-key"), integerArgument("--now-epoch", 1));
} else if (command === "validate-restore-identity") {
  validateRestoreIdentity();
} else if (command === "write-restore-success-receipt") {
  writeRestoreReceipt("complete");
} else if (command === "write-restore-failure-receipt") {
  writeRestoreReceipt("failed");
} else if (command === "validate-receipt") {
  const kind = argument("--kind");
  const document = readJson(argument("--document"));
  if (kind === "backup") validateBackupReceipt(document);
  else if (kind === "restore") validateRestoreReceipt(document);
  else fail("RECEIPT_KIND_INVALID");
} else {
  fail(`HELPER_COMMAND_INVALID:${command || "missing"}`);
}
