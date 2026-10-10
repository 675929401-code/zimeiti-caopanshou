#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertLocalReleaseAccepted } from "./local-revision.mjs";

const rawArguments = process.argv.slice(2);
const action = rawArguments[0] && !rawArguments[0].startsWith("--") ? rawArguments.shift() : "audit";
const options = new Map();
for (let index = 0; index < rawArguments.length; index += 1) {
  const argument = rawArguments[index];
  if (!argument.startsWith("--")) continue;
  const next = rawArguments[index + 1];
  if (next && !next.startsWith("--")) {
    options.set(argument, next);
    index += 1;
  } else {
    options.set(argument, "1");
  }
}

const sourceRoot = path.resolve(options.get("--root") || process.cwd());
const policyPath = path.resolve(
  sourceRoot,
  options.get("--policy") || "deploy/policies/release-policy.json",
);

function stop(message, exitCode = 1) {
  console.error(`FAIL ${message}`);
  process.exit(exitCode);
}

function normalize(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function absoluteFrom(root, relativePath) {
  return path.join(root, ...normalize(relativePath).split("/"));
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
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function canonicalSourceBuffer(filePath, relativePath = "") {
  const original = fs.readFileSync(filePath);
  if (relativePath && isExternalAsset(relativePath)) return original;
  if (original.includes(0)) return original;
  const text = original.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(original)) return original;
  return Buffer.from(text.replace(/\r\n?/gu, "\n"), "utf8");
}

function canonicalDigest(files) {
  const canonical = files
    .map((file) => `${file.sha256}  ${file.path}\n`)
    .join("");
  return sha256Buffer(canonical);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let assetPolicySha256;

function canonicalAssetDigest(files) {
  const canonicalFiles = files.map((file) => `${file.sha256}  ${file.path}\n`).join("");
  return sha256Buffer(`asset-policy-sha256  ${assetPolicySha256}\n${canonicalFiles}`);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!fs.existsSync(filePath)) {
    fs.renameSync(temporaryPath, filePath);
    return;
  }

  // Windows does not reliably replace an existing file with renameSync.
  // Keep the previous complete document until the new document is committed.
  const previousPath = `${filePath}.previous-${process.pid}-${crypto.randomUUID()}`;
  fs.renameSync(filePath, previousPath);
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    if (!fs.existsSync(filePath) && fs.existsSync(previousPath)) fs.renameSync(previousPath, filePath);
    throw error;
  }
  try {
    fs.rmSync(previousPath, { force: true });
  } catch (error) {
    console.warn(`WARN committed ${filePath}, but could not remove previous copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!fs.existsSync(policyPath)) stop(`missing release policy: ${policyPath}`, 2);
const policyBytes = fs.readFileSync(policyPath);
const policy = JSON.parse(policyBytes.toString("utf8"));
if (policy.schemaVersion !== 1 || !policy.projectId) stop("unsupported or incomplete release policy", 2);
const policySha256 = sha256Buffer(policyBytes);
assetPolicySha256 = sha256Buffer(stableJson({
  schemaVersion: policy.schemaVersion,
  projectId: policy.projectId,
  assets: policy.assets,
}));

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
    }
  }
  return new RegExp(`${expression}$`, "u");
}

const excludeMatchers = (policy.source.excludeGlobs || []).map((pattern) => globToRegExp(normalize(pattern)));
const excludedDirectories = new Set(policy.source.excludeDirectoryNames || []);
const excludedFileNames = new Set(policy.source.excludeFileNames || []);
const publicSourcePaths = new Set((policy.source.publicSourcePaths || []).map(normalize));
const externalAssetRoots = (policy.assets.externalRoots || []).map(normalize);
const forbiddenPublicRoots = (policy.assets.forbiddenPublicRoots || []).map(normalize);
const forbiddenCuratedJsonMarkers = policy.assets.forbiddenCuratedJsonMarkers || [];
const mutablePaths = (policy.runtime.mutablePaths || []).map(normalize);
const secretPaths = (policy.runtime.secretPaths || []).map(normalize);

function hasPathPrefix(relativePath, prefix) {
  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

function validateManagedRelativePath(relativePath) {
  const normalized = normalize(relativePath);
  if (
    !normalized
    || path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.includes("\0")
  ) {
    stop(`unsafe managed relative path: ${relativePath}`, 2);
  }
  return normalized;
}

function isPublicSourcePath(relativePath) {
  return publicSourcePaths.has(normalize(relativePath));
}

function isRuntimeOrSecret(relativePath) {
  const normalized = normalize(relativePath);
  return [...mutablePaths, ...secretPaths].some((prefix) => hasPathPrefix(normalized, prefix));
}

function isExcluded(relativePath, entryName = path.posix.basename(normalize(relativePath))) {
  const normalized = normalize(relativePath);
  if (/^\.env(?:\.|$)/u.test(entryName) && entryName !== ".env.example") return true;
  if (excludeMatchers.some((matcher) => matcher.test(normalized))) return true;
  if (excludedFileNames.has(entryName)) return true;
  return isRuntimeOrSecret(normalized);
}

function isExternalAsset(relativePath) {
  const normalized = normalize(relativePath);
  if (!hasPathPrefix(normalized, normalize(policy.assets.root))) return false;
  if (isRuntimeOrSecret(normalized)) return false;
  return externalAssetRoots.some((prefix) => hasPathPrefix(normalized, prefix));
}

function shouldWalkAssetDirectory(relativePath) {
  const normalized = normalize(relativePath);
  return externalAssetRoots.some((prefix) => (
    hasPathPrefix(normalized, prefix) || hasPathPrefix(prefix, normalized)
  ));
}

function validateCuratedAssetFile(relativePath, filePath) {
  const normalized = normalize(relativePath);
  if (!hasPathPrefix(normalized, "public/product-assets") || path.extname(filePath).toLowerCase() !== ".json") {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8").toLowerCase();
  const marker = forbiddenCuratedJsonMarkers.find((candidate) => content.includes(String(candidate).toLowerCase()));
  return marker ? `curated product JSON contains forbidden ephemeral marker ${JSON.stringify(marker)}: ${normalized}` : null;
}

function looksSensitive(relativePath, filePath, bytes) {
  if (bytes > 2 * 1024 * 1024) return null;
  const extension = path.extname(relativePath).toLowerCase();
  if (![".cjs", ".env", ".example", ".js", ".json", ".md", ".mjs", ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml"].includes(extension) && !path.basename(relativePath).startsWith(".env")) {
    return null;
  }
  const content = fs.readFileSync(filePath, "utf8");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content)) return "private key material";
  if (/https?:\/\/[^/\s:@]+:[^/\s@]+@/iu.test(content)) return "credential-bearing URL";
  if (/^\s*(?:ACCESS_KEY_SECRET|SECRET_ACCESS_KEY|SUPABASE_SERVICE_ROLE_KEY)\s*=\s*[^$\s][^\r\n]{7,}$/imu.test(content)) {
    return "literal high-risk secret assignment";
  }
  return null;
}

function collectSourceFiles() {
  const failures = [];
  const files = [];
  const seen = new Set();

  function addFile(relativePath, filePath) {
    const normalized = normalize(relativePath);
    if (seen.has(normalized)) return;
    if (isExcluded(normalized)) return;
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      failures.push(`source contains unsupported symbolic link: ${normalized}`);
      return;
    }
    if (!stats.isFile()) return;
    if (stats.size > policy.source.maxFileBytes) {
      failures.push(`source file exceeds ${policy.source.maxFileBytes} bytes: ${normalized} (${stats.size})`);
      return;
    }
    const sensitiveReason = looksSensitive(normalized, filePath, stats.size);
    if (sensitiveReason) {
      failures.push(`${sensitiveReason} found in source candidate: ${normalized}`);
      return;
    }
    const canonical = canonicalSourceBuffer(filePath, normalized);
    files.push({ path: normalized, bytes: canonical.length, sha256: sha256Buffer(canonical), absolutePath: filePath });
    seen.add(normalized);
  }

  function walk(relativeDirectory) {
    const absoluteDirectory = absoluteFrom(sourceRoot, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) {
      failures.push(`missing configured source root: ${relativeDirectory}`);
      return;
    }
    const entries = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = normalize(`${relativeDirectory}/${entry.name}`);
      if (entry.isSymbolicLink()) {
        failures.push(`source contains unsupported symbolic link: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || isExcluded(relativePath, entry.name)) continue;
        walk(relativePath);
        continue;
      }
      if (!entry.isFile() || isExcluded(relativePath, entry.name)) continue;
      if (hasPathPrefix(relativePath, normalize(policy.assets.root)) && !isPublicSourcePath(relativePath)) continue;
      addFile(relativePath, absoluteFrom(sourceRoot, relativePath));
    }
  }

  for (const relativePath of policy.source.topLevelFiles || []) {
    const filePath = absoluteFrom(sourceRoot, relativePath);
    if (!fs.existsSync(filePath)) {
      failures.push(`missing configured top-level source file: ${relativePath}`);
      continue;
    }
    addFile(relativePath, filePath);
  }
  for (const relativeDirectory of policy.source.roots || []) walk(normalize(relativeDirectory));

  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const includedPaths = new Set(files.map((file) => file.path));
  for (const requiredPath of policy.source.requiredBuildPaths || []) {
    if (!includedPaths.has(normalize(requiredPath))) {
      failures.push(`build-required source path is missing from the clean snapshot: ${requiredPath}`);
    }
  }
  const bytes = files.reduce((total, file) => total + file.bytes, 0);
  if (bytes > policy.source.maxBytes) {
    failures.push(`source snapshot exceeds ${policy.source.maxBytes} bytes: ${bytes}`);
  }
  const forbiddenProductionMarkers = forbiddenPublicRoots
    .filter((prefix) => hasPathPrefix(prefix, "public"))
    .map((prefix) => `/${prefix.slice("public/".length)}/`);
  for (const file of files) {
    if (!hasPathPrefix(file.path, "src") || !/[.](?:js|jsx|ts|tsx)$/iu.test(file.path)) continue;
    const content = fs.readFileSync(file.absolutePath, "utf8");
    const marker = forbiddenProductionMarkers.find((candidate) => content.includes(candidate));
    if (marker) failures.push(`production source references forbidden public evidence path ${marker}: ${file.path}`);
  }
  return { files, bytes, failures, fingerprint: canonicalDigest(files) };
}

function collectAssetFiles({ hash = false } = {}) {
  const files = [];
  const failures = [];
  for (const externalRoot of externalAssetRoots) {
    const overlapsForbiddenRoot = forbiddenPublicRoots.some((forbiddenRoot) => (
      hasPathPrefix(externalRoot, forbiddenRoot) || hasPathPrefix(forbiddenRoot, externalRoot)
    ));
    if (overlapsForbiddenRoot) failures.push(`immutable asset root overlaps forbidden public evidence: ${externalRoot}`);
  }
  const assetRoot = absoluteFrom(sourceRoot, policy.assets.root);
  if (!fs.existsSync(assetRoot)) return { files, bytes: 0, failures: [`missing asset root: ${policy.assets.root}`] };

  function walk(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = normalize(path.relative(sourceRoot, filePath));
      if (entry.isSymbolicLink()) {
        failures.push(`asset tree contains unsupported symbolic link: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (isRuntimeOrSecret(relativePath)) continue;
        if (!shouldWalkAssetDirectory(relativePath)) continue;
        walk(filePath);
        continue;
      }
      if (!entry.isFile() || !isExternalAsset(relativePath)) continue;
      const curatedFailure = validateCuratedAssetFile(relativePath, filePath);
      if (curatedFailure) {
        failures.push(curatedFailure);
        continue;
      }
      const stats = fs.statSync(filePath);
      files.push({
        path: relativePath,
        bytes: stats.size,
        ...(hash ? { sha256: sha256File(filePath) } : {}),
      });
    }
  }
  walk(assetRoot);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const requiredPath of policy.assets.requiredPaths || []) {
    if (!fs.existsSync(absoluteFrom(sourceRoot, requiredPath))) failures.push(`missing required public asset: ${requiredPath}`);
  }
  return {
    files,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    failures,
  };
}

function validateAssetManifest() {
  const failures = [];
  const manifestPath = absoluteFrom(sourceRoot, policy.assets.manifest);
  if (!fs.existsSync(manifestPath)) {
    return {
      failures: [`missing generated asset manifest: ${policy.assets.manifest}; run the assets action first`],
      manifest: null,
      manifestPath,
      manifestSha256: null,
    };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return {
      failures: [`invalid asset manifest JSON: ${error instanceof Error ? error.message : String(error)}`],
      manifest: null,
      manifestPath,
      manifestSha256: sha256File(manifestPath),
    };
  }

  if (manifest.schemaVersion !== 1 || manifest.projectId !== policy.projectId || manifest.kind !== "public-assets") {
    failures.push("asset manifest identity/schema does not match release policy");
  }
  if (!Array.isArray(manifest.files)) failures.push("asset manifest files must be an array");

  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const seen = new Set();
  let totalBytes = 0;
  let previousPath = "";
  for (const file of files) {
    const relativePath = typeof file?.path === "string" ? validateManagedRelativePath(file.path) : "";
    if (!relativePath || !isExternalAsset(relativePath)) failures.push(`asset manifest contains an out-of-bound path: ${String(file?.path)}`);
    if (seen.has(relativePath)) failures.push(`asset manifest contains duplicate path: ${relativePath}`);
    if (previousPath && previousPath.localeCompare(relativePath, "en") > 0) failures.push("asset manifest file list is not canonically sorted");
    if (!Number.isSafeInteger(file?.bytes) || file.bytes < 0) failures.push(`asset manifest has invalid byte size: ${relativePath}`);
    if (!/^[0-9a-f]{64}$/u.test(String(file?.sha256 || ""))) failures.push(`asset manifest has invalid sha256: ${relativePath}`);
    seen.add(relativePath);
    previousPath = relativePath;
    totalBytes += Number.isSafeInteger(file?.bytes) ? file.bytes : 0;
  }

  const digest = canonicalAssetDigest(files);
  if (manifest.fileCount !== files.length) failures.push("asset manifest fileCount does not match files");
  if (manifest.totalBytes !== totalBytes) failures.push("asset manifest totalBytes does not match files");
  if (manifest.assetPolicySha256 !== assetPolicySha256) failures.push("asset manifest policy digest does not match the current asset boundary");
  if (manifest.digest !== digest) failures.push("asset manifest canonical digest does not match files and asset policy");
  if (manifest.assetVersion !== `sha256-${digest}`) failures.push("asset manifest assetVersion is not pinned to its digest");
  if (manifest.mutableUploadsIncluded !== false) failures.push("asset manifest must exclude mutable uploads");

  const coupledPaths = (policy.source.publicSourcePaths || [])
    .map(normalize)
    .filter((relativePath) => isExternalAsset(relativePath));
  for (const relativePath of coupledPaths) {
    const entry = files.find((file) => file.path === relativePath);
    const currentPath = absoluteFrom(sourceRoot, relativePath);
    if (!entry) {
      failures.push(`build-coupled public file is absent from asset manifest: ${relativePath}`);
      continue;
    }
    if (!fs.existsSync(currentPath)) {
      failures.push(`build-coupled public file is absent from source tree: ${relativePath}`);
      continue;
    }
    const stats = fs.statSync(currentPath);
    if (stats.size !== entry.bytes || sha256File(currentPath) !== entry.sha256) {
      failures.push(`build-coupled public file changed after asset manifest generation: ${relativePath}`);
    }
  }
  for (const relativePath of policy.assets.requiredPaths || []) {
    if (!seen.has(normalize(relativePath))) failures.push(`required public asset is absent from asset manifest: ${relativePath}`);
  }

  return {
    failures,
    manifest,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
  };
}

function validateLocalAssetTree(assets, assetManifest) {
  const failures = [];
  const expected = assetManifest.manifest?.files;
  if (!Array.isArray(expected)) return failures;
  if (assets.files.length !== expected.length) {
    failures.push(`local asset tree count does not match pinned manifest: ${assets.files.length} != ${expected.length}`);
    return failures;
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actual = assets.files[index];
    const pinned = expected[index];
    if (actual.path !== pinned.path || actual.bytes !== pinned.bytes || actual.sha256 !== pinned.sha256) {
      failures.push(`local asset tree does not match pinned manifest: ${pinned.path || actual.path}`);
      if (failures.length >= 20) break;
    }
  }
  return failures;
}

function validateManagedSnapshot(source, assetManifest) {
  const failures = [];
  const markerPath = absoluteFrom(sourceRoot, ".release/source-repo.json");
  const sourceManifestPath = absoluteFrom(sourceRoot, ".release/source-files.v1.json");
  if (!fs.existsSync(markerPath) && !fs.existsSync(sourceManifestPath)) return { managed: false, failures };
  if (!fs.existsSync(markerPath) || !fs.existsSync(sourceManifestPath)) {
    return { managed: true, failures: ["managed source snapshot metadata is incomplete"] };
  }
  let marker;
  let snapshot;
  try {
    marker = readJson(markerPath);
    snapshot = readJson(sourceManifestPath);
  } catch (error) {
    return { managed: true, failures: [`managed source snapshot metadata is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (marker.schemaVersion !== 1 || marker.projectId !== policy.projectId || marker.kind !== "managed-clean-source-repository") {
    failures.push("managed source repository marker identity is invalid");
  }
  if (marker.canonicalTextEol !== "lf") failures.push("managed source repository does not declare canonical LF text");
  if (snapshot.schemaVersion !== 1 || snapshot.projectId !== policy.projectId || snapshot.kind !== "clean-source-snapshot") {
    failures.push("managed source snapshot identity is invalid");
  }
  if (snapshot.canonicalTextEol !== "lf") failures.push("managed source snapshot does not declare canonical LF text");
  if (snapshot.policySha256 !== policySha256) failures.push("managed source snapshot policy SHA does not match current policy");
  if (snapshot.sourceFingerprint !== source.fingerprint) failures.push("managed source snapshot fingerprint does not match current files");
  if (snapshot.fileCount !== source.files.length || snapshot.totalBytes !== source.bytes) {
    failures.push("managed source snapshot count/bytes do not match current files");
  }
  if (snapshot.assetManifestSha256 !== assetManifest.manifestSha256) failures.push("managed source snapshot asset manifest SHA mismatch");
  if (snapshot.assetDigest !== assetManifest.manifest?.digest || snapshot.assetVersion !== assetManifest.manifest?.assetVersion) {
    failures.push("managed source snapshot asset identity mismatch");
  }
  const pinnedFiles = Array.isArray(snapshot.files) ? snapshot.files : [];
  if (pinnedFiles.length !== source.files.length) {
    failures.push("managed source snapshot file list length mismatch");
  } else {
    for (let index = 0; index < pinnedFiles.length; index += 1) {
      const pinned = pinnedFiles[index];
      const actual = source.files[index];
      if (pinned.path !== actual.path || pinned.bytes !== actual.bytes || pinned.sha256 !== actual.sha256) {
        failures.push(`managed source snapshot file mismatch: ${pinned.path || actual.path}`);
        if (failures.length >= 20) break;
      }
    }
  }
  return { managed: true, failures };
}

function inspectMigrationWorktree() {
  const migrationRoot = normalize(policy.database?.migrationRoot || "supabase/migrations");
  const rollbackRoot = normalize(policy.database?.rollbackRoot || "supabase/rollbacks");
  const requestedBase = options.get("--base") || process.env.RELEASE_BASE_SHA?.trim() || null;
  const requestedHead = options.get("--head") || process.env.RELEASE_HEAD_SHA?.trim() || null;
  const unavailable = (reason, fatal = false) => ({
    mode: "unavailable",
    migrationRoot,
    rollbackRoot,
    policySha256,
    base: null,
    head: null,
    range: null,
    consumedRelocationReceipts: [],
    modifiedHistoricalMigrations: [],
    deletedHistoricalMigrations: [],
    relocatedHistoricalRollbacks: [],
    invalidMigrationRootEntries: [],
    newForwardMigrations: [],
    failures: fatal || requestedBase || requestedHead ? [reason] : [],
    warning: reason,
  });
  const run = (arguments_) => spawnSync("git", arguments_, {
    cwd: sourceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const runBytes = (arguments_) => spawnSync("git", arguments_, {
    cwd: sourceRoot,
    encoding: null,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.error || inside.status !== 0 || inside.stdout.trim() !== "true") {
    return unavailable("Git worktree is unavailable; migration immutability will be enforced by the database manifest hash gate.");
  }
  if (Boolean(requestedBase) !== Boolean(requestedHead)) {
    return unavailable("migration candidate audit requires both --base and --head (or RELEASE_BASE_SHA and RELEASE_HEAD_SHA)");
  }
  const splitPaths = (value) => Buffer.from(value).toString("utf8").split("\0").map(normalize).filter(Boolean);
  const gitFailure = (label, result) => `${label}: ${result.error?.message || Buffer.from(result.stderr || "").toString("utf8").trim() || "git command failed"}`;
  const resolveCommit = (revision, label) => {
    const result = run(["rev-parse", "--verify", `${revision}^{commit}`]);
    if (result.error || result.status !== 0) throw new Error(gitFailure(`unable to resolve ${label}`, result));
    return result.stdout.trim();
  };
  const treePaths = (commit, rootPath) => {
    const result = runBytes(["ls-tree", "-r", "--name-only", "-z", commit, "--", rootPath]);
    if (result.error || result.status !== 0) throw new Error(gitFailure(`unable to inspect ${commit}:${rootPath}`, result));
    return splitPaths(result.stdout).filter((entry) => entry.endsWith(".sql"));
  };
  const gitObject = (revision, relativePath) => {
    const treeEntry = runBytes(["ls-tree", "-z", revision, "--", relativePath]);
    if (treeEntry.error || treeEntry.status !== 0) throw new Error(gitFailure(`unable to inspect Git tree entry ${revision}:${relativePath}`, treeEntry));
    if (treeEntry.stdout.length === 0) return null;
    const record = treeEntry.stdout.subarray(0, treeEntry.stdout.length - 1).toString("utf8");
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    if (tab < 0 || record.slice(tab + 1) !== relativePath || type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new Error(`Git tree entry is not a regular file: ${revision}:${relativePath}`);
    }
    const bytes = runBytes(["cat-file", "blob", oid]);
    if (bytes.error || bytes.status !== 0) throw new Error(gitFailure(`unable to read Git blob ${revision}:${relativePath}`, bytes));
    return { oid, bytes: bytes.stdout };
  };
  const gitIndexObject = (relativePath) => {
    const entry = runBytes(["ls-files", "--stage", "-z", "--", relativePath]);
    if (entry.error || entry.status !== 0) throw new Error(gitFailure(`unable to inspect index entry ${relativePath}`, entry));
    if (entry.stdout.length === 0) return null;
    const record = entry.stdout.subarray(0, entry.stdout.length - 1).toString("utf8");
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = record.slice(0, tab).split(" ");
    if (tab < 0 || record.slice(tab + 1) !== relativePath || stage !== "0" || !["100644", "100755"].includes(mode)) {
      throw new Error(`index entry is not a regular stage-zero file: ${relativePath}`);
    }
    const bytes = runBytes(["cat-file", "blob", oid]);
    if (bytes.error || bytes.status !== 0) throw new Error(gitFailure(`unable to read index blob ${relativePath}`, bytes));
    return { oid, bytes: bytes.stdout };
  };
  const sameFileIdentity = (left, right) => left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
  const validatePhysicalPath = (relativePath, expectedType) => {
    const normalized = normalize(relativePath);
    if (!normalized || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(normalized)) {
      throw new Error(`physical path escaped sourceRoot: ${relativePath}`);
    }
    const sourceStats = fs.lstatSync(sourceRoot);
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
      throw new Error("sourceRoot is a symlink, junction, reparse point, or non-directory");
    }
    const sourceReal = fs.realpathSync.native(sourceRoot);
    let lexical = sourceRoot;
    const segments = normalized.split("/");
    for (const [index, segment] of segments.entries()) {
      lexical = path.join(lexical, segment);
      const stats = fs.lstatSync(lexical);
      if (stats.isSymbolicLink()) {
        throw new Error(`physical path contains a symlink, junction, or reparse point: ${normalize(path.relative(sourceRoot, lexical))}`);
      }
      const isFinal = index === segments.length - 1;
      if (!isFinal && !stats.isDirectory()) {
        throw new Error(`physical path ancestor is not a directory: ${normalize(path.relative(sourceRoot, lexical))}`);
      }
      if (isFinal && expectedType === "directory" && !stats.isDirectory()) {
        throw new Error(`physical path is not a directory: ${normalized}`);
      }
      if (isFinal && expectedType === "file" && !stats.isFile()) {
        throw new Error(`physical path is not a regular file: ${normalized}`);
      }
      const real = fs.realpathSync.native(lexical);
      const expectedReal = path.join(sourceReal, ...segments.slice(0, index + 1));
      if (!isInside(sourceReal, real) || path.relative(expectedReal, real) !== "") {
        throw new Error(`physical path contains a junction, mount, or reparse redirect: ${normalize(path.relative(sourceRoot, lexical))}`);
      }
    }
  };
  const readStableRegularFile = (filePath, expectedParent) => {
    validatePhysicalPath(normalize(path.relative(sourceRoot, filePath)), "file");
    const beforeParent = fs.lstatSync(expectedParent, { bigint: true });
    if (!beforeParent.isDirectory() || beforeParent.isSymbolicLink()) {
      throw new Error("expected parent is not a regular directory");
    }
    const beforePath = fs.lstatSync(filePath, { bigint: true });
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n) {
      throw new Error("path is not a single-link regular file");
    }
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const beforeFd = fs.fstatSync(descriptor, { bigint: true });
      if (!sameFileIdentity(beforePath, beforeFd)) throw new Error("path identity changed before read");
      const chunks = [];
      const buffer = Buffer.allocUnsafe(64 * 1024);
      while (true) {
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      const afterFd = fs.fstatSync(descriptor, { bigint: true });
      const afterPath = fs.lstatSync(filePath, { bigint: true });
      const afterParent = fs.lstatSync(expectedParent, { bigint: true });
      if (!sameFileIdentity(beforeFd, afterFd) || !sameFileIdentity(afterFd, afterPath)) {
        throw new Error("path identity changed during read");
      }
      if (!sameFileIdentity(beforeParent, afterParent)) throw new Error("parent identity changed during read");
      const realParent = fs.realpathSync(expectedParent);
      const realFile = fs.realpathSync(filePath);
      if (path.dirname(realFile) !== realParent) throw new Error("path resolved outside its expected parent");
      return Buffer.concat(chunks);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const walkSqlFiles = (rootRelative, traversalFailures) => {
    const rootAbsolute = absoluteFrom(sourceRoot, rootRelative);
    if (!fs.existsSync(rootAbsolute)) return [];
    try {
      validatePhysicalPath(rootRelative, "directory");
    } catch (error) {
      traversalFailures.push(error instanceof Error ? error.message : String(error));
      return [];
    }
    const found = [];
    const pending = [rootAbsolute];
    while (pending.length > 0) {
      const directory = pending.pop();
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, item.name);
        const relative = normalize(path.relative(sourceRoot, absolute));
        if (item.isSymbolicLink()) {
          traversalFailures.push(`migration filesystem contains a symbolic link: ${relative}`);
        } else if (item.isDirectory()) {
          try {
            validatePhysicalPath(relative, "directory");
            pending.push(absolute);
          } catch (error) {
            traversalFailures.push(error instanceof Error ? error.message : String(error));
          }
        } else if (item.isFile() && relative.endsWith(".sql")) {
          try {
            validatePhysicalPath(relative, "file");
            found.push(relative);
          } catch (error) {
            traversalFailures.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
    }
    return found.sort((left, right) => left.localeCompare(right, "en"));
  };
  const canonicalForwardName = /^\d{14}_[a-z0-9_]+\.sql$/u;
  const legacyRollbackName = /^\d{14}_[a-z0-9_]+\.rollback\.sql$/u;
  const isCanonicalForwardPath = (entry) => path.posix.dirname(entry) === migrationRoot
    && canonicalForwardName.test(path.posix.basename(entry));
  const isSafePolicyPath = (entry) => typeof entry === "string"
    && entry === normalize(entry)
    && !path.posix.isAbsolute(entry)
    && entry !== ".."
    && !entry.startsWith("../")
    && !entry.includes("/../")
    && !entry.includes(":")
    && !entry.includes("\0");

  const relocationPolicyFailures = [];
  const relocationByFrom = new Map();
  const relocationTargets = new Set();
  const configuredRelocations = policy.database?.legacyRollbackRelocations;
  const relocationAuditPolicy = policy.database?.legacyRollbackRelocationAudit;
  if (!relocationAuditPolicy
    || relocationAuditPolicy.schemaVersion !== 1
    || relocationAuditPolicy.requireExplicitCandidateRange !== true
    || relocationAuditPolicy.candidateMode !== "git-tree-and-blob-only"
    || relocationAuditPolicy.dirtyMode !== "head-index-worktree-bound"
    || relocationAuditPolicy.receiptBinding !== "base-head-policy-sha256-old-new-git-blob") {
    relocationPolicyFailures.push("legacy rollback relocation audit policy is missing or unsupported");
  }
  if (configuredRelocations !== undefined && !Array.isArray(configuredRelocations)) {
    relocationPolicyFailures.push("legacy rollback relocation policy must be an array");
  }
  for (const [index, candidate] of (Array.isArray(configuredRelocations) ? configuredRelocations : []).entries()) {
    const from = candidate && typeof candidate === "object" ? candidate.from : null;
    const to = candidate && typeof candidate === "object" ? candidate.to : null;
    const expectedSha256 = candidate && typeof candidate === "object" ? candidate.sha256 : null;
    const name = typeof from === "string" ? path.posix.basename(from) : "";
    const valid = isSafePolicyPath(from)
      && isSafePolicyPath(to)
      && path.posix.dirname(from) === `${migrationRoot}/rollback`
      && path.posix.dirname(to) === rollbackRoot
      && path.posix.basename(to) === name
      && legacyRollbackName.test(name)
      && typeof expectedSha256 === "string"
      && /^[0-9a-f]{64}$/u.test(expectedSha256);
    if (!valid) {
      relocationPolicyFailures.push(`legacy rollback relocation policy entry ${index} is invalid`);
      continue;
    }
    if (relocationByFrom.has(from) || relocationTargets.has(to)) {
      relocationPolicyFailures.push(`legacy rollback relocation policy entry ${index} duplicates a source or target`);
      continue;
    }
    const receipt = { from, to, sha256: expectedSha256 };
    relocationByFrom.set(from, receipt);
    relocationTargets.add(to);
  }

  let base;
  let candidateHead;
  let mode;
  let historicalPaths;
  let currentPaths;
  let readBaseObject;
  let readCandidateObject;
  const bindingFailures = [];
  const traversalFailures = [];
  try {
    if (requestedBase && requestedHead) {
      base = resolveCommit(requestedBase, "candidate base");
      candidateHead = resolveCommit(requestedHead, "candidate head");
      const ancestry = run(["merge-base", "--is-ancestor", base, candidateHead]);
      if (ancestry.error || ancestry.status !== 0) throw new Error("candidate base is not an ancestor of candidate head");
      const relativePolicyPath = normalize(path.relative(sourceRoot, policyPath));
      if (!isSafePolicyPath(relativePolicyPath)) throw new Error("release policy is outside the candidate repository");
      const candidatePolicy = gitObject(candidateHead, relativePolicyPath);
      if (!candidatePolicy || !candidatePolicy.bytes.equals(policyBytes)) {
        throw new Error("loaded release policy does not match the candidate-head Git blob");
      }
      historicalPaths = new Set(treePaths(base, migrationRoot));
      currentPaths = treePaths(candidateHead, migrationRoot);
      readBaseObject = (entry) => gitObject(base, entry);
      readCandidateObject = (entry) => gitObject(candidateHead, entry);
      mode = "git-range-candidate";
    } else {
      base = resolveCommit("HEAD", "HEAD baseline");
      validatePhysicalPath(migrationRoot, "directory");
      validatePhysicalPath(rollbackRoot, "directory");
      const repositoryStatus = runBytes(["status", "--porcelain=v1", "-z"]);
      if (repositoryStatus.error || repositoryStatus.status !== 0) {
        throw new Error(gitFailure("unable to inspect repository status", repositoryStatus));
      }
      if (repositoryStatus.stdout.length === 0 && relocationAuditPolicy?.requireExplicitCandidateRange === true) {
        bindingFailures.push("clean candidate requires an explicit trusted --base and --head Git commit range");
      }
      const staged = runBytes(["diff", "--cached", "--name-only", "-z", "HEAD", "--", migrationRoot, rollbackRoot]);
      const unstaged = runBytes(["diff", "--name-only", "-z", "--", migrationRoot, rollbackRoot]);
      const untracked = runBytes(["ls-files", "--others", "--exclude-standard", "-z", "--", migrationRoot, rollbackRoot]);
      for (const [label, result] of [["staged candidate diff", staged], ["worktree candidate diff", unstaged], ["untracked candidate inventory", untracked]]) {
        if (result.error || result.status !== 0) throw new Error(gitFailure(`unable to inspect ${label}`, result));
      }
      const stagedPaths = splitPaths(staged.stdout);
      const unstagedPaths = splitPaths(unstaged.stdout);
      const untrackedPaths = splitPaths(untracked.stdout);
      const indexMode = stagedPaths.length > 0;
      if (indexMode && (unstagedPaths.length > 0 || untrackedPaths.length > 0)) {
        bindingFailures.push("index/worktree candidate mismatch: staged migration candidate must have no unstaged or untracked migration/rollback paths");
      }
      historicalPaths = new Set(treePaths(base, migrationRoot));
      currentPaths = walkSqlFiles(migrationRoot, traversalFailures);
      readBaseObject = (entry) => gitObject(base, entry);
      if (indexMode) {
        readCandidateObject = (entry) => gitIndexObject(entry);
        candidateHead = "INDEX";
        mode = "git-head-bound-index";
      } else {
        readCandidateObject = (entry) => {
          const absolute = absoluteFrom(sourceRoot, entry);
          if (!fs.existsSync(absolute)) return null;
          const bytes = readStableRegularFile(absolute, path.dirname(absolute));
          return { oid: `worktree-sha256:${sha256Buffer(bytes)}`, bytes };
        };
        candidateHead = "WORKTREE";
        mode = "git-head-bound-worktree";
      }
    }
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error), true);
  }

  const currentPathSet = new Set(currentPaths);
  const safelyReadObject = (reader, entry, label) => {
    try {
      return reader(entry);
    } catch (error) {
      bindingFailures.push(`${label} (${entry}): ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const modifiedHistoricalMigrations = [];
  const deletedHistoricalCandidates = [];
  for (const entry of historicalPaths) {
    const baseObject = safelyReadObject(readBaseObject, entry, "unable to read audit-base migration");
    const candidateObject = currentPathSet.has(entry)
      ? safelyReadObject(readCandidateObject, entry, "unable to read candidate migration")
      : null;
    if (!candidateObject) deletedHistoricalCandidates.push(entry);
    else if (!baseObject || !baseObject.bytes.equals(candidateObject.bytes)) modifiedHistoricalMigrations.push(entry);
  }
  modifiedHistoricalMigrations.sort((left, right) => left.localeCompare(right, "en"));
  deletedHistoricalCandidates.sort((left, right) => left.localeCompare(right, "en"));
  const deletedHistoricalMigrations = [];
  const relocatedHistoricalRollbacks = [];
  const consumedRelocationReceipts = [];
  const relocationFailures = [];
  for (const entry of deletedHistoricalCandidates) {
    const receipt = relocationByFrom.get(entry);
    if (!receipt) {
      deletedHistoricalMigrations.push(entry);
      continue;
    }
    const sourceObject = safelyReadObject(readBaseObject, entry, "unable to read relocation source");
    const preexistingTargetObject = safelyReadObject(readBaseObject, receipt.to, "unable to inspect relocation target in audit base");
    const targetObject = safelyReadObject(readCandidateObject, receipt.to, "unable to read relocation target");
    const failures = [];
    if (!sourceObject) failures.push("base source blob is unavailable");
    if (preexistingTargetObject) failures.push("target already existed in the audit base");
    if (!targetObject) failures.push("target is missing from the candidate");
    if (mode === "git-head-bound-worktree") {
      const visible = runBytes(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", receipt.to]);
      if (visible.error || visible.status !== 0 || !splitPaths(visible.stdout).includes(receipt.to)) {
        failures.push("target is not Git-visible (it may be ignored)");
      }
    }
    const sourceSha256 = sourceObject ? sha256Buffer(sourceObject.bytes) : null;
    const targetSha256 = targetObject ? sha256Buffer(targetObject.bytes) : null;
    if (sourceSha256 !== receipt.sha256) failures.push("base source blob sha256 does not match the relocation receipt");
    if (targetSha256 !== receipt.sha256) failures.push("target sha256 does not match the relocation receipt");
    if (!sourceObject || !targetObject || !sourceObject.bytes.equals(targetObject.bytes)) {
      failures.push("base source blob and relocation target bytes differ");
    }
    if (failures.length > 0) {
      deletedHistoricalMigrations.push(entry);
      relocationFailures.push(`legacy rollback relocation rejected (${entry}): ${[...new Set(failures)].join("; ")}`);
      continue;
    }
    const consumedReceipt = {
      from: receipt.from,
      to: receipt.to,
      sha256: receipt.sha256,
      bytes: sourceObject.bytes.length,
      base,
      head: candidateHead,
      policySha256,
      oldBlob: sourceObject.oid,
      newBlob: targetObject.oid,
    };
    relocatedHistoricalRollbacks.push(consumedReceipt);
    consumedRelocationReceipts.push(consumedReceipt);
  }
  for (const receipt of relocationByFrom.values()) {
    if (!consumedRelocationReceipts.some((entry) => entry.from === receipt.from)) {
      relocationFailures.push(`configured legacy rollback relocation receipt was not consumed in this candidate: ${receipt.from}`);
    }
  }
  const invalidMigrationRootEntries = [...new Set([
    ...currentPaths.filter((entry) => !isCanonicalForwardPath(entry)),
    ...[...historicalPaths].filter((entry) => !isCanonicalForwardPath(entry) && !relocationByFrom.has(entry)),
  ])]
    .sort((left, right) => left.localeCompare(right, "en"));
  const newForwardMigrations = currentPaths
    .filter((entry) => !historicalPaths.has(entry) && isCanonicalForwardPath(entry))
    .sort((left, right) => left.localeCompare(right, "en"));
  const failures = [
    ...relocationPolicyFailures,
    ...bindingFailures,
    ...traversalFailures,
    ...modifiedHistoricalMigrations.map((entry) => `historical migration changed relative to audit base; restore it and use a new forward-only migration: ${entry}`),
    ...deletedHistoricalMigrations.map((entry) => `historical migration deleted relative to audit base; restore it and use a new forward-only migration: ${entry}`),
    ...invalidMigrationRootEntries.map((entry) => `migration root contains a non-canonical or nested SQL entry: ${entry}`),
    ...relocationFailures,
  ];
  return {
    mode,
    migrationRoot,
    rollbackRoot,
    policySha256,
    base,
    head: candidateHead,
    range: `${base}..${candidateHead}`,
    consumedRelocationReceipts,
    modifiedHistoricalMigrations,
    deletedHistoricalMigrations,
    relocatedHistoricalRollbacks,
    invalidMigrationRootEntries,
    newForwardMigrations,
    failures,
    warning: null,
  };
}

function printMigrationAudit() {
  const migrationSource = inspectMigrationWorktree();
  const result = {
    status: migrationSource.failures.length === 0 ? "PASS" : "FAIL",
    projectId: policy.projectId,
    migrationSource: {
      mode: migrationSource.mode,
      migrationRoot: migrationSource.migrationRoot,
      rollbackRoot: migrationSource.rollbackRoot,
      policySha256: migrationSource.policySha256,
      base: migrationSource.base,
      head: migrationSource.head,
      range: migrationSource.range,
      consumedRelocationReceipts: migrationSource.consumedRelocationReceipts,
      historicalMigrationMutationAllowed: false,
      modifiedHistoricalMigrations: migrationSource.modifiedHistoricalMigrations,
      deletedHistoricalMigrations: migrationSource.deletedHistoricalMigrations,
      relocatedHistoricalRollbacks: migrationSource.relocatedHistoricalRollbacks,
      invalidMigrationRootEntries: migrationSource.invalidMigrationRootEntries,
      newForwardMigrations: migrationSource.newForwardMigrations,
      warning: migrationSource.warning,
    },
    failures: migrationSource.failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
}

function printAudit() {
  const source = collectSourceFiles();
  const assetManifest = validateAssetManifest();
  const managedSnapshot = validateManagedSnapshot(source, assetManifest);
  const migrationSource = inspectMigrationWorktree();
  const assets = managedSnapshot.managed
    ? {
        files: assetManifest.manifest?.files || [],
        bytes: assetManifest.manifest?.totalBytes || 0,
        failures: [],
      }
    : collectAssetFiles({ hash: true });
  const assetContentFailures = managedSnapshot.managed ? [] : validateLocalAssetTree(assets, assetManifest);
  const failures = [
    ...source.failures,
    ...assets.failures,
    ...assetManifest.failures,
    ...managedSnapshot.failures,
    ...assetContentFailures,
    ...migrationSource.failures,
  ];
  const result = {
    status: failures.length === 0 ? "PASS" : "FAIL",
    projectId: policy.projectId,
    policySha256,
    source: {
      files: source.files.length,
      bytes: source.bytes,
      maxBytes: policy.source.maxBytes,
      fingerprint: source.fingerprint,
    },
    externalAssets: {
      files: assets.files.length,
      bytes: assets.bytes,
      pinnedDigest: assetManifest.manifest?.digest || null,
      manifestSha256: assetManifest.manifestSha256,
      mutableUploadsExcluded: true,
      verification: managedSnapshot.managed ? "pinned-manifest-from-managed-source" : "full-local-sha256",
    },
    mutablePathsExcluded: policy.runtime.mutablePaths,
    migrationSource: {
      mode: migrationSource.mode,
      migrationRoot: migrationSource.migrationRoot,
      rollbackRoot: migrationSource.rollbackRoot,
      policySha256: migrationSource.policySha256,
      base: migrationSource.base,
      head: migrationSource.head,
      range: migrationSource.range,
      consumedRelocationReceipts: migrationSource.consumedRelocationReceipts,
      historicalMigrationMutationAllowed: false,
      modifiedHistoricalMigrations: migrationSource.modifiedHistoricalMigrations,
      deletedHistoricalMigrations: migrationSource.deletedHistoricalMigrations,
      relocatedHistoricalRollbacks: migrationSource.relocatedHistoricalRollbacks,
      invalidMigrationRootEntries: migrationSource.invalidMigrationRootEntries,
      newForwardMigrations: migrationSource.newForwardMigrations,
      warning: migrationSource.warning,
    },
    failures,
  };
  console.log(JSON.stringify(result, null, 2));
  if (options.get("--json")) writeJsonAtomic(path.resolve(options.get("--json")), result);
  if (failures.length > 0) process.exit(1);
}

function createAssetManifest() {
  if (options.get("--write") !== "1") {
    stop("asset manifest generation is write-protected; pass --write after reviewing the asset boundary", 2);
  }
  const assets = collectAssetFiles({ hash: true });
  if (assets.failures.length > 0) stop(assets.failures.join("; "));
  const digest = canonicalAssetDigest(assets.files);
  const manifest = {
    schemaVersion: 1,
    projectId: policy.projectId,
    kind: "public-assets",
    assetPolicySha256,
    contentAddressing: "sha256-files-and-asset-policy",
    assetVersion: `sha256-${digest}`,
    files: assets.files,
    fileCount: assets.files.length,
    totalBytes: assets.bytes,
    digest,
    mutableUploadsIncluded: false,
  };
  const outputPath = path.resolve(sourceRoot, options.get("--output") || policy.assets.manifest);
  if (!isInside(sourceRoot, outputPath)) stop("asset manifest output must remain inside the source root", 2);
  writeJsonAtomic(outputPath, manifest);
  console.log(`PASS asset manifest: ${assets.files.length} files, ${assets.bytes} bytes, sha256=${digest}`);
  console.log(`WROTE ${outputPath}`);
}

function sourceManifest(source) {
  const assetManifest = validateAssetManifest();
  if (assetManifest.failures.length > 0) stop(assetManifest.failures.join("; "));
  return {
    schemaVersion: 1,
    projectId: policy.projectId,
    kind: "clean-source-snapshot",
    canonicalTextEol: "lf",
    policySha256,
    sourceFingerprint: source.fingerprint,
    assetManifestSha256: assetManifest.manifestSha256,
    assetDigest: assetManifest.manifest.digest,
    assetVersion: assetManifest.manifest.assetVersion,
    fileCount: source.files.length,
    totalBytes: source.bytes,
    files: source.files.map(({ path: relativePath, bytes, sha256 }) => ({ path: relativePath, bytes, sha256 })),
  };
}

function assertFactSourceReleaseInputs() {
  const assetManifest = validateAssetManifest();
  const assets = collectAssetFiles({ hash: true });
  const failures = [
    ...assets.failures,
    ...assetManifest.failures,
    ...validateLocalAssetTree(assets, assetManifest),
  ];
  if (failures.length > 0) stop(`pre-snapshot asset gate failed: ${failures.join("; ")}`);

  for (const relativePath of policy.source.preSnapshotVerifiers || []) {
    const normalized = validateManagedRelativePath(relativePath);
    const verifierPath = absoluteFrom(sourceRoot, normalized);
    if (!isInside(sourceRoot, verifierPath) || !fs.existsSync(verifierPath) || fs.lstatSync(verifierPath).isSymbolicLink()) {
      stop(`pre-snapshot verifier is missing or unsafe: ${normalized}`, 2);
    }
    const result = spawnSync(process.execPath, [verifierPath], {
      cwd: sourceRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      stop(`pre-snapshot verifier failed (${normalized}): ${result.error?.message || result.stderr || result.stdout}`);
    }
  }
}

function markerDocument() {
  return {
    schemaVersion: 1,
    projectId: policy.projectId,
    kind: "managed-clean-source-repository",
    managedBy: "scripts/release-workflow.mjs",
    canonicalTextEol: "lf",
    mutableDataIncluded: false,
    publicBinaryAssetsIncluded: false,
  };
}

function assertSafeManagedTarget(destinationRoot, relativePath) {
  const normalized = validateManagedRelativePath(relativePath);
  if (!fs.existsSync(destinationRoot)) stop(`managed destination does not exist: ${destinationRoot}`, 2);
  if (fs.lstatSync(destinationRoot).isSymbolicLink()) stop(`managed destination cannot be a symbolic link: ${destinationRoot}`, 2);
  const resolvedRoot = fs.realpathSync(destinationRoot);
  const target = absoluteFrom(resolvedRoot, normalized);
  if (!isInside(resolvedRoot, target)) stop(`managed target escapes destination: ${normalized}`, 2);

  let current = resolvedRoot;
  for (const segment of normalized.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) stop(`managed target traverses a symbolic link: ${normalized}`, 2);
    if (!fs.statSync(current).isDirectory()) stop(`managed target parent is not a directory: ${normalized}`, 2);
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) stop(`managed target is a symbolic link: ${normalized}`, 2);
  return target;
}

function copyManagedFile(file, destinationRoot) {
  const destination = assertSafeManagedTarget(destinationRoot, file.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.sync-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, canonicalSourceBuffer(file.absolutePath, file.path));
  if (sha256File(temporary) !== file.sha256) {
    fs.rmSync(temporary, { force: true });
    stop(`staged copy hash mismatch: ${file.path}`);
  }
  fs.chmodSync(temporary, fs.statSync(file.absolutePath).mode);
  if (!fs.existsSync(destination)) {
    fs.renameSync(temporary, destination);
    return;
  }
  const previous = `${destination}.previous-${process.pid}-${crypto.randomUUID()}`;
  fs.renameSync(destination, previous);
  try {
    fs.renameSync(temporary, destination);
    fs.rmSync(previous, { force: true });
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(destination) && fs.existsSync(previous)) fs.renameSync(previous, destination);
    throw error;
  }
}

function writeRepositoryMetadata(destinationRoot, manifest) {
  writeJsonAtomic(absoluteFrom(destinationRoot, ".release/source-repo.json"), markerDocument());
  writeJsonAtomic(absoluteFrom(destinationRoot, ".release/source-files.v1.json"), manifest);
}

function createSnapshot() {
  const outputOption = options.get("--output");
  if (!outputOption) stop("snapshot requires --output <new-directory>", 2);
  const finalOutputRoot = path.resolve(outputOption);
  if (fs.existsSync(finalOutputRoot)) stop(`refusing to overwrite existing snapshot directory: ${finalOutputRoot}`, 2);
  if (isInside(sourceRoot, finalOutputRoot) || isInside(finalOutputRoot, sourceRoot)) {
    stop("snapshot output must be an adjacent directory, not inside or above the source root", 2);
  }
  const source = collectSourceFiles();
  if (source.failures.length > 0) stop(source.failures.join("; "));
  assertFactSourceReleaseInputs();
  const manifest = sourceManifest(source);
  const outputParent = path.dirname(finalOutputRoot);
  const stagingPrefix = `.${path.basename(finalOutputRoot)}.snapshot-staging-`;
  const outputRoot = path.join(outputParent, `${stagingPrefix}${process.pid}-${crypto.randomUUID()}`);
  let snapshotCommitted = false;
  function cleanupSnapshotStaging() {
    if (snapshotCommitted || !fs.existsSync(outputRoot)) return;
    const resolved = path.resolve(outputRoot);
    if (path.dirname(resolved) !== outputParent || !path.basename(resolved).startsWith(stagingPrefix)) {
      console.error(`REFUSED unsafe snapshot staging cleanup: ${resolved}`);
      return;
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  process.once("exit", cleanupSnapshotStaging);
  fs.mkdirSync(outputRoot, { recursive: false });
  for (const file of source.files) copyManagedFile(file, outputRoot);
  writeRepositoryMetadata(outputRoot, manifest);
  fs.renameSync(outputRoot, finalOutputRoot);
  snapshotCommitted = true;
  console.log(`PASS clean source snapshot: ${finalOutputRoot}`);
  console.log(`SOURCE ${source.files.length} files, ${source.bytes} bytes, sha256=${source.fingerprint}`);
}

function refreshSourceMetadata() {
  const source = collectSourceFiles();
  if (source.failures.length > 0) stop(source.failures.join("; "));
  assertFactSourceReleaseInputs();
  const manifest = sourceManifest(source);
  writeRepositoryMetadata(sourceRoot, manifest);
  console.log(`PASS refreshed source metadata: ${sourceRoot}`);
  console.log(`SOURCE ${source.files.length} files, ${source.bytes} bytes, sha256=${source.fingerprint}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function gitStatus(destinationRoot) {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: destinationRoot,
    encoding: "utf8",
  });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: destinationRoot,
    encoding: "utf8",
  });
  if (status.status !== 0) stop(`unable to inspect destination Git status: ${status.stderr || status.stdout}`);
  return status.stdout;
}

function gitVisibleFiles(destinationRoot) {
  const files = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: destinationRoot,
    encoding: "utf8",
  });
  if (files.status !== 0) stop(`unable to enumerate destination Git files: ${files.stderr || files.stdout}`);
  return files.stdout.split("\0")
    .filter(Boolean)
    .map(validateManagedRelativePath)
    .filter((relativePath) => {
      const filePath = absoluteFrom(destinationRoot, relativePath);
      if (!fs.existsSync(filePath)) return false;
      if (fs.lstatSync(filePath).isSymbolicLink()) stop(`Git worktree contains an unsupported symbolic link: ${relativePath}`, 2);
      return fs.statSync(filePath).isFile();
    })
    .sort((left, right) => left.localeCompare(right, "en"));
}

function isSafelyIgnoredLegacyManagedFile(destinationRoot, relativePath, manifestByPath) {
  const manifestFile = manifestByPath.get(relativePath);
  if (!manifestFile?.sha256 || !isExcluded(relativePath)) return false;
  const filePath = assertSafeManagedTarget(destinationRoot, relativePath);
  if (!fs.existsSync(filePath)) return false;
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) return false;
  if (sha256File(filePath) !== manifestFile.sha256) return false;
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], {
    cwd: destinationRoot,
    encoding: "utf8",
  });
  return ignored.status === 0;
}

function assertRepositoryReconciliation(destinationRoot, manifest) {
  if (gitStatus(destinationRoot) === null) return;
  const expected = [
    ...(manifest.files || []).map((file) => validateManagedRelativePath(file.path)),
    ".release/source-files.v1.json",
    ".release/source-repo.json",
  ].sort((left, right) => left.localeCompare(right, "en"));
  const visible = gitVisibleFiles(destinationRoot);
  if (visible.length !== expected.length || visible.some((file, index) => file !== expected[index])) {
    const expectedSet = new Set(expected);
    const visibleSet = new Set(visible);
    const extra = visible.filter((file) => !expectedSet.has(file));
    const missing = expected.filter((file) => !visibleSet.has(file));
    const manifestByPath = new Map((manifest.files || []).map((file) => [validateManagedRelativePath(file.path), file]));
    const safelyIgnored = missing.filter((relativePath) => isSafelyIgnoredLegacyManagedFile(destinationRoot, relativePath, manifestByPath));
    const unresolvedMissing = missing.filter((relativePath) => !safelyIgnored.includes(relativePath));
    if (extra.length > 0 || unresolvedMissing.length > 0) {
      stop(`managed repository reconciliation failed; extra=${JSON.stringify(extra)} missing=${JSON.stringify(unresolvedMissing)}`, 2);
    }
    if (safelyIgnored.length > 0) {
      console.warn(`WARN allowing exact-hash cleanup of ignored runtime files from the previous managed manifest: ${JSON.stringify(safelyIgnored)}`);
    }
  }
}

function syncSnapshot() {
  if (options.get("--apply") === "1") {
    try { assertLocalReleaseAccepted(sourceRoot); }
    catch (error) { stop(error.message, 2); }
  }
  const outputOption = options.get("--output");
  if (!outputOption) stop("sync requires --output <managed-git-worktree>", 2);
  const outputRoot = path.resolve(outputOption);
  if (!fs.existsSync(outputRoot)) stop("sync destination does not exist; create the first snapshot instead", 2);
  if (fs.lstatSync(outputRoot).isSymbolicLink()) stop("sync destination cannot be a symbolic link", 2);
  if (isInside(sourceRoot, outputRoot) || isInside(outputRoot, sourceRoot)) stop("sync destination must be adjacent to the source root", 2);

  const markerPath = absoluteFrom(outputRoot, ".release/source-repo.json");
  const previousManifestPath = absoluteFrom(outputRoot, ".release/source-files.v1.json");
  if (!fs.existsSync(markerPath) || !fs.existsSync(previousManifestPath)) stop("destination is not a managed clean source repository", 2);
  const marker = readJson(markerPath);
  if (marker.projectId !== policy.projectId || marker.kind !== "managed-clean-source-repository") {
    stop("destination marker does not match this project", 2);
  }

  const status = gitStatus(outputRoot);
  if (status === null) stop("sync destination must be a Git worktree", 2);
  if (options.get("--apply") === "1" && status) stop("destination Git worktree must be clean before sync", 2);
  const source = collectSourceFiles();
  if (source.failures.length > 0) stop(source.failures.join("; "));
  assertFactSourceReleaseInputs();
  const nextManifest = sourceManifest(source);
  const previousManifest = readJson(previousManifestPath);
  if (options.get("--apply") === "1") assertRepositoryReconciliation(outputRoot, previousManifest);
  const previousByPath = new Map((previousManifest.files || []).map((file) => [file.path, file]));
  const nextByPath = new Map(nextManifest.files.map((file) => [file.path, file]));

  const added = [];
  const updated = [];
  const deleted = [];
  for (const file of nextManifest.files) {
    const previous = previousByPath.get(file.path);
    if (!previous) added.push(file.path);
    else if (previous.sha256 !== file.sha256 || !fs.existsSync(absoluteFrom(outputRoot, file.path))) updated.push(file.path);
  }
  for (const file of previousManifest.files || []) {
    if (!nextByPath.has(file.path)) deleted.push(file.path);
  }
  const plan = {
    projectId: policy.projectId,
    mode: options.get("--apply") === "1" ? "apply" : "plan",
    added,
    updated,
    deleted,
    unchanged: nextManifest.files.length - added.length - updated.length,
    nextSourceFingerprint: nextManifest.sourceFingerprint,
  };
  console.log(JSON.stringify(plan, null, 2));
  if (options.get("--apply") !== "1") {
    console.log("PLAN ONLY: pass --apply after reviewing this bounded file list.");
    return;
  }

  const sourceByPath = new Map(source.files.map((file) => [file.path, file]));
  const stagingRoot = `${outputRoot}.sync-staging-${process.pid}-${crypto.randomUUID()}`;
  if (fs.existsSync(stagingRoot)) stop(`unexpected sync staging collision: ${stagingRoot}`);
  fs.mkdirSync(stagingRoot, { recursive: false });
  try {
    for (const relativePath of [...added, ...updated]) copyManagedFile(sourceByPath.get(relativePath), stagingRoot);
    for (const relativePath of [...added, ...updated]) {
      const staged = absoluteFrom(stagingRoot, relativePath);
      const expected = sourceByPath.get(relativePath);
      copyManagedFile({ ...expected, absolutePath: staged }, outputRoot);
    }
    for (const relativePath of deleted) {
      const target = assertSafeManagedTarget(outputRoot, relativePath);
      const previous = previousByPath.get(relativePath);
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile()) stop(`refusing to delete non-file managed path: ${relativePath}`);
        if (previous?.sha256 && sha256File(target) !== previous.sha256) stop(`managed deletion target changed unexpectedly: ${relativePath}`);
        fs.rmSync(target);
      }
    }
    writeRepositoryMetadata(outputRoot, nextManifest);
    assertRepositoryReconciliation(outputRoot, nextManifest);
  } finally {
    if (fs.existsSync(stagingRoot) && path.dirname(stagingRoot) === path.dirname(outputRoot)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  console.log("PASS managed source sync applied; review Git diff, run verification, then commit.");
}

function gitChangedFiles(repositoryRoot, base) {
  const command = base
    ? ["diff", "--name-only", "-z", `${base}...HEAD`]
    : ["diff", "--name-only", "-z", "HEAD"];
  const diff = spawnSync("git", command, { cwd: repositoryRoot, encoding: "utf8" });
  if (diff.status !== 0) stop(`unable to classify Git changes: ${diff.stderr || diff.stdout}`);
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repositoryRoot, encoding: "utf8" });
  if (untracked.status !== 0) stop(`unable to inspect Git untracked files: ${untracked.stderr || untracked.stdout}`);
  const files = new Set(diff.stdout.split("\0").map(normalize).filter(Boolean));
  for (const relativePath of untracked.stdout.split("\0").map(normalize).filter(Boolean)) files.add(relativePath);
  return [...files].sort();
}

function classifyChanges() {
  const explicitFiles = options.get("--files");
  const repositoryRoot = path.resolve(options.get("--repo") || process.cwd());
  const files = explicitFiles
    ? explicitFiles.split(/[;,]/u).map(normalize).filter(Boolean)
    : gitChangedFiles(repositoryRoot, options.get("--base"));

  let web = false;
  let voice = false;
  let assets = false;
  let migration = false;
  let deployment = false;
  let otherCode = false;
  for (const relativePath of files) {
    const assetManifestPath = normalize(policy.assets.manifest);
    const assetMetadata = relativePath === assetManifestPath || hasPathPrefix(relativePath, "deploy/manifests/public-asset");
    if (hasPathPrefix(relativePath, "supabase/migrations") || hasPathPrefix(relativePath, "voice-platform/prisma")) migration = true;
    if (
      (!assetMetadata && hasPathPrefix(relativePath, "deploy"))
      || hasPathPrefix(relativePath, ".github/workflows")
      || relativePath === "Dockerfile"
      || relativePath === ".dockerignore"
      || /^scripts\/(?:build-release-vnext|deploy-|package-standalone|publish-public-assets|release-workflow)/u.test(relativePath)
    ) deployment = true;
    if (hasPathPrefix(relativePath, "voice-platform")) voice = true;
    if (hasPathPrefix(relativePath, "public") || assetMetadata) assets = true;
    if ((policy.source.requiredBuildPaths || []).map(normalize).includes(relativePath)) web = true;
    if (hasPathPrefix(relativePath, "src") || ["next.config.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"].includes(relativePath)) web = true;
    if (hasPathPrefix(relativePath, "scripts") && !/verify|test/iu.test(relativePath)) otherCode = true;
  }
  if (otherCode) web = true;

  let mode = "DOCS";
  if (migration || deployment || (web && voice)) mode = "FULL";
  else if (web) mode = "WEB";
  else if (voice) mode = "VOICE";
  else if (assets) mode = "ASSET";
  const targets = mode === "FULL"
    ? [assets ? "ASSET" : null, "WEB", "VOICE"].filter(Boolean)
    : [assets ? "ASSET" : null, web ? "WEB" : null, voice ? "VOICE" : null].filter(Boolean);
  if (targets.length === 0) targets.push("DOCS");
  const result = {
    mode,
    targets,
    changedFiles: files,
    services: mode === "FULL" ? ["web", "voice"] : [web ? "web" : null, voice ? "voice" : null].filter(Boolean),
    assets,
    migration,
    rules: {
      serverFilePatchAllowed: false,
      rebuildAffectedServiceArtifact: mode !== "DOCS" && mode !== "ASSET",
      databaseMigrationRunsSeparately: migration,
      assetBeforeWeb: assets && (web || mode === "FULL"),
      dualPointerAtomicityClaimAllowed: false,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (options.get("--output")) writeJsonAtomic(path.resolve(options.get("--output")), result);
}

function remoteHost(remoteUrl) {
  const value = remoteUrl.trim();
  if (!value || /^[A-Za-z]:[\\/]|^\.{0,2}[\\/]|^file:/iu.test(value)) return null;
  const scpLike = value.match(/^[^@\s]+@([^:\s]+):(.+)$/u);
  if (scpLike) return scpLike[1].toLowerCase();
  try {
    const parsed = new URL(value);
    if (!["https:", "ssh:"].includes(parsed.protocol) || !parsed.hostname || parsed.password) return null;
    if (parsed.protocol === "https:" && parsed.username) return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function gitCommand(repositoryRoot, arguments_) {
  const result = spawnSync("git", arguments_, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) stop(`git ${arguments_.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout}`, 2);
  return result.stdout.trim();
}

function verifyManagedGitRepository() {
  const repositoryRoot = path.resolve(options.get("--repo") || process.cwd());
  const topLevel = path.resolve(gitCommand(repositoryRoot, ["rev-parse", "--show-toplevel"]));
  if (topLevel.toLowerCase() !== repositoryRoot.toLowerCase()) stop(`repository gate must run at Git top-level: ${topLevel}`, 2);
  if (gitCommand(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) stop("repository gate requires a clean worktree", 2);
  const branch = gitCommand(repositoryRoot, ["branch", "--show-current"]);
  if (branch !== policy.git.primaryBranch) stop(`repository branch must be ${policy.git.primaryBranch}; current=${branch || "detached"}`, 2);
  const commitSha = gitCommand(repositoryRoot, ["rev-parse", "HEAD"]).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) stop("repository HEAD is not traceable", 2);

  const markerPath = absoluteFrom(repositoryRoot, ".release/source-repo.json");
  const manifestPath = absoluteFrom(repositoryRoot, ".release/source-files.v1.json");
  if (!fs.existsSync(markerPath) || !fs.existsSync(manifestPath)) stop("repository is missing managed source metadata", 2);
  const marker = readJson(markerPath);
  const manifest = readJson(manifestPath);
  if (marker.projectId !== policy.projectId || marker.kind !== "managed-clean-source-repository") stop("repository marker identity mismatch", 2);
  if (marker.canonicalTextEol !== "lf") stop("repository marker must declare canonical LF text", 2);
  if (manifest.projectId !== policy.projectId || manifest.kind !== "clean-source-snapshot" || manifest.policySha256 !== policySha256) {
    stop("repository source manifest identity/policy mismatch", 2);
  }
  if (manifest.canonicalTextEol !== "lf") stop("repository source manifest must declare canonical LF text", 2);
  assertRepositoryReconciliation(repositoryRoot, manifest);
  const nonCanonicalEol = gitCommand(repositoryRoot, ["ls-files", "--eol"])
    .split(/\r?\n/u)
    .filter((line) => /\bw\/(?:crlf|mixed)\b/u.test(line) && !/\battr\/-text\b/u.test(line));
  if (nonCanonicalEol.length > 0) {
    stop(`repository contains non-canonical text working-tree bytes: ${JSON.stringify(nonCanonicalEol.slice(0, 20))}`, 2);
  }

  const configuredRemotes = gitCommand(repositoryRoot, ["remote"]).split(/\r?\n/u).filter(Boolean);
  const remoteEvidence = [];
  for (const name of policy.git.requiredRemotes || []) {
    if (!configuredRemotes.includes(name)) stop(`missing required Git remote: ${name}`, 2);
    const url = gitCommand(repositoryRoot, ["remote", "get-url", name]);
    const host = remoteHost(url);
    if (!host && policy.git.allowLocalRemotes === false) stop(`Git remote ${name} must be a non-local HTTPS or SSH endpoint`, 2);
    remoteEvidence.push({ name, host: host || "local" });
    if (options.get("--require-pushed") === "1") {
      const remoteCommit = gitCommand(repositoryRoot, ["rev-parse", `refs/remotes/${name}/${policy.git.primaryBranch}`]).toLowerCase();
      if (remoteCommit !== commitSha) stop(`remote-tracking ${name}/${policy.git.primaryBranch} does not equal HEAD`, 2);
    }
  }
  if (policy.git.requireDistinctRemoteHosts && new Set(remoteEvidence.map((remote) => remote.host)).size !== remoteEvidence.length) {
    stop("required Git remotes must use independent hosts", 2);
  }
  const fsck = spawnSync("git", ["fsck", "--no-dangling"], { cwd: repositoryRoot, encoding: "utf8" });
  if (fsck.error || fsck.status !== 0) stop(`git fsck failed: ${fsck.error?.message || fsck.stderr || fsck.stdout}`, 2);
  console.log(JSON.stringify({ ok: true, projectId: policy.projectId, branch, commitSha, remotes: remoteEvidence, pushedRefsRequired: options.get("--require-pushed") === "1" }, null, 2));
}

switch (action) {
  case "audit":
    printAudit();
    break;
  case "migration-audit":
    printMigrationAudit();
    break;
  case "assets":
    createAssetManifest();
    break;
  case "snapshot":
    createSnapshot();
    break;
  case "refresh-metadata":
    refreshSourceMetadata();
    break;
  case "sync":
    syncSnapshot();
    break;
  case "classify":
    classifyChanges();
    break;
  case "repo":
    verifyManagedGitRepository();
    break;
  default:
    stop(`unknown action ${action}; expected audit, migration-audit, assets, snapshot, refresh-metadata, sync, classify, or repo`, 2);
}
