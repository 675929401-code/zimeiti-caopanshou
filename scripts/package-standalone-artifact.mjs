#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { computeBuildOutputDigest } from "./compute-release-build-output-digest.mjs";
import { assertJsonSchema, canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";
import { materializeTracedRuntime } from "./materialize-storage-runtime.mjs";

const options = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    options.set(argument, next);
    index += 1;
  } else {
    options.set(argument, "1");
  }
}

function stop(message, code = 1) {
  console.error(`FAIL ${message}`);
  process.exit(code);
}

function normalize(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

const windowsReservedName = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/iu;
function canonicalArtifactPath(value) {
  if (typeof value !== "string" || !value || value !== value.normalize("NFC")
    || /[\\:\u0000-\u001f\u007f]|\p{Bidi_Control}/u.test(value)
    || value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`unsafe artifact logical path: ${String(value)}`);
  }
  const normalized = value.replace(/^\.\//u, "").replace(/\/$/u, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((segment) => !segment || segment === "." || segment === ".."
    || /[. ]$/u.test(segment) || windowsReservedName.test(segment))) {
    throw new Error(`unsafe artifact logical path: ${value}`);
  }
  return normalized;
}

function isKnownNonSecretDependencySchema(relativePath) {
  const normalizedPath = normalize(relativePath).toLowerCase();
  const schemaPath = "node_modules/har-schema/lib/cookie.json";
  return normalizedPath === schemaPath || normalizedPath.endsWith(`/${schemaPath}`);
}

const sensitiveDataExtensions = new Set([
  "",
  ".bin",
  ".conf",
  ".config",
  ".csv",
  ".dat",
  ".ini",
  ".json",
  ".properties",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const privateKeyExtensions = new Set([".key", ".keystore", ".p12", ".pfx"]);
const sensitiveNameMarker = /(^|[._-])(?:api[._-]?key|private[._-]?key|secret(?:s)?|token(?:s)?|cookie(?:s)?|credential(?:s)?|service[._-]?account)(?=$|[._-])/iu;
const hiddenMetadataDirectoryNames = new Set([".git", ".svn", ".hg", ".history", ".cache"]);

function sensitiveArtifactPathReason(relativePath, kind) {
  const normalizedPath = canonicalArtifactPath(relativePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === ".env" || lowerPart.startsWith(".env.")) return "environment file";
    if (lowerPart === ".npmrc") return "package-manager credential file";
    if (lowerPart === ".secure") return "secure-material path";
    if (hiddenMetadataDirectoryNames.has(lowerPart)) return "source-control, history, or cache metadata path";
  }
  if (kind !== "file" || parts.length === 0) return null;
  if (isKnownNonSecretDependencySchema(normalizedPath)) return null;

  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
  if ([".pem", ".key", ".pub", ".crt", ".cer", ".p7b", ".p12", ".pfx", ".map"].includes(extension)) {
    return "key, certificate, or source-map file";
  }
  if (privateKeyExtensions.has(extension)) return "private-key container";
  if (["id_dsa", "id_ecdsa", "id_ed25519", "id_rsa"].includes(fileName)) return "SSH private key";
  if (sensitiveDataExtensions.has(extension)) {
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    if (sensitiveNameMarker.test(stem)) return "credential, key, token, cookie, or secret data file";
  }
  return null;
}

function assertSafeArtifactPath(relativePath, kind) {
  const reason = sensitiveArtifactPathReason(relativePath, kind);
  if (reason) throw new Error(`forbidden sensitive artifact path (${reason}): ${normalize(relativePath)}`);
}

const privateKeyPemPattern = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]{1,1048576}?)-----END \1-----/gu;
function containsStructurallyValidPrivateKeyPem(body) {
  const text = body.toString("latin1");
  privateKeyPemPattern.lastIndex = 0;
  for (const match of text.matchAll(privateKeyPemPattern)) {
    const label = match[1];
    const lines = match[2].replace(/\r/gu, "").split("\n");
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && /^[A-Za-z0-9-]+:[\t -~]*$/u.test(lines[0].trim())) lines.shift();
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines.at(-1).trim()) lines.pop();
    if (lines.length === 0) continue;
    const encodedLines = lines.map((line) => line.trim());
    if (encodedLines.some((line) => !/^[A-Za-z0-9+/]+={0,2}$/u.test(line))) continue;
    const encoded = encodedLines.join("");
    if (encoded.length < 44 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) continue;
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length < 32 || decoded.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) continue;
    if (label === "OPENSSH PRIVATE KEY") {
      if (decoded.subarray(0, 15).equals(Buffer.from("openssh-key-v1\0", "ascii"))) return true;
    } else if (decoded[0] === 0x30) {
      return true;
    }
  }
  return false;
}

function assertSafeArtifactContent(filePath, relativePath) {
  const body = fs.readFileSync(filePath);
  if (containsStructurallyValidPrivateKeyPem(body)) {
    throw new Error(`forbidden private-key PEM content: ${canonicalArtifactPath(relativePath)}`);
  }
}

function isSourceMapPath(relativePath) {
  return path.posix.extname(normalize(relativePath)).toLowerCase() === ".map";
}

const nonRuntimePackageDocumentationExtensions = new Set([".md", ".markdown"]);
function isNonRuntimePackageDocumentation(relativePath) {
  const normalizedPath = normalize(relativePath).toLowerCase();
  return normalizedPath.split("/").includes("node_modules")
    && nonRuntimePackageDocumentationExtensions.has(path.posix.extname(normalizedPath));
}

function sensitiveArtifactPathReasonAllowingSourceMap(relativePath, kind, allowSourceMap) {
  if (allowSourceMap && kind === "file" && isSourceMapPath(relativePath)) {
    const parent = path.posix.dirname(normalize(relativePath));
    return parent === "." ? null : sensitiveArtifactPathReason(parent, "directory");
  }
  return sensitiveArtifactPathReason(relativePath, kind);
}

function archivedMode(stats, kind) {
  const mode = stats.mode & 0o777;
  // Windows bsdtar necessarily adds search bits to directory headers. Record
  // that exact archive representation so a fresh Linux finalizer verifies the
  // bytes it will materialize, rather than the lossy Windows directory stat.
  return process.platform === "win32" && kind === "directory" ? mode | 0o111 : mode;
}

function assertArtifactTreeHasNoSensitivePaths(rootPath) {
  const resolvedRoot = path.resolve(rootPath);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (rootStats.isSymbolicLink()) throw new Error("artifact verification root must not be a symbolic link or junction");
  if (!rootStats.isDirectory()) throw new Error("verification root is not a directory");
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalize(path.relative(resolvedRoot, entryPath));
      const entryStats = fs.lstatSync(entryPath);
      if (entryStats.isSymbolicLink()) throw new Error(`artifact tree contains a forbidden symbolic link or junction: ${relativePath}`);
      assertSafeArtifactPath(relativePath, entryStats.isDirectory() ? "directory" : "file");
      if (entryStats.isDirectory()) walk(entryPath);
      else if (!entryStats.isFile()) throw new Error(`artifact tree contains a non-regular entry: ${relativePath}`);
      else assertSafeArtifactContent(entryPath, relativePath);
    }
  }
  walk(resolvedRoot);
}

function assertMaterializableArtifactTree(rootPath, trustedRoots) {
  const resolvedRoot = path.resolve(rootPath);
  const rootStats = fs.lstatSync(resolvedRoot);
  if (rootStats.isSymbolicLink()) throw new Error("materializable verification root must not be a symbolic link or junction");
  if (!rootStats.isDirectory()) throw new Error("verification root is not a directory");
  const realTrustedRoots = [...new Set(trustedRoots.map((candidate) => fs.realpathSync(candidate)))];
  const activeRealDirectories = new Set();
  const omittedSourceMapTargets = new Set();
  const omittedPackageDocumentationTargets = new Set();

  function trustedTargetRelativePaths(realTarget) {
    return realTrustedRoots
      .filter((trustedRoot) => isPathInsideOrEqual(trustedRoot, realTarget))
      .map((trustedRoot) => normalize(path.relative(trustedRoot, realTarget)))
      .filter(Boolean);
  }

  function assertTrustedRealTarget(realTarget, kind, logicalPath, allowSourceMap) {
    const matchingRoots = realTrustedRoots.filter((trustedRoot) => isPathInsideOrEqual(trustedRoot, realTarget));
    if (matchingRoots.length === 0) throw new Error(`materializable link target escapes trusted build roots: ${logicalPath}`);
    for (const relativeTarget of trustedTargetRelativePaths(realTarget)) {
      const reason = sensitiveArtifactPathReasonAllowingSourceMap(relativeTarget, kind, allowSourceMap);
      if (reason) throw new Error(`materializable link resolves to a forbidden sensitive target (${reason}): ${logicalPath}`);
    }
  }

  function walk(directory, logicalDirectory) {
    const realDirectory = fs.realpathSync(directory);
    const directoryKey = process.platform === "win32" ? realDirectory.toLowerCase() : realDirectory;
    if (activeRealDirectories.has(directoryKey)) throw new Error(`materializable input contains a cyclic directory link: ${logicalDirectory || "."}`);
    activeRealDirectories.add(directoryKey);
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        const relativePath = normalize(path.posix.join(logicalDirectory, entry.name));
        const entryStats = fs.lstatSync(entryPath);
        const sourceMapOmitted = isSourceMapPath(relativePath);
        const packageDocumentationOmitted = isNonRuntimePackageDocumentation(relativePath);

        let realTarget;
        try {
          realTarget = fs.realpathSync(entryPath);
        } catch {
          throw new Error(`materializable input contains a broken link: ${relativePath}`);
        }
        let targetStats;
        try {
          targetStats = fs.statSync(entryPath);
        } catch {
          throw new Error(`materializable input contains a broken link: ${relativePath}`);
        }
        const targetKind = targetStats.isDirectory() ? "directory" : "file";
        const logicalReason = sensitiveArtifactPathReasonAllowingSourceMap(relativePath, targetKind, sourceMapOmitted);
        if (logicalReason) throw new Error(`forbidden sensitive materializable logical path (${logicalReason}): ${relativePath}`);
        assertTrustedRealTarget(realTarget, targetKind, relativePath, sourceMapOmitted);
        if (entryStats.isSymbolicLink() && !targetStats.isDirectory() && !targetStats.isFile()) {
          throw new Error(`materializable link target is not a regular file or directory: ${relativePath}`);
        }
        if (!entryStats.isSymbolicLink() && !entryStats.isDirectory() && !entryStats.isFile()) {
          throw new Error(`materializable input contains a non-regular entry: ${relativePath}`);
        }
        if (sourceMapOmitted || packageDocumentationOmitted) {
          const targetKey = process.platform === "win32" ? realTarget.toLowerCase() : realTarget;
          if (sourceMapOmitted) omittedSourceMapTargets.add(targetKey);
          if (packageDocumentationOmitted) omittedPackageDocumentationTargets.add(targetKey);
          continue;
        }
        if (targetStats.isDirectory()) walk(realTarget, relativePath);
        else if (!targetStats.isFile()) throw new Error(`materializable input contains a non-regular entry: ${relativePath}`);
      }
    } finally {
      activeRealDirectories.delete(directoryKey);
    }
  }
  walk(resolvedRoot, "");
  return {
    omittedSourceMaps: omittedSourceMapTargets.size,
    omittedPackageDocumentation: omittedPackageDocumentationTargets.size,
  };
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

function inspectTarInventory(archivePath) {
  const tar = zlib.gunzipSync(fs.readFileSync(archivePath));
  const entries = [];
  const collisionKeys = new Set();
  let offset = 0;
  let pendingPax = {};
  let pendingLongPath = null;
  const field = (header, start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
  const numberField = (header, start, length) => {
    const raw = field(header, start, length).trim();
    return raw ? Number.parseInt(raw, 8) : 0;
  };
  const parsePax = (body) => {
    const values = {};
    let cursor = 0;
    while (cursor < body.length) {
      const space = body.indexOf(0x20, cursor);
      if (space < 0) throw new Error("candidate archive contains malformed PAX metadata");
      const length = Number.parseInt(body.subarray(cursor, space).toString("ascii"), 10);
      if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > body.length) throw new Error("candidate archive contains malformed PAX metadata");
      const record = body.subarray(space + 1, cursor + length - 1).toString("utf8");
      const equals = record.indexOf("=");
      if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
      cursor += length;
    }
    return values;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = numberField(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error("candidate archive contains an invalid entry size");
    const body = tar.subarray(offset + 512, offset + 512 + size);
    const type = field(header, 156, 1) || "0";
    const name = field(header, 0, 100);
    const prefix = field(header, 345, 155);
    if (type === "x") pendingPax = { ...pendingPax, ...parsePax(body) };
    else if (type === "L") pendingLongPath = body.toString("utf8").replace(/\0.*$/u, "");
    else if (type === "g") {
      // Global PAX metadata cannot replace per-entry path/type/mode trust decisions.
      parsePax(body);
    } else {
      if (!["0", "5"].includes(type)) throw new Error("candidate archive contains unsupported entry type");
      const entryPax = pendingPax;
      const rawPath = entryPax.path || pendingLongPath || `${prefix ? `${prefix}/` : ""}${name}`;
      pendingPax = {};
      pendingLongPath = null;
      const cleaned = rawPath.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (cleaned) {
        const logicalPath = canonicalArtifactPath(cleaned);
        const collisionKey = logicalPath.normalize("NFC").toLocaleLowerCase("en-US");
        if (collisionKeys.has(collisionKey)) throw new Error("candidate archive contains case or Unicode-normalization path collision");
        collisionKeys.add(collisionKey);
        const paxMode = entryPax.mode;
        const mode = paxMode ? Number.parseInt(paxMode, 8) : numberField(header, 100, 8);
        if (!Number.isSafeInteger(mode)) throw new Error("candidate archive contains invalid entry mode");
        entries.push({ path: logicalPath, kind: type === "5" ? "directory" : "file", mode: mode & 0o777 });
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function git(arguments_, root) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) stop(`git ${arguments_.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`, 2);
  return result.stdout;
}

function isPathInsideOrEqual(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function copyTree(source, destination, filter = () => true, options = {}) {
  if (!fs.existsSync(source)) stop(`missing artifact input: ${source}`);
  const trustedSymlinkRoots = options.trustedSymlinkRoots || [];
  const activeRealDirectories = options.activeRealDirectories || new Set();
  const realSource = fs.realpathSync(source);
  const sourceKey = process.platform === "win32" ? realSource.toLowerCase() : realSource;
  if (activeRealDirectories.has(sourceKey)) stop(`artifact input contains a cyclic directory link: ${source}`);
  activeRealDirectories.add(sourceKey);
  try {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (isNonRuntimePackageDocumentation(sourcePath)) {
        if (options.metrics) {
          options.metrics.omittedPackageDocumentationCount = (options.metrics.omittedPackageDocumentationCount || 0) + 1;
        }
        continue;
      }
      if (entry.name.toLowerCase().endsWith(".map")) {
        if (options.metrics) options.metrics.omittedSourceMapCount = (options.metrics.omittedSourceMapCount || 0) + 1;
        continue;
      }
      if (!filter(sourcePath, entry)) continue;
      if (entry.isSymbolicLink()) {
        if (trustedSymlinkRoots.length === 0) stop(`artifact input contains unsupported symbolic link: ${sourcePath}`);
        let realTarget;
        try {
          realTarget = fs.realpathSync(sourcePath);
        } catch (error) {
          stop(`artifact input contains a broken symbolic link: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!trustedSymlinkRoots.some((trustedRoot) => isPathInsideOrEqual(trustedRoot, realTarget))) {
          stop(`artifact input symbolic link escapes trusted build roots: ${sourcePath} -> ${realTarget}`);
        }
        const targetStats = fs.statSync(sourcePath);
        if (options.metrics) options.metrics.materializedSymlinkCount += 1;
        if (targetStats.isDirectory()) {
          copyTree(realTarget, destinationPath, filter, { ...options, activeRealDirectories });
        } else if (targetStats.isFile()) {
          fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
          fs.copyFileSync(sourcePath, destinationPath);
          fs.chmodSync(destinationPath, targetStats.mode);
        } else {
          stop(`artifact input symbolic link target is not a regular file or directory: ${sourcePath}`);
        }
      } else if (entry.isDirectory()) {
        copyTree(sourcePath, destinationPath, filter, { ...options, activeRealDirectories });
      } else if (entry.isFile()) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        fs.chmodSync(destinationPath, fs.statSync(sourcePath).mode);
      }
    }
  } finally {
    activeRealDirectories.delete(sourceKey);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    stop(`invalid ${label}: ${filePath}: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
}

function listRegularFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else stop(`public source boundary contains a non-regular entry: ${entryPath}`, 2);
    }
  }
  walk(rootPath);
  return files;
}

const sensitiveVerificationRoot = options.get("--verify-sensitive-root");
if (sensitiveVerificationRoot) {
  try {
    assertArtifactTreeHasNoSensitivePaths(sensitiveVerificationRoot);
    console.log("PASS final artifact contains only regular directories/files and no sensitive paths");
    process.exit(0);
  } catch (error) {
    stop(`artifact sensitive-path policy rejected input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const materializableVerificationRoot = options.get("--verify-materializable-root");
if (materializableVerificationRoot) {
  try {
    const verificationProjectRoot = path.resolve(options.get("--root") || process.cwd());
    const verificationService = options.get("--service") || "web";
    if (!new Set(["web", "voice"]).has(verificationService)) throw new Error("verification service must be web or voice");
    const verificationServiceRoot = verificationService === "voice" ? path.join(verificationProjectRoot, "voice-platform") : verificationProjectRoot;
    const trustedRoots = [
      materializableVerificationRoot,
      path.join(verificationServiceRoot, "node_modules"),
      path.join(verificationProjectRoot, "node_modules"),
    ].filter((candidate, index, values) => fs.existsSync(candidate) && values.indexOf(candidate) === index);
    const result = assertMaterializableArtifactTree(materializableVerificationRoot, trustedRoots);
    console.log(`PASS materializable standalone input; omittedSourceMaps=${result.omittedSourceMaps}; omittedPackageDocumentation=${result.omittedPackageDocumentation}`);
    process.exit(0);
  } catch (error) {
    stop(`materializable standalone policy rejected input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = path.resolve(options.get("--root") || process.cwd());
const service = options.get("--service");
const outputOption = options.get("--output");
const releaseId = options.get("--release-id") || process.env.RELEASE_ID;
const requestedCommit = (options.get("--commit") || process.env.DEPLOY_COMMIT_SHA || "").toLowerCase();
const buildOutputDigestReceiptPath = options.get("--build-output-digest-receipt");
const allowLocalRehearsal = options.get("--allow-local-rehearsal") === "1";
if (!service || !["web", "voice"].includes(service)) stop("--service must be web or voice", 2);

function verifyMaterializedArtifactTree(artifactRoot, expectedPayload, expectedSubject, archiveInventory) {
  const realRoot = fs.realpathSync(artifactRoot);
  const manifestPath = path.join(realRoot, "release-manifest.json");
  const manifest = readJson(manifestPath, "candidate payload release manifest");
  if (manifest.schemaVersion !== 2 || manifest.service !== service || manifest.commitSha !== expectedSubject.commit
    || manifest.buildId !== expectedSubject.builds[service]
    || manifest.buildOutputDigest !== expectedSubject.buildOutputDigests[service]
    || manifest.releaseId !== expectedPayload.releaseId || manifest.artifactDigest !== expectedPayload.artifactDigest
    || manifest.fileCount !== expectedPayload.fileCount || manifest.totalBytes !== expectedPayload.totalBytes) {
    throw new Error("CANDIDATE_PAYLOAD_MANIFEST_BINDING_MISMATCH");
  }
  const actual = [];
  const collisionKeys = new Set();
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const filePath = path.join(directory, entry.name);
      const relativePath = canonicalArtifactPath(normalize(path.relative(realRoot, filePath)));
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink()) throw new Error(`CANDIDATE_PAYLOAD_LINK_FORBIDDEN:${relativePath}`);
      const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (collisionKeys.has(collisionKey)) throw new Error(`CANDIDATE_PAYLOAD_PATH_COLLISION:${relativePath}`);
      collisionKeys.add(collisionKey);
      assertSafeArtifactPath(relativePath, stats.isDirectory() ? "directory" : "file");
      const real = fs.realpathSync(filePath);
      if (!isPathInsideOrEqual(realRoot, real)) throw new Error(`CANDIDATE_PAYLOAD_PATH_ESCAPE:${relativePath}`);
      if (stats.isDirectory()) {
        actual.push({ path: relativePath, kind: "directory", mode: stats.mode & 0o777, bytes: 0, sha256: null });
        walk(filePath);
      }
      else if (stats.isFile() && relativePath !== "release-manifest.json") {
        assertSafeArtifactContent(filePath, relativePath);
        actual.push({ path: relativePath, kind: "file", mode: stats.mode & 0o777, bytes: stats.size, sha256: sha256File(filePath) });
      } else if (!stats.isFile()) throw new Error(`CANDIDATE_PAYLOAD_NON_FILE:${relativePath}`);
    }
  }
  walk(realRoot);
  actual.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const archiveComparable = archiveInventory
    .filter((entry) => entry.path !== "release-manifest.json")
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  const archivePathAndType = archiveComparable.map(({ path: entryPath, kind }) => ({ path: entryPath, kind }));
  const actualPathAndType = actual.map(({ path: entryPath, kind }) => ({ path: entryPath, kind }));
  if (canonicalJson(archivePathAndType) !== canonicalJson(actualPathAndType)) throw new Error("CANDIDATE_PAYLOAD_ARCHIVE_MODE_OR_TYPE_MISMATCH");
  const archiveModeByPath = new Map(archiveComparable.map((entry) => [entry.path, entry.mode]));
  for (const entry of actual) entry.mode = archiveModeByPath.get(entry.path);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) {
    const mismatchIndex = actual.findIndex((entry, index) => canonicalJson(entry) !== canonicalJson(manifest.files[index]));
    throw new Error(`CANDIDATE_PAYLOAD_INVENTORY_MISMATCH:${mismatchIndex}:${canonicalJson(actual[mismatchIndex])}:${canonicalJson(manifest.files[mismatchIndex])}`);
  }
  const artifactDigest = sha256(canonicalJson(actual));
  if (artifactDigest !== manifest.artifactDigest) throw new Error("CANDIDATE_PAYLOAD_ARTIFACT_DIGEST_MISMATCH");
  return manifest;
}

const finalizeCandidateArchive = options.get("--finalize-candidate-archive");
if (finalizeCandidateArchive) {
  const checksumPath = path.resolve(options.get("--candidate-checksum") || "");
  const bundlePath = path.resolve(options.get("--validation-bundle") || "");
  const scopeReceiptPath = path.resolve(options.get("--scope-receipt") || "");
  const evidenceRoot = path.resolve(options.get("--evidence-root") || "");
  const archivePath = path.resolve(finalizeCandidateArchive);
  const finalArchivePath = path.resolve(options.get("--archive-path") || "");
  for (const required of [archivePath, checksumPath, bundlePath, scopeReceiptPath]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) stop(`missing candidate finalize input: ${required}`, 2);
  }
  if (!options.get("--archive-path") || fs.existsSync(finalArchivePath) || fs.existsSync(`${finalArchivePath}.sha256`)) {
    stop("fresh official archive output is required", 2);
  }
  const archiveSha256 = sha256File(archivePath);
  const checksum = fs.readFileSync(checksumPath, "utf8").trim();
  if (checksum !== `${archiveSha256}  ${path.basename(archivePath)}`) stop("candidate archive checksum mismatch", 2);
  if (!fs.existsSync(evidenceRoot) || !fs.statSync(evidenceRoot).isDirectory()) stop("missing release-ready evidence root", 2);
  const authoritativeGate = spawnSync(process.execPath, [
    path.join(root, "scripts", "release-change-validation-gate.mjs"),
    "verify-release-ready",
    "--root", root,
    "--bundle", bundlePath,
    "--scope-receipt", scopeReceiptPath,
    "--evidence-root", evidenceRoot,
  ], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (authoritativeGate.error || authoritativeGate.status !== 0) {
    stop(`authoritative release-ready gate rejected candidate: ${authoritativeGate.error?.message || authoritativeGate.stderr || authoritativeGate.stdout}`, 2);
  }
  const bundleSchema = readJson(path.join(root, "scripts", "contracts", "release-change-validation-bundle.v1.schema.json"), "validation bundle schema");
  const bundle = readJson(bundlePath, "release-ready validation bundle");
  try { assertJsonSchema(bundleSchema, bundle, "BUNDLE_JSON_SCHEMA_INVALID"); } catch (error) { stop(error instanceof Error ? error.message : String(error), 2); }
  const bundlePayload = { ...bundle };
  delete bundlePayload.bundleId;
  if (bundle.bundleId !== `validation-${sha256(canonicalJson(bundlePayload)).slice(0, 24)}`
    || bundle.target !== "release-ready" || bundle.status !== "release-ready") stop("release-ready validation bundle required", 2);
  const expectedPayload = bundle.subject?.candidatePayloads?.[service];
  if (!expectedPayload || expectedPayload.archiveSha256 !== archiveSha256) stop("candidate archive is not bound to the release-ready bundle", 2);
  const listing = spawnSync("tar", ["-tzf", archivePath], { encoding: "utf8" });
  const verbose = spawnSync("tar", ["-tvzf", archivePath], { encoding: "utf8" });
  if (listing.error || listing.status !== 0 || verbose.error || verbose.status !== 0) stop("candidate archive cannot be inspected", 2);
  const archivePathKeys = new Set();
  for (const entry of listing.stdout.split(/\r?\n/u).filter(Boolean)) {
    if (entry === "./" || entry === ".") continue;
    let logicalPath;
    try { logicalPath = canonicalArtifactPath(entry.replace(/^\.\//u, "").replace(/\/$/u, "")); }
    catch { stop("candidate archive contains unsafe path", 2); }
    const collisionKey = logicalPath.normalize("NFC").toLocaleLowerCase("en-US");
    if (archivePathKeys.has(collisionKey)) stop("candidate archive contains case or Unicode-normalization path collision", 2);
    archivePathKeys.add(collisionKey);
  }
  if (verbose.stdout.split(/\r?\n/u).some((line) => /^[lh]/u.test(line))) stop("candidate archive contains links", 2);
  let archiveInventory;
  try { archiveInventory = inspectTarInventory(archivePath); }
  catch (error) { stop(error instanceof Error ? error.message : String(error), 2); }
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-candidate-finalize-"));
  try {
    const extract = spawnSync("tar", ["-xzf", archivePath, "-C", extractRoot], { encoding: "utf8" });
    if (extract.error || extract.status !== 0) stop(`candidate archive extraction failed: ${extract.error?.message || extract.stderr}`, 2);
    try { verifyMaterializedArtifactTree(extractRoot, expectedPayload, bundle.subject, archiveInventory); }
    catch (error) { stop(error instanceof Error ? error.message : String(error), 2); }
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(finalArchivePath), { recursive: true });
  fs.copyFileSync(archivePath, finalArchivePath, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(`${finalArchivePath}.sha256`, `${archiveSha256}  ${path.basename(finalArchivePath)}\n`, { flag: "wx" });
  console.log(`PASS finalized exact candidate payload without rebuild: ${finalArchivePath}`);
  process.exit(0);
}

if (!buildOutputDigestReceiptPath) stop("--build-output-digest-receipt is required", 2);

function assertCurrentBuildOutputDigest(commit) {
  const receipt = readJson(path.resolve(buildOutputDigestReceiptPath), "build output digest receipt");
  let actual;
  try {
    actual = computeBuildOutputDigest(root, service, commit, receipt.sourceVersion);
  } catch (error) {
    stop(`cannot recompute build output digest: ${error instanceof Error ? error.message : String(error)}`, 2);
  }
  if (canonicalJson(receipt) !== canonicalJson(actual)) stop("build output digest receipt does not match the bytes package would materialize", 2);
  return receipt;
}

if (options.get("--verify-build-output-digest-only") === "1") {
  if (!/^[0-9a-f]{40,64}$/u.test(requestedCommit)) stop("--commit is required for digest-only verification", 2);
  const receipt = assertCurrentBuildOutputDigest(requestedCommit);
  console.log(`PASS package input build-output digest: ${receipt.outputDigest}`);
  process.exit(0);
}

if (!outputOption) stop("--output <new-directory> is required", 2);
if (!releaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u.test(releaseId)) stop("--release-id must be 8-80 safe characters", 2);

const finalOutputRoot = path.resolve(outputOption);
if (fs.existsSync(finalOutputRoot)) stop(`refusing to overwrite artifact directory: ${finalOutputRoot}`, 2);
if (finalOutputRoot === root || finalOutputRoot.startsWith(`${root}${path.sep}`)) stop("artifact output must be outside the source worktree", 2);
const artifactParent = path.dirname(finalOutputRoot);
const stagingPrefix = `.${path.basename(finalOutputRoot)}.staging-`;
const outputRoot = path.join(artifactParent, `${stagingPrefix}${process.pid}-${crypto.randomUUID()}`);
let artifactCommitted = false;

function cleanupArtifactStaging() {
  if (artifactCommitted || !fs.existsSync(outputRoot)) return;
  const resolvedStaging = path.resolve(outputRoot);
  if (path.dirname(resolvedStaging) !== artifactParent || !path.basename(resolvedStaging).startsWith(stagingPrefix)) {
    console.error(`REFUSED unsafe artifact staging cleanup: ${resolvedStaging}`);
    return;
  }
  fs.rmSync(resolvedStaging, { recursive: true, force: true });
}

process.once("exit", cleanupArtifactStaging);

const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
if (!fs.existsSync(policyPath)) stop("missing deploy/policies/release-policy.json", 2);
const policy = readJson(policyPath, "release policy");
const servicePolicy = policy.services?.[service];
if (!servicePolicy) stop(`service missing from release policy: ${service}`, 2);

const gitRoot = path.resolve(git(["rev-parse", "--show-toplevel"], root).trim());
if (gitRoot.toLowerCase() !== root.toLowerCase()) stop(`artifact root must be the Git top-level: ${gitRoot}`, 2);
const commitSha = git(["rev-parse", "HEAD"], root).trim().toLowerCase();
if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) stop("a traceable Git commit SHA is required", 2);
if (requestedCommit && requestedCommit !== commitSha) stop(`--commit must equal clean Git HEAD (${commitSha})`, 2);
if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root)) stop("artifact packaging requires a clean Git worktree", 2);

const serviceRoot = service === "web" ? root : path.join(root, "voice-platform");
const standaloneRoot = path.join(root, ...normalize(servicePolicy.standaloneDirectory).split("/"));
const serverEntrypoint = path.join(standaloneRoot, "server.js");
const staticRoot = path.join(serviceRoot, ".next", "static");
const buildIdPath = path.join(serviceRoot, ".next", "BUILD_ID");
const provenancePath = path.join(serviceRoot, ".next", "release-provenance.v1.json");
for (const requiredPath of [serverEntrypoint, staticRoot, buildIdPath, provenancePath]) {
  if (!fs.existsSync(requiredPath)) stop(`missing built artifact input: ${requiredPath}; run release:vnext:build:${service}`, 2);
}

const sourceManifestPath = path.join(root, ".release", "source-files.v1.json");
const assetManifestPath = path.join(root, ...normalize(policy.assets.manifest).split("/"));
for (const requiredPath of [sourceManifestPath, assetManifestPath]) {
  if (!fs.existsSync(requiredPath)) stop(`missing release metadata input: ${requiredPath}`, 2);
}
const sourceManifest = readJson(sourceManifestPath, "source manifest");
const assetManifest = readJson(assetManifestPath, "public asset manifest");
const provenance = readJson(provenancePath, "build provenance");
const buildId = fs.readFileSync(buildIdPath, "utf8").trim();
const buildOutputDigestReceipt = assertCurrentBuildOutputDigest(commitSha);
if (buildOutputDigestReceipt.schemaVersion !== "zimeiti-release-build-output-digest.v1"
  || buildOutputDigestReceipt.service !== service
  || buildOutputDigestReceipt.commit !== commitSha
  || buildOutputDigestReceipt.buildId !== buildId
  || !/^[a-f0-9]{64}$/u.test(buildOutputDigestReceipt.outputDigest || "")) {
  stop("build output digest receipt does not bind this exact service output", 2);
}
const expected = {
  projectId: policy.projectId,
  service,
  sourceCommit: commitSha,
  sourceManifestSha256: sha256File(sourceManifestPath),
  policySha256: sha256File(policyPath),
  assetManifestSha256: sha256File(assetManifestPath),
  assetDigest: assetManifest.digest,
  assetVersion: assetManifest.assetVersion,
  buildId,
};
for (const [key, value] of Object.entries(expected)) {
  if (provenance[key] !== value) stop(`build provenance mismatch for ${key}; rebuild from clean HEAD`, 2);
}
if (sourceManifest.assetManifestSha256 !== expected.assetManifestSha256 || sourceManifest.assetDigest !== assetManifest.digest) {
  stop("clean source snapshot and public asset manifest are not pinned together", 2);
}
if (!provenance.deployable && !allowLocalRehearsal) stop("build provenance is non-deployable; production artifacts must be built on the locked Linux builder", 2);
if (provenance.deployable) {
  const buildPolicy = policy.release.productionBuild;
  if (provenance.buildEnvironment?.platform !== buildPolicy.platform) stop("deployable provenance platform mismatch", 2);
  if (!buildPolicy.architectures.includes(provenance.buildEnvironment?.arch)) stop("deployable provenance architecture mismatch", 2);
  if (!String(provenance.buildEnvironment?.nodeVersion || "").startsWith(`v${buildPolicy.nodeMajor}.`)) stop("deployable provenance Node version mismatch", 2);
  if (provenance.buildEnvironment?.pnpmVersion !== buildPolicy.pnpmVersion) stop("deployable provenance pnpm version mismatch", 2);
  if (!["glibc", "musl"].includes(provenance.buildEnvironment?.libc)) stop("deployable provenance libc is invalid", 2);
}

fs.mkdirSync(outputRoot, { recursive: false });
try {
  const copyMetrics = { materializedSymlinkCount: 0, omittedSourceMapCount: 0, omittedPackageDocumentationCount: 0 };
  const trustedSymlinkRoots = [
    standaloneRoot,
    path.join(serviceRoot, "node_modules"),
    path.join(root, "node_modules"),
  ].filter((candidate, index, values) => fs.existsSync(candidate) && values.indexOf(candidate) === index)
    .map((candidate) => fs.realpathSync(candidate));
  assertMaterializableArtifactTree(standaloneRoot, trustedSymlinkRoots);
  const standaloneCopyFilter = service === "web"
    ? (sourcePath) => {
      const relativePath = normalize(path.relative(standaloneRoot, sourcePath));
      return relativePath !== "public" && !relativePath.startsWith("public/");
    }
    : () => true;
  copyTree(standaloneRoot, outputRoot, standaloneCopyFilter, { trustedSymlinkRoots, metrics: copyMetrics });
  // Next's standalone trace preserves pnpm's virtual-store topology. Once the
  // traced package links are materialized into real top-level directories,
  // Node no longer walks through `.pnpm/node_modules` automatically. Mirror
  // the traced hoisted layer into the artifact's top-level node_modules so the
  // link-free artifact retains the same dependency resolution semantics.
  const pnpmHoistedRoot = path.join(standaloneRoot, "node_modules", ".pnpm", "node_modules");
  let materializedPnpmHoistedLayer = false;
  if (fs.existsSync(pnpmHoistedRoot)) {
    copyTree(pnpmHoistedRoot, path.join(outputRoot, "node_modules"), () => true, { trustedSymlinkRoots, metrics: copyMetrics });
    materializedPnpmHoistedLayer = true;
  }
  // Dereferencing pnpm's package links removes sibling resolution for every
  // externalized package, including pg, native modules, SDKs and the framework.
  // Complete the entire traced external set instead of patching missing modules
  // one at a time, and forbid fallback to the builder during load verification.
  const runtime = materializeTracedRuntime(serviceRoot, standaloneRoot, outputRoot, { storage: service === "web" });
  console.log(`PASS traced runtime dependencies: ${runtime.roots.join(", ")}; ${runtime.packageCopies} package copies`);
  console.log(`PASS omitted non-runtime package documentation: ${copyMetrics.omittedPackageDocumentationCount + runtime.omittedPackageDocumentation} files`);
  copyTree(staticRoot, path.join(outputRoot, ".next", "static"));
  fs.mkdirSync(path.join(outputRoot, ".next"), { recursive: true });
  fs.copyFileSync(buildIdPath, path.join(outputRoot, ".next", "BUILD_ID"));

  let publicSourceBoundary = null;
  if (service === "web") {
    const publicRoot = path.join(root, "public");
    const allowedPublicFiles = new Set((policy.source.publicSourcePaths || []).map(normalize));
    for (const relativePath of allowedPublicFiles) {
      if (!relativePath.startsWith("public/")
        || path.isAbsolute(relativePath)
        || relativePath.split("/").includes("..")) {
        stop(`invalid allowlisted public source path: ${relativePath}`, 2);
      }
      const sourcePath = path.join(root, ...relativePath.split("/"));
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) stop(`missing allowlisted public source file: ${relativePath}`, 2);
      const destinationPath = path.join(outputRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
    if (!fs.existsSync(publicRoot)) stop(`missing public root: ${publicRoot}`, 2);
    const artifactPublicRoot = path.join(outputRoot, "public");
    const actualPublicFiles = listRegularFiles(artifactPublicRoot)
      .map((filePath) => normalize(path.relative(outputRoot, filePath)))
      .sort((left, right) => left.localeCompare(right, "en"));
    const expectedPublicFiles = [...allowedPublicFiles].sort((left, right) => left.localeCompare(right, "en"));
    if (JSON.stringify(actualPublicFiles) !== JSON.stringify(expectedPublicFiles)) {
      const unexpected = actualPublicFiles.filter((filePath) => !allowedPublicFiles.has(filePath));
      const missing = expectedPublicFiles.filter((filePath) => !actualPublicFiles.includes(filePath));
      stop(`web artifact public boundary mismatch: unexpected=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`, 2);
    }
    publicSourceBoundary = {
      fileCount: actualPublicFiles.length,
      totalBytes: actualPublicFiles.reduce((total, relativePath) => total + fs.statSync(path.join(outputRoot, ...relativePath.split("/"))).size, 0),
      policy: "source-public-allowlist-only",
    };
  } else {
    const voicePublic = path.join(root, "voice-platform", "public");
    if (fs.existsSync(voicePublic)) {
      copyTree(voicePublic, path.join(outputRoot, "public"), (sourcePath) => {
        const relativePath = normalize(path.relative(voicePublic, sourcePath));
        return relativePath !== "reference-audio" && !relativePath.startsWith("reference-audio/");
      });
    }
  }

  const releaseMetadataRoot = path.join(outputRoot, ".release");
  fs.mkdirSync(releaseMetadataRoot, { recursive: true });
  fs.copyFileSync(path.join(root, "deploy", "pm2", "ecosystem.vnext.config.cjs"), path.join(releaseMetadataRoot, "ecosystem.config.cjs"));
  fs.copyFileSync(sourceManifestPath, path.join(releaseMetadataRoot, "source-files.v1.json"));
  fs.copyFileSync(provenancePath, path.join(releaseMetadataRoot, "build-provenance.v1.json"));
  if (service === "web") fs.copyFileSync(assetManifestPath, path.join(releaseMetadataRoot, "public-assets.v1.json"));

  const inventory = [];
  const inventoryCollisionKeys = new Set();
  function inventoryTree(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const filePath = path.join(directory, entry.name);
      const relativePath = canonicalArtifactPath(normalize(path.relative(outputRoot, filePath)));
      assertSafeArtifactPath(relativePath, entry.isDirectory() ? "directory" : "file");
      if (entry.isSymbolicLink()) stop(`artifact output contains unsupported symlink: ${filePath}`);
      const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
      if (inventoryCollisionKeys.has(collisionKey)) stop(`artifact output contains a case or Unicode-normalization path collision: ${relativePath}`);
      inventoryCollisionKeys.add(collisionKey);
      const stats = fs.statSync(filePath);
      if (entry.isDirectory()) {
        inventory.push({ path: relativePath, kind: "directory", mode: archivedMode(stats, "directory"), bytes: 0, sha256: null });
        inventoryTree(filePath);
      }
      else if (entry.isFile()) {
        if (relativePath === "release-manifest.json") continue;
        assertSafeArtifactContent(filePath, relativePath);
        inventory.push({ path: relativePath, kind: "file", mode: archivedMode(stats, "file"), bytes: stats.size, sha256: sha256File(filePath) });
      }
    }
  }
  inventoryTree(outputRoot);
  inventory.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const artifactDigest = sha256(canonicalJson(inventory));

  const releaseManifest = {
    schemaVersion: 2,
    projectId: policy.projectId,
    kind: "immutable-standalone-service-artifact",
    deployable: provenance.deployable === true,
    rehearsal: provenance.deployable !== true,
    releaseId,
    service,
    commitSha,
    buildId,
    buildOutputDigest: buildOutputDigestReceipt.outputDigest,
    healthPath: servicePolicy.healthPath,
    readinessPath: servicePolicy.readinessPath,
    port: servicePolicy.port,
    sourceManifestSha256: expected.sourceManifestSha256,
    sourceFingerprint: sourceManifest.sourceFingerprint,
    assetManifestSha256: service === "web" ? expected.assetManifestSha256 : null,
    assetDigest: service === "web" ? assetManifest.digest : null,
    assetVersion: service === "web" ? assetManifest.assetVersion : null,
    buildEnvironment: provenance.buildEnvironment,
    builtAt: provenance.builtAt,
    packagedAt: new Date().toISOString(),
    artifactDigest,
    materializedSymlinkCount: copyMetrics.materializedSymlinkCount,
    materializedPnpmHoistedLayer,
    fileCount: inventory.filter((entry) => entry.kind === "file").length,
    totalBytes: inventory.reduce((total, file) => total + file.bytes, 0),
    publicSourceBoundary,
    files: inventory,
  };
  fs.writeFileSync(path.join(outputRoot, "release-manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");

  // Only a fully inventoried artifact becomes visible at the requested path.
  fs.renameSync(outputRoot, finalOutputRoot);
  artifactCommitted = true;

  console.log(`PASS ${service} ${releaseManifest.deployable ? "deployable" : "rehearsal-only"} artifact directory: ${finalOutputRoot}`);
  console.log(`RELEASE ${releaseId} commit=${commitSha} digest=${artifactDigest}`);
} catch (error) {
  cleanupArtifactStaging();
  console.error(`FAIL artifact packaging aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

if (options.get("--archive") === "1") {
  const archivePath = path.resolve(options.get("--archive-path") || `${finalOutputRoot}.tar.gz`);
  const archiveChecksumPath = `${archivePath}.sha256`;
  if (fs.existsSync(archivePath)) stop(`refusing to overwrite artifact archive: ${archivePath}`, 2);
  if (fs.existsSync(archiveChecksumPath)) stop(`refusing to overwrite artifact checksum: ${archiveChecksumPath}`, 2);
  const archiveParent = path.dirname(archivePath);
  const archiveTemporary = path.join(archiveParent, `.${path.basename(archivePath)}.staging-${process.pid}-${crypto.randomUUID()}`);
  const tar = spawnSync("tar", ["-czf", archiveTemporary, "-C", finalOutputRoot, "."], { cwd: path.dirname(finalOutputRoot), encoding: "utf8" });
  if (tar.error || tar.status !== 0) {
    if (fs.existsSync(archiveTemporary)) fs.rmSync(archiveTemporary, { force: true });
    stop(`tar archive failed: ${tar.error?.message || tar.stderr || tar.stdout}`);
  }
  fs.renameSync(archiveTemporary, archivePath);
  const archiveSha256 = sha256File(archivePath);
  const checksumTemporary = `${archiveChecksumPath}.staging-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(checksumTemporary, `${archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");
  fs.renameSync(checksumTemporary, archiveChecksumPath);
  console.log(`ARCHIVE ${archivePath}`);
  console.log(`SHA256 ${archiveSha256}`);
}
