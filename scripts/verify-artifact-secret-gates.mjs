#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeBuildOutputDigest } from "./compute-release-build-output-digest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagerPath = path.join(root, "scripts", "package-standalone-artifact.mjs");
const deployerPath = path.join(root, "scripts", "deploy-artifact-vnext.sh");
const verifierSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
const packagerSource = fs.readFileSync(packagerPath, "utf8");
const deployerSource = fs.readFileSync(deployerPath, "utf8");
const digestSource = fs.readFileSync(path.join(root, "scripts", "compute-release-build-output-digest.mjs"), "utf8");
const materializerSource = fs.readFileSync(path.join(root, "scripts", "materialize-storage-runtime.mjs"), "utf8");

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

function createDirectoryLink(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
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
    ".next/server/app/api/conversations/history/route.js",
    ".next/server/app/api/runtime/cache/route.js",
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
    "runtime/private.pem",
    "runtime/public.pub",
    "runtime/certificate.crt",
    "runtime/certificate.cer",
    "runtime/certificate.p7b",
    "runtime/debug.map",
    "id_rsa",
    "node_modules/untrusted/cookie.json",
    ".git/config",
    ".svn/entries",
    ".hg/store/data",
    ".history/snapshot.json",
    ".cache/state.bin",
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

  const pemContentRoot = path.join(temporaryRoot, "pem-content");
  createTree(pemContentRoot, ["server.js", "runtime/blob.bin"]);
  const privateKeyPemMarker = ["-----BEGIN ", "PRIVATE ", "KEY-----"].join("");
  const privateKeyPemFooter = ["-----END ", "PRIVATE ", "KEY-----"].join("");
  assert.equal(verifierSource.includes(privateKeyPemMarker), false, "complete PEM fixture marker must not be stored in verifier source");
  assert.equal(verifierSource.includes(privateKeyPemFooter), false, "complete PEM fixture footer must not be stored in verifier source");
  const privateKeyFixtureBody = Buffer.concat([Buffer.from([0x30, 0x3e]), Buffer.alloc(62, 0x07)])
    .toString("base64")
    .match(/.{1,64}/gu)
    .join("\n");
  fs.writeFileSync(path.join(pemContentRoot, "runtime", "blob.bin"), `${privateKeyPemMarker}\n${privateKeyFixtureBody}\n${privateKeyPemFooter}\n`, "utf8");

  const pemPackagerResult = run(process.execPath, [packagerPath, "--verify-sensitive-root", pemContentRoot]);
  assert.notEqual(pemPackagerResult.status, 0, "packager accepted disguised private-key PEM content");
  assert.match(outputOf(pemPackagerResult), /forbidden private-key PEM content/iu);

  const pemDeployerResult = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(pemContentRoot)]);
  assert.notEqual(pemDeployerResult.status, 0, "deployer accepted disguised private-key PEM content");
  assert.match(outputOf(pemDeployerResult), /forbidden private-key PEM content/iu);

  const pemMarkerOnlyRoot = path.join(temporaryRoot, "pem-marker-only");
  createTree(pemMarkerOnlyRoot, ["server.js", "runtime/documentation.txt"]);
  fs.writeFileSync(path.join(pemMarkerOnlyRoot, "runtime", "documentation.txt"), `documentation example: ${privateKeyPemMarker}\n`, "utf8");
  const markerOnlyPackagerResult = run(process.execPath, [packagerPath, "--verify-sensitive-root", pemMarkerOnlyRoot]);
  assert.equal(markerOnlyPackagerResult.status, 0, `packager rejected a marker-only documentation example:\n${outputOf(markerOnlyPackagerResult)}`);
  const markerOnlyDeployerResult = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(pemMarkerOnlyRoot)]);
  assert.equal(markerOnlyDeployerResult.status, 0, `deployer rejected a marker-only documentation example:\n${outputOf(markerOnlyDeployerResult)}`);

  const binaryMarkerRoot = path.join(temporaryRoot, "binary-marker-pair");
  createTree(binaryMarkerRoot, ["server.js", "runtime-tools/ffmpeg.exe"]);
  const openSshPemMarker = ["-----BEGIN ", "OPENSSH PRIVATE ", "KEY-----"].join("");
  const openSshPemFooter = ["-----END ", "OPENSSH PRIVATE ", "KEY-----"].join("");
  fs.writeFileSync(path.join(binaryMarkerRoot, "runtime-tools", "ffmpeg.exe"), Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0x00, 0xff, 0x10]),
    Buffer.from(openSshPemMarker, "ascii"),
    Buffer.from([0x00, 0xff, 0x80, 0x01, 0x02, 0x03]),
    Buffer.from(openSshPemFooter, "ascii"),
  ]));
  const binaryMarkerPackagerResult = run(process.execPath, [packagerPath, "--verify-sensitive-root", binaryMarkerRoot]);
  assert.equal(binaryMarkerPackagerResult.status, 0, `packager rejected non-key binary marker strings:\n${outputOf(binaryMarkerPackagerResult)}`);
  const binaryMarkerDeployerResult = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(binaryMarkerRoot)]);
  assert.equal(binaryMarkerDeployerResult.status, 0, `deployer rejected non-key binary marker strings:\n${outputOf(binaryMarkerDeployerResult)}`);

  const materializableProject = path.join(temporaryRoot, "materializable-project");
  const materializableStandalone = path.join(materializableProject, ".next", "standalone");
  const trustedPackage = path.join(materializableProject, "node_modules", "trusted-package");
  createTree(materializableStandalone, ["server.js", "runtime/debug.map"]);
  createTree(trustedPackage, ["package.json", "index.js"]);
  fs.writeFileSync(path.join(trustedPackage, "README.md"), `${privateKeyPemMarker}\nfixture-only\n${privateKeyPemFooter}\n`, "utf8");
  createDirectoryLink(trustedPackage, path.join(materializableStandalone, "node_modules", "trusted-package"));
  const materializableAccepted = run(process.execPath, [
    packagerPath,
    "--verify-materializable-root", materializableStandalone,
    "--root", materializableProject,
    "--service", "web",
  ]);
  assert.equal(materializableAccepted.status, 0, `trusted standalone dependency link was rejected:\n${outputOf(materializableAccepted)}`);
  assert.match(outputOf(materializableAccepted), /omittedSourceMaps=1/u);
  assert.match(outputOf(materializableAccepted), /omittedPackageDocumentation=1/u);
  assert.equal(outputOf(materializableAccepted).includes(fs.realpathSync(trustedPackage)), false, "materializable verifier exposed an absolute link target");

  const digestProject = path.join(temporaryRoot, "build-output-digest");
  createTree(digestProject, [
    ".next/BUILD_ID",
    ".next/standalone/server.js",
    ".next/standalone/node_modules/trusted-package/package.json",
    ".next/standalone/node_modules/trusted-package/index.js",
    ".next/static/app.js",
  ]);
  fs.writeFileSync(path.join(digestProject, ".next", "BUILD_ID"), "fixture-build-id\n", "utf8");
  fs.writeFileSync(
    path.join(digestProject, ".next", "standalone", "node_modules", "trusted-package", "README.md"),
    `${privateKeyPemMarker}\nfixture-only\n${privateKeyPemFooter}\n`,
    "utf8",
  );
  const digest = computeBuildOutputDigest(digestProject, "web", "a".repeat(40), "R_TEST");
  assert.equal(digest.files.some((entry) => entry.path.endsWith("/README.md")), false, "build digest retained non-runtime package documentation");
  assert.equal(digest.files.some((entry) => entry.path.endsWith("/index.js")), true, "build digest omitted runtime package code");

  const finalLinkPackager = run(process.execPath, [packagerPath, "--verify-sensitive-root", materializableStandalone]);
  assert.notEqual(finalLinkPackager.status, 0, "final packager gate accepted a symbolic link or junction");
  assert.match(outputOf(finalLinkPackager), /forbidden symbolic link or junction/iu);
  const finalLinkDeployer = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(materializableStandalone)]);
  assert.notEqual(finalLinkDeployer.status, 0, "final deployer gate accepted a symbolic link or junction");
  assert.match(outputOf(finalLinkDeployer), /symbolic link|symlink|junction|non-regular/iu);

  const finalMapRoot = path.join(temporaryRoot, "final-map");
  createTree(finalMapRoot, ["server.js", "runtime/debug.map"]);
  const finalMapPackager = run(process.execPath, [packagerPath, "--verify-sensitive-root", finalMapRoot]);
  assert.notEqual(finalMapPackager.status, 0, "final packager gate accepted a source map");
  assert.match(outputOf(finalMapPackager), /forbidden sensitive artifact path/iu);
  const finalMapDeployer = run(bash, ["scripts/deploy-artifact-vnext.sh", "--verify-sensitive-root", toBashPath(finalMapRoot)]);
  assert.notEqual(finalMapDeployer.status, 0, "final deployer gate accepted a source map");
  assert.match(outputOf(finalMapDeployer), /forbidden sensitive artifact path/iu);

  const materializableCases = [
    {
      name: "outside",
      pattern: /escapes trusted build roots/iu,
      prepare(standalone) {
        const outside = path.join(temporaryRoot, "outside-target");
        createTree(outside, ["package.json"]);
        createDirectoryLink(outside, path.join(standalone, "node_modules", "outside"));
      },
    },
    {
      name: "broken",
      pattern: /broken link/iu,
      prepare(standalone) {
        createDirectoryLink(path.join(temporaryRoot, "missing-target"), path.join(standalone, "node_modules", "broken"));
      },
    },
    {
      name: "cycle",
      pattern: /cyclic directory link/iu,
      prepare(standalone) {
        createDirectoryLink(standalone, path.join(standalone, "node_modules", "cycle"));
      },
    },
    {
      name: "sensitive-real-target-alias",
      pattern: /forbidden sensitive target/iu,
      prepare(standalone, project) {
        const sensitiveTarget = path.join(project, "node_modules", ".secure");
        createTree(sensitiveTarget, ["opaque.bin"]);
        createDirectoryLink(sensitiveTarget, path.join(standalone, "node_modules", "safe-alias"));
      },
    },
    {
      name: "sensitive-logical-alias",
      pattern: /forbidden sensitive materializable logical path/iu,
      prepare(standalone, project) {
        const safeTarget = path.join(project, "node_modules", "safe-target");
        createTree(safeTarget, ["package.json"]);
        createDirectoryLink(safeTarget, path.join(standalone, ".secure"));
      },
    },
  ];
  for (const fixture of materializableCases) {
    const project = path.join(temporaryRoot, `materializable-${fixture.name}`);
    const standalone = path.join(project, ".next", "standalone");
    createTree(standalone, ["server.js"]);
    fs.mkdirSync(path.join(project, "node_modules"), { recursive: true });
    fixture.prepare(standalone, project);
    const result = run(process.execPath, [packagerPath, "--verify-materializable-root", standalone, "--root", project, "--service", "web"]);
    assert.notEqual(result.status, 0, `materializable verifier accepted ${fixture.name}`);
    assert.match(outputOf(result), fixture.pattern);
    assert.equal(outputOf(result).includes(path.join(project, "node_modules")), false, `${fixture.name} error exposed an absolute target`);
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
  assert.match(deployerSource, /assertNotSensitive\(item\.path, "manifest inventory", item\.kind\)/u);

  const packagerHiddenMetadataChecks = packagerSource.match(/hiddenMetadataDirectoryNames\.has\(lowerPart\)/gu) || [];
  const deployerHiddenMetadataChecks = deployerSource.match(/hiddenMetadataDirectoryNames\.has\(lowerPart\)/gu) || [];
  const deployerForbiddenExtensionChecks = deployerSource.match(/forbiddenArtifactExtensions\.has\(extension\)/gu) || [];
  assert.equal(packagerHiddenMetadataChecks.length, 1, "packager must apply the hidden metadata directory policy once");
  assert.equal(deployerHiddenMetadataChecks.length, 2, "deployer must apply the hidden metadata directory policy to archive/tree and manifest inventory checks");
  assert.equal(deployerForbiddenExtensionChecks.length, 2, "deployer must apply key, certificate, and source-map extension policy to archive/tree and manifest inventory checks");
  const deployerArchiveTreePolicy = deployerSource.indexOf("hiddenMetadataDirectoryNames.has(lowerPart)", deployerSource.indexOf("verify_sensitive_artifact_paths()"));
  const deployerArchiveTreeExtensionPolicy = deployerSource.indexOf("forbiddenArtifactExtensions.has(extension)", deployerSource.indexOf("verify_sensitive_artifact_paths()"));
  const deployerArchiveBranch = deployerSource.indexOf('if (inputMode === "archive")', deployerArchiveTreePolicy);
  const deployerManifestValidator = deployerSource.indexOf("validate_payload_inventory() {");
  const deployerManifestPolicy = deployerSource.indexOf("hiddenMetadataDirectoryNames.has(lowerPart)", deployerManifestValidator);
  const deployerManifestExtensionPolicy = deployerSource.indexOf("forbiddenArtifactExtensions.has(extension)", deployerManifestValidator);
  const deployerManifestContentGate = deployerSource.indexOf("assertSafeContent(filePath, relativePath)", deployerManifestValidator);
  assert.ok(deployerArchiveTreePolicy > 0 && deployerArchiveTreePolicy < deployerArchiveBranch, "deployer archive/tree preflight must share the hidden metadata directory policy");
  assert.ok(deployerArchiveTreeExtensionPolicy > 0 && deployerArchiveTreeExtensionPolicy < deployerArchiveBranch, "deployer archive/tree preflight must apply the forbidden extension policy before extraction");
  assert.ok(deployerManifestPolicy > deployerManifestValidator, "deployer manifest inventory must apply the hidden metadata directory policy");
  assert.ok(deployerManifestExtensionPolicy > deployerManifestValidator, "deployer manifest inventory must apply the forbidden extension policy");
  assert.ok(deployerManifestContentGate > deployerManifestValidator, "deployer extracted payload inventory must scan file content for private-key PEM material");
  assert.doesNotMatch(packagerSource, /["']history["']\s*,\s*["']\.cache["']/u, "plain history directory must not be forbidden by the packager");
  assert.doesNotMatch(packagerSource, /["']cache["']\s*\]/u, "plain cache directory must not be forbidden by the packager");
  assert.match(packagerSource, /if \(isNonRuntimePackageDocumentation\(sourcePath\)\)/u, "packager copy must omit non-runtime package documentation");
  assert.match(digestSource, /isNonRuntimePackageDocumentation\(relative\)/u, "build-output digest must omit the same non-runtime package documentation");
  assert.match(materializerSource, /omittedPackageDocumentation/u, "dependency materialization must omit and report non-runtime package documentation");

  console.log("PASS artifact secret gates reject sensitive names at packaging and deployment layers");
  console.log("PASS allowed environment-neutral, source-code, history, and cache paths remain accepted");
  console.log("PASS hidden metadata directory policy covers deploy archive/tree and manifest checks");
  console.log("PASS key/certificate paths and disguised private-key PEM content remain rejected");
  console.log("PASS materializable standalone accepts trusted links, omits source maps, and rejects escaped, broken, cyclic, or sensitive aliases");
  console.log("PASS non-runtime package documentation is omitted before digesting and materialization");
  console.log("PASS final packager/deployer gates reject links and source maps");
  console.log(`PASS forbidden fixtures checked: ${forbiddenPaths.length}`);
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  if (resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`) && path.basename(resolvedTemporaryRoot).startsWith("artifact-secret-gates-")) {
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  }
}
