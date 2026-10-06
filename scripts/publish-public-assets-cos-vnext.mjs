#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

const MAX_CONCURRENCY = 12;
const DEFAULT_CONCURRENCY = 4;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RECEIPT_BYTES = 64 * 1024;
// cos-nodejs-sdk-v5 drops x-cos-forbid-overwrite from multipart-complete.
// Until a conditional multipart protocol is implemented, immutable publication
// is intentionally limited to single PUT objects.
const SINGLE_PUT_MAX_BYTES = 5 * 1024 * 1024;
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const METADATA_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const PUBLISHER_ID = "publish-public-assets-cos-vnext";
const PUBLISHER_PROTOCOL_VERSION = 1;
const REMOTE_VERIFICATION = "head-content-type-cache-control-metadata-sha256-and-full-body-sha256";
const OVERWRITE_PROTOCOL = "put-object-forbid-overwrite";
const PUBLICATION_ORDER = "assets-then-manifest-then-ready";

const allowedOptions = new Set([
  "--root",
  "--policy",
  "--manifest",
  "--prefix",
  "--concurrency",
  "--timeout-ms",
  "--execute",
  "--confirm",
  "--receipt-output",
]);
const flagOptions = new Set(["--execute"]);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--") || !allowedOptions.has(argument)) {
    console.error(`FAIL unknown or positional option: ${argument}`);
    process.exit(2);
  }
  if (options.has(argument)) {
    console.error(`FAIL duplicate option: ${argument}`);
    process.exit(2);
  }
  if (flagOptions.has(argument)) {
    options.set(argument, "1");
    continue;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    console.error(`FAIL ${argument} requires a value`);
    process.exit(2);
  }
  options.set(argument, next);
  index += 1;
}

function stop(message, code = 1) {
  console.error(`FAIL ${message}`);
  process.exit(code);
}

function parseSafeIntegerOption(name, fallback, minimum, maximum) {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) stop(`${name} must be a base-10 integer`, 2);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    stop(`${name} must be between ${minimum} and ${maximum}`, 2);
  }
  return value;
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

function assertNoSymlinkComponents(anchor, target, { allowMissing = false } = {}) {
  const resolvedAnchor = path.resolve(anchor);
  const resolvedTarget = path.resolve(target);
  if (!isInside(resolvedAnchor, resolvedTarget)) throw new Error(`path escapes trusted anchor: ${resolvedTarget}`);
  const anchorStats = fs.lstatSync(resolvedAnchor);
  if (!anchorStats.isDirectory() || anchorStats.isSymbolicLink()) throw new Error(`trusted anchor is not a real directory: ${resolvedAnchor}`);
  let current = resolvedAnchor;
  const relative = path.relative(resolvedAnchor, resolvedTarget);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) {
      if (allowMissing) return;
      throw new Error(`missing path component: ${current}`);
    }
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`symbolic links are forbidden: ${current}`);
  }
}

function resolveTrustedFile(root, candidate, label) {
  const resolved = path.resolve(root, candidate);
  if (!isInside(root, resolved)) stop(`${label} must remain inside the project root`, 2);
  try {
    assertNoSymlinkComponents(root, resolved);
  } catch (error) {
    stop(`${label} is unsafe: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  const stats = fs.lstatSync(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) stop(`${label} must be a real file: ${resolved}`, 2);
  return resolved;
}

function validateCanonicalRoot(value, label) {
  if (typeof value !== "string" || value !== normalize(value) || value.includes("\\") || value.includes("\0")) {
    stop(`${label} is not a canonical forward-slash path`, 2);
  }
  const parts = value.split("/");
  if (parts.length < 2 || parts[0] !== "public" || parts.some((part) => !part || part === "." || part === "..")) {
    stop(`${label} is invalid: ${value}`, 2);
  }
  return value;
}

function pathMatchesRoot(relativePath, rootPath) {
  return relativePath === rootPath || relativePath.startsWith(`${rootPath}/`);
}

function validateManifest(policy, manifest, manifestBytes) {
  if (!policy || policy.schemaVersion !== 1 || typeof policy.projectId !== "string" || !policy.assets) {
    stop("release policy identity or assets contract is invalid", 2);
  }
  const allowedRoots = (policy.assets.externalRoots || []).map((entry, index) => validateCanonicalRoot(entry, `externalRoots[${index}]`));
  const forbiddenRoots = (policy.assets.forbiddenPublicRoots || []).map((entry, index) => validateCanonicalRoot(entry, `forbiddenPublicRoots[${index}]`));
  if (allowedRoots.length === 0) stop("release policy has no external asset roots", 2);
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
  ) stop("asset manifest identity or current policy binding is invalid", 2);

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
    ) stop(`asset manifest path is not canonical at index ${index}: ${relativePath}`, 2);
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) stop(`unsafe asset path segment: ${relativePath}`, 2);
    if (!allowedRoots.some((entry) => pathMatchesRoot(relativePath, entry))) {
      stop(`asset manifest path is outside the production allowlist: ${relativePath}`, 2);
    }
    if (forbiddenRoots.some((entry) => pathMatchesRoot(relativePath, entry))) {
      stop(`asset manifest path is inside a forbidden public root: ${relativePath}`, 2);
    }
    const portableKey = relativePath.toLocaleLowerCase("en");
    if (exactSeen.has(relativePath) || portableSeen.has(portableKey)) stop(`duplicate or portable path collision: ${relativePath}`, 2);
    if (previousPath && previousPath.localeCompare(relativePath, "en") >= 0) stop("asset manifest paths are not canonically sorted", 2);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[0-9a-f]{64}$/u.test(String(file.sha256 || ""))) {
      stop(`asset manifest file metadata is invalid: ${relativePath}`, 2);
    }
    exactSeen.add(relativePath);
    portableSeen.add(portableKey);
    previousPath = relativePath;
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) stop("asset manifest totalBytes exceeds the safe integer range", 2);
    canonicalFiles += `${file.sha256}  ${relativePath}\n`;
  }
  const calculatedDigest = sha256Buffer(Buffer.from(`asset-policy-sha256  ${assetPolicySha256}\n${canonicalFiles}`, "utf8"));
  if (
    !/^[0-9a-f]{64}$/u.test(String(manifest.digest || ""))
    || calculatedDigest !== manifest.digest
    || manifest.assetVersion !== `sha256-${calculatedDigest}`
    || manifest.fileCount !== manifest.files.length
    || manifest.totalBytes !== totalBytes
  ) stop("asset manifest digest, count or byte total is invalid", 2);
  for (const requiredPath of policy.assets.requiredPaths || []) {
    const canonicalRequired = validateCanonicalRoot(requiredPath, "required asset path");
    if (!exactSeen.has(canonicalRequired)) stop(`required asset is missing from manifest: ${canonicalRequired}`, 2);
  }
  return { assetPolicySha256, manifestSha256: sha256Buffer(manifestBytes), totalBytes };
}

function validateKeyPrefix(value) {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) stop("--prefix must be a canonical relative COS key prefix", 2);
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) stop("--prefix contains an unsafe path segment", 2);
  return value;
}

const root = path.resolve(options.get("--root") || process.cwd());
if (!fs.existsSync(root)) stop(`project root does not exist: ${root}`, 2);
try {
  assertNoSymlinkComponents(path.parse(root).root, root);
} catch (error) {
  stop(`project root is unsafe: ${error instanceof Error ? error.message : String(error)}`, 2);
}
const rootStats = fs.lstatSync(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) stop("project root must be a real directory", 2);
const policyPath = resolveTrustedFile(root, options.get("--policy") || "deploy/policies/release-policy.json", "release policy");
const manifestPath = resolveTrustedFile(root, options.get("--manifest") || "deploy/manifests/public-assets.v1.json", "asset manifest");
const execute = options.get("--execute") === "1";
const concurrency = parseSafeIntegerOption("--concurrency", DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
const requestTimeoutMs = parseSafeIntegerOption("--timeout-ms", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const { assetPolicySha256, manifestSha256, totalBytes } = validateManifest(policy, manifest, manifestBytes);
const publisherScriptSha256 = sha256File(fileURLToPath(import.meta.url));
const keyPrefix = `${validateKeyPrefix(options.get("--prefix") || "assets/releases")}/${manifest.assetVersion}`;
const oversizedFiles = manifest.files.filter((file) => file.bytes > SINGLE_PUT_MAX_BYTES);

console.log(JSON.stringify({
  mode: execute ? "execute" : "plan",
  assetVersion: manifest.assetVersion,
  assetDigest: manifest.digest,
  assetPolicySha256,
  manifestSha256,
  publisherScriptSha256,
  files: manifest.files.length,
  totalBytes,
  keyPrefix,
  concurrency,
  requestTimeoutMs,
  immutable: true,
  mutableUploadsIncluded: false,
  overwriteProtocol: OVERWRITE_PROTOCOL,
  singlePutMaxBytes: SINGLE_PUT_MAX_BYTES,
  publishable: oversizedFiles.length === 0,
  blockedMultipartFiles: oversizedFiles.length,
  blockedMultipartBytes: oversizedFiles.reduce((sum, file) => sum + file.bytes, 0),
  blockedMultipartExamples: oversizedFiles.slice(0, 10).map((file) => ({ path: file.path, bytes: file.bytes })),
}, null, 2));
if (!execute) {
  if (oversizedFiles.length > 0) {
    console.log("PLAN BLOCKED: multipart no-overwrite is not proven safe; split or separately publish the listed large immutable objects first.");
  } else {
    console.log(`PLAN ONLY: pass --execute --confirm ${manifest.assetVersion} after reviewing bucket, region and CDN policy.`);
  }
  process.exit(0);
}
if (oversizedFiles.length > 0) {
  stop(`refusing COS publication: ${oversizedFiles.length} objects exceed the ${SINGLE_PUT_MAX_BYTES}-byte conditional single-PUT limit`, 2);
}
if (options.get("--confirm") !== manifest.assetVersion) stop(`--confirm must equal ${manifest.assetVersion}`, 2);

const Bucket = process.env.COS_BUCKET?.trim();
const Region = process.env.COS_REGION?.trim();
const SecretId = process.env.COS_SECRET_ID?.trim();
const SecretKey = process.env.COS_SECRET_KEY?.trim();
const SecurityToken = process.env.COS_SESSION_TOKEN?.trim();
if (!Bucket || !Region || !SecretId || !SecretKey) stop("COS_BUCKET, COS_REGION, COS_SECRET_ID and COS_SECRET_KEY are required", 2);
const { default: COS } = await import("cos-nodejs-sdk-v5");
const cos = new COS({ SecretId, SecretKey, Timeout: requestTimeoutMs, ...(SecurityToken ? { SecurityToken } : {}) });

function headerValue(head, name) {
  const headers = head?.headers || {};
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return Array.isArray(value) ? value.join(",") : String(value);
  }
  if (lowerName === "content-length" && head?.ContentLength !== undefined) return String(head.ContentLength);
  if (lowerName === "content-type" && head?.ContentType !== undefined) return String(head.ContentType);
  if (lowerName === "cache-control" && head?.CacheControl !== undefined) return String(head.CacheControl);
  return "";
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/\s*;\s*/gu, ";").replace(/\s*,\s*/gu, ", ");
}

function headObject(Key) {
  return new Promise((resolve, reject) => {
    cos.headObject({ Bucket, Region, Key }, (error, data) => {
      if (error) {
        if (Number(error.statusCode || error.status) === 404) resolve(null);
        else reject(error);
      } else resolve(data);
    });
  });
}

function putObject(Key, Body, sha256, contentType, cacheControl) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket,
      Region,
      Key,
      Body,
      ContentLength: Body.length,
      ContentType: contentType,
      Headers: {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        "x-cos-meta-sha256": sha256,
        "x-cos-forbid-overwrite": "true",
      },
    }, (error, data) => error ? reject(error) : resolve(data));
  });
}

function remoteMatches(head, expected) {
  if (!head) return false;
  const remoteSha = headerValue(head, "x-cos-meta-sha256") || headerValue(head, "x-cos-meta-sha-256");
  const remoteBytes = Number(headerValue(head, "content-length"));
  return remoteBytes === expected.bytes
    && remoteSha === expected.sha256
    && normalizeHeader(headerValue(head, "content-type")) === normalizeHeader(expected.contentType)
    && normalizeHeader(headerValue(head, "cache-control")) === normalizeHeader(expected.cacheControl);
}

function contentTypeFor(relativePath) {
  const extension = path.extname(relativePath).toLowerCase();
  return ({
    ".aac": "audio/aac",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json; charset=utf-8",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".zip": "application/zip",
  })[extension] || "application/octet-stream";
}

function verifyRemoteContent(Key, expectedBytes, expectedSha256) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    let requestFinished = false;
    let streamFinished = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      if (error) {
        settled = true;
        reject(error);
        return;
      }
      if (!requestFinished || !streamFinished) return;
      const digest = hash.digest("hex");
      settled = true;
      if (bytes !== expectedBytes || digest !== expectedSha256) reject(new Error(`remote full-sha256 mismatch: ${Key}`));
      else resolve();
    };
    const output = new Writable({
      write(chunk, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback();
      },
    });
    output.once("finish", () => {
      streamFinished = true;
      finish();
    });
    output.once("error", (error) => finish(error));
    cos.getObject({ Bucket, Region, Key, Output: output, Headers: {} }, (error) => {
      if (error) finish(error);
      else {
        requestFinished = true;
        finish();
      }
    });
  });
}

function getObjectBuffer(Key) {
  return new Promise((resolve, reject) => {
    cos.getObject({ Bucket, Region, Key, Headers: {} }, (error, data) => {
      if (error) reject(error);
      else resolve(Buffer.from(data.Body || []));
    });
  });
}

async function publishImmutableBuffer(Key, bytes, sha256, contentType, cacheControl) {
  if (bytes.length > SINGLE_PUT_MAX_BYTES) throw new Error(`conditional single-PUT size exceeded: ${Key}`);
  const expected = { bytes: bytes.length, sha256, contentType, cacheControl };
  let existing = await headObject(Key);
  if (existing && !remoteMatches(existing, expected)) {
    throw new Error(`immutable COS object already exists with different bytes or HTTP metadata: ${Key}`);
  }
  if (!existing) {
    try {
      await putObject(Key, bytes, sha256, contentType, cacheControl);
    } catch (error) {
      // A concurrent identical publisher may win the no-overwrite race. It is
      // reusable only after the full immutable contract is re-verified.
      existing = await headObject(Key);
      if (!existing || !remoteMatches(existing, expected)) throw error;
    }
    const uploadedHead = await headObject(Key);
    if (!remoteMatches(uploadedHead, expected)) throw new Error(`remote metadata verification failed: ${Key}`);
  }
  await verifyRemoteContent(Key, bytes.length, sha256);
  return existing ? "reused" : "uploaded";
}

function writeReceiptOutput(filePath, bytes) {
  if (bytes.length <= 0 || bytes.length > MAX_RECEIPT_BYTES) stop("readiness receipt output has an invalid size", 2);
  const resolved = path.resolve(root, filePath);
  if (!isInside(root, resolved)) stop("receipt output must remain inside the project root", 2);
  try {
    assertNoSymlinkComponents(root, path.dirname(resolved), { allowMissing: true });
  } catch (error) {
    stop(`receipt output parent is unsafe: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  assertNoSymlinkComponents(root, path.dirname(resolved));
  const expectedSha256 = sha256Buffer(bytes);
  if (fs.existsSync(resolved)) {
    const stats = fs.lstatSync(resolved);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== bytes.length || sha256File(resolved) !== expectedSha256) {
      stop(`refusing to overwrite a different or unsafe receipt output: ${resolved}`, 2);
    }
    return resolved;
  }
  const temporary = `${resolved}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporary, resolved);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stats = fs.lstatSync(resolved);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== bytes.length || sha256File(resolved) !== expectedSha256) throw error;
    }
    fs.rmSync(temporary, { force: true });
    fsyncDirectory(path.dirname(resolved));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return resolved;
}

function readVerifiedSourceAsset(file) {
  const filePath = path.resolve(root, ...file.path.split("/"));
  if (!isInside(root, filePath)) throw new Error(`local asset escaped project root: ${file.path}`);
  assertNoSymlinkComponents(root, filePath);
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes) throw new Error(`local asset size or type mismatch: ${file.path}`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== file.bytes || sha256Buffer(bytes) !== file.sha256) throw new Error(`local asset sha256 mismatch: ${file.path}`);
  return bytes;
}

let nextIndex = 0;
let uploaded = 0;
let reused = 0;
let fullSha256Verified = 0;
async function worker() {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    if (index >= manifest.files.length) return;
    const file = manifest.files[index];
    const bytes = readVerifiedSourceAsset(file);
    const result = await publishImmutableBuffer(
      `${keyPrefix}/${file.path}`,
      bytes,
      file.sha256,
      contentTypeFor(file.path),
      IMMUTABLE_CACHE_CONTROL,
    );
    if (result === "uploaded") uploaded += 1;
    else reused += 1;
    fullSha256Verified += 1;
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (
    fullSha256Verified !== manifest.files.length
    || uploaded + reused !== manifest.files.length
  ) throw new Error("not every manifest asset completed full remote verification");

  const metadataPrefix = `${keyPrefix}/.release`;
  await publishImmutableBuffer(
    `${metadataPrefix}/public-assets.v1.json`,
    manifestBytes,
    manifestSha256,
    "application/json; charset=utf-8",
    METADATA_CACHE_CONTROL,
  );
  const receiptContract = {
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
    location: `cos://${Bucket}/${keyPrefix}`,
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
  const receiptKey = `${metadataPrefix}/public-assets.ready.v1.json`;
  const existingReceiptHead = await headObject(receiptKey);
  let receipt;
  let receiptBytes;
  if (existingReceiptHead) {
    const declaredReceiptBytes = Number(headerValue(existingReceiptHead, "content-length"));
    if (!Number.isSafeInteger(declaredReceiptBytes) || declaredReceiptBytes <= 0 || declaredReceiptBytes > MAX_RECEIPT_BYTES) {
      throw new Error("existing readiness receipt has an invalid size");
    }
    receiptBytes = await getObjectBuffer(receiptKey);
    if (receiptBytes.length !== declaredReceiptBytes || receiptBytes.length > MAX_RECEIPT_BYTES) {
      throw new Error("existing readiness receipt body size does not match HEAD");
    }
    const existingReceiptSha = sha256Buffer(receiptBytes);
    if (!remoteMatches(existingReceiptHead, {
      bytes: receiptBytes.length,
      sha256: existingReceiptSha,
      contentType: "application/json; charset=utf-8",
      cacheControl: METADATA_CACHE_CONTROL,
    })) throw new Error("existing readiness receipt metadata does not match its content or HTTP contract");
    receipt = JSON.parse(receiptBytes.toString("utf8"));
    for (const [field, expected] of Object.entries(receiptContract)) {
      if (receipt[field] !== expected) throw new Error(`existing readiness receipt field does not match: ${field}`);
    }
    if (typeof receipt.verifiedAt !== "string" || Number.isNaN(Date.parse(receipt.verifiedAt))) {
      throw new Error("existing readiness receipt has invalid verifiedAt");
    }
    await verifyRemoteContent(receiptKey, receiptBytes.length, existingReceiptSha);
  } else {
    receipt = { ...receiptContract, verifiedAt: new Date().toISOString() };
    receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (receiptBytes.length <= 0 || receiptBytes.length > MAX_RECEIPT_BYTES) throw new Error("generated readiness receipt has an invalid size");
    const receiptSha256 = sha256Buffer(receiptBytes);
    await publishImmutableBuffer(
      receiptKey,
      receiptBytes,
      receiptSha256,
      "application/json; charset=utf-8",
      METADATA_CACHE_CONTROL,
    );
  }
  const receiptOutput = options.get("--receipt-output")
    ? writeReceiptOutput(options.get("--receipt-output"), receiptBytes)
    : null;
  console.log(JSON.stringify({ ok: true, uploaded, reused, fullSha256Verified, receipt, receiptOutput }, null, 2));
} catch (error) {
  stop(`COS asset publication failed before READY: ${error instanceof Error ? error.message : String(error)}`);
}
