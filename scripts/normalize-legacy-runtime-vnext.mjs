import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

const PROJECT_ID = "zimeiti-caopanshou";
const WEB_NAME = "agent-hub-web";
const WORKER_NAME = "agent-hub-media-worker";
const WORKER_PORTS = [5102, 5103];
const LEGACY_VOICE_NAME = "voice-platform";

function fail(message) { throw new Error(message); }
function sha256(buffer) { return crypto.createHash("sha256").update(buffer).digest("hex"); }
function sha256File(filePath) { return sha256(fs.readFileSync(filePath)); }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function readJson(filePath, label) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { fail(`${label}_INVALID:${error instanceof Error ? error.message : String(error)}`); }
}

function parseOptions(argv) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`UNEXPECTED_ARGUMENT:${token}`);
    if (["--plan", "--execute", "--execute-locked"].includes(token)) { flags.add(token); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`MISSING_ARGUMENT_VALUE:${token}`);
    options.set(token, value);
    index += 1;
  }
  if (["--plan", "--execute", "--execute-locked"].filter((flag) => flags.has(flag)).length !== 1) {
    fail("EXACTLY_ONE_MODE_REQUIRED");
  }
  const required = [
    "--root", "--target-web", "--target-asset", "--expected-current-web", "--expected-running-web",
    "--expected-current-asset", "--runtime-config", "--runtime-config-sha256", "--receipt",
  ];
  for (const name of required) if (!options.has(name)) fail(`REQUIRED_OPTION_MISSING:${name}`);
  return { options, flags };
}

function requireLinuxRoot() {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) fail("LINUX_ROOT_REQUIRED");
}

function assertRootControlled(filePath, { file = false, modeMask = 0o022, singleLink = false } = {}) {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || (file ? !stats.isFile() : !stats.isDirectory()) || stats.uid !== 0 || stats.gid !== 0
    || (stats.mode & modeMask) !== 0 || (singleLink && stats.nlink !== 1)) fail(`ROOT_CONTROL_REQUIRED:${filePath}`);
  return stats;
}

function assertTrustedFile(filePath, expectedSha, label) {
  if (!/^[a-f0-9]{64}$/u.test(expectedSha || "")) fail(`${label}_SHA256_INVALID`);
  assertRootControlled(filePath, { file: true, modeMask: 0o077, singleLink: true });
  if (sha256File(filePath) !== expectedSha) fail(`${label}_SHA256_MISMATCH`);
  return path.resolve(filePath);
}

function safeRelative(entryPath) {
  return typeof entryPath === "string" && entryPath.length > 0 && !path.isAbsolute(entryPath)
    && !entryPath.includes("\\") && !entryPath.split("/").some((part) => !part || part === "." || part === "..");
}

function validateInventory(target, manifest, { allowUnexpected = false } = {}) {
  if (!Array.isArray(manifest.files) || manifest.files.length < 1 || !/^[a-f0-9]{64}$/u.test(manifest.artifactDigest || "")) {
    fail("TARGET_FULL_INVENTORY_REQUIRED");
  }
  const expected = new Map();
  let previous = "";
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!safeRelative(entry.path) || (previous && previous.localeCompare(entry.path, "en") >= 0)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 || "") || Object.hasOwn(entry, "kind") || Object.hasOwn(entry, "mode")) {
      fail("TARGET_LEGACY_INVENTORY_ENTRY_INVALID");
    }
    previous = entry.path;
    expected.set(entry.path, entry);
    const absolute = path.join(target, ...entry.path.split("/"));
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o222) !== 0
      || stats.size !== entry.bytes || sha256File(absolute) !== entry.sha256) fail(`TARGET_FILE_MISMATCH:${entry.path}`);
    totalBytes += entry.bytes;
  }
  const actual = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(target, absolute).replaceAll(path.sep, "/");
      if (relative === "release-manifest.json") continue;
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink() || (stats.mode & 0o222) !== 0) fail(`TARGET_TREE_METADATA_UNSAFE:${relative}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) actual.push(relative);
      else fail(`TARGET_TREE_SPECIAL_FILE:${relative}`);
    }
  }
  walk(target);
  actual.sort((left, right) => left.localeCompare(right, "en"));
  const expectedPaths = [...expected.keys()].sort((left, right) => left.localeCompare(right, "en"));
  const actualSet = new Set(actual);
  const unexpectedPaths = actual.filter((entryPath) => !expected.has(entryPath));
  const missingPaths = expectedPaths.filter((entryPath) => !actualSet.has(entryPath));
  if (missingPaths.length > 0 || (!allowUnexpected && unexpectedPaths.length > 0)) fail("TARGET_INVENTORY_PATH_SET_MISMATCH");
  const artifactDigest = sha256(manifest.files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""));
  if (artifactDigest !== manifest.artifactDigest || manifest.fileCount !== manifest.files.length || manifest.totalBytes !== totalBytes) {
    fail("TARGET_ARTIFACT_AGGREGATE_INVALID");
  }
  for (const required of ["server.js", ".release/ecosystem.config.cjs", ".release/source-files.v1.json", ".release/build-provenance.v1.json", ".next/BUILD_ID"]) {
    if (!expected.has(required)) fail(`TARGET_REQUIRED_RUNTIME_FILE_MISSING:${required}`);
  }
  return {
    unexpectedCount: unexpectedPaths.length,
    unexpectedDigest: sha256(canonicalJson(unexpectedPaths)),
  };
}

function validateAssetRelease(target, expectedDigest, expectedManifestSha, { allowLegacyFileOwnership = false } = {}) {
  assertRootControlled(target);
  assertRootControlled(path.join(target, "public"));
  assertRootControlled(path.join(target, ".release"));
  const manifestPath = path.join(target, ".release", "public-assets.v1.json");
  const manifestBytes = fs.readFileSync(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha) fail("TARGET_ASSET_MANIFEST_SHA_MISMATCH");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schemaVersion !== 1 || manifest.projectId !== PROJECT_ID || manifest.kind !== "public-assets"
    || manifest.contentAddressing !== "sha256-files-and-asset-policy" || manifest.mutableUploadsIncluded !== false
    || !/^[a-f0-9]{64}$/u.test(manifest.assetPolicySha256 || "") || manifest.digest !== expectedDigest
    || manifest.assetVersion !== `sha256-${expectedDigest}` || !Array.isArray(manifest.files)) {
    fail("TARGET_ASSET_MANIFEST_INVALID");
  }
  let previous = "";
  let totalBytes = 0;
  const expectedPaths = [];
  const ownershipSnapshot = [];
  for (const entry of manifest.files) {
    if (!safeRelative(entry.path) || !entry.path.startsWith("public/") || (previous && previous.localeCompare(entry.path, "en") >= 0)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 || "")) {
      fail("TARGET_ASSET_ENTRY_INVALID");
    }
    previous = entry.path;
    const absolute = path.join(target, ...entry.path.split("/"));
    const stats = fs.lstatSync(absolute);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || (!allowLegacyFileOwnership && (stats.uid !== 0 || stats.gid !== 0))
      || (stats.mode & 0o222) !== 0 || stats.size !== entry.bytes || sha256File(absolute) !== entry.sha256) {
      fail(`TARGET_ASSET_FILE_MISMATCH:${entry.path}`);
    }
    ownershipSnapshot.push({ path: entry.path, uid: stats.uid, gid: stats.gid, mode: stats.mode & 0o777 });
    expectedPaths.push(entry.path);
    totalBytes += entry.bytes;
  }
  const digest = sha256(`asset-policy-sha256  ${manifest.assetPolicySha256}\n${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("")}`);
  if (digest !== expectedDigest || manifest.fileCount !== manifest.files.length || manifest.totalBytes !== totalBytes) {
    fail("TARGET_ASSET_TOTAL_MISMATCH");
  }
  const actualPaths = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(target, absolute).replaceAll(path.sep, "/");
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink() || (stats.mode & 0o222) !== 0) fail(`TARGET_ASSET_TREE_UNSAFE:${relative}`);
      if (entry.isDirectory()) {
        if (stats.uid !== 0 || stats.gid !== 0) fail(`TARGET_ASSET_DIRECTORY_NOT_ROOT_CONTROLLED:${relative}`);
        walk(absolute);
      }
      else if (entry.isFile()) actualPaths.push(relative);
      else fail(`TARGET_ASSET_SPECIAL_FILE:${relative}`);
    }
  }
  walk(path.join(target, "public"));
  actualPaths.sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalJson(actualPaths) !== canonicalJson(expectedPaths)) fail("TARGET_ASSET_PATH_SET_MISMATCH");
  const allowedMetadata = new Set(["public-assets.bundle.v1.json", "public-assets.ready.v1.json", "public-assets.v1.json"]);
  const observedMetadata = fs.readdirSync(path.join(target, ".release")).sort((left, right) => left.localeCompare(right, "en"));
  if (observedMetadata.some((entry) => !allowedMetadata.has(entry)) || observedMetadata.length !== allowedMetadata.size) {
    fail("TARGET_ASSET_METADATA_SET_MISMATCH");
  }
  for (const metadataName of allowedMetadata) {
    assertRootControlled(path.join(target, ".release", metadataName), { file: true, modeMask: 0o222, singleLink: true });
  }
  const readyPath = path.join(target, ".release", "public-assets.ready.v1.json");
  const ready = readJson(readyPath, "TARGET_ASSET_READY_RECEIPT");
  if (ready.schemaVersion !== 1 || ready.projectId !== PROJECT_ID || ready.kind !== "public-assets-readiness-receipt"
    || ready.status !== "READY" || ready.assetVersion !== manifest.assetVersion || ready.assetDigest !== expectedDigest
    || ready.manifestSha256 !== expectedManifestSha || ready.fileCount !== manifest.fileCount || ready.totalBytes !== manifest.totalBytes
    || ready.mutableUploadsIncluded !== false || ready.verificationMode !== "full-sha256" || ready.storageBackend !== "disk"
    || path.resolve(ready.location || "") !== target) fail("TARGET_ASSET_READY_RECEIPT_INVALID");
  const ownershipDigest = sha256(canonicalJson(ownershipSnapshot));
  const ownershipHardeningRequired = ownershipSnapshot.some((entry) => entry.uid !== 0 || entry.gid !== 0);
  return {
    manifestPath,
    manifestBytes,
    manifest,
    manifestSha256: expectedManifestSha,
    fileCount: manifest.fileCount,
    totalBytes,
    ownershipSnapshot,
    ownershipDigest,
    ownershipHardeningRequired,
  };
}

function run(command, args, { env = process.env, timeout = 120_000, allowFailure = false, input } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout, env, input });
  if (!allowFailure && (result.error || result.status !== 0)) fail(`${command.toUpperCase()}_FAILED:${result.error?.message || result.stderr || result.status}`);
  return result;
}

function valueOf(entry, key) {
  return entry?.pm2_env?.[key] ?? entry?.pm2_env?.env?.[key] ?? entry?.env?.[key] ?? entry?.[key];
}
function statusOf(entry) { return entry?.pm2_env?.status ?? entry?.status ?? ""; }
function pm2Entries() { return JSON.parse(run("pm2", ["jlist"]).stdout); }
function realOrNull(filePath) { try { return fs.realpathSync(filePath); } catch { return null; } }

function selectedProcess(entry) {
  return {
    name: entry.name,
    pid: Number.isInteger(entry.pid) ? entry.pid : 0,
    status: statusOf(entry),
    cwd: realOrNull(entry.pm2_env?.pm_cwd),
    port: Number(valueOf(entry, "PORT")),
    releaseId: String(valueOf(entry, "RELEASE_ID") || ""),
    commitSha: String(valueOf(entry, "DEPLOY_COMMIT_SHA") || ""),
    buildId: String(valueOf(entry, "EXPECTED_BUILD_ID") || ""),
    sourceVersion: String(valueOf(entry, "RELEASE_SOURCE_VERSION") || ""),
    buildOutputDigest: String(valueOf(entry, "RELEASE_BUILD_OUTPUT_DIGEST") || ""),
    assetDigest: String(valueOf(entry, "ASSET_DIGEST") || ""),
    assetManifestSha256: String(valueOf(entry, "ASSET_MANIFEST_SHA256") || ""),
  };
}

function curlJson(port, route) {
  const result = run("curl", ["--fail", "--silent", "--show-error", "--connect-timeout", "2", "--max-time", "5", `http://127.0.0.1:${port}${route}`]);
  return JSON.parse(result.stdout);
}

function dataDigest(root) {
  const entries = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) fail(`SHARED_DATA_SYMLINK:${relative}`);
      if (entry.isDirectory()) { entries.push({ path: relative, kind: "directory" }); walk(absolute); }
      else if (entry.isFile()) entries.push({ path: relative, kind: "file", bytes: stats.size, sha256: sha256File(absolute) });
      else fail(`SHARED_DATA_SPECIAL_FILE:${relative}`);
    }
  }
  walk(root);
  return { digest: sha256(canonicalJson(entries)), fileCount: entries.filter((entry) => entry.kind === "file").length };
}

function legacyBuildOutputDigest(subject) {
  return sha256(`zimeiti-legacy-build-output.v1\0${subject.releaseId}\0${subject.commitSha}\0${subject.buildId}\0${subject.sourceVersion}\0${subject.targetManifestSha256}\0${subject.artifactDigest}`);
}

function validateTarget(options) {
  const root = path.resolve(options.get("--root"));
  if (root !== "/data/web") fail("RELEASE_ROOT_INVALID");
  const sourceTargetWeb = fs.realpathSync(path.resolve(options.get("--target-web")));
  const targetAsset = fs.realpathSync(path.resolve(options.get("--target-asset")));
  if (!sourceTargetWeb.startsWith(`${root}/releases/`) || !sourceTargetWeb.endsWith("/web")) fail("TARGET_WEB_PATH_INVALID");
  if (!targetAsset.startsWith(`${root}/shared/assets/releases/sha256-`)) fail("TARGET_ASSET_PATH_INVALID");
  assertRootControlled(path.dirname(sourceTargetWeb));
  const manifestPath = path.join(sourceTargetWeb, "release-manifest.json");
  const manifest = readJson(manifestPath, "TARGET_RELEASE_MANIFEST");
  if (manifest.schemaVersion !== 2 || manifest.projectId !== PROJECT_ID || manifest.service !== "web" || manifest.deployable !== true
    || manifest.rehearsal !== false || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/u.test(manifest.releaseId || "")
    || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(manifest.commitSha || "")
    || !/^[A-Za-z0-9._-]{1,256}$/u.test(manifest.buildId || "") || !/^[a-f0-9]{64}$/u.test(manifest.assetDigest || "")
    || !/^[a-f0-9]{64}$/u.test(manifest.assetManifestSha256 || "")
    || !/^[a-f0-9]{64}$/u.test(manifest.sourceManifestSha256 || "")) fail("TARGET_RELEASE_MANIFEST_UNSUPPORTED");
  if (manifest.sourceVersion !== undefined || manifest.buildOutputDigest !== undefined) fail("TARGET_IS_NOT_A_LEGACY_BASELINE");
  if (path.basename(path.dirname(sourceTargetWeb)) !== manifest.releaseId || path.basename(targetAsset) !== `sha256-${manifest.assetDigest}`) {
    fail("TARGET_RELEASE_PATH_IDENTITY_MISMATCH");
  }
  const normalizedReleaseRoot = path.join(
    root,
    "releases",
    `legacy-normalized-${manifest.releaseId}-${manifest.artifactDigest.slice(0, 12)}`,
  );
  const targetWeb = path.join(normalizedReleaseRoot, "web");
  if (fs.existsSync(normalizedReleaseRoot) || fs.lstatSync(path.dirname(normalizedReleaseRoot)).isSymbolicLink()) {
    fail("NORMALIZED_TARGET_ALREADY_EXISTS_OR_PARENT_UNSAFE");
  }
  assertRootControlled(path.dirname(normalizedReleaseRoot));
  const versionPath = path.join(sourceTargetWeb, "public", "version.json");
  const version = readJson(versionPath, "TARGET_PUBLIC_VERSION");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(version.sourceVersion || "")) fail("TARGET_SOURCE_VERSION_INVALID");
  const asset = validateAssetRelease(targetAsset, manifest.assetDigest, manifest.assetManifestSha256, {
    allowLegacyFileOwnership: true,
  });
  const embeddedAssetManifestPath = path.join(sourceTargetWeb, ".release", "public-assets.v1.json");
  const embeddedAssetManifestBytes = fs.readFileSync(embeddedAssetManifestPath);
  if (sha256(embeddedAssetManifestBytes) !== manifest.assetManifestSha256 || !embeddedAssetManifestBytes.equals(asset.manifestBytes)) {
    fail("TARGET_EMBEDDED_ASSET_MANIFEST_MISMATCH");
  }
  const sourceInventory = validateInventory(sourceTargetWeb, manifest, { allowUnexpected: true });
  const runtimeConfig = assertTrustedFile(
    path.resolve(options.get("--runtime-config")),
    options.get("--runtime-config-sha256"),
    "RUNTIME_CONFIG",
  );
  const subject = {
    releaseId: manifest.releaseId,
    commitSha: manifest.commitSha,
    buildId: manifest.buildId,
    sourceVersion: version.sourceVersion,
    sourceTargetWeb,
    targetWeb,
    targetAsset,
    assetDigest: manifest.assetDigest,
    assetManifestSha256: manifest.assetManifestSha256,
    targetManifestSha256: sha256File(manifestPath),
    artifactDigest: manifest.artifactDigest,
    sourceManifestSha256: manifest.sourceManifestSha256,
    publicVersionSha256: sha256File(versionPath),
    runtimeConfig,
    runtimeConfigSha256: options.get("--runtime-config-sha256"),
    assetFileCount: asset.fileCount,
    assetTotalBytes: asset.totalBytes,
    assetOwnershipDigest: asset.ownershipDigest,
    assetOwnershipHardeningRequired: asset.ownershipHardeningRequired,
    sourceUnexpectedCount: sourceInventory.unexpectedCount,
    sourceUnexpectedDigest: sourceInventory.unexpectedDigest,
  };
  subject.buildOutputDigest = legacyBuildOutputDigest(subject);
  return { root, subject, assetOwnershipSnapshot: asset.ownershipSnapshot };
}

function inspectCurrent(options, target) {
  const root = target.root;
  const currentWeb = realOrNull(path.join(root, "current-web"));
  const currentAsset = realOrNull(path.join(root, "shared", "assets", "current"));
  const expectedCurrentWeb = fs.realpathSync(path.resolve(options.get("--expected-current-web")));
  const expectedRunningWeb = fs.realpathSync(path.resolve(options.get("--expected-running-web")));
  const expectedCurrentAsset = fs.realpathSync(path.resolve(options.get("--expected-current-asset")));
  if (currentWeb !== expectedCurrentWeb || currentAsset !== expectedCurrentAsset) fail("OBSERVED_POINTERS_CHANGED");
  const entries = pm2Entries();
  const webMatches = entries.filter((entry) => entry.name === WEB_NAME);
  const workerMatches = entries.filter((entry) => entry.name === WORKER_NAME);
  if (webMatches.length !== 1 || workerMatches.length !== 2) fail("OBSERVED_PM2_TOPOLOGY_CHANGED");
  const web = selectedProcess(webMatches[0]);
  const workers = workerMatches.map(selectedProcess).sort((left, right) => left.port - right.port);
  if (web.status !== "online" || web.pid <= 0 || web.cwd !== expectedRunningWeb || web.port !== 5000
    || workers.some((worker, index) => worker.status !== "online" || worker.pid <= 0 || worker.cwd !== expectedRunningWeb || worker.port !== WORKER_PORTS[index])) {
    fail("OBSERVED_RUNTIME_IDENTITY_CHANGED");
  }
  const sharedIdentityKeys = [
    "releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256",
  ];
  if (workers.some((worker) => sharedIdentityKeys.some((key) => worker[key] !== web[key]))) {
    fail("OBSERVED_RUNTIME_COMPONENT_IDENTITY_DIVERGED");
  }
  const version = curlJson(5000, "/api/version");
  for (const [key, expected] of Object.entries({
    releaseId: web.releaseId,
    deployCommitSha: web.commitSha,
    buildId: web.buildId,
  })) if (version[key] !== expected) fail(`OBSERVED_VERSION_MISMATCH:${key}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(version.sourceVersion || "")) fail("OBSERVED_SOURCE_VERSION_INVALID");
  if (web.sourceVersion && web.sourceVersion !== version.sourceVersion) fail("OBSERVED_SOURCE_VERSION_MISMATCH");
  const currentAssetManifest = path.join(currentAsset, ".release", "public-assets.v1.json");
  const dumpPath = "/root/.pm2/dump.pm2";
  const dumpStats = assertRootControlled(dumpPath, { file: true, modeMask: 0o022, singleLink: true });
  const voice = entries.find((entry) => entry.name === LEGACY_VOICE_NAME);
  if (voice && !["online", "stopped"].includes(statusOf(voice))) fail("OBSERVED_LEGACY_VOICE_STATE_UNSAFE");
  const data = dataDigest(path.join(root, "shared", "data"));
  const original = {
    currentWeb,
    currentAsset,
    runningWeb: expectedRunningWeb,
    web: { ...web, sourceVersion: version.sourceVersion },
    workers,
    legacyVoice: voice ? selectedProcess(voice) : null,
    currentAssetManifestSha256: sha256File(currentAssetManifest),
    dumpSha256: sha256File(dumpPath),
    dumpMode: dumpStats.mode & 0o777,
    data,
  };
  const planSubject = {
    schemaVersion: "zimeiti-runtime-alignment-plan.v1",
    projectId: PROJECT_ID,
    root,
    original,
    target: target.subject,
    receipt: path.resolve(options.get("--receipt")),
  };
  const planId = sha256(canonicalJson(planSubject));
  return { planId, planSubject, original, target: target.subject };
}

function environmentFor(root, identity, targetWeb) {
  const protectedFile = path.join(root, "shared", "env", ".env.local");
  assertRootControlled(protectedFile, { file: true, modeMask: 0o077 });
  const protectedValues = parseEnv(fs.readFileSync(protectedFile, "utf8"));
  const shared = path.join(root, "shared");
  const env = { ...process.env, ...protectedValues };
  delete env.NODE_OPTIONS;
  return {
    ...env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
    RELEASE_NODE_BINARY: process.execPath,
    NODE_ENV: "production",
    COZE_PROJECT_ENV: "PROD",
    RELEASE_ROOT: root,
    WEB_RELEASE_DIR: targetWeb,
    APP_DATA_DIR: path.join(shared, "data"),
    APP_RUNTIME_DIR: path.join(shared, "runtime"),
    COMMERCE_DATA_DIR: path.join(shared, "runtime", "commerce-agent"),
    COMMERCE_DISCOVERY_CATALOG: path.join(shared, "runtime", "commerce-discovery", "catalog.json"),
    COMMERCE_GATEWAY_KEY_FILE: path.join(shared, "runtime", "commerce-agent", "main-gateway.key"),
    IDEMPOTENCY_DIR: path.join(shared, "runtime", "llm-request-idempotency"),
    BACKUP_DIR: path.join(shared, "backups"),
    PUBLIC_ASSET_ROOT: path.join(shared, "assets", "current", "public"),
    STORAGE_LOCAL_BASE_PATH: path.join(shared, "uploads"),
    VOICE_SQLITE_PATH: path.join(shared, "voice", "voice.db"),
    VOICE_REFERENCE_AUDIO_DIR: path.join(shared, "voice", "reference-audio"),
    RELEASE_ID: identity.releaseId,
    DEPLOY_COMMIT_SHA: identity.commitSha,
    EXPECTED_BUILD_ID: identity.buildId,
    RELEASE_SOURCE_VERSION: identity.sourceVersion,
    RELEASE_BUILD_OUTPUT_DIGEST: identity.buildOutputDigest,
    ASSET_DIGEST: identity.assetDigest,
    ASSET_MANIFEST_SHA256: identity.assetManifestSha256,
    MEDIA_QUEUE_WORKER_INSTANCES: "2",
    MEDIA_QUEUE_WORKER_PORT: "5102",
  };
}

function atomicSymlink(target, linkPath) {
  const temporary = `${linkPath}.runtime-alignment-${process.pid}-${crypto.randomUUID()}`;
  fs.symlinkSync(target, temporary, "dir");
  fs.renameSync(temporary, linkPath);
  if (fs.realpathSync(linkPath) !== fs.realpathSync(target)) fail(`ATOMIC_POINTER_SWITCH_FAILED:${linkPath}`);
}

function atomicWrite(filePath, bytes, mode = 0o600) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, mode);
  const directoryFd = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function stopIfPresent(name) {
  if (pm2Entries().some((entry) => entry.name === name)) run("pm2", ["stop", name], { timeout: 90_000 });
}

function deleteIfPresent(name) {
  if (pm2Entries().some((entry) => entry.name === name)) run("pm2", ["delete", name], { timeout: 90_000 });
}

async function waitPortsFree(ports) {
  // Media workers may use a 25s graceful drain and a 35s PM2 kill timeout.
  // The recovery window must outlast both rather than declaring rollback
  // unconfirmed while a correctly terminating worker still owns its port.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const allFree = ports.every((port) => run("ss", ["-H", "-ltnp", `sport = :${port}`], { allowFailure: true }).stdout.trim() === "");
    if (allFree) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail("RUNTIME_PORTS_DID_NOT_DRAIN");
}

async function waitNamedProcessStatus(name, expectedStatus) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const matches = pm2Entries().filter((entry) => entry.name === name);
    if (matches.length === 1 && statusOf(matches[0]) === expectedStatus) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  fail(`PROCESS_STATUS_NOT_RESTORED:${name}:${expectedStatus}`);
}

function startProcess(config, name, env) {
  if (pm2Entries().some((entry) => entry.name === name)) fail(`PROCESS_SLOT_STILL_EXISTS:${name}`);
  run("pm2", ["start", config, "--only", name, "--env", "production", "--update-env"], { env, timeout: 90_000 });
}

async function waitIdentity(identity, targetWeb) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const entries = pm2Entries();
      const web = entries.filter((entry) => entry.name === WEB_NAME).map(selectedProcess);
      const workers = entries.filter((entry) => entry.name === WORKER_NAME).map(selectedProcess).sort((left, right) => left.port - right.port);
      const commonKeys = ["releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256"];
      if (web.length === 1 && workers.length === 2 && web[0].status === "online" && web[0].cwd === targetWeb && web[0].port === 5000
        && workers.every((worker, index) => worker.status === "online" && worker.cwd === targetWeb && worker.port === WORKER_PORTS[index])
        && [web[0], ...workers].every((entry) => commonKeys.every((key) => entry[key] === identity[key]))) {
        const versions = [5000, ...WORKER_PORTS].map((port) => curlJson(port, "/api/version"));
        if (versions.every((version) => version.releaseId === identity.releaseId && version.deployCommitSha === identity.commitSha
          && version.buildId === identity.buildId && version.sourceVersion === identity.sourceVersion)) return;
      }
    } catch { /* retry until timeout */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  fail("NORMALIZED_RUNTIME_NOT_READY");
}

function verifyDump(identity, targetWeb, voiceMustBeStopped) {
  assertRootControlled("/root/.pm2/dump.pm2", { file: true, modeMask: 0o077, singleLink: true });
  const dump = readJson("/root/.pm2/dump.pm2", "PM2_DUMP");
  const entries = dump.filter((entry) => [WEB_NAME, WORKER_NAME].includes(entry.name));
  const web = entries.filter((entry) => entry.name === WEB_NAME);
  const workers = entries.filter((entry) => entry.name === WORKER_NAME).sort((left, right) => Number(valueOf(left, "PORT")) - Number(valueOf(right, "PORT")));
  if (web.length !== 1 || workers.length !== 2) fail("PM2_DUMP_TOPOLOGY_INVALID");
  const required = [web[0], ...workers];
  for (const entry of required) {
    if (statusOf(entry) !== "online" || fs.realpathSync(entry.pm_cwd) !== targetWeb) fail("PM2_DUMP_RUNTIME_INVALID");
    for (const key of ["releaseId", "commitSha", "buildId", "sourceVersion", "buildOutputDigest", "assetDigest", "assetManifestSha256"]) {
      const envKey = { releaseId: "RELEASE_ID", commitSha: "DEPLOY_COMMIT_SHA", buildId: "EXPECTED_BUILD_ID", sourceVersion: "RELEASE_SOURCE_VERSION", buildOutputDigest: "RELEASE_BUILD_OUTPUT_DIGEST", assetDigest: "ASSET_DIGEST", assetManifestSha256: "ASSET_MANIFEST_SHA256" }[key];
      if (String(valueOf(entry, envKey) || "") !== identity[key]) fail(`PM2_DUMP_IDENTITY_INVALID:${key}`);
    }
  }
  if (Number(valueOf(web[0], "PORT")) !== 5000 || workers.some((entry, index) => Number(valueOf(entry, "PORT")) !== WORKER_PORTS[index])) {
    fail("PM2_DUMP_PORTS_INVALID");
  }
  if (voiceMustBeStopped) {
    const voice = dump.find((entry) => entry.name === LEGACY_VOICE_NAME);
    if (voice && statusOf(voice) !== "stopped") fail("LEGACY_VOICE_DUMP_NOT_STOPPED");
  }
}

function makeReceiptPathSafe(receiptPath) {
  const resolved = path.resolve(receiptPath);
  if (!/^\/data\/direct-deploy\/incoming\/run-[0-9]+\/control\/receipts\/legacy-runtime-baseline-web-[A-Za-z0-9._-]{8,128}\.json$/u.test(resolved)) {
    fail("RECEIPT_PATH_INVALID");
  }
  assertRootControlled(path.dirname(resolved));
  if (fs.existsSync(resolved)) fail("IMMUTABLE_RECEIPT_ALREADY_EXISTS");
  return resolved;
}

function copySignedLegacyInventory(sourceWeb, stagingReleaseRoot, manifest, expectedManifestSha256, { chownRoot = false } = {}) {
  const stagingWeb = path.join(stagingReleaseRoot, "web");
  fs.mkdirSync(stagingWeb, { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    if (!safeRelative(entry.path)) fail(`NORMALIZED_SOURCE_PATH_INVALID:${String(entry.path)}`);
    const source = path.join(sourceWeb, ...entry.path.split("/"));
    const destination = path.join(stagingWeb, ...entry.path.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    if (chownRoot) fs.chownSync(destination, 0, 0);
    fs.chmodSync(destination, 0o444);
  }
  const sourceManifest = path.join(sourceWeb, "release-manifest.json");
  const stagedManifest = path.join(stagingWeb, "release-manifest.json");
  fs.copyFileSync(sourceManifest, stagedManifest, fs.constants.COPYFILE_EXCL);
  if (chownRoot) fs.chownSync(stagedManifest, 0, 0);
  fs.chmodSync(stagedManifest, 0o444);
  if (sha256File(stagedManifest) !== expectedManifestSha256) fail("NORMALIZED_MANIFEST_CHANGED_DURING_COPY");

  const directories = [];
  function collectDirectories(directory) {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) collectDirectories(path.join(directory, entry.name));
    }
  }
  collectDirectories(stagingReleaseRoot);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    if (chownRoot) fs.chownSync(directory, 0, 0);
    fs.chmodSync(directory, 0o555);
  }
  validateInventory(stagingWeb, manifest);
  return stagingWeb;
}

function prepareNormalizedRelease(sourceWeb, targetWeb, manifest, expectedManifestSha256, failureRoot) {
  const targetReleaseRoot = path.dirname(targetWeb);
  const releasesRoot = path.dirname(targetReleaseRoot);
  assertRootControlled(releasesRoot);
  if (fs.existsSync(targetReleaseRoot)) fail("NORMALIZED_TARGET_ALREADY_EXISTS");
  const stagingReleaseRoot = path.join(
    releasesRoot,
    `.runtime-alignment-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stagingReleaseRoot, { recursive: false, mode: 0o700 });
  fs.chownSync(stagingReleaseRoot, 0, 0);
  try {
    copySignedLegacyInventory(sourceWeb, stagingReleaseRoot, manifest, expectedManifestSha256, { chownRoot: true });
    return stagingReleaseRoot;
  } catch (error) {
    if (fs.existsSync(stagingReleaseRoot)) {
      const failedStaging = path.join(failureRoot, "failed-normalized-staging");
      if (fs.existsSync(failedStaging)) fail("FAILED_NORMALIZED_STAGING_BACKUP_ALREADY_EXISTS");
      fs.renameSync(stagingReleaseRoot, failedStaging);
    }
    throw error;
  }
}

async function executeLocked(options, inspection) {
  const approval = process.env.RUNTIME_ALIGNMENT_APPROVED || "";
  if (approval !== inspection.planId) fail("RUNTIME_ALIGNMENT_APPROVED_MISMATCH");
  const freshTarget = validateTarget(options);
  const fresh = inspectCurrent(options, freshTarget);
  if (fresh.planId !== inspection.planId || canonicalJson(fresh.planSubject) !== canonicalJson(inspection.planSubject)) fail("RUNTIME_ALIGNMENT_PLAN_CHANGED");

  const root = freshTarget.root;
  const receiptPath = makeReceiptPathSafe(options.get("--receipt"));
  const backupRoot = path.join(root, "shared", "backups", "runtime-alignment", fresh.planId);
  if (fs.existsSync(backupRoot)) fail("RUNTIME_ALIGNMENT_BACKUP_ALREADY_EXISTS");
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.chownSync(backupRoot, 0, 0);
  fs.chmodSync(backupRoot, 0o700);
  const originalDump = fs.readFileSync("/root/.pm2/dump.pm2");
  atomicWrite(path.join(backupRoot, "dump.pm2.before"), originalDump, 0o600);
  atomicWrite(path.join(backupRoot, "before-state.json"), `${JSON.stringify(fresh.planSubject, null, 2)}\n`, 0o600);
  let mutated = false;
  let transactionRootCreated = false;
  let assetOwnershipHardened = false;
  let assetOwnershipMutationAttempted = false;
  let normalizedReleasePrepared = false;
  let normalizedStagingRoot = null;
  let rollbackFailure = null;

  const targetIdentity = {
    releaseId: fresh.target.releaseId,
    commitSha: fresh.target.commitSha,
    buildId: fresh.target.buildId,
    sourceVersion: fresh.target.sourceVersion,
    buildOutputDigest: fresh.target.buildOutputDigest,
    assetDigest: fresh.target.assetDigest,
    assetManifestSha256: fresh.target.assetManifestSha256,
  };

  try {
    const sourceManifest = readJson(
      path.join(fresh.target.sourceTargetWeb, "release-manifest.json"),
      "NORMALIZATION_SOURCE_MANIFEST",
    );
    normalizedStagingRoot = prepareNormalizedRelease(
      fresh.target.sourceTargetWeb,
      fresh.target.targetWeb,
      sourceManifest,
      fresh.target.targetManifestSha256,
      backupRoot,
    );
    fs.renameSync(normalizedStagingRoot, path.dirname(fresh.target.targetWeb));
    normalizedStagingRoot = null;
    normalizedReleasePrepared = true;
    const releasesDirectoryFd = fs.openSync(path.dirname(path.dirname(fresh.target.targetWeb)), fs.constants.O_RDONLY);
    try { fs.fsyncSync(releasesDirectoryFd); } finally { fs.closeSync(releasesDirectoryFd); }
    validateInventory(fresh.target.targetWeb, sourceManifest);
    const normalizedEmbeddedAssetManifest = path.join(fresh.target.targetWeb, ".release", "public-assets.v1.json");
    if (sha256File(normalizedEmbeddedAssetManifest) !== fresh.target.assetManifestSha256) {
      fail("NORMALIZED_ASSET_MANIFEST_BINDING_INVALID");
    }
    mutated = true;
    stopIfPresent(WORKER_NAME);
    stopIfPresent(WEB_NAME);
    await waitPortsFree([5000, ...WORKER_PORTS]);
    // startOrReload can preserve stale per-instance PORT values. Removing only
    // these managed slots makes PM2 recalculate 5102/5103 deterministically.
    deleteIfPresent(WORKER_NAME);
    deleteIfPresent(WEB_NAME);
    if (fresh.target.assetOwnershipHardeningRequired) {
      assetOwnershipMutationAttempted = true;
      for (const entry of freshTarget.assetOwnershipSnapshot) {
        fs.chownSync(path.join(fresh.target.targetAsset, ...entry.path.split("/")), 0, 0);
      }
      assetOwnershipHardened = true;
    }
    const hardenedAsset = validateAssetRelease(
      fresh.target.targetAsset,
      fresh.target.assetDigest,
      fresh.target.assetManifestSha256,
    );
    if (hardenedAsset.ownershipHardeningRequired) fail("TARGET_ASSET_OWNERSHIP_HARDENING_FAILED");
    atomicSymlink(fresh.target.targetAsset, path.join(root, "shared", "assets", "current"));
    atomicSymlink(fresh.target.targetWeb, path.join(root, "current-web"));
    const env = environmentFor(root, targetIdentity, fresh.target.targetWeb);
    startProcess(fresh.target.runtimeConfig, WEB_NAME, env);
    startProcess(fresh.target.runtimeConfig, WORKER_NAME, env);
    await waitIdentity(targetIdentity, fresh.target.targetWeb);
    const voice = pm2Entries().find((entry) => entry.name === LEGACY_VOICE_NAME);
    if (voice && statusOf(voice) !== "stopped") {
      run("pm2", ["stop", LEGACY_VOICE_NAME], { timeout: 90_000 });
      await waitNamedProcessStatus(LEGACY_VOICE_NAME, "stopped");
    }
    run("pm2", ["save", "--force"], { timeout: 90_000 });
    fs.chmodSync("/root/.pm2/dump.pm2", 0o600);
    const dumpFd = fs.openSync("/root/.pm2/dump.pm2", fs.constants.O_RDONLY);
    try { fs.fsyncSync(dumpFd); } finally { fs.closeSync(dumpFd); }
    verifyDump(targetIdentity, fresh.target.targetWeb, true);
    const afterData = dataDigest(path.join(root, "shared", "data"));
    if (canonicalJson(afterData) !== canonicalJson(fresh.original.data)) fail("SHARED_DATA_CHANGED_DURING_ALIGNMENT");
    const transactionRoot = "/data/direct-deploy/transactions";
    if (!fs.existsSync(transactionRoot)) {
      assertRootControlled(path.dirname(transactionRoot));
      fs.mkdirSync(transactionRoot, { mode: 0o700 });
      fs.chownSync(transactionRoot, 0, 0);
      fs.chmodSync(transactionRoot, 0o700);
      transactionRootCreated = true;
    }
    assertRootControlled(transactionRoot);
    const receipt = {
      schemaVersion: 1,
      kind: "legacy-runtime-baseline",
      projectId: PROJECT_ID,
      service: "web",
      releaseRoot: root,
      target: fresh.target.targetWeb,
      sourceTarget: fresh.target.sourceTargetWeb,
      releaseId: targetIdentity.releaseId,
      commitSha: targetIdentity.commitSha,
      buildId: targetIdentity.buildId,
      sourceVersion: targetIdentity.sourceVersion,
      buildOutputDigest: targetIdentity.buildOutputDigest,
      assetTarget: fresh.target.targetAsset,
      assetDigest: targetIdentity.assetDigest,
      assetManifestSha256: targetIdentity.assetManifestSha256,
      assetOwnershipBeforeSha256: fresh.target.assetOwnershipDigest,
      assetOwnershipHardened,
      sourceUnexpectedCount: fresh.target.sourceUnexpectedCount,
      sourceUnexpectedDigest: fresh.target.sourceUnexpectedDigest,
      targetManifestSha256: fresh.target.targetManifestSha256,
      artifactDigest: fresh.target.artifactDigest,
      sourceManifestSha256: fresh.target.sourceManifestSha256,
      publicVersionSha256: fresh.target.publicVersionSha256,
      runtimeConfigSha256: fresh.target.runtimeConfigSha256,
      normalizationPlanId: fresh.planId,
      normalizedAt: new Date().toISOString(),
      pm2DumpSha256: sha256File("/root/.pm2/dump.pm2"),
      sharedDataDigest: afterData.digest,
      legacyReadinessPath: "/api/version",
      fullInventoryValidated: true,
      oldVoiceState: "stopped-recoverable",
      transactionRoot,
    };
    atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 0o400);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "execute", planId: fresh.planId, receipt: receiptPath, receiptSha256: sha256File(receiptPath), productionSwitchedToCandidate: false })}\n`);
  } catch (error) {
    if (mutated) {
      try {
        stopIfPresent(WORKER_NAME);
        stopIfPresent(WEB_NAME);
        await waitPortsFree([5000, ...WORKER_PORTS]);
        deleteIfPresent(WORKER_NAME);
        deleteIfPresent(WEB_NAME);
        atomicSymlink(fresh.original.currentAsset, path.join(root, "shared", "assets", "current"));
        atomicSymlink(fresh.original.currentWeb, path.join(root, "current-web"));
        const originalAssetDigest = path.basename(fresh.original.currentAsset).replace(/^sha256-/u, "");
        const originalIdentity = {
          releaseId: fresh.original.web.releaseId,
          commitSha: fresh.original.web.commitSha,
          buildId: fresh.original.web.buildId,
          sourceVersion: fresh.original.web.sourceVersion,
          buildOutputDigest: /^[a-f0-9]{64}$/u.test(fresh.original.web.buildOutputDigest)
            ? fresh.original.web.buildOutputDigest
            : sha256(`legacy-rollback\0${fresh.original.web.releaseId}\0${fresh.original.dumpSha256}`),
          assetDigest: originalAssetDigest,
          assetManifestSha256: fresh.original.currentAssetManifestSha256,
        };
        const originalEnv = environmentFor(root, originalIdentity, fresh.original.runningWeb);
        startProcess(fresh.target.runtimeConfig, WEB_NAME, originalEnv);
        startProcess(fresh.target.runtimeConfig, WORKER_NAME, originalEnv);
        await waitIdentity(originalIdentity, fresh.original.runningWeb);
        if (fresh.original.legacyVoice && fresh.original.legacyVoice.status !== "stopped") {
          run("pm2", ["start", LEGACY_VOICE_NAME], { timeout: 90_000 });
          await waitNamedProcessStatus(LEGACY_VOICE_NAME, fresh.original.legacyVoice.status);
        }
        atomicWrite("/root/.pm2/dump.pm2", originalDump, fresh.original.dumpMode);
        if (sha256File("/root/.pm2/dump.pm2") !== fresh.original.dumpSha256
          || (fs.statSync("/root/.pm2/dump.pm2").mode & 0o777) !== fresh.original.dumpMode) {
          fail("ROLLBACK_PM2_DUMP_CHANGED");
        }
        if (assetOwnershipMutationAttempted) {
          for (const entry of freshTarget.assetOwnershipSnapshot) {
            fs.chownSync(path.join(fresh.target.targetAsset, ...entry.path.split("/")), entry.uid, entry.gid);
          }
          const restoredAsset = validateAssetRelease(
            fresh.target.targetAsset,
            fresh.target.assetDigest,
            fresh.target.assetManifestSha256,
            { allowLegacyFileOwnership: true },
          );
          if (restoredAsset.ownershipDigest !== fresh.target.assetOwnershipDigest) fail("ROLLBACK_ASSET_OWNERSHIP_CHANGED");
        }
        const afterRollbackData = dataDigest(path.join(root, "shared", "data"));
        if (canonicalJson(afterRollbackData) !== canonicalJson(fresh.original.data)) fail("ROLLBACK_SHARED_DATA_CHANGED");
        if (transactionRootCreated) fs.rmdirSync("/data/direct-deploy/transactions");
      } catch (rollbackError) {
        rollbackFailure = rollbackError;
      }
    }
    if (normalizedReleasePrepared && fs.existsSync(path.dirname(fresh.target.targetWeb))) {
      const cleanupEvidence = quarantineNormalizedRelease({
        releaseRoot: path.dirname(fresh.target.targetWeb), backupRoot, rollbackFailure,
        inspectReferences: () => inspectNormalizedReleaseReferences(root, path.dirname(fresh.target.targetWeb)),
      });
      process.stderr.write(`${JSON.stringify({ kind: "normalized-release-failure-cleanup", ...cleanupEvidence })}\n`);
      try {
        atomicWrite(path.join(backupRoot, "normalized-release-failure-cleanup.v1.json"), `${JSON.stringify(cleanupEvidence, null, 2)}\n`, 0o400);
      } catch (evidenceError) {
        process.stderr.write(`RELEASE_CLEANUP_EVIDENCE_WRITE_FAILED:${evidenceError instanceof Error ? evidenceError.message : String(evidenceError)}\n`);
        rollbackFailure ||= evidenceError;
      }
      if (cleanupEvidence.action !== "quarantined") rollbackFailure ||= new Error(`NORMALIZED_RELEASE_PRESERVED:${cleanupEvidence.reason}`);
    }
    if (normalizedStagingRoot && fs.existsSync(normalizedStagingRoot)) {
      const failedNormalizedStaging = path.join(backupRoot, "failed-normalized-staging");
      if (fs.existsSync(failedNormalizedStaging)) fail("FAILED_NORMALIZED_STAGING_BACKUP_ALREADY_EXISTS");
      fs.renameSync(normalizedStagingRoot, failedNormalizedStaging);
    }
    if (rollbackFailure) {
      fail(`RUNTIME_ALIGNMENT_FAILED_AND_ROLLBACK_UNCONFIRMED:${error instanceof Error ? error.message : String(error)}:${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`);
    }
    throw error;
  }
}

// Failure or incomplete observation must never remove a potentially live release.
function quarantineNormalizedRelease({ releaseRoot, backupRoot, rollbackFailure, inspectReferences }) {
  const evidence = { schemaVersion: 1, releaseRoot, action: "preserved", reason: null };
  if (rollbackFailure) {
    evidence.reason = "ROLLBACK_UNCONFIRMED";
    evidence.rollbackError = rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure);
    return evidence;
  }
  try {
    const observation = inspectReferences();
    if (!observation || observation.confirmed !== true || !Array.isArray(observation.references)) throw new Error("RELEASE_REFERENCES_UNKNOWN");
    evidence.references = observation.references;
    if (observation.references.length > 0) {
      evidence.reason = "RELEASE_STILL_REFERENCED";
      return evidence;
    }
    const destination = path.join(backupRoot, "failed-normalized-release");
    if (fs.existsSync(destination)) throw new Error("FAILED_NORMALIZED_RELEASE_BACKUP_ALREADY_EXISTS");
    fs.renameSync(releaseRoot, destination);
    evidence.action = "quarantined";
    evidence.destination = destination;
    evidence.reason = "NO_POINTER_OR_PROCESS_REFERENCES";
  } catch (error) {
    evidence.reason = "RELEASE_QUARANTINE_UNCONFIRMED";
    evidence.inspectionOrRenameError = error instanceof Error ? error.message : String(error);
  }
  return evidence;
}

function inspectNormalizedReleaseReferences(root, releaseRoot) {
  const canonicalRelease = fs.realpathSync(releaseRoot);
  const references = [];
  const checkPath = (label, candidate) => {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) fail(`RELEASE_REFERENCE_PATH_UNKNOWN:${label}`);
    const relative = path.relative(canonicalRelease, fs.realpathSync(candidate));
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) references.push(label);
  };
  checkPath("current-web", path.join(root, "current-web"));
  const entries = pm2Entries();
  if (!Array.isArray(entries)) fail("RELEASE_PM2_REFERENCES_UNKNOWN");
  for (const entry of entries) {
    if (!entry.pm2_env) fail("RELEASE_PM2_ENV_UNKNOWN");
    checkPath(`pm2:${entry.name}:cwd`, entry.pm2_env.pm_cwd);
    checkPath(`pm2:${entry.name}:script`, entry.pm2_env.pm_exec_path);
  }
  // PM2 metadata cannot prove detached/old child processes exited. Unreadable
  // or disappearing processes make the snapshot inconclusive and preserve it.
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/u.test(name))) {
    const processRoot = path.join("/proc", pid);
    const command = fs.readFileSync(path.join(processRoot, "cmdline"), "utf8");
    if (!command) continue; // Kernel threads/zombies have no userspace runtime.
    checkPath(`pid:${pid}:cwd`, path.join(processRoot, "cwd"));
    checkPath(`pid:${pid}:exe`, path.join(processRoot, "exe"));
    if (command.includes(canonicalRelease)) references.push(`pid:${pid}:cmdline`);
    if (fs.readFileSync(path.join(processRoot, "maps"), "utf8").includes(canonicalRelease)) references.push(`pid:${pid}:maps`);
  }
  return { confirmed: true, references };
}

async function main() {
  const { options, flags } = parseOptions(process.argv.slice(2));
  requireLinuxRoot();
  const target = validateTarget(options);
  const inspection = inspectCurrent(options, target);
  if (flags.has("--plan")) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "plan", planId: inspection.planId, current: { webPointer: inspection.original.currentWeb, runningWeb: inspection.original.runningWeb, assetPointer: inspection.original.currentAsset }, target: inspection.target, productionWrites: 0, databaseWrites: 0 })}\n`);
    return;
  }
  if (flags.has("--execute")) {
    const lockPath = path.join(target.root, ".deploy.lock");
    assertRootControlled(lockPath, { file: true, modeMask: 0o022 });
    const forwarded = process.argv.slice(2).filter((argument) => argument !== "--execute");
    forwarded.unshift("--execute-locked");
    const result = run("flock", ["-n", lockPath, process.execPath, path.resolve(process.argv[1]), ...forwarded], {
      env: process.env,
      timeout: 15 * 60_000,
      allowFailure: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) process.exitCode = result.status || 1;
    return;
  }
  await executeLocked(options, inspection);
}

export { canonicalJson, copySignedLegacyInventory, legacyBuildOutputDigest, prepareNormalizedRelease, quarantineNormalizedRelease, validateInventory };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
