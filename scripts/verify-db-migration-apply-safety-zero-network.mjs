#!/usr/bin/env node
// Actual runner functions with synthetic RAM files/pg; no database or Git writes.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import pg from "pg";
import { postgresErrorDiagnostics } from "./lib/postgres-error-diagnostics.mjs";
import { readDatabaseTargetIdentity } from "./lib/database-target-identity.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");
assert.equal(process.version, "v24.19.0");
const source = fs.readFileSync("scripts/db-migration-release.mjs", "utf8");
const ast = ts.createSourceFile("runner.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(node => [node.name.text, node.getText(ast)]));
const names = ["sha256", "stableJson", "confirmedWriteTarget", "verifiedFileBytes", "verifiedArchiveDigest", "confirmedDatabaseBackup", "assertBackupFields", "normalizedLoopbackHost", "isIsoTimestamp", "verifiedBackupEvidence", "verifiedMigrationSql", "assertLiveWriteTarget", "databaseTargetIdentity", "readAppliedVersions", "appliedMigrationHashDrifts", "ensureMigrationLedger", "applySql", "apply", "adoptSemanticNoops", "semanticReceiptDigest", "safeReleaseErrorCode"];
const realFunctions = names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join("\n");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const stable = value => value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
const root = path.resolve("synthetic-migration-fixture");
const sql = "begin;\nselect 'synthetic migration';\ncommit;\n";
const migration = { warnings: [], errors: [], version: "20990101000000", name: "20990101000000_safe.sql", slug: "safe", file: "migrations/20990101000000_safe.sql", sha256: digest(sql), valid: true, transactionMode: "self-contained" };
const identity = { database_name: "business", server_version: "170000", server_address: "127.0.0.1/32", server_port: "54322" };
const fingerprint = digest(stable({ configuredHost: "127.0.0.1", databaseName: identity.database_name, serverVersion: identity.server_version, serverAddress: identity.server_address, serverPort: identity.server_port }));
let passed = 0;
async function fixture(change = () => {}, mode = "apply") {
  const archive = Buffer.from("PGDMP synthetic fixture, not a real backup");
  const restore = { kind: "database-isolated-restore-report.v1", archiveSha256: digest(archive), sourceTargetFingerprint: fingerprint, exitCode: 0, targetIsolated: true, target: { host: "127.0.0.1", port: 54323, database: "restore_fixture" }, checks: { schema: true, data: true }, completedAt: "2026-10-01T00:00:04Z" };
  const listing = Buffer.from("1; 0 0 SCHEMA - synthetic\n");
  const receipt = { kind: "pre-migration-database-backup-receipt.v1", schemaVersion: 1, targetClass: "local-loopback-only", targetHost: "127.0.0.1", targetPort: 54322, database: "business", targetFingerprint: fingerprint, createdAt: "2026-10-01T00:00:00Z", completedAt: "2026-10-01T00:00:03Z", archivePath: "archive.dump", archiveSha256: digest(archive), archiveBytes: archive.length, format: "postgres-custom", readability: { tool: "pg_restore --list", exitCode: 0, entryCount: 1, evidencePath: "list.txt", evidenceSha256: digest(listing) }, restore: { status: "verified", evidencePath: "restore.json", evidenceSha256: digest(JSON.stringify(restore)) } };
  const options = { receipt, restore, archive, listing, live: { ...identity }, confirmedTargetHost: "127.0.0.1", confirmedTargetPort: 54322, confirmedTargetDatabase: "business", confirmedTargetFingerprint: fingerprint, url: "postgresql://fixture@127.0.0.1:54322/business", ledger: [], mutateSqlAt: "", failLedger: false, backupMissing: false, tamperArchive: false, tamperReceipt: false, tamperRestore: false };
  change(options);
  receipt.restore.evidenceSha256 = digest(JSON.stringify(restore));
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const files = new Map([[path.join(root, "receipt.json"), options.tamperReceipt ? Buffer.concat([receiptBytes, Buffer.from(" ")]) : receiptBytes], [path.join(root, "archive.dump"), options.tamperArchive ? Buffer.from("tampered") : options.archive], [path.join(root, "restore.json"), options.tamperRestore ? Buffer.from("tampered") : Buffer.from(JSON.stringify(restore))], [path.join(root, "list.txt"), options.listing], [path.join(root, migration.file), Buffer.from(sql)]]);
  if (options.backupMissing) files.delete(path.join(root, "receipt.json"));
  if (options.mutateSqlAt === "preflight") files.set(path.join(root, migration.file), Buffer.from("changed"));
  const semantic = { kind: "migration-semantic-noop-receipt", semanticCheckVersion: "catalog-and-transaction-noop.v2", targetFingerprint: fingerprint, manifestSha256: "c".repeat(64), databaseWrites: 0, committedMigrationSql: 0, results: [{ ...migration, eligible: true, beforeCatalogSha256: "before", afterCatalogSha256: "after" }] };
  semantic.receiptSha256 = digest(stable(semantic));
  files.set(path.join(root, "semantic.json"), Buffer.from(JSON.stringify(semantic)));
  const calls = [], writes = [], handles = new Map(); let appliedSql = 0, result, archiveReadChunks = 0;
  const fileStat = file => { if (!files.has(file)) throw Error("missing"); return { size: files.get(file).length, ino: 1, dev: 1, mtimeMs: 1, ctimeMs: 1, isFile: () => true }; };
  const client = {
    async connect() { if (options.mutateSqlAt === "connect") files.set(path.join(root, migration.file), Buffer.from("changed")); }, async end() {},
    async query(text) {
      calls.push(text);
      if (text.includes("current_database()")) return { rows: [options.live] };
      if (text.includes("to_regclass(")) return { rows: [{ table_name: options.ledger.length ? "ledger" : null }] };
      if (text.includes("select version::text")) return { rows: options.ledger };
      if (/^\s*(create|alter|insert|begin;)/iu.test(text)) writes.push(text);
      if (text === sql) appliedSql++;
      if (text.includes("insert into") && options.failLedger) throw new Error("provider password=DO_NOT_PRINT");
      return { rows: [{ version: migration.version }], rowCount: 1 };
    },
  };
  const context = {
    crypto, Buffer, URL, path, root, Date, console, pg, postgresErrorDiagnostics, readDatabaseTargetIdentity, policy: { database: { preMigrationBackupRequired: true } },
    fs: { statSync: fileStat, openSync: file => { fileStat(file);const fd=handles.size+1;handles.set(fd,{file,position:0});return fd; }, fstatSync: fd=>({...fileStat(handles.get(fd).file),mtimeMs:options.archiveChanged && handles.get(fd).position>0 ? 2 : 1}), readSync: (fd,chunk,offset,length)=>{const h=handles.get(fd),data=files.get(h.file),count=Math.min(length,data.length-h.position);data.copy(chunk,offset,h.position,h.position+count);h.position+=count;archiveReadChunks++;return count;}, closeSync: fd=>handles.delete(fd), readFileSync: (file, encoding) => { assert.ok(!file.endsWith(".dump"),"Archive must never use readFileSync");if (!files.has(file)) throw Error("missing"); const bytes = files.get(file); return encoding ? bytes.toString(encoding) : bytes; }, existsSync: file => files.has(file) },
    ...options, confirmedBackup: "receipt.json", confirmedBackupReceiptFileSha256: digest(receiptBytes), confirmedBackupArchiveSha256: options.confirmedBackupArchiveSha256 || digest(archive), confirmedManifestSha256: "c".repeat(64),
    databaseConfig: () => ({ configured: true, host: options.confirmedTargetHost, value: options.url, envName: "SYNTHETIC_FIXTURE" }),
    listMigrations: () => [{ ...migration }], migrationManifest: () => ({ manifestSha256: "c".repeat(64), projectId: "fixture", excludedForwardMigrations: [] }), pgClient: () => client,
    writeResult: value => { result = value; }, applyProgress: null, selectedOnly: [], onlySelectionReport: {}, actor: "synthetic", ADVISORY_LOCK_ID: "fixture-lock", hasFlag: () => false,
    semanticReceiptPath: "semantic.json", confirmedSemanticReceiptSha256: semantic.receiptSha256, SEMANTIC_CHECK_VERSION: "catalog-and-transaction-noop.v2", readJson: file => JSON.parse(files.get(file).toString()),
    pendingMigrationsFor: async () => [{ ...migration }], probeMigrationSemanticNoop: async () => ({ eligible: true, beforeCatalogSha256: "before", afterCatalogSha256: "after" }),
  };
  vm.createContext(context); vm.runInContext(realFunctions + "\nthis.run = " + (mode === "adopt" ? "adoptSemanticNoops" : "apply") + ";", context);
  let error;
  try { await context.run(); } catch (caught) { error = caught; }
  return { error, writes, calls, appliedSql, result, context, archiveReadChunks };
}
async function rejects(change, code, mode) {
  const result = await fixture(change, mode);
  assert.ok(result.error, code); assert.match(result.error.message, new RegExp(code));
  assert.equal(result.writes.length, 0, "Gate failure must precede first DDL/DML"); assert.equal(result.appliedSql, 0); passed++;
}
await rejects(o => { o.confirmedTargetDatabase = "different"; }, "TARGET_DATABASE");
await rejects(o => { o.confirmedTargetPort = 54324; }, "TARGET_PORT");
await rejects(o => { o.live.database_name = "same_host_other_db"; }, "LIVE_DATABASE_TARGET");
await rejects(o => { o.live.server_port = "54324"; }, "TARGET_FINGERPRINT");
await rejects(o => { o.confirmedTargetFingerprint = ""; }, "TARGET_FINGERPRINT");
await rejects(o => { o.confirmedTargetFingerprint = "d".repeat(64); o.receipt.targetFingerprint = o.confirmedTargetFingerprint; o.restore.sourceTargetFingerprint = o.confirmedTargetFingerprint; }, "TARGET_FINGERPRINT");
await rejects(o => { o.backupMissing = true; }, "BACKUP_RECEIPT_NOT_FOUND");
await rejects(o => { o.tamperReceipt = true; }, "BACKUP_RECEIPT_SHA256");
await rejects(o => { o.tamperArchive = true; }, "BACKUP_ARCHIVE_SHA256");
await rejects(o => { o.receipt.database = "other"; }, "BACKUP_RECEIPT_UNSAFE");
await rejects(o => { o.receipt.archiveBytes++; }, "BACKUP_ARCHIVE_BYTES");
await rejects(o => { o.receipt.readability.exitCode = 1; }, "BACKUP_READABILITY");
await rejects(o => { o.receipt.readability.entryCount = 2; }, "BACKUP_READABILITY_ENTRY_COUNT");
await rejects(o => { o.receipt.restore.status = "not_run"; }, "BACKUP_RESTORE_NOT_VERIFIED");
await rejects(o => { o.tamperRestore = true; }, "BACKUP_RESTORE_EVIDENCE_SHA256");
await rejects(o => { o.restore.sourceTargetFingerprint = "d".repeat(64); }, "BACKUP_RESTORE_EVIDENCE_UNSAFE");
await rejects(o => { o.restore.archiveSha256 = "d".repeat(64); }, "BACKUP_RESTORE_EVIDENCE_UNSAFE");
await rejects(o => { o.restore.checks.data = false; }, "BACKUP_RESTORE_EVIDENCE_UNSAFE");
await rejects(o => { o.restore.target = { host: "localhost", port: 54322, database: "business" }; }, "BACKUP_RESTORE_EVIDENCE_UNSAFE");
await rejects(o => { o.confirmedTargetHost = "production.invalid"; o.url = "postgresql://fixture@production.invalid:54322/business"; }, "BACKUP_TARGET_CLASS_UNSUPPORTED");
await rejects(o => { o.mutateSqlAt = "preflight"; }, "MIGRATION_SOURCE_HASH_CHANGED");
await rejects(o => { o.mutateSqlAt = "connect"; }, "MIGRATION_SOURCE_HASH_CHANGED");
await rejects(o => { o.ledger = [{ version: migration.version, hash: "" }]; }, "APPLIED_MIGRATION_HASH_DRIFT");
await rejects(o => { o.ledger = [{ version: migration.version, hash: "d".repeat(64) }]; }, "APPLIED_MIGRATION_HASH_DRIFT");
await rejects(o=>{o.url+='?host=production.invalid';},'DATABASE_TARGET_QUERY_OVERRIDE_FORBIDDEN');
await rejects(o=>{o.url+='?port=54324';},'DATABASE_TARGET_QUERY_OVERRIDE_FORBIDDEN');
await rejects(o=>{o.archive.fill(88,0,5);o.receipt.archiveSha256=digest(o.archive);},'BACKUP_ARCHIVE_NOT_READABLE');
await rejects(o=>{o.receipt.readability.evidenceSha256='d'.repeat(64);},'BACKUP_READABILITY_EVIDENCE_SHA256_MISMATCH');
await rejects(o=>{o.restore.targetIsolated=false;},'BACKUP_RESTORE_EVIDENCE_UNSAFE');
const streamed=await fixture(o=>{o.archive=Buffer.alloc(3*1024*1024,32);o.archive.write('PGDMP');o.receipt.archiveSha256=digest(o.archive);o.receipt.archiveBytes=o.archive.length;o.restore.archiveSha256=digest(o.archive);o.confirmedBackupArchiveSha256=digest(o.archive);});assert.equal(streamed.error,undefined);assert.ok(streamed.archiveReadChunks>=8);passed++;
await rejects(o=>{o.archiveChanged=true;},'BACKUP_ARCHIVE_UNREADABLE_OR_CHANGED');
const valid = await fixture(); assert.equal(valid.error, undefined); assert.equal(valid.appliedSql, 1); assert.equal(valid.result.ledgerRecordedCount, 1); passed++;
const skipped = await fixture(o => { o.ledger = [{ version: migration.version, hash: migration.sha256 }]; }); assert.equal(skipped.error, undefined); assert.equal(skipped.appliedSql, 0); assert.equal(skipped.result.skippedCount, 1); passed++;
const partial = await fixture(o => { o.failLedger = true; }); assert.equal(partial.appliedSql, 1); assert.equal(partial.context.applyProgress.committedButUnrecorded.version, migration.version); assert.equal(partial.context.safeReleaseErrorCode(partial.error), "MIGRATION_RELEASE_FAILED"); passed++;
await rejects(o => { o.restore.exitCode = 1; }, "BACKUP_RESTORE_EVIDENCE_UNSAFE", "adopt");
await rejects(o => { o.live.database_name = "other"; }, "LIVE_DATABASE_TARGET_MISMATCH", "adopt");
const adopted = await fixture(() => {}, "adopt"); assert.equal(adopted.error, undefined); assert.equal(adopted.result.adoptedCount, 1); passed++;
// The actual plan must not call dotenv or consult a configured DB URL.
assert.match(source, /if \(command !== "plan"\) dotenv\.config/u);
assert.match(functions.get("plan"), /command === "plan" \? \{ configured: false, envName: null, host: null \} : databaseConfig\(\)/u);
// Execute the actual plan, with secret/config readers that fail if touched.
const planContext={...valid.context,command:'plan',databaseConfig:()=>assert.fail('Source-only plan accessed DB configuration'),pgClient:()=>assert.fail('Source-only plan connected'),relativeSlash:value=>value,migrationRoot:'migrations',includeApplied:false,excludedForwardMigrations:new Set(),writeResult:value=>{assert.equal(value.database.targetIdentityVerified,false);assert.equal(value.databaseWrites,0);},process:{exitCode:0}};
vm.createContext(planContext);vm.runInContext(functions.get('plan')+';this.runPlan=plan;',planContext);await planContext.runPlan();passed++;
await rejects(o=>{o.receipt.extra='unknown';},'BACKUP_EVIDENCE_FIELDS_INVALID');
await rejects(o=>{o.restore.completedAt='2026-10-01T00:00:01Z';},'BACKUP_RESTORE_EVIDENCE_UNSAFE');
// Preserve --only's existing dependency-prefix interpretation.
const prefixEntries=['20990101000000_a.sql','20990102000000_b.sql','20990103000000_c.sql','20990104000000_d.sql'];
const prefixContext={path,migrationRoot:'fixture',excludedForwardMigrations:new Set(),selectedOnly:[prefixEntries[3]],onlySelectionReport:{},validateForwardMigrationSource:()=>({entries:prefixEntries.map(relativePath=>({relativePath}))}),inspectMigration:file=>({name:path.basename(file),version:path.basename(file).slice(0,14),valid:true,errors:[]})};
vm.createContext(prefixContext);vm.runInContext(functions.get('listMigrations')+';this.selected=listMigrations();',prefixContext);assert.equal(prefixContext.selected.length,4);assert.equal(prefixContext.onlySelectionReport.dependencyClosureAdded.length,3);passed++;
// Execute the actual top-level failure callback, not a test-only serialization copy.
const failureStatement = ast.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
  && node.expression.expression.name.text === "catch"
  && node.expression.expression.expression.getText(ast) === "main()");
assert.ok(failureStatement);
const failureCallback = failureStatement.expression.arguments[0].getText(ast);
function serializedFailure(error, fixtureResult = valid) {
  let printed;
  const context = { ...fixtureResult.context, command: "apply", writeEvidence: false, process: { exitCode: 0 },
    console: { error: text => { printed = text; } } };
  vm.createContext(context);
  vm.runInContext(realFunctions + `;this.captureFailure = ${failureCallback};`, context);
  context.captureFailure(error);
  assert.equal(context.process.exitCode, 1);
  return { text: printed, value: JSON.parse(printed) };
}
const secretMarker = "SYNTHETIC_PG_SECRET_UPPERCASE";
function pgError(code, position) {
  const error = new pg.DatabaseError(secretMarker, 0, "error");
  Object.assign(error, { code, position, schema: secretMarker + "_SCHEMA", table: secretMarker + "_TABLE",
    constraint: secretMarker + "_CONSTRAINT", detail: secretMarker + "_DETAIL", hint: secretMarker + "_HINT",
    where: secretMarker + "_WHERE", internalQuery: secretMarker + "_QUERY", stack: secretMarker + "_STACK" });
  return error;
}
const realPgError = pgError("42704", "12");
const pgFailure = serializedFailure(realPgError);
assert.equal(pgFailure.value.code, "MIGRATION_RELEASE_FAILED");
assert.deepEqual(pgFailure.value.postgresDiagnostic, { sqlState: "42704", position: 12,
  messageSha256: digest(secretMarker), schemaSha256: digest(realPgError.schema),
  tableSha256: digest(realPgError.table), constraintSha256: digest(realPgError.constraint) });
assert.ok(!pgFailure.text.includes(secretMarker)); passed++;
for (const code of [undefined, "", "00000", "00ABC", "4270", "427040", "42p01", "42P01 trailing", 42704]) {
  const failure = serializedFailure(pgError(code, "12"));
  assert.equal(failure.value.code, "MIGRATION_RELEASE_FAILED");
  assert.equal(failure.value.postgresDiagnostic.sqlState, undefined);
  assert.ok(!failure.text.includes(secretMarker)); passed++;
}
for (const position of [undefined, "", "0", "-1", "1.5", "12suffix", " 12", "+12", "1e2", "9007199254740992", 0, -1, 1.5, Infinity, NaN]) {
  const failure = serializedFailure(pgError("P0001", position));
  assert.equal(failure.value.postgresDiagnostic.position, undefined);
  assert.ok(!failure.text.includes(secretMarker)); passed++;
}
const numericPosition = serializedFailure(pgError("23514", 23));
assert.equal(numericPosition.value.postgresDiagnostic.position, 23); passed++;
const spoof = Object.assign(new Error("plain unsafe message"), { code: "42704", position: "12", detail: secretMarker });
assert.equal(serializedFailure(spoof).value.postgresDiagnostic, undefined);
assert.equal(postgresErrorDiagnostics(spoof, false), undefined); passed++;
assert.equal(serializedFailure(new Error("APPLIED_MIGRATION_HASH_DRIFT:20990101000000")).value.code,
  "APPLIED_MIGRATION_HASH_DRIFT:20990101000000"); passed++;
const serializedPartial = serializedFailure(pgError("23514", "1"), partial).value;
assert.equal(serializedPartial.committedMigrationCount, 1);
assert.equal(serializedPartial.ledgerRecordedCount, 0);
assert.equal(serializedPartial.committedButUnrecorded.version, migration.version); passed++;
// SQL repair is byte-bounded. Actual ADD validation still requires root-owned PostgreSQL execution.
const h3Sql = fs.readFileSync("supabase/migrations/20261012011000_h3_provider_delivery.sql", "utf8");
assert.equal(digest(h3Sql.replaceAll("DROP CONSTRAINT IF EXISTS autodl_h3_", "DROP CONSTRAINT autodl_h3_")),
  "18d8230db11bee562302e41e9e430b9e05134e6825c9a096898812f4140728a2");
assert.equal((h3Sql.match(/DROP CONSTRAINT IF EXISTS /gu) || []).length, 2);
assert.ok(!h3Sql.includes("NOT VALID")); passed++;
// Optional actual producer fixture contract. Synthetic files only; no pg/CLI execution.
let syntheticProducerReceiptVerified = false;
if (process.env.DATABASE_APPLY_SYNTHETIC_RECEIPT) {
  const receiptPath = path.resolve(process.env.DATABASE_APPLY_SYNTHETIC_RECEIPT);
  const receiptBytes = fs.readFileSync(receiptPath), receipt = JSON.parse(receiptBytes.toString("utf8"));
  const producerContext = { crypto, Buffer, URL, path, root, Date, fs,
    confirmedBackup: receiptPath, confirmedBackupReceiptFileSha256: digest(receiptBytes),
    confirmedBackupArchiveSha256: receipt.archiveSha256, confirmedTargetFingerprint: receipt.targetFingerprint };
  vm.createContext(producerContext);vm.runInContext(realFunctions, producerContext);
  const checked = producerContext.confirmedDatabaseBackup({ host: receipt.targetHost, port: receipt.targetPort, database: receipt.database });
  assert.equal(checked.restoreDrillVerified, true);
  syntheticProducerReceiptVerified = true;passed++;
}
console.log(JSON.stringify({ passed: true, behaviorCases: passed, syntheticProducerReceiptVerified, sourceSha256: digest(source), scope: "Actual apply/adopt guards and pg calls with synthetic files; optional producer fixture is not a real backup/restore/apply", realDatabaseConnections: 0, realDatabaseWrites: 0, realGitWrites: 0 }));
