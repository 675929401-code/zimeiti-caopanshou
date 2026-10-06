#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_RECEIPT_BYTES = 64 * 1024;
const PUBLISHER_ID = "publish-public-assets-cos-vnext";
const PUBLISHER_PROTOCOL_VERSION = 1;
const REMOTE_VERIFICATION = "head-content-type-cache-control-metadata-sha256-and-full-body-sha256";
const OVERWRITE_PROTOCOL = "put-object-forbid-overwrite";
const PUBLICATION_ORDER = "assets-then-manifest-then-ready";
const LOCAL_DISK_ISSUER = "materialize-public-asset-release-vnext";
const LOCAL_DISK_ISSUER_VERSION = 1;
const BUNDLE_RECEIPT_PATH = ".release/public-assets.bundle.v1.json";
const COS_READY_RECEIPT_PATH = ".release/public-assets.cos.ready.v1.json";

const allowedOptions = new Set([
  "--source-root",
  "--policy",
  "--manifest",
  "--releases-root",
  "--mode",
  "--location",
  "--receipt",
  "--execute",
  "--confirm",
]);
const flagOptions = new Set(["--execute"]);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--") || !allowedOptions.has(argument)) throw new Error(`unknown or positional option: ${argument}`);
  if (options.has(argument)) throw new Error(`duplicate option: ${argument}`);
  if (flagOptions.has(argument)) {
    options.set(argument, "1");
    continue;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${argument} requires a value`);
  options.set(argument, next);
  index += 1;
}

function fail(message) {
  throw new Error(message);
}

function normalize(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fsyncFile(filePath) {
  // Windows rejects FlushFileBuffers on a read-only handle even for a regular
  // file. These are materialized output files, so use a writable handle there;
  // Linux keeps the narrower read-only descriptor.
  const descriptor = fs.openSync(filePath, process.platform === "win32" ? "r+" : "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EBADF", "EINVAL", "EISDIR", "EPERM"].includes(error?.code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function makeReadOnlyAndFsync(filePath) {
  // On Windows chmod(0444) prevents reopening with the writable handle that
  // FlushFileBuffers requires. The file was already fsynced by writeBuffer;
  // flush once more before chmod there. Linux can flush after chmod normally.
  if (process.platform === "win32") fsyncFile(filePath);
  fs.chmodSync(filePath, 0o444);
  if (process.platform !== "win32") fsyncFile(filePath);
}

function assertNoSymlinkComponents(anchor, target, { allowMissing = false } = {}) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedAnchor, resolvedTarget)) fail(`path escapes trusted anchor: ${resolvedTarget}`);
  const anchorStats = fs.lstatSync(resolvedAnchor);
  if (!anchorStats.isDirectory() || anchorStats.isSymbolicLink()) fail(`trusted anchor is not a real directory: ${resolvedAnchor}`);
  let current = resolvedAnchor;
  const relative = path.relative(resolvedAnchor, resolvedTarget);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (allowMissing) return;
      fail(`missing path component: ${current}`);
    }
    if (fs.lstatSync(current).isSymbolicLink()) fail(`symbolic links are forbidden: ${current}`);
  }
}

function resolveTrustedFile(root, candidate, label) {
  const resolved = path.resolve(root, candidate);
  if (!isInside(root, resolved)) fail(`${label} must remain inside the source root`);
  assertNoSymlinkComponents(root, resolved);
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a real file: ${resolved}`);
  return resolved;
}

function validateCanonicalRoot(value, label) {
  if (typeof value !== "string" || value !== normalize(value) || value.includes("\\") || value.includes("\0")) {
    fail(`${label} is not a canonical forward-slash path`);
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts[0] !== "public" || parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${label} is invalid: ${value}`);
  }
  return value;
}

function validateLogicalDirectory(value, label) {
  if (typeof value !== "string" || value !== normalize(value) || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) {
    fail(`${label} is not a canonical relative directory`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) fail(`${label} contains an unsafe path segment`);
  return value;
}

function pathMatchesRoot(relativePath, rootPath) {
  return relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function validateManifest(policy, manifest, manifestBytes) {
  if (!policy || policy.schemaVersion !== 1 || typeof policy.projectId !== "string" || !policy.assets) {
    fail("release policy identity or assets contract is invalid");
  }
  const allowedRoots = (policy.assets.externalRoots || []).map((entry, index) => validateCanonicalRoot(entry, `externalRoots[${index}]`));
  const forbiddenRoots = (policy.assets.forbiddenPublicRoots || []).map((entry, index) => validateCanonicalRoot(entry, `forbiddenPublicRoots[${index}]`));
  if (allowedRoots.length === 0) fail("release policy has no external asset roots");
  const assetPolicySha256 = sha256Buffer(Buffer.from(stableJson({
    schemaVersion: policy.schemaVersion,
    projectId: policy.projectId,
    assets: policy.assets,
  }), "utf8"));
  if (
    !manifest
    || manifest.schemaVersion !== 1
    || manifest.projectId !== policy.projectId
    || manifest.kind !== "public-assets"
    || manifest.contentAddressing !== "sha256-files-and-asset-policy"
    || manifest.mutableUploadsIncluded !== false
    || manifest.assetPolicySha256 !== assetPolicySha256
    || !Array.isArray(manifest.files)
  ) fail("asset manifest identity or current policy binding is invalid");

  const exactSeen = new Set();
  const portableSeen = new Set();
  let previousPath = "";
  let totalBytes = 0;
  let canonicalFiles = "";
  for (const [index, file] of manifest.files.entries()) {
    const relativePath = String(file?.path || "");
    if (
      relativePath !== normalize(relativePath)
      || relativePath.includes("\\")
      || relativePath.includes("\0")
      || path.posix.isAbsolute(relativePath)
    ) fail(`asset manifest path is not canonical at index ${index}: ${relativePath}`);
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) fail(`unsafe asset path segment: ${relativePath}`);
    if (!allowedRoots.some((entry) => pathMatchesRoot(relativePath, entry))) {
      fail(`asset manifest path is outside the production allowlist: ${relativePath}`);
    }
    if (forbiddenRoots.some((entry) => pathMatchesRoot(relativePath, entry))) {
      fail(`asset manifest path is inside a forbidden public root: ${relativePath}`);
    }
    const portableKey = relativePath.toLocaleLowerCase("en");
    if (exactSeen.has(relativePath) || portableSeen.has(portableKey)) fail(`duplicate or portable path collision: ${relativePath}`);
    if (previousPath && previousPath.localeCompare(relativePath, "en") >= 0) fail("asset manifest paths are not canonically sorted");
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/u.test(String(file.sha256 || ""))) {
      fail(`asset manifest file metadata is invalid: ${relativePath}`);
    }
    exactSeen.add(relativePath);
    portableSeen.add(portableKey);
    previousPath = relativePath;
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) fail("asset manifest totalBytes exceeds the safe integer range");
    canonicalFiles += `${file.sha256}  ${relativePath}\n`;
  }
  const calculatedDigest = sha256Buffer(Buffer.from(`asset-policy-sha256  ${assetPolicySha256}\n${canonicalFiles}`, "utf8"));
  if (
    !/^[0-9a-f]{64}$/u.test(String(manifest.digest || ""))
    || calculatedDigest !== manifest.digest
    || manifest.assetVersion !== `sha256-${calculatedDigest}`
    || manifest.fileCount !== manifest.files.length
    || manifest.totalBytes !== totalBytes
  ) fail("asset manifest digest, count or byte total is invalid");
  for (const requiredPath of policy.assets.requiredPaths || []) {
    const canonicalRequired = validateCanonicalRoot(requiredPath, "required asset path");
    if (!exactSeen.has(canonicalRequired)) fail(`required asset is missing from manifest: ${canonicalRequired}`);
  }
  return {
    assetPolicySha256,
    manifestSha256: sha256Buffer(manifestBytes),
    totalBytes,
    binaryExtensions: new Set((policy.assets.binaryExtensions || []).map((entry) => String(entry).toLowerCase())),
  };
}

function validateCosLocation(value, assetVersion) {
  if (
    typeof value !== "string"
    || !/^cos:\/\/[^/]+\/.+/u.test(value)
    || value.includes("\\")
    || value.includes("%")
    || /[\u0000-\u001f\u007f?#]/u.test(value)
  ) fail("COS materialization requires a canonical --location cos://<bucket>/<prefix>");
  const withoutScheme = value.slice("cos://".length);
  const slashIndex = withoutScheme.indexOf("/");
  const bucket = withoutScheme.slice(0, slashIndex);
  const key = withoutScheme.slice(slashIndex + 1);
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(bucket)) fail("COS receipt bucket is not canonical");
  const segments = key.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("COS receipt prefix contains an unsafe segment");
  if (segments.at(-1) !== assetVersion) fail("COS receipt location is not bound to the manifest assetVersion");
  return value;
}

function writeBuffer(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const descriptor = fs.openSync(filePath, "wx", 0o644);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validatePublisherReceipt(receipt, manifest, assetPolicySha256, manifestSha256, remoteLocation, publisherScriptSha256) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("asset readiness receipt must be a JSON object");
  const expected = {
    schemaVersion: 1,
    projectId: manifest.projectId,
    kind: "public-assets-readiness-receipt",
    status: "READY",
    assetVersion: manifest.assetVersion,
    assetDigest: manifest.digest,
    assetPolicySha256,
    manifestSha256,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    mutableUploadsIncluded: false,
    verificationMode: "full-sha256",
    storageBackend: "cos",
    location: remoteLocation,
    publisherId: PUBLISHER_ID,
    publisherProtocolVersion: PUBLISHER_PROTOCOL_VERSION,
    publisherScriptSha256,
    remoteVerification: REMOTE_VERIFICATION,
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol: OVERWRITE_PROTOCOL,
    publicationOrder: PUBLICATION_ORDER,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) fail(`asset readiness receipt mismatch: ${field}`);
  }
  if (typeof receipt.verifiedAt !== "string" || Number.isNaN(Date.parse(receipt.verifiedAt))) {
    fail("asset readiness receipt verifiedAt is invalid");
  }
}

function validateTransportReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) fail("asset transport receipt must be a JSON object");
  for (const [field, value] of Object.entries(expected)) {
    if (receipt[field] !== value) fail(`asset transport receipt mismatch: ${field}`);
  }
  if (typeof receipt.verifiedAt !== "string" || Number.isNaN(Date.parse(receipt.verifiedAt))) {
    fail("asset transport receipt verifiedAt is invalid");
  }
}

function readReceipt(receiptPath) {
  const stats = fs.lstatSync(receiptPath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0 || stats.size > MAX_RECEIPT_BYTES) {
    fail(`asset readiness receipt is unsafe or exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  const bytes = fs.readFileSync(receiptPath);
  if (bytes.length !== stats.size || bytes.length > MAX_RECEIPT_BYTES) fail("asset readiness receipt changed while being read");
  return { bytes, receipt: JSON.parse(bytes.toString("utf8")) };
}

const sourceRoot = path.resolve(options.get("--source-root") || process.cwd());
if (!fs.existsSync(sourceRoot)) fail(`source root does not exist: ${sourceRoot}`);
assertNoSymlinkComponents(path.parse(sourceRoot).root, sourceRoot);
const sourceStats = fs.lstatSync(sourceRoot);
if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) fail("source root must be a real directory");
const policyPath = resolveTrustedFile(sourceRoot, options.get("--policy") || "deploy/policies/release-policy.json", "release policy");
const manifestPath = resolveTrustedFile(sourceRoot, options.get("--manifest") || "deploy/manifests/public-assets.v1.json", "asset manifest");
const releasesRoot = path.resolve(options.get("--releases-root") || path.join(sourceRoot, "dist", "asset-releases"));
const mode = options.get("--mode") || "disk";
const execute = options.get("--execute") === "1";
if (!["disk", "cos"].includes(mode)) fail("--mode must be disk or cos");
if (path.parse(releasesRoot).root === releasesRoot) fail("asset releases root cannot be a filesystem root");
if (releasesRoot === sourceRoot || isInside(releasesRoot, sourceRoot)) fail("asset releases root cannot contain the source root");
assertNoSymlinkComponents(path.parse(releasesRoot).root, releasesRoot, { allowMissing: true });

const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const { assetPolicySha256, manifestSha256, binaryExtensions } = validateManifest(policy, manifest, manifestBytes);
const selectedFiles = manifest.files.filter((file) => mode === "disk" || !binaryExtensions.has(path.extname(file.path).toLowerCase()));
const selectedBytes = selectedFiles.reduce((total, file) => total + file.bytes, 0);
const finalRoot = path.join(releasesRoot, manifest.assetVersion);
const logicalLocation = `${validateLogicalDirectory(policy.assets.releaseDirectory, "asset releaseDirectory")}/${manifest.assetVersion}`;
let remoteLocation = null;
if (mode === "cos") {
  remoteLocation = validateCosLocation(options.get("--location") || "", manifest.assetVersion);
} else if (options.has("--location") && options.get("--location") !== logicalLocation) {
  fail(`disk transport location must equal the stable policy target ${logicalLocation}`);
}

const publisherPath = resolveTrustedFile(sourceRoot, "scripts/publish-public-assets-cos-vnext.mjs", "COS publisher");
const publisherScriptSha256 = sha256File(publisherPath);
let publisherReceipt = null;
let publisherReceiptBytes = null;
if (mode === "cos") {
  const receiptOption = options.get("--receipt");
  if (!receiptOption) fail("COS materialization requires the downloaded publisher READY receipt via --receipt");
  const receiptPath = resolveTrustedFile(sourceRoot, receiptOption, "COS readiness receipt");
  ({ bytes: publisherReceiptBytes, receipt: publisherReceipt } = readReceipt(receiptPath));
  validatePublisherReceipt(publisherReceipt, manifest, assetPolicySha256, manifestSha256, remoteLocation, publisherScriptSha256);
}
const transportContract = {
  schemaVersion: 1,
  projectId: manifest.projectId,
  kind: "public-assets-transport-receipt",
  status: "VERIFIED",
  assetVersion: manifest.assetVersion,
  assetDigest: manifest.digest,
  assetPolicySha256,
  manifestSha256,
  fileCount: manifest.fileCount,
  totalBytes: manifest.totalBytes,
  transportFileCount: selectedFiles.length,
  transportBytes: selectedBytes,
  mutableUploadsIncluded: false,
  verificationMode: "full-sha256",
  storageBackend: mode,
  location: logicalLocation,
  issuerId: LOCAL_DISK_ISSUER,
  issuerProtocolVersion: LOCAL_DISK_ISSUER_VERSION,
  ...(mode === "cos" ? {
    remoteLocation,
    publisherReadyReceiptPath: COS_READY_RECEIPT_PATH,
    publisherReadyReceiptSha256: sha256Buffer(publisherReceiptBytes),
    publisherId: PUBLISHER_ID,
    publisherProtocolVersion: PUBLISHER_PROTOCOL_VERSION,
    publisherScriptSha256,
    remoteVerification: REMOTE_VERIFICATION,
    remoteVerifiedFileCount: manifest.fileCount,
    remoteVerifiedTotalBytes: manifest.totalBytes,
    remoteContentTypeVerified: true,
    remoteCacheControlVerified: true,
    overwriteProtocol: OVERWRITE_PROTOCOL,
    publicationOrder: PUBLICATION_ORDER,
  } : {}),
};
const transportReceipt = { ...transportContract, verifiedAt: new Date().toISOString() };
const transportReceiptBytes = Buffer.from(`${JSON.stringify(transportReceipt, null, 2)}\n`, "utf8");
if (transportReceiptBytes.length <= 0 || transportReceiptBytes.length > MAX_RECEIPT_BYTES) fail("generated transport receipt has an invalid size");

console.log(JSON.stringify({
  mode: execute ? "execute" : "plan",
  storageBackend: mode,
  assetVersion: manifest.assetVersion,
  assetPolicySha256,
  manifestSha256,
  manifestFiles: manifest.fileCount,
  manifestBytes: manifest.totalBytes,
  locallyMaterializedFiles: selectedFiles.length,
  locallyMaterializedBytes: selectedBytes,
  heavyFilesRemoteOnly: mode === "cos" ? manifest.fileCount - selectedFiles.length : 0,
  transportReceipt: BUNDLE_RECEIPT_PATH,
  logicalLocation,
  ...(remoteLocation ? { remoteLocation } : {}),
  finalRoot,
  currentPointerChanged: false,
}, null, 2));
if (!execute) process.exit(0);
if (options.get("--confirm") !== manifest.assetVersion) fail(`--confirm must equal ${manifest.assetVersion}`);

if (!fs.existsSync(releasesRoot)) fs.mkdirSync(releasesRoot, { recursive: true });
assertNoSymlinkComponents(path.parse(releasesRoot).root, releasesRoot);
const releasesStats = fs.lstatSync(releasesRoot);
if (!releasesStats.isDirectory() || releasesStats.isSymbolicLink()) fail("asset releases root must be a real directory");
const resolvedReleasesRoot = fs.realpathSync(releasesRoot);
const resolvedFinalRoot = path.join(resolvedReleasesRoot, manifest.assetVersion);
if (!isInside(resolvedReleasesRoot, resolvedFinalRoot)) fail("asset release target escaped releases root");

const expectedFileSet = new Set([
  ...selectedFiles.map((file) => file.path),
  ".release/public-assets.v1.json",
  BUNDLE_RECEIPT_PATH,
  ...(mode === "cos" ? [COS_READY_RECEIPT_PATH] : []),
]);
const expectedDirectorySet = new Set([""]);
for (const filePath of expectedFileSet) {
  const parts = filePath.split("/");
  for (let index = 1; index < parts.length; index += 1) expectedDirectorySet.add(parts.slice(0, index).join("/"));
}

function verifyExactInventory(releaseRoot) {
  const walk = (directoryPath) => {
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const absolutePath = path.join(directoryPath, entry.name);
      const stats = fs.lstatSync(absolutePath);
      const relativePath = normalize(path.relative(releaseRoot, absolutePath));
      if (stats.isSymbolicLink()) fail(`materialized release contains a symbolic link: ${relativePath}`);
      if (stats.isDirectory()) {
        if (!expectedDirectorySet.has(relativePath)) fail(`materialized release contains an unexpected directory: ${relativePath}`);
        walk(absolutePath);
      } else if (!stats.isFile() || !expectedFileSet.has(relativePath)) {
        fail(`materialized release contains an unexpected entry: ${relativePath}`);
      }
    }
  };
  walk(releaseRoot);
}

function verifyMaterializedRelease(releaseRoot) {
  assertNoSymlinkComponents(path.parse(releaseRoot).root, releaseRoot);
  const localManifest = path.join(releaseRoot, ".release", "public-assets.v1.json");
  const localTransportReceipt = path.join(releaseRoot, ...BUNDLE_RECEIPT_PATH.split("/"));
  const manifestStats = fs.lstatSync(localManifest);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || sha256File(localManifest) !== manifestSha256) {
    fail("materialized manifest does not match source manifest");
  }
  const { receipt: parsedTransportReceipt } = readReceipt(localTransportReceipt);
  validateTransportReceipt(parsedTransportReceipt, transportContract);
  if (mode === "cos") {
    const localPublisherReceipt = path.join(releaseRoot, ...COS_READY_RECEIPT_PATH.split("/"));
    const { bytes: localPublisherBytes, receipt: parsedPublisherReceipt } = readReceipt(localPublisherReceipt);
    if (sha256Buffer(localPublisherBytes) !== transportContract.publisherReadyReceiptSha256) {
      fail("preserved COS publisher receipt does not match the transport receipt");
    }
    validatePublisherReceipt(
      parsedPublisherReceipt,
      manifest,
      assetPolicySha256,
      manifestSha256,
      remoteLocation,
      publisherScriptSha256,
    );
  }
  for (const file of selectedFiles) {
    const filePath = path.resolve(releaseRoot, ...file.path.split("/"));
    if (!isInside(releaseRoot, filePath)) fail(`materialized file escaped release root: ${file.path}`);
    assertNoSymlinkComponents(releaseRoot, filePath);
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes || sha256File(filePath) !== file.sha256) {
      fail(`materialized file verification failed: ${file.path}`);
    }
  }
  verifyExactInventory(releaseRoot);
}

if (fs.existsSync(resolvedFinalRoot)) {
  const stats = fs.lstatSync(resolvedFinalRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) fail("existing asset release is not a real directory");
  verifyMaterializedRelease(resolvedFinalRoot);
  console.log(JSON.stringify({ ok: true, reused: true, finalRoot: resolvedFinalRoot, currentPointerChanged: false }, null, 2));
  process.exit(0);
}

const stagingRoot = path.join(resolvedReleasesRoot, `.staging-${manifest.assetVersion}-${process.pid}-${crypto.randomUUID()}`);
if (!isInside(resolvedReleasesRoot, stagingRoot) || !path.basename(stagingRoot).startsWith(".staging-sha256-")) fail("unsafe asset staging path");
fs.mkdirSync(stagingRoot, { recursive: false });
fsyncDirectory(resolvedReleasesRoot);
try {
  for (const file of selectedFiles) {
    const relativePath = file.path;
    const sourcePath = path.resolve(sourceRoot, ...relativePath.split("/"));
    if (!isInside(sourceRoot, sourcePath)) fail(`source asset escaped root: ${relativePath}`);
    assertNoSymlinkComponents(sourceRoot, sourcePath);
    const sourceStats = fs.lstatSync(sourcePath);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink() || sourceStats.size !== file.bytes || sha256File(sourcePath) !== file.sha256) {
      fail(`source asset verification failed: ${relativePath}`);
    }
    const destinationPath = path.resolve(stagingRoot, ...relativePath.split("/"));
    if (!isInside(stagingRoot, destinationPath)) fail(`destination asset escaped staging root: ${relativePath}`);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    assertNoSymlinkComponents(stagingRoot, path.dirname(destinationPath));
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    fsyncFile(destinationPath);
  }
  writeBuffer(path.join(stagingRoot, ".release", "public-assets.v1.json"), manifestBytes);
  writeBuffer(path.join(stagingRoot, ...BUNDLE_RECEIPT_PATH.split("/")), transportReceiptBytes);
  if (mode === "cos") writeBuffer(path.join(stagingRoot, ...COS_READY_RECEIPT_PATH.split("/")), publisherReceiptBytes);
  verifyMaterializedRelease(stagingRoot);
  const metadataManifest = path.join(stagingRoot, ".release", "public-assets.v1.json");
  const metadataReceipt = path.join(stagingRoot, ...BUNDLE_RECEIPT_PATH.split("/"));
  makeReadOnlyAndFsync(metadataManifest);
  makeReadOnlyAndFsync(metadataReceipt);
  if (mode === "cos") {
    const metadataPublisherReceipt = path.join(stagingRoot, ...COS_READY_RECEIPT_PATH.split("/"));
    makeReadOnlyAndFsync(metadataPublisherReceipt);
  }
  for (const relativeDirectory of [...expectedDirectorySet].sort((left, right) => right.split("/").length - left.split("/").length)) {
    fsyncDirectory(relativeDirectory ? path.join(stagingRoot, ...relativeDirectory.split("/")) : stagingRoot);
  }
  fs.renameSync(stagingRoot, resolvedFinalRoot);
  fsyncDirectory(resolvedReleasesRoot);
} catch (error) {
  if (fs.existsSync(stagingRoot) && isInside(resolvedReleasesRoot, stagingRoot)) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
  throw error;
}

verifyMaterializedRelease(resolvedFinalRoot);
console.log(JSON.stringify({ ok: true, reused: false, finalRoot: resolvedFinalRoot, currentPointerChanged: false }, null, 2));
