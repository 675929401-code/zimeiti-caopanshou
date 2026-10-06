#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

function sensitiveArtifactPathReason(relativePath, kind) {
  const normalizedPath = normalize(relativePath);
  const parts = normalizedPath.split("/").filter(Boolean);
  for (const part of parts) {
    const lowerPart = part.toLowerCase();
    if (lowerPart === ".env" || lowerPart.startsWith(".env.")) return "environment file";
    if (lowerPart === ".npmrc") return "package-manager credential file";
    if (lowerPart === ".secure") return "secure-material path";
  }
  if (kind !== "file" || parts.length === 0) return null;
  if (isKnownNonSecretDependencySchema(normalizedPath)) return null;

  const fileName = parts.at(-1).toLowerCase();
  const extension = path.posix.extname(fileName);
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

function assertArtifactTreeHasNoSensitivePaths(rootPath) {
  const resolvedRoot = fs.realpathSync(rootPath);
  const visitedDirectories = new Set();
  function walk(directory) {
    const realDirectory = fs.realpathSync(directory);
    const directoryKey = process.platform === "win32" ? realDirectory.toLowerCase() : realDirectory;
    if (visitedDirectories.has(directoryKey)) return;
    visitedDirectories.add(directoryKey);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = normalize(path.relative(resolvedRoot, entryPath));
      const targetStats = fs.statSync(entryPath);
      assertSafeArtifactPath(relativePath, targetStats.isDirectory() ? "directory" : "file");
      if (targetStats.isDirectory()) walk(entryPath);
      else if (!targetStats.isFile()) throw new Error(`artifact tree contains a non-regular entry: ${relativePath}`);
    }
  }
  walk(resolvedRoot);
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

const sensitiveVerificationRoot = options.get("--verify-sensitive-root");
if (sensitiveVerificationRoot) {
  try {
    if (!fs.statSync(sensitiveVerificationRoot).isDirectory()) throw new Error("verification root is not a directory");
    assertArtifactTreeHasNoSensitivePaths(sensitiveVerificationRoot);
    console.log(`PASS artifact sensitive-path policy: ${path.resolve(sensitiveVerificationRoot)}`);
    process.exit(0);
  } catch (error) {
    stop(`artifact sensitive-path policy rejected input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const root = path.resolve(options.get("--root") || process.cwd());
const service = options.get("--service");
const outputOption = options.get("--output");
const releaseId = options.get("--release-id") || process.env.RELEASE_ID;
const requestedCommit = (options.get("--commit") || process.env.DEPLOY_COMMIT_SHA || "").toLowerCase();
const allowLocalRehearsal = options.get("--allow-local-rehearsal") === "1";
if (!service || !["web", "voice"].includes(service)) stop("--service must be web or voice", 2);
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
  const copyMetrics = { materializedSymlinkCount: 0 };
  const trustedSymlinkRoots = [
    standaloneRoot,
    path.join(serviceRoot, "node_modules"),
    path.join(root, "node_modules"),
  ].filter((candidate, index, values) => fs.existsSync(candidate) && values.indexOf(candidate) === index)
    .map((candidate) => fs.realpathSync(candidate));
  copyTree(standaloneRoot, outputRoot, () => true, { trustedSymlinkRoots, metrics: copyMetrics });
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
  copyTree(staticRoot, path.join(outputRoot, ".next", "static"));
  fs.mkdirSync(path.join(outputRoot, ".next"), { recursive: true });
  fs.copyFileSync(buildIdPath, path.join(outputRoot, ".next", "BUILD_ID"));

  if (service === "web") {
    const publicRoot = path.join(root, "public");
    const allowedPublicFiles = new Set((policy.source.publicSourcePaths || []).map(normalize));
    for (const relativePath of allowedPublicFiles) {
      const sourcePath = path.join(root, ...relativePath.split("/"));
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) stop(`missing allowlisted public source file: ${relativePath}`, 2);
      const destinationPath = path.join(outputRoot, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }
    if (!fs.existsSync(publicRoot)) stop(`missing public root: ${publicRoot}`, 2);
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
  function inventoryTree(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const filePath = path.join(directory, entry.name);
      const relativePath = normalize(path.relative(outputRoot, filePath));
      assertSafeArtifactPath(relativePath, entry.isDirectory() ? "directory" : "file");
      if (entry.isSymbolicLink()) stop(`artifact output contains unsupported symlink: ${filePath}`);
      if (entry.isDirectory()) inventoryTree(filePath);
      else if (entry.isFile()) {
        if (relativePath === "release-manifest.json") continue;
        const stats = fs.statSync(filePath);
        inventory.push({ path: relativePath, bytes: stats.size, sha256: sha256File(filePath) });
      }
    }
  }
  inventoryTree(outputRoot);
  inventory.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const artifactDigest = crypto.createHash("sha256")
    .update(inventory.map((file) => `${file.sha256}  ${file.path}\n`).join(""))
    .digest("hex");

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
    fileCount: inventory.length,
    totalBytes: inventory.reduce((total, file) => total + file.bytes, 0),
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
