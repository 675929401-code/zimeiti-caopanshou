#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagerPath = path.join(root, "scripts", "package-standalone-artifact.mjs");
const deployerPath = path.join(root, "scripts", "deploy-artifact-vnext.sh");
const packagerSource = fs.readFileSync(packagerPath, "utf8");
const deployerSource = fs.readFileSync(deployerPath, "utf8");

function findBash() {
  const candidates = [
    process.env.BASH_EXE,
    process.platform === "win32" ? "E:\\大模型聚合套壳\\Git\\bin\\bash.exe" : "bash",
    "bash",
  ].filter(Boolean);
  for (const candidate of new Set(candidates)) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error("bash is required for the deploy sensitive-path gate test");
}

function toBashPath(nativePath) {
  if (process.platform !== "win32") return nativePath;
  const normalized = path.resolve(nativePath).replace(/\\/gu, "/");
  return normalized.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`);
}

function createTree(base, files) {
  fs.mkdirSync(base, { recursive: true });
  for (const relativePath of files) {
    const filePath = path.join(base, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "fixture-only\n", "utf8");
  }
}

function run(executable, arguments_, options = {}) {
  return spawnSync(executable, arguments_, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}`,
    },
    ...options,
  });
}

function outputOf(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

const bash = findBash();
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-secret-gates-"));
try {
  const allowedRoot = path.join(temporaryRoot, "allowed");
  createTree(allowedRoot, [
    ".next/BUILD_ID",
    "config/environment-neutral.json",
    "config/public-key.json",
    "node_modules/cookie/index.js",
    "node_modules/.pnpm/har-schema@2.0.0/node_modules/har-schema/lib/cookie.json",
    "server.js",
    "src/token-utils.js",
    ".next/server/app/api/voice/sso-token/route.js",
  ]);

  const allowedPackager = run(process.execPath, [packagerPath, "--verify-sensitive-root", allowedRoot]);
  assert.equal(allowedPackager.status, 0, `packager rejected allowed env-neutral paths:\n${outputOf(allowedPackager)}`);
  const allowedDeployer = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(allowedRoot)]);
  assert.equal(allowedDeployer.status, 0, `deployer rejected allowed env-neutral paths:\n${outputOf(allowedDeployer)}`);

  const forbiddenPaths = [
    ".env",
    ".env.local",
    ".npmrc",
    ".secure/opaque.bin",
    "config/access-token.txt",
    "config/cookies.json",
    "config/credentials.json",
    "config/private.key",
    "id_rsa",
    "node_modules/untrusted/cookie.json",
  ];
  for (const [index, forbiddenPath] of forbiddenPaths.entries()) {
    const maliciousRoot = path.join(temporaryRoot, `malicious-${index}`);
    createTree(maliciousRoot, ["server.js", forbiddenPath]);

    const packagerResult = run(process.execPath, [packagerPath, "--verify-sensitive-root", maliciousRoot]);
    assert.notEqual(packagerResult.status, 0, `packager accepted forbidden path: ${forbiddenPath}`);
    assert.match(outputOf(packagerResult), /forbidden sensitive artifact path/iu);

    const deployerResult = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(maliciousRoot)]);
    assert.notEqual(deployerResult.status, 0, `deployer accepted forbidden path: ${forbiddenPath}`);
    assert.match(outputOf(deployerResult), /forbidden sensitive artifact path/iu);
  }

  const packagerInventoryWalk = packagerSource.indexOf("function inventoryTree");
  const packagerInventoryGate = packagerSource.indexOf("assertSafeArtifactPath(relativePath", packagerInventoryWalk);
  const packagerCommit = packagerSource.indexOf("fs.renameSync(outputRoot, finalOutputRoot)");
  assert.ok(packagerInventoryWalk > 0 && packagerInventoryGate > packagerInventoryWalk && packagerInventoryGate < packagerCommit, "packager sensitive gate must run during inventory before artifact commit");

  const archiveGate = deployerSource.indexOf('verify_sensitive_artifact_paths archive "$names_file" "$types_file"');
  const extraction = deployerSource.indexOf('tar "${TAR_COMPRESSION[@]}" --extract --restrict');
  const extractedGate = deployerSource.indexOf('verify_sensitive_artifact_paths tree "$PAYLOAD_DIR"', extraction);
  const payloadValidation = deployerSource.indexOf('validate_payload_inventory "$PAYLOAD_DIR"', extraction);
  assert.ok(archiveGate > 0 && archiveGate < extraction, "deployment archive inventory gate must run before extraction");
  assert.ok(extractedGate > extraction && extractedGate < payloadValidation, "deployment extracted-tree gate must run before payload inventory validation");
  assert.match(deployerSource, /assertNotSensitive\(file\.path, "manifest inventory"\)/u);

  console.log("PASS artifact secret gates reject sensitive names at packaging and deployment layers");
  console.log("PASS allowed environment-neutral and source-code paths remain accepted");
  console.log(`PASS forbidden fixtures checked: ${forbiddenPaths.length}`);
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`) && path.basename(resolvedTemporaryRoot).startsWith("artifact-secret-gates-")) {
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}
