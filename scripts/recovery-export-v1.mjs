#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROJECT_ID = "zimeiti-caopanshou";
export const CATALOG_SCHEMA = "zimeiti-recovery-catalog.v1";
export const USER_INVENTORY_SCHEMA = "zimeiti-user-object-inventory.v1";
export const SOURCE_COMMIT_RECEIPT_SCHEMA = "zimeiti-source-commit-receipt.v1";
export const READINESS_EVIDENCE_SCHEMA = "zimeiti-recovery-readiness-evidence.v1";
export const READINESS_ITEM_SCHEMA = "zimeiti-recovery-readiness-item.v1";
export const EXPORT_RECEIPT_SCHEMA = "zimeiti-recovery-export-receipt.v1";
export const DETACHED_SIGNATURE_SCHEMA = "zimeiti-recovery-detached-ed25519.v1";
export const TRUSTED_ISSUERS_SCHEMA = "zimeiti-recovery-trusted-issuers.v1";
export const SHA256 = /^[a-f0-9]{64}$/u;
export const GIT_COMMIT = /^[a-f0-9]{40}$/u;
export const SAFE_ID = /^[A-Za-z0-9._-]+$/u;
const FORBIDDEN_METADATA_KEY = /(authorization|cookie|credential|password|private.?key|secret|token)/iu;
const FORBIDDEN_URL = /(?:https?:\/\/|[?&](?:q-signature|x-amz-signature|signature|token|access_token)=)/iu;
const READINESS_IDS = [
  "primary-copy",
  "offline-copy",
  "independent-offsite-copy",
  "two-failure-domains",
  "offline-or-immutable",
  "empty-disk-drill",
  "zero-verification-errors",
];
const CATALOG_SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "contracts", "recovery-catalog.v1.schema.json");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_TRUST_PATH = path.join(PROJECT_ROOT, "deploy", "policies", "recovery-trusted-issuers.v1.json");
const require = createRequire(import.meta.url);
const Ajv2020Module = require(path.join(PROJECT_ROOT, "node_modules", ".pnpm", "ajv@8.20.0", "node_modules", "ajv", "dist", "2020.js"));
const Ajv2020 = Ajv2020Module.default || Ajv2020Module;
const STRICT_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MAX_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1000;

function stop(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function sha256File(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

export function readJson(filePath, label = "JSON document") {
  const bytes = fs.readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    stop(`${label} is not valid JSON`);
  }
  return { bytes, value };
}

function strictDateTime(value, label) {
  if (typeof value !== "string" || !STRICT_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) stop(`${label} must be a strict RFC3339 date-time`);
  return Date.parse(value);
}

function publicKeyFingerprint(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") stop("trusted recovery key must be Ed25519");
  return sha256Buffer(key.export({ type: "spki", format: "der" }));
}

export function loadTrustedIssuers(filePath, environment, { allowBundled = false } = {}) {
  if (!filePath) return { trusted: false, issuers: new Map(), bytes: null, path: null };
  const resolved = assertSafeRoot(filePath, "trusted issuer allowlist");
  if (environment === "production-recovery" && !allowBundled && path.resolve(resolved) !== path.resolve(PRODUCTION_TRUST_PATH)) {
    stop("production recovery only accepts the repository-controlled trusted issuer allowlist");
  }
  const document = readJson(resolved, "trusted issuer allowlist");
  const value = document.value;
  exactKeys(value, ["schemaVersion", "projectId", "environment", "issuers"], [], "trusted issuer allowlist");
  if (value.schemaVersion !== TRUSTED_ISSUERS_SCHEMA || value.projectId !== PROJECT_ID || value.environment !== environment || !Array.isArray(value.issuers) || value.issuers.length < 1) {
    stop("trusted issuer allowlist identity is invalid");
  }
  const issuers = new Map();
  for (const issuer of value.issuers) {
    exactKeys(issuer, ["issuerId", "publicKeyPem", "publicKeyFingerprint", "allowedEvidenceTypes"], [], "trusted issuer");
    if (!SAFE_ID.test(String(issuer.issuerId || "")) || issuers.has(issuer.issuerId) || !Array.isArray(issuer.allowedEvidenceTypes)) stop("trusted issuer entry is invalid");
    if (publicKeyFingerprint(issuer.publicKeyPem) !== issuer.publicKeyFingerprint || !SHA256.test(issuer.publicKeyFingerprint)) stop("trusted issuer fingerprint mismatch");
    issuers.set(issuer.issuerId, issuer);
  }
  return { trusted: true, issuers, bytes: document.bytes, path: resolved, sha256: sha256Buffer(document.bytes) };
}

export function verifyDetachedSignature(signaturePath, targetBytes, expected, trust, replayState = { receiptIds: new Set(), nonces: new Set() }) {
  if (!trust?.trusted) stop("trusted recovery issuer allowlist is unavailable");
  const document = readJson(signaturePath, "detached recovery signature");
  const envelope = document.value;
  exactKeys(envelope, [
    "schemaVersion", "algorithm", "issuerId", "publicKeyFingerprint", "receiptId", "nonce", "issuedAt", "expiresAt",
    "evidenceType", "targetSha256", "projectId", "environment", "catalogBindingSha256", "gitCommit", "assetVersion",
    "databaseIdentity", "accountId", "tenantId", "signature",
  ], [], "detached recovery signature");
  const issuer = trust.issuers.get(envelope.issuerId);
  if (envelope.schemaVersion !== DETACHED_SIGNATURE_SCHEMA || envelope.algorithm !== "Ed25519" || !issuer
    || envelope.publicKeyFingerprint !== issuer.publicKeyFingerprint || !issuer.allowedEvidenceTypes.includes(envelope.evidenceType)
    || envelope.projectId !== PROJECT_ID || envelope.environment !== expected.environment || envelope.evidenceType !== expected.evidenceType
    || envelope.targetSha256 !== sha256Buffer(targetBytes) || envelope.catalogBindingSha256 !== expected.catalogBindingSha256
    || envelope.gitCommit !== expected.gitCommit || envelope.assetVersion !== expected.assetVersion
    || envelope.databaseIdentity !== expected.databaseIdentity || envelope.accountId !== expected.accountId || envelope.tenantId !== expected.tenantId
    || !SAFE_ID.test(String(envelope.receiptId || "")) || !SAFE_ID.test(String(envelope.nonce || ""))) stop("detached signature identity or target binding mismatch");
  const issued = strictDateTime(envelope.issuedAt, "signature issuedAt");
  const expires = strictDateTime(envelope.expiresAt, "signature expiresAt");
  const now = Date.now();
  if (issued > now + 5 * 60 * 1000 || now - issued > MAX_EVIDENCE_AGE_MS || expires <= now || expires <= issued || expires - issued > MAX_EVIDENCE_AGE_MS) stop("detached signature is expired, future-dated, or too old");
  if (replayState.receiptIds.has(envelope.receiptId) || replayState.nonces.has(envelope.nonce)) stop("detached signature receiptId or nonce replay detected");
  const signed = { ...envelope };
  delete signed.signature;
  let signature;
  try { signature = Buffer.from(envelope.signature, "base64"); } catch { stop("detached signature encoding is invalid"); }
  if (!crypto.verify(null, Buffer.from(stableJson(signed), "utf8"), issuer.publicKeyPem, signature)) stop("detached Ed25519 signature verification failed");
  replayState.receiptIds.add(envelope.receiptId);
  replayState.nonces.add(envelope.nonce);
  return { bytes: document.bytes, value: envelope, sha256: sha256Buffer(document.bytes), path: signaturePath };
}

export function loadAndValidateCatalogSchema(catalog, schemaPath = CATALOG_SCHEMA_PATH) {
  const schemaDocument = readJson(schemaPath, "recovery catalog Draft 2020-12 schema");
  const schema = schemaDocument.value;
  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") stop("recovery catalog schema is not Draft 2020-12");
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  ajv.addFormat("date-time", { type: "string", validate: (value) => STRICT_DATE_TIME.test(value) && Number.isFinite(Date.parse(value)) });
  const validate = ajv.compile(schema);
  if (!validate(catalog)) stop(`recovery catalog Draft 2020-12 validation failed: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  return { schemaPath, schemaBytes: schemaDocument.bytes, schemaSha256: sha256Buffer(schemaDocument.bytes) };
}

export function exactKeys(value, required, optional = [], label = "document") {
  if (!value || typeof value !== "object" || Array.isArray(value)) stop(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) stop(`${label} is missing ${key}`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) stop(`${label} contains unsupported field ${key}`);
}

export function rejectSensitiveMetadata(value, label = "metadata", keyPath = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSensitiveMetadata(entry, label, `${keyPath}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_METADATA_KEY.test(key)) stop(`${label} contains forbidden sensitive field ${keyPath ? `${keyPath}.` : ""}${key}`);
      rejectSensitiveMetadata(entry, label, keyPath ? `${keyPath}.${key}` : key);
    }
    return;
  }
  if (typeof value === "string" && FORBIDDEN_URL.test(value)) stop(`${label} contains a URL or signed-URL material at ${keyPath}`);
}

export function canonicalRelativePath(input, label = "path") {
  if (typeof input !== "string" || !input || input.includes("\\") || input.includes("\0") || /[\u0000-\u001f\u007f]/u.test(input)) {
    stop(`${label} is not a canonical relative path`);
  }
  if (path.posix.isAbsolute(input) || /^[A-Za-z]:/u.test(input) || input.startsWith("//")) stop(`${label} must be relative`);
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) stop(`${label} contains an unsafe segment`);
  for (const part of parts) {
    if (part.includes(":") || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) {
      stop(`${label} contains a Windows-unsafe segment`);
    }
  }
  if (path.posix.normalize(input) !== input) stop(`${label} is not normalized`);
  return input;
}

export function canonicalObjectKey(input, label = "objectKey") {
  const value = canonicalRelativePath(input, label);
  if (FORBIDDEN_URL.test(value) || value.includes("?") || value.includes("#") || value.includes(":")) stop(`${label} must be an opaque COS object key, not a URL`);
  return value;
}

export function assertSafeRoot(rootInput, label, { allowMissing = false } = {}) {
  const root = path.resolve(rootInput);
  if (path.parse(root).root === root) stop(`${label} cannot be a filesystem root`);
  const anchor = path.parse(root).root;
  const relative = path.relative(anchor, root);
  let cursor = anchor;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (allowMissing) break;
      stop(`${label} does not exist: ${cursor}`);
    }
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) stop(`${label} contains a symbolic link: ${cursor}`);
  }
  return root;
}

export function resolveEntry(root, relativePath, label, { mustExist = true } = {}) {
  const canonical = canonicalRelativePath(relativePath, label);
  const absolute = path.resolve(root, ...canonical.split("/"));
  const boundary = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(boundary)) stop(`${label} escaped its root`);
  if (mustExist) {
    assertSafeRoot(absolute, label);
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) stop(`${label} is not a regular non-symlink file`);
  }
  return absolute;
}

function validateFileEntries(files, label, { objectKeys = false } = {}) {
  if (!Array.isArray(files)) stop(`${label}.files must be an array`);
  const exact = new Set();
  const folded = new Set();
  let previous = null;
  let totalBytes = 0;
  for (const [index, entry] of files.entries()) {
    const required = objectKeys ? ["relativePath", "objectKey", "versionId", "bytes", "sha256"] : ["path", "bytes", "sha256"];
    exactKeys(entry, required, [], `${label}.files[${index}]`);
    const relative = canonicalRelativePath(entry[objectKeys ? "relativePath" : "path"], `${label}.files[${index}] path`);
    const foldedPath = relative.toLocaleLowerCase("en-US");
    if (exact.has(relative) || folded.has(foldedPath)) stop(`${label} contains a duplicate or case-colliding path: ${relative}`);
    if (previous !== null && previous.localeCompare(relative, "en") >= 0) stop(`${label} paths must be canonically sorted`);
    exact.add(relative);
    folded.add(foldedPath);
    previous = relative;
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA256.test(String(entry.sha256 || ""))) {
      stop(`${label} has invalid size or hash: ${relative}`);
    }
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes)) stop(`${label} total bytes exceeds the safe integer range`);
    if (objectKeys) {
      canonicalObjectKey(entry.objectKey, `${label}.files[${index}].objectKey`);
      if (typeof entry.versionId !== "string" || !/^[A-Za-z0-9._~+=/-]{1,512}$/u.test(entry.versionId) || FORBIDDEN_URL.test(entry.versionId)) {
        stop(`${label} has an invalid immutable object version: ${relative}`);
      }
    }
  }
  return { totalBytes };
}

export function validateSourceManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion", "projectId", "kind", "canonicalTextEol", "policySha256", "sourceFingerprint",
    "assetManifestSha256", "assetDigest", "assetVersion", "fileCount", "totalBytes", "files",
  ], [], "source manifest");
  if (manifest.schemaVersion !== 1 || manifest.projectId !== PROJECT_ID || manifest.kind !== "clean-source-snapshot" || manifest.canonicalTextEol !== "lf") {
    stop("source manifest identity is invalid");
  }
  for (const field of ["policySha256", "sourceFingerprint", "assetManifestSha256", "assetDigest"]) {
    if (!SHA256.test(String(manifest[field] || ""))) stop(`source manifest ${field} is invalid`);
  }
  if (manifest.assetVersion !== `sha256-${manifest.assetDigest}`) stop("source manifest assetVersion does not match assetDigest");
  const { totalBytes } = validateFileEntries(manifest.files, "source manifest");
  if (manifest.fileCount !== manifest.files.length || manifest.totalBytes !== totalBytes || manifest.fileCount < 1 || manifest.totalBytes < 1) stop("source manifest totals are invalid");
  return manifest;
}

export function validatePublicManifest(manifest) {
  exactKeys(manifest, [
    "schemaVersion", "projectId", "kind", "assetPolicySha256", "contentAddressing", "assetVersion",
    "files", "fileCount", "totalBytes", "digest", "mutableUploadsIncluded",
  ], [], "public asset manifest");
  if (manifest.schemaVersion !== 1 || manifest.projectId !== PROJECT_ID || manifest.kind !== "public-assets"
    || manifest.contentAddressing !== "sha256-files-and-asset-policy" || manifest.mutableUploadsIncluded !== false
    || !SHA256.test(String(manifest.assetPolicySha256 || ""))) stop("public asset manifest identity is invalid");
  const { totalBytes } = validateFileEntries(manifest.files, "public asset manifest");
  let canonical = `asset-policy-sha256  ${manifest.assetPolicySha256}\n`;
  for (const file of manifest.files) canonical += `${file.sha256}  ${file.path}\n`;
  const digest = sha256Buffer(Buffer.from(canonical, "utf8"));
  if (manifest.digest !== digest || manifest.assetVersion !== `sha256-${digest}` || manifest.fileCount !== manifest.files.length
    || manifest.totalBytes !== totalBytes || manifest.fileCount < 1) stop("public asset manifest digest or totals are invalid");
  return manifest;
}

export function validateReadyReceipt(receipt, manifest, manifestSha256) {
  const required = [
    "schemaVersion", "projectId", "kind", "status", "assetVersion", "assetDigest", "assetPolicySha256",
    "manifestSha256", "fileCount", "totalBytes", "mutableUploadsIncluded", "verificationMode", "storageBackend",
    "location", "publisherId", "publisherProtocolVersion", "publisherScriptSha256", "remoteVerification",
    "remoteVerifiedFileCount", "remoteVerifiedTotalBytes", "remoteContentTypeVerified", "remoteCacheControlVerified",
    "overwriteProtocol", "publicationOrder", "verifiedAt",
  ];
  exactKeys(receipt, required, [], "public asset READY receipt");
  const expected = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    kind: "public-assets-readiness-receipt",
    status: "READY",
    assetVersion: manifest.assetVersion,
    assetDigest: manifest.digest,
    assetPolicySha256: manifest.assetPolicySha256,
    manifestSha256,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    mutableUploadsIncluded: false,
    verificationMode: "full-sha256",
    storageBackend: "cos",
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol: "put-object-forbid-overwrite",
    publicationOrder: "assets-then-manifest-then-ready",
  };
  for (const [field, value] of Object.entries(expected)) if (receipt[field] !== value) stop(`public asset READY receipt mismatch: ${field}`);
  if (!SHA256.test(String(receipt.publisherScriptSha256 || "")) || typeof receipt.publisherId !== "string" || !receipt.publisherId
    || typeof receipt.publisherProtocolVersion !== "number" || typeof receipt.remoteVerification !== "string" || !receipt.remoteVerification) {
    stop("public asset READY publisher identity is invalid");
  }
  if (typeof receipt.location !== "string" || !receipt.location.startsWith("cos://") || !receipt.location.endsWith(`/${manifest.assetVersion}`)
    || receipt.location.includes("?") || receipt.location.includes("#")) stop("public asset READY location is invalid or not version-bound");
  if (typeof receipt.verifiedAt !== "string" || Number.isNaN(Date.parse(receipt.verifiedAt))) stop("public asset READY verifiedAt is invalid");
  return receipt;
}

export function validateSourceCommitReceipt(receipt, sourceManifestSha256, sourceVersion, gitCommit) {
  exactKeys(receipt, ["schemaVersion", "projectId", "status", "gitCommit", "sourceVersion", "sourceManifestSha256", "verificationMode", "verifiedAt"], [], "source commit receipt");
  if (receipt.schemaVersion !== SOURCE_COMMIT_RECEIPT_SCHEMA || receipt.projectId !== PROJECT_ID || receipt.status !== "VERIFIED"
    || receipt.gitCommit !== gitCommit || receipt.sourceVersion !== sourceVersion || receipt.sourceManifestSha256 !== sourceManifestSha256
    || receipt.verificationMode !== "git-object-manifest-sha256" || Number.isNaN(Date.parse(receipt.verifiedAt))) {
    stop("source commit receipt does not bind the requested exact Git commit and manifest");
  }
  return receipt;
}

export function validateBackupReceipt(receipt, packagePath, sourceVersion) {
  const required = [
    "schemaVersion", "status", "backupId", "sourceVersion", "createdEpoch", "completedEpoch", "artifactCreationDurationSeconds",
    "oldestComponentAgeAtCompletionSeconds", "encryptedPackage", "encryptedSha256", "manifestSha256", "componentSnapshots",
    "sharedSnapshot", "productionConsistency", "productionConsistencyComplete", "sourceTargetDisjoint", "expectedDeviceVerified",
    "plaintextFinalPackage", "finalPackageHashVerified", "manifestHashVerified", "atomicCommit",
  ];
  exactKeys(receipt, required, [], "database backup receipt");
  if (receipt.schemaVersion !== "zimeiti-backup-receipt.v1" || receipt.status !== "complete" || receipt.sourceVersion !== sourceVersion
    || !/^backup-[0-9]{8}T[0-9]{6}Z-[0-9]+$/u.test(String(receipt.backupId || "")) || receipt.encryptedPackage !== "package.tar.gz.age"
    || !SHA256.test(String(receipt.encryptedSha256 || "")) || !SHA256.test(String(receipt.manifestSha256 || "")) || sha256File(packagePath) !== receipt.encryptedSha256
    || receipt.productionConsistency !== "incomplete" || receipt.productionConsistencyComplete !== false || receipt.sharedSnapshot !== false
    || receipt.plaintextFinalPackage !== false || receipt.finalPackageHashVerified !== true || receipt.manifestHashVerified !== true
    || receipt.atomicCommit !== true || receipt.sourceTargetDisjoint !== true || receipt.expectedDeviceVerified !== true) {
    stop("database backup receipt or encrypted package binding is invalid");
  }
  if (!Number.isSafeInteger(receipt.createdEpoch) || !Number.isSafeInteger(receipt.completedEpoch) || receipt.createdEpoch < 1 || receipt.completedEpoch < receipt.createdEpoch
    || !Number.isSafeInteger(receipt.artifactCreationDurationSeconds) || receipt.artifactCreationDurationSeconds !== receipt.completedEpoch - receipt.createdEpoch
    || !Number.isSafeInteger(receipt.oldestComponentAgeAtCompletionSeconds) || receipt.oldestComponentAgeAtCompletionSeconds < 0
    || !Array.isArray(receipt.componentSnapshots) || receipt.componentSnapshots.length !== 8) {
    stop("database backup receipt component/timestamp contract is invalid");
  }
  const components = new Set();
  for (const snapshot of receipt.componentSnapshots) {
    exactKeys(snapshot, ["component", "method", "startedEpoch", "completedEpoch", "consistency", "sharedWithOtherComponents", "evidenceSha256"], [], "database component snapshot");
    if (!SAFE_ID.test(String(snapshot.component || "")) || !SAFE_ID.test(String(snapshot.method || "")) || components.has(snapshot.component)
      || !Number.isSafeInteger(snapshot.startedEpoch) || !Number.isSafeInteger(snapshot.completedEpoch) || snapshot.startedEpoch < 1 || snapshot.completedEpoch < snapshot.startedEpoch
      || snapshot.consistency !== "verified" || snapshot.sharedWithOtherComponents !== false || !SHA256.test(String(snapshot.evidenceSha256 || ""))) {
      stop("database backup component snapshot is invalid");
    }
    components.add(snapshot.component);
  }
  return receipt;
}

export function validateUserInventory(inventory, sourceVersion, environment = "production-recovery") {
  exactKeys(inventory, [
    "schemaVersion", "projectId", "environment", "sourceVersion", "snapshotAt", "bucket", "accountId", "tenantId", "region", "ownerId", "databaseIdentity",
    "crossComponentConsistency", "files", "fileCount", "totalBytes", "digest",
  ], [], "user object inventory");
  rejectSensitiveMetadata(inventory, "user object inventory");
  if (inventory.schemaVersion !== USER_INVENTORY_SCHEMA || inventory.projectId !== PROJECT_ID || inventory.environment !== environment || inventory.sourceVersion !== sourceVersion
    || inventory.crossComponentConsistency !== false || !STRICT_DATE_TIME.test(inventory.snapshotAt) || Number.isNaN(Date.parse(inventory.snapshotAt))
    || !/^[a-z0-9][a-z0-9.-]{2,127}$/u.test(String(inventory.bucket || ""))
    || !SAFE_ID.test(String(inventory.accountId || "")) || !SAFE_ID.test(String(inventory.tenantId || ""))
    || !/^[a-z0-9-]+$/u.test(String(inventory.region || "")) || !SAFE_ID.test(String(inventory.ownerId || ""))
    || !SAFE_ID.test(String(inventory.databaseIdentity || ""))) stop("user object inventory identity is invalid");
  const { totalBytes } = validateFileEntries(inventory.files, "user object inventory", { objectKeys: true });
  let canonical = `source-version  ${sourceVersion}\nsnapshot-at  ${inventory.snapshotAt}\nbucket  ${inventory.bucket}\naccount-id  ${inventory.accountId}\ntenant-id  ${inventory.tenantId}\nregion  ${inventory.region}\nowner-id  ${inventory.ownerId}\ndatabase-identity  ${inventory.databaseIdentity}\n`;
  for (const file of inventory.files) canonical += `${file.sha256}  ${file.bytes}  ${file.versionId}  ${file.objectKey}  ${file.relativePath}\n`;
  const digest = sha256Buffer(Buffer.from(canonical, "utf8"));
  if (inventory.fileCount !== inventory.files.length || inventory.totalBytes !== totalBytes || inventory.digest !== digest || !SHA256.test(inventory.digest)) {
    stop("user object inventory digest or totals are invalid");
  }
  return inventory;
}

export function defaultReadiness(recoveryBindingSha256 = "0".repeat(64), environment = "production-recovery") {
  return {
    schemaVersion: READINESS_EVIDENCE_SCHEMA,
    projectId: PROJECT_ID,
    environment,
    recoveryBindingSha256,
    checks: READINESS_IDS.map((id) => ({ id, verified: false, evidencePath: null, evidenceSha256: null, signaturePath: null, signatureSha256: null, issuerFingerprint: null })),
  };
}

function validateReadinessItem(item, checkId, bindingDigest, environment) {
  exactKeys(item, [
    "schemaVersion", "projectId", "checkId", "status", "environment", "recoveryBindingSha256", "targetId", "observedAt",
    "accountOrTenant", "region", "ownerId", "failureDomain", "mediaType", "offline", "immutable", "independentFromPrimary",
    "verificationErrors", "drillReceiptSha256", "verificationReportSha256", "supportingEvidencePath", "supportingEvidenceSha256",
  ], [], `readiness item ${checkId}`);
  rejectSensitiveMetadata(item, `readiness item ${checkId}`);
  if (item.schemaVersion !== READINESS_ITEM_SCHEMA || item.projectId !== PROJECT_ID || item.checkId !== checkId || item.status !== "VERIFIED"
    || item.environment !== environment || item.recoveryBindingSha256 !== bindingDigest || !STRICT_DATE_TIME.test(item.observedAt) || Number.isNaN(Date.parse(item.observedAt))
    || Date.parse(item.observedAt) > Date.now() + 5 * 60 * 1000 || Date.now() - Date.parse(item.observedAt) > MAX_EVIDENCE_AGE_MS || !SAFE_ID.test(String(item.targetId || ""))
    || !SAFE_ID.test(String(item.accountOrTenant || "")) || !/^[a-z0-9-]+$/u.test(String(item.region || ""))
    || !SAFE_ID.test(String(item.ownerId || "")) || !SAFE_ID.test(String(item.failureDomain || ""))
    || !["cloud-services", "removable-storage", "object-storage", "isolated-restore", "audit"].includes(item.mediaType)
    || typeof item.offline !== "boolean" || typeof item.immutable !== "boolean" || typeof item.independentFromPrimary !== "boolean"
    || !Number.isSafeInteger(item.verificationErrors) || item.verificationErrors !== 0
    || (item.drillReceiptSha256 !== null && !SHA256.test(String(item.drillReceiptSha256 || "")))
    || (item.verificationReportSha256 !== null && !SHA256.test(String(item.verificationReportSha256 || "")))
    || (item.supportingEvidenceSha256 !== null && !SHA256.test(String(item.supportingEvidenceSha256 || "")))) stop(`readiness item semantic mismatch: ${checkId}`);
  const semantic = {
    "primary-copy": item.targetId === "primary-recovery-set" && item.mediaType === "cloud-services" && !item.offline && !item.independentFromPrimary,
    "offline-copy": item.targetId === "offline-recovery-copy" && item.mediaType === "removable-storage" && item.offline && item.independentFromPrimary,
    "independent-offsite-copy": item.targetId === "offsite-immutable-copy" && item.mediaType === "object-storage" && item.immutable && item.independentFromPrimary,
    "two-failure-domains": item.targetId === "failure-domain-audit" && item.mediaType === "audit",
    "offline-or-immutable": item.targetId === "offline-or-immutable-audit" && item.mediaType === "audit",
    "empty-disk-drill": item.targetId === "empty-disk-drill" && item.mediaType === "isolated-restore" && SHA256.test(String(item.drillReceiptSha256 || "")),
    "zero-verification-errors": item.targetId === "verification-summary" && item.mediaType === "audit" && SHA256.test(String(item.verificationReportSha256 || "")),
  }[checkId];
  if (!semantic) stop(`readiness item target/media semantics are invalid: ${checkId}`);
  return item;
}

export function validateReadinessEvidence(value, bindingDigest, evidenceRoot, trust = null, identity = null, replayState = { receiptIds: new Set(), nonces: new Set() }) {
  exactKeys(value, ["schemaVersion", "projectId", "environment", "recoveryBindingSha256", "checks"], [], "readiness evidence");
  rejectSensitiveMetadata(value, "readiness evidence");
  if (value.schemaVersion !== READINESS_EVIDENCE_SCHEMA || value.projectId !== PROJECT_ID || value.environment !== identity?.environment
    || value.recoveryBindingSha256 !== bindingDigest || !Array.isArray(value.checks) || value.checks.length !== READINESS_IDS.length) {
    stop("readiness evidence identity is invalid");
  }
  const byId = new Map();
  const evidenceFiles = [];
  const items = new Map();
  for (const check of value.checks) {
    exactKeys(check, ["id", "verified", "evidencePath", "evidenceSha256", "signaturePath", "signatureSha256", "issuerFingerprint"], [], "readiness check");
    if (!READINESS_IDS.includes(check.id) || byId.has(check.id) || typeof check.verified !== "boolean") stop("readiness check set is invalid");
    if (!check.verified) {
      if (check.evidencePath !== null || check.evidenceSha256 !== null || check.signaturePath !== null || check.signatureSha256 !== null || check.issuerFingerprint !== null) stop(`blocked readiness check cannot claim evidence: ${check.id}`);
    } else {
      if (!evidenceRoot || !SHA256.test(String(check.evidenceSha256 || "")) || typeof check.evidencePath !== "string"
        || !SHA256.test(String(check.signatureSha256 || "")) || typeof check.signaturePath !== "string" || !SHA256.test(String(check.issuerFingerprint || ""))) {
        stop(`readiness check evidence or detached signature is missing: ${check.id}`);
      }
      const relative = canonicalRelativePath(check.evidencePath, `readiness evidence path ${check.id}`);
      if (!relative.startsWith("evidence/") || !relative.endsWith(".json")) stop(`readiness evidence path is outside evidence/: ${check.id}`);
      const localRelative = relative.slice("evidence/".length);
      const filePath = resolveEntry(evidenceRoot, localRelative, `readiness evidence file ${check.id}`);
      if (sha256File(filePath) !== check.evidenceSha256) stop(`readiness evidence content hash mismatch: ${check.id}`);
      const item = readJson(filePath, `readiness item ${check.id}`).value;
      validateReadinessItem(item, check.id, bindingDigest, value.environment);
      if (["empty-disk-drill", "zero-verification-errors"].includes(check.id)) {
        const supportRelative = canonicalRelativePath(item.supportingEvidencePath, `supporting evidence path ${check.id}`);
        if (!supportRelative.startsWith("evidence/") || !supportRelative.endsWith(".json")) stop(`supporting evidence path is invalid: ${check.id}`);
        const supportPath = resolveEntry(evidenceRoot, supportRelative.slice("evidence/".length), `supporting evidence ${check.id}`);
        const supportSha = sha256File(supportPath);
        const semanticHash = check.id === "empty-disk-drill" ? item.drillReceiptSha256 : item.verificationReportSha256;
        if (supportSha !== item.supportingEvidenceSha256 || supportSha !== semanticHash) stop(`supporting evidence content hash mismatch: ${check.id}`);
        evidenceFiles.push({ relativePath: supportRelative, sourcePath: supportPath, sha256: supportSha, bytes: fs.statSync(supportPath).size });
      } else if (item.supportingEvidencePath !== null || item.supportingEvidenceSha256 !== null) stop(`unexpected supporting evidence: ${check.id}`);
      const signatureRelative = canonicalRelativePath(check.signaturePath, `readiness signature path ${check.id}`);
      if (!signatureRelative.startsWith("evidence/") || !signatureRelative.endsWith(".sig.json")) stop(`readiness signature path is invalid: ${check.id}`);
      const signaturePath = resolveEntry(evidenceRoot, signatureRelative.slice("evidence/".length), `readiness detached signature ${check.id}`);
      if (sha256File(signaturePath) !== check.signatureSha256) stop(`readiness detached signature hash mismatch: ${check.id}`);
      const signature = verifyDetachedSignature(signaturePath, fs.readFileSync(filePath), {
        ...identity, evidenceType: `readiness:${check.id}`, catalogBindingSha256: bindingDigest,
      }, trust, replayState);
      if (signature.value.publicKeyFingerprint !== check.issuerFingerprint) stop(`readiness issuer fingerprint mismatch: ${check.id}`);
      evidenceFiles.push({ relativePath: relative, sourcePath: filePath, sha256: check.evidenceSha256, bytes: fs.statSync(filePath).size });
      evidenceFiles.push({ relativePath: signatureRelative, sourcePath: signaturePath, sha256: check.signatureSha256, bytes: fs.statSync(signaturePath).size });
      items.set(check.id, item);
    }
    byId.set(check.id, check);
  }
  const checks = READINESS_IDS.map((id) => byId.get(id));
  if (checks.every((check) => check.verified)) {
    const primary = items.get("primary-copy");
    const offline = items.get("offline-copy");
    const offsite = items.get("independent-offsite-copy");
    if (new Set([primary.failureDomain, offline.failureDomain, offsite.failureDomain]).size < 3
      || new Set([primary.ownerId, offline.ownerId, offsite.ownerId]).size < 3
      || new Set([primary.accountOrTenant, offline.accountOrTenant, offsite.accountOrTenant]).size < 3
      || new Set([primary.region, offline.region, offsite.region]).size < 3
      || new Set([primary.mediaType, offline.mediaType, offsite.mediaType]).size < 3
      || offline.accountOrTenant === primary.accountOrTenant || offsite.accountOrTenant === primary.accountOrTenant
      || offline.region === primary.region || offsite.region === primary.region
      || !offline.offline || !(offsite.immutable || offsite.offline)) {
      stop("readiness evidence does not prove independent failure domains and offline/immutable copies");
    }
  }
  return { checks, evidenceFiles, items };
}

function verifyFiles(root, files, pathField, label) {
  let bytes = 0;
  for (const entry of files) {
    const relative = entry[pathField];
    const filePath = resolveEntry(root, relative, `${label}: ${relative}`);
    const stats = fs.lstatSync(filePath);
    if (stats.size !== entry.bytes || sha256File(filePath) !== entry.sha256) stop(`${label} size/hash mismatch: ${relative}`);
    bytes += stats.size;
  }
  return bytes;
}

export function buildRecoveryInputs(options) {
  const required = [
    "source-root", "source-manifest", "source-commit-receipt", "git-commit", "source-version", "public-root", "public-manifest",
    "public-ready-receipt", "user-root", "user-inventory", "database-package", "database-receipt", "output-root",
  ];
  for (const name of required) if (!options.get(`--${name}`)) stop(`--${name} is required`);
  const sourceRoot = assertSafeRoot(options.get("--source-root"), "source root");
  const publicRoot = assertSafeRoot(options.get("--public-root"), "public asset root");
  const userRoot = assertSafeRoot(options.get("--user-root"), "user asset root");
  const outputRoot = assertSafeRoot(options.get("--output-root"), "output root");
  for (const [label, root] of [["source", sourceRoot], ["public", publicRoot], ["user", userRoot]]) {
    const outputInsideInput = outputRoot.startsWith(`${root}${path.sep}`);
    const inputInsideOutput = root.startsWith(`${outputRoot}${path.sep}`);
    if (outputRoot === root || outputInsideInput || inputInsideOutput) stop(`output root must be disjoint from ${label} root`);
  }
  if (!fs.lstatSync(outputRoot).isDirectory()) stop("output root must be a directory");
  const sourceVersion = options.get("--source-version");
  const gitCommit = options.get("--git-commit");
  const environment = options.get("--environment") || "production-recovery";
  if (!SAFE_ID.test(environment)) stop("recovery environment is invalid");
  if (!SAFE_ID.test(sourceVersion) || !GIT_COMMIT.test(gitCommit)) stop("sourceVersion or exact Git commit is invalid");

  const sourceManifestPath = assertSafeRoot(options.get("--source-manifest"), "source manifest");
  const sourceCommitReceiptPath = assertSafeRoot(options.get("--source-commit-receipt"), "source commit receipt");
  const publicManifestPath = assertSafeRoot(options.get("--public-manifest"), "public asset manifest");
  const publicReadyPath = assertSafeRoot(options.get("--public-ready-receipt"), "public asset READY receipt");
  const userInventoryPath = assertSafeRoot(options.get("--user-inventory"), "user object inventory");
  const databasePackagePath = assertSafeRoot(options.get("--database-package"), "database package");
  const databaseReceiptPath = assertSafeRoot(options.get("--database-receipt"), "database receipt");
  for (const [label, filePath] of Object.entries({ sourceManifestPath, sourceCommitReceiptPath, publicManifestPath, publicReadyPath, userInventoryPath, databasePackagePath, databaseReceiptPath })) {
    if (!fs.lstatSync(filePath).isFile()) stop(`${label} must be a regular file`);
  }

  const sourceDocument = readJson(sourceManifestPath, "source manifest");
  const publicDocument = readJson(publicManifestPath, "public asset manifest");
  const readyDocument = readJson(publicReadyPath, "public asset READY receipt");
  const userDocument = readJson(userInventoryPath, "user object inventory");
  const backupDocument = readJson(databaseReceiptPath, "database receipt");
  const commitDocument = readJson(sourceCommitReceiptPath, "source commit receipt");
  const sourceManifest = validateSourceManifest(sourceDocument.value);
  const publicManifest = validatePublicManifest(publicDocument.value);
  const publicManifestSha256 = sha256Buffer(publicDocument.bytes);
  if (sourceManifest.assetManifestSha256 !== publicManifestSha256 || sourceManifest.assetDigest !== publicManifest.digest
    || sourceManifest.assetVersion !== publicManifest.assetVersion) stop("source and public asset manifests are not bound to the same release");
  const sourceManifestSha256 = sha256Buffer(sourceDocument.bytes);
  validateSourceCommitReceipt(commitDocument.value, sourceManifestSha256, sourceVersion, gitCommit);
  validateReadyReceipt(readyDocument.value, publicManifest, publicManifestSha256);
  validateBackupReceipt(backupDocument.value, databasePackagePath, sourceVersion);
  const userInventory = validateUserInventory(userDocument.value, sourceVersion, environment);
  verifyFiles(sourceRoot, sourceManifest.files, "path", "source file");
  verifyFiles(publicRoot, publicManifest.files, "path", "public asset");
  verifyFiles(userRoot, userInventory.files, "relativePath", "user asset");

  const createdAt = new Date(backupDocument.value.completedEpoch * 1000).toISOString();
  const binding = {
    gitCommit,
    sourceVersion,
    sourceManifestSha256,
    publicManifestSha256,
    publicReadyReceiptSha256: sha256Buffer(readyDocument.bytes),
    databaseReceiptSha256: sha256Buffer(backupDocument.bytes),
    databasePackageSha256: backupDocument.value.encryptedSha256,
    userInventorySha256: sha256Buffer(userDocument.bytes),
  };
  const bindingDigest = sha256Buffer(Buffer.from(stableJson(binding), "utf8"));
  const trust = loadTrustedIssuers(options.get("--trusted-issuers"), environment);
  const identity = {
    environment,
    gitCommit,
    assetVersion: publicManifest.assetVersion,
    databaseIdentity: userInventory.databaseIdentity,
    accountId: userInventory.accountId,
    tenantId: userInventory.tenantId,
  };
  const replayState = { receiptIds: new Set(), nonces: new Set() };
  const externalSignatures = {};
  if (trust.trusted) {
    for (const [name, option, bytes, evidenceType] of [
      ["source", "--source-signature", commitDocument.bytes, "source-commit"],
      ["public", "--public-signature", readyDocument.bytes, "public-ready"],
      ["database", "--database-signature", backupDocument.bytes, "database-backup"],
      ["user", "--user-signature", userDocument.bytes, "user-inventory"],
    ]) {
      if (!options.get(option)) stop(`${option} is required when a trusted issuer allowlist is supplied`);
      const signaturePath = assertSafeRoot(options.get(option), `${name} detached signature`);
      externalSignatures[name] = verifyDetachedSignature(signaturePath, bytes, {
        ...identity, evidenceType, catalogBindingSha256: bindingDigest,
      }, trust, replayState);
    }
  }
  let readinessValue = defaultReadiness(bindingDigest, environment);
  let readinessEvidencePath = null;
  let readinessEvidenceRoot = null;
  let readinessEvidenceBytes = Buffer.from(`${JSON.stringify(readinessValue, null, 2)}\n`, "utf8");
  if (options.get("--readiness-evidence")) {
    if (!trust.trusted) stop("signed readiness evidence requires a trusted issuer allowlist");
    if (!options.get("--readiness-evidence-root")) stop("--readiness-evidence-root is required with --readiness-evidence");
    readinessEvidencePath = assertSafeRoot(options.get("--readiness-evidence"), "readiness evidence");
    readinessEvidenceRoot = assertSafeRoot(options.get("--readiness-evidence-root"), "readiness evidence root");
    const readinessDocument = readJson(readinessEvidencePath, "readiness evidence");
    readinessValue = readinessDocument.value;
    readinessEvidenceBytes = readinessDocument.bytes;
  }
  const readiness = validateReadinessEvidence(readinessValue, bindingDigest, readinessEvidenceRoot, trust, identity, replayState);
  const catalogSchemaDocument = readJson(CATALOG_SCHEMA_PATH, "recovery catalog Draft 2020-12 schema");
  if (catalogSchemaDocument.value.$schema !== "https://json-schema.org/draft/2020-12/schema") stop("recovery catalog schema is not Draft 2020-12");
  const catalog = {
    schemaVersion: CATALOG_SCHEMA,
    projectId: PROJECT_ID,
    environment,
    accountId: userInventory.accountId,
    tenantId: userInventory.tenantId,
    databaseIdentity: userInventory.databaseIdentity,
    catalogId: `recovery-${sourceVersion}-${bindingDigest.slice(0, 16)}`,
    catalogSchemaSha256: sha256Buffer(catalogSchemaDocument.bytes),
    createdAt,
    source: {
      gitCommit,
      sourceVersion,
      manifestSha256: sourceManifestSha256,
      commitReceiptSha256: sha256Buffer(commitDocument.bytes),
      detachedSignatureSha256: externalSignatures.source?.sha256 || null,
      sourceFingerprint: sourceManifest.sourceFingerprint,
      fileCount: sourceManifest.fileCount,
      totalBytes: sourceManifest.totalBytes,
    },
    publicAssets: {
      assetVersion: publicManifest.assetVersion,
      assetDigest: publicManifest.digest,
      manifestSha256: publicManifestSha256,
      readyReceiptSha256: sha256Buffer(readyDocument.bytes),
      detachedSignatureSha256: externalSignatures.public?.sha256 || null,
      fileCount: publicManifest.fileCount,
      totalBytes: publicManifest.totalBytes,
    },
    databaseBackup: {
      backupId: backupDocument.value.backupId,
      sourceVersion,
      packageSha256: backupDocument.value.encryptedSha256,
      receiptSha256: sha256Buffer(backupDocument.bytes),
      detachedSignatureSha256: externalSignatures.database?.sha256 || null,
      projectId: PROJECT_ID,
      environment,
      accountId: userInventory.accountId,
      tenantId: userInventory.tenantId,
      databaseIdentity: userInventory.databaseIdentity,
      productionConsistency: "incomplete",
    },
    userAssets: {
      inventorySha256: sha256Buffer(userDocument.bytes),
      detachedSignatureSha256: externalSignatures.user?.sha256 || null,
      inventoryDigest: userInventory.digest,
      snapshotAt: userInventory.snapshotAt,
      bucket: userInventory.bucket,
      accountId: userInventory.accountId,
      tenantId: userInventory.tenantId,
      region: userInventory.region,
      ownerId: userInventory.ownerId,
      databaseIdentity: userInventory.databaseIdentity,
      fileCount: userInventory.fileCount,
      totalBytes: userInventory.totalBytes,
      crossComponentConsistency: false,
    },
    consistency: {
      crossComponentConsistency: false,
      databaseAndObjectsJointSnapshot: false,
      truth: "independent-verified-components",
    },
    trust: {
      status: trust.trusted ? "TRUSTED" : "BLOCKED",
      allowlistSha256: trust.sha256 || null,
      algorithm: "Ed25519",
      maxEvidenceAgeSeconds: MAX_EVIDENCE_AGE_MS / 1000,
    },
    readiness: {
      standard: "3-2-1-1-0",
      status: trust.trusted && readiness.checks.every((check) => check.verified) ? "READY" : "BLOCKED",
      checks: readiness.checks,
    },
  };
  rejectSensitiveMetadata(catalog, "recovery catalog");
  const loadedSchema = loadAndValidateCatalogSchema(catalog);
  if (catalog.catalogSchemaSha256 !== loadedSchema.schemaSha256) stop("catalog schema hash binding failed");
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const catalogSha256 = sha256Buffer(catalogBytes);
  return {
    sourceRoot, publicRoot, userRoot, outputRoot, sourceManifestPath, sourceCommitReceiptPath, publicManifestPath,
    publicReadyPath, userInventoryPath, databasePackagePath, databaseReceiptPath, readinessEvidencePath,
    sourceDocument, commitDocument, publicDocument, readyDocument, userDocument, backupDocument,
    readinessEvidenceBytes, readinessEvidenceRoot, readinessEvidenceFiles: readiness.evidenceFiles, catalogSchemaPath: CATALOG_SCHEMA_PATH,
    trust, externalSignatures,
    catalogSchemaBytes: loadedSchema.schemaBytes, bindingDigest, sourceManifest, publicManifest, userInventory, catalog, catalogBytes, catalogSha256,
  };
}

export function parseOptions(argv) {
  const flags = new Set(["--execute"]);
  const options = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (flags.has(argument)) {
      if (options.has(argument)) stop(`duplicate option ${argument}`);
      options.set(argument, "1");
      continue;
    }
    if (!argument.startsWith("--")) stop(`unexpected argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || options.has(argument)) stop(`missing or duplicate value for ${argument}`);
    options.set(argument, value);
    index += 1;
  }
  return options;
}

function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) stop(`unsafe output directory: ${directoryPath}`);
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
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) stop(`export copy source changed during read: ${source}`);
  } finally {
    fs.closeSync(sourceDescriptor);
    fs.closeSync(destinationDescriptor);
  }
  const current = fs.lstatSync(source);
  if (current.dev !== before.dev || current.ino !== before.ino || fs.realpathSync.native(source) !== sourceRealBefore
    || fs.realpathSync.native(path.dirname(destination)) !== parentRealBefore) stop("export copy detected symlink/junction swap");
}

function writeExclusive(destination, bytes) {
  ensureDirectory(path.dirname(destination));
  const descriptor = fs.openSync(destination, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function copyEntries(sourceRoot, destinationRoot, entries, pathField) {
  for (const entry of entries) {
    const relative = entry[pathField];
    copyExclusive(resolveEntry(sourceRoot, relative, `copy source ${relative}`), resolveEntry(destinationRoot, relative, `copy destination ${relative}`, { mustExist: false }));
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

function exactTree(root, expectedFiles, expectedBaseDirectories) {
  const actualFiles = new Set();
  const actualDirectories = new Set();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (stats.isSymbolicLink()) stop(`exported bundle contains a symbolic link: ${relative}`);
      if (stats.isDirectory()) {
        actualDirectories.add(relative);
        visit(absolute);
      } else if (stats.isFile()) actualFiles.add(relative);
      else stop(`exported bundle contains a non-file entry: ${relative}`);
    }
  };
  visit(root);
  const expectedDirectories = new Set(expectedBaseDirectories);
  for (const file of expectedFiles) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  if (actualFiles.size !== expectedFiles.size || [...actualFiles].some((file) => !expectedFiles.has(file))
    || actualDirectories.size !== expectedDirectories.size || [...actualDirectories].some((directory) => !expectedDirectories.has(directory))) {
    stop("exported recovery bundle exact inventory mismatch");
  }
}

function verifyExportedBundle(inputs, bundleRoot) {
  verifyFiles(path.join(bundleRoot, "source"), inputs.sourceManifest.files, "path", "exported source");
  verifyFiles(path.join(bundleRoot, "public-assets"), inputs.publicManifest.files, "path", "exported public asset");
  verifyFiles(path.join(bundleRoot, "user-assets"), inputs.userInventory.files, "relativePath", "exported user asset");
  if (sha256File(path.join(bundleRoot, "database", "package.tar.gz.age")) !== inputs.catalog.databaseBackup.packageSha256) stop("exported database package hash mismatch");
  const metadataBindings = [
    ["metadata/recovery-catalog.v1.json", inputs.catalogSha256],
    ["metadata/recovery-catalog.v1.schema.json", inputs.catalog.catalogSchemaSha256],
    ["metadata/source-files.v1.json", sha256Buffer(inputs.sourceDocument.bytes)],
    ["metadata/source-commit-receipt.v1.json", sha256Buffer(inputs.commitDocument.bytes)],
    ["metadata/public-assets.v1.json", sha256Buffer(inputs.publicDocument.bytes)],
    ["metadata/public-assets.ready.v1.json", sha256Buffer(inputs.readyDocument.bytes)],
    ["metadata/user-object-inventory.v1.json", sha256Buffer(inputs.userDocument.bytes)],
    ["metadata/database-backup-receipt.v1.json", sha256Buffer(inputs.backupDocument.bytes)],
    ["metadata/readiness-evidence.v1.json", sha256Buffer(inputs.readinessEvidenceBytes)],
  ];
  if (inputs.trust.trusted) {
    metadataBindings.push(["metadata/trusted-issuers.v1.json", inputs.trust.sha256]);
    for (const [name, signature] of Object.entries(inputs.externalSignatures)) metadataBindings.push([`metadata/${name}.sig.json`, signature.sha256]);
  }
  for (const [relative, expectedHash] of metadataBindings) if (sha256File(path.join(bundleRoot, ...relative.split("/"))) !== expectedHash) stop(`exported metadata hash mismatch: ${relative}`);
  for (const evidence of inputs.readinessEvidenceFiles) {
    const filePath = path.join(bundleRoot, ...evidence.relativePath.split("/"));
    if (fs.statSync(filePath).size !== evidence.bytes || sha256File(filePath) !== evidence.sha256) stop(`exported readiness evidence mismatch: ${evidence.relativePath}`);
  }
  const expectedFiles = new Set([
    ...inputs.sourceManifest.files.map((file) => `source/${file.path}`),
    ...inputs.publicManifest.files.map((file) => `public-assets/${file.path}`),
    ...inputs.userInventory.files.map((file) => `user-assets/${file.relativePath}`),
    ...metadataBindings.map(([relative]) => relative),
    ...inputs.readinessEvidenceFiles.map((item) => item.relativePath),
    "database/package.tar.gz.age",
    ".release/recovery-export-receipt.v1.json",
  ]);
  exactTree(bundleRoot, expectedFiles, ["source", "public-assets", "user-assets", "database", "metadata", "evidence", ".release"]);
}

function exportBundle(inputs, confirm) {
  if (confirm !== inputs.catalogSha256) stop(`--confirm must equal catalog SHA-256 ${inputs.catalogSha256}`);
  const finalRoot = path.join(inputs.outputRoot, inputs.catalog.catalogId);
  if (fs.existsSync(finalRoot)) stop(`recovery export target already exists: ${finalRoot}`);
  const stagingRoot = path.join(inputs.outputRoot, `.staging-${inputs.catalog.catalogId}-${process.pid}-${crypto.randomUUID()}`);
  if (fs.existsSync(stagingRoot)) stop("recovery export staging target already exists");
  ensureDirectory(stagingRoot);
  for (const directory of ["source", "public-assets", "user-assets", "database", "metadata", "evidence", ".release"]) {
    ensureDirectory(path.join(stagingRoot, directory));
  }
  copyEntries(inputs.sourceRoot, path.join(stagingRoot, "source"), inputs.sourceManifest.files, "path");
  copyEntries(inputs.publicRoot, path.join(stagingRoot, "public-assets"), inputs.publicManifest.files, "path");
  copyEntries(inputs.userRoot, path.join(stagingRoot, "user-assets"), inputs.userInventory.files, "relativePath");
  copyExclusive(inputs.databasePackagePath, path.join(stagingRoot, "database", "package.tar.gz.age"));
  const metadata = path.join(stagingRoot, "metadata");
  writeExclusive(path.join(metadata, "recovery-catalog.v1.json"), inputs.catalogBytes);
  writeExclusive(path.join(metadata, "recovery-catalog.v1.schema.json"), inputs.catalogSchemaBytes);
  copyExclusive(inputs.sourceManifestPath, path.join(metadata, "source-files.v1.json"));
  copyExclusive(inputs.sourceCommitReceiptPath, path.join(metadata, "source-commit-receipt.v1.json"));
  copyExclusive(inputs.publicManifestPath, path.join(metadata, "public-assets.v1.json"));
  copyExclusive(inputs.publicReadyPath, path.join(metadata, "public-assets.ready.v1.json"));
  copyExclusive(inputs.userInventoryPath, path.join(metadata, "user-object-inventory.v1.json"));
  copyExclusive(inputs.databaseReceiptPath, path.join(metadata, "database-backup-receipt.v1.json"));
  writeExclusive(path.join(metadata, "readiness-evidence.v1.json"), inputs.readinessEvidenceBytes);
  if (inputs.trust.trusted) {
    copyExclusive(inputs.trust.path, path.join(metadata, "trusted-issuers.v1.json"));
    for (const [name, signature] of Object.entries(inputs.externalSignatures)) copyExclusive(signature.path, path.join(metadata, `${name}.sig.json`));
  }
  for (const evidence of inputs.readinessEvidenceFiles) {
    copyExclusive(evidence.sourcePath, path.join(stagingRoot, ...evidence.relativePath.split("/")));
  }
  const receipt = {
    schemaVersion: EXPORT_RECEIPT_SCHEMA,
    status: "complete",
    catalogId: inputs.catalog.catalogId,
    catalogSha256: inputs.catalogSha256,
    recoveryBindingSha256: inputs.bindingDigest,
    sourceFiles: inputs.sourceManifest.fileCount,
    publicAssetFiles: inputs.publicManifest.fileCount,
    userAssetFiles: inputs.userInventory.fileCount,
    databasePackageSha256: inputs.catalog.databaseBackup.packageSha256,
    catalogSchemaSha256: inputs.catalog.catalogSchemaSha256,
    stagingVerified: true,
    atomicCommit: true,
    overwritePrevented: true,
    networkAccessed: false,
    createdAt: inputs.catalog.createdAt,
  };
  writeExclusive(path.join(stagingRoot, ".release", "recovery-export-receipt.v1.json"), Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8"));
  verifyExportedBundle(inputs, stagingRoot);
  fsyncTree(stagingRoot);
  fsyncDirectory(inputs.outputRoot);
  verifyExportedBundle(inputs, stagingRoot);
  if (fs.existsSync(finalRoot)) stop("recovery export target appeared before atomic commit");
  if (process.platform !== "win32") stop("recovery export execute requires an OS no-replace directory rename primitive; this implementation is Windows fail-closed");
  try { fs.renameSync(stagingRoot, finalRoot); } catch (error) { stop(`recovery export no-replace atomic commit failed: ${error?.code || error}`); }
  fsyncDirectory(inputs.outputRoot);
  verifyExportedBundle(inputs, finalRoot);
  return { finalRoot, receipt };
}

export function runExportCli(argv = process.argv) {
  const options = parseOptions(argv);
  const inputs = buildRecoveryInputs(options);
  const plan = {
    mode: options.get("--execute") === "1" ? "execute" : "plan",
    networkAccessed: false,
    catalogId: inputs.catalog.catalogId,
    catalogSha256: inputs.catalogSha256,
    recoveryBindingSha256: inputs.bindingDigest,
    readiness: inputs.catalog.readiness.status,
    sourceFiles: inputs.sourceManifest.fileCount,
    publicAssetFiles: inputs.publicManifest.fileCount,
    userAssetFiles: inputs.userInventory.fileCount,
    databaseBackupId: inputs.catalog.databaseBackup.backupId,
    finalRoot: path.join(inputs.outputRoot, inputs.catalog.catalogId),
  };
  if (options.get("--execute") !== "1") return plan;
  return { ...plan, ...exportBundle(inputs, options.get("--confirm")) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    console.log(JSON.stringify(runExportCli(), null, 2));
  } catch (error) {
    console.error(`RECOVERY_EXPORT_FAILED:${error instanceof Error ? error.message : String(error)}`);
    process.exit(error?.exitCode || 2);
  }
}
