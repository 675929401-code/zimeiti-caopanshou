#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CATALOG_SCHEMA,
  EXPORT_RECEIPT_SCHEMA,
  PROJECT_ID,
  assertSafeRoot,
  exactKeys,
  loadAndValidateCatalogSchema,
  loadTrustedIssuers,
  parseOptions,
  readJson,
  rejectSensitiveMetadata,
  resolveEntry,
  sha256Buffer,
  sha256File,
  stableJson,
  validateBackupReceipt,
  validatePublicManifest,
  validateReadinessEvidence,
  validateReadyReceipt,
  validateSourceCommitReceipt,
  validateSourceManifest,
  validateUserInventory,
  verifyDetachedSignature,
} from "./recovery-export-v1.mjs";

const DRILL_RECEIPT_SCHEMA = "zimeiti-empty-disk-drill-receipt.v1";

function stop(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

function validateCatalog(catalog) {
  exactKeys(catalog, ["schemaVersion", "projectId", "environment", "accountId", "tenantId", "databaseIdentity", "catalogId", "catalogSchemaSha256", "createdAt", "source", "publicAssets", "databaseBackup", "userAssets", "consistency", "trust", "readiness"], [], "recovery catalog");
  rejectSensitiveMetadata(catalog, "recovery catalog");
  if (catalog.schemaVersion !== CATALOG_SCHEMA || catalog.projectId !== PROJECT_ID || !/^recovery-[A-Za-z0-9._-]+-[a-f0-9]{16}$/u.test(String(catalog.catalogId || ""))
    || Number.isNaN(Date.parse(catalog.createdAt))) stop("recovery catalog identity is invalid");
  exactKeys(catalog.source, ["gitCommit", "sourceVersion", "manifestSha256", "commitReceiptSha256", "detachedSignatureSha256", "sourceFingerprint", "fileCount", "totalBytes"], [], "catalog source");
  exactKeys(catalog.publicAssets, ["assetVersion", "assetDigest", "manifestSha256", "readyReceiptSha256", "detachedSignatureSha256", "fileCount", "totalBytes"], [], "catalog publicAssets");
  exactKeys(catalog.databaseBackup, ["backupId", "sourceVersion", "packageSha256", "receiptSha256", "detachedSignatureSha256", "projectId", "environment", "accountId", "tenantId", "databaseIdentity", "productionConsistency"], [], "catalog databaseBackup");
  exactKeys(catalog.userAssets, ["inventorySha256", "detachedSignatureSha256", "inventoryDigest", "snapshotAt", "bucket", "accountId", "tenantId", "region", "ownerId", "databaseIdentity", "fileCount", "totalBytes", "crossComponentConsistency"], [], "catalog userAssets");
  exactKeys(catalog.consistency, ["crossComponentConsistency", "databaseAndObjectsJointSnapshot", "truth"], [], "catalog consistency");
  exactKeys(catalog.trust, ["status", "allowlistSha256", "algorithm", "maxEvidenceAgeSeconds"], [], "catalog trust");
  exactKeys(catalog.readiness, ["standard", "status", "checks"], [], "catalog readiness");
  if (catalog.consistency.crossComponentConsistency !== false || catalog.consistency.databaseAndObjectsJointSnapshot !== false
    || catalog.consistency.truth !== "independent-verified-components" || catalog.databaseBackup.productionConsistency !== "incomplete"
    || catalog.userAssets.crossComponentConsistency !== false || catalog.readiness.standard !== "3-2-1-1-0") stop("catalog overstates cross-component consistency");
  if (!Array.isArray(catalog.readiness.checks) || catalog.readiness.checks.length !== 7) stop("catalog readiness checks are invalid");
  for (const check of catalog.readiness.checks) {
    exactKeys(check, ["id", "verified", "evidencePath", "evidenceSha256", "signaturePath", "signatureSha256", "issuerFingerprint"], [], "catalog readiness check");
    if (typeof check.verified !== "boolean" || (check.verified
      ? typeof check.evidencePath !== "string" || !/^[a-f0-9]{64}$/u.test(String(check.evidenceSha256 || ""))
        || typeof check.signaturePath !== "string" || !/^[a-f0-9]{64}$/u.test(String(check.signatureSha256 || "")) || !/^[a-f0-9]{64}$/u.test(String(check.issuerFingerprint || ""))
      : check.evidencePath !== null || check.evidenceSha256 !== null || check.signaturePath !== null || check.signatureSha256 !== null || check.issuerFingerprint !== null)) stop("catalog readiness check evidence shape is invalid");
  }
  const expectedStatus = catalog.trust.status === "TRUSTED" && catalog.readiness.checks.every((check) => check.verified) ? "READY" : "BLOCKED";
  if (catalog.readiness.status !== expectedStatus) stop("catalog readiness status does not match its evidence checks");
  return catalog;
}

function verifyEntries(root, files, pathField, label) {
  for (const entry of files) {
    const relative = entry[pathField];
    const filePath = resolveEntry(root, relative, `${label}: ${relative}`);
    const stats = fs.lstatSync(filePath);
    if (stats.size !== entry.bytes || sha256File(filePath) !== entry.sha256) stop(`${label} size/hash mismatch: ${relative}`);
  }
}

function walkRelative(root) {
  const files = [];
  const directories = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (stats.isSymbolicLink()) stop(`recovery bundle contains a symbolic link: ${relative}`);
      if (stats.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else if (stats.isFile()) files.push(relative);
      else stop(`recovery bundle contains a non-file entry: ${relative}`);
    }
  };
  visit(root);
  return {
    files: files.sort((left, right) => left.localeCompare(right, "en")),
    directories: directories.sort((left, right) => left.localeCompare(right, "en")),
  };
}

export function verifyBundle(bundleInput, { expectDrillReceipt = false, expectedDrillSha256 = null } = {}) {
  const bundleRoot = assertSafeRoot(bundleInput, "recovery bundle");
  if (!fs.lstatSync(bundleRoot).isDirectory()) stop("recovery bundle must be a directory");
  const metadataRoot = path.join(bundleRoot, "metadata");
  const catalogDocument = readJson(resolveEntry(metadataRoot, "recovery-catalog.v1.json", "recovery catalog"), "recovery catalog");
  const bundledSchemaPath = resolveEntry(metadataRoot, "recovery-catalog.v1.schema.json", "bundled recovery catalog schema");
  const sourceDocument = readJson(resolveEntry(metadataRoot, "source-files.v1.json", "source manifest"), "source manifest");
  const commitDocument = readJson(resolveEntry(metadataRoot, "source-commit-receipt.v1.json", "source commit receipt"), "source commit receipt");
  const publicDocument = readJson(resolveEntry(metadataRoot, "public-assets.v1.json", "public manifest"), "public manifest");
  const readyDocument = readJson(resolveEntry(metadataRoot, "public-assets.ready.v1.json", "public READY receipt"), "public READY receipt");
  const userDocument = readJson(resolveEntry(metadataRoot, "user-object-inventory.v1.json", "user inventory"), "user inventory");
  const backupDocument = readJson(resolveEntry(metadataRoot, "database-backup-receipt.v1.json", "database receipt"), "database receipt");
  const readinessDocument = readJson(resolveEntry(metadataRoot, "readiness-evidence.v1.json", "readiness evidence"), "readiness evidence");
  const exportDocument = readJson(resolveEntry(bundleRoot, ".release/recovery-export-receipt.v1.json", "export receipt"), "export receipt");
  const databasePackage = resolveEntry(bundleRoot, "database/package.tar.gz.age", "database package");
  const catalog = validateCatalog(catalogDocument.value);
  const authoritativeSchema = loadAndValidateCatalogSchema(catalog);
  if (catalog.catalogSchemaSha256 !== authoritativeSchema.schemaSha256 || sha256File(bundledSchemaPath) !== authoritativeSchema.schemaSha256) {
    stop("catalog is not bound to the authoritative Draft 2020-12 schema");
  }
  const sourceManifest = validateSourceManifest(sourceDocument.value);
  const publicManifest = validatePublicManifest(publicDocument.value);
  const publicManifestSha256 = sha256Buffer(publicDocument.bytes);
  const userInventory = validateUserInventory(userDocument.value, catalog.source.sourceVersion, catalog.environment);
  validateSourceCommitReceipt(commitDocument.value, sha256Buffer(sourceDocument.bytes), catalog.source.sourceVersion, catalog.source.gitCommit);
  validateReadyReceipt(readyDocument.value, publicManifest, publicManifestSha256);
  validateBackupReceipt(backupDocument.value, databasePackage, catalog.source.sourceVersion);
  if (sourceManifest.assetManifestSha256 !== publicManifestSha256 || sourceManifest.assetDigest !== publicManifest.digest
    || sourceManifest.assetVersion !== publicManifest.assetVersion) stop("source/public manifest release binding is invalid");
  const bindings = [
    [catalog.source.manifestSha256, sha256Buffer(sourceDocument.bytes), "source manifest"],
    [catalog.source.commitReceiptSha256, sha256Buffer(commitDocument.bytes), "source commit receipt"],
    [catalog.source.sourceFingerprint, sourceManifest.sourceFingerprint, "source fingerprint"],
    [catalog.source.fileCount, sourceManifest.fileCount, "source file count"],
    [catalog.source.totalBytes, sourceManifest.totalBytes, "source byte total"],
    [catalog.publicAssets.assetVersion, publicManifest.assetVersion, "public asset version"],
    [catalog.publicAssets.assetDigest, publicManifest.digest, "public asset digest"],
    [catalog.publicAssets.manifestSha256, publicManifestSha256, "public manifest"],
    [catalog.publicAssets.readyReceiptSha256, sha256Buffer(readyDocument.bytes), "public READY receipt"],
    [catalog.publicAssets.fileCount, publicManifest.fileCount, "public file count"],
    [catalog.publicAssets.totalBytes, publicManifest.totalBytes, "public byte total"],
    [catalog.databaseBackup.backupId, backupDocument.value.backupId, "database backup ID"],
    [catalog.databaseBackup.sourceVersion, backupDocument.value.sourceVersion, "database source version"],
    [catalog.databaseBackup.packageSha256, backupDocument.value.encryptedSha256, "database package"],
    [catalog.databaseBackup.receiptSha256, sha256Buffer(backupDocument.bytes), "database receipt"],
    [catalog.databaseBackup.projectId, catalog.projectId, "database project"],
    [catalog.databaseBackup.environment, catalog.environment, "database environment"],
    [catalog.databaseBackup.accountId, catalog.accountId, "database account"],
    [catalog.databaseBackup.tenantId, catalog.tenantId, "database tenant"],
    [catalog.databaseBackup.databaseIdentity, catalog.databaseIdentity, "database identity"],
    [catalog.userAssets.inventorySha256, sha256Buffer(userDocument.bytes), "user inventory"],
    [catalog.userAssets.inventoryDigest, userInventory.digest, "user inventory digest"],
    [catalog.userAssets.snapshotAt, userInventory.snapshotAt, "user snapshot time"],
    [catalog.userAssets.bucket, userInventory.bucket, "user asset bucket"],
    [catalog.userAssets.accountId, userInventory.accountId, "user asset account"],
    [catalog.userAssets.tenantId, userInventory.tenantId, "user asset tenant"],
    [catalog.userAssets.region, userInventory.region, "user asset region"],
    [catalog.userAssets.ownerId, userInventory.ownerId, "user asset owner"],
    [catalog.userAssets.databaseIdentity, userInventory.databaseIdentity, "user asset database identity"],
    [catalog.userAssets.fileCount, userInventory.fileCount, "user file count"],
    [catalog.userAssets.totalBytes, userInventory.totalBytes, "user byte total"],
  ];
  for (const [actual, expected, label] of bindings) if (actual !== expected) stop(`recovery catalog binding mismatch: ${label}`);
  const bindingDigest = sha256Buffer(Buffer.from(stableJson({
    gitCommit: catalog.source.gitCommit,
    sourceVersion: catalog.source.sourceVersion,
    sourceManifestSha256: catalog.source.manifestSha256,
    publicManifestSha256: catalog.publicAssets.manifestSha256,
    publicReadyReceiptSha256: catalog.publicAssets.readyReceiptSha256,
    databaseReceiptSha256: catalog.databaseBackup.receiptSha256,
    databasePackageSha256: catalog.databaseBackup.packageSha256,
    userInventorySha256: catalog.userAssets.inventorySha256,
  }), "utf8"));
  if (catalog.catalogId !== `recovery-${catalog.source.sourceVersion}-${bindingDigest.slice(0, 16)}`) stop("recovery catalog ID is not content-bound");
  const identity = {
    environment: catalog.environment,
    gitCommit: catalog.source.gitCommit,
    assetVersion: catalog.publicAssets.assetVersion,
    databaseIdentity: catalog.databaseIdentity,
    accountId: catalog.accountId,
    tenantId: catalog.tenantId,
  };
  const replayState = { receiptIds: new Set(), nonces: new Set() };
  let trust = { trusted: false, issuers: new Map() };
  const trustedMetadata = [];
  if (catalog.trust.status === "TRUSTED") {
    const allowlistPath = resolveEntry(metadataRoot, "trusted-issuers.v1.json", "bundled trusted issuer allowlist");
    trust = loadTrustedIssuers(allowlistPath, catalog.environment, { allowBundled: true });
    if (trust.sha256 !== catalog.trust.allowlistSha256) stop("catalog trusted issuer allowlist hash mismatch");
    trustedMetadata.push("metadata/trusted-issuers.v1.json");
    for (const [name, targetBytes, evidenceType, expectedHash] of [
      ["source", commitDocument.bytes, "source-commit", catalog.source.detachedSignatureSha256],
      ["public", readyDocument.bytes, "public-ready", catalog.publicAssets.detachedSignatureSha256],
      ["database", backupDocument.bytes, "database-backup", catalog.databaseBackup.detachedSignatureSha256],
      ["user", userDocument.bytes, "user-inventory", catalog.userAssets.detachedSignatureSha256],
    ]) {
      const signaturePath = resolveEntry(metadataRoot, `${name}.sig.json`, `${name} detached signature`);
      const signature = verifyDetachedSignature(signaturePath, targetBytes, { ...identity, evidenceType, catalogBindingSha256: bindingDigest }, trust, replayState);
      if (signature.sha256 !== expectedHash) stop(`${name} detached signature catalog binding mismatch`);
      trustedMetadata.push(`metadata/${name}.sig.json`);
    }
  } else if (catalog.trust.allowlistSha256 !== null || catalog.source.detachedSignatureSha256 !== null
    || catalog.publicAssets.detachedSignatureSha256 !== null || catalog.databaseBackup.detachedSignatureSha256 !== null || catalog.userAssets.detachedSignatureSha256 !== null) {
    stop("blocked trust state must not claim detached signatures");
  }
  const readiness = validateReadinessEvidence(readinessDocument.value, bindingDigest, path.join(bundleRoot, "evidence"), trust, identity, replayState);
  if (stableJson(readiness.checks) !== stableJson(catalog.readiness.checks)) stop("catalog and readiness evidence checks differ");
  exactKeys(exportDocument.value, ["schemaVersion", "status", "catalogId", "catalogSha256", "recoveryBindingSha256", "sourceFiles", "publicAssetFiles", "userAssetFiles", "databasePackageSha256", "catalogSchemaSha256", "stagingVerified", "atomicCommit", "overwritePrevented", "networkAccessed", "createdAt"], [], "export receipt");
  if (exportDocument.value.schemaVersion !== EXPORT_RECEIPT_SCHEMA || exportDocument.value.status !== "complete"
    || exportDocument.value.catalogId !== catalog.catalogId || exportDocument.value.catalogSha256 !== sha256Buffer(catalogDocument.bytes)
    || exportDocument.value.sourceFiles !== sourceManifest.fileCount || exportDocument.value.publicAssetFiles !== publicManifest.fileCount
    || exportDocument.value.userAssetFiles !== userInventory.fileCount || exportDocument.value.databasePackageSha256 !== catalog.databaseBackup.packageSha256
    || exportDocument.value.recoveryBindingSha256 !== bindingDigest || exportDocument.value.catalogSchemaSha256 !== catalog.catalogSchemaSha256 || exportDocument.value.stagingVerified !== true
    || exportDocument.value.atomicCommit !== true || exportDocument.value.overwritePrevented !== true || exportDocument.value.networkAccessed !== false
    || exportDocument.value.createdAt !== catalog.createdAt) stop("recovery export receipt is invalid");
  verifyEntries(path.join(bundleRoot, "source"), sourceManifest.files, "path", "bundled source");
  verifyEntries(path.join(bundleRoot, "public-assets"), publicManifest.files, "path", "bundled public asset");
  verifyEntries(path.join(bundleRoot, "user-assets"), userInventory.files, "relativePath", "bundled user asset");
  const expectedFiles = new Set([
    ...sourceManifest.files.map((file) => `source/${file.path}`),
    ...publicManifest.files.map((file) => `public-assets/${file.path}`),
    ...userInventory.files.map((file) => `user-assets/${file.relativePath}`),
    "database/package.tar.gz.age",
    "metadata/recovery-catalog.v1.json",
    "metadata/recovery-catalog.v1.schema.json",
    "metadata/source-files.v1.json",
    "metadata/source-commit-receipt.v1.json",
    "metadata/public-assets.v1.json",
    "metadata/public-assets.ready.v1.json",
    "metadata/user-object-inventory.v1.json",
    "metadata/database-backup-receipt.v1.json",
    "metadata/readiness-evidence.v1.json",
    ...trustedMetadata,
    ...readiness.evidenceFiles.map((item) => item.relativePath),
    ".release/recovery-export-receipt.v1.json",
  ]);
  const expectedDirectories = new Set(["source", "public-assets", "user-assets", "database", "metadata", "evidence", ".release"]);
  if (expectDrillReceipt) {
    const drillPath = resolveEntry(bundleRoot, ".recovery/empty-disk-drill-receipt.v1.json", "empty disk drill receipt");
    const drillDocument = readJson(drillPath, "empty disk drill receipt");
    exactKeys(drillDocument.value, ["schemaVersion", "status", "catalogId", "catalogSha256", "sourceGitCommit", "sourceFilesVerified", "publicAssetFilesVerified", "userAssetFilesVerified", "databasePackageVerified", "databaseRestoreExecuted", "databaseRestoreDelegatedTo", "targetWasEmpty", "networkAccessed", "verificationErrors", "completedAt"], [], "empty disk drill receipt");
    if (drillDocument.value.schemaVersion !== DRILL_RECEIPT_SCHEMA || drillDocument.value.status !== "complete"
      || drillDocument.value.catalogId !== catalog.catalogId || drillDocument.value.catalogSha256 !== sha256Buffer(catalogDocument.bytes)
      || drillDocument.value.sourceGitCommit !== catalog.source.gitCommit || drillDocument.value.sourceFilesVerified !== sourceManifest.fileCount
      || drillDocument.value.publicAssetFilesVerified !== publicManifest.fileCount || drillDocument.value.userAssetFilesVerified !== userInventory.fileCount
      || drillDocument.value.databasePackageVerified !== true || drillDocument.value.databaseRestoreExecuted !== false
      || drillDocument.value.targetWasEmpty !== true || drillDocument.value.networkAccessed !== false || drillDocument.value.verificationErrors !== 0
      || !/^\d{4}-\d{2}-\d{2}T/u.test(drillDocument.value.completedAt)) stop("empty disk drill receipt semantic binding is invalid");
    if (expectedDrillSha256 && sha256Buffer(drillDocument.bytes) !== expectedDrillSha256) stop("empty disk drill receipt changed during commit");
    expectedFiles.add(".recovery/empty-disk-drill-receipt.v1.json");
    expectedDirectories.add(".recovery");
  }
  for (const file of expectedFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  const actual = walkRelative(bundleRoot);
  if (actual.files.length !== expectedFiles.size || actual.files.some((file) => !expectedFiles.has(file))
    || actual.directories.length !== expectedDirectories.size || actual.directories.some((directory) => !expectedDirectories.has(directory))) {
    stop("recovery bundle exact inventory mismatch");
  }
  return { bundleRoot, catalog, catalogSha256: sha256Buffer(catalogDocument.bytes), sourceManifest, publicManifest, userInventory };
}

function assertEmptyTarget(targetInput) {
  const target = assertSafeRoot(targetInput, "restore target");
  const stats = fs.lstatSync(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) stop("restore target must be a real directory");
  if (fs.readdirSync(target).length !== 0) stop("restore target must be empty");
  return target;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) stop(`unsafe restore directory: ${directoryPath}`);
}

function copyExclusive(source, destination) {
  ensureDirectory(path.dirname(destination));
  const sourceRealBefore = fs.realpathSync.native(source);
  const parentRealBefore = fs.realpathSync.native(path.dirname(destination));
  const sourceDescriptor = fs.openSync(source, "r");
  const destinationDescriptor = fs.openSync(destination, "wx", 0o600);
  const before = fs.fstatSync(sourceDescriptor);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null)) > 0) fs.writeSync(destinationDescriptor, buffer, 0, read);
    fs.fsyncSync(destinationDescriptor);
    const after = fs.fstatSync(sourceDescriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) stop(`restore copy source changed during read: ${source}`);
  } finally {
    fs.closeSync(sourceDescriptor);
    fs.closeSync(destinationDescriptor);
  }
  const current = fs.lstatSync(source);
  if (current.dev !== before.dev || current.ino !== before.ino || fs.realpathSync.native(source) !== sourceRealBefore || fs.realpathSync.native(path.dirname(destination)) !== parentRealBefore) {
    stop("restore copy detected symlink/junction swap");
  }
}

function copyTree(sourceRoot, destinationRoot) {
  ensureDirectory(destinationRoot);
  const visit = (source, destination) => {
    const sourceReal = fs.realpathSync.native(source);
    const destinationReal = fs.realpathSync.native(destination);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      const stats = fs.lstatSync(sourcePath);
      if (stats.isSymbolicLink()) stop(`restore source contains a symbolic link: ${sourcePath}`);
      if (stats.isDirectory()) {
        ensureDirectory(destinationPath);
        visit(sourcePath, destinationPath);
      } else if (stats.isFile()) copyExclusive(sourcePath, destinationPath);
      else stop(`restore source contains a non-file entry: ${sourcePath}`);
    }
    if (fs.realpathSync.native(source) !== sourceReal || fs.realpathSync.native(destination) !== destinationReal) stop("restore tree detected symlink/junction swap");
  };
  visit(sourceRoot, destinationRoot);
}

function writeExclusive(filePath, bytes) {
  ensureDirectory(path.dirname(filePath));
  const descriptor = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsyncTree(root) {
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path.join(directory, entry.name));
  };
  visit(root);
  directories.sort((left, right) => right.length - left.length).forEach(fsyncDirectory);
}

export function executeRestore(bundle, target, confirm, hooks = {}) {
  if (confirm !== bundle.catalogSha256) stop(`--confirm must equal catalog SHA-256 ${bundle.catalogSha256}`);
  const staging = path.join(target, `.staging-${bundle.catalog.catalogId}-${process.pid}-${crypto.randomUUID()}`);
  const finalRoot = path.join(target, `restored-${bundle.catalog.catalogId}`);
  if (fs.existsSync(staging) || fs.existsSync(finalRoot)) stop("restore staging or final target already exists");
  ensureDirectory(staging);
  for (const directory of ["source", "public-assets", "user-assets", "database", "metadata", "evidence", ".release"]) {
    copyTree(path.join(bundle.bundleRoot, directory), path.join(staging, directory));
  }
  verifyBundle(staging);
  verifyEntries(path.join(staging, "source"), bundle.sourceManifest.files, "path", "restored source");
  verifyEntries(path.join(staging, "public-assets"), bundle.publicManifest.files, "path", "restored public asset");
  verifyEntries(path.join(staging, "user-assets"), bundle.userInventory.files, "relativePath", "restored user asset");
  if (sha256File(path.join(staging, "database", "package.tar.gz.age")) !== bundle.catalog.databaseBackup.packageSha256) stop("restored database package hash mismatch");
  const receipt = {
    schemaVersion: DRILL_RECEIPT_SCHEMA,
    status: "complete",
    catalogId: bundle.catalog.catalogId,
    catalogSha256: bundle.catalogSha256,
    sourceGitCommit: bundle.catalog.source.gitCommit,
    sourceFilesVerified: bundle.sourceManifest.fileCount,
    publicAssetFilesVerified: bundle.publicManifest.fileCount,
    userAssetFilesVerified: bundle.userInventory.fileCount,
    databasePackageVerified: true,
    databaseRestoreExecuted: false,
    databaseRestoreDelegatedTo: "scripts/restore-data.sh-on-isolated-linux",
    targetWasEmpty: true,
    networkAccessed: false,
    verificationErrors: 0,
    completedAt: new Date().toISOString(),
  };
  writeExclusive(path.join(staging, ".recovery", "empty-disk-drill-receipt.v1.json"), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
  const drillReceiptPath = path.join(staging, ".recovery", "empty-disk-drill-receipt.v1.json");
  const drillReceiptSha256 = sha256File(drillReceiptPath);
  fsyncTree(staging);
  fsyncDirectory(target);
  verifyBundle(staging, { expectDrillReceipt: true, expectedDrillSha256: drillReceiptSha256 });
  hooks.beforeCommit?.({ staging, finalRoot, target });
  const targetEntries = fs.readdirSync(target);
  if (targetEntries.length !== 1 || targetEntries[0] !== path.basename(staging) || fs.existsSync(finalRoot)) stop("restore target changed before no-replace commit");
  if (process.platform !== "win32") stop("restore execute requires an OS no-replace directory rename primitive; this implementation is Windows fail-closed");
  try { fs.renameSync(staging, finalRoot); } catch (error) { stop(`restore no-replace atomic commit failed: ${error?.code || error}`); }
  fsyncDirectory(target);
  hooks.afterCommit?.({ finalRoot, target });
  verifyBundle(finalRoot, { expectDrillReceipt: true, expectedDrillSha256: drillReceiptSha256 });
  const finalEntries = fs.readdirSync(target);
  if (finalEntries.length !== 1 || finalEntries[0] !== path.basename(finalRoot)) stop("restore target changed after atomic commit");
  return { finalRoot, drillReceipt: path.join(finalRoot, ".recovery", "empty-disk-drill-receipt.v1.json"), receipt };
}

export function runRestoreCli(argv = process.argv) {
  const options = parseOptions(argv);
  if (!options.get("--bundle") || !options.get("--target")) stop("--bundle and --target are required");
  const bundle = verifyBundle(options.get("--bundle"));
  const target = assertEmptyTarget(options.get("--target"));
  if (target === bundle.bundleRoot || target.startsWith(`${bundle.bundleRoot}${path.sep}`) || bundle.bundleRoot.startsWith(`${target}${path.sep}`)) {
    stop("restore target and recovery bundle must be disjoint");
  }
  const result = {
    mode: options.get("--execute") === "1" ? "execute" : "plan",
    networkAccessed: false,
    catalogId: bundle.catalog.catalogId,
    catalogSha256: bundle.catalogSha256,
    readiness: bundle.catalog.readiness.status,
    target,
    databaseRestoreExecuted: false,
    databaseRestoreDelegatedTo: "scripts/restore-data.sh-on-isolated-linux",
  };
  if (options.get("--execute") !== "1") return result;
  return { ...result, ...executeRestore(bundle, target, options.get("--confirm")) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    console.log(JSON.stringify(runRestoreCli(), null, 2));
  } catch (error) {
    console.error(`RECOVERY_RESTORE_FAILED:${error instanceof Error ? error.message : String(error)}`);
    process.exit(error?.exitCode || 2);
  }
}
