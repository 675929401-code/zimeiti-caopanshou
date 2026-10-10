#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROJECT_ID,
  USER_INVENTORY_SCHEMA,
  assertSafeRoot,
  canonicalObjectKey,
  canonicalRelativePath,
  exactKeys,
  loadTrustedIssuers,
  parseOptions,
  readJson,
  rejectSensitiveMetadata,
  resolveEntry,
  sha256Buffer,
  sha256File,
  stableJson,
  validatePublicManifest,
  validateReadyReceipt,
  validateUserInventory,
  verifyDetachedSignature,
} from "./recovery-export-v1.mjs";

const PLAN_SCHEMA = "zimeiti-coscli-recovery-plan.v1";
const DOWNLOAD_RECEIPT_SCHEMA = "zimeiti-coscli-download-receipt.v1";

function stop(message) {
  const error = new Error(message);
  error.exitCode = 2;
  throw error;
}

function quotePowerShell(value) {
  if (/[\r\n\0]/u.test(value)) stop("unsafe PowerShell command value");
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteBash(value) {
  if (/[\r\n\0]/u.test(value)) stop("unsafe Bash command value");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function splitCosLocation(location) {
  if (typeof location !== "string" || !location.startsWith("cos://") || location.includes("?") || location.includes("#")) stop("READY receipt COS location is invalid");
  const slash = location.indexOf("/", "cos://".length);
  if (slash < 0) stop("READY receipt COS prefix is missing");
  return { bucket: location.slice("cos://".length, slash), prefix: canonicalObjectKey(location.slice(slash + 1), "READY receipt prefix") };
}

function makeCommands(item) {
  const bucketEnvironment = item.class === "public-assets" ? "RECOVERY_PUBLIC_COS_BUCKET" : "RECOVERY_USER_COS_BUCKET";
  const keyLiteral = quotePowerShell(`/${item.objectKey}`);
  const relativeLiteral = quotePowerShell(item.relativePath.replaceAll("/", path.sep));
  const versionArgument = item.versionKind === "cos-version-id" ? ` --version-id ${quotePowerShell(item.expectedVersion)}` : "";
  const windowsPowerShell = `& $env:COSCLI_EXE cp ('cos://' + $env:${bucketEnvironment} + ${keyLiteral}) (Join-Path $env:RECOVERY_DOWNLOAD_ROOT ${relativeLiteral}) --config-path $env:COSCLI_CONFIG_PATH${versionArgument}`;
  const bashKey = quoteBash(`/${item.objectKey}`);
  const bashPath = quoteBash(`/${item.relativePath}`);
  const bashVersion = item.versionKind === "cos-version-id" ? ` --version-id ${quoteBash(item.expectedVersion)}` : "";
  const linuxBash = `"\${COSCLI_EXE}" cp "cos://\${${bucketEnvironment}}"${bashKey} "\${RECOVERY_DOWNLOAD_ROOT}"${bashPath} --config-path "\${COSCLI_CONFIG_PATH}"${bashVersion}`;
  return { windowsPowerShell, linuxBash };
}

function buildPlan(options, environmentVariables = process.env) {
  for (const name of ["public-manifest", "public-ready-receipt", "user-inventory", "source-version", "git-commit", "catalog-binding", "environment"]) {
    if (!options.get(`--${name}`)) stop(`--${name} is required`);
  }
  const publicPath = assertSafeRoot(options.get("--public-manifest"), "public asset manifest");
  const readyPath = assertSafeRoot(options.get("--public-ready-receipt"), "public asset READY receipt");
  const userPath = assertSafeRoot(options.get("--user-inventory"), "user object inventory");
  const publicDocument = readJson(publicPath, "public asset manifest");
  const readyDocument = readJson(readyPath, "public asset READY receipt");
  const userDocument = readJson(userPath, "user object inventory");
  const publicManifest = validatePublicManifest(publicDocument.value);
  const publicManifestSha256 = sha256Buffer(publicDocument.bytes);
  const ready = validateReadyReceipt(readyDocument.value, publicManifest, publicManifestSha256);
  const sourceVersion = options.get("--source-version");
  const recoveryEnvironment = options.get("--environment");
  const gitCommit = options.get("--git-commit");
  const catalogBindingSha256 = options.get("--catalog-binding");
  if (!/^[a-f0-9]{40}$/u.test(gitCommit) || !/^[a-f0-9]{64}$/u.test(catalogBindingSha256)) stop("COS plan commit or catalog binding is invalid");
  const userInventory = validateUserInventory(userDocument.value, sourceVersion, recoveryEnvironment);
  const trust = loadTrustedIssuers(options.get("--trusted-issuers"), recoveryEnvironment);
  let trustStatus = "BLOCKED";
  if (trust.trusted) {
    if (!options.get("--public-signature") || !options.get("--user-signature")) stop("trusted COS plan requires public READY and user inventory detached signatures");
    const expectedIdentity = { environment: recoveryEnvironment, catalogBindingSha256, gitCommit, assetVersion: publicManifest.assetVersion, databaseIdentity: userInventory.databaseIdentity, accountId: userInventory.accountId, tenantId: userInventory.tenantId };
    const replayState = { receiptIds: new Set(), nonces: new Set() };
    verifyDetachedSignature(assertSafeRoot(options.get("--public-signature"), "public READY detached signature"), readyDocument.bytes, { ...expectedIdentity, evidenceType: "public-ready" }, trust, replayState);
    verifyDetachedSignature(assertSafeRoot(options.get("--user-signature"), "user inventory detached signature"), userDocument.bytes, { ...expectedIdentity, evidenceType: "user-inventory" }, trust, replayState);
    trustStatus = "TRUSTED";
  }
  const { bucket: publicBucket, prefix } = splitCosLocation(ready.location);
  const requiredEnvironment = {
    RECOVERY_PUBLIC_COS_BUCKET: publicBucket,
    RECOVERY_USER_COS_BUCKET: userInventory.bucket,
    RECOVERY_USER_ACCOUNT_ID: userInventory.accountId,
    RECOVERY_USER_TENANT_ID: userInventory.tenantId,
    RECOVERY_USER_REGION: userInventory.region,
    RECOVERY_USER_OWNER_ID: userInventory.ownerId,
    RECOVERY_DATABASE_IDENTITY: userInventory.databaseIdentity,
  };
  for (const [name, expected] of Object.entries(requiredEnvironment)) {
    if (String(environmentVariables[name] || "") !== expected) stop(`recovery environment identity mismatch: ${name}`);
  }
  const items = [
    ...publicManifest.files.map((file) => ({
      class: "public-assets",
      bucket: publicBucket,
      relativePath: `public-assets/${file.path}`,
      objectKey: `${prefix}/${file.path}`,
      expectedVersion: publicManifest.assetVersion,
      versionKind: "immutable-release-prefix",
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    ...userInventory.files.map((file) => ({
      class: "user-assets",
      bucket: userInventory.bucket,
      relativePath: `user-assets/${file.relativePath}`,
      objectKey: file.objectKey,
      expectedVersion: file.versionId,
      versionKind: "cos-version-id",
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  ];
  const exactPaths = new Set();
  const objectVersions = new Set();
  for (const item of items) {
    canonicalRelativePath(item.relativePath, "COS plan relativePath");
    canonicalObjectKey(item.objectKey, "COS plan objectKey");
    const folded = item.relativePath.toLocaleLowerCase("en-US");
    const objectVersion = `${item.objectKey}\0${item.expectedVersion}`;
    if (exactPaths.has(folded) || objectVersions.has(objectVersion)) stop("COS plan contains a duplicate path or object version");
    exactPaths.add(folded);
    objectVersions.add(objectVersion);
  }
  items.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
  const binding = {
    projectId: PROJECT_ID,
    environment: recoveryEnvironment,
    gitCommit,
    catalogBindingSha256,
    sourceVersion,
    publicManifestSha256,
    publicReadyReceiptSha256: sha256Buffer(readyDocument.bytes),
    userInventorySha256: sha256Buffer(userDocument.bytes),
    userStorageIdentity: {
      bucket: userInventory.bucket,
      accountId: userInventory.accountId,
      tenantId: userInventory.tenantId,
      region: userInventory.region,
      ownerId: userInventory.ownerId,
      databaseIdentity: userInventory.databaseIdentity,
    },
    items: items.map(({ class: itemClass, bucket, relativePath, objectKey, expectedVersion, versionKind, bytes, sha256 }) => ({
      class: itemClass, bucket, relativePath, objectKey, expectedVersion, versionKind, bytes, sha256,
    })),
  };
  const planSha256 = sha256Buffer(Buffer.from(stableJson(binding), "utf8"));
  const plan = {
    schemaVersion: PLAN_SCHEMA,
    projectId: PROJECT_ID,
    environment: recoveryEnvironment,
    gitCommit,
    catalogBindingSha256,
    status: trustStatus === "TRUSTED" ? "PLAN_ONLY" : "BLOCKED_PLAN_ONLY",
    trustStatus,
    networkAccessed: false,
    executesCoscli: false,
    authMaterialPersisted: false,
    sourceVersion,
    publicManifestSha256,
    publicReadyReceiptSha256: sha256Buffer(readyDocument.bytes),
    userInventorySchemaVersion: USER_INVENTORY_SCHEMA,
    userInventorySha256: sha256Buffer(userDocument.bytes),
    publicBucket,
    userStorageIdentity: binding.userStorageIdentity,
    planSha256,
    environmentPlaceholders: [
      "COSCLI_EXE", "COSCLI_CONFIG_PATH", "RECOVERY_PUBLIC_COS_BUCKET", "RECOVERY_USER_COS_BUCKET", "RECOVERY_USER_ACCOUNT_ID",
      "RECOVERY_USER_TENANT_ID", "RECOVERY_USER_REGION", "RECOVERY_USER_OWNER_ID", "RECOVERY_DATABASE_IDENTITY", "RECOVERY_DOWNLOAD_ROOT",
    ],
    itemCount: items.length,
    totalBytes: items.reduce((total, item) => total + item.bytes, 0),
    items: items.map((item) => ({ ...item, commands: makeCommands(item) })),
  };
  rejectSensitiveMetadata(plan, "COSCLI recovery plan");
  return { plan, planSha256, items, publicManifest, userInventory };
}

function verifyDownloaded(planResult, rootInput, receiptInput, signatureInput, trustedIssuersInput) {
  const root = assertSafeRoot(rootInput, "COSCLI download root");
  const receiptPath = assertSafeRoot(receiptInput, "COSCLI download receipt");
  const receiptDocument = readJson(receiptPath, "COSCLI download receipt");
  const { value: receipt } = receiptDocument;
  exactKeys(receipt, ["schemaVersion", "projectId", "status", "planSha256", "networkTool", "publicBucket", "userStorageIdentity", "items"], [], "COSCLI download receipt");
  rejectSensitiveMetadata(receipt, "COSCLI download receipt");
  if (receipt.schemaVersion !== DOWNLOAD_RECEIPT_SCHEMA || receipt.projectId !== PROJECT_ID || receipt.status !== "complete"
    || receipt.planSha256 !== planResult.planSha256 || receipt.networkTool !== "official-coscli"
    || receipt.publicBucket !== planResult.plan.publicBucket || stableJson(receipt.userStorageIdentity) !== stableJson(planResult.plan.userStorageIdentity)
    || !Array.isArray(receipt.items)
    || receipt.items.length !== planResult.items.length) stop("COSCLI download receipt identity is invalid");
  const expected = new Map(planResult.items.map((item) => [item.relativePath, item]));
  for (const [index, entry] of receipt.items.entries()) {
    exactKeys(entry, ["bucket", "relativePath", "objectKey", "observedVersion", "bytes", "sha256"], [], `download receipt item ${index}`);
    const relative = canonicalRelativePath(entry.relativePath, "download receipt relativePath");
    const item = expected.get(relative);
    if (!item) stop(`download receipt contains an unexpected path: ${relative}`);
    if (entry.bucket !== item.bucket || entry.objectKey !== item.objectKey || entry.observedVersion !== item.expectedVersion || entry.bytes !== item.bytes || entry.sha256 !== item.sha256) {
      stop(`download receipt object/version/size/hash mismatch: ${relative}`);
    }
    const downloaded = resolveEntry(root, relative, `downloaded file ${relative}`);
    const stats = fs.lstatSync(downloaded);
    if (stats.size !== item.bytes || sha256File(downloaded) !== item.sha256) stop(`downloaded file size/hash mismatch: ${relative}`);
    expected.delete(relative);
  }
  if (expected.size !== 0) stop("COSCLI download receipt is incomplete");
  const trust = loadTrustedIssuers(trustedIssuersInput, planResult.plan.environment);
  const signaturePath = assertSafeRoot(signatureInput, "COSCLI download detached signature");
  verifyDetachedSignature(signaturePath, receiptDocument.bytes, {
    environment: planResult.plan.environment,
    evidenceType: "cos-download",
    catalogBindingSha256: planResult.plan.catalogBindingSha256,
    gitCommit: planResult.plan.gitCommit,
    assetVersion: planResult.publicManifest.assetVersion,
    databaseIdentity: planResult.userInventory.databaseIdentity,
    accountId: planResult.userInventory.accountId,
    tenantId: planResult.userInventory.tenantId,
  }, trust);
  return { verified: true, verifiedItems: planResult.items.length, detachedSignatureVerified: true };
}

function writePlan(outputPathInput, plan, confirm) {
  if (confirm !== plan.planSha256) stop(`--confirm must equal plan SHA-256 ${plan.planSha256}`);
  const outputPath = path.resolve(outputPathInput);
  assertSafeRoot(path.dirname(outputPath), "COSCLI plan output directory");
  if (fs.existsSync(outputPath)) stop("COSCLI plan output already exists");
  const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
  const stagingPath = path.join(path.dirname(outputPath), `.staging-${path.basename(outputPath)}-${process.pid}-${crypto.randomUUID()}`);
  const descriptor = fs.openSync(stagingPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (fs.existsSync(outputPath)) stop("COSCLI plan output appeared before atomic commit");
  if (process.platform !== "win32") stop("COSCLI plan write requires an OS no-replace rename primitive; this implementation is Windows fail-closed");
  fs.renameSync(stagingPath, outputPath);
  let parentDescriptor;
  try { parentDescriptor = fs.openSync(path.dirname(outputPath), "r"); fs.fsyncSync(parentDescriptor); } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally { if (parentDescriptor !== undefined) fs.closeSync(parentDescriptor); }
  return { outputPath, outputSha256: sha256File(outputPath) };
}

export function runCosPlanCli(argv = process.argv) {
  const options = parseOptions(argv);
  const result = buildPlan(options);
  let verification = null;
  const downloadRoot = options.get("--download-root");
  const downloadReceipt = options.get("--download-receipt");
  const downloadSignature = options.get("--download-signature");
  const trustedIssuers = options.get("--trusted-issuers");
  if ([downloadRoot, downloadReceipt, downloadSignature].some(Boolean)
    && ![downloadRoot, downloadReceipt, downloadSignature, trustedIssuers].every(Boolean)) stop("download verification requires root, receipt, detached signature, and trusted issuers together");
  if (downloadRoot) verification = verifyDownloaded(result, downloadRoot, downloadReceipt, downloadSignature, trustedIssuers);
  const summary = {
    mode: options.get("--execute") === "1" ? "write-plan" : "plan",
    networkAccessed: false,
    executesCoscli: false,
    planSha256: result.planSha256,
    itemCount: result.plan.itemCount,
    totalBytes: result.plan.totalBytes,
    verification,
  };
  if (options.get("--execute") !== "1") return { ...summary, plan: result.plan };
  if (!options.get("--output")) stop("--output is required with --execute");
  return { ...summary, ...writePlan(options.get("--output"), result.plan, options.get("--confirm")) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  try {
    console.log(JSON.stringify(runCosPlanCli(), null, 2));
  } catch (error) {
    console.error(`RECOVERY_COS_PLAN_FAILED:${error instanceof Error ? error.message : String(error)}`);
    process.exit(error?.exitCode || 2);
  }
}
