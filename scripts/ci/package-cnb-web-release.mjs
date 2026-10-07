#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function stop(message, code = 1) {
  console.error(`FAIL ${message}`);
  process.exit(code);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    stop(`${command} ${args.join(" ")} failed: ${result.error?.message || result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return options.capture ? result.stdout.trim() : "";
}

function sha256(filePath) {
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

function writeJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

const root = process.cwd();
const gitRoot = path.resolve(run("git", ["rev-parse", "--show-toplevel"], { capture: true }));
if (gitRoot !== path.resolve(root)) stop(`CNB package step must run at Git top-level: ${gitRoot}`, 2);
if (run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { capture: true })) {
  stop("CNB package step requires a clean Git worktree", 2);
}

const tag = (process.env.CNB_BRANCH || "").trim();
const match = /^deploy\/(V[1-9][0-9]*\.[0-9]+-[a-f0-9]{12})$/u.exec(tag);
if (!match) stop(`refusing non-release tag: ${tag || "<empty>"}`, 2);
const releaseIdentity = match[1];
const releaseId = `web-direct-${releaseIdentity.toLowerCase()}`;
const commitSha = run("git", ["rev-parse", "HEAD"], { capture: true }).toLowerCase();
if (!/^[a-f0-9]{40,64}$/u.test(commitSha)) stop("invalid Git commit identity", 2);

const workspace = path.resolve(process.env.CNB_BUILD_WORKSPACE || root);
if (workspace !== root) stop(`CNB_BUILD_WORKSPACE must equal the checked-out repository root: ${workspace}`, 2);
const attachmentRoot = path.join(workspace, ".cnb-artifacts");
if (fs.existsSync(attachmentRoot)) stop(`refusing to reuse attachment directory: ${attachmentRoot}`, 2);
fs.mkdirSync(attachmentRoot, { recursive: false });

const outputRoot = path.join(os.tmpdir(), `zimeiti-${releaseIdentity.toLowerCase()}-${process.pid}`);
if (fs.existsSync(outputRoot)) stop(`refusing to overwrite artifact directory: ${outputRoot}`, 2);
const archivePath = path.join(attachmentRoot, "web-release.tar.gz");

try {
  run(process.execPath, [
    "scripts/package-standalone-artifact.mjs",
    "--service", "web",
    "--output", outputRoot,
    "--release-id", releaseId,
    "--commit", commitSha,
    "--archive",
    "--archive-path", archivePath,
  ]);

  const releaseManifestPath = path.join(outputRoot, "release-manifest.json");
  const sourceManifestPath = path.join(root, ".release", "source-files.v1.json");
  const versionPath = path.join(root, "public", "version.json");
  for (const filePath of [releaseManifestPath, sourceManifestPath, versionPath, archivePath, `${archivePath}.sha256`]) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) stop(`missing CNB release output: ${filePath}`);
  }

  const releaseManifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  const version = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  if (releaseManifest.deployable !== true || releaseManifest.releaseId !== releaseId || releaseManifest.commitSha !== commitSha) {
    stop("packaged release manifest identity mismatch");
  }
  if (releaseManifest.sourceManifestSha256 !== sha256(sourceManifestPath)
      || releaseManifest.sourceFingerprint !== sourceManifest.sourceFingerprint) {
    stop("packaged release is not bound to the current source manifest");
  }

  fs.copyFileSync(releaseManifestPath, path.join(attachmentRoot, "release-manifest.json"), fs.constants.COPYFILE_EXCL);
  const receipt = {
    schemaVersion: 1,
    kind: "tencent-cnb-linux-artifact.v1",
    status: "SUCCESS",
    releaseIdentity,
    releaseId,
    sourceVersion: version.sourceVersion,
    sourceFingerprint: sourceManifest.sourceFingerprint,
    sourceManifestSha256: sha256(sourceManifestPath),
    commitSha,
    buildId: releaseManifest.buildId,
    artifactSha256: sha256(archivePath),
    releaseManifestSha256: sha256(releaseManifestPath),
    buildEnvironment: releaseManifest.buildEnvironment,
    security: {
      builder: "tencent-cnb-container",
      productionPathsMounted: false,
      deploymentCredentialsInjected: false,
      productionActivationAttempted: false,
    },
    cnb: {
      buildId: process.env.CNB_BUILD_ID || null,
      event: process.env.CNB_EVENT || "tag_push",
      tag,
    },
    createdAt: new Date().toISOString(),
  };
  writeJson(path.join(attachmentRoot, "cnb-build-receipt.json"), receipt);
  console.log(`PASS CNB immutable artifact ${releaseId} commit=${commitSha} sha256=${receipt.artifactSha256}`);
} finally {
  if (fs.existsSync(outputRoot)) fs.rmSync(outputRoot, { recursive: true, force: true });
}
