#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function run(command, arguments_, cwd, { capture = false } = {}) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
    },
  });
  if (result.error) stop(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) stop(`${command} ${arguments_.join(" ")} failed${capture ? `: ${result.stderr || result.stdout}` : ""}`);
  return capture ? result.stdout.trim() : "";
}

function resolvePnpmInvocation() {
  const configuredPath = process.env.PNPM_CLI_PATH?.trim() || process.env.npm_execpath?.trim();
  if (!configuredPath) {
    stop("pnpm CLI identity is unavailable; invoke this build through pnpm run or set PNPM_CLI_PATH", 2);
  }
  const cliPath = path.resolve(configuredPath);
  if (!fs.existsSync(cliPath) || !fs.statSync(cliPath).isFile()) stop(`pnpm CLI path is not a file: ${cliPath}`, 2);
  if (!/^pnpm[.](?:c?js|mjs)$/iu.test(path.basename(cliPath))) stop(`refusing unexpected pnpm CLI identity: ${cliPath}`, 2);
  return { command: process.execPath, prefixArguments: [cliPath] };
}

function runPnpm(arguments_, cwd, options_ = {}) {
  const invocation = resolvePnpmInvocation();
  return run(invocation.command, [...invocation.prefixArguments, ...arguments_], cwd, options_);
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

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (!fs.existsSync(filePath)) {
    fs.renameSync(temporary, filePath);
    return;
  }
  const previous = `${filePath}.previous-${process.pid}-${crypto.randomUUID()}`;
  fs.renameSync(filePath, previous);
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (!fs.existsSync(filePath) && fs.existsSync(previous)) fs.renameSync(previous, filePath);
    throw error;
  }
  try {
    fs.rmSync(previous, { force: true });
  } catch (error) {
    console.warn(`WARN committed ${filePath}, but could not remove previous copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function detectLibc() {
  if (process.platform !== "linux") return "non-linux";
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

const root = path.resolve(options.get("--root") || process.cwd());
const service = options.get("--service");
const allowLocalRehearsal = options.get("--allow-local-rehearsal") === "1";
if (options.get("--verify-pnpm-invocation") === "1") {
  console.log(JSON.stringify({ ok: true, pnpmVersion: runPnpm(["--version"], root, { capture: true }) }));
  process.exit(0);
}
if (!service || !["web", "voice"].includes(service)) stop("--service must be web or voice", 2);

const policyPath = path.join(root, "deploy", "policies", "release-policy.json");
if (!fs.existsSync(policyPath)) stop("missing deploy/policies/release-policy.json", 2);
const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
const productionBuild = policy.release?.productionBuild;
if (!productionBuild) stop("release policy is missing productionBuild", 2);

const gitRoot = path.resolve(run("git", ["rev-parse", "--show-toplevel"], root, { capture: true }));
if (gitRoot.toLowerCase() !== root.toLowerCase()) stop(`build root must be the Git top-level: ${gitRoot}`, 2);
const commitSha = run("git", ["rev-parse", "HEAD"], root, { capture: true }).toLowerCase();
if (!/^[0-9a-f]{40,64}$/u.test(commitSha)) stop("unable to resolve a traceable Git commit", 2);
const gitStatus = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, { capture: true });
if (gitStatus) stop("release build requires a clean Git worktree", 2);
const requestedDeploymentVersion = process.env.DEPLOYMENT_VERSION?.trim().toLowerCase();
if (requestedDeploymentVersion && requestedDeploymentVersion !== commitSha) {
  stop(`DEPLOYMENT_VERSION must equal the clean Git commit: expected=${commitSha} actual=${requestedDeploymentVersion}`, 2);
}
process.env.DEPLOYMENT_VERSION = commitSha;

const nodeMajor = Number(process.versions.node.split(".")[0]);
const platformAllowed = process.platform === productionBuild.platform;
const architectureAllowed = productionBuild.architectures.includes(process.arch);
const nodeAllowed = nodeMajor === productionBuild.nodeMajor && process.versions.node === productionBuild.nodeVersion;
const isProductionEnvironment = platformAllowed && architectureAllowed && nodeAllowed;
if (!isProductionEnvironment && !allowLocalRehearsal) {
  stop(`production builds require ${productionBuild.platform}/${productionBuild.architectures.join("|")}/Node ${productionBuild.nodeVersion}; current=${process.platform}/${process.arch}/${process.version}`, 2);
}

const pnpmVersion = runPnpm(["--version"], root, { capture: true });
const pnpmAllowed = pnpmVersion === productionBuild.pnpmVersion;
if (!pnpmAllowed && !allowLocalRehearsal) stop(`production builds require pnpm ${productionBuild.pnpmVersion}; current=${pnpmVersion}`, 2);

const serviceRoot = service === "web" ? root : path.join(root, "voice-platform");
const servicePnpmPrefix = service === "voice" ? ["--ignore-workspace"] : [];
const lockfilePath = service === "web"
  ? path.join(root, "pnpm-lock.yaml")
  : path.join(root, "voice-platform", "pnpm-lock.yaml");
const sourceManifestPath = path.join(root, ".release", "source-files.v1.json");
const assetManifestPath = path.join(root, ...policy.assets.manifest.split("/"));
for (const requiredPath of [lockfilePath, sourceManifestPath, assetManifestPath]) {
  if (!fs.existsSync(requiredPath)) stop(`missing release build input: ${requiredPath}`, 2);
}
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
const assetManifest = JSON.parse(fs.readFileSync(assetManifestPath, "utf8"));
if (sourceManifest.projectId !== policy.projectId || assetManifest.projectId !== policy.projectId) stop("release manifest identity mismatch", 2);
if (sourceManifest.assetManifestSha256 !== sha256File(assetManifestPath)) stop("source snapshot is not pinned to the current asset manifest", 2);
if (sourceManifest.assetDigest !== assetManifest.digest) stop("source snapshot asset digest mismatch", 2);

const expectedNextVersions = {
  web: "16.2.11",
  voice: "15.5.21",
};
const nextPackagePath = path.join(serviceRoot, "node_modules", "next", "package.json");
if (!fs.existsSync(nextPackagePath)) stop(`Next.js is not installed for ${service}: ${nextPackagePath}`, 2);
const nextVersion = JSON.parse(fs.readFileSync(nextPackagePath, "utf8")).version;
if (nextVersion !== expectedNextVersions[service]) {
  stop(`unexpected ${service} Next.js version: expected=${expectedNextVersions[service]} actual=${nextVersion}`, 2);
}

if (service === "voice") runPnpm([...servicePnpmPrefix, "exec", "prisma", "generate"], serviceRoot);
// Use the same audited Next 16 file tracer as the local production preview.
runPnpm([...servicePnpmPrefix, "exec", "next", "build", ...(service === "web" ? ["--webpack"] : [])], serviceRoot);

const buildDirectory = path.join(serviceRoot, ".next");
// Next may trace the builder's environment link. Remove generated copies only;
// runtime configuration is supplied separately and never belongs in an artifact.
const standaloneRoot = path.join(buildDirectory, "standalone");
const removedEnvironmentEntries = [];
function removeGeneratedEnvironmentEntries(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === ".env" || entry.name.startsWith(".env.") || entry.name === ".npmrc" || entry.name === ".secure") {
      const relative = path.relative(standaloneRoot, entryPath);
      if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) stop("environment cleanup escaped standalone output");
      if (entry.isSymbolicLink()) fs.unlinkSync(entryPath);
      else fs.rmSync(entryPath, { recursive: entry.isDirectory(), force: true });
      removedEnvironmentEntries.push(relative);
    } else if (entry.isDirectory()) removeGeneratedEnvironmentEntries(entryPath);
  }
}
if (fs.existsSync(standaloneRoot)) removeGeneratedEnvironmentEntries(standaloneRoot);
console.log(`Removed ${removedEnvironmentEntries.length} generated environment entries from standalone output.`);

// Runtime state and developer-only checkout material are provisioned separately
// or are irrelevant to production. Next's file tracer can still copy these
// roots when server code contains dynamic filesystem reads, so purge them before
// the audited runtime allowlist is materialized and before provenance is issued.
const nonArtifactRoots = [
  ".codex-backups",
  ".codex-evidence",
  ".codex-snapshots",
  ".codex-temp",
  ".logs",
  ".next-validation",
  ".next-local-acceptance",
  ".next-local-acceptance-next",
  ".runtime",
  ".tmp-e2e",
  "--output=.codex-evidence",
  "%SystemDrive%",
  "artifacts",
  "assets",
  "backups",
  "data",
  "deploy",
  "docs",
  "evidence-archive",
  "prompts",
  "research",
  "research-output",
  "runtime",
  "scripts",
  "src",
  "supabase",
  "tests",
  "voice-platform",
  "任务快照",
  "备份快照",
];
const removedNonArtifactRoots = [];
for (const relativePath of nonArtifactRoots) {
  const target = path.join(standaloneRoot, relativePath);
  if (!fs.existsSync(target)) continue;
  const relative = path.relative(standaloneRoot, target);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) stop("standalone non-artifact cleanup escaped build output");
  fs.rmSync(target, { recursive: true, force: true });
  removedNonArtifactRoots.push(relativePath);
}
console.log(`Removed ${removedNonArtifactRoots.length} generated non-artifact roots from standalone output.`);
run(process.execPath, [path.join(root, "scripts", "prepare-next-standalone-assets.mjs"), "--root", root, "--service", service], root);
if (fs.existsSync(standaloneRoot)) removeGeneratedEnvironmentEntries(standaloneRoot);
run(process.execPath, [path.join(root, "scripts", "verify-standalone-trace-boundary.mjs"), "--artifact"], root);
const standaloneEntrypoint = path.join(buildDirectory, "standalone", "server.js");
const buildIdPath = path.join(buildDirectory, "BUILD_ID");
const requiredServerFilesPath = path.join(buildDirectory, "required-server-files.json");
if (!fs.existsSync(standaloneEntrypoint)) stop(`standalone output missing after build: ${standaloneEntrypoint}`);
if (!fs.existsSync(buildIdPath)) stop(`BUILD_ID missing after build: ${buildIdPath}`);
if (!fs.existsSync(requiredServerFilesPath)) stop(`required-server-files.json missing after build: ${requiredServerFilesPath}`);
const buildId = fs.readFileSync(buildIdPath, "utf8").trim();
if (!buildId) stop("BUILD_ID is empty after build");
const requiredServerFiles = JSON.parse(fs.readFileSync(requiredServerFilesPath, "utf8"));
const compiledDeploymentId = requiredServerFiles.config?.deploymentId;
if (compiledDeploymentId !== commitSha) {
  stop(`compiled deploymentId must equal the immutable Git commit: expected=${commitSha} actual=${compiledDeploymentId || "missing"}`, 2);
}
const buildIdStrategy = service === "voice"
  ? "next-15-generate-build-id-git-commit"
  : "next-16-deployment-id-skew-protection";
if (service === "voice" && buildId !== commitSha) {
  stop(`Voice BUILD_ID must equal the immutable Git commit: expected=${commitSha} actual=${buildId}`, 2);
}

const finalGitStatus = run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], root, { capture: true });
if (finalGitStatus) stop("build changed tracked or unignored source files; refusing provenance", 2);

const buildEnvironment = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.version,
  nodeModulesAbi: process.versions.modules,
  libc: detectLibc(),
  pnpmVersion,
  lockfileSha256: sha256File(lockfilePath),
};
const deployable = isProductionEnvironment && pnpmAllowed && ["glibc", "musl"].includes(buildEnvironment.libc);
const provenance = {
  schemaVersion: 1,
  projectId: policy.projectId,
  kind: "release-build-provenance",
  service,
  deployable,
  rehearsal: !deployable,
  sourceCommit: commitSha,
  sourceManifestSha256: sha256File(sourceManifestPath),
  sourceFingerprint: sourceManifest.sourceFingerprint,
  policySha256: sha256File(policyPath),
  assetManifestSha256: sha256File(assetManifestPath),
  assetDigest: assetManifest.digest,
  assetVersion: assetManifest.assetVersion,
  deploymentId: commitSha,
  compiledDeploymentId,
  nextVersion,
  buildIdStrategy,
  buildId,
  builtAt: new Date().toISOString(),
  buildEnvironment,
};
const provenancePath = path.join(buildDirectory, "release-provenance.v1.json");
writeJsonAtomic(provenancePath, provenance);

console.log(`PASS ${service} ${deployable ? "production" : "local rehearsal"} build`);
console.log(`BUILD_ID ${buildId}`);
console.log(`COMMIT ${commitSha}`);
console.log(`PROVENANCE ${provenancePath}`);
