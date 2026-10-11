#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
const policy = JSON.parse(read("deploy/policies/release-policy.json"));
const releaseWorkflowSource = read("scripts/release-workflow.mjs");
const ciWorkflow = read(".github/workflows/release-vnext.yml");
const browserAcceptanceWorkflow = read(".github/workflows/release-browser-acceptance.yml");

function verifyReleaseVnextWorkflowContract() {
  assert.match(ciWorkflow, /node-version:\s*"24\.19\.0"/u);
  assert.match(ciWorkflow, /PUPPETEER_SKIP_DOWNLOAD:\s*"true"/u);
  assert.match(ciWorkflow, /Install, verify, and audit source candidate[\s\S]*?NODE_OPTIONS:\s*"--max-old-space-size=8192"[\s\S]*?pnpm run validate/u,
    "source candidate validation must retain the audited Node heap ceiling");
  assert.match(ciWorkflow, /Build once, hash actual outputs, and bind the digest[\s\S]*?NODE_OPTIONS:\s*"--max-old-space-size=8192"[\s\S]*?release:vnext:build:/u,
    "candidate builds must retain the audited Node heap ceiling");
  assert.match(ciWorkflow, /git diff --check "\$RELEASE_BASE_SHA\.\.\.\$RELEASE_HEAD_SHA"/u, "PR merge-base diff-check must use the resolved trusted range");
  assert.match(ciWorkflow, /git diff --check "\$RELEASE_BASE_SHA\.\.\$RELEASE_HEAD_SHA"/u, "manual direct diff-check must use the trusted release range");
  assert.match(ciWorkflow, /sha256sum -c/u, "CI must verify the packager-owned checksum");
  assert.doesNotMatch(ciWorkflow, /sha256sum[^\n]*>[^\n]*checksum/u, "CI must never overwrite the packager-owned checksum");
  assert.match(ciWorkflow, /package-standalone-artifact\.mjs[^\n]+--archive/u);
  assert.match(ciWorkflow, /\(cd voice-platform && pnpm --ignore-workspace install --frozen-lockfile\)/u,
    "Voice dependencies must be installed in an explicit isolated subshell");
  assert.match(ciWorkflow, /init --scope-receipt[^\n]+--target source-candidate/u);
  assert.match(ciWorkflow, /finalize --bundle[^\n]+--target source-candidate/u);
  assert.match(ciWorkflow, /merge-external --bundle "\$RELEASE_VALIDATION_BUNDLE"/u);
  assert.match(ciWorkflow, /promote-release-ready --bundle "\$RELEASE_VALIDATION_BUNDLE"/u);
  assert.match(ciWorkflow, /finalize --bundle "\$RELEASE_VALIDATION_BUNDLE" --target release-ready/u);
  const mergeIndex = ciWorkflow.indexOf("merge-external --bundle");
  const promoteIndex = ciWorkflow.indexOf("promote-release-ready --bundle");
  const readyIndex = ciWorkflow.indexOf("--target release-ready");
  const packageIndex = ciWorkflow.indexOf("--finalize-candidate-archive");
  assert.ok(mergeIndex > 0 && mergeIndex < promoteIndex && promoteIndex < readyIndex && readyIndex < packageIndex,
    "one staged bundle must merge evidence, promote, finalize, then package without rebuilding");
  assert.equal((ciWorkflow.match(/release:vnext:build:/gu) || []).length, 1, "workflow must build once and never rebuild during finalization");
  assert.doesNotMatch(ciWorkflow, /^\s+push:/mu, "release workflow must not be tag-triggered");
  assert.doesNotMatch(ciWorkflow, /^\s+tags:/mu, "tags must not be a release entrypoint");
  assert.match(ciWorkflow, /git merge-base --is-ancestor "\$base_sha" "\$head_sha"/u, "manual release base must be a real ancestor");
  assert.doesNotMatch(ciWorkflow, /acceptance_trusted_issuers_path/u, "dispatcher must not replace issuer trust");
  assert.match(ciWorkflow, /bind-identity --bundle[^\n]+--service "\$service"[^\n]+--build-output-digest-receipt/u);
  assert.match(ciWorkflow, /bind-package-payload --bundle "\$RELEASE_VALIDATION_BUNDLE"/u);
  assert.match(ciWorkflow, /--finalize-candidate-archive "\$candidate_archive"/u);
  assert.match(ciWorkflow, /--finalize-candidate-archive "\$candidate_archive"[^\n]+--scope-receipt "\$RELEASE_SCOPE_RECEIPT"[^\n]+--evidence-root "\$RELEASE_VALIDATION_EVIDENCE"/u,
    "fresh finalizer must rerun the authoritative gate against scope and signed evidence");
  assert.match(read("scripts/package-standalone-artifact.mjs"), /"verify-release-ready"[\s\S]+"--scope-receipt", scopeReceiptPath[\s\S]+"--evidence-root", evidenceRoot/u,
    "formal packager must invoke the authoritative release-ready verifier");
  assert.doesNotMatch(ciWorkflow, /tar -xzf "\$RUNNER_TEMP\/candidate\/release-candidate-build/u,
    "finalize must consume the already-materialized package instead of restoring build output");
  const finalizeSection = ciWorkflow.slice(ciWorkflow.indexOf("Validate candidate and browser-evidence run provenance"));
  assert.doesNotMatch(finalizeSection, /pnpm (?:install|run "?release:vnext:build)|compute-release-build-output-digest\.mjs/u,
    "fresh finalize must not install dependencies, rebuild, or regenerate output digests");

  assert.match(browserAcceptanceWorkflow, /^name: Release browser acceptance evidence$/mu);
  assert.match(browserAcceptanceWorkflow, /^\s+workflow_dispatch:/mu);
  assert.match(browserAcceptanceWorkflow, /^\s+candidate_run_id:/mu);
  assert.match(browserAcceptanceWorkflow, /git merge-base --is-ancestor "\$candidate_sha" "\$GITHUB_SHA"/u);
  assert.match(browserAcceptanceWorkflow, /candidate reuse rejected because runtime source changed/u);
  assert.match(browserAcceptanceWorkflow, /name: release-candidate-\$\{\{ steps\.candidate\.outputs\.sha \}\}/u);
  assert.match(browserAcceptanceWorkflow, /run-id: \$\{\{ inputs\.candidate_run_id \}\}/u);
  assert.doesNotMatch(browserAcceptanceWorkflow, /^\s{6}(?:PLAYWRIGHT_BROWSERS_PATH|DATA_IMAGE):[^\n]*\$\{\{ runner\.temp \}\}/mu,
    "runner context is unavailable while job-level env is evaluated");
  assert.match(browserAcceptanceWorkflow, /Resolve runner-scoped temporary paths[\s\S]*PLAYWRIGHT_BROWSERS_PATH=\$RUNNER_TEMP\/ms-playwright[\s\S]*DATA_IMAGE=\$RUNNER_TEMP\/release-browser-acceptance-data-/u,
    "runner-scoped paths must be exported only after the runner starts");
  assert.match(browserAcceptanceWorkflow, /playwright install --with-deps chromium/u);
  assert.match(browserAcceptanceWorkflow, /stat -c '%d' \/data/u);
  assert.match(browserAcceptanceWorkflow, /run-release-browser-acceptance\.mjs/u);
  assert.match(browserAcceptanceWorkflow, /RELEASE_BROWSER_ACCEPTANCE_ED25519_PRIVATE_KEY: \$\{\{ secrets\.RELEASE_BROWSER_ACCEPTANCE_ED25519_PRIVATE_KEY \}\}/u);
  assert.match(browserAcceptanceWorkflow, /release-change-validation-gate\.mjs verify-release-ready/u);
  assert.match(browserAcceptanceWorkflow, /name: release-browser-acceptance-\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(browserAcceptanceWorkflow, /\b(?:ssh|scp|rsync)\b|deploy-artifact-vnext|production\.env|DEPLOY_EXECUTION_APPROVED/u,
    "browser acceptance must remain an isolated build-only workflow and never connect to production");
  assert.match(ciWorkflow, /RELEASE_TOOLCHAIN_SHA=\$toolchain_sha/u);
  assert.match(ciWorkflow, /candidate finalization rejected because runtime source changed/u);
  assert.match(ciWorkflow, /name: release-candidate-\$\{\{ steps\.resolve\.outputs\.subject_sha \}\}/u);
  assert.match(ciWorkflow, /b\.subject\.commit!==process\.env\.RELEASE_HEAD_SHA/u,
    "finalize must bind the downloaded candidate bundle to the immutable subject commit");
}

verifyReleaseVnextWorkflowContract();
if (process.argv.includes("--workflow-contract-only")) {
  process.stdout.write("PASS release-vnext staged workflow contract\n");
  process.exit(0);
}

for (const marker of [
  "inspectMigrationWorktree",
  "historical migration changed relative to audit base; restore it and use a new forward-only migration",
  "historicalMigrationMutationAllowed: false",
  "relocatedHistoricalRollbacks",
  "consumedRelocationReceipts",
  "verifiedCommittedRelocationReceipts",
  "validatePhysicalPath",
  "readStableRegularFile",
  "git-range-candidate",
  "legacy rollback relocation rejected",
  "newForwardMigrations",
]) assert.ok(releaseWorkflowSource.includes(marker), `release workflow migration immutability gate missing: ${marker}`);

assert.deepEqual(policy.database.legacyRollbackRelocationAudit, {
  schemaVersion: 1,
  requireExplicitCandidateRange: true,
  candidateMode: "git-tree-and-blob-only",
  dirtyMode: "head-index-worktree-bound",
  receiptBinding: "base-head-policy-sha256-old-new-git-blob",
}, "legacy rollback relocation audit policy must remain fail-closed and explicit");

const expectedLegacyRollbackRelocations = [
  {
    from: "supabase/migrations/rollback/20261001221000_super_admin_governance.rollback.sql",
    to: "supabase/rollbacks/20261001221000_super_admin_governance.rollback.sql",
    sha256: "23d2cec78ffa7c27845fd2cc7a6eef061ae37c73baefcf4b66f7ffdd7a057b35",
  },
  {
    from: "supabase/migrations/rollback/20261001224000_existing_member_admin_promotion.rollback.sql",
    to: "supabase/rollbacks/20261001224000_existing_member_admin_promotion.rollback.sql",
    sha256: "d3925f35c472830af4148b30cd36213a6136cdd6f581cb273407d3328a4789e8",
  },
];
assert.deepEqual(
  policy.database.legacyRollbackRelocations,
  expectedLegacyRollbackRelocations,
  "legacy rollback relocation receipts must remain exact and reviewable",
);

const releaseWorkflowPath = path.join(root, "scripts", "release-workflow.mjs");
const relocationChecks = [];
const fixturePrefix = path.join(os.tmpdir(), "zimeiti-release-migration-relocation-");

function writeFixtureFile(fixtureRoot, relativePath, bytes) {
  const target = path.join(fixtureRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function fixtureGit(fixtureRoot, arguments_) {
  const result = spawnSync("git", arguments_, { cwd: fixtureRoot, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `fixture git ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function createRelocationFixture({ includeUnlistedLegacy = false, includePreexistingTarget = false } = {}) {
  const fixtureRoot = fs.mkdtempSync(fixturePrefix);
  const name = "20260101010101_legacy_guard.rollback.sql";
  const from = `supabase/migrations/rollback/${name}`;
  const to = `supabase/rollbacks/${name}`;
  const rollbackBytes = Buffer.from("BEGIN;\nSELECT 1;\nCOMMIT;\n", "utf8");
  const sha256 = crypto.createHash("sha256").update(rollbackBytes).digest("hex");
  const policyDocument = {
    schemaVersion: 1,
    projectId: "migration-relocation-fixture",
    source: { excludeGlobs: [], excludeDirectoryNames: [], excludeFileNames: [], publicSourcePaths: [] },
    assets: { root: "public", externalRoots: [], forbiddenPublicRoots: [], forbiddenCuratedJsonMarkers: [] },
    runtime: { mutablePaths: [], secretPaths: [] },
    database: {
      migrationRoot: "supabase/migrations",
      rollbackRoot: "supabase/rollbacks",
      legacyRollbackRelocationAudit: {
        schemaVersion: 1,
        requireExplicitCandidateRange: true,
        candidateMode: "git-tree-and-blob-only",
        dirtyMode: "head-index-worktree-bound",
        receiptBinding: "base-head-policy-sha256-old-new-git-blob",
      },
      legacyRollbackRelocations: [{ from, to, sha256 }],
    },
  };
  writeFixtureFile(fixtureRoot, from, rollbackBytes);
  if (includePreexistingTarget) writeFixtureFile(fixtureRoot, to, rollbackBytes);
  writeFixtureFile(fixtureRoot, "supabase/migrations/20260101000000_forward.sql", "BEGIN;\nSELECT 2;\nCOMMIT;\n");
  if (includeUnlistedLegacy) {
    writeFixtureFile(
      fixtureRoot,
      "supabase/migrations/legacy/20260101010102_unlisted.rollback.sql",
      "BEGIN;\nSELECT 3;\nCOMMIT;\n",
    );
  }
  writeFixtureFile(fixtureRoot, "release-policy.json", `${JSON.stringify(policyDocument, null, 2)}\n`);
  fixtureGit(fixtureRoot, ["init", "--quiet", "--initial-branch=main"]);
  fixtureGit(fixtureRoot, ["-c", "core.autocrlf=false", "add", "--all"]);
  fixtureGit(fixtureRoot, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "baseline"]);
  const baseline = fixtureGit(fixtureRoot, ["rev-parse", "HEAD"]).trim();
  fs.rmSync(path.join(fixtureRoot, ...from.split("/")));
  writeFixtureFile(fixtureRoot, to, rollbackBytes);
  return { fixtureRoot, from, to, name, rollbackBytes, sha256, policyDocument, baseline, cleanupPaths: [] };
}

function runRelocationAudit(fixtureRoot, { base, head } = {}) {
  const rangeArguments = base && head ? ["--base", base, "--head", head] : [];
  const childEnvironment = { ...process.env };
  delete childEnvironment.RELEASE_BASE_SHA;
  delete childEnvironment.RELEASE_HEAD_SHA;
  const result = spawnSync(process.execPath, [
    releaseWorkflowPath,
    "migration-audit",
    "--root", fixtureRoot,
    "--policy", "release-policy.json",
    ...rangeArguments,
  ], {
    cwd: fixtureRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: childEnvironment,
  });
  assert.ok([0, 1].includes(result.status), `migration audit crashed: ${result.stderr || result.stdout}`);
  assert.ok(result.stdout.trim(), `migration audit emitted no JSON: ${result.stderr}`);
  return { exitCode: result.status, report: JSON.parse(result.stdout) };
}

function commitFixture(fixture, message = "candidate") {
  fixtureGit(fixture.fixtureRoot, ["-c", "core.autocrlf=false", "add", "--all"]);
  fixtureGit(fixture.fixtureRoot, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
  return fixtureGit(fixture.fixtureRoot, ["rev-parse", "HEAD"]).trim();
}

function withRelocationFixture(name, mutate, verify, options) {
  const fixture = createRelocationFixture(options);
  try {
    mutate?.(fixture);
    const result = runRelocationAudit(fixture.fixtureRoot);
    verify(result, fixture);
    relocationChecks.push(name);
  } finally {
    const resolved = path.resolve(fixture.fixtureRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "fixture cleanup escaped the OS temp root");
    fs.rmSync(resolved, { recursive: true, force: true });
    for (const cleanupPath of fixture.cleanupPaths) {
      const resolvedCleanup = path.resolve(cleanupPath);
      assert.ok(resolvedCleanup.startsWith(path.resolve(os.tmpdir())), "fixture auxiliary cleanup escaped the OS temp root");
      fs.rmSync(resolvedCleanup, { recursive: true, force: true });
    }
  }
}

function withCleanCandidateFixture(name, mutate, verify, options) {
  const fixture = createRelocationFixture(options);
  try {
    mutate?.(fixture);
    const candidateHead = commitFixture(fixture, name);
    const result = runRelocationAudit(fixture.fixtureRoot, { base: fixture.baseline, head: candidateHead });
    verify(result, { ...fixture, candidateHead });
    relocationChecks.push(name);
  } finally {
    const resolved = path.resolve(fixture.fixtureRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "fixture cleanup escaped the OS temp root");
    fs.rmSync(resolved, { recursive: true, force: true });
    for (const cleanupPath of fixture.cleanupPaths) {
      const resolvedCleanup = path.resolve(cleanupPath);
      assert.ok(resolvedCleanup.startsWith(path.resolve(os.tmpdir())), "fixture auxiliary cleanup escaped the OS temp root");
      fs.rmSync(resolvedCleanup, { recursive: true, force: true });
    }
  }
}

const expectRelocationFailure = (pattern) => ({ exitCode, report }) => {
  assert.equal(exitCode, 1);
  assert.equal(report.status, "FAIL");
  assert.match(report.failures.join("\n"), pattern);
};

withRelocationFixture("byte-identical allowlisted relocation passes", null, ({ exitCode, report }, fixture) => {
  assert.equal(exitCode, 0);
  assert.equal(report.status, "PASS");
  assert.deepEqual(report.migrationSource.deletedHistoricalMigrations, []);
  assert.deepEqual(report.migrationSource.invalidMigrationRootEntries, []);
  assert.equal(report.migrationSource.relocatedHistoricalRollbacks.length, 1);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.migrationSource.relocatedHistoricalRollbacks[0])
      .filter(([key]) => ["from", "to", "sha256", "bytes"].includes(key))),
    { from: fixture.from, to: fixture.to, sha256: fixture.sha256, bytes: fixture.rollbackBytes.length },
  );
});
withRelocationFixture("tampered target fails closed", (fixture) => {
  fs.appendFileSync(path.join(fixture.fixtureRoot, ...fixture.to.split("/")), "-- tampered\n");
}, expectRelocationFailure(/target sha256|bytes differ/u));
withRelocationFixture("missing target fails closed", (fixture) => {
  fs.rmSync(path.join(fixture.fixtureRoot, ...fixture.to.split("/")));
}, expectRelocationFailure(/target is missing/u));
withRelocationFixture("wrong target root fails closed", (fixture) => {
  fixture.policyDocument.database.legacyRollbackRelocations[0].to = `supabase/not-rollbacks/${fixture.name}`;
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/policy entry 0 is invalid/u));
withRelocationFixture("wrong source root fails closed", (fixture) => {
  fixture.policyDocument.database.legacyRollbackRelocations[0].from = `supabase/not-migrations/rollback/${fixture.name}`;
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/policy entry 0 is invalid/u));
withRelocationFixture("path traversal fails closed", (fixture) => {
  fixture.policyDocument.database.legacyRollbackRelocations[0].to = `supabase/rollbacks/../rollbacks/${fixture.name}`;
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/policy entry 0 is invalid/u));
withRelocationFixture("different target basename fails closed", (fixture) => {
  fixture.policyDocument.database.legacyRollbackRelocations[0].to = "supabase/rollbacks/20260101010101_different.rollback.sql";
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/policy entry 0 is invalid/u));
withRelocationFixture("policy hash drift fails closed", (fixture) => {
  fixture.policyDocument.database.legacyRollbackRelocations[0].sha256 = "0".repeat(64);
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/target sha256|base source blob sha256/u));
withRelocationFixture("audit-base source blob hash remains authoritative", (fixture) => {
  const replacement = Buffer.from("BEGIN;\nSELECT 8;\nCOMMIT;\n", "utf8");
  writeFixtureFile(fixture.fixtureRoot, fixture.to, replacement);
  fixture.policyDocument.database.legacyRollbackRelocations[0].sha256 = crypto.createHash("sha256").update(replacement).digest("hex");
  writeFixtureFile(fixture.fixtureRoot, "release-policy.json", `${JSON.stringify(fixture.policyDocument, null, 2)}\n`);
}, expectRelocationFailure(/base source blob sha256|bytes differ/u));
withRelocationFixture("symlink target fails closed", (fixture) => {
  const target = path.join(fixture.fixtureRoot, ...fixture.to.split("/"));
  const backing = path.join(path.dirname(target), "backing.rollback.sql");
  fs.renameSync(target, backing);
  fs.symlinkSync(path.basename(backing), target, "file");
}, expectRelocationFailure(/not a single-link regular file|symlink, junction, or reparse point/u));
withRelocationFixture("unknown nested SQL fails closed", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, "supabase/migrations/nested/20260101010103_unknown.sql", "SELECT 4;\n");
}, expectRelocationFailure(/non-canonical or nested SQL entry/u));
withRelocationFixture("historical top-level forward modification fails closed", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, "supabase/migrations/20260101000000_forward.sql", "BEGIN;\nSELECT 9;\nCOMMIT;\n");
}, expectRelocationFailure(/historical migration changed relative to audit base/u));
withRelocationFixture("historical top-level forward deletion fails closed", (fixture) => {
  fs.rmSync(path.join(fixture.fixtureRoot, "supabase", "migrations", "20260101000000_forward.sql"));
}, expectRelocationFailure(/historical migration deleted relative to audit base/u));
withRelocationFixture("unallowlisted historical nested SQL deletion fails closed", (fixture) => {
  fs.rmSync(path.join(fixture.fixtureRoot, "supabase", "migrations", "legacy", "20260101010102_unlisted.rollback.sql"));
}, expectRelocationFailure(/historical migration deleted relative to audit base/u), { includeUnlistedLegacy: true });
withRelocationFixture("index and worktree candidate divergence fails closed", (fixture) => {
  fs.appendFileSync(path.join(fixture.fixtureRoot, ...fixture.to.split("/")), "-- staged tamper\n");
  fixtureGit(fixture.fixtureRoot, ["-c", "core.autocrlf=false", "add", "--all"]);
  writeFixtureFile(fixture.fixtureRoot, fixture.to, fixture.rollbackBytes);
}, expectRelocationFailure(/index\/worktree candidate mismatch/u));
withRelocationFixture("gitignored nested SQL is still rejected by filesystem traversal", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, ".gitignore", "supabase/migrations/ignored/\n");
  writeFixtureFile(fixture.fixtureRoot, "supabase/migrations/ignored/20260101010104_hidden.sql", "SELECT 10;\n");
}, expectRelocationFailure(/non-canonical or nested SQL entry/u));
withRelocationFixture("gitignored relocation target is not a consumable candidate", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, ".gitignore", "supabase/rollbacks/\n");
}, expectRelocationFailure(/target is not Git-visible/u));
withRelocationFixture("supabase ancestor junction to an external tree fails closed", (fixture) => {
  const externalContainer = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-release-external-supabase-"));
  const externalSupabase = path.join(externalContainer, "supabase");
  const fixtureSupabase = path.join(fixture.fixtureRoot, "supabase");
  fs.renameSync(fixtureSupabase, externalSupabase);
  fs.symlinkSync(externalSupabase, fixtureSupabase, process.platform === "win32" ? "junction" : "dir");
  fixture.cleanupPaths.push(externalContainer);
}, ({ exitCode, report }) => {
  assert.equal(exitCode, 1, JSON.stringify(report, null, 2));
  assert.match(report.failures.join("\n"), /symlink, junction, or reparse point|junction, mount, or reparse redirect/u);
});
withRelocationFixture("hard-linked relocation target fails stable file identity gate", (fixture) => {
  fs.linkSync(
    path.join(fixture.fixtureRoot, ...fixture.to.split("/")),
    path.join(fixture.fixtureRoot, "supabase", "rollbacks", "hardlink.rollback.sql"),
  );
}, expectRelocationFailure(/single-link regular file/u));

withCleanCandidateFixture("clean Git range relocation consumes a base-head-policy-blob-bound receipt", null, ({ exitCode, report }, fixture) => {
  assert.equal(exitCode, 0);
  assert.equal(report.status, "PASS");
  assert.equal(report.migrationSource.mode, "git-range-candidate");
  assert.equal(report.migrationSource.base, fixture.baseline);
  assert.equal(report.migrationSource.head, fixture.candidateHead);
  assert.equal(report.migrationSource.range, `${fixture.baseline}..${fixture.candidateHead}`);
  assert.equal(report.migrationSource.consumedRelocationReceipts.length, 1);
  const receipt = report.migrationSource.consumedRelocationReceipts[0];
  assert.equal(receipt.base, fixture.baseline);
  assert.equal(receipt.head, fixture.candidateHead);
  assert.match(receipt.policySha256, /^[0-9a-f]{64}$/u);
  assert.match(receipt.oldBlob, /^[0-9a-f]{40,64}$/u);
  assert.match(receipt.newBlob, /^[0-9a-f]{40,64}$/u);
});
{
  const fixture = createRelocationFixture();
  try {
    const relocationHead = commitFixture(fixture, "commit reviewed relocation");
    writeFixtureFile(fixture.fixtureRoot, "post-relocation-change.txt", "next candidate\n");
    const nextHead = commitFixture(fixture, "candidate after committed relocation");
    const { exitCode, report } = runRelocationAudit(fixture.fixtureRoot, { base: relocationHead, head: nextHead });
    assert.equal(exitCode, 0, JSON.stringify(report, null, 2));
    assert.equal(report.status, "PASS");
    assert.equal(report.migrationSource.consumedRelocationReceipts.length, 0);
    assert.equal(report.migrationSource.verifiedCommittedRelocationReceipts.length, 1);
    const receipt = report.migrationSource.verifiedCommittedRelocationReceipts[0];
    assert.equal(receipt.from, fixture.from);
    assert.equal(receipt.to, fixture.to);
    assert.equal(receipt.sha256, fixture.sha256);
    assert.equal(receipt.base, relocationHead);
    assert.equal(receipt.head, nextHead);
    assert.match(receipt.baseTargetBlob, /^[0-9a-f]{40,64}$/u);
    assert.match(receipt.candidateTargetBlob, /^[0-9a-f]{40,64}$/u);
    relocationChecks.push("committed relocation remains valid for later clean candidates");
  } finally {
    const resolved = path.resolve(fixture.fixtureRoot);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())), "fixture cleanup escaped the OS temp root");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
withCleanCandidateFixture("clean Git range historical forward modification fails closed", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, "supabase/migrations/20260101000000_forward.sql", "BEGIN;\nSELECT 11;\nCOMMIT;\n");
}, expectRelocationFailure(/historical migration changed relative to audit base/u));
withCleanCandidateFixture("clean Git range historical forward deletion fails closed", (fixture) => {
  fs.rmSync(path.join(fixture.fixtureRoot, "supabase", "migrations", "20260101000000_forward.sql"));
}, expectRelocationFailure(/historical migration deleted relative to audit base/u));
withCleanCandidateFixture("clean Git range unknown nested SQL addition fails closed", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, "supabase/migrations/nested/20260101010105_unknown.sql", "SELECT 12;\n");
}, expectRelocationFailure(/non-canonical or nested SQL entry/u));
withCleanCandidateFixture("clean Git range symlink relocation target fails closed", (fixture) => {
  const target = path.join(fixture.fixtureRoot, ...fixture.to.split("/"));
  const backing = path.join(path.dirname(target), "clean-backing.rollback.sql");
  fs.renameSync(target, backing);
  fs.symlinkSync(path.basename(backing), target, "file");
}, expectRelocationFailure(/not a regular file|target is missing/u));
withCleanCandidateFixture("clean Git range unallowlisted nested deletion fails closed", (fixture) => {
  fs.rmSync(path.join(fixture.fixtureRoot, "supabase", "migrations", "legacy", "20260101010102_unlisted.rollback.sql"));
}, expectRelocationFailure(/historical migration deleted relative to audit base/u), { includeUnlistedLegacy: true });
withCleanCandidateFixture("configured relocation receipt must be consumed", (fixture) => {
  writeFixtureFile(fixture.fixtureRoot, fixture.from, fixture.rollbackBytes);
}, expectRelocationFailure(/neither consumed nor a verified committed relocation/u));
withCleanCandidateFixture("preexisting rollback target does not consume a relocation receipt", null,
  expectRelocationFailure(/target already existed in the audit base/u), { includePreexistingTarget: true });

{
  const hadBase = Object.hasOwn(process.env, "RELEASE_BASE_SHA");
  const hadHead = Object.hasOwn(process.env, "RELEASE_HEAD_SHA");
  const previousBase = process.env.RELEASE_BASE_SHA;
  const previousHead = process.env.RELEASE_HEAD_SHA;
  process.env.RELEASE_BASE_SHA = "ci-parent-base-must-not-leak";
  process.env.RELEASE_HEAD_SHA = "ci-parent-head-must-not-leak";
  try {
    withRelocationFixture("dirty fixture clears inherited CI release range", null, ({ exitCode, report }) => {
      assert.equal(exitCode, 0);
      assert.equal(report.status, "PASS");
      assert.equal(report.migrationSource.mode, "git-head-bound-worktree");
    });
    withCleanCandidateFixture("clean fixture overrides inherited CI release range with its own commits", null,
      ({ exitCode, report }, fixture) => {
        assert.equal(exitCode, 0);
        assert.equal(report.status, "PASS");
        assert.equal(report.migrationSource.base, fixture.baseline);
        assert.equal(report.migrationSource.head, fixture.candidateHead);
      });
  } finally {
    if (hadBase) process.env.RELEASE_BASE_SHA = previousBase;
    else delete process.env.RELEASE_BASE_SHA;
    if (hadHead) process.env.RELEASE_HEAD_SHA = previousHead;
    else delete process.env.RELEASE_HEAD_SHA;
  }
}

{
  const fixture = createRelocationFixture();
  try {
    const candidateHead = commitFixture(fixture, "clean candidate without explicit range");
    expectRelocationFailure(/clean candidate requires an explicit trusted --base and --head/u)(runRelocationAudit(fixture.fixtureRoot));
    relocationChecks.push("clean candidate without explicit range fails closed");
    fs.appendFileSync(path.join(fixture.fixtureRoot, "release-policy.json"), "\n");
    expectRelocationFailure(/policy does not match the candidate-head Git blob/u)(runRelocationAudit(
      fixture.fixtureRoot,
      { base: fixture.baseline, head: candidateHead },
    ));
    relocationChecks.push("candidate range rejects a worktree policy that differs from candidate head");
    expectRelocationFailure(/candidate base is not an ancestor of candidate head/u)(runRelocationAudit(
      fixture.fixtureRoot,
      { base: candidateHead, head: fixture.baseline },
    ));
    relocationChecks.push("candidate range rejects a reversed non-ancestor base");
  } finally {
    fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }
}

if (process.argv.includes("--migration-relocation-contract-only")) {
  console.log(JSON.stringify({
    verifier: "release-workflow-legacy-rollback-relocation",
    passed: true,
    checks: relocationChecks,
    networkRequests: 0,
    databaseWrites: 0,
  }, null, 2));
  process.exit(0);
}

const codeTrackManifest = read("deploy/manifests/public-code-track.v1.txt")
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
assert.equal(codeTrackManifest.length, 81, "public code-track manifest count drifted");
assert.equal(new Set(codeTrackManifest).size, codeTrackManifest.length, "public code-track manifest contains duplicates");
function assertGitPathNotIgnored(relativePath, label) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    1,
    `${label} must not be ignored by Git: ${relativePath}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
  );
}
function assertGitPathIgnored(relativePath, label) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${label} must remain ignored by Git: ${relativePath}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
  );
}
function assertGitPathTracked(relativePath, label) {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    `${label} must be tracked by the Git index: ${relativePath}${result.stderr ? ` (${result.stderr.trim()})` : ""}`,
  );
}
for (const manifestPath of codeTrackManifest) {
  const relativePath = `public/${manifestPath}`;
  assertGitPathNotIgnored(relativePath, "public code-track path");
  assertGitPathTracked(relativePath, "public code-track path");
}
for (const relativePath of [
  "voice-platform/src/__release_visibility_probe__.ts",
  "voice-platform/scripts/__release_visibility_probe__.mjs",
  "voice-platform/prisma/__release_visibility_probe__.prisma",
]) assertGitPathNotIgnored(relativePath, "Voice source visibility probe");
for (const relativePath of [
  "voice-platform/scripts/batch-gen-avatars.sh",
  "voice-platform/scripts/generate-avatars.py",
  "voice-platform/public/avatars/__release_generated_probe__.png",
  "voice-platform/src/app/api/avatars/__release_generated_probe__.ts",
]) assertGitPathIgnored(relativePath, "Voice generated-only boundary probe");
const expectedPublicSourcePaths = [
  ...codeTrackManifest.map((relativePath) => `public/${relativePath}`),
  "public/version.json",
].sort((left, right) => left.localeCompare(right, "en"));
assert.deepEqual(policy.source.publicSourcePaths, expectedPublicSourcePaths,
  "release policy public allowlist must exactly match the reviewed code-track manifest plus version.json");
assert.deepEqual(policy.source.requiredBuildPaths, policy.source.publicSourcePaths,
  "every code-track public asset must be present in the reviewed build");
for (const relativePath of policy.source.publicSourcePaths) {
  assert.ok(fs.statSync(path.join(root, ...relativePath.split("/"))).isFile(), `missing code-track public asset: ${relativePath}`);
}
const commercePublicRoot = path.join(root, "public", "commerce");
const commercePublicPaths = [];
function collectCommercePublicFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectCommercePublicFiles(entryPath);
    else if (entry.isFile()) commercePublicPaths.push(path.relative(root, entryPath).replace(/\\/gu, "/"));
  }
}
collectCommercePublicFiles(commercePublicRoot);
commercePublicPaths.sort((left, right) => left.localeCompare(right, "en"));
assert.deepEqual(
  policy.source.publicSourcePaths.filter((relativePath) => relativePath.startsWith("public/commerce/")),
  commercePublicPaths,
  "every Commerce runtime image must remain on the exact code public track",
);
assert.ok(policy.source.publicSourcePaths.includes("public/brand/platform-logo-display-256.webp"),
  "the platform fallback logo must remain inside the code artifact");
assert.equal(policy.source.publicSourceExtensions, undefined, "blanket public extension allowlists are forbidden");
assert.deepEqual(policy.source.preSnapshotVerifiers, [
  "scripts/verify-public-asset-contract.mjs",
  "scripts/verify-runtime-data-vnext.mjs",
]);
for (const pattern of ["**/*.db", "**/*.db-*", "**/*.sqlite", "**/*.sqlite-*", "**/*.sqlite3", "**/*.sqlite3-*"]) {
  assert.ok(policy.source.excludeGlobs.includes(pattern), `mutable SQLite path is not excluded from source snapshots: ${pattern}`);
}
for (const ignoreFile of [".gitignore", ".releaseignore"]) {
  const ignore = read(ignoreFile);
  for (const pattern of ["*.db", "*.db-*", "*.sqlite", "*.sqlite-*", "*.sqlite3", "*.sqlite3-*"]) {
    assert.ok(ignore.split(/\r?\n/u).includes(pattern), `${ignoreFile} is missing SQLite runtime exclusion: ${pattern}`);
  }
}
for (const required of [
  "shared/data",
  "shared/runtime",
  "shared/runtime/commerce-agent",
  "shared/runtime/commerce-discovery",
  "shared/assets/releases",
  "shared/assets/current",
  "shared/uploads",
  "shared/logs",
  "shared/backups",
  "shared/voice/voice.db",
  "shared/voice/reference-audio",
]) {
  assert.ok(policy.runtime.requiredServerMounts.includes(required), `missing persistent server mount: ${required}`);
}
assert.ok(policy.runtime.requiredDataFiles.includes("studio-config.json"));
assert.ok(policy.runtime.requiredDataFiles.includes("custom-voices.json"));
assert.equal(policy.runtime.requiredDataShapes["custom-voices.json"], "array");
assert.deepEqual(policy.assets.forbiddenPublicRoots, ["public/storyboard-reviews", "public/demo-assets"]);
assert.equal(policy.release.serverBuildAllowed, false);
assert.equal(policy.release.serverGitCheckoutAllowed, false);
assert.equal(policy.release.productionBuild.platform, "linux");
assert.equal(policy.release.productionBuild.nodeMajor, 24);
assert.equal(policy.release.productionBuild.nodeVersion, "24.19.0");
assert.equal(policy.release.productionBuild.pnpmVersion, "9.0.0");
assert.equal(policy.database.contract, "deploy/policies/database-contract.v1.json");
assert.equal(policy.database.probeMode, "read-only-postgrest-openapi");
assert.equal(policy.database.requireTablesColumnsRpcsAndArguments, true);
assert.equal(policy.database.requireForbiddenRpcAbsence, true);
assert.equal(policy.database.applicationManagedMigrationsAllowed, false);
assert.equal(policy.database.preMigrationBackupRequired, true);
const databaseContract = JSON.parse(read(policy.database.contract));
assert.equal(databaseContract.schemaVersion, 1);
assert.match(databaseContract.contractId, /^zimeiti-caopanshou-production-database-/u);
assert.match(databaseContract.contractVersion, /^\d{14}$/u);
assert.ok(databaseContract.tables.length >= 41, "production database contract is missing P0 tables");
assert.ok(databaseContract.rpcs.length >= 34, "production database contract is missing P0 RPCs");
assert.equal(new Set(databaseContract.tables.map((table) => table.name)).size, databaseContract.tables.length);
assert.equal(new Set(databaseContract.rpcs.map((rpc) => rpc.name)).size, databaseContract.rpcs.length);
for (const table of databaseContract.tables) {
  assert.match(table.name, /^[a-z][a-z0-9_]*$/u);
  assert.ok(Array.isArray(table.columns) && table.columns.length > 0, `database table columns missing: ${table.name}`);
  assert.equal(new Set(table.columns).size, table.columns.length, `duplicate database columns: ${table.name}`);
}
for (const rpc of databaseContract.rpcs) {
  assert.match(rpc.name, /^[a-z][a-z0-9_]*$/u);
  assert.ok(Array.isArray(rpc.arguments), `database RPC arguments missing: ${rpc.name}`);
  assert.equal(new Set(rpc.arguments).size, rpc.arguments.length, `duplicate RPC arguments: ${rpc.name}`);
}
for (const requiredTable of [
  "conversation_message_attachments",
  "canvas_document_requests",
  "short_drama_project_versions",
  "wallet_ledger_entries",
  "voice_training_authorization_jobs",
  "manju_config_audit",
  "skill_invocations",
  "cash_debt_records",
  "password_audit_log",
]) assert.ok(databaseContract.tables.some((table) => table.name === requiredTable), `P0 database table is missing: ${requiredTable}`);
assert.deepEqual(databaseContract.forbiddenRpcs.map((rpc) => rpc.name), ["fulfill_payment_order_atomic"]);
for (const backupPattern of ["**/*.bak", "**/*.backup", "**/*.old", "**/*.orig", "**/*.rej", "**/*~"]) {
  assert.ok(policy.source.excludeGlobs.includes(backupPattern), `clean source must exclude editor/backup artifact: ${backupPattern}`);
}
assert.ok(policy.source.excludeGlobs.includes("voice-platform/scripts/voices-full-backup.json"));
assert.match(read(".gitignore"), /^\/voice-platform\/scripts\/voices-full-backup\.json$/mu);
assert.match(read(".gitattributes"), /^\* text=auto eol=lf$/mu, "Git text files must be normalized to LF across platforms");
assert.match(
  read(".gitattributes"),
  /^public\/youcai-media\/v1\/source-manifest[.]json -text -diff$/mu,
  "asset-digest-coupled manifest bytes must remain unchanged and non-text-diffable across Git checkout",
);

const packageJson = JSON.parse(read("package.json"));
for (const script of [
  "release:vnext:audit",
  "release:vnext:assets:write",
  "release:vnext:curate-demo-assets",
  "release:vnext:assets:cos-plan",
  "release:vnext:assets:materialize",
  "release:vnext:assets:verify",
  "release:vnext:inspiration:verify",
  "release:vnext:classify",
  "release:vnext:data:verify",
  "release:vnext:schema:verify",
  "release:vnext:snapshot",
  "release:vnext:sync",
  "release:vnext:build:web",
  "release:vnext:build:voice",
  "release:vnext:package",
  "release:vnext:verify",
  "deploy:nginx:render",
  "deploy:nginx:verify",
]) assert.ok(packageJson.scripts[script], `missing package script: ${script}`);
assert.equal(packageJson.scripts.preinstall, "node ./scripts/enforce-pnpm.mjs");
assert.equal(packageJson.scripts["e2e:browser:install"], "puppeteer browsers install chrome");
assert.equal(packageJson.scripts.validate, "tsc -p tsconfig.json && eslint . --quiet", "validation must not resolve a different nested pnpm binary");
assert.equal(packageJson.packageManager, `pnpm@${policy.release.productionBuild.pnpmVersion}`);
assert.equal(packageJson.engines.pnpm, policy.release.productionBuild.pnpmVersion);
const expectedPnpmOverrides = {
  "fast-xml-parser": "4.5.5",
  "form-data": "2.5.6",
  ini: "1.3.8",
  "linkify-it": "5.0.2",
  nanoid: "3.3.18",
  postcss: "8.5.18",
  sharp: "0.35.0",
};
assert.deepEqual(packageJson.pnpm?.overrides, expectedPnpmOverrides, "pnpm 9 overrides must live in package.json#pnpm");
const expectedOnlyBuiltDependencies = [
  "esbuild",
  "ffmpeg-static",
  "sharp",
  "unrs-resolver",
];
assert.deepEqual(
  packageJson.pnpm?.onlyBuiltDependencies,
  expectedOnlyBuiltDependencies,
  "pnpm 9 lifecycle-script allowlist must live in package.json#pnpm",
);
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("canvas"), "canvas lifecycle scripts must remain blocked");
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("puppeteer"), "browser download must remain outside release dependency installation");
assert.ok(!packageJson.pnpm.onlyBuiltDependencies.includes("better-sqlite3"), "better-sqlite3 v13 prebuild must not invoke node-gyp during install");
assert.equal(packageJson.dependencies["better-sqlite3"], "13.0.3");
assert.equal(packageJson.dependencies["@prisma/client"], undefined, "Web does not own the Voice Prisma client");
assert.equal(packageJson.dependencies.prisma, undefined, "Web does not own the Voice Prisma generator");
const voicePackageJson = JSON.parse(read("voice-platform/package.json"));
assert.equal(voicePackageJson.scripts.preinstall, "node ../scripts/enforce-pnpm.mjs");
assert.equal(voicePackageJson.packageManager, `pnpm@${policy.release.productionBuild.pnpmVersion}`);
assert.equal(voicePackageJson.engines.pnpm, policy.release.productionBuild.pnpmVersion);
assert.equal(voicePackageJson.dependencies["@prisma/client"], "^5.22.0");
assert.equal(voicePackageJson.devDependencies.prisma, "^5.22.0");
assert.deepEqual(voicePackageJson.pnpm?.onlyBuiltDependencies, [
  "@prisma/client",
  "@prisma/engines",
  "esbuild",
  "prisma",
  "sharp",
  "unrs-resolver",
]);
const workspaceManifest = read("pnpm-workspace.yaml");
assert.doesNotMatch(workspaceManifest, /^overrides:/mu, "pnpm 9 does not read root overrides from pnpm-workspace.yaml");
assert.doesNotMatch(workspaceManifest, /^allowBuilds:/mu, "pnpm 9 does not support pnpm 10 allowBuilds");
assert.doesNotMatch(workspaceManifest, /^onlyBuiltDependencies:/mu, "pnpm 9 lifecycle allowlist belongs in package.json");
const lockfileHeaderLines = read("pnpm-lock.yaml").split(/\r?\nimporters:/u, 1)[0].split(/\r?\n/u);
for (const [dependency, version] of Object.entries(expectedPnpmOverrides)) {
  assert.ok(lockfileHeaderLines.includes(`  ${dependency}: ${version}`), `lockfile override is missing or stale: ${dependency}`);
}
const pnpmEnforcer = read("scripts/enforce-pnpm.mjs");
assert.ok(pnpmEnforcer.includes(`expectedVersion = "${policy.release.productionBuild.pnpmVersion}"`));
const runtimeDataVerifier = read("scripts/verify-runtime-data-vnext.mjs");
for (const marker of ["explicitDataRoot", "EXTERNAL_RUNTIME_DATA_NOT_PRESENT", "pass --data-root to verify a mounted data release"]) {
  assert.ok(runtimeDataVerifier.includes(marker), `runtime-data source-boundary gate missing: ${marker}`);
}
const publicAssetContractVerifier = read("scripts/verify-public-asset-contract.mjs");
for (const marker of ["pinned-external-manifest", "full-local-sha256-and-decode", "partial local YouCai asset tree is forbidden", "activationReady: false"]) {
  assert.ok(publicAssetContractVerifier.includes(marker), `public-asset verification mode missing: ${marker}`);
}
const topLevelDatabaseClients = [];
const sourceScanStack = [path.join(root, "src")];
while (sourceScanStack.length > 0) {
  const directory = sourceScanStack.pop();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceScanStack.push(filePath);
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) {
      const relativePath = path.relative(root, filePath).split(path.sep).join("/");
      for (const [index, line] of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).entries()) {
        if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*getSupabase(?:Admin)?Client\(\);?\s*$/u.test(line)) {
          topLevelDatabaseClients.push(`${relativePath}:${index + 1}`);
        }
      }
    }
  }
}
assert.deepEqual(topLevelDatabaseClients, [], "database clients must be initialized inside request/runtime functions, never during module evaluation");

const dockerfile = read("Dockerfile");
assert.match(dockerfile, /node:24\.19\.0-bookworm-slim@sha256:[0-9a-f]{64}/u);
assert.match(dockerfile, /pnpm-workspace\.yaml/u);
assert.match(dockerfile, /PUPPETEER_SKIP_DOWNLOAD=true/u);
assert.match(dockerfile, /\.next\/standalone/u);
assert.match(dockerfile, /USER nextjs/u);
assert.doesNotMatch(dockerfile, /require\(["']@prisma\/client["']\)/u, "Web image must not require the Voice Prisma client");
assert.doesNotMatch(dockerfile, /COPY\s+--from=deps\s+\/app\/node_modules\s+\.\/node_modules[\s\S]*FROM \$\{NODE_IMAGE\} AS runner[\s\S]*COPY.*node_modules/u);

const packager = read("scripts/package-standalone-artifact.mjs");
for (const marker of [
  "release-provenance.v1.json",
  "git([\"status\"",
  "schemaVersion: 2",
  "deployable",
  "buildEnvironment",
  "assetDigest",
  "sourceManifestSha256",
  "sourceVersion: buildOutputDigestReceipt.sourceVersion",
  "buildOutputDigest: buildOutputDigestReceipt.outputDigest",
  "standaloneCopyFilter",
  "source-public-allowlist-only",
  "publicSourceBoundary",
]) assert.ok(packager.includes(marker), `packager gate missing: ${marker}`);
assert.match(packager, /const ARCHIVE_METADATA_MAX_BUFFER = 64 \* 1024 \* 1024;/u,
  "finalization must bound large archive metadata output above Node's default child-process buffer");
assert.equal((packager.match(/maxBuffer: ARCHIVE_METADATA_MAX_BUFFER/gu) || []).length, 2,
  "finalization must apply the archive metadata buffer to both compact and verbose tar listings");
assert.doesNotMatch(packager, /publicSourceExtensions/u);
assert.match(
  packager,
  /relativePath !== "public" && !relativePath\.startsWith\("public\/"\)/u,
  "web artifact must exclude the prepared standalone public tree before copying the exact source allowlist",
);

const build = read("scripts/build-release-vnext.mjs");
for (const marker of ["productionBuild", "--allow-local-rehearsal", "--verify-pnpm-invocation", "resolvePnpmInvocation", "PNPM_CLI_PATH", "lockfileSha256", "nodeModulesAbi", "detectLibc", "DEPLOYMENT_VERSION", "servicePnpmPrefix", "--ignore-workspace", "required-server-files.json", "compiled deploymentId must equal the immutable Git commit", "Voice BUILD_ID must equal the immutable Git commit", "deploymentId: commitSha", "buildIdStrategy", "nextVersion"]) {
  assert.ok(build.includes(marker), `build provenance gate missing: ${marker}`);
}
assert.doesNotMatch(build, /pnpm[.]cmd/u, "Windows release builds must not spawn a .cmd shim directly");
const gitAutoDeploy = read("scripts/git-auto-deploy.sh");
assert.ok(
  gitAutoDeploy.includes(`corepack prepare pnpm@${policy.release.productionBuild.pnpmVersion} --activate`),
  "legacy deploy script must prepare the policy pnpm version",
);
assert.doesNotMatch(gitAutoDeploy, /pnpm@9\.15\.9/u, "legacy deploy script must not prepare a drifted pnpm 9.x version");
const nextConfig = read("next.config.ts");
assert.match(nextConfig, /deploymentId:\s*deploymentVersion/u);
assert.doesNotMatch(nextConfig, /generateBuildId/u, "Next 16 BUILD_ID must not be conflated with the immutable release commit");
assert.doesNotMatch(
  nextConfig,
  /outputFileTracingRoot:\s*process\.cwd\(\)/u,
  "Next config must not make NFT trace the entire project through a dynamic cwd root",
);
assert.match(
  nextConfig,
  /turbopack:\s*\{[\s\S]*?root:\s*process\.cwd\(\)/u,
  "Turbopack must stay pinned to the current project instead of scanning the parent drive",
);
const voiceNextConfig = read("voice-platform/next.config.ts");
assert.match(voiceNextConfig, /deploymentId:\s*deploymentVersion/u);
assert.match(voiceNextConfig, /generateBuildId:\s*deploymentVersion/u);
const pnpmCliPath = process.env.PNPM_CLI_PATH?.trim() || process.env.npm_execpath?.trim();
if (pnpmCliPath) {
  const pnpmInvocationSmoke = spawnSync(process.execPath, [path.join(root, "scripts/build-release-vnext.mjs"), "--verify-pnpm-invocation"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PNPM_CLI_PATH: pnpmCliPath },
  });
  assert.equal(pnpmInvocationSmoke.status, 0, pnpmInvocationSmoke.stderr || pnpmInvocationSmoke.stdout);
  assert.equal(JSON.parse(pnpmInvocationSmoke.stdout).pnpmVersion, policy.release.productionBuild.pnpmVersion);
}

const deployApi = read("src/app/api/deploy/route.ts");
assert.match(deployApi, /IN_APP_DEPLOY_DISABLED/u);
assert.doesNotMatch(deployApi, /next build|pm2 restart|public\/version\.json/u);
const legacyVoiceSync = read("src/app/api/admin/voices/sync/route.ts");
assert.match(legacyVoiceSync, /LEGACY_SOURCE_MUTATION_DISABLED/u);
assert.doesNotMatch(legacyVoiceSync, /writeFileSync|voices-volc\.ts/u);
for (const route of ["src/app/api/settings/route.ts", "src/app/api/settings/layout/route.ts"]) {
  assert.doesNotMatch(read(route), /writeFileSync|public["'],\s*["']version\.json/u, `${route} mutates immutable version metadata`);
}

const databaseReadiness = read("src/lib/production-database-readiness.ts");
for (const marker of [
  "validateProductionDatabaseOpenApi",
  "missingColumns",
  "missingRpcArguments",
  "forbiddenRpcsPresent",
  "application/openapi+json",
]) assert.ok(databaseReadiness.includes(marker), `database readiness gate missing: ${marker}`);
const releaseReadiness = read("src/app/api/release-readiness/route.ts");
assert.match(releaseReadiness, /probeProductionDatabaseReadiness/u);
assert.match(releaseReadiness, /production database contract is not ready/u);
assert.match(releaseReadiness, /probeProductionReferenceDataReadiness/u);
assert.match(releaseReadiness, /production reference data is not ready/u);
assert.match(releaseReadiness, /EXPECTED_BUILD_ID/u);
assert.match(releaseReadiness, /RELEASE_SOURCE_VERSION/u);
assert.match(releaseReadiness, /RELEASE_BUILD_OUTPUT_DIGEST/u);
assert.match(releaseReadiness, /requireDedicatedDataMount/u);
assert.match(releaseReadiness, /dataStats\.dev === rootStats\.dev/u);
assert.match(releaseReadiness, /production runtime path escaped \/data/u);
assert.doesNotMatch(releaseReadiness, /process\.cwd\(\)[\s\S]{0,80}BUILD_ID/u, "Web readiness must not make Next trace the source root");
for (const call of ["openSync", "readFileSync", "statSync", "lstatSync", "accessSync"]) {
  assert.doesNotMatch(
    releaseReadiness,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `Web readiness dynamic fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const runtimePaths = read("src/lib/runtime-paths.ts");
for (const call of ["existsSync", "mkdirSync", "statSync", "accessSync"]) {
  assert.doesNotMatch(
    runtimePaths,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `runtime path fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const voiceDatabasePath = read("src/lib/voice-studio/database-path.ts");
for (const call of ["resolve", "join"]) {
  assert.doesNotMatch(
    voiceDatabasePath,
    new RegExp(`path\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `Voice SQLite path.${call} must be excluded from Turbopack file tracing`,
  );
}
const localStorageProvider = read("src/storage/object/providers/local.ts");
for (const call of ["mkdir", "open", "rename", "rm", "readFile", "access", "unlink", "readdir", "stat"]) {
  assert.doesNotMatch(
    localStorageProvider,
    new RegExp(`fs\\.${call}\\((?!\\s*\\/\\* turbopackIgnore: true \\*\\/)`, "u"),
    `local storage fs.${call} must be excluded from Turbopack file tracing`,
  );
}
const avatarRoute = read("src/app/api/avatars/route.ts");
for (const pattern of [
  /fs\.readFile\((?!\s*\/\* turbopackIgnore: true \*\/)/u,
  /path\.resolve\((?!\s*\/\* turbopackIgnore: true \*\/)/u,
]) assert.doesNotMatch(avatarRoute, pattern, "avatar runtime mounts must be excluded from Turbopack file tracing");
const voiceReleaseReadiness = read("voice-platform/src/app/api/release-readiness/route.ts");
assert.match(voiceReleaseReadiness, /EXPECTED_BUILD_ID/u);
assert.match(voiceReleaseReadiness, /RELEASE_SOURCE_VERSION/u);
assert.match(voiceReleaseReadiness, /RELEASE_BUILD_OUTPUT_DIGEST/u);
assert.match(voiceReleaseReadiness, /must equal DEPLOY_COMMIT_SHA/u);
assert.doesNotMatch(voiceReleaseReadiness, /process\.cwd\(\)[\s\S]{0,80}BUILD_ID/u, "Voice readiness must not make Next trace the source root");
const referenceDataReadiness = read("src/lib/production-reference-data-readiness.ts");
for (const marker of [
  "voice_nest_price_versions",
  "manju_config_active",
  "manju_config_storage_state",
  "MANJU_CONFIG_DOMAINS",
  "COZE_SUPABASE_SERVICE_ROLE_KEY",
  "video_models",
  "video_channel_health",
  "isReleaseVerifiedVideoChannelHealth",
  "reference-data-not-ready",
]) assert.ok(referenceDataReadiness.includes(marker), `reference-data readiness gate missing: ${marker}`);
const healthRoute = read("src/app/api/health/route.ts");
assert.match(healthRoute, /probeProductionDatabaseReadiness/u);
assert.doesNotMatch(healthRoute, /requiredTables[\s\S]{0,600}["']avatars["']/u, "avatars storage bucket must not be treated as a database table");
const debtLedgerMigration = read("supabase/migrations/20260828193000_release_baseline_audit_and_debt.sql");
assert.match(debtLedgerMigration, /CREATE TABLE IF NOT EXISTS public\.cash_debt_records/u);
assert.match(debtLedgerMigration, /CREATE TABLE IF NOT EXISTS public\.password_audit_log/u);
const billing = read("src/lib/billing.ts");
assert.match(billing, /DEBT_LEDGER_QUERY_FAILED/u);
assert.match(billing, /failureCode:\s*'DEBT_LEDGER_UNAVAILABLE'/u);
const imageGenerate = read("src/app/api/image/generate/route.ts");
assert.match(imageGenerate, /BILLING_LEDGER_UNAVAILABLE/u);
assert.match(imageGenerate, /本次不会调用图片模型，也不会扣费/u);

const nginx = read("deploy/nginx/agent-hub.vnext.conf.example");
for (const marker of ["shared/assets/current/public", "public-assets.ready.v1.json", "api/release-readiness"]) {
  assert.ok(nginx.includes(marker), `nginx release contract missing: ${marker}`);
}
for (const token of ["__RELEASE_ROOT__", "__SERVER_NAMES__"]) {
  assert.ok(nginx.includes(token), `nginx template must keep an explicit renderer token: ${token}`);
}
assert.doesNotMatch(nginx, /^\s*server_name\s+example\.invalid\s*;/mu, "nginx template must not contain an active placeholder server name");
assert.doesNotMatch(nginx, /^\s*(?:root|alias)\s+\/srv\/zimeiti-caopanshou(?:\/|;)/mu, "nginx template must not contain an active example release root");
const nginxRenderer = read("scripts/render-nginx-config-vnext.mjs");
for (const marker of [
  "validateReleaseRoot",
  "validateServerNames",
  "unresolved placeholders",
  "output already exists",
  "writeAtomic",
]) assert.ok(nginxRenderer.includes(marker), `nginx renderer gate missing: ${marker}`);
assert.match(packageJson.scripts["release:vnext:verify"], /verify-render-nginx-config-vnext\.mjs/u, "formal release verification must execute the Nginx renderer test");
assert.match(nginx, /location = \/api\/payment\/notify\s*\{[\s\S]*?client_max_body_size 64k;/u, "payment callback bodies must be bounded at the edge");
assert.match(nginx, /location = \/api\/payment\/refund\s*\{[\s\S]*?client_max_body_size 16k;/u, "payment refund bodies must be bounded at the edge");
assert.match(nginx, /location = \/api\/payment\/refund\s*\{[\s\S]*?limit_req zone=agent_hub_paid_write_ip burst=5 nodelay;/u, "payment refunds must use the shared paid-write limiter");
assert.match(nginxRenderer, /validateRequestBodyLimits/u, "Nginx renderer must reject payment-limit and media-upload-limit drift");
assert.match(nginx, /location\s+(?:\^~\s+)?\/uploads\//u, "nginx mutable uploads location is missing");
assert.match(nginx, /storyboard-reviews\|demo-assets/u, "nginx must deny public evidence roots");
assert.match(packageJson.scripts["deploy:capacity:verify"], /verify-release-operational-capacity\.mjs\s+--mode=production/u, "deployment must run the production capacity gate");
const capacityVerifier = read("scripts/verify-release-operational-capacity.mjs");
for (const marker of [
  "single-public-web-process-boundary",
  "payment-edge-body-limits",
  "large-upload-edge-separation",
  "horizontal-web-scale-boundary",
  "single-web-no-cost-concurrency-probe",
  "PROBE_CONCURRENCY = 200",
  "paidModelCalls: 0",
  "databaseWrites: 0",
]) assert.ok(capacityVerifier.includes(marker), `operational capacity gate missing: ${marker}`);

const releaseWorkflow = read("scripts/release-workflow.mjs");
for (const marker of ["assetPolicySha256", "sha256-files-and-asset-policy", "canonicalSourceBuffer", "canonicalTextEol", "isExternalAsset", "attr\\/-text", "ls-files", "--eol", "w\\/(?:crlf|mixed)", "forbiddenPublicRoots", "requiredRemotes", "isSafelyIgnoredLegacyManagedFile", "check-ignore", "stats.nlink !== 1"]) {
  assert.ok(releaseWorkflow.includes(marker), `release workflow policy gate missing: ${marker}`);
}
assert.doesNotMatch(releaseWorkflow, /generatedAt:\s*new Date\(\)\.toISOString\(\)[\s\S]{0,250}kind:\s*["']public-assets/u);

const assetVerifier = read("scripts/verify-public-asset-release.mjs");
for (const marker of ["fileCount", "totalBytes", "mutableUploadsIncluded", "verificationMode", "storageBackend", "location"]) {
  assert.ok(assetVerifier.includes(marker), `asset READY verifier is missing: ${marker}`);
}
assert.match(assetVerifier, /storageBackend !== ["']disk["']/u, "local verifier must reject COS READY issuance");
assert.match(assetVerifier, /COS READY must be generated by publish-public-assets-cos-vnext/u);
assert.match(assetVerifier, /assetPolicySha256 !== assetPolicySha256/u, "local verifier must bind the current stable asset policy digest");
assert.match(assetVerifier, /symbolic links are forbidden/u);
assert.match(assetVerifier, /kind:\s*["']public-assets-verification-result["']/u);
assert.match(assetVerifier, /status:\s*["']VERIFIED["']/u);
assert.match(assetVerifier, /--write-ready is disabled/u);
assert.doesNotMatch(assetVerifier, /status:\s*["']READY["']/u, "local verifier must not mint final READY");
const cosPublisher = read("scripts/publish-public-assets-cos-vnext.mjs");
assert.match(cosPublisher, /verificationMode:\s*["']full-sha256["']/u);
assert.doesNotMatch(cosPublisher, /full-sha256-metadata/u);
assert.match(cosPublisher, /verifyRemoteContent/u);
for (const marker of [
  "Number.isSafeInteger",
  "SINGLE_PUT_MAX_BYTES",
  "assetPolicySha256 !== assetPolicySha256",
  "publisherScriptSha256",
  "remoteVerifiedFileCount",
  "remoteContentTypeVerified",
  "remoteCacheControlVerified",
  "put-object-forbid-overwrite",
]) assert.ok(cosPublisher.includes(marker), `COS publisher security gate missing: ${marker}`);
assert.doesNotMatch(cosPublisher, /cos\.uploadFile\s*\(/u, "unsafe multipart upload fallback must remain disabled");
const assetMaterializer = read("scripts/materialize-public-asset-release-vnext.mjs");
for (const marker of [
  "assetPolicySha256 !== assetPolicySha256",
  "publisherId: PUBLISHER_ID",
  "publisherScriptSha256",
  "remoteVerifiedFileCount",
  "MAX_RECEIPT_BYTES",
  "symbolic links are forbidden",
  "fsyncFile(destinationPath)",
  "public-assets-transport-receipt",
  "public-assets.bundle.v1.json",
  "public-assets.cos.ready.v1.json",
]) assert.ok(assetMaterializer.includes(marker), `asset materializer security gate missing: ${marker}`);
assert.doesNotMatch(assetMaterializer, /["']public-assets\.ready\.v1\.json["']/u, "materializer must not write the final READY filename");

for (const productionSource of [
  "src/app/help/storyboard-mode-showcase.tsx",
  "src/features/official-home/official-home-page.tsx",
  "src/lib/creation-center-catalog.ts",
  "src/components/manual-canvas.tsx",
  "src/components/storyboard-workbench.tsx",
]) {
  assert.doesNotMatch(read(productionSource), /\/(?:storyboard-reviews|demo-assets)\//u, `${productionSource} references public evidence`);
}
const pm2 = read("deploy/pm2/ecosystem.vnext.config.cjs");
for (const marker of ["APP_DATA_DIR", "APP_RUNTIME_DIR", "COMMERCE_DATA_DIR", "COMMERCE_DISCOVERY_CATALOG", "COMMERCE_GATEWAY_KEY_FILE", "BACKUP_DIR", "PUBLIC_ASSET_ROOT", "VOICE_REFERENCE_AUDIO_DIR", "EXPECTED_BUILD_ID", "RELEASE_SOURCE_VERSION", "RELEASE_BUILD_OUTPUT_DIGEST", "COZE_PROJECT_ENV", "RELEASE_READINESS_PROFILE", "production-full-v1"]) {
  assert.ok(pm2.includes(marker), `PM2 release contract missing: ${marker}`);
}
const artifactDeployer = read("scripts/deploy-artifact-vnext.sh");
const browserAcceptanceRunner = read("scripts/run-release-browser-acceptance.mjs");
const standaloneAssetPreparer = read("scripts/prepare-next-standalone-assets.mjs");
for (const marker of ["materializeVoiceReleaseIdentity", 'path.join(root, "public", "version.json")', "sourceVersion"]) {
  assert.ok(standaloneAssetPreparer.includes(marker), `Voice release identity materialization gate missing: ${marker}`);
}
for (const marker of ["EXPECTED_BUILD_ID=$BUILD_ID", "RELEASE_SOURCE_VERSION=$SOURCE_VERSION", "RELEASE_BUILD_OUTPUT_DIGEST=$BUILD_OUTPUT_DIGEST", "active_build_id", "env.EXPECTED_BUILD_ID !== buildId", "env.RELEASE_SOURCE_VERSION !== sourceVersion", "env.RELEASE_BUILD_OUTPUT_DIGEST !== buildOutputDigest", "\"$PREVIOUS_BUILD_ID\"", "\"$PREVIOUS_SOURCE_VERSION\"", "\"$PREVIOUS_BUILD_OUTPUT_DIGEST\""]) {
  assert.ok(artifactDeployer.includes(marker), `artifact deployment build-identity gate missing: ${marker}`);
}
for (const marker of [
  "CANDIDATE_PAYLOAD_INVENTORY_MISMATCH",
  "DEDICATED_DATA_MOUNT_REQUIRED",
  "candidate-runtime-v1",
  "desktop-precise-route-visual-1440x900",
  "desktop-two-adjacent-pages-visual",
  "console-and-request-errors",
  "full-desktop-release-checklist",
  "BROWSER_SIGNING_KEY_NOT_TRUSTED",
  "crypto.sign(null",
  "playwright",
  "1440",
  "900",
]) assert.ok(browserAcceptanceRunner.includes(marker), `browser acceptance runner contract missing: ${marker}`);
assert.match(browserAcceptanceRunner, /const ARCHIVE_METADATA_MAX_BUFFER = 64 \* 1024 \* 1024;/u,
  "browser acceptance must bound large archive metadata output above Node's default child-process buffer");
assert.match(browserAcceptanceRunner, /maxBuffer: options\.maxBuffer \|\| 1024 \* 1024/u,
  "browser acceptance command runner must forward explicit bounded output limits");
assert.equal((browserAcceptanceRunner.match(/maxBuffer: ARCHIVE_METADATA_MAX_BUFFER/gu) || []).length, 2,
  "browser acceptance must apply the archive metadata buffer to both compact and verbose tar listings");
assert.match(browserAcceptanceRunner, /startCandidateDatabaseFixture/u,
  "browser acceptance must use an isolated local database fixture for authenticated routes");
assert.match(browserAcceptanceRunner, /process\.env\.CANDIDATE_SUBJECT_SHA \|\| process\.env\.GITHUB_SHA/u,
  "browser acceptance must separate the immutable candidate subject from the verifier toolchain commit");
assert.match(browserAcceptanceRunner, /context\.addInitScript[\s\S]*localStorage\.setItem\("auth_token", token\)[\s\S]*localStorage\.setItem\("auth_user", JSON\.stringify\(user\)\)[\s\S]*sessionStorage\.setItem\("entered_app", "1"\)/u,
  "browser acceptance must seed the same client-side authenticated state used by protected pages");
assert.match(browserAcceptanceRunner, /blockingFailures\.push[\s\S]*BROWSER_ROUTE_FAILURES/u,
  "browser acceptance must sweep all required routes and report their blocking failures together");
assert.match(browserAcceptanceRunner, /"\/extract": Object\.freeze\(\{ service: "web", expectedRoute: "\/tools\?tab=text" \}\)/u,
  "browser acceptance must validate the retired extract bookmark against its reviewed toolbox destination");
assert.match(browserAcceptanceRunner, /"\/workspace": Object\.freeze\(\{ service: "voice", expectedRoute: "\/workspace" \}\)/u,
  "browser acceptance must open the Voice workspace on the Voice candidate rather than the Web candidate");
assert.match(browserAcceptanceRunner, /runBrowserAcceptance\(\{[\s\S]*web: `http:\/\/127\.0\.0\.1:\$\{ports\.web\}`[\s\S]*voice: ports\.voice/u,
  "browser acceptance must provide both immutable candidate origins to the route sweep");
assert.match(browserAcceptanceRunner, /COZE_SUPABASE_URL = acceptance\.database\.url/u);
assert.doesNotMatch(browserAcceptanceRunner, /process\.env\.(?:COZE_SUPABASE|COS_SECRET|SSH_)|https:\/\/[^"'`]*supabase/iu,
  "browser acceptance must never inherit production database, COS, or SSH credentials");
const publishedBrandFixtureMarker = 'url.pathname === "/rest/v1/rpc/read_published_platform_brand"';
const genericRpcFixtureMarker = 'url.pathname.startsWith("/rest/v1/rpc/")';
const publishedBrandFixtureIndex = browserAcceptanceRunner.indexOf(publishedBrandFixtureMarker);
const genericRpcFixtureIndex = browserAcceptanceRunner.indexOf(genericRpcFixtureMarker);
assert.ok(
  publishedBrandFixtureIndex >= 0 && genericRpcFixtureIndex > publishedBrandFixtureIndex,
  "browser acceptance must handle the published-brand RPC before the generic RPC fixture",
);
assert.match(
  browserAcceptanceRunner.slice(publishedBrandFixtureIndex, genericRpcFixtureIndex),
  /sendJson\(request, response, 200, null\)/u,
  "an empty isolated brand control plane must use the authoritative null RPC result",
);
for (const marker of ["canonicalJson(expected)", 'item.kind === "directory"', "expectedFileCount", "observed.mode !== item.mode", "manifest.sourceVersion"]) {
  assert.ok(artifactDeployer.includes(marker), `artifact deployment v2 inventory/identity contract missing: ${marker}`);
}
for (const marker of [
  "verify_exact_active_composite",
  "verify_exact_first_deploy_composite",
  "env.ASSET_DIGEST !== assetDigest",
  "ROLLBACK_ATTEMPTED",
  "handle_termination TERM 143",
  "handle_termination INT 130",
  "handle_termination HUP 129",
  "read_asset_release_backend",
  "CURRENT_ASSET_BACKEND",
  "ASSET_TARGET_BACKEND",
  '[[ "$EUID" -eq 0 ]] || die "--execute requires EUID=0',
  "seal_candidate_release",
  "verify_candidate_release_seal",
  "sealed candidate full SHA-256 inventory changed before activation",
  'CANDIDATE_USER="zimeiti-candidate"',
  "systemd-run --quiet --collect",
  '--expand-environment=no',
  '"$ENV_BIN" -i -- "${CANDIDATE_ENVIRONMENT[@]}"',
  'RELEASE_READINESS_PROFILE=candidate-runtime-v1',
  'RELEASE_CANDIDATE_MODE=isolated',
  'SERVER_ENV_DISCOVERY_DISABLED=1',
  'CANDIDATE_FIXTURE_HELPER_PATH="/usr/local/libexec/zimeiti/prepare-candidate-readiness-fixtures.py"',
  '"$CANDIDATE_FIXTURE_HELPER_PATH" --service web',
  'productionRecordsCopied',
  'schemaContractVersion !== "zimeiti-voice-sqlite-readiness.v1"',
  'receipt.sourceSchemaSha256 !== receipt.outputSchemaSha256',
  'PrivateNetwork=yes',
  'PrivateIPC=yes',
  'ProtectSystem=strict',
  'ProtectProc=invisible',
  'ProcSubset=pid',
  'RestrictAddressFamilies=AF_INET AF_INET6',
  'ReadWritePaths=$CANDIDATE_STATE_ROOT',
  'InaccessiblePaths=$CANDIDATE_INACCESSIBLE_PATHS',
  'StandardOutput=append:$CANDIDATE_PRIVATE_LOG',
  'MemoryMax=1073741824',
  'MemorySwapMax=0',
  'TasksMax=256',
  'CPUQuota=100%',
  'LimitFSIZE=134217728',
  'ReadOnlyPaths=$PAYLOAD_DIR $PUBLIC_ASSET_ROOT',
  'ReadWritePaths=$CANDIDATE_STATE_ROOT',
  'InaccessiblePaths=$CANDIDATE_INACCESSIBLE_PATHS',
  'CapabilityBoundingSet=',
  'AmbientCapabilities=',
  'RestrictNamespaces=yes',
  'KillMode=mixed',
  'RuntimeMaxUSec=3min',
  'TimeoutStopUSec=5s',
  'UMask=0077',
  'candidate-log.v2 service=${service} release=${releaseId}',
  'published candidate log length summary is invalid',
  'published candidate log payload digest is invalid',
  'candidate_cgroup_empty',
  'candidate sandbox could not be proven inactive with an empty cgroup',
  'nsenter --target "$candidate_pid" --net',
  'STORAGE_GUARD_PATH="/usr/local/libexec/zimeiti/verify-deploy-storage-runtime.sh"',
  "run_storage_boot_guard",
  "assert_fresh_production_preflight_receipt",
  "create-production-preflight-receipt.mjs",
  "verify-production-preflight-receipt.mjs",
  "PRODUCTION_PREFLIGHT_RECEIPT_HMAC_KEY",
  "production preflight receipt identity missing at commit boundary",
]) assert.ok(artifactDeployer.includes(marker), `artifact deployment transaction gate missing: ${marker}`);
assert.ok(
  !artifactDeployer.includes('cp -a -- "$APP_DATA_DIR/." "$CANDIDATE_DATA_DIR/"'),
  "candidate must not clone the full mutable/user-derived application data tree",
);
const serverRuntimeEnvironment = read("src/lib/server-runtime-env.ts");
const customServerEntrypoint = read("src/server.ts");
assert.ok(
  serverRuntimeEnvironment.includes('if (process.env.SERVER_ENV_DISCOVERY_DISABLED === "1") return;'),
  "server runtime env loader must return before explicit or discovered env files in candidate mode",
);
assert.ok(
  customServerEntrypoint.includes("process.env.SERVER_ENV_DISCOVERY_DISABLED !== '1'"),
  "custom server entrypoint must honor candidate env-discovery isolation",
);
for (const forbiddenCandidateCredentialMarker of [
  ".env.candidate-readonly",
  "load_candidate_readonly_environment",
  "zimeiti_candidate_readonly",
  'COZE_SUPABASE_SERVICE_ROLE_KEY="$COZE_SUPABASE_SERVICE_ROLE_KEY"',
]) {
  assert.ok(!artifactDeployer.includes(forbiddenCandidateCredentialMarker), `candidate deployment still contains a forbidden credential marker: ${forbiddenCandidateCredentialMarker}`);
}
assert.ok(
  artifactDeployer.indexOf("compare_data_snapshot \"$DATA_BEFORE\" \"$DATA_AFTER_CANDIDATE\"")
    < artifactDeployer.lastIndexOf("load_protected_environment"),
  "production credentials must load only after isolated candidate acceptance",
);
const storageGuardBytes = fs.readFileSync(path.join(root, "scripts/verify-deploy-storage-runtime.sh"));
const storageGuardSha256 = crypto.createHash("sha256").update(storageGuardBytes).digest("hex");
assert.ok(
  artifactDeployer.includes(`STORAGE_GUARD_SHA256="${storageGuardSha256}"`),
  "artifact deployer is not pinned to the reviewed storage guard bytes",
);
const runtimeSafetyProvisioner = read("scripts/provision-production-runtime-safety.sh");
const candidateFixtureBytes = fs.readFileSync(path.join(root, "scripts/prepare-candidate-readiness-fixtures.py"));
const candidateFixtureSha256 = crypto.createHash("sha256").update(candidateFixtureBytes).digest("hex");
const candidateFixtureSource = candidateFixtureBytes.toString("utf8");
for (const marker of [
  'VOICE_SCHEMA_CONTRACT_VERSION = "zimeiti-voice-sqlite-readiness.v1"',
  "VOICE_SCHEMA_CONTRACT:",
  "REQUIRED_UNIQUE_COLUMN_SETS:",
  "validate_voice_schema_contract",
  '"sourceSchemaSha256"',
  '"outputSchemaSha256"',
  "candidate Voice schema drifted while production records were removed",
]) assert.ok(candidateFixtureSource.includes(marker), `candidate fixture schema gate missing: ${marker}`);
const candidateFixtureTestSource = read("scripts/test-prepare-candidate-readiness-fixtures.py");
for (const marker of [
  '"missing-table"',
  '"missing-column"',
  '"incompatible-affinity"',
  'receipt["sourceSchemaSha256"]',
  'receipt["outputSchemaSha256"]',
]) assert.ok(candidateFixtureTestSource.includes(marker), `candidate fixture negative test gate missing: ${marker}`);
const systemdStorageDropinBytes = fs.readFileSync(path.join(root, "deploy/systemd/pm2-root.service.d/20-zimeiti-data-mount.conf.example"));
const systemdStorageDropinSha256 = crypto.createHash("sha256").update(systemdStorageDropinBytes).digest("hex");
for (const marker of [
  "RUNTIME_SAFETY_EXECUTION_APPROVED",
  'CANDIDATE_USER="zimeiti-candidate"',
  "systemctl daemon-reload",
  "PM2_ACTIONS=0",
  "missing-disk and wrong-disk boot drills",
  "prepare-candidate-readiness-fixtures.py",
  '"$FIXTURE_TARGET" --self-test',
]) assert.ok(runtimeSafetyProvisioner.includes(marker), `runtime-safety provisioner gate missing: ${marker}`);
assert.ok(
  runtimeSafetyProvisioner.includes(`GUARD_SHA256="${storageGuardSha256}"`),
  "runtime-safety provisioner is not pinned to the reviewed storage guard bytes",
);
assert.ok(
  runtimeSafetyProvisioner.includes(`DROPIN_SHA256="${systemdStorageDropinSha256}"`),
  "runtime-safety provisioner is not pinned to the reviewed systemd drop-in bytes",
);
assert.ok(
  runtimeSafetyProvisioner.includes(`FIXTURE_SHA256="${candidateFixtureSha256}"`)
    && artifactDeployer.includes(`CANDIDATE_FIXTURE_HELPER_SHA256="${candidateFixtureSha256}"`),
  "candidate fixture helper is not pinned consistently by provisioning and deployment",
);
assert.ok(
  artifactDeployer.lastIndexOf("\nload_protected_environment\n")
    < artifactDeployer.lastIndexOf("\nrun_production_preflight\n"),
  "production preflight must run only after protected credentials load",
);
const stateMachineVerification = spawnSync(process.execPath, [path.join(root, "scripts/verify-deploy-state-machine.mjs")], {
  cwd: root,
  encoding: "utf8",
  env: process.env,
});
assert.equal(stateMachineVerification.status, 0, `deployment state-machine verification failed: ${stateMachineVerification.stderr || stateMachineVerification.stdout}`);
const stateMachineReport = JSON.parse(stateMachineVerification.stdout);
assert.equal(stateMachineReport.ok, true, "deployment state-machine report did not pass");
assert.equal(stateMachineReport.staticStateMachineChecks, true, "deployment state-machine static gates did not pass");
assert.ok(stateMachineReport.embeddedNodeValidators >= 12, "deployment state-machine did not syntax-check every embedded Node validator");
assert.ok(Array.isArray(stateMachineReport.dynamicFaultInjectionChecks), "deployment state-machine did not execute fault injection");
for (const shellScript of [
  "scripts/provision-production-runtime-safety.sh",
  "scripts/verify-deploy-storage-runtime.sh",
]) {
  const syntax = spawnSync(stateMachineReport.bash, ["-n", path.join(root, shellScript)], { cwd: root, encoding: "utf8" });
  assert.equal(syntax.status, 0, `${shellScript} Bash syntax failed: ${syntax.stderr || syntax.stdout}`);
}
for (const requiredHarness of ["signal", "exit", "first-deploy"]) {
  assert.ok(
    stateMachineReport.dynamicFaultInjectionChecks.some((result) => result.harness === requiredHarness),
    `deployment state-machine did not execute the ${requiredHarness} harness`,
  );
}
for (const requiredScenario of ["rollback-current", "rollback-absent", "rollback-rm-fail", "rollback-unexpected"]) {
  assert.ok(
    stateMachineReport.dynamicFaultInjectionChecks.some((result) => result.scenario === requiredScenario),
    `deployment state-machine did not execute first-deploy scenario ${requiredScenario}`,
  );
}
const provisioner = read("scripts/provision-release-root-vnext.sh");
for (const marker of [
  "--plan",
  "--execute",
  "RELEASE_ROOT_PROVISION_APPROVED",
  ".zimeiti-release-root",
  "shared/runtime/llm-request-idempotency",
  "PRAGMA quick_check",
  "no empty business data was generated",
]) assert.ok(provisioner.includes(marker), `release-root provisioner gate missing: ${marker}`);
assert.doesNotMatch(provisioner, /(?:echo|printf)[^\n]*(?:\[\]|\{\})[^\n]*shared\/data/u, "provisioner must not seed empty business JSON");

for (const script of [
  "scripts/release-workflow.mjs",
  "scripts/build-release-vnext.mjs",
  "scripts/package-standalone-artifact.mjs",
  "scripts/verify-deploy-state-machine.mjs",
  "scripts/verify-public-asset-release.mjs",
  "scripts/publish-public-assets-cos-vnext.mjs",
  "scripts/materialize-public-asset-release-vnext.mjs",
  "scripts/run-release-browser-acceptance.mjs",
]) {
  const checked = spawnSync(process.execPath, ["--check", path.join(root, script)], { encoding: "utf8" });
  assert.equal(checked.status, 0, `${script} syntax failed: ${checked.stderr || checked.stdout}`);
}

const audit = spawnSync(process.execPath, [path.join(root, "scripts/release-workflow.mjs"), "audit"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 10 * 1024 * 1024,
});
assert.equal(audit.status, 0, `release workflow audit failed: ${audit.stderr || audit.stdout}`);
const auditJson = JSON.parse(audit.stdout);
assert.equal(auditJson.status, "PASS");
assert.ok(auditJson.source.bytes < policy.source.maxBytes);
assert.ok(auditJson.externalAssets.bytes > auditJson.source.bytes);
assert.match(auditJson.externalAssets.pinnedDigest, /^[0-9a-f]{64}$/u);

console.log(JSON.stringify({
  ok: true,
  sourceFiles: auditJson.source.files,
  sourceBytes: auditJson.source.bytes,
  assetFiles: auditJson.externalAssets.files,
  assetBytes: auditJson.externalAssets.bytes,
  assetDigest: auditJson.externalAssets.pinnedDigest,
  productionBuild: policy.release.productionBuild,
}, null, 2));
