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

let helperCommandCount = 0;
function runHelper(args, expectedStatus = 0, expectedError = "") {
  helperCommandCount += 1;
  const result = run(process.execPath, [helper, ...args]);
  if (expectedStatus === 0) assert.equal(result.status, 0, `${args[0]} failed: ${result.stderr || result.stdout}`);
  else assert.notEqual(result.status, 0, `${args[0]} unexpectedly accepted a counterexample`);
  if (expectedError) assert.ok(result.stderr.includes(expectedError), `${args[0]} must reject with ${expectedError}: ${result.stderr}`);
  return result;
}

function replaceArgument(args, name, value) {
  const result = [...args];
  const index = result.indexOf(name);
  assert.ok(index >= 0 && index + 1 < result.length, `test argument missing: ${name}`);
  result[index + 1] = value;
  return result;
}

function rejectSuccessReceipt(args, expectedError) {
  runHelper(args, 1, expectedError);
  assert.equal(fs.existsSync(args[args.indexOf("--output") + 1]), false, "rejected source must not leave a success receipt");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function canonicalAttestation(document) {
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v1") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, environment: document.environment, systemIdentifier: document.systemIdentifier, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
  }
  if (document.schemaVersion === "zimeiti-production-postgres-identity.v2") {
    return JSON.stringify({ schemaVersion: document.schemaVersion, environment: document.environment, systemIdentifier: document.systemIdentifier, database: document.database, issuedEpoch: document.issuedEpoch, expiresEpoch: document.expiresEpoch });
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
const sourceBindingPosition = restoreSource.indexOf('node "$HELPER" validate-backup-source-identity');
const manifestPosition = restoreSource.indexOf('node "$HELPER" verify-manifest');
const metadataPosition = restoreSource.indexOf('node "$HELPER" validate-backup-metadata');
const requiredFilesPosition = restoreSource.indexOf('for required in postgres/database.dump');
const filesPosition = restoreSource.indexOf('PHASE="prepare-isolated-files"');
const pgRestorePosition = restoreSource.indexOf('PGSERVICE="$RESTORE_PG_SERVICE" pg_restore');
assert.ok(manifestPosition >= 0 && manifestPosition < metadataPosition && metadataPosition < requiredFilesPosition && requiredFilesPosition < sourceBindingPosition && sourceBindingPosition < filesPosition && filesPosition < pgRestorePosition, "verified package source must precede isolated file preparation and pg_restore");
assert.match(restoreSource.slice(sourceBindingPosition, filesPosition), /--backup-version "\$EXTRACTED\/postgres\/version\.json" --production-identity "\$RESTORE_PRODUCTION_IDENTITY_FILE" --attestation-key "\$RESTORE_PROVISIONING_HMAC_KEY_FILE" --now-epoch/u);
const rowCountSql = restoreSource.match(/> "\$WORK_ROOT\/postgres-row-counts\.json" <<'SQL'\r?\n([\s\S]*?)\r?\nSQL/u)?.[1];
assert.ok(rowCountSql, "actual row-count SQL heredoc must exist");
assert.match(rowCountSql, /^BEGIN;\s*create temporary table backup_row_counts[\s\S]*on commit drop;/u);
assert.match(rowCountSql, /select jsonb_object_agg\(name, rows order by name\) from backup_row_counts;\s*COMMIT;$/u);
const successCommand = restoreSource.split(/\r?\n/u).find(line => line.startsWith('node "$HELPER" write-restore-success-receipt'));
assert.ok(successCommand?.includes('--backup-version "$EXTRACTED/postgres/version.json"'));
assert.ok(successCommand.includes('--production-identity "$RESTORE_PRODUCTION_IDENTITY_FILE"'));
assert.ok(successCommand.includes('--attestation-key "$RESTORE_PROVISIONING_HMAC_KEY_FILE"'));
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
  const targetSystemIdentifier = "2222222222222222222";
  const productionSystemIdentifier = "1111111111111111111";
  const productionDatabase = " Production DB.汉字 ";
  const backupVersion = path.join(stage, "postgres", "version.json");
  const backupVersionValue = { serverVersion: "17.9-fixture", database: productionDatabase, databaseUser: "fixture_backup_role", systemIdentifier: productionSystemIdentifier, schema: "all-non-system", exportedSnapshot: "fixture-snapshot" };
  writeJson(backupVersion, backupVersionValue);
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
  const nonce = "ab".repeat(32);
  const production = sign({ schemaVersion: "zimeiti-production-postgres-identity.v1", environment: "production", systemIdentifier: productionSystemIdentifier, issuedEpoch: now - 60, expiresEpoch: now + 3600 }, key);
  const productionV2 = sign({ schemaVersion: "zimeiti-production-postgres-identity.v2", environment: "production", systemIdentifier: productionSystemIdentifier, database: productionDatabase, issuedEpoch: now - 60, expiresEpoch: now + 3600 }, key);
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
  const productionV2File = path.join(temporaryRoot, "production-v2.json");
  const provisioningFile = path.join(temporaryRoot, "provisioning.json");
  const identityFile = path.join(temporaryRoot, "identity.json");
  writeJson(productionFile, production);
  writeJson(productionV2File, productionV2);
  writeJson(provisioningFile, provisioning);
  writeJson(identityFile, identity);
  const beforeReport = path.join(temporaryRoot, "identity-before-report.json");
  const identityBaseArgs = ["--identity", identityFile, "--production-identity", productionFile, "--provisioning-receipt", provisioningFile, "--attestation-key", keyFile, "--expected-target-system-identifier", targetSystemIdentifier, "--expected-target-database", "zimeiti_restore_fixture", "--expected-target-role", "zimeiti_restore_role", "--now-epoch", String(now)];
  runHelper(["validate-restore-identity", ...identityBaseArgs, "--phase", "before", "--output", beforeReport]);

  const afterReport = path.join(temporaryRoot, "identity-after-report.json");
  runHelper(["validate-restore-identity", ...identityBaseArgs, "--phase", "after", "--expected-before-report", beforeReport, "--output", afterReport]);

  const v2BeforeReport = path.join(temporaryRoot, "identity-v2-before-report.json");
  runHelper(["validate-restore-identity", ...replaceArgument(identityBaseArgs, "--production-identity", productionV2File), "--phase", "before", "--output", v2BeforeReport]);
  assert.deepEqual(JSON.parse(read(v2BeforeReport)), JSON.parse(read(beforeReport)), "v1 and v2 retain the target-isolation report wire format");

  const sourceIdentityFileArgs = ["--backup-version", backupVersion, "--production-identity", productionV2File, "--attestation-key", keyFile];
  const sourceIdentityArgs = [...sourceIdentityFileArgs, "--now-epoch", String(now)];
  runHelper(["validate-backup-source-identity", ...sourceIdentityArgs]);
  const sourceCounterexamples = [
    ["different-cluster", { ...backupVersionValue, systemIdentifier: targetSystemIdentifier }, "BACKUP_SOURCE_SYSTEM_IDENTIFIER_MISMATCH"],
    ["same-cluster-other-database", { ...backupVersionValue, database: "other_production_database" }, "BACKUP_SOURCE_DATABASE_MISMATCH"],
    ["trimmed-database", { ...backupVersionValue, database: productionDatabase.trim() }, "BACKUP_SOURCE_DATABASE_MISMATCH"],
    ["database-case", { ...backupVersionValue, database: productionDatabase.toUpperCase() }, "BACKUP_SOURCE_DATABASE_MISMATCH"],
    ["missing-system-identifier", { database: productionDatabase }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["non-string-system-identifier", { ...backupVersionValue, systemIdentifier: 1111111111 }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["invalid-system-identifier", { ...backupVersionValue, systemIdentifier: "invalid" }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["missing-database", { systemIdentifier: productionSystemIdentifier }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["empty-database", { ...backupVersionValue, database: "" }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["nul-database", { ...backupVersionValue, database: "fixture\u0000database" }, "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["non-string-database", { ...backupVersionValue, database: 42 }, "BACKUP_SOURCE_IDENTITY_INVALID"],
  ];
  for (const [label, document, error] of sourceCounterexamples) {
    const file = path.join(temporaryRoot, `backup-source-${label}.json`);
    writeJson(file, document);
    runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, "--backup-version", file)], 1, error);
  }

  const productionCounterexamples = [
    ["tampered-database", { ...productionV2, database: "tampered_database" }, "ATTESTATION_SIGNATURE_MISMATCH"],
    ["tampered-cluster", { ...productionV2, systemIdentifier: targetSystemIdentifier }, "ATTESTATION_SIGNATURE_MISMATCH"],
    ["expired", sign({ ...productionV2, expiresEpoch: now - 1 }, key), "ATTESTATION_TIME_INVALID"],
    ["future-issued", sign({ ...productionV2, issuedEpoch: now + 301 }, key), "ATTESTATION_TIME_INVALID"],
    ["empty-signed-database", sign({ ...productionV2, database: "" }, key), "PRODUCTION_DATABASE_IDENTITY_REQUIRED"],
    ["nul-signed-database", sign({ ...productionV2, database: "fixture\u0000database" }, key), "PRODUCTION_DATABASE_IDENTITY_REQUIRED"],
    ["non-string-signed-database", sign({ ...productionV2, database: 42 }, key), "PRODUCTION_DATABASE_IDENTITY_REQUIRED"],
    ["wrong-environment", sign({ ...productionV2, environment: "staging" }, key), "PRODUCTION_IDENTITY_INVALID"],
    ["extra-field", { ...productionV2, unsignedDatabase: productionDatabase }, "RECEIPT_ADDITIONAL_PROPERTY:unsignedDatabase"],
  ];
  for (const [label, document, error] of productionCounterexamples) {
    const file = path.join(temporaryRoot, `production-source-${label}.json`);
    writeJson(file, document);
    runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, "--production-identity", file)], 1, error);
  }
  const malformedSourceFile = path.join(temporaryRoot, "malformed-backup-source.json");
  const malformedProductionFile = path.join(temporaryRoot, "malformed-production-identity.json");
  const malformedDocuments = [
    ["--backup-version", malformedSourceFile, "UNPARSEABLE_BACKUP_IDENTITY_FIXTURE", "BACKUP_SOURCE_IDENTITY_INVALID"],
    ["--production-identity", malformedProductionFile, "UNPARSEABLE_PRODUCTION_IDENTITY_FIXTURE", "PRODUCTION_DATABASE_IDENTITY_REQUIRED"],
  ];
  for (const [name, file, marker, error] of malformedDocuments) {
    fs.writeFileSync(file, `{${marker}`, "utf8");
    const result = runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, name, file)], 1, error);
    assert.equal(result.stderr.includes(marker), false, "invalid identity JSON must not expose document fragments");
  }
  runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, "--production-identity", productionFile)], 1, "PRODUCTION_DATABASE_IDENTITY_REQUIRED");
  const shortKeyFile = path.join(temporaryRoot, "short-attestation.key");
  fs.writeFileSync(shortKeyFile, Buffer.alloc(31));
  runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, "--attestation-key", shortKeyFile)], 1, "ATTESTATION_KEY_TOO_SHORT");
  const forbiddenIssuerOutput = path.join(temporaryRoot, "self-signed-production.json");
  runHelper(["sign-production-identity", "--backup-version", backupVersion, "--attestation-key", keyFile, "--output", forbiddenIssuerOutput], 1, "HELPER_COMMAND_INVALID:sign-production-identity");
  assert.equal(fs.existsSync(forbiddenIssuerOutput), false, "a backup package must never issue its own trusted production identity");

  const sameClusterProduction = path.join(temporaryRoot, "same-cluster-production.json");
  writeJson(sameClusterProduction, sign({ ...production, systemIdentifier: targetSystemIdentifier, signature: undefined }, key));
  runHelper(["validate-restore-identity", ...identityBaseArgs.map((item, index, all) => all[index - 1] === "--production-identity" ? sameClusterProduction : item), "--phase", "before", "--output", path.join(temporaryRoot, "same-cluster-report.json")], 1);

  const privilegedIdentityFile = path.join(temporaryRoot, "privileged-identity.json");
  writeJson(privilegedIdentityFile, { ...identity, roleSuper: true });
  runHelper(["validate-restore-identity", ...identityBaseArgs.map((item, index, all) => all[index - 1] === "--identity" ? privilegedIdentityFile : item), "--phase", "before", "--output", path.join(temporaryRoot, "privileged-report.json")], 1);

  const wrongNonceFile = path.join(temporaryRoot, "wrong-nonce-identity.json");
  writeJson(wrongNonceFile, { ...identity, provisioningNonce: "cd".repeat(32) });
  runHelper(["validate-restore-identity", ...replaceArgument(identityBaseArgs, "--identity", wrongNonceFile), "--phase", "before", "--output", path.join(temporaryRoot, "wrong-nonce-report.json")], 1, "TARGET_IDENTITY_MISMATCH");
  const tamperedProvisioningFile = path.join(temporaryRoot, "tampered-provisioning.json");
  writeJson(tamperedProvisioningFile, { ...provisioning, provisioningNonce: "cd".repeat(32) });
  runHelper(["validate-restore-identity", ...replaceArgument(identityBaseArgs, "--provisioning-receipt", tamperedProvisioningFile), "--phase", "before", "--output", path.join(temporaryRoot, "tampered-provisioning-report.json")], 1, "ATTESTATION_SIGNATURE_MISMATCH");

  const restoreReceipt = path.join(temporaryRoot, "restore-receipt.json");
  const successReceiptArgs = ["write-restore-success-receipt", "--output", restoreReceipt, "--restore-id", "restore-20261010T000000Z-1", "--phase", "complete", "--target-database", "zimeiti_restore_fixture", "--started-epoch", String(now), "--completed-epoch", String(now + 5), "--package-sha256", crypto.createHash("sha256").update(fs.readFileSync(encryptedPackage)).digest("hex"), "--metadata", metadata, "--before-identity", beforeReport, "--after-identity", afterReport, "--isolated-file-root", path.join(temporaryRoot, "zimeiti-restore-fixture"), ...sourceIdentityFileArgs];
  runHelper(successReceiptArgs);
  runHelper(["validate-receipt", "--kind", "restore", "--document", restoreReceipt]);
  const restoreReceiptValue = JSON.parse(read(restoreReceipt));
  assert.ok(restoreReceiptValue.backupAgeAtRestoreStartSeconds >= 0);
  assert.equal(restoreReceiptValue.packageHashVerifiedAfterRestore, true);
  assert.ok(!JSON.stringify(restoreReceiptValue).includes("postgres://"));
  assert.ok(!Object.hasOwn(restoreReceiptValue, "serviceRpoSeconds"));
  assert.ok(!Object.hasOwn(restoreReceiptValue, "sourceDatabase"));
  assert.ok(!Object.hasOwn(restoreReceiptValue, "schemaReady"));

  for (const [label, , error] of sourceCounterexamples) {
    const args = replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, `bad-source-success-${label}.json`)), "--backup-version", path.join(temporaryRoot, `backup-source-${label}.json`));
    rejectSuccessReceipt(args, error);
  }
  for (const [name, file, marker, error] of malformedDocuments) {
    const args = replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, `malformed-${name.slice(2)}-success.json`)), name, file);
    const result = runHelper(args, 1, error);
    assert.equal(result.stderr.includes(marker), false);
    assert.equal(fs.existsSync(args[args.indexOf("--output") + 1]), false, "malformed source must not leave a success receipt");
  }
  rejectSuccessReceipt(replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, "v1-success.json")), "--production-identity", productionFile), "PRODUCTION_DATABASE_IDENTITY_REQUIRED");
  const expiresDuringRestoreFile = path.join(temporaryRoot, "expires-during-restore-production.json");
  writeJson(expiresDuringRestoreFile, sign({ ...productionV2, expiresEpoch: now + 3 }, key));
  runHelper(["validate-backup-source-identity", ...replaceArgument(sourceIdentityArgs, "--production-identity", expiresDuringRestoreFile)]);
  rejectSuccessReceipt(replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, "expired-at-completion-success.json")), "--production-identity", expiresDuringRestoreFile), "ATTESTATION_TIME_INVALID");
  const noSourceReceiptArgs = successReceiptArgs.slice(0, successReceiptArgs.indexOf("--backup-version"));
  rejectSuccessReceipt(replaceArgument(noSourceReceiptArgs, "--output", path.join(temporaryRoot, "missing-source-success.json")), "ARGUMENT_REQUIRED:--backup-version");
  const failureReceipt = path.join(temporaryRoot, "source-failure-receipt.json");
  runHelper(["write-restore-failure-receipt", "--output", failureReceipt, "--restore-id", "restore-20261010T000000Z-4", "--phase", "validate-backup-source-identity", "--target-database", "unknown", "--started-epoch", String(now), "--completed-epoch", String(now + 5), "--package-sha256", restoreReceiptValue.encryptedPackageSha256]);
  runHelper(["validate-receipt", "--kind", "restore", "--document", failureReceipt]);
  assert.equal(JSON.parse(read(failureReceipt)).status, "failed");

  const injectedReceipt = path.join(temporaryRoot, "injected-restore-receipt.json");
  writeJson(injectedReceipt, { ...restoreReceiptValue, serviceRpoSeconds: 1 });
  runHelper(["validate-receipt", "--kind", "restore", "--document", injectedReceipt], 1);
  rejectSuccessReceipt(replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, "path-injection.json")), "--isolated-file-root", path.join(temporaryRoot, "zimeiti-restore-safe\n\"injected")), "RESTORE_RECEIPT_SUCCESS_VALUE_INVALID");

  const futureMetadata = path.join(temporaryRoot, "future-metadata.json");
  writeJson(futureMetadata, { ...metadataValue, createdEpoch: now + 100, componentSnapshots: metadataValue.componentSnapshots.map(item => ({ ...item, startedEpoch: now + 100, completedEpoch: now + 100 })) });
  rejectSuccessReceipt(replaceArgument(replaceArgument(successReceiptArgs, "--output", path.join(temporaryRoot, "negative-age.json")), "--metadata", futureMetadata), "RESTORE_BACKUP_AGE_NEGATIVE");

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "zimeiti-backup-restore-zero-network-test.v2",
    passed: true,
    nodeExecutable: process.execPath,
    nodeVersion: process.version,
    helperCommandCount,
    networkCalls: 0,
    productionWrites: 0,
    sourceBinding: { signedV2Accepted: true, rawDatabaseNamePreserved: true, v1TargetIdentityCompatible: true, v1SourceIdentityRejected: true, sourceCounterexamples: sourceCounterexamples.length, attestationCounterexamples: productionCounterexamples.length, malformedIdentityDocumentsSanitized: malformedDocuments.length, invalidSourceCannotWriteSuccess: true, completedEpochRechecked: true, failedReceiptWithoutSourceAccepted: true, productionIdentitySelfIssuerRejected: true, manifestBeforeSourceBeforeWrites: true, rowCountTransactionSourceVerified: true, realPostgresSqlRegression: "NOT_EXECUTED_BY_THIS_TEST" },
    executableCounterexamples: {
      nestedBackupRootRejected: true,
      stalePlaintextStagingRejected: true,
      sqliteHashMismatchRejected: true,
      restoredTreeHashMismatchRejected: true,
      manifestTamperRejected: true,
      falseSuccessReceiptRejected: true,
      sameClusterRestoreRejected: true,
      privilegedRestoreRoleRejected: true,
      wrongNonceRejected: true,
      provisioningSignatureTamperRejected: true,
      extraServiceRpoRejected: true,
      receiptPathInjectionRejected: true,
      negativeBackupAgeRejected: true
    }
  }, null, 2)}\n`);
} finally {
  assert.ok(temporaryRoot.startsWith(os.tmpdir()), "temporary fixture root escaped OS temp");
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
