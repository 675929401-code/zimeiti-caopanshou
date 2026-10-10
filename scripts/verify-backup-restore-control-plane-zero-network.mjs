#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(projectRoot, "scripts", "backup-recovery-helper.mjs");
const postgresHelper = path.join(projectRoot, "scripts", "backup-postgres-consistent.mjs");
const backupScript = path.join(projectRoot, "runtime-tools", "backup-data.sh");
const restoreScript = path.join(projectRoot, "scripts", "restore-data.sh");
const runbook = path.join(projectRoot, "docs", "deployment", "BACKUP-RESTORE-CONTROL-PLANE.md");
const backupSchemaPath = path.join(projectRoot, "scripts", "contracts", "backup-receipt.v1.schema.json");
const restoreSchemaPath = path.join(projectRoot, "scripts", "contracts", "restore-receipt.v1.schema.json");
const read = file => fs.readFileSync(file, "utf8");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
}

function runHelper(args, expectedStatus = 0) {
  const result = run(process.execPath, [helper, ...args]);
  if (expectedStatus === 0) assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.stdout}`);
  else assert.notEqual(result.status, 0, `${args[0]} unexpectedly accepted a counterexample`);
  return result;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalAttestation(document) {
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v1") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, environment: document.environment, systemIdentifier: document.systemIdentifier, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
  }
  return JSON.stringify({ schemaVersion: document.schemaVersion, targetSystemIdentifier: document.targetSystemIdentifier, targetDatabase: document.targetDatabase, targetRole: document.targetRole, provisioningNonce: document.provisioningNonce, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
}

function sign(document, key) {
  return { ...document, signature: crypto.createHmac("sha256", key).update(canonicalAttestation(document)).digest("hex") };
}

const backupSource = read(backupScript);
const restoreSource = read(restoreScript);
const postgresSource = read(postgresHelper);
const docs = read(runbook);
const backupSchema = JSON.parse(read(backupSchemaPath));
const restoreSchema = JSON.parse(read(restoreSchemaPath));

assert.match(backupSource, /stat -Lc '%d'/u, "backup device identity must use stat.st_dev");
assert.match(restoreSource, /stat -Lc '%d'/u, "restore device identity must use stat.st_dev");
assert.doesNotMatch(backupSource, /findmnt -n -o SOURCE -T \/\)/u, "findmnt SOURCE must not identify the system device");
assert.doesNotMatch(restoreSource, /RESTORE_DATABASE_URL/u, "restore URLs must not enter the control plane");
assert.match(backupSource, /stable-copy-tree/u, "file roots must use executable pre/post stability checks");
assert.match(restoreSource, /POST_RESTORE_PACKAGE_SHA256_MISMATCH/u, "restore must hash the package again after restore");
assert.match(restoreSource, /system_identifier::text from pg_control_system/u, "restore must query PostgreSQL cluster identity");
assert.match(restoreSource, /pre-pgrestore-identity-recheck/u, "restore must recheck identity immediately before pg_restore");
assert.match(postgresSource, /postgres-component-snapshot\.json/u, "PostgreSQL component snapshot evidence is required");
assert.match(postgresSource, /system_identifier/u, "PostgreSQL backup identity must include system_identifier");
assert.match(docs, /仅支持 Linux/u);
assert.match(docs, /productionConsistency.*incomplete/u);
assert.match(docs, /SIGKILL/u);
assert.doesNotMatch(docs, /共同时间点快照[^：]*：\s*是/u);

assert.equal(backupSchema.additionalProperties, false);
assert.equal(backupSchema.$defs.componentSnapshot.additionalProperties, false);
assert.equal(backupSchema.properties.productionConsistencyComplete.const, false);
assert.equal(backupSchema.properties.finalPackageHashVerified.const, true);
assert.equal(restoreSchema.additionalProperties, false);
assert.equal(restoreSchema.properties.productionOverwriteAttempted.const, false);
assert.equal(restoreSchema.properties.targetClusterDistinctFromProduction.const, true);
assert.equal(restoreSchema.properties.packageHashVerifiedAfterRestore.const, true);
assert.ok(!Object.hasOwn(restoreSchema.properties, "serviceRpoSeconds"));
assert.ok(!Object.hasOwn(restoreSchema.properties, "serviceRtoSeconds"));

const bashCandidates = [
  process.env.BASH_EXE,
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Users\\Administrator\\.workbuddy\\vendor\\PortableGit.old.16688\\usr\\bin\\bash.exe",
].filter(Boolean);
const bash = bashCandidates.find(candidate => fs.existsSync(candidate));
assert.ok(bash, "BASH_RUNTIME_REQUIRED_FOR_SYNTAX_CHECK");
const bashEnvironment = { PATH: `${path.dirname(bash)};${process.env.PATH || ""}`, TMPDIR: os.tmpdir() };
for (const script of [backupScript, restoreScript]) {
  const syntax = run(bash, ["-n", script], { env: bashEnvironment });
  assert.equal(syntax.status, 0, `bash -n failed for ${path.basename(script)}: ${syntax.stderr}`);
  const plan = run(bash, [script, "--plan"], { env: bashEnvironment });
  assert.equal(plan.status, 0, `plan failed for ${path.basename(script)}: ${plan.stderr}`);
  const parsed = JSON.parse(plan.stdout);
  assert.match(parsed.schemaVersion, /^zimeiti-(backup|restore)-plan\.v2$/u);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zimeiti-backup-control-v2-"));
try {
  const sourceRoot = path.join(temporaryRoot, "source");
  const nestedBackup = path.join(sourceRoot, "backup");
  const siblingBackup = path.join(temporaryRoot, "backup");
  fs.mkdirSync(nestedBackup, { recursive: true });
  fs.mkdirSync(siblingBackup);
  runHelper(["assert-disjoint", "--left", sourceRoot, "--right", nestedBackup], 1);
  runHelper(["assert-disjoint", "--left", sourceRoot, "--right", siblingBackup]);

  const residue = path.join(temporaryRoot, "zimeiti-backup-plaintext-staging");
  fs.mkdirSync(residue);
  runHelper(["assert-path-absent", "--path", residue], 1);
  fs.rmSync(residue, { recursive: true });
  runHelper(["assert-path-absent", "--path", residue]);

  const commerce = path.join(temporaryRoot, "commerce.sqlite");
  const voice = path.join(temporaryRoot, "voice.db");
  for (const [databasePath, table, values] of [[commerce, "records", ["one", "two"]], [voice, "voices", ["vivi"]]]) {
    const database = new DatabaseSync(databasePath);
    database.exec(`PRAGMA journal_mode=WAL; CREATE TABLE ${table}(id INTEGER PRIMARY KEY,value TEXT NOT NULL);`);
    const insert = database.prepare(`INSERT INTO ${table}(value) VALUES (?)`);
    for (const value of values) insert.run(value);
    database.close();
  }

  const stage = path.join(temporaryRoot, "stage");
  fs.mkdirSync(path.join(stage, "sqlite"), { recursive: true });
  fs.mkdirSync(path.join(stage, "audits"), { recursive: true });
  fs.mkdirSync(path.join(stage, "metadata"), { recursive: true });
  const commerceCopy = path.join(stage, "sqlite", "commerce.sqlite");
  const commerceAudit = path.join(stage, "audits", "commerce.json");
  const voiceCopy = path.join(stage, "sqlite", "voice.sqlite");
  const voiceAudit = path.join(stage, "audits", "voice.json");
  runHelper(["sqlite-backup", "--source", commerce, "--destination", commerceCopy, "--report", commerceAudit, "--label", "commerce-sqlite"]);
  runHelper(["sqlite-backup", "--source", voice, "--destination", voiceCopy, "--report", voiceAudit, "--label", "voice-sqlite"]);

  const restoredAudit = path.join(temporaryRoot, "commerce-restored.json");
  runHelper(["sqlite-audit", "--source", commerceCopy, "--report", restoredAudit]);
  runHelper(["compare-sqlite-audit", "--expected", commerceAudit, "--actual", restoredAudit, "--label", "COMMERCE"]);
  const badSqliteAudit = path.join(temporaryRoot, "commerce-bad-audit.json");
  writeJson(badSqliteAudit, { ...JSON.parse(read(restoredAudit)), sha256: "0".repeat(64) });
  runHelper(["compare-sqlite-audit", "--expected", commerceAudit, "--actual", badSqliteAudit, "--label", "COMMERCE"], 1);

  const treeSource = path.join(temporaryRoot, "tree-source");
  fs.mkdirSync(path.join(treeSource, "nested"), { recursive: true });
  fs.writeFileSync(path.join(treeSource, "nested", "asset.bin"), Buffer.from("fixture-asset"));
  const treeDestination = path.join(stage, "files", "app-data");
  const treeReport = path.join(stage, "audits", "app-data-tree.json");
  runHelper(["stable-copy-tree", "--source", treeSource, "--destination", treeDestination, "--report", treeReport, "--label", "app-data"]);
  const treeEvidence = JSON.parse(read(treeReport));
  assert.equal(treeEvidence.stableBeforeAndAfter, true);
  assert.equal(treeEvidence.destinationMatchesSource, true);
  runHelper(["compare-tree", "--expected-root", treeSource, "--actual-root", treeDestination, "--label", "APP_DATA"]);

  const now = Math.floor(Date.now() / 1000);
  const componentNames = ["postgresql", "commerce-sqlite", "voice-sqlite", "app-data", "commerce-assets", "voice-reference-audio", "uploads", "public-assets"];
  const componentReports = [];
  for (const [index, component] of componentNames.entries()) {
    const file = path.join(stage, "audits", `component-${index}.json`);
    writeJson(file, {
      componentSnapshot: {
        component,
        method: component === "postgresql" ? "exported-repeatable-read-snapshot" : component.endsWith("sqlite") ? "sqlite-online-backup" : "pre-post-sha256-tree",
        startedEpoch: now - 20,
        completedEpoch: now - 10,
        consistency: "verified",
        sharedWithOtherComponents: false,
        evidenceSha256: crypto.createHash("sha256").update(component).digest("hex"),
      },
    });
    componentReports.push(file);
  }
  const metadata = path.join(stage, "metadata", "package.json");
  const metadataArgs = ["write-backup-metadata", "--output", metadata, "--backup-id", "backup-20261010T000000Z-1", "--source-version", "R000001-test", "--created-epoch", String(now - 30)];
  for (const file of componentReports) metadataArgs.push("--component-report", file);
  runHelper(metadataArgs);
  runHelper(["validate-backup-metadata", "--document", metadata]);
  const metadataValue = JSON.parse(read(metadata));
  assert.equal(metadataValue.sharedSnapshot, false);
  assert.equal(metadataValue.productionConsistency, "incomplete");

  const manifest = path.join(stage, "manifest.json");
  runHelper(["build-manifest", "--root", stage, "--metadata", metadata, "--output", manifest]);
  runHelper(["verify-manifest", "--root", stage, "--manifest", manifest]);
  fs.appendFileSync(path.join(stage, "files", "app-data", "nested", "asset.bin"), "tampered");
  runHelper(["compare-tree", "--expected-root", treeSource, "--actual-root", treeDestination, "--label", "APP_DATA"], 1);
  runHelper(["verify-manifest", "--root", stage, "--manifest", manifest], 1);

  const encryptedPackage = path.join(temporaryRoot, "package.tar.gz.age");
  fs.writeFileSync(encryptedPackage, crypto.randomBytes(64));
  const backupReceipt = path.join(temporaryRoot, "backup-receipt.json");
  runHelper(["write-backup-receipt", "--output", backupReceipt, "--metadata", metadata, "--encrypted-package", encryptedPackage, "--manifest", manifest, "--completed-epoch", String(now)]);
  runHelper(["validate-receipt", "--kind", "backup", "--document", backupReceipt]);
  const backupReceiptValue = JSON.parse(read(backupReceipt));
  assert.equal(backupReceiptValue.productionConsistencyComplete, false);
  assert.equal(backupReceiptValue.componentSnapshots.length, 8);
  const lyingBackupReceipt = path.join(temporaryRoot, "lying-backup-receipt.json");
  writeJson(lyingBackupReceipt, { ...backupReceiptValue, productionConsistencyComplete: true });
  runHelper(["validate-receipt", "--kind", "backup", "--document", lyingBackupReceipt], 1);

  const key = Buffer.from("0123456789abcdef".repeat(4));
  const keyFile = path.join(temporaryRoot, "attestation.key");
  fs.writeFileSync(keyFile, key);
  const targetSystemIdentifier = "2222222222222222222";
  const productionSystemIdentifier = "1111111111111111111";
  const nonce = "ab".repeat(32);
  const production = sign({ schemaVersion: "zimeiti-production-postgres-identity.v1", environment: "production", systemIdentifier: productionSystemIdentifier, issuedEpoch: now - 60, expiresEpoch: now + 3600 }, key);
  const provisioning = sign({ schemaVersion: "zimeiti-restore-provisioning-receipt.v1", targetSystemIdentifier, targetDatabase: "zimeiti_restore_fixture", targetRole: "zimeiti_restore_role", provisioningNonce: nonce, issuedEpoch: now - 60, expiresEpoch: now + 3600 }, key);
  const identity = {
    systemIdentifier: targetSystemIdentifier,
    database: "zimeiti_restore_fixture",
    role: "zimeiti_restore_role",
    provisioningNonce: nonce,
    roleSuper: false,
    roleCreateRole: false,
    roleCreateDb: false,
    roleReplication: false,
    roleBypassRls: false,
    databaseConnect: true,
    databaseCreate: true,
    databaseTemporary: true,
    publicSchemaCreate: true,
  };
  const productionFile = path.join(temporaryRoot, "production.json");
  const provisioningFile = path.join(temporaryRoot, "provisioning.json");
  const identityFile = path.join(temporaryRoot, "identity.json");
  writeJson(productionFile, production);
  writeJson(provisioningFile, provisioning);
  writeJson(identityFile, identity);
  const beforeReport = path.join(temporaryRoot, "identity-before-report.json");
  const identityBaseArgs = ["--identity", identityFile, "--production-identity", productionFile, "--provisioning-receipt", provisioningFile, "--attestation-key", keyFile, "--expected-target-system-identifier", targetSystemIdentifier, "--expected-target-database", "zimeiti_restore_fixture", "--expected-target-role", "zimeiti_restore_role", "--now-epoch", String(now)];
  runHelper(["validate-restore-identity", ...identityBaseArgs, "--phase", "before", "--output", beforeReport]);

  const afterReport = path.join(temporaryRoot, "identity-after-report.json");
  runHelper(["validate-restore-identity", ...identityBaseArgs, "--phase", "after", "--expected-before-report", beforeReport, "--output", afterReport]);

  const sameClusterProduction = path.join(temporaryRoot, "same-cluster-production.json");
  writeJson(sameClusterProduction, sign({ ...production, systemIdentifier: targetSystemIdentifier, signature: undefined }, key));
  runHelper(["validate-restore-identity", ...identityBaseArgs.map((item, index, all) => all[index - 1] === "--production-identity" ? sameClusterProduction : item), "--phase", "before", "--output", path.join(temporaryRoot, "same-cluster-report.json")], 1);

  const privilegedIdentityFile = path.join(temporaryRoot, "privileged-identity.json");
  writeJson(privilegedIdentityFile, { ...identity, roleSuper: true });
  runHelper(["validate-restore-identity", ...identityBaseArgs.map((item, index, all) => all[index - 1] === "--identity" ? privilegedIdentityFile : item), "--phase", "before", "--output", path.join(temporaryRoot, "privileged-report.json")], 1);

  const restoreReceipt = path.join(temporaryRoot, "restore-receipt.json");
  runHelper(["write-restore-success-receipt", "--output", restoreReceipt, "--restore-id", "restore-20261010T000000Z-1", "--phase", "complete", "--target-database", "zimeiti_restore_fixture", "--started-epoch", String(now), "--completed-epoch", String(now + 5), "--package-sha256", crypto.createHash("sha256").update(fs.readFileSync(encryptedPackage)).digest("hex"), "--metadata", metadata, "--before-identity", beforeReport, "--after-identity", afterReport, "--isolated-file-root", path.join(temporaryRoot, "zimeiti-restore-fixture")]);
  runHelper(["validate-receipt", "--kind", "restore", "--document", restoreReceipt]);
  const restoreReceiptValue = JSON.parse(read(restoreReceipt));
  assert.ok(restoreReceiptValue.backupAgeAtRestoreStartSeconds >= 0);
  assert.equal(restoreReceiptValue.packageHashVerifiedAfterRestore, true);
  assert.ok(!JSON.stringify(restoreReceiptValue).includes("postgres://"));
  assert.ok(!Object.hasOwn(restoreReceiptValue, "serviceRpoSeconds"));

  const injectedReceipt = path.join(temporaryRoot, "injected-restore-receipt.json");
  writeJson(injectedReceipt, { ...restoreReceiptValue, serviceRpoSeconds: 1 });
  runHelper(["validate-receipt", "--kind", "restore", "--document", injectedReceipt], 1);
  runHelper(["write-restore-success-receipt", "--output", path.join(temporaryRoot, "path-injection.json"), "--restore-id", "restore-20261010T000000Z-3", "--phase", "complete", "--target-database", "zimeiti_restore_fixture", "--started-epoch", String(now), "--completed-epoch", String(now + 5), "--package-sha256", restoreReceiptValue.encryptedPackageSha256, "--metadata", metadata, "--before-identity", beforeReport, "--after-identity", afterReport, "--isolated-file-root", path.join(temporaryRoot, "zimeiti-restore-safe\n\"injected")], 1);

  const futureMetadata = path.join(temporaryRoot, "future-metadata.json");
  writeJson(futureMetadata, { ...metadataValue, createdEpoch: now + 100, componentSnapshots: metadataValue.componentSnapshots.map(item => ({ ...item, startedEpoch: now + 100, completedEpoch: now + 100 })) });
  runHelper(["write-restore-success-receipt", "--output", path.join(temporaryRoot, "negative-age.json"), "--restore-id", "restore-20261010T000000Z-2", "--phase", "complete", "--target-database", "zimeiti_restore_fixture", "--started-epoch", String(now), "--completed-epoch", String(now + 5), "--package-sha256", restoreReceiptValue.encryptedPackageSha256, "--metadata", futureMetadata, "--before-identity", beforeReport, "--after-identity", afterReport, "--isolated-file-root", path.join(temporaryRoot, "zimeiti-restore-fixture")], 1);

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "zimeiti-backup-restore-zero-network-test.v2",
    passed: true,
    networkCalls: 0,
    productionWrites: 0,
    executableCounterexamples: {
      nestedBackupRootRejected: true,
      stalePlaintextStagingRejected: true,
      sqliteHashMismatchRejected: true,
      restoredTreeHashMismatchRejected: true,
      manifestTamperRejected: true,
      falseSuccessReceiptRejected: true,
      sameClusterRestoreRejected: true,
      privilegedRestoreRoleRejected: true,
      extraServiceRpoRejected: true,
      receiptPathInjectionRejected: true,
      negativeBackupAgeRejected: true
    }
  }, null, 2)}\n`);
} finally {
  assert.ok(temporaryRoot.startsWith(os.tmpdir()), "temporary fixture root escaped OS temp");
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
