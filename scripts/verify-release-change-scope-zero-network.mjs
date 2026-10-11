#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { canonicalJson, sha256 } from "./lib/json-schema-contract.mjs";

const root = process.cwd();
const classifierPath = path.join(root, "scripts", "classify-release-change-scope.mjs");
const policyPath = path.join(root, "deploy", "policies", "release-change-scope.v1.json");
const schemaPath = path.join(root, "scripts", "contracts", "release-change-scope-receipt.v1.schema.json");
const validationGatePath = path.join(root, "scripts", "release-change-validation-gate.mjs");
const targetedRunnerPath = path.join(root, "scripts", "run-release-targeted-regressions.mjs");
const secretScannerPath = path.join(root, "scripts", "verify-release-secret-exposure.mjs");
const validationSchemaPath = path.join(root, "scripts", "contracts", "release-change-validation-bundle.v1.schema.json");
const workflowPath = path.join(root, ".github", "workflows", "release-vnext.yml");
const browserAcceptanceWorkflowPath = path.join(root, ".github", "workflows", "release-browser-acceptance.yml");
const browserAcceptanceRunnerPath = path.join(root, "scripts", "run-release-browser-acceptance.mjs");
const buildOutputDigestPath = path.join(root, "scripts", "compute-release-build-output-digest.mjs");
const packagerPath = path.join(root, "scripts", "package-standalone-artifact.mjs");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-change-scope-"));
const repositoryTemporaryParent = path.join(root, ".codex-temp");
fs.mkdirSync(repositoryTemporaryParent, { recursive: true });
const repositoryTemporaryRoot = fs.mkdtempSync(path.join(repositoryTemporaryParent, "release-change-scope-"));
let scenarioIndex = 0;

function run(command, args, cwd = root, expectedStatus = 0) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, expectedStatus, `${command} ${args.join(" ")} status=${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

function runFailure(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} unexpectedly passed`);
  return result;
}

function recomputeBundleId(bundle) {
  const payload = { ...bundle };
  delete payload.bundleId;
  return `validation-${sha256(canonicalJson(payload)).slice(0, 24)}`;
}

function writeMinimalTarGz(filePath, entries) {
  const blocks = [];
  const octal = (buffer, offset, length, value) => {
    const text = Math.max(0, value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
    buffer.write(`${text}\0`, offset, length, "ascii");
  };
  for (const entry of entries) {
    const body = Buffer.from(entry.body || "", "utf8");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, Math.min(Buffer.byteLength(entry.path), 100), "utf8");
    octal(header, 100, 8, entry.mode ?? 0o644);
    octal(header, 108, 8, 0); octal(header, 116, 8, 0);
    octal(header, 124, 12, entry.type === "5" ? 0 : body.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type || "0", 156, 1, "ascii");
    if (entry.linkname) header.write(entry.linkname, 157, Math.min(Buffer.byteLength(entry.linkname), 100), "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(header, 148, 8, [...header].reduce((sum, byte) => sum + byte, 0));
    blocks.push(header);
    if (body.length) blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.concat(blocks)));
}

function rewriteTarEntryMode(sourcePath, destinationPath, requestedPath, mode) {
  const tar = zlib.gunzipSync(fs.readFileSync(sourcePath));
  let offset = 0;
  let changed = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/u, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const logicalPath = `${prefix ? `${prefix}/` : ""}${name}`.replace(/^\.\//u, "");
    const size = Number.parseInt(readString(124, 12).trim() || "0", 8);
    if (logicalPath === requestedPath) {
      const modeText = Math.max(0, mode).toString(8).padStart(7, "0").slice(-7);
      header.write(`${modeText}\0`, 100, 8, "ascii");
      header.fill(0x20, 148, 156);
      const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
      header.write(checksum.toString(8).padStart(6, "0").slice(-6), 148, 6, "ascii");
      header[154] = 0;
      header[155] = 0x20;
      changed = true;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(changed, true, `tar fixture entry not found: ${requestedPath}`);
  fs.writeFileSync(destinationPath, zlib.gzipSync(tar));
}

function writeBuildDigestReceipt(filePath, service, commit, buildId, sourceVersion = "RTEST") {
  const files = [
    { path: ".next/BUILD_ID", kind: "file", sourceKind: "direct", mode: 0o644, size: buildId.length, sha256: sha256(buildId) },
    { path: ".next/standalone/server.js", kind: "file", sourceKind: "direct", mode: 0o644, size: 1, sha256: "1".repeat(64) },
    { path: ".next/static/chunk.js", kind: "file", sourceKind: "direct", mode: 0o644, size: 1, sha256: "2".repeat(64) },
  ];
  const receipt = {
    schemaVersion: "zimeiti-release-build-output-digest.v1",
    service, commit, sourceVersion, buildId,
    roots: [".next/BUILD_ID", ".next/standalone", ".next/static"],
    files, fileCount: files.length, totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    outputDigest: sha256(canonicalJson({ service, commit, sourceVersion, buildId, files })),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function bindFixtureCandidatePayload(bundlePath, service, directory, label) {
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const manifestPath = path.join(directory, `${label}-${service}-manifest.json`);
  const archivePath = path.join(directory, `${label}-${service}.tar.gz`);
  fs.writeFileSync(archivePath, `fixture-candidate-payload:${label}:${service}\n`, "utf8");
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    schemaVersion: 2,
    service,
    commitSha: bundle.subject.commit,
    buildId: bundle.subject.builds[service],
    sourceVersion: bundle.subject.sourceVersion,
    buildOutputDigest: bundle.subject.buildOutputDigests[service],
    releaseId: `${label}-${service}-release`,
    artifactDigest: sha256(`fixture-artifact:${label}:${service}`),
    fileCount: 3,
    totalBytes: 42,
  }, null, 2)}\n`, "utf8");
  run(process.execPath, [validationGatePath, "bind-package-payload", "--root", root, "--bundle", bundlePath, "--service", service, "--manifest", manifestPath, "--archive", archivePath]);
}

function runScenario(name, changes, options = {}) {
  scenarioIndex += 1;
  const fixturePath = path.join(temporaryRoot, `${scenarioIndex}-${name}.json`);
  const outputPath = path.join(temporaryRoot, `${scenarioIndex}-${name}.receipt.json`);
  fs.writeFileSync(fixturePath, `${JSON.stringify({ changes }, null, 2)}\n`, "utf8");
  const commandArgs = [
    classifierPath,
    "--root", root,
    "--policy", options.policyPath || policyPath,
    "--changes-file", fixturePath,
    "--output", outputPath,
    "--quiet",
  ];
  if (options.acceptanceRoutes) commandArgs.push("--acceptance-routes-json", JSON.stringify(options.acceptanceRoutes));
  const result = spawnSync(process.execPath, commandArgs, { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${name} failed: ${result.stderr || result.stdout}`);
  return JSON.parse(fs.readFileSync(outputPath, "utf8"));
}

function assertCommonValidations(receipt) {
  for (const validation of [
    "credential-scan",
    "source-integrity",
    "diff-check",
    "build",
    "build-identity",
    "desktop-precise-route-visual-1440x900",
    "desktop-two-adjacent-pages-visual",
    "console-and-request-errors",
  ]) {
    assert.ok(receipt.requiredValidations.includes(validation), `${receipt.classification} omitted ${validation}`);
  }
}

try {
  const classifierSource = fs.readFileSync(classifierPath, "utf8");
  assert.doesNotMatch(classifierSource, /from\s+["']node:(?:http|https|net|tls|dns)["']/u, "classifier must remain zero-network");
  assert.doesNotMatch(classifierSource, /\bfetch\s*\(/u, "classifier must not use fetch");

  const fast = runScenario("fast-ui", [
    { status: "M", path: "scripts/verify-cover-zero-network.mjs", content: "assert.equal(width, 1440);" }
  ]);
  assert.equal(fast.classification, "FAST");
  assert.equal(fast.failClosed, false);
  assert.equal(fast.gate.decision, "CLASSIFICATION_ONLY");
  assert.equal(fast.gate.validationState, "pending-required");
  assert.equal(fast.gate.releaseReady, false);
  assertCommonValidations(fast);
  assert.ok(fast.requiredValidations.includes("targeted-zero-network-regression"));
  assert.ok(fast.omittedValidations.includes("full-zero-network-regression"));

  const unmappedFastCandidate = runScenario("unmapped-ui-escalates", [
    { status: "M", path: "src/app/cover/page.tsx", content: "const title = '封面制作';" },
  ]);
  assert.equal(unmappedFastCandidate.classification, "STANDARD");
  assert.ok(unmappedFastCandidate.reasons.some((reason) => reason.code === "FAST_TARGETED_REGRESSION_UNMAPPED"));

  const standardApi = runScenario("standard-api", [
    { status: "M", path: "src/app/api/help/route.ts", content: "return Response.json({ ok: true });" }
  ]);
  assert.equal(standardApi.classification, "FULL");
  assert.equal(standardApi.browserAcceptance.explicitRoutesRequired, true);
  assert.equal(standardApi.browserAcceptance.explicitRoutesProvided, false);
  const standardApiWithRoutes = runScenario("standard-api-with-reviewed-routes", [
    { status: "M", path: "src/app/api/help/route.ts", content: "return Response.json({ ok: true });" }
  ], { acceptanceRoutes: ["/help", "/", "/tools"] });
  assert.equal(standardApiWithRoutes.classification, "FULL");
  assert.equal(standardApiWithRoutes.failClosed, true);
  assert.ok(standardApiWithRoutes.browserAcceptance.unresolvedPaths.includes("src/app/api/help/route.ts"));
  assertCommonValidations(standardApi);
  assert.ok(standardApiWithRoutes.requiredValidations.includes("full-zero-network-regression"));

  const standardShared = runScenario("standard-shared", [
    { status: "M", path: "src/components/feature-card.tsx", content: "const size = 'desktop';" }
  ], { acceptanceRoutes: ["/", "/tools", "/video"] });
  assert.equal(standardShared.classification, "FULL");
  assert.equal(standardShared.failClosed, true);

  const dynamicPageWithArbitraryRoutes = runScenario("dynamic-page-caller-route-bypass", [
    { status: "M", path: "src/app/blog/[slug]/page.tsx", content: "export default function Page() { return null; }" },
  ], { acceptanceRoutes: ["/", "/tools", "/video"] });
  assert.equal(dynamicPageWithArbitraryRoutes.classification, "FULL");
  assert.ok(dynamicPageWithArbitraryRoutes.browserAcceptance.unresolvedPaths.includes("src/app/blog/[slug]/page.tsx"));

  const unmappedSharedWithArbitraryRoutes = runScenario("unmapped-shared-caller-route-bypass", [
    { status: "M", path: "src/shared/unmapped.ts", content: "export const shared = true;" },
  ], { acceptanceRoutes: ["/", "/tools", "/video"] });
  assert.equal(unmappedSharedWithArbitraryRoutes.classification, "FULL");
  assert.ok(unmappedSharedWithArbitraryRoutes.browserAcceptance.unresolvedPaths.includes("src/shared/unmapped.ts"));

  const standardBusinessContent = runScenario("standard-business-content", [
    { status: "M", path: "src/app/cover/page.tsx", content: "'use server';\nawait repository.updateCover(input);" }
  ]);
  assert.equal(standardBusinessContent.classification, "STANDARD");
  assert.ok(standardBusinessContent.changedFiles[0].contentRiskIds.includes("content-api-or-business-logic"));

  const fullCases = [
    ["database", "A", "supabase/migrations/20990101000000_example.sql", "CREATE TABLE example(id bigint);"],
    ["auth", "M", "src/lib/auth.ts", "export const requireUser = () => true;"],
    ["billing", "M", "src/lib/wallet-ledger.ts", "export const settle = () => true;"],
    ["model-adapter", "M", "src/lib/video-provider-adapter.ts", "export const adapter = {};"],
    ["deployment", "M", "deploy/manifests/example.json", "{}"],
    ["secret", "A", "config/client-secret.template", "placeholder only"],
  ];
  for (const [name, status, filePath, content] of fullCases) {
    const receipt = runScenario(`full-${name}`, [{ status, path: filePath, content }]);
    assert.equal(receipt.classification, "FULL", `${name} must be FULL`);
    assertCommonValidations(receipt);
  }

  const storageDelete = runScenario("full-storage-delete-content", [
    { status: "M", path: "src/app/assets/page.tsx", content: "await storage.deleteObject(objectKey);" }
  ]);
  assert.equal(storageDelete.classification, "FULL");
  assert.ok(storageDelete.changedFiles[0].contentRiskIds.includes("content-storage-deletion"));

  const renamed = runScenario("full-rename", [
    { status: "R100", previousPath: "docs/old.md", path: "docs/new.md", content: "" }
  ]);
  assert.equal(renamed.classification, "FULL");
  assert.equal(renamed.failClosed, true);

  const deleted = runScenario("full-delete", [
    { status: "D", path: "docs/removed.md", content: "" }
  ]);
  assert.equal(deleted.classification, "FULL");
  assert.equal(deleted.failClosed, true);

  const unknown = runScenario("full-unknown", [
    { status: "A", path: "unknown-area/item.xyz", content: "opaque" }
  ]);
  assert.equal(unknown.classification, "FULL");
  assert.equal(unknown.failClosed, true);
  assert.ok(unknown.reasons.some((reason) => reason.code === "UNKNOWN_PATH_CLASSIFICATION"));

  const unsafe = runScenario("full-unsafe", [
    { status: "M", path: "../outside.txt", content: "opaque" }
  ]);
  assert.equal(unsafe.classification, "FULL");
  assert.equal(unsafe.changedFiles[0].path, "<unsafe-path>");

  for (const [name, unsafePath] of [
    ["lf", "docs/bad\nname.md"],
    ["cr", "docs/bad\rname.md"],
    ["tab", "docs/bad\tname.md"],
    ["escape", "docs/bad\u001bname.md"],
    ["nul", "docs/bad\u0000name.md"],
    ["backslash", "docs\\bad.md"],
    ["bidi", "docs/bad\u202ename.md"],
  ]) {
    const rejected = runScenario(`unsafe-${name}`, [{ status: "M", path: unsafePath, content: "opaque" }]);
    assert.equal(rejected.classification, "FULL", `${name} path must fail closed`);
    assert.equal(rejected.failClosed, true);
    assert.equal(rejected.changedFiles[0].path, "<unsafe-path>");
  }

  const forcedOutputPath = path.join(temporaryRoot, "forced-full.receipt.json");
  const forced = spawnSync(process.execPath, [
    classifierPath,
    "--root", root,
    "--force-full-reason", "no-trusted-change-base",
    "--output", forcedOutputPath,
    "--quiet",
  ], { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(forced.status, 0, `forced FULL failed: ${forced.stderr || forced.stdout}`);
  const forcedReceipt = JSON.parse(fs.readFileSync(forcedOutputPath, "utf8"));
  assert.equal(forcedReceipt.classification, "FULL");
  assert.equal(forcedReceipt.failClosed, true);
  assert.equal(forcedReceipt.input.kind, "forced-full");

  const conflictingPolicyPath = path.join(temporaryRoot, "conflicting-policy.json");
  const conflictingPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  conflictingPolicy.pathRules.push(
    { id: "fixture-conflict-fast", level: "FAST", precedence: 999, patterns: ["^src/app/api/conflict/"] },
    { id: "fixture-conflict-standard", level: "STANDARD", precedence: 999, patterns: ["^src/app/api/conflict/"] },
  );
  fs.writeFileSync(conflictingPolicyPath, `${JSON.stringify(conflictingPolicy, null, 2)}\n`, "utf8");
  const conflict = runScenario("full-conflict", [
    { status: "M", path: "src/app/api/conflict/route.ts", content: "return true;" }
  ], { policyPath: conflictingPolicyPath });
  assert.equal(conflict.classification, "FULL");
  assert.equal(conflict.failClosed, true);
  assert.ok(conflict.reasons.some((reason) => reason.code === "PATH_CLASSIFICATION_CONFLICT"));

  const deterministicA = runScenario("deterministic-a", [
    { status: "M", path: "scripts/verify-deterministic-zero-network.mjs", content: "const title = 'A';" }
  ]);
  const deterministicB = runScenario("deterministic-b", [
    { status: "M", path: "scripts/verify-deterministic-zero-network.mjs", content: "const title = 'A';" }
  ]);
  assert.deepEqual(deterministicA, deterministicB, "same input must produce the same receipt");

  const digestFixtureRoot = path.join(temporaryRoot, "build-output-digest-fixture");
  fs.mkdirSync(path.join(digestFixtureRoot, "scripts", "contracts"), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts", "contracts", "release-build-output-digest.v1.schema.json"), path.join(digestFixtureRoot, "scripts", "contracts", "release-build-output-digest.v1.schema.json"));
  fs.mkdirSync(path.join(digestFixtureRoot, ".next", "standalone"), { recursive: true });
  fs.mkdirSync(path.join(digestFixtureRoot, ".next", "static"), { recursive: true });
  fs.writeFileSync(path.join(digestFixtureRoot, ".next", "BUILD_ID"), "fixed-build-id\n", "utf8");
  fs.writeFileSync(path.join(digestFixtureRoot, ".next", "standalone", "server.js"), "export {};\n", "utf8");
  fs.writeFileSync(path.join(digestFixtureRoot, ".next", "static", "chunk.js"), "old-output\n", "utf8");
  const linkedTargetRoot = path.join(digestFixtureRoot, "node_modules", "fixture-linked-package");
  fs.mkdirSync(linkedTargetRoot, { recursive: true });
  fs.writeFileSync(path.join(linkedTargetRoot, "index.js"), "export const linked = 'old';\n", "utf8");
  fs.mkdirSync(path.join(digestFixtureRoot, ".next", "standalone", "node_modules"), { recursive: true });
  fs.symlinkSync(linkedTargetRoot, path.join(digestFixtureRoot, ".next", "standalone", "node_modules", "fixture-linked-package"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(path.join(digestFixtureRoot, ".next", "standalone", "top-level.map"), "ignored source map v1\n", "utf8");
  fs.writeFileSync(path.join(linkedTargetRoot, "nested.map"), "ignored linked source map v1\n", "utf8");
  const digestReceiptPath = path.join(temporaryRoot, "build-output-digest.json");
  const digestCommit = "a".repeat(40);
  run(process.execPath, [buildOutputDigestPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--source-version", "RTEST", "--receipt", digestReceiptPath]);
  run(process.execPath, [buildOutputDigestPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--source-version", "RTEST", "--receipt", digestReceiptPath, "--verify", "1"]);
  run(process.execPath, [packagerPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--build-output-digest-receipt", digestReceiptPath, "--verify-build-output-digest-only"]);
  const digestReceipt = JSON.parse(fs.readFileSync(digestReceiptPath, "utf8"));
  assert.ok(digestReceipt.files.some((entry) => entry.path.endsWith("fixture-linked-package/index.js") && entry.sourceKind === "materialized-symlink"), "digest must cover materialized link target bytes");
  assert.equal(digestReceipt.files.some((entry) => entry.path.endsWith(".map")), false, "digest must omit bytes that packaging omits");
  fs.writeFileSync(path.join(digestFixtureRoot, ".next", "standalone", "top-level.map"), "ignored source map v2\n", "utf8");
  fs.writeFileSync(path.join(linkedTargetRoot, "nested.map"), "ignored linked source map v2\n", "utf8");
  run(process.execPath, [buildOutputDigestPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--source-version", "RTEST", "--receipt", digestReceiptPath, "--verify", "1"]);
  fs.writeFileSync(path.join(linkedTargetRoot, "index.js"), "export const linked = 'tampered-after-receipt';\n", "utf8");
  assert.match(runFailure(process.execPath, [buildOutputDigestPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--source-version", "RTEST", "--receipt", digestReceiptPath, "--verify", "1"]).stderr, /BUILD_OUTPUT_DIGEST_MISMATCH/u);
  assert.match(runFailure(process.execPath, [packagerPath, "--root", digestFixtureRoot, "--service", "web", "--commit", digestCommit, "--build-output-digest-receipt", digestReceiptPath, "--verify-build-output-digest-only"]).stderr, /build output digest receipt does not match the bytes package would materialize/u);

  const validReceiptPath = path.join(temporaryRoot, "valid-receipt.json");
  fs.writeFileSync(validReceiptPath, `${JSON.stringify(deterministicA, null, 2)}\n`, "utf8");
  run(process.execPath, [
    classifierPath,
    "--root", root,
    "--verify-receipt", validReceiptPath,
    "--quiet",
  ]);

  const schemaTamperPath = path.join(temporaryRoot, "schema-tamper.json");
  const schemaTamper = structuredClone(deterministicA);
  delete schemaTamper.gate.releaseReady;
  fs.writeFileSync(schemaTamperPath, `${JSON.stringify(schemaTamper, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [
    classifierPath,
    "--root", root,
    "--verify-receipt", schemaTamperPath,
    "--quiet",
  ]).stderr, /RECEIPT_JSON_SCHEMA_INVALID/u);

  const semanticTamperPath = path.join(temporaryRoot, "semantic-tamper.json");
  const semanticTamper = structuredClone(deterministicA);
  semanticTamper.input.changeCount += 1;
  fs.writeFileSync(semanticTamperPath, `${JSON.stringify(semanticTamper, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [
    classifierPath,
    "--root", root,
    "--verify-receipt", semanticTamperPath,
    "--quiet",
  ]).stderr, /RECEIPT_CHANGE_COUNT_MISMATCH/u);

  const gitRepository = path.join(temporaryRoot, "git-range-source");
  fs.mkdirSync(path.join(gitRepository, "scripts"), { recursive: true });
  run("git", ["init", "--quiet"], gitRepository);
  run("git", ["config", "user.email", "release-gate@example.invalid"], gitRepository);
  run("git", ["config", "user.name", "Release Gate Fixture"], gitRepository);
  const gitFixtureFile = path.join(gitRepository, "scripts", "verify-widget-zero-network.mjs");
  fs.writeFileSync(gitFixtureFile, "process.exitCode = 0; // A\n", "utf8");
  run("git", ["add", "--", "scripts/verify-widget-zero-network.mjs"], gitRepository);
  run("git", ["commit", "--quiet", "-m", "initial"], gitRepository);
  const rangeBase = run("git", ["rev-parse", "HEAD"], gitRepository).stdout.trim();
  fs.writeFileSync(gitFixtureFile, "process.exitCode = 0; // B\n", "utf8");
  run("git", ["add", "--", "scripts/verify-widget-zero-network.mjs"], gitRepository);
  run("git", ["commit", "--quiet", "-m", "update"], gitRepository);
  const rangeHead = run("git", ["rev-parse", "HEAD"], gitRepository).stdout.trim();
  const rangeReceiptPath = path.join(temporaryRoot, "real-range-receipt.json");
  run(process.execPath, [
    classifierPath,
    "--root", gitRepository,
    "--policy", policyPath,
    "--schema", schemaPath,
    "--base", rangeBase,
    "--head", rangeHead,
    "--range-mode", "direct",
    "--output", rangeReceiptPath,
    "--quiet",
  ], gitRepository);
  const rangeReceipt = JSON.parse(fs.readFileSync(rangeReceiptPath, "utf8"));
  assert.equal(rangeReceipt.input.kind, "git-range");
  assert.equal(rangeReceipt.input.base, rangeBase);
  assert.equal(rangeReceipt.input.head, rangeHead);
  assert.equal(rangeReceipt.input.trustedBase, true);
  assert.equal(rangeReceipt.classification, "FAST");
  assert.equal(rangeReceipt.input.changeCount, 1);

  const targetedReceiptPath = path.join(temporaryRoot, "targeted-regression-receipt.json");
  run(process.execPath, [targetedRunnerPath, "--root", gitRepository, "--scope-receipt", rangeReceiptPath, "--output", targetedReceiptPath], gitRepository);
  const targetedReceipt = JSON.parse(fs.readFileSync(targetedReceiptPath, "utf8"));
  assert.equal(targetedReceipt.result, "passed");
  assert.equal(targetedReceipt.executions.length, 1);
  assert.equal(targetedReceipt.executions[0].args[0], "scripts/verify-widget-zero-network.mjs");

  const actualSecretReceiptPath = path.join(temporaryRoot, "actual-secret-scan-receipt.json");
  run(process.execPath, [secretScannerPath, "--candidate-commit", rangeHead, "--history-base", rangeBase, "--history-head", rangeHead, "--scope-receipt", rangeReceiptPath, "--require-clean-candidate", "--receipt", actualSecretReceiptPath], gitRepository);
  const actualSecretReceipt = JSON.parse(fs.readFileSync(actualSecretReceiptPath, "utf8"));
  assert.equal(actualSecretReceipt.status, "PASS");
  assert.equal(actualSecretReceipt.candidate.commit, rangeHead);
  assert.equal(actualSecretReceipt.gitHistory.base, rangeBase);
  assert.equal(actualSecretReceipt.gitHistory.head, rangeHead);
  assert.equal(actualSecretReceipt.scopeReceiptId, rangeReceipt.receiptId);

  run(process.execPath, [classifierPath, "--root", gitRepository, "--policy", policyPath, "--schema", schemaPath, "--verify-receipt", rangeReceiptPath, "--quiet"], gitRepository);
  const disguisedMigrationPath = path.join(temporaryRoot, "disguised-migration-fast.json");
  const disguisedMigration = structuredClone(rangeReceipt);
  disguisedMigration.changedFiles[0].path = "supabase/migrations/20990101000000_disguised.sql";
  disguisedMigration.changedFiles[0].pathLevel = "FAST";
  disguisedMigration.changedFiles[0].pathRuleIds = ["fast-targeted-test-fixture-or-documentation"];
  disguisedMigration.changedFiles[0].targetedRegressionIds = ["changed-zero-network-mjs"];
  const { receiptId: ignoredReceiptId, ...disguisedPayload } = disguisedMigration;
  void ignoredReceiptId;
  disguisedMigration.receiptId = `scope-${sha256(canonicalJson(disguisedPayload)).slice(0, 24)}`;
  fs.writeFileSync(disguisedMigrationPath, `${JSON.stringify(disguisedMigration, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [classifierPath, "--root", gitRepository, "--policy", policyPath, "--schema", schemaPath, "--verify-receipt", disguisedMigrationPath, "--quiet"], gitRepository).stderr, /RECEIPT_GIT_RANGE_RECLASSIFICATION_MISMATCH/u);

  assert.match(runFailure(process.execPath, [
    classifierPath,
    "--root", gitRepository,
    "--policy", policyPath,
    "--schema", schemaPath,
    "--base", "missing-ref",
    "--head", "HEAD",
    "--quiet",
  ], gitRepository).stderr, /GIT_REVISION_UNRESOLVED/u);

  const shallowRepository = path.join(temporaryRoot, "git-range-shallow");
  run("git", ["clone", "--quiet", "--depth", "1", "--no-local", gitRepository, shallowRepository], temporaryRoot);
  assert.equal(run("git", ["rev-parse", "--is-shallow-repository"], shallowRepository).stdout.trim(), "true");
  assert.match(runFailure(process.execPath, [
    classifierPath,
    "--root", shallowRepository,
    "--policy", policyPath,
    "--schema", schemaPath,
    "--base", "HEAD~1",
    "--head", "HEAD",
    "--quiet",
  ], shallowRepository).stderr, /GIT_REVISION_UNRESOLVED/u);

  const mainBase = run("git", ["rev-parse", "HEAD~1"], root).stdout.trim();
  const mainHead = run("git", ["rev-parse", "HEAD"], root).stdout.trim();
  const gateScopePath = path.join(temporaryRoot, "gate-real-range-receipt.json");
  run(process.execPath, [classifierPath, "--root", root, "--base", mainBase, "--head", mainHead, "--range-mode", "direct", "--output", gateScopePath, "--quiet"]);
  const gateScope = JSON.parse(fs.readFileSync(gateScopePath, "utf8"));
  const secretReceiptPath = path.join(temporaryRoot, "secret-scan-receipt.json");
  fs.writeFileSync(secretReceiptPath, `${JSON.stringify({
    schemaVersion: "zimeiti-release-secret-exposure-receipt.v1",
    verifier: "release-secret-exposure",
    mode: "release-candidate",
    status: "PASS",
    scopeReceiptId: gateScope.receiptId,
    scopeReceiptSha256: sha256(fs.readFileSync(gateScopePath)),
    candidate: { commit: mainHead, cleanRequired: true },
    outputPolicy: "paths-categories-counts-only",
    summary: { blockingCount: 0, reviewCount: 0, workingTreeBlockingCount: 0, historyBlockingCount: 0 },
    workingTree: { findingFiles: 0, findings: [] },
    gitHistory: { available: true, base: mainBase, head: mainHead, includeBase: false, commits: 1, findings: [] },
  }, null, 2)}\n`, "utf8");

  const untrustedScopePath = path.join(temporaryRoot, "untrusted-base-scope.json");
  run(process.execPath, [classifierPath, "--root", root, "--base", mainBase, "--head", mainHead, "--range-mode", "direct", "--untrusted-base", "--minimum-level", "FULL", "--output", untrustedScopePath, "--quiet"]);
  const untrustedScope = JSON.parse(fs.readFileSync(untrustedScopePath, "utf8"));
  assert.equal(untrustedScope.classification, "FULL");
  assert.equal(untrustedScope.input.trustedBase, false);
  const untrustedBundlePath = path.join(temporaryRoot, "untrusted-base-bundle.json");
  const untrustedEvidenceRoot = path.join(temporaryRoot, "untrusted-base-evidence");
  const untrustedSecretReceiptPath = path.join(temporaryRoot, "untrusted-secret-scan-receipt.json");
  const untrustedSecretReceipt = JSON.parse(fs.readFileSync(secretReceiptPath, "utf8"));
  untrustedSecretReceipt.scopeReceiptId = untrustedScope.receiptId;
  untrustedSecretReceipt.scopeReceiptSha256 = sha256(fs.readFileSync(untrustedScopePath));
  untrustedSecretReceipt.gitHistory.includeBase = true;
  untrustedSecretReceipt.gitHistory.commits += 1;
  fs.writeFileSync(untrustedSecretReceiptPath, `${JSON.stringify(untrustedSecretReceipt, null, 2)}\n`, "utf8");
  fs.mkdirSync(untrustedEvidenceRoot, { recursive: true });
  run(process.execPath, [validationGatePath, "init", "--root", root, "--scope-receipt", untrustedScopePath, "--output", untrustedBundlePath, "--subject-commit", mainHead, "--target", "release-ready"]);
  run(process.execPath, [validationGatePath, "record", "--root", root, "--bundle", untrustedBundlePath, "--validation", "credential-scan", "--executor", "ci", "--evidence-root", untrustedEvidenceRoot, "--evidence-file", untrustedSecretReceiptPath]);
  for (const validationId of ["source-integrity", "diff-check", "build", "build-identity"]) {
    run(process.execPath, [validationGatePath, "record", "--root", root, "--bundle", untrustedBundlePath, "--validation", validationId, "--executor", "ci", "--evidence-root", untrustedEvidenceRoot, "--evidence-label", `fixture-${validationId}`]);
  }
  const untrustedDigestPath = path.join(temporaryRoot, "untrusted-build-output.json");
  writeBuildDigestReceipt(untrustedDigestPath, "web", mainHead, mainHead);
  run(process.execPath, [validationGatePath, "bind-identity", "--root", root, "--bundle", untrustedBundlePath, "--source-version", "RTEST", "--build-id", mainHead, "--build-output-digest-receipt", untrustedDigestPath]);
  assert.match(runFailure(process.execPath, [validationGatePath, "finalize", "--root", root, "--bundle", untrustedBundlePath, "--target", "release-ready", "--evidence-root", untrustedEvidenceRoot, "--quiet"]).stderr, /RELEASE_TRUSTED_BASE_REQUIRED/u);

  const validationBundlePath = path.join(temporaryRoot, "source-candidate-validations.json");
  const validationEvidenceRoot = path.join(temporaryRoot, "source-candidate-evidence");
  fs.mkdirSync(validationEvidenceRoot, { recursive: true });
  const fixtureCommit = mainHead;
  run(process.execPath, [
    validationGatePath, "init",
    "--root", root,
    "--scope-receipt", gateScopePath,
    "--output", validationBundlePath,
    "--subject-commit", fixtureCommit,
    "--target", "source-candidate",
  ]);
  let validationBundle = JSON.parse(fs.readFileSync(validationBundlePath, "utf8"));
  assert.equal(validationBundle.attestations.length, gateScope.requiredValidations.length);
  assert.ok(validationBundle.attestations.every((entry) => entry.status === "pending-required"));
  assert.match(runFailure(process.execPath, [
    validationGatePath, "finalize",
    "--root", root,
    "--bundle", validationBundlePath,
    "--target", "source-candidate",
    "--evidence-root", validationEvidenceRoot,
    "--quiet",
  ]).stderr, /CI_ATTESTATION_REQUIRED/u);

  assert.match(runFailure(process.execPath, [
    validationGatePath, "record", "--root", root, "--bundle", validationBundlePath,
    "--validation", "credential-scan", "--executor", "ci", "--evidence-root", validationEvidenceRoot,
    "--evidence-label", "contract-fixture-must-not-count",
  ]).stderr, /VALIDATION_REQUIRES_MACHINE_RECEIPT/u);

  run(process.execPath, [
    validationGatePath, "record", "--root", root, "--bundle", validationBundlePath,
    "--validation", "credential-scan", "--executor", "ci", "--evidence-root", validationEvidenceRoot,
    "--evidence-file", secretReceiptPath,
  ]);
  for (const validationId of ["source-integrity", "diff-check", "build", "build-identity"]) {
    run(process.execPath, [
      validationGatePath, "record",
      "--root", root,
      "--bundle", validationBundlePath,
      "--validation", validationId,
      "--executor", "ci",
      "--evidence-root", validationEvidenceRoot,
      "--evidence-label", `fixture-${validationId}`,
    ]);
  }
  run(process.execPath, [
    validationGatePath, "bind-identity",
    "--root", root,
    "--bundle", validationBundlePath,
    "--source-version", "RTEST",
    "--build-id", fixtureCommit,
    "--build-output-digest-receipt", (() => {
      const receiptPath = path.join(temporaryRoot, "source-candidate-build-output.json");
      writeBuildDigestReceipt(receiptPath, "web", fixtureCommit, fixtureCommit);
      return receiptPath;
    })(),
  ]);
  run(process.execPath, [
    validationGatePath, "finalize",
    "--root", root,
    "--bundle", validationBundlePath,
    "--target", "source-candidate",
    "--evidence-root", validationEvidenceRoot,
    "--quiet",
  ]);
  validationBundle = JSON.parse(fs.readFileSync(validationBundlePath, "utf8"));
  assert.equal(validationBundle.status, "source-candidate-pending-required");
  for (const validationId of [
    "desktop-precise-route-visual-1440x900",
    "desktop-two-adjacent-pages-visual",
    "console-and-request-errors",
  ]) {
    const visual = validationBundle.attestations.find((entry) => entry.validationId === validationId);
    assert.equal(visual.status, "pending-required");
    assert.equal(visual.executor, "unassigned");
  }

  const missingAttestationPath = path.join(temporaryRoot, "missing-attestation.json");
  const missingAttestation = structuredClone(validationBundle);
  missingAttestation.attestations.pop();
  missingAttestation.summary = {
    requiredCount: missingAttestation.attestations.length,
    passedCount: missingAttestation.attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: missingAttestation.attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: missingAttestation.attestations.filter((entry) => entry.status === "failed").length,
  };
  missingAttestation.bundleId = recomputeBundleId(missingAttestation);
  fs.writeFileSync(missingAttestationPath, `${JSON.stringify(missingAttestation, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [
    validationGatePath, "verify",
    "--root", root,
    "--bundle", missingAttestationPath,
    "--quiet",
  ]).stderr, /BUNDLE_ATTESTATION_SET_MISMATCH/u);

  const releaseBundlePath = path.join(temporaryRoot, "release-ready-validations.json");
  const releaseEvidenceRoot = path.join(temporaryRoot, "release-ready-evidence");
  fs.mkdirSync(releaseEvidenceRoot, { recursive: true });
  run(process.execPath, [
    validationGatePath, "init",
    "--root", root,
    "--scope-receipt", gateScopePath,
    "--output", releaseBundlePath,
    "--subject-commit", fixtureCommit,
    "--target", "source-candidate",
  ]);
  run(process.execPath, [validationGatePath, "record", "--root", root, "--bundle", releaseBundlePath, "--validation", "credential-scan", "--executor", "ci", "--evidence-root", releaseEvidenceRoot, "--evidence-file", secretReceiptPath]);
  for (const validationId of ["source-integrity", "diff-check", "build", "build-identity"]) {
    run(process.execPath, [
      validationGatePath, "record",
      "--root", root,
      "--bundle", releaseBundlePath,
      "--validation", validationId,
      "--executor", "ci",
      "--evidence-root", releaseEvidenceRoot,
      "--evidence-label", `fixture-${validationId}`,
    ]);
  }
  run(process.execPath, [
    validationGatePath, "bind-identity",
    "--root", root,
    "--bundle", releaseBundlePath,
    "--source-version", "RTEST",
    "--build-id", fixtureCommit,
    "--build-output-digest-receipt", (() => {
      const receiptPath = path.join(temporaryRoot, "release-ready-build-output.json");
      writeBuildDigestReceipt(receiptPath, "web", fixtureCommit, fixtureCommit);
      return receiptPath;
    })(),
  ]);
  bindFixtureCandidatePayload(releaseBundlePath, "web", temporaryRoot, "release-ready-fixture");
  run(process.execPath, [validationGatePath, "finalize", "--root", root, "--bundle", releaseBundlePath, "--target", "source-candidate", "--evidence-root", releaseEvidenceRoot, "--quiet"]);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const publicKeyFingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  const trustPath = path.join(repositoryTemporaryRoot, "trusted-issuers.json");
  fs.writeFileSync(trustPath, `${JSON.stringify({
    schemaVersion: "zimeiti-release-acceptance-trusted-issuers.v1",
    projectId: "zimeiti-caopanshou",
    trustRoot: { rootId: "zimeiti-release-acceptance-external-root-v1", custody: "external-controlled", keyMaterial: "public-only" },
    maxEvidenceAgeSeconds: 86400,
    issuers: [{ issuerId: "fixture-browser", trustRootId: "zimeiti-release-acceptance-external-root-v1", publicKeyPem, publicKeyFingerprint, allowedEvidenceTypes: ["release-browser-acceptance"] }],
  }, null, 2)}\n`, "utf8");
  const externalRoot = path.join(repositoryTemporaryRoot, "external-evidence");
  fs.mkdirSync(externalRoot, { recursive: true });
  const externalBundlePath = path.join(repositoryTemporaryRoot, "external-bundle.json");
  const localReleaseBundle = JSON.parse(fs.readFileSync(releaseBundlePath, "utf8"));
  const externalBundle = structuredClone(localReleaseBundle);
  for (const entry of externalBundle.attestations) {
    entry.status = "pending-required";
    entry.executor = "unassigned";
    entry.evidenceRef = null;
    entry.evidenceSha256 = null;
    entry.signatureRef = null;
    entry.signatureSha256 = null;
  }
  const now = Date.now();
  const browserValidationIds = ["desktop-precise-route-visual-1440x900", "desktop-two-adjacent-pages-visual", "console-and-request-errors"];
  for (const [index, validationId] of browserValidationIds.entries()) {
    const evidenceRef = `${validationId}.json`;
    const evidencePath = path.join(externalRoot, evidenceRef);
    const evidence = {
      schemaVersion: "zimeiti-release-browser-acceptance-evidence.v1",
      receiptId: `browser-receipt-${index}-1234567890`,
      nonce: `browser_nonce_${index}_1234567890`,
      checkedAt: new Date(now - 1_000).toISOString(),
      subject: {
        commit: fixtureCommit,
        sourceVersion: "RTEST",
        builds: localReleaseBundle.subject.builds,
        buildOutputDigests: localReleaseBundle.subject.buildOutputDigests,
        candidatePayloads: localReleaseBundle.subject.candidatePayloads,
      },
      runtimeReadbacks: {
        web: {
          commit: fixtureCommit,
          sourceVersion: "RTEST",
          buildId: fixtureCommit,
          buildOutputDigest: localReleaseBundle.subject.buildOutputDigests.web,
        },
        voice: null,
      },
      viewport: { width: 1440, height: 900 },
      preciseRoute: localReleaseBundle.scope.browserAcceptance.preciseRoute,
      adjacentRoutes: localReleaseBundle.scope.browserAcceptance.requiredRoutes.filter((route) => route !== localReleaseBundle.scope.browserAcceptance.preciseRoute),
      consoleErrors: [],
      requestFailures: [],
      result: "passed",
    };
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(evidencePath, evidenceBytes);
    const signature = {
      schemaVersion: "zimeiti-release-browser-acceptance-signature.v1",
      algorithm: "Ed25519",
      issuerId: "fixture-browser",
      publicKeyFingerprint,
      receiptId: evidence.receiptId,
      nonce: evidence.nonce,
      issuedAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      evidenceType: "release-browser-acceptance",
      targetSha256: sha256(evidenceBytes),
      subjectCommit: fixtureCommit,
      sourceVersion: "RTEST",
      webBuildId: fixtureCommit,
      voiceBuildId: null,
      webOutputDigest: localReleaseBundle.subject.buildOutputDigests.web,
      voiceOutputDigest: null,
    };
    signature.signature = crypto.sign(null, Buffer.from(canonicalJson(signature)), privateKey).toString("base64");
    fs.writeFileSync(`${evidencePath}.sig.json`, `${JSON.stringify(signature, null, 2)}\n`, "utf8");
    const entry = externalBundle.attestations.find((candidate) => candidate.validationId === validationId);
    entry.status = "passed";
    entry.executor = "external-browser";
    entry.evidenceRef = evidenceRef;
    entry.evidenceSha256 = sha256(evidenceBytes);
    entry.signatureRef = `${evidenceRef}.sig.json`;
    entry.signatureSha256 = sha256(fs.readFileSync(`${evidencePath}.sig.json`));
  }
  externalBundle.summary = {
    requiredCount: externalBundle.attestations.length,
    passedCount: externalBundle.attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: externalBundle.attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: 0,
  };
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");

  const tamperBundlePath = path.join(temporaryRoot, "tamper-local-bundle.json");
  const tamperEvidenceRoot = path.join(temporaryRoot, "tamper-evidence");
  fs.mkdirSync(tamperEvidenceRoot, { recursive: true });
  fs.copyFileSync(releaseBundlePath, tamperBundlePath);
  const firstMergedBrowserValidationId = [...browserValidationIds].sort((left, right) => left.localeCompare(right))[0];
  const tamperedEvidencePath = path.join(externalRoot, `${firstMergedBrowserValidationId}.json`);
  const originalEvidenceBytes = fs.readFileSync(tamperedEvidencePath);
  const tamperedEvidenceBytes = Buffer.concat([originalEvidenceBytes, Buffer.from(" ")]);
  fs.writeFileSync(tamperedEvidencePath, tamperedEvidenceBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(tamperedEvidenceBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", tamperBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", tamperEvidenceRoot]).stderr, /BROWSER_SIGNATURE_BINDING_MISMATCH/u);
  fs.writeFileSync(tamperedEvidencePath, originalEvidenceBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(originalEvidenceBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");

  const originalSignatureBytes = fs.readFileSync(`${tamperedEvidencePath}.sig.json`);
  const invalidBrowserEvidence = JSON.parse(originalEvidenceBytes.toString("utf8"));
  invalidBrowserEvidence.consoleErrors = ["fixture console error"];
  const invalidBrowserBytes = Buffer.from(`${JSON.stringify(invalidBrowserEvidence, null, 2)}\n`);
  fs.writeFileSync(tamperedEvidencePath, invalidBrowserBytes);
  const invalidBrowserSignature = JSON.parse(originalSignatureBytes.toString("utf8"));
  invalidBrowserSignature.targetSha256 = sha256(invalidBrowserBytes);
  delete invalidBrowserSignature.signature;
  invalidBrowserSignature.signature = crypto.sign(null, Buffer.from(canonicalJson(invalidBrowserSignature)), privateKey).toString("base64");
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, `${JSON.stringify(invalidBrowserSignature, null, 2)}\n`, "utf8");
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(invalidBrowserBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(fs.readFileSync(`${tamperedEvidencePath}.sig.json`));
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");
  const semanticTamperBundlePath = path.join(temporaryRoot, "semantic-tamper-local-bundle.json");
  const semanticTamperEvidenceRoot = path.join(temporaryRoot, "semantic-tamper-evidence");
  fs.copyFileSync(releaseBundlePath, semanticTamperBundlePath);
  fs.mkdirSync(semanticTamperEvidenceRoot, { recursive: true });
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", semanticTamperBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", semanticTamperEvidenceRoot]).stderr, /BROWSER_EVIDENCE_SCHEMA_INVALID/u);
  fs.writeFileSync(tamperedEvidencePath, originalEvidenceBytes);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, originalSignatureBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(originalEvidenceBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(originalSignatureBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");

  const unrelatedRouteEvidence = JSON.parse(originalEvidenceBytes.toString("utf8"));
  unrelatedRouteEvidence.preciseRoute = "/unrelated";
  unrelatedRouteEvidence.adjacentRoutes = ["/cover", "/unrelated-neighbor"];
  const unrelatedRouteBytes = Buffer.from(`${JSON.stringify(unrelatedRouteEvidence, null, 2)}\n`);
  const unrelatedRouteSignature = JSON.parse(originalSignatureBytes.toString("utf8"));
  unrelatedRouteSignature.targetSha256 = sha256(unrelatedRouteBytes);
  delete unrelatedRouteSignature.signature;
  unrelatedRouteSignature.signature = crypto.sign(null, Buffer.from(canonicalJson(unrelatedRouteSignature)), privateKey).toString("base64");
  fs.writeFileSync(tamperedEvidencePath, unrelatedRouteBytes);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, `${JSON.stringify(unrelatedRouteSignature, null, 2)}\n`, "utf8");
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(unrelatedRouteBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(fs.readFileSync(`${tamperedEvidencePath}.sig.json`));
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", semanticTamperBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", semanticTamperEvidenceRoot]).stderr, /BROWSER_EVIDENCE_(?:PRECISE_ROUTE|SCOPE_ROUTES)_MISMATCH/u);

  const oldOutputEvidence = JSON.parse(originalEvidenceBytes.toString("utf8"));
  oldOutputEvidence.runtimeReadbacks.web.buildOutputDigest = "f".repeat(64);
  const oldOutputBytes = Buffer.from(`${JSON.stringify(oldOutputEvidence, null, 2)}\n`);
  const oldOutputSignature = JSON.parse(originalSignatureBytes.toString("utf8"));
  oldOutputSignature.targetSha256 = sha256(oldOutputBytes);
  delete oldOutputSignature.signature;
  oldOutputSignature.signature = crypto.sign(null, Buffer.from(canonicalJson(oldOutputSignature)), privateKey).toString("base64");
  fs.writeFileSync(tamperedEvidencePath, oldOutputBytes);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, `${JSON.stringify(oldOutputSignature, null, 2)}\n`, "utf8");
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(oldOutputBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(fs.readFileSync(`${tamperedEvidencePath}.sig.json`));
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", semanticTamperBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", semanticTamperEvidenceRoot]).stderr, /BROWSER_RUNTIME_READBACK_MISMATCH/u);
  fs.writeFileSync(tamperedEvidencePath, originalEvidenceBytes);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, originalSignatureBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).evidenceSha256 = sha256(originalEvidenceBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(originalSignatureBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");

  const staleSignature = JSON.parse(originalSignatureBytes.toString("utf8"));
  staleSignature.issuedAt = new Date(now - 2 * 86400_000).toISOString();
  staleSignature.expiresAt = new Date(now + 60_000).toISOString();
  delete staleSignature.signature;
  staleSignature.signature = crypto.sign(null, Buffer.from(canonicalJson(staleSignature)), privateKey).toString("base64");
  const staleSignatureBytes = Buffer.from(`${JSON.stringify(staleSignature, null, 2)}\n`);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, staleSignatureBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(staleSignatureBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");
  const staleBundlePath = path.join(temporaryRoot, "stale-local-bundle.json");
  const staleEvidenceRoot = path.join(temporaryRoot, "stale-evidence");
  fs.copyFileSync(releaseBundlePath, staleBundlePath);
  fs.mkdirSync(staleEvidenceRoot, { recursive: true });
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", staleBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", staleEvidenceRoot]).stderr, /BROWSER_EVIDENCE_EXPIRED_OR_FUTURE_DATED/u);
  fs.writeFileSync(`${tamperedEvidencePath}.sig.json`, originalSignatureBytes);
  externalBundle.attestations.find((entry) => entry.validationId === firstMergedBrowserValidationId).signatureSha256 = sha256(originalSignatureBytes);
  externalBundle.bundleId = recomputeBundleId(externalBundle);
  fs.writeFileSync(externalBundlePath, `${JSON.stringify(externalBundle, null, 2)}\n`, "utf8");

  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", releaseBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", releaseEvidenceRoot]).stderr, /BROWSER_SIGNATURE_BINDING_MISMATCH/u);
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", releaseBundlePath, "--external-bundle", path.relative(root, externalBundlePath).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", releaseEvidenceRoot, "--trusted-issuers", path.relative(root, trustPath).replaceAll("\\", "/")]).stderr, /TRUSTED_ISSUERS_OVERRIDE_FORBIDDEN/u);
  const mergedReleaseBundle = JSON.parse(fs.readFileSync(releaseBundlePath, "utf8"));
  for (const validationId of browserValidationIds) {
    const entry = mergedReleaseBundle.attestations.find((candidate) => candidate.validationId === validationId);
    assert.equal(entry.status, "pending-required");
    assert.equal(entry.executor, "unassigned");
  }

  const outsideJunctionTarget = path.join(temporaryRoot, "junction-outside");
  fs.mkdirSync(outsideJunctionTarget, { recursive: true });
  fs.copyFileSync(externalBundlePath, path.join(outsideJunctionTarget, "bundle.json"));
  const junctionPath = path.join(repositoryTemporaryRoot, "escape-junction");
  fs.symlinkSync(outsideJunctionTarget, junctionPath, process.platform === "win32" ? "junction" : "dir");
  assert.match(runFailure(process.execPath, [validationGatePath, "merge-external", "--root", root, "--bundle", tamperBundlePath, "--external-bundle", path.relative(root, path.join(junctionPath, "bundle.json")).replaceAll("\\", "/"), "--external-evidence-root", path.relative(root, externalRoot).replaceAll("\\", "/"), "--evidence-root", releaseEvidenceRoot]).stderr, /EXTERNAL_BUNDLE_PATH_UNSAFE/u);

  // Exercise the exact staged workflow on one bundle with a fixture-only public
  // trust root: init candidate -> CI -> build identity -> browser evidence ->
  // promote -> release-ready. The private key never enters the fixture root.
  const transitionRoot = path.join(repositoryTemporaryRoot, "transition-repository");
  fs.mkdirSync(path.join(transitionRoot, "scripts"), { recursive: true });
  fs.cpSync(path.join(root, "scripts", "contracts"), path.join(transitionRoot, "scripts", "contracts"), { recursive: true });
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(transitionRoot, "scripts", "lib"), { recursive: true });
  for (const scriptName of ["classify-release-change-scope.mjs", "run-release-targeted-regressions.mjs", "verify-video-live-history-ui-only-zero-network.mjs"]) {
    fs.copyFileSync(path.join(root, "scripts", scriptName), path.join(transitionRoot, "scripts", scriptName));
  }
  fs.mkdirSync(path.join(transitionRoot, "deploy", "policies"), { recursive: true });
  const transitionTrustRelative = "deploy/policies/release-acceptance-trusted-issuers.v1.json";
  const transitionTrustPath = path.join(transitionRoot, ...transitionTrustRelative.split("/"));
  const transitionTrust = {
    schemaVersion: "zimeiti-release-acceptance-trusted-issuers.v1",
    projectId: "zimeiti-caopanshou",
    trustRoot: { rootId: "zimeiti-release-acceptance-external-root-v1", custody: "external-controlled", keyMaterial: "public-only" },
    maxEvidenceAgeSeconds: 86400,
    issuers: [{ issuerId: "fixture-browser", trustRootId: "zimeiti-release-acceptance-external-root-v1", publicKeyPem, publicKeyFingerprint, allowedEvidenceTypes: ["release-browser-acceptance"] }],
  };
  fs.writeFileSync(transitionTrustPath, `${JSON.stringify(transitionTrust, null, 2)}\n`, "utf8");
  const transitionPolicy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  transitionPolicy.browserAcceptanceTrust = {
    ...transitionPolicy.browserAcceptanceTrust,
    path: transitionTrustRelative,
    sha256: sha256(fs.readFileSync(transitionTrustPath)),
  };
  fs.writeFileSync(path.join(transitionRoot, "deploy", "policies", "release-change-scope.v1.json"), `${JSON.stringify(transitionPolicy, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(transitionRoot, "src", "app", "video"), { recursive: true });
  const transitionPage = path.join(transitionRoot, "src", "app", "video", "page.tsx");
  fs.writeFileSync(transitionPage, "export default function Page() { return <main>before</main>; }\n", "utf8");
  run("git", ["init", "--quiet"], transitionRoot);
  run("git", ["config", "user.email", "release-transition@example.invalid"], transitionRoot);
  run("git", ["config", "user.name", "Release Transition Fixture"], transitionRoot);
  run("git", ["add", "--", "deploy", "scripts", "src"], transitionRoot);
  run("git", ["commit", "--quiet", "-m", "baseline"], transitionRoot);
  const transitionBase = run("git", ["rev-parse", "HEAD"], transitionRoot).stdout.trim();
  fs.writeFileSync(transitionPage, "export default function Page() { return <main>after</main>; }\n", "utf8");
  run("git", ["add", "--", "src/app/video/page.tsx"], transitionRoot);
  run("git", ["commit", "--quiet", "-m", "change video page"], transitionRoot);
  const transitionHead = run("git", ["rev-parse", "HEAD"], transitionRoot).stdout.trim();
  const transitionScopePath = path.join(temporaryRoot, "transition-scope.json");
  run(process.execPath, [path.join(transitionRoot, "scripts", "classify-release-change-scope.mjs"), "--root", transitionRoot, "--base", transitionBase, "--head", transitionHead, "--range-mode", "direct", "--output", transitionScopePath, "--quiet"], transitionRoot);
  const transitionScope = JSON.parse(fs.readFileSync(transitionScopePath, "utf8"));
  assert.equal(transitionScope.input.trustedBase, true);
  assert.equal(transitionScope.browserAcceptance.explicitRoutesRequired, false);
  const transitionSecretPath = path.join(temporaryRoot, "transition-secret-receipt.json");
  run(process.execPath, [secretScannerPath, "--candidate-commit", transitionHead, "--history-base", transitionBase, "--history-head", transitionHead, "--scope-receipt", transitionScopePath, "--require-clean-candidate", "--receipt", transitionSecretPath], transitionRoot);
  const transitionBundlePath = path.join(transitionRoot, "validation-bundle.json");
  const transitionEvidenceRoot = path.join(transitionRoot, "ci-evidence");
  fs.mkdirSync(transitionEvidenceRoot, { recursive: true });
  run(process.execPath, [validationGatePath, "init", "--root", transitionRoot, "--scope-receipt", transitionScopePath, "--output", transitionBundlePath, "--subject-commit", transitionHead, "--target", "source-candidate"]);
  run(process.execPath, [validationGatePath, "record", "--root", transitionRoot, "--bundle", transitionBundlePath, "--validation", "credential-scan", "--executor", "ci", "--evidence-root", transitionEvidenceRoot, "--evidence-file", transitionSecretPath]);
  for (const validationId of transitionScope.requiredValidations.filter((id) => !browserValidationIds.includes(id) && id !== "credential-scan" && id !== "targeted-zero-network-regression")) {
    run(process.execPath, [validationGatePath, "record", "--root", transitionRoot, "--bundle", transitionBundlePath, "--validation", validationId, "--executor", "ci", "--evidence-root", transitionEvidenceRoot, "--evidence-label", `transition-${validationId}`]);
  }
  if (transitionScope.requiredValidations.includes("targeted-zero-network-regression")) {
    const transitionTargetedPath = path.join(transitionRoot, "targeted-receipt.json");
    const regressionIds = [...new Set(transitionScope.changedFiles.flatMap((entry) => entry.targetedRegressionIds))];
    fs.writeFileSync(transitionTargetedPath, `${JSON.stringify({
      schemaVersion: "zimeiti-release-targeted-regression-receipt.v1",
      scopeReceiptId: transitionScope.receiptId,
      scopeReceiptSha256: sha256(fs.readFileSync(transitionScopePath)),
      subjectCommit: transitionHead,
      classification: "FAST",
      changedFiles: transitionScope.changedFiles.map((entry) => ({ path: entry.path, regressionIds: entry.targetedRegressionIds })),
      executions: regressionIds.map((regressionId) => ({ regressionId, executable: process.execPath, args: ["fixture-covered-by-earlier-real-targeted-run"], exitCode: 0 })),
      result: "passed",
    }, null, 2)}\n`, "utf8");
    run(process.execPath, [validationGatePath, "record", "--root", transitionRoot, "--bundle", transitionBundlePath, "--validation", "targeted-zero-network-regression", "--executor", "ci", "--evidence-root", transitionEvidenceRoot, "--evidence-file", transitionTargetedPath]);
  }
  const transitionDigestPath = path.join(transitionRoot, "build-output.json");
  writeBuildDigestReceipt(transitionDigestPath, "web", transitionHead, transitionHead);
  run(process.execPath, [validationGatePath, "bind-identity", "--root", transitionRoot, "--bundle", transitionBundlePath, "--source-version", "RTEST", "--build-id", transitionHead, "--build-output-digest-receipt", transitionDigestPath]);
  bindFixtureCandidatePayload(transitionBundlePath, "web", transitionRoot, "transition-fixture");
  run(process.execPath, [validationGatePath, "finalize", "--root", transitionRoot, "--bundle", transitionBundlePath, "--target", "source-candidate", "--evidence-root", transitionEvidenceRoot, "--quiet"]);
  const candidateBundle = JSON.parse(fs.readFileSync(transitionBundlePath, "utf8"));
  assert.equal(candidateBundle.status, "source-candidate-pending-required");
  const candidateBundleId = candidateBundle.bundleId;

  const transitionExternalRoot = path.join(transitionRoot, "browser-evidence");
  fs.mkdirSync(transitionExternalRoot, { recursive: true });
  const transitionExternalBundlePath = path.join(transitionRoot, "browser-bundle.json");
  const transitionExternalBundle = structuredClone(candidateBundle);
  for (const entry of transitionExternalBundle.attestations) {
    entry.status = "pending-required";
    entry.executor = "unassigned";
    entry.evidenceRef = null;
    entry.evidenceSha256 = null;
    entry.signatureRef = null;
    entry.signatureSha256 = null;
  }
  const transitionNow = Date.now();
  for (const [index, validationId] of browserValidationIds.entries()) {
    const evidenceRef = `${validationId}.json`;
    const evidencePath = path.join(transitionExternalRoot, evidenceRef);
    const evidence = {
      schemaVersion: "zimeiti-release-browser-acceptance-evidence.v1",
      receiptId: `transition-browser-${index}-1234567890`,
      nonce: `transition_nonce_${index}_1234567890`,
      checkedAt: new Date(transitionNow - 1000).toISOString(),
      subject: { commit: transitionHead, sourceVersion: "RTEST", builds: candidateBundle.subject.builds, buildOutputDigests: candidateBundle.subject.buildOutputDigests, candidatePayloads: candidateBundle.subject.candidatePayloads },
      runtimeReadbacks: { web: { commit: transitionHead, sourceVersion: "RTEST", buildId: transitionHead, buildOutputDigest: candidateBundle.subject.buildOutputDigests.web }, voice: null },
      viewport: { width: 1440, height: 900 },
      preciseRoute: candidateBundle.scope.browserAcceptance.preciseRoute,
      adjacentRoutes: candidateBundle.scope.browserAcceptance.requiredRoutes.filter((route) => route !== candidateBundle.scope.browserAcceptance.preciseRoute),
      consoleErrors: [], requestFailures: [], result: "passed",
    };
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(evidencePath, evidenceBytes);
    const signature = {
      schemaVersion: "zimeiti-release-browser-acceptance-signature.v1", algorithm: "Ed25519", issuerId: "fixture-browser", publicKeyFingerprint,
      receiptId: evidence.receiptId, nonce: evidence.nonce, issuedAt: new Date(transitionNow - 1000).toISOString(), expiresAt: new Date(transitionNow + 60_000).toISOString(),
      evidenceType: "release-browser-acceptance", targetSha256: sha256(evidenceBytes), subjectCommit: transitionHead, sourceVersion: "RTEST",
      webBuildId: transitionHead, voiceBuildId: null, webOutputDigest: candidateBundle.subject.buildOutputDigests.web, voiceOutputDigest: null,
    };
    signature.signature = crypto.sign(null, Buffer.from(canonicalJson(signature)), privateKey).toString("base64");
    fs.writeFileSync(`${evidencePath}.sig.json`, `${JSON.stringify(signature, null, 2)}\n`, "utf8");
    const entry = transitionExternalBundle.attestations.find((candidate) => candidate.validationId === validationId);
    entry.status = "passed"; entry.executor = "external-browser"; entry.evidenceRef = evidenceRef; entry.evidenceSha256 = sha256(evidenceBytes);
    entry.signatureRef = `${evidenceRef}.sig.json`; entry.signatureSha256 = sha256(fs.readFileSync(`${evidencePath}.sig.json`));
  }
  transitionExternalBundle.summary = {
    requiredCount: transitionExternalBundle.attestations.length,
    passedCount: transitionExternalBundle.attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: transitionExternalBundle.attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: transitionExternalBundle.attestations.filter((entry) => entry.status === "failed").length,
  };
  transitionExternalBundle.bundleId = recomputeBundleId(transitionExternalBundle);
  fs.writeFileSync(transitionExternalBundlePath, `${JSON.stringify(transitionExternalBundle, null, 2)}\n`, "utf8");
  run(process.execPath, [validationGatePath, "merge-external", "--root", transitionRoot, "--bundle", transitionBundlePath, "--external-bundle", "browser-bundle.json", "--external-evidence-root", "browser-evidence", "--evidence-root", transitionEvidenceRoot]);
  run(process.execPath, [validationGatePath, "promote-release-ready", "--root", transitionRoot, "--bundle", transitionBundlePath]);
  run(process.execPath, [validationGatePath, "finalize", "--root", transitionRoot, "--bundle", transitionBundlePath, "--target", "release-ready", "--evidence-root", transitionEvidenceRoot, "--quiet"]);
  const releaseReadyTransition = JSON.parse(fs.readFileSync(transitionBundlePath, "utf8"));
  assert.equal(releaseReadyTransition.target, "release-ready");
  assert.equal(releaseReadyTransition.status, "release-ready");
  assert.notEqual(releaseReadyTransition.bundleId, candidateBundleId);
  assert.deepEqual(releaseReadyTransition.subject, candidateBundle.subject, "promotion must retain the exact build/output identity in the same bundle file");

  // Run the real packager on a minimal traced pnpm-style candidate, then delete
  // that entire candidate workspace. A fresh checkout with no node_modules must
  // finalize the exact archive without install, rebuild, or rematerialization.
  const packageCandidateRoot = path.join(temporaryRoot, "package-candidate-workspace");
  fs.mkdirSync(path.join(packageCandidateRoot, "deploy", "policies"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, "deploy", "assets"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, "deploy", "pm2"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, "public"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, "scripts", "contracts"), { recursive: true });
  fs.cpSync(path.join(root, "scripts", "contracts"), path.join(packageCandidateRoot, "scripts", "contracts"), { recursive: true });
  fs.cpSync(path.join(root, "scripts", "lib"), path.join(packageCandidateRoot, "scripts", "lib"), { recursive: true });
  fs.copyFileSync(classifierPath, path.join(packageCandidateRoot, "scripts", "classify-release-change-scope.mjs"));
  fs.copyFileSync(validationGatePath, path.join(packageCandidateRoot, "scripts", "release-change-validation-gate.mjs"));
  fs.copyFileSync(path.join(transitionRoot, "deploy", "policies", "release-change-scope.v1.json"), path.join(packageCandidateRoot, "deploy", "policies", "release-change-scope.v1.json"));
  fs.copyFileSync(path.join(transitionRoot, "deploy", "policies", "release-acceptance-trusted-issuers.v1.json"), path.join(packageCandidateRoot, "deploy", "policies", "release-acceptance-trusted-issuers.v1.json"));
  const packageAssetManifestPath = path.join(packageCandidateRoot, "deploy", "assets", "public-assets.json");
  const packageAssetManifest = { assetVersion: "fixture-v1", digest: "a".repeat(64) };
  fs.writeFileSync(packageAssetManifestPath, `${JSON.stringify(packageAssetManifest, null, 2)}\n`, "utf8");
  const packagePolicyPath = path.join(packageCandidateRoot, "deploy", "policies", "release-policy.json");
  const packagePolicy = {
    projectId: "zimeiti-caopanshou",
    services: { web: { standaloneDirectory: ".next/standalone", healthPath: "/api/health", readinessPath: "/api/release-readiness", port: 5000 } },
    assets: { manifest: "deploy/assets/public-assets.json" },
    source: { publicSourcePaths: ["public/version.json"] },
    release: { productionBuild: { platform: "linux", architectures: ["x64"], nodeMajor: 24, pnpmVersion: "9.0.0" } },
  };
  fs.writeFileSync(packagePolicyPath, `${JSON.stringify(packagePolicy, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, "deploy", "pm2", "ecosystem.vnext.config.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, "public", "version.json"), `${JSON.stringify({ sourceVersion: "RTEST" })}\n`, "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, "README.md"), "isolated package candidate\n", "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, ".gitattributes"), "* -text\n", "utf8");
  run("git", ["init", "--quiet"], packageCandidateRoot);
  run("git", ["config", "user.email", "package-candidate@example.invalid"], packageCandidateRoot);
  run("git", ["config", "user.name", "Package Candidate Fixture"], packageCandidateRoot);
  fs.appendFileSync(path.join(packageCandidateRoot, ".git", "info", "exclude"), ".next/\n.release/\nnode_modules/\n", "utf8");
  run("git", ["add", "--", ".gitattributes", "README.md", "deploy", "public", "scripts"], packageCandidateRoot);
  run("git", ["commit", "--quiet", "-m", "candidate baseline"], packageCandidateRoot);
  const packageBase = run("git", ["rev-parse", "HEAD"], packageCandidateRoot).stdout.trim();
  fs.writeFileSync(path.join(packageCandidateRoot, "README.md"), "isolated package candidate updated\n", "utf8");
  run("git", ["add", "--", "README.md"], packageCandidateRoot);
  run("git", ["commit", "--quiet", "-m", "candidate change"], packageCandidateRoot);
  const packageCommit = run("git", ["rev-parse", "HEAD"], packageCandidateRoot).stdout.trim();
  const packageScopePath = path.join(temporaryRoot, "package-candidate-scope.json");
  run(process.execPath, [path.join(packageCandidateRoot, "scripts", "classify-release-change-scope.mjs"), "--root", packageCandidateRoot, "--base", packageBase, "--head", packageCommit, "--range-mode", "direct", "--output", packageScopePath, "--quiet"], packageCandidateRoot);
  const packageScope = JSON.parse(fs.readFileSync(packageScopePath, "utf8"));
  const packageBuildId = "fixture-build-output-r000001";
  const packageStandalone = path.join(packageCandidateRoot, ".next", "standalone");
  fs.mkdirSync(path.join(packageStandalone, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, ".next", "static"), { recursive: true });
  fs.mkdirSync(path.join(packageCandidateRoot, ".release"), { recursive: true });
  fs.writeFileSync(path.join(packageCandidateRoot, ".next", "BUILD_ID"), `${packageBuildId}\n`, "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, ".next", "static", "chunk.js"), "fixture static\n", "utf8");
  fs.writeFileSync(path.join(packageStandalone, "server.js"), "require('next'); require('react'); require('react-dom/server');\n", "utf8");
  fs.writeFileSync(path.join(packageStandalone, "package.json"), `${JSON.stringify({ name: "fixture-standalone", version: "1.0.0" })}\n`, "utf8");
  fs.writeFileSync(path.join(packageStandalone, "top-level.map"), "top-level source map\n", "utf8");
  fs.writeFileSync(path.join(packageCandidateRoot, ".next", "static", "static-nested.map"), "static source map\n", "utf8");
  for (const packageName of ["next", "react", "react-dom", "cos-nodejs-sdk-v5"]) {
    const packageRoot = path.join(packageCandidateRoot, "node_modules", packageName);
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: packageName, version: "1.0.0", main: "index.js" })}\n`, "utf8");
    const implementation = packageName === "next"
      ? "module.exports = function next() {};\n"
      : packageName === "cos-nodejs-sdk-v5"
        ? "module.exports = class COS { putObject() {} headObject() {} };\n"
        : "module.exports = {};\n";
    fs.writeFileSync(path.join(packageRoot, "index.js"), implementation, "utf8");
    fs.writeFileSync(path.join(packageRoot, "package-nested.map"), "dependency source map\n", "utf8");
    if (packageName === "react-dom") fs.writeFileSync(path.join(packageRoot, "server.js"), "module.exports = {};\n", "utf8");
    fs.symlinkSync(packageRoot, path.join(packageStandalone, "node_modules", packageName), process.platform === "win32" ? "junction" : "dir");
  }
  const packagePnpmMap = path.join(packageStandalone, "node_modules", ".pnpm", "fixture@1", "node_modules", "fixture", "virtual-store.map");
  fs.mkdirSync(path.dirname(packagePnpmMap), { recursive: true });
  fs.writeFileSync(packagePnpmMap, "virtual store source map\n", "utf8");
  const packageSourceManifestPath = path.join(packageCandidateRoot, ".release", "source-files.v1.json");
  const packageSourceManifest = {
    assetManifestSha256: sha256(fs.readFileSync(packageAssetManifestPath)),
    assetDigest: packageAssetManifest.digest,
    sourceFingerprint: "b".repeat(64),
  };
  fs.writeFileSync(packageSourceManifestPath, `${JSON.stringify(packageSourceManifest, null, 2)}\n`, "utf8");
  const packageProvenance = {
    projectId: packagePolicy.projectId,
    service: "web",
    sourceCommit: packageCommit,
    sourceManifestSha256: sha256(fs.readFileSync(packageSourceManifestPath)),
    policySha256: sha256(fs.readFileSync(packagePolicyPath)),
    assetManifestSha256: sha256(fs.readFileSync(packageAssetManifestPath)),
    assetDigest: packageAssetManifest.digest,
    assetVersion: packageAssetManifest.assetVersion,
    buildId: packageBuildId,
    deployable: false,
    buildEnvironment: { platform: process.platform, arch: process.arch, nodeVersion: process.version, pnpmVersion: "fixture", libc: "fixture" },
    builtAt: new Date(0).toISOString(),
  };
  fs.writeFileSync(path.join(packageCandidateRoot, ".next", "release-provenance.v1.json"), `${JSON.stringify(packageProvenance, null, 2)}\n`, "utf8");
  const packageDigestReceiptPath = path.join(temporaryRoot, "package-candidate-build-output.json");
  run(process.execPath, [buildOutputDigestPath, "--root", packageCandidateRoot, "--service", "web", "--commit", packageCommit, "--source-version", "RTEST", "--receipt", packageDigestReceiptPath], packageCandidateRoot);
  const packageDigestReceipt = JSON.parse(fs.readFileSync(packageDigestReceiptPath, "utf8"));
  const packageSecretReceiptPath = path.join(temporaryRoot, "package-candidate-secret.json");
  run(process.execPath, [secretScannerPath, "--candidate-commit", packageCommit, "--history-base", packageBase, "--history-head", packageCommit, "--scope-receipt", packageScopePath, "--require-clean-candidate", "--receipt", packageSecretReceiptPath], packageCandidateRoot);
  const authoritativePackageBundlePath = path.join(temporaryRoot, "package-candidate-validations.json");
  const authoritativePackageEvidenceRoot = path.join(temporaryRoot, "package-candidate-evidence");
  fs.mkdirSync(authoritativePackageEvidenceRoot, { recursive: true });
  run(process.execPath, [validationGatePath, "init", "--root", packageCandidateRoot, "--scope-receipt", packageScopePath, "--output", authoritativePackageBundlePath, "--subject-commit", packageCommit, "--target", "source-candidate"]);
  run(process.execPath, [validationGatePath, "record", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--validation", "credential-scan", "--executor", "ci", "--evidence-root", authoritativePackageEvidenceRoot, "--evidence-file", packageSecretReceiptPath]);
  for (const validationId of packageScope.requiredValidations.filter((id) => !browserValidationIds.includes(id) && id !== "credential-scan" && id !== "targeted-zero-network-regression")) {
    run(process.execPath, [validationGatePath, "record", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--validation", validationId, "--executor", "ci", "--evidence-root", authoritativePackageEvidenceRoot, "--evidence-label", `package-${validationId}`]);
  }
  if (packageScope.requiredValidations.includes("targeted-zero-network-regression")) {
    const targetedPath = path.join(temporaryRoot, "package-targeted.json");
    const regressionIds = [...new Set(packageScope.changedFiles.flatMap((entry) => entry.targetedRegressionIds))];
    fs.writeFileSync(targetedPath, `${JSON.stringify({
      schemaVersion: "zimeiti-release-targeted-regression-receipt.v1",
      scopeReceiptId: packageScope.receiptId,
      scopeReceiptSha256: sha256(fs.readFileSync(packageScopePath)),
      subjectCommit: packageCommit,
      classification: "FAST",
      changedFiles: packageScope.changedFiles.map((entry) => ({ path: entry.path, regressionIds: entry.targetedRegressionIds })),
      executions: regressionIds.map((regressionId) => ({ regressionId, executable: process.execPath, args: ["fixture"], exitCode: 0 })),
      result: "passed",
    }, null, 2)}\n`, "utf8");
    run(process.execPath, [validationGatePath, "record", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--validation", "targeted-zero-network-regression", "--executor", "ci", "--evidence-root", authoritativePackageEvidenceRoot, "--evidence-file", targetedPath]);
  }
  run(process.execPath, [validationGatePath, "bind-identity", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--source-version", "RTEST", "--build-id", packageBuildId, "--build-output-digest-receipt", packageDigestReceiptPath]);
  const candidateArtifactDirectory = path.join(temporaryRoot, "candidate-materialized-artifact");
  const candidateArchivePath = path.join(temporaryRoot, "candidate-materialized-artifact.tar.gz");
  run(process.execPath, [packagerPath, "--root", packageCandidateRoot, "--service", "web", "--output", candidateArtifactDirectory, "--release-id", "fixture-candidate-r000001", "--commit", packageCommit, "--build-output-digest-receipt", packageDigestReceiptPath, "--allow-local-rehearsal", "1", "--archive", "--archive-path", candidateArchivePath], packageCandidateRoot);
  const candidateArtifactManifest = JSON.parse(fs.readFileSync(path.join(candidateArtifactDirectory, "release-manifest.json"), "utf8"));
  assert.ok(candidateArtifactManifest.materializedSymlinkCount >= 3, "fixture must exercise traced dependency link materialization");
  assert.equal(fs.existsSync(path.join(candidateArtifactDirectory, "node_modules", "next", "index.js")), true);
  assert.equal(candidateArtifactManifest.files.some((entry) => entry.path.endsWith(".map")), false, "artifact inventory must omit all source maps");
  const artifactMapPaths = [];
  const artifactLinkPaths = [];
  const inspectArtifactMaps = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stats = fs.lstatSync(entryPath);
      if (stats.isSymbolicLink()) artifactLinkPaths.push(entryPath);
      else if (stats.isDirectory()) inspectArtifactMaps(entryPath);
      else if (entry.name.toLowerCase().endsWith(".map")) artifactMapPaths.push(entryPath);
    }
  };
  inspectArtifactMaps(candidateArtifactDirectory);
  assert.deepEqual(artifactMapPaths, [], "materialized artifact directory must not contain source maps");
  assert.deepEqual(artifactLinkPaths, [], "materialized artifact directory must not contain symbolic links or junctions");
  const candidateArchiveListing = run("tar", ["-tzf", candidateArchivePath]).stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(candidateArchiveListing.some((entry) => entry.toLowerCase().endsWith(".map")), false, "artifact tar must not contain source maps");
  const sourceVersionTamperManifestPath = path.join(temporaryRoot, "candidate-source-version-tamper-manifest.json");
  fs.writeFileSync(sourceVersionTamperManifestPath, `${JSON.stringify({ ...candidateArtifactManifest, sourceVersion: "RTEST-TAMPERED" }, null, 2)}\n`, "utf8");
  assert.match(
    runFailure(process.execPath, [validationGatePath, "bind-package-payload", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--service", "web", "--manifest", sourceVersionTamperManifestPath, "--archive", candidateArchivePath]).stderr,
    /CANDIDATE_PAYLOAD_BUILD_IDENTITY_MISMATCH/u,
    "candidate payload sourceVersion must remain bound to the accepted build identity",
  );
  run(process.execPath, [validationGatePath, "bind-package-payload", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--service", "web", "--manifest", path.join(candidateArtifactDirectory, "release-manifest.json"), "--archive", candidateArchivePath]);
  run(process.execPath, [validationGatePath, "finalize", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--target", "source-candidate", "--evidence-root", authoritativePackageEvidenceRoot, "--quiet"]);

  const danglingLink = path.join(packageStandalone, "node_modules", "dangling-fixture");
  fs.symlinkSync(path.join(packageCandidateRoot, "node_modules", "missing-package"), danglingLink, process.platform === "win32" ? "junction" : "dir");
  assert.match(runFailure(process.execPath, [packagerPath, "--root", packageCandidateRoot, "--service", "web", "--output", path.join(temporaryRoot, "dangling-output"), "--release-id", "fixture-dangling-r000001", "--commit", packageCommit, "--build-output-digest-receipt", packageDigestReceiptPath, "--allow-local-rehearsal", "1"], packageCandidateRoot).stderr, /cannot recompute build output digest|BUILD_OUTPUT/u);
  fs.rmSync(danglingLink, { recursive: true, force: true });
  const outsideDependency = path.join(temporaryRoot, "outside-linked-package");
  fs.mkdirSync(outsideDependency, { recursive: true });
  fs.writeFileSync(path.join(outsideDependency, "package.json"), `${JSON.stringify({ name: "escape", version: "1.0.0" })}\n`, "utf8");
  const escapeLink = path.join(packageStandalone, "node_modules", "escape-fixture");
  fs.symlinkSync(outsideDependency, escapeLink, process.platform === "win32" ? "junction" : "dir");
  assert.match(runFailure(process.execPath, [packagerPath, "--root", packageCandidateRoot, "--service", "web", "--output", path.join(temporaryRoot, "escape-output"), "--release-id", "fixture-escape-r000001", "--commit", packageCommit, "--build-output-digest-receipt", packageDigestReceiptPath, "--allow-local-rehearsal", "1"], packageCandidateRoot).stderr, /BUILD_OUTPUT_SYMLINK_ESCAPE|cannot recompute build output digest/u);
  fs.rmSync(escapeLink, { recursive: true, force: true });
  const sensitiveFixture = path.join(packageStandalone, "client-secret.json");
  fs.writeFileSync(sensitiveFixture, "{}\n", "utf8");
  const sensitiveDigestPath = path.join(temporaryRoot, "sensitive-build-output.json");
  run(process.execPath, [buildOutputDigestPath, "--root", packageCandidateRoot, "--service", "web", "--commit", packageCommit, "--source-version", "RTEST", "--receipt", sensitiveDigestPath], packageCandidateRoot);
  assert.match(runFailure(process.execPath, [packagerPath, "--root", packageCandidateRoot, "--service", "web", "--output", path.join(temporaryRoot, "sensitive-output"), "--release-id", "fixture-sensitive-r000001", "--commit", packageCommit, "--build-output-digest-receipt", sensitiveDigestPath, "--allow-local-rehearsal", "1"], packageCandidateRoot).stderr, /forbidden sensitive (?:artifact|materializable logical) path/u);
  fs.rmSync(sensitiveFixture, { force: true });

  const packageCandidateBundle = JSON.parse(fs.readFileSync(authoritativePackageBundlePath, "utf8"));
  const packageExternalRoot = path.join(packageCandidateRoot, ".external-browser-evidence");
  fs.mkdirSync(packageExternalRoot, { recursive: true });
  const packageExternalBundle = structuredClone(packageCandidateBundle);
  for (const entry of packageExternalBundle.attestations) {
    entry.status = "pending-required"; entry.executor = "unassigned"; entry.evidenceRef = null; entry.evidenceSha256 = null; entry.signatureRef = null; entry.signatureSha256 = null;
  }
  const packageEvidenceNow = Date.now();
  for (const [index, validationId] of browserValidationIds.entries()) {
    const evidenceRef = `${validationId}.json`;
    const evidencePath = path.join(packageExternalRoot, evidenceRef);
    const evidence = {
      schemaVersion: "zimeiti-release-browser-acceptance-evidence.v1",
      receiptId: `package-browser-${index}-1234567890`, nonce: `package_nonce_${index}_1234567890`, checkedAt: new Date(packageEvidenceNow - 1000).toISOString(),
      subject: { commit: packageCommit, sourceVersion: "RTEST", builds: packageCandidateBundle.subject.builds, buildOutputDigests: packageCandidateBundle.subject.buildOutputDigests, candidatePayloads: packageCandidateBundle.subject.candidatePayloads },
      runtimeReadbacks: { web: { commit: packageCommit, sourceVersion: "RTEST", buildId: packageBuildId, buildOutputDigest: packageDigestReceipt.outputDigest }, voice: null },
      viewport: { width: 1440, height: 900 }, preciseRoute: packageCandidateBundle.scope.browserAcceptance.preciseRoute,
      adjacentRoutes: packageCandidateBundle.scope.browserAcceptance.requiredRoutes.filter((route) => route !== packageCandidateBundle.scope.browserAcceptance.preciseRoute),
      consoleErrors: [], requestFailures: [], result: "passed",
    };
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(evidencePath, evidenceBytes);
    const signature = {
      schemaVersion: "zimeiti-release-browser-acceptance-signature.v1", algorithm: "Ed25519", issuerId: "fixture-browser", publicKeyFingerprint,
      receiptId: evidence.receiptId, nonce: evidence.nonce, issuedAt: new Date(packageEvidenceNow - 1000).toISOString(), expiresAt: new Date(packageEvidenceNow + 60_000).toISOString(),
      evidenceType: "release-browser-acceptance", targetSha256: sha256(evidenceBytes), subjectCommit: packageCommit, sourceVersion: "RTEST",
      webBuildId: packageBuildId, voiceBuildId: null, webOutputDigest: packageDigestReceipt.outputDigest, voiceOutputDigest: null,
    };
    signature.signature = crypto.sign(null, Buffer.from(canonicalJson(signature)), privateKey).toString("base64");
    fs.writeFileSync(`${evidencePath}.sig.json`, `${JSON.stringify(signature, null, 2)}\n`, "utf8");
    const entry = packageExternalBundle.attestations.find((candidate) => candidate.validationId === validationId);
    entry.status = "passed"; entry.executor = "external-browser"; entry.evidenceRef = evidenceRef; entry.evidenceSha256 = sha256(evidenceBytes);
    entry.signatureRef = `${evidenceRef}.sig.json`; entry.signatureSha256 = sha256(fs.readFileSync(`${evidencePath}.sig.json`));
  }
  packageExternalBundle.summary = {
    requiredCount: packageExternalBundle.attestations.length,
    passedCount: packageExternalBundle.attestations.filter((entry) => entry.status === "passed").length,
    pendingCount: packageExternalBundle.attestations.filter((entry) => entry.status === "pending-required").length,
    failedCount: packageExternalBundle.attestations.filter((entry) => entry.status === "failed").length,
  };
  packageExternalBundle.bundleId = recomputeBundleId(packageExternalBundle);
  const packageExternalBundlePath = path.join(packageCandidateRoot, ".external-browser-bundle.json");
  fs.writeFileSync(packageExternalBundlePath, `${JSON.stringify(packageExternalBundle, null, 2)}\n`, "utf8");
  run(process.execPath, [validationGatePath, "merge-external", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--external-bundle", ".external-browser-bundle.json", "--external-evidence-root", ".external-browser-evidence", "--evidence-root", authoritativePackageEvidenceRoot]);
  run(process.execPath, [validationGatePath, "promote-release-ready", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath]);
  run(process.execPath, [validationGatePath, "finalize", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--target", "release-ready", "--evidence-root", authoritativePackageEvidenceRoot, "--quiet"]);
  run(process.execPath, [validationGatePath, "verify-release-ready", "--root", packageCandidateRoot, "--bundle", authoritativePackageBundlePath, "--scope-receipt", packageScopePath, "--evidence-root", authoritativePackageEvidenceRoot]);

  const freshFinalizeRoot = path.join(temporaryRoot, "fresh-finalize-checkout");
  run("git", ["clone", "--quiet", "--no-local", packageCandidateRoot, freshFinalizeRoot], temporaryRoot);
  fs.mkdirSync(path.join(freshFinalizeRoot, "candidate-packages"), { recursive: true });
  const finalizeArchivePath = path.join(freshFinalizeRoot, "candidate-packages", path.basename(candidateArchivePath));
  const finalizeChecksumPath = `${finalizeArchivePath}.sha256`;
  fs.copyFileSync(candidateArchivePath, finalizeArchivePath);
  fs.copyFileSync(`${candidateArchivePath}.sha256`, finalizeChecksumPath);
  const packageReadyBundlePath = path.join(freshFinalizeRoot, "release-ready-bundle.json");
  fs.copyFileSync(authoritativePackageBundlePath, packageReadyBundlePath);
  const packageReadyBundle = JSON.parse(fs.readFileSync(packageReadyBundlePath, "utf8"));
  const freshScopePath = path.join(freshFinalizeRoot, "release-scope.json");
  fs.copyFileSync(packageScopePath, freshScopePath);
  const freshEvidenceRoot = path.join(freshFinalizeRoot, "release-evidence");
  fs.cpSync(authoritativePackageEvidenceRoot, freshEvidenceRoot, { recursive: true });
  fs.rmSync(packageCandidateRoot, { recursive: true, force: true });
  fs.rmSync(candidateArtifactDirectory, { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(freshFinalizeRoot, "node_modules")), false, "fresh finalize fixture must not contain node_modules");
  const officialArchivePath = path.join(freshFinalizeRoot, "official", "web-fixture.tar.gz");
  run(process.execPath, [packagerPath, "--root", freshFinalizeRoot, "--service", "web", "--finalize-candidate-archive", finalizeArchivePath, "--candidate-checksum", finalizeChecksumPath, "--validation-bundle", packageReadyBundlePath, "--scope-receipt", freshScopePath, "--evidence-root", freshEvidenceRoot, "--archive-path", officialArchivePath], freshFinalizeRoot);
  assert.equal(sha256(fs.readFileSync(officialArchivePath)), sha256(fs.readFileSync(finalizeArchivePath)), "official package must preserve exact candidate archive bytes");

  function signedAttackInputs(name, archivePath) {
    const attackRoot = path.join(freshFinalizeRoot, `attack-${name}`);
    const attackEvidenceRoot = path.join(attackRoot, "evidence");
    fs.mkdirSync(attackRoot, { recursive: true });
    fs.cpSync(freshEvidenceRoot, attackEvidenceRoot, { recursive: true });
    const attackBundle = structuredClone(packageReadyBundle);
    attackBundle.subject.candidatePayloads.web.archiveSha256 = sha256(fs.readFileSync(archivePath));
    for (const validationId of browserValidationIds) {
      const entry = attackBundle.attestations.find((candidate) => candidate.validationId === validationId);
      const evidencePath = path.join(attackEvidenceRoot, ...entry.evidenceRef.split("/"));
      const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      evidence.subject.candidatePayloads = attackBundle.subject.candidatePayloads;
      const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
      fs.writeFileSync(evidencePath, evidenceBytes);
      const signaturePath = path.join(attackEvidenceRoot, ...entry.signatureRef.split("/"));
      const signature = JSON.parse(fs.readFileSync(signaturePath, "utf8"));
      signature.targetSha256 = sha256(evidenceBytes);
      delete signature.signature;
      signature.signature = crypto.sign(null, Buffer.from(canonicalJson(signature)), privateKey).toString("base64");
      fs.writeFileSync(signaturePath, `${JSON.stringify(signature, null, 2)}\n`, "utf8");
      entry.evidenceSha256 = sha256(evidenceBytes);
      entry.signatureSha256 = sha256(fs.readFileSync(signaturePath));
    }
    attackBundle.bundleId = recomputeBundleId(attackBundle);
    const bundlePath = path.join(attackRoot, "bundle.json");
    fs.writeFileSync(bundlePath, `${JSON.stringify(attackBundle, null, 2)}\n`, "utf8");
    const checksumPath = `${archivePath}.${name}.sha256`;
    fs.writeFileSync(checksumPath, `${attackBundle.subject.candidatePayloads.web.archiveSha256}  ${path.basename(archivePath)}\n`, "utf8");
    return { attackRoot, attackEvidenceRoot, bundlePath, checksumPath };
  }

  function expectSignedArchiveAttack(name, archivePath, expected) {
    const attack = signedAttackInputs(name, archivePath);
    const result = runFailure(process.execPath, [packagerPath, "--root", freshFinalizeRoot, "--service", "web", "--finalize-candidate-archive", archivePath, "--candidate-checksum", attack.checksumPath, "--validation-bundle", attack.bundlePath, "--scope-receipt", freshScopePath, "--evidence-root", attack.attackEvidenceRoot, "--archive-path", path.join(attack.attackRoot, "official.tar.gz")], freshFinalizeRoot);
    assert.match(result.stderr, expected, `${name} attack must fail closed`);
  }

  for (const [name, relativePath] of [
    ["ads", "./runtime/file:ads"],
    ["reserved", "./runtime/CON.txt"],
    ["trailing-dot", "./runtime/file."],
  ]) {
    const archivePath = path.join(freshFinalizeRoot, `${name}.tar.gz`);
    writeMinimalTarGz(archivePath, [{ path: relativePath, body: "attack" }]);
    expectSignedArchiveAttack(name, archivePath, /candidate archive contains unsafe path/u);
  }
  const caseCollisionArchive = path.join(freshFinalizeRoot, "case-collision.tar.gz");
  writeMinimalTarGz(caseCollisionArchive, [{ path: "./runtime/Case.js", body: "A" }, { path: "./runtime/case.js", body: "B" }]);
  expectSignedArchiveAttack("case-collision", caseCollisionArchive, /case or Unicode-normalization path collision/u);
  const unicodeCollisionArchive = path.join(freshFinalizeRoot, "unicode-collision.tar.gz");
  writeMinimalTarGz(unicodeCollisionArchive, [{ path: "./runtime/caf\u00e9.js", body: "A" }, { path: "./runtime/cafe\u0301.js", body: "B" }]);
  expectSignedArchiveAttack("unicode-collision", unicodeCollisionArchive, /unsafe path|Unicode-normalization path collision/u);
  const linkArchive = path.join(freshFinalizeRoot, "link.tar.gz");
  writeMinimalTarGz(linkArchive, [{ path: "./runtime/link", type: "2", linkname: "../../outside" }]);
  expectSignedArchiveAttack("link", linkArchive, /candidate archive contains links/u);

  function archiveWithInjectedFile(name, relativePath, body, mutate) {
    const directory = path.join(freshFinalizeRoot, `injected-${name}`);
    fs.mkdirSync(directory, { recursive: true });
    run("tar", ["-xzf", finalizeArchivePath, "-C", directory], freshFinalizeRoot);
    const filePath = path.join(directory, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, body, "utf8");
    if (mutate) mutate(filePath, directory);
    const archivePath = path.join(freshFinalizeRoot, `injected-${name}.tar.gz`);
    run("tar", ["-czf", archivePath, "-C", directory, "."], freshFinalizeRoot);
    return archivePath;
  }
  expectSignedArchiveAttack("private-pem", archiveWithInjectedFile("private-pem", "runtime/private.pem", "not-a-real-key\n"), /key, certificate, or source-map file/u);
  const privateKeyPemMarker = ["-----BEGIN ", "PRIVATE ", "KEY-----"].join("");
  const privateKeyPemFooter = ["-----END ", "PRIVATE ", "KEY-----"].join("");
  const privateKeyPemBody = Buffer.concat([Buffer.from([0x30, 0x3e]), Buffer.alloc(62, 0x07)])
    .toString("base64")
    .match(/.{1,64}/gu)
    .join("\n");
  const privateKeyPemFixture = `${privateKeyPemMarker}\n${privateKeyPemBody}\n${privateKeyPemFooter}\n`;
  expectSignedArchiveAttack("pem-content", archiveWithInjectedFile("pem-content", "runtime/blob.bin", privateKeyPemFixture), /forbidden private-key PEM content/u);
  expectSignedArchiveAttack("git-metadata", archiveWithInjectedFile("git-metadata", ".git/config", "[core]\n"), /source-control, history, or cache(?: metadata)? path/u);
  const modeDirectory = path.join(freshFinalizeRoot, "mode-tamper-tree");
  fs.mkdirSync(modeDirectory, { recursive: true });
  run("tar", ["-xzf", finalizeArchivePath, "-C", modeDirectory], freshFinalizeRoot);
  const modeArchive = path.join(freshFinalizeRoot, "mode-tamper.tar.gz");
  const expectedServerMode = JSON.parse(fs.readFileSync(path.join(modeDirectory, "release-manifest.json"), "utf8")).files.find((entry) => entry.path === "server.js").mode;
  rewriteTarEntryMode(finalizeArchivePath, modeArchive, "server.js", expectedServerMode === 0o444 ? 0o755 : 0o444);
  expectSignedArchiveAttack("mode", modeArchive, /CANDIDATE_PAYLOAD_INVENTORY_MISMATCH/u);

  const corruptedArchivePath = path.join(freshFinalizeRoot, "corrupted.tar.gz");
  fs.copyFileSync(finalizeArchivePath, corruptedArchivePath);
  fs.appendFileSync(corruptedArchivePath, "tamper", "utf8");
  assert.match(runFailure(process.execPath, [packagerPath, "--root", freshFinalizeRoot, "--service", "web", "--finalize-candidate-archive", corruptedArchivePath, "--candidate-checksum", finalizeChecksumPath, "--validation-bundle", packageReadyBundlePath, "--scope-receipt", freshScopePath, "--evidence-root", freshEvidenceRoot, "--archive-path", path.join(freshFinalizeRoot, "official", "corrupt.tar.gz")], freshFinalizeRoot).stderr, /candidate archive checksum mismatch/u);
  const tamperExtractRoot = path.join(freshFinalizeRoot, "tamper-extract");
  fs.mkdirSync(tamperExtractRoot, { recursive: true });
  run("tar", ["-xzf", finalizeArchivePath, "-C", tamperExtractRoot], freshFinalizeRoot);
  const forgedDependencyPath = path.join(tamperExtractRoot, "node_modules", "next", "index.js");
  fs.writeFileSync(forgedDependencyPath, "module.exports = 'tampered dependency';\n", "utf8");
  const forgedManifestPath = path.join(tamperExtractRoot, "release-manifest.json");
  const forgedManifest = JSON.parse(fs.readFileSync(forgedManifestPath, "utf8"));
  const forgedEntry = forgedManifest.files.find((entry) => entry.path === "node_modules/next/index.js");
  forgedEntry.bytes = fs.statSync(forgedDependencyPath).size;
  forgedEntry.mode = fs.statSync(forgedDependencyPath).mode & 0o777;
  forgedEntry.sha256 = sha256(fs.readFileSync(forgedDependencyPath));
  forgedManifest.totalBytes = forgedManifest.files.filter((entry) => entry.kind === "file").reduce((sum, entry) => sum + entry.bytes, 0);
  forgedManifest.artifactDigest = sha256(canonicalJson(forgedManifest.files));
  fs.writeFileSync(forgedManifestPath, `${JSON.stringify(forgedManifest, null, 2)}\n`, "utf8");
  const internallyTamperedArchive = path.join(freshFinalizeRoot, "internally-tampered.tar.gz");
  run("tar", ["-czf", internallyTamperedArchive, "-C", tamperExtractRoot, "."], freshFinalizeRoot);
  const internallyTamperedChecksum = `${internallyTamperedArchive}.sha256`;
  const internallyTamperedSha = sha256(fs.readFileSync(internallyTamperedArchive));
  fs.writeFileSync(internallyTamperedChecksum, `${internallyTamperedSha}  ${path.basename(internallyTamperedArchive)}\n`, "utf8");
  const internallyTamperedBundle = structuredClone(packageReadyBundle);
  internallyTamperedBundle.subject.candidatePayloads.web.archiveSha256 = internallyTamperedSha;
  internallyTamperedBundle.subject.candidatePayloads.web.artifactDigest = forgedManifest.artifactDigest;
  internallyTamperedBundle.subject.candidatePayloads.web.totalBytes = forgedManifest.totalBytes;
  internallyTamperedBundle.bundleId = recomputeBundleId(internallyTamperedBundle);
  const internallyTamperedBundlePath = path.join(freshFinalizeRoot, "internally-tampered-bundle.json");
  fs.writeFileSync(internallyTamperedBundlePath, `${JSON.stringify(internallyTamperedBundle, null, 2)}\n`, "utf8");
  assert.match(runFailure(process.execPath, [packagerPath, "--root", freshFinalizeRoot, "--service", "web", "--finalize-candidate-archive", internallyTamperedArchive, "--candidate-checksum", internallyTamperedChecksum, "--validation-bundle", internallyTamperedBundlePath, "--scope-receipt", freshScopePath, "--evidence-root", freshEvidenceRoot, "--archive-path", path.join(freshFinalizeRoot, "official", "internal-tamper.tar.gz")], freshFinalizeRoot).stderr, /authoritative release-ready gate rejected candidate/u);

  assert.match(runFailure(process.execPath, [
    validationGatePath, "promote-release-ready",
    "--root", root,
    "--bundle", releaseBundlePath,
  ]).stderr, /RELEASE_BROWSER_ROUTES_UNRESOLVED/u);

  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  assert.equal(policy.unknownBehavior, "FULL");
  assert.equal(policy.classificationConflictBehavior, "FULL");
  assert.deepEqual(policy.fullOnChangeStatuses, ["D", "R", "C", "T", "U", "X", "B", "?"]);
  assert.deepEqual(
    policy.browserAcceptance.routeRules.find((rule) => rule.id === "voice-surface")?.routes,
    ["/voice-studio/workspace", "/", "/tools"],
    "voice acceptance must use the live canonical workspace instead of the retired /voice route",
  );
  const pinnedTrustPath = path.join(root, ...policy.browserAcceptanceTrust.path.split("/"));
  assert.equal(sha256(fs.readFileSync(pinnedTrustPath)), policy.browserAcceptanceTrust.sha256, "reviewed issuer allowlist hash pin must match exact bytes");
  const productionTrust = JSON.parse(fs.readFileSync(pinnedTrustPath, "utf8"));
  assert.equal(productionTrust.trustRoot.custody, "external-controlled");
  assert.equal(productionTrust.trustRoot.keyMaterial, "public-only");
  assert.ok(productionTrust.issuers.every((issuer) => !/PRIVATE KEY/u.test(issuer.publicKeyPem)), "production trust must never contain private keys");

  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert.equal(schema.properties.schemaVersion.const, "zimeiti-release-change-scope-receipt.v1");
  for (const field of ["receiptId", "classification", "reasons", "changedFiles", "requiredValidations", "gate"]) {
    assert.ok(schema.required.includes(field), `receipt schema missing required field: ${field}`);
  }
  const validationSchema = JSON.parse(fs.readFileSync(validationSchemaPath, "utf8"));
  assert.equal(validationSchema.properties.schemaVersion.const, "zimeiti-release-change-validation-bundle.v1");
  assert.ok(validationSchema.required.includes("attestations"));

  const workflow = fs.readFileSync(workflowPath, "utf8");
  const browserAcceptanceWorkflow = fs.readFileSync(browserAcceptanceWorkflowPath, "utf8");
  const browserAcceptanceRunner = fs.readFileSync(browserAcceptanceRunnerPath, "utf8");
  for (const marker of [
    "Classify, diff-check, and scan the exact candidate range",
    "scripts/classify-release-change-scope.mjs",
    "verify-release-secret-exposure.mjs",
    "Build once, hash actual outputs, and bind the digest",
    "compute-release-build-output-digest.mjs",
    "Restore candidate, verify digest, and merge signed evidence",
    "Package the same verified output without rebuilding",
    "release_base_sha",
    "candidate_run_id",
    "acceptance_run_id",
    "acceptance_routes_json",
    "source-candidate",
    "release-ready",
    "release-change-validation-gate.mjs promote-release-ready",
    "release-change-validation-gate.mjs finalize",
    "release-browser-acceptance-${{ github.sha }}",
    "candidatePayloads",
  ]) {
    assert.ok(workflow.includes(marker), `workflow integration missing: ${marker}`);
  }
  assert.doesNotMatch(workflow, /^\s+push:/mu, "release workflow must not be tag-triggered");
  assert.doesNotMatch(workflow, /^\s+tags:/mu, "tags must not be a release entrypoint");
  assert.match(workflow, /git merge-base --is-ancestor "\$base_sha" "\$head_sha"/u, "manual release base must be a real ancestor");
  assert.doesNotMatch(workflow, /acceptance_trusted_issuers_path/u, "dispatcher must not replace issuer trust");
  assert.equal((workflow.match(/release:vnext:build:/gu) || []).length, 1, "workflow must have one build loop and no package-job rebuild");
  assert.ok(workflow.indexOf("release:vnext:build:") < workflow.indexOf("package-standalone-artifact.mjs"), "accepted build must be packaged after identity binding");
  assert.match(workflow, /bind-identity --bundle[^\n]+--service "\$service"[^\n]+--build-output-digest-receipt/u);
  assert.match(workflow, /bind-package-payload --bundle/u);
  assert.match(workflow, /--finalize-candidate-archive/u);
  assert.match(workflow, /--finalize-candidate-archive "\$candidate_archive"[^\n]+--scope-receipt "\$RELEASE_SCOPE_RECEIPT"[^\n]+--evidence-root "\$RELEASE_VALIDATION_EVIDENCE"/u);
  assert.match(fs.readFileSync(packagerPath, "utf8"), /"verify-release-ready"[\s\S]+"--scope-receipt", scopeReceiptPath[\s\S]+"--evidence-root", evidenceRoot/u);
  assert.doesNotMatch(workflow, /tar -xzf "\$RUNNER_TEMP\/candidate\/release-candidate-build/u);
  for (const marker of [
    "name: Release browser acceptance evidence",
    "release-candidate-${{ steps.candidate.outputs.sha }}",
    "run-release-browser-acceptance.mjs",
    "RELEASE_BROWSER_ACCEPTANCE_ED25519_PRIVATE_KEY",
    "release-change-validation-gate.mjs verify-release-ready",
    "release-browser-acceptance-${{ github.sha }}",
  ]) assert.ok(browserAcceptanceWorkflow.includes(marker), `browser acceptance workflow integration missing: ${marker}`);
  assert.doesNotMatch(browserAcceptanceWorkflow, /\b(?:ssh|scp|rsync)\b|deploy-artifact-vnext|DEPLOY_EXECUTION_APPROVED/u);
  for (const marker of [
    "CANDIDATE_PAYLOAD_INVENTORY_MISMATCH",
    "DEDICATED_DATA_MOUNT_REQUIRED",
    "BROWSER_SIGNING_KEY_NOT_TRUSTED",
    "desktop-precise-route-visual-1440x900",
    "desktop-two-adjacent-pages-visual",
    "console-and-request-errors",
    "full-desktop-release-checklist",
  ]) assert.ok(browserAcceptanceRunner.includes(marker), `browser acceptance runner integration missing: ${marker}`);
  assert.equal(spawnSync(process.execPath, ["--check", browserAcceptanceRunnerPath], { encoding: "utf8" }).status, 0,
    "browser acceptance runner syntax must be valid");
  run(process.execPath, [path.join(root, "scripts", "verify-release-workflow.mjs"), "--workflow-contract-only"]);

  process.stdout.write(JSON.stringify({
    verifier: "release-change-scope-zero-network",
    status: "passed",
    scenarios: scenarioIndex,
    networkCalls: 0,
  }, null, 2) + "\n");
} finally {
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolvedTemporaryRoot), resolvedSystemTemp, "refusing to clean outside the system temp directory");
  assert.match(path.basename(resolvedTemporaryRoot), /^release-change-scope-/u, "refusing to clean an unexpected temp directory");
  fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  const resolvedRepositoryTemporaryRoot = path.resolve(repositoryTemporaryRoot);
  assert.equal(path.dirname(resolvedRepositoryTemporaryRoot), path.resolve(repositoryTemporaryParent), "refusing to clean outside repository temp");
  assert.match(path.basename(resolvedRepositoryTemporaryRoot), /^release-change-scope-/u, "refusing to clean an unexpected repository temp directory");
  fs.rmSync(resolvedRepositoryTemporaryRoot, { recursive: true, force: true });
}
