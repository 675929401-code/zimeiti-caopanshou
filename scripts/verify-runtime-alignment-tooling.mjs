import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  copySignedLegacyInventory,
  legacyBuildOutputDigest,
  quarantineNormalizedRelease,
  validateInventory,
} from "./normalize-legacy-runtime-vnext.mjs";
import {
  dumpWorkersMatch,
  snapshotWorkers,
  workersMatch,
} from "./media-worker-transaction-hook-vnext.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeFixtureFile(root, relativePath, body) {
  const absolute = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o755 });
  fs.writeFileSync(absolute, body, { mode: 0o444 });
  fs.chmodSync(absolute, 0o444);
  return absolute;
}

function legacyInventoryFixture(root) {
  const content = new Map([
    [".next/BUILD_ID", "fixture-build\n"],
    [".release/build-provenance.v1.json", "{}\n"],
    [".release/ecosystem.config.cjs", "module.exports = {};\n"],
    [".release/source-files.v1.json", "{}\n"],
    ["public/shared.txt", "code-owned public asset\n"],
    ["server.js", "process.exitCode = 0;\n"],
  ]);
  const files = [...content.entries()]
    .map(([relativePath, body]) => {
      const bytes = Buffer.from(body);
      writeFixtureFile(root, relativePath, bytes);
      return { path: relativePath, bytes: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const directory of [root, path.join(root, ".next"), path.join(root, ".release"), path.join(root, "public")]) {
    fs.chmodSync(directory, 0o555);
  }
  return {
    files,
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.bytes, 0),
    artifactDigest: sha256(files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("")),
  };
}

// Test-owned trees only. Never follow links or change production inventory modes.
function cleanupFixtureTree(scopeRoot, target = scopeRoot, filesystem = fs) {
  const root = path.resolve(scopeRoot);
  const absolute = path.resolve(target);
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()), "FIXTURE_CLEANUP_ROOT_INVALID");
  assert.match(path.basename(root), /^zimeiti-runtime-alignment-/u, "FIXTURE_CLEANUP_ROOT_INVALID");
  const relative = path.relative(root, absolute);
  assert.ok(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)), "FIXTURE_CLEANUP_OUTSIDE_ROOT");
  // A caller may request a subtree, but it must not enter through a link ancestor.
  let ancestor = root;
  const parts = relative ? relative.split(path.sep) : [];
  for (let index = 0; index < parts.length; index += 1) {
    let metadata;
    try { metadata = filesystem.lstatSync(ancestor); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink(), "FIXTURE_CLEANUP_LINK_ANCESTOR");
    ancestor = path.join(ancestor, parts[index]);
  }
  function remove(entry) {
    try {
      const metadata = filesystem.lstatSync(entry);
      if (metadata.isSymbolicLink()) { filesystem.unlinkSync(entry); return; }
      if (metadata.isDirectory()) {
        filesystem.chmodSync(entry, (metadata.mode & 0o055) | 0o700);
        for (const name of filesystem.readdirSync(entry)) remove(path.join(entry, name));
        filesystem.rmdirSync(entry);
      } else {
        assert.ok(metadata.isFile(), "FIXTURE_CLEANUP_ENTRY_UNSUPPORTED");
        filesystem.chmodSync(entry, (metadata.mode & 0o155) | 0o600);
        filesystem.unlinkSync(entry);
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  remove(absolute);
}

function withFixtureCleanup(root, operation, cleanup = cleanupFixtureTree) {
  let result;
  let primaryError;
  let cleanupError;
  let primaryFailed = false;
  let cleanupFailed = false;
  try { result = operation(); } catch (error) { primaryFailed = true; primaryError = error; }
  try {
    cleanup(root);
    try { fs.lstatSync(root); throw new Error("FIXTURE_ROOT_NOT_REMOVED"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } catch (error) { cleanupFailed = true; cleanupError = error; }
  if (primaryFailed && cleanupFailed) throw new AggregateError([primaryError, cleanupError], "Verification and fixture cleanup both failed");
  if (primaryFailed) throw primaryError;
  if (cleanupFailed) throw cleanupError;
  return result;
}

function sealedCleanupFixture(root) {
  const nested = path.join(root, "nested", "deeper");
  fs.mkdirSync(nested, { recursive: true, mode: 0o755 });
  writeFixtureFile(nested, "sealed.txt", "fixture only\n");
  for (const directory of [nested, path.dirname(nested), root]) fs.chmodSync(directory, 0o555);
}

function cleanupFailureChild(scenario) {
  assert.ok(["assertion-failure", "cleanup-failure", "dual-failure"].includes(scenario));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-runtime-alignment-"));
  sealedCleanupFixture(root);
  try {
    withFixtureCleanup(root, () => {
      if (scenario !== "cleanup-failure") assert.fail("INJECTED_ASSERTION_FAILURE");
      return { ok: true };
    }, (scope) => cleanupFixtureTree(scope, scope, scenario === "assertion-failure" ? fs : {
      ...fs, chmodSync() { throw Object.assign(new Error("INJECTED_CLEANUP_FAILURE"), { code: "EACCES" }); },
    }));
    throw new Error("EXPECTED_FIXTURE_FAILURE_MISSING");
  } catch (error) {
    const rootRemovedBeforeRecovery = !fs.existsSync(root);
    // The deliberate failure stays nonzero; release only this child's test residue.
    cleanupFixtureTree(root);
    process.stderr.write(`${JSON.stringify({ name: error.name, message: error.message,
      errors: error instanceof AggregateError ? error.errors.map((cause) => ({ name: cause.name, message: cause.message })) : [],
      rootRemovedBeforeRecovery, rootRemoved: !fs.existsSync(root) })}\n`);
    process.exitCode = 1;
  }
}

function workerEntry(cwd, port, overrides = {}, dump = false) {
  const identity = {
    PORT: String(port),
    RELEASE_ID: "web-fixture-12345678",
    DEPLOY_COMMIT_SHA: "a".repeat(40),
    EXPECTED_BUILD_ID: "build-fixture",
    RELEASE_SOURCE_VERSION: "R000001-fixture",
    RELEASE_BUILD_OUTPUT_DIGEST: "b".repeat(64),
    ASSET_DIGEST: "c".repeat(64),
    ASSET_MANIFEST_SHA256: "d".repeat(64),
    MEDIA_QUEUE_WORKER_PROCESS: "1",
    DIGITAL_VIDEO_QUEUE_WORKER: "1",
    DIGITAL_HUMAN_LONG_WORKER: "1",
    ...overrides,
  };
  if (dump) {
    return {
      name: "agent-hub-media-worker",
      status: "online",
      pm_cwd: cwd,
      pm_exec_path: path.join(cwd, "server.js"),
      exec_mode: "fork_mode",
      ...identity,
    };
  }
  return {
    name: "agent-hub-media-worker",
    pid: port,
    pm2_env: {
      status: "online",
      pm_cwd: cwd,
      pm_exec_path: path.join(cwd, "server.js"),
      exec_mode: "fork_mode",
      ...identity,
    },
  };
}

if (process.argv[2] === "--fixture-cleanup-selftest") {
  cleanupFailureChild(process.argv[3]);
} else {
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-runtime-alignment-"));
const verification = withFixtureCleanup(temporaryRoot, () => {
  const require = createRequire(import.meta.url);
  const pm2ConfigPath = path.resolve("deploy/pm2/ecosystem.vnext.config.cjs");
  const previousReleaseNodeBinary = process.env.RELEASE_NODE_BINARY;
  process.env.RELEASE_NODE_BINARY = "/data/toolchains/node-v24.19.0-linux-x64/bin/node";
  delete require.cache[require.resolve(pm2ConfigPath)];
  const pm2Config = require(pm2ConfigPath);
  if (previousReleaseNodeBinary === undefined) delete process.env.RELEASE_NODE_BINARY;
  else process.env.RELEASE_NODE_BINARY = previousReleaseNodeBinary;
  assert.equal(pm2Config.apps.length, 3);
  assert.equal(pm2Config.apps.every((app) => app.interpreter === "/data/toolchains/node-v24.19.0-linux-x64/bin/node"), true);
  const mediaWorkerConfig = pm2Config.apps.find((app) => app.name === "agent-hub-media-worker");
  assert.equal(mediaWorkerConfig.increment_var, "PORT");
  assert.equal(mediaWorkerConfig.env_production.PORT, 5102);

  const normalizerSource = fs.readFileSync(new URL("./normalize-legacy-runtime-vnext.mjs", import.meta.url), "utf8");
  assert.match(normalizerSource, /RELEASE_NODE_BINARY:\s*process\.execPath/u);
  assert.match(normalizerSource, /PATH:\s*`\$\{path\.dirname\(process\.execPath\)\}:/u);
  assert.match(normalizerSource, /attempt < 200/u);
  assert.match(normalizerSource, /run\("pm2", \["delete", name\]/u);
  assert.match(normalizerSource, /run\("pm2", \["start", config/u);
  assert.doesNotMatch(normalizerSource, /run\("pm2", \["startOrReload"/u);
  // Exercise production cleanup against real files; inject only observations.
  // These tests cannot access live PM2, /proc, servers or the network.
  const cleanupCases = [
    { name: "rollback-failed-before-pointer-restore", rollbackFailure: new Error("injected pointer restore failure"), observation: { confirmed: true, references: [] }, reason: "ROLLBACK_UNCONFIRMED" },
    { name: "current-web-still-targets-release", observation: { confirmed: true, references: ["current-web"] }, reason: "RELEASE_STILL_REFERENCED" },
    { name: "old-worker-still-running", observation: { confirmed: true, references: ["pid:123:cwd"] }, reason: "RELEASE_STILL_REFERENCED" },
    { name: "pm2-inspection-failed", inspectionError: new Error("injected PM2 unavailable"), reason: "RELEASE_QUARANTINE_UNCONFIRMED" },
    { name: "incomplete-process-snapshot", observation: { confirmed: false, references: [] }, reason: "RELEASE_QUARANTINE_UNCONFIRMED" },
    { name: "destination-already-exists", observation: { confirmed: true, references: [] }, occupied: true, reason: "RELEASE_QUARANTINE_UNCONFIRMED" },
    { name: "confirmed-unreferenced", observation: { confirmed: true, references: [] }, reason: "NO_POINTER_OR_PROCESS_REFERENCES", quarantined: true },
  ];
  for (const fixture of cleanupCases) {
    const caseRoot = path.join(temporaryRoot, fixture.name);
    const releaseRoot = path.join(caseRoot, "release");
    const backupRoot = path.join(caseRoot, "backup");
    fs.mkdirSync(releaseRoot, { recursive: true });
    fs.mkdirSync(backupRoot);
    fs.writeFileSync(path.join(releaseRoot, "server.js"), "intact runtime");
    const destination = path.join(backupRoot, "failed-normalized-release");
    if (fixture.occupied) fs.mkdirSync(destination);
    let inspections = 0;
    const result = quarantineNormalizedRelease({
      releaseRoot, backupRoot, rollbackFailure: fixture.rollbackFailure,
      inspectReferences: () => {
        inspections += 1;
        if (fixture.inspectionError) throw fixture.inspectionError;
        return fixture.observation;
      },
    });
    assert.equal(result.reason, fixture.reason, fixture.name);
    assert.equal(result.action, fixture.quarantined ? "quarantined" : "preserved", fixture.name);
    assert.equal(inspections, fixture.rollbackFailure ? 0 : 1, fixture.name);
    assert.equal(fs.existsSync(releaseRoot), !fixture.quarantined, fixture.name);
    assert.equal(fs.readFileSync(path.join(fixture.quarantined ? destination : releaseRoot, "server.js"), "utf8"), "intact runtime", fixture.name);
    if (fixture.rollbackFailure) assert.match(result.rollbackError, /injected pointer restore failure/u);
    if (fixture.inspectionError) assert.match(result.inspectionOrRenameError, /injected PM2 unavailable/u);
  }

  const deployerSource = fs.readFileSync(new URL("./deploy-artifact-vnext.sh", import.meta.url), "utf8");
  assert.match(deployerSource, /RELEASE_NODE_BINARY="\$DEPLOY_NODE_BIN"\s*\nexport RELEASE_NODE_BINARY/u);
  assert.match(deployerSource, /typeof r\.assetOwnershipHardened!==['"]boolean['"]/u);
  assert.match(deployerSource, /legacyFileInventory && extension === "\.map"/u);
  assert.match(deployerSource, /legacyFileInventory && dependencyDocumentation/u);
  assert.match(deployerSource, /forbiddenArtifactExtensions = new Set\(\["\.pem"[^\n]+"\.map"\]\)/u);

  const workerHookSource = fs.readFileSync(new URL("./media-worker-transaction-hook-vnext.mjs", import.meta.url), "utf8");
  assert.match(workerHookSource, /run\("pm2", \["delete", WORKER_NAME\]/u);
  assert.match(workerHookSource, /run\("pm2", \["start", configPath/u);
  assert.doesNotMatch(workerHookSource, /run\("pm2", \["startOrReload"/u);

  const legacyRoot = path.join(temporaryRoot, "legacy");
  fs.mkdirSync(legacyRoot, { mode: 0o755 });
  const manifest = legacyInventoryFixture(legacyRoot);
  validateInventory(legacyRoot, manifest);
  assert.equal(manifest.artifactDigest, sha256(manifest.files.map((entry) => `${entry.sha256}  ${entry.path}\n`).join("")));

  const tampered = path.join(legacyRoot, "server.js");
  fs.chmodSync(tampered, 0o644);
  fs.appendFileSync(tampered, "tampered\n");
  fs.chmodSync(tampered, 0o444);
  assert.throws(() => validateInventory(legacyRoot, manifest), /TARGET_FILE_MISMATCH/u);
  cleanupFixtureTree(temporaryRoot, legacyRoot);

  const permissionRoot = path.join(temporaryRoot, "permission-rejections");
  fs.mkdirSync(permissionRoot, { mode: 0o755 });
  const permissionManifest = legacyInventoryFixture(permissionRoot);
  const permissionFile = path.join(permissionRoot, "server.js");
  fs.chmodSync(permissionFile, 0o644);
  assert.throws(() => validateInventory(permissionRoot, permissionManifest), /TARGET_FILE_MISMATCH/u);
  fs.chmodSync(permissionFile, 0o444);
  const permissionDirectory = path.join(permissionRoot, ".next");
  fs.chmodSync(permissionDirectory, 0o755);
  assert.throws(() => validateInventory(permissionRoot, permissionManifest), /TARGET_TREE_METADATA_UNSAFE/u);
  fs.chmodSync(permissionDirectory, 0o555);
  validateInventory(permissionRoot, permissionManifest);

  const nestedCleanupRoot = path.join(temporaryRoot, "nested-cleanup");
  sealedCleanupFixture(nestedCleanupRoot);
  let restoredModes = 0;
  cleanupFixtureTree(temporaryRoot, nestedCleanupRoot, { ...fs, chmodSync(entry, mode) {
    assert.equal(mode & 0o022, 0, "fixture cleanup must never grant group/other write or chmod 0777");
    const ownerRequired = fs.lstatSync(entry).isDirectory() ? 0o700 : 0o600;
    assert.equal(mode & ownerRequired, ownerRequired);
    restoredModes += 1;
    fs.chmodSync(entry, mode);
  } });
  assert.equal(restoredModes, 4);
  assert.equal(fs.existsSync(nestedCleanupRoot), false);
  cleanupFixtureTree(temporaryRoot, nestedCleanupRoot); // only missing entries are ignored
  assert.throws(() => cleanupFixtureTree(temporaryRoot, `${temporaryRoot}-outside`), /FIXTURE_CLEANUP_OUTSIDE_ROOT/u);

  const linkTarget = path.join(temporaryRoot, "link-target");
  fs.mkdirSync(linkTarget);
  const linkedFile = writeFixtureFile(linkTarget, "sealed.txt", "link target must remain untouched\n");
  const linkedMode = fs.statSync(linkedFile).mode;
  const linkRoot = path.join(temporaryRoot, "links");
  fs.mkdirSync(linkRoot);
  fs.symlinkSync(linkTarget, path.join(linkRoot, "directory-link"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => cleanupFixtureTree(temporaryRoot, path.join(linkRoot, "directory-link", "sealed.txt")), /FIXTURE_CLEANUP_LINK_ANCESTOR/u);
  cleanupFixtureTree(temporaryRoot, linkRoot);
  assert.equal(fs.readFileSync(linkedFile, "utf8"), "link target must remain untouched\n");
  assert.equal(fs.statSync(linkedFile).mode, linkedMode);

  const failureScenarios = ["assertion-failure", "cleanup-failure", "dual-failure"];
  for (const scenario of failureScenarios) {
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", fileURLToPath(import.meta.url), "--fixture-cleanup-selftest", scenario], { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 1, `${scenario}: failure must remain nonzero`);
    assert.equal(result.stdout, "", `${scenario}: must not print success before cleanup`);
    const failure = JSON.parse(result.stderr.trim());
    assert.equal(failure.rootRemoved, true);
    assert.equal(failure.rootRemovedBeforeRecovery, scenario === "assertion-failure");
    if (scenario === "assertion-failure") assert.match(failure.message, /INJECTED_ASSERTION_FAILURE/u);
    if (scenario === "cleanup-failure") assert.match(failure.message, /INJECTED_CLEANUP_FAILURE/u);
    if (scenario === "dual-failure") {
      assert.equal(failure.name, "AggregateError");
      assert.deepEqual(failure.errors.map((cause) => cause.message), ["INJECTED_ASSERTION_FAILURE", "INJECTED_CLEANUP_FAILURE"]);
    }
  }

  const extraRoot = path.join(temporaryRoot, "extra");
  fs.mkdirSync(extraRoot, { mode: 0o755 });
  const extraManifest = legacyInventoryFixture(extraRoot);
  fs.chmodSync(extraRoot, 0o755);
  writeFixtureFile(extraRoot, "unexpected.txt", "unexpected\n");
  fs.chmodSync(extraRoot, 0o555);
  assert.throws(() => validateInventory(extraRoot, extraManifest), /TARGET_INVENTORY_PATH_SET_MISMATCH/u);
  const sourceInventory = validateInventory(extraRoot, extraManifest, { allowUnexpected: true });
  assert.equal(sourceInventory.unexpectedCount, 1);
  assert.match(sourceInventory.unexpectedDigest, /^[a-f0-9]{64}$/u);

  const typedRoot = path.join(temporaryRoot, "typed");
  fs.mkdirSync(typedRoot, { mode: 0o755 });
  const typedManifest = legacyInventoryFixture(typedRoot);
  typedManifest.files[0] = { ...typedManifest.files[0], kind: "file", mode: 0o444 };
  assert.throws(() => validateInventory(typedRoot, typedManifest), /TARGET_LEGACY_INVENTORY_ENTRY_INVALID/u);

  const normalizationRoot = path.join(temporaryRoot, "normalization");
  const releasesRoot = path.join(normalizationRoot, "releases");
  const sourceWeb = path.join(releasesRoot, "source", "web");
  const targetRelease = path.join(releasesRoot, "normalized");
  const targetWeb = path.join(targetRelease, "web");
  fs.mkdirSync(sourceWeb, { recursive: true, mode: 0o755 });
  const normalizationManifest = legacyInventoryFixture(sourceWeb);
  fs.chmodSync(sourceWeb, 0o755);
  writeFixtureFile(sourceWeb, "unsigned-extra.txt", "must not enter normalized release\n");
  const releaseManifestBytes = Buffer.from(`${JSON.stringify(normalizationManifest)}\n`);
  writeFixtureFile(sourceWeb, "release-manifest.json", releaseManifestBytes);
  fs.chmodSync(sourceWeb, 0o555);
  copySignedLegacyInventory(
    sourceWeb,
    targetRelease,
    normalizationManifest,
    sha256(releaseManifestBytes),
  );
  validateInventory(targetWeb, normalizationManifest);
  assert.equal(fs.existsSync(path.join(targetWeb, "unsigned-extra.txt")), false);

  const workerRoot = path.join(temporaryRoot, "worker-release");
  fs.mkdirSync(workerRoot, { mode: 0o755 });
  writeFixtureFile(workerRoot, "server.js", "process.exitCode = 0;\n");
  const liveEntries = [workerEntry(workerRoot, 5102), workerEntry(workerRoot, 5103)];
  const expected = snapshotWorkers(liveEntries);
  assert.deepEqual(expected.ports, [5102, 5103]);
  assert.equal(workersMatch(liveEntries, expected), true);
  assert.equal(workersMatch([workerEntry(workerRoot, 5102), workerEntry(workerRoot, 5103, { ASSET_DIGEST: "e".repeat(64) })], expected), false);

  const dumpEntries = [workerEntry(workerRoot, 5102, {}, true), workerEntry(workerRoot, 5103, {}, true)];
  assert.equal(dumpWorkersMatch(dumpEntries, expected), true);
  assert.equal(dumpWorkersMatch([workerEntry(workerRoot, 5102, {}, true), workerEntry(workerRoot, 5103, { DIGITAL_VIDEO_QUEUE_WORKER: "0" }, true)], expected), false);
  assert.equal(dumpWorkersMatch([workerEntry(workerRoot, 5102, {}, true), workerEntry(workerRoot, 5104, {}, true)], expected), false);

  const digestSubject = {
    releaseId: "web-legacy-fixture",
    commitSha: "f".repeat(40),
    buildId: "build-fixture",
    sourceVersion: "R000001-fixture",
    targetManifestSha256: "1".repeat(64),
    artifactDigest: "2".repeat(64),
  };
  assert.match(legacyBuildOutputDigest(digestSubject), /^[a-f0-9]{64}$/u);
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');

  return {
    ok: true,
    legacyInventoryChecks: 8,
    mediaWorkerChecks: 11,
    deterministicDigestChecks: 2,
    nodeRuntimeSelectionChecks: 11,
    rollbackRecoveryChecks: cleanupCases.length,
    rollbackRecoveryCases: cleanupCases.map((fixture) => fixture.name),
    fixturePermissionRejectionChecks: 3,
    fixtureCleanupFailureCases: failureScenarios,
    fixtureCleanupScopeAndLinkChecks: 6,
  };
});
process.stdout.write(`${JSON.stringify({ ...verification, temporaryRootRemoved: true })}\n`);
}
