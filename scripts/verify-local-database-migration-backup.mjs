#!/usr/bin/env node
// Offline behavior tests. Synthetic artifacts are never evidence of an actual database restore.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareBackup, parseArguments, parseLocalConnection, normalizeSchema, archiveDigest } from './prepare-local-database-migration-backup.mjs';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';
import { compareRestoreSchemas } from './lib/database-restore-schema-comparison.mjs';

const cli = fileURLToPath(new URL('./prepare-local-database-migration-backup.mjs', import.meta.url));
const fixtureArg = process.argv.find(arg => arg.startsWith('--fixture-root='));
const parent = fixtureArg ? path.resolve(fixtureArg.slice('--fixture-root='.length)) : os.tmpdir();
const root = fs.mkdtempSync(path.join(parent, 'synthetic-backup-producer-'));
const bin = path.join(root, 'fake-tools'); fs.mkdirSync(bin);
for (const name of ['pg_dump', 'pg_restore']) fs.writeFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), 'NONEXECUTABLE SYNTHETIC TOOL', { flag: 'wx' });
const sourceUrl = 'postgresql://fixture:synthetic-secret@127.0.0.1:54322/business';
const restoreUrl = 'postgresql://fixture:synthetic-secret@localhost:54322/postgres';
const restoreName = 'zimeiti_restore_20261012000000_12345678';
const identityRow = database => ({ database_name: database, server_version: '170000', server_address: '127.0.0.1/32', server_port: '54322' });
const financial = Object.fromEntries(['users', 'creditsBalance', 'cashBalance', 'creditsReserved', 'creditTransactions', 'creditTransactionAmount', 'cashTransactions', 'cashTransactionAmount', 'walletLedgerEntries', 'walletLedgerDelta', 'paymentOrders', 'paymentOrderAmount'].map(key => [key, '0']));
const dbProperties = { owner: 'fixture', default_acl: true, encoding: 'UTF8', collate: 'C', ctype: 'C', locale_provider: 'c',
  collation_version: null, connection_limit: -1, allow_connections: true, is_template: false, settings_count: '0' };
const sourceIdentity = await readDatabaseTargetIdentity({ query: async () => ({ rows: [identityRow('business')] }) }, '127.0.0.1');
const baseOptions = { execute: true, 'output-root': root, 'confirm-controlled-backup-root': root, 'pg-bin': bin,
  'restore-database': restoreName, 'confirm-source-host': '127.0.0.1', 'confirm-source-port': '54322',
  'confirm-source-database': 'business', 'confirm-source-fingerprint': sourceIdentity.fingerprint };
let cases = 0;
const passed = () => { cases++; };

function adapters(mode = '') {
  const calls = { connections: [], queries: [], tools: [], creates: 0, restores: 0 };
  let archiveFile;
  return { calls, environment: { LOCAL_BACKUP_SOURCE_URL: sourceUrl, LOCAL_BACKUP_RESTORE_ADMIN_URL: restoreUrl,
    PGSERVICE: 'must-not-inherit', PGOPTIONS: 'must-not-inherit', SECRET_SENTINEL: 'synthetic-secret' },
  connect: async (config, readOnly) => {
    calls.connections.push({ database: config.database, readOnly });
    const restored = config.database === restoreName;
    return { end: async () => {}, query: async (sql, values) => {
      calls.queries.push(sql);
      if (/DROP|ALTER ROLE|CREATE ROLE|INSERT|UPDATE|DELETE/iu.test(sql)) throw new Error('Unexpected mutation');
      if (/^CREATE DATABASE/u.test(sql)) { calls.creates++; if (['permission', 'ackunknown'].includes(mode)) throw new Error('connection/permission synthetic-secret ' + sourceUrl); return { rows: [] }; }
      if (sql.includes('server_version_num')) return { rows: [identityRow(mode === 'identity' && config.database === 'business' ? 'wrong' : config.database)] };
      if (sql.includes('pg_control_system')) return { rows: [{ system_identifier: mode === 'cluster' && config.database === 'postgres' ? '222' : '111' }] };
      if (sql.includes('datname=$1')) { assert.equal(values[0], restoreName); return { rows: mode === 'exists' || (mode === 'ackunknown' && calls.creates) ? [{ datname: restoreName }] : [] }; }
      if (sql.includes('acldefault')) return { rows: [{ ...dbProperties, ...(mode === 'acl' && !restored ? { default_acl: false } : {}), ...(mode === 'locale' ? { locale_provider: 'i' } : {}), ...(mode === 'owner' && restored ? { owner: 'wrong' } : {}) }] };
      if (sql.includes('pg_export_snapshot')) return { rows: [{ snapshot: '00000003-00000001-1' }] };
      if (sql.startsWith('select count(*)::text as count from pg_tables')) return { rows: [{ count: mode === 'notempty' ? '1' : '0' }] };
      if (sql.includes('select schemaname,tablename')) return { rows: [{ schemaname: 'public', tablename: 'users' }] };
      if (sql.startsWith('select count(*)::text as count from')) return { rows: [{ count: restored && mode === 'data' ? '1' : '0' }] };
      if (sql.includes('jsonb_build_object')) return { rows: [{ evidence: { ...financial, ...(restored && mode === 'financial' ? { cashBalance: '1' } : {}) } }] };
      if (sql.includes('from pg_roles order')) return { rows: [{ rolname: 'fixture', rolsuper: true, ...(restored && mode === 'roles' ? { rolsuper: false } : {}) }] };
      if (sql.includes('from pg_auth_members')) return { rows: [] };
      if (/^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql)) return { rows: [] };
      throw new Error('Unexpected query ' + sql);
    } };
  },
  spawn: (command, args, options) => {
    calls.tools.push({ command, args });
    assert.equal(options.env.PGSERVICE, undefined); assert.equal(options.env.PGOPTIONS, undefined); assert.equal(options.env.SECRET_SENTINEL, undefined);
    assert.equal(options.env.PGPASSWORD, 'synthetic-secret');
    assert.ok(!options.env.PGHOST.includes('['));
    assert.ok(!args.some(arg => ['--no-owner', '--no-acl', '--clean'].includes(arg)));
    if (mode === 'dump' && command.includes('pg_dump')) return { status: 1, stderr: 'synthetic-secret ' + sourceUrl };
    if (args.includes('--list')) return { status: 0, stdout: mode === 'toc' ? '; no entries\n' : '; synthetic\n1; 1259 1 TABLE public users fixture\n' + (mode === 'toobigtoc' ? 'x'.repeat(16 * 1024 * 1024) : '') };
    if (command.includes('pg_restore')) {
      calls.restores++;
      assert.ok(args.includes('--single-transaction') && args.includes('--exit-on-error'));
      if (mode === 'restore') return { status: 1, stderr: 'synthetic-secret ' + sourceUrl };
      if (mode === 'archive') fs.appendFileSync(archiveFile, 'changed');
      return { status: 0, stdout: '' };
    }
    const output = args.find(arg => arg.startsWith('--file=')).slice(7);
    if (mode === 'filepermission') throw new Error('EACCES synthetic-secret ' + sourceUrl);
    if (mode === 'uppercase') throw new Error('SYNTHETIC_SECRET_UPPERCASE');
    if (args.includes('--format=custom')) {
      archiveFile = output;
      fs.writeFileSync(output, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(2 * 1024 * 1024, 42)]), { flag: 'wx' });
    } else {
      const restored = options.env.PGDATABASE === restoreName;
      fs.writeFileSync(output, restored && mode === 'listonly' ? '-- nothing restored\n' : `-- Dumped by pg_dump version 17.0\n\\restrict ${restored ? 'ABC222' : 'ABC111'}\nCREATE TABLE "public"."users"();\nALTER TABLE "public"."users" OWNER TO "${restored && mode === 'schema' ? 'other' : 'fixture'}";\n\\unrestrict ${restored ? 'ABC222' : 'ABC111'}\n`, { flag: 'wx' });
    }
    return { status: 0, stdout: '' };
  } };
}

const plan = await prepareBackup({}, { get environment() { throw new Error('secret accessed'); }, connect: () => { throw new Error('DB accessed'); } });
assert.equal(plan.executed, false); passed();
const planCli = spawnSync(process.execPath, [cli], { encoding: 'utf8', env: { ...process.env, LOCAL_BACKUP_SOURCE_URL: 'malformed-synthetic-secret', LOCAL_BACKUP_RESTORE_ADMIN_URL: 'malformed' } });
assert.equal(planCli.status, 0); assert.equal(JSON.parse(planCli.stdout).filesWritten, false); assert.ok(!planCli.stdout.includes('synthetic-secret')); passed();
const rejectedCli = spawnSync(process.execPath, [cli, '--execute'], { encoding: 'utf8', env: { ...process.env, LOCAL_BACKUP_SOURCE_URL: 'postgresql://fixture:synthetic-secret@remote.invalid/business' } });
assert.equal(rejectedCli.status, 1); assert.ok(!rejectedCli.stderr.includes('synthetic-secret') && !rejectedCli.stderr.includes('postgresql://')); passed();
const specialPassword = 'slash/back\\slash:@?# newline\n';
assert.equal(parseLocalConnection(`postgresql://fixture:${encodeURIComponent(specialPassword)}@127.0.0.1/business`).password, specialPassword); passed();
assert.throws(() => parseLocalConnection('postgresql://fixture@127.0.0.1/business')); passed();
const oldPgOptions = process.env.PGOPTIONS;
try {
  process.env.PGOPTIONS = '-c role=synthetic_untrusted';
  await assert.rejects(prepareBackup(baseOptions), /AMBIENT_PG_ENVIRONMENT_FORBIDDEN/u); passed();
} finally { if (oldPgOptions === undefined) delete process.env.PGOPTIONS; else process.env.PGOPTIONS = oldPgOptions; }
for (const bad of ['postgresql://u:p@remote.invalid/db', 'postgresql://u:p@127.0.0.1/db?host=remote', 'postgresql://u:p@127.0.0.1/db?service=x', 'postgresql://u:p@127.0.0.1/db?port=9999', 'postgresql://u:p@127.0.0.1/db?dbname=other']) {
  assert.throws(() => parseLocalConnection(bad)); passed();
}
assert.throws(() => parseArguments(['--execute=true'])); assert.throws(() => parseArguments(['--unknown=value'])); passed();
// Exercise the exported parser and real CLI with every supported flag, including sha256.
const sharedCliOptions = { 'output-root': root, 'confirm-controlled-backup-root': root, 'pg-bin': bin,
  'restore-database': restoreName, 'confirm-source-host': '127.0.0.1', 'confirm-source-port': '54322',
  'confirm-source-database': restoreName, 'confirm-source-fingerprint': 'a'.repeat(64),
  'input-manifest': path.join(root, 'not-read-manifest.json'), 'confirm-input-manifest-sha256': 'b'.repeat(64) };
for (const mode of ['execute', 'verify-existing']) {
  const argv = [`--${mode}`, ...Object.entries(sharedCliOptions).map(([name, value]) => `--${name}=${value}`)];
  assert.deepEqual(parseArguments(argv), { [mode]: true, ...sharedCliOptions }); passed();
  // Remove connection and PG overrides; both paths must fail before fs, pg import or DB access.
  const isolatedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^PG|^LOCAL_BACKUP_/iu.test(name)));
  for (const source of [undefined, 'postgresql://fixture@127.0.0.1:54322/isolated']) {
    const env = { ...isolatedEnv, ...(source === undefined ? {} : { LOCAL_BACKUP_SOURCE_URL: source }) };
    const child = spawnSync(process.execPath, [cli, ...argv], { encoding: 'utf8', env });
    assert.equal(child.status, 1); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { verified: false, code: 'CONNECTION_INVALID' });
    assert.ok(!child.stderr.includes('postgresql://') && !child.stderr.includes('fixture')); passed();
  }
}
for (const argv of [
  ['--confirm-input-manifest-sha256=a', '--confirm-input-manifest-sha256=b'],
  ['--confirm-input-manifest-sha256='], ['--confirm-input-manifest-sha256'],
  ['--unknown256=value'], ['--256=value'], ['--confirm_input_manifest_sha256=value'],
  ['--Confirm-input-manifest-sha256=value'], ['--verify-existing=true'], ['--execute', '--execute'],
]) { assert.throws(() => parseArguments(argv), /ARGUMENT_INVALID/u); passed(); }

assert.notEqual(normalizeSchema('CREATE FUNCTION f() RETURNS text AS $$dbname$$ LANGUAGE SQL;'), normalizeSchema('CREATE FUNCTION f() RETURNS text AS $$other$$ LANGUAGE SQL;')); passed();
assert.equal(normalizeSchema('\\restrict abc\nx\n\\unrestrict abc'), 'x'); passed();
const functionBody = token => `\\restrict outer\nCREATE FUNCTION f() RETURNS text AS $$\n\\restrict ${token}\n-- Dumped by pg_dump version ${token}\n\\unrestrict ${token}\n$$ LANGUAGE SQL;\n\\unrestrict outer`;
assert.notEqual(normalizeSchema(functionBody('insideA')), normalizeSchema(functionBody('insideB'))); passed();

async function rejects(mode, code, options = {}, environmentChanges = {}) {
  const deps = adapters(mode); Object.assign(deps.environment, environmentChanges);
  const previous = new Set(fs.readdirSync(root));
  await assert.rejects(prepareBackup({ ...baseOptions, ...options }, deps), error => error.message === code && !error.message.includes('synthetic-secret'));
  for (const name of fs.readdirSync(root).filter(name => !previous.has(name))) assert.equal(fs.existsSync(path.join(root, name, 'backup-receipt.json')), false);
  if (['exists', 'identity', 'cluster', 'acl', 'locale', 'dump', 'toc'].includes(mode)) assert.equal(deps.calls.creates, 0);
  assert.ok(!deps.calls.queries.some(sql => /DROP DATABASE/iu.test(sql)));
  passed(); return deps;
}
await rejects('', 'SOURCE_CONFIRMATION_REQUIRED', { 'confirm-source-database': 'wrong' });
await rejects('', 'SOURCE_RESTORE_SAME_TARGET', { 'confirm-source-database': restoreName }, { LOCAL_BACKUP_SOURCE_URL: `postgresql://fixture:synthetic-secret@127.0.0.1:54322/${restoreName}` });
await rejects('', 'SOURCE_RESTORE_SAME_TARGET', { 'confirm-source-host': '[::1]', 'confirm-source-database': restoreName }, { LOCAL_BACKUP_SOURCE_URL: `postgresql://fixture:synthetic-secret@[::1]:54322/${restoreName}` });
await rejects('', 'REMOTE_TARGET_FORBIDDEN', {}, { LOCAL_BACKUP_RESTORE_ADMIN_URL: 'postgresql://fixture:synthetic-secret@remote.invalid:54322/postgres' });
await rejects('', 'RESTORE_NAME_INVALID', { 'restore-database': 'business' });
await rejects('', 'BACKUP_ROOT_UNSAFE', { 'output-root': path.dirname(path.dirname(cli)), 'confirm-controlled-backup-root': path.dirname(path.dirname(cli)) });
for (const [mode, code] of [['exists', 'RESTORE_DATABASE_ALREADY_EXISTS'], ['identity', 'ACTUAL_TARGET_MISMATCH'], ['cluster', 'ACTUAL_CLUSTER_MISMATCH'],
  ['acl', 'DATABASE_LEVEL_ACL_UNSUPPORTED'], ['locale', 'DATABASE_PROPERTIES_UNSUPPORTED'], ['dump', 'DUMP_FAILED'], ['toc', 'TOC_EMPTY'],
  ['permission', 'BACKUP_OPERATION_FAILED'], ['ackunknown', 'BACKUP_OPERATION_FAILED'], ['filepermission', 'BACKUP_OPERATION_FAILED'],
  ['uppercase', 'BACKUP_OPERATION_FAILED'],
  ['toobigtoc', 'TOC_TOO_LARGE'], ['listonly', 'RESTORE_VERIFICATION_MISMATCH'], ['notempty', 'RESTORE_DATABASE_NOT_EMPTY'], ['restore', 'RESTORE_TOOL_FAILED'],
  ['archive', 'ARCHIVE_CHANGED'], ['schema', 'RESTORE_VERIFICATION_MISMATCH'], ['owner', 'RESTORE_VERIFICATION_MISMATCH'],
  ['data', 'RESTORE_VERIFICATION_MISMATCH'], ['financial', 'RESTORE_VERIFICATION_MISMATCH'], ['roles', 'RESTORE_VERIFICATION_MISMATCH']]) await rejects(mode, code);
const failures = fs.readdirSync(root).filter(name => name.startsWith('local-migration-backup-')).map(name => path.join(root, name, 'failure.json')).filter(file => fs.existsSync(file)).map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
assert.ok(failures.some(failure => failure.actions.creationState === 'submitted_unknown' && failure.actions.creationObservation === 'database_exists'
  && failure.actions.isolatedDatabaseCreated === null && failure.isolatedDatabaseRetained === null)); passed();

const successDeps = adapters();
const result = await prepareBackup(baseOptions, successDeps);
assert.equal(result.verified, true); assert.equal(successDeps.calls.restores, 1); assert.equal(successDeps.calls.creates, 1);
assert.equal(successDeps.calls.connections[0].readOnly, true); assert.equal(successDeps.calls.connections[2].readOnly, true);
const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
const archiveFile = path.join(path.dirname(result.receiptPath), receipt.archivePath);
assert.deepEqual(archiveDigest(archiveFile), { sha256: receipt.archiveSha256, bytes: receipt.archiveBytes });
assert.equal(receipt.archiveSha256, crypto.createHash('sha256').update(fs.readFileSync(archiveFile)).digest('hex'));
assert.equal(receipt.restore.status, 'verified');
assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
passed();
const ipv6Deps = adapters();
ipv6Deps.environment.LOCAL_BACKUP_SOURCE_URL = 'postgresql://fixture:synthetic-secret@[::1]:54322/business';
ipv6Deps.environment.LOCAL_BACKUP_RESTORE_ADMIN_URL = 'postgresql://fixture:synthetic-secret@[::1]:54322/postgres';
const ipv6Identity = await readDatabaseTargetIdentity({ query: async () => ({ rows: [identityRow('business')] }) }, '[::1]');
const ipv6Result = await prepareBackup({ ...baseOptions, 'confirm-source-host': '[::1]', 'confirm-source-fingerprint': ipv6Identity.fingerprint }, ipv6Deps);
const ipv6Receipt = JSON.parse(fs.readFileSync(ipv6Result.receiptPath, 'utf8'));
assert.equal(ipv6Receipt.targetHost, '[::1]'); assert.equal(ipv6Receipt.targetFingerprint, ipv6Identity.fingerprint); passed();
fs.writeFileSync(path.join(root, 'SYNTHETIC-ONLY.json'), JSON.stringify({ scope: 'Offline callback fixture, no real database dump or restore', receiptPath: result.receiptPath }), { flag: 'wx' });

const check = expression => `CREATE TABLE "public"."t"(CONSTRAINT "c" CHECK (${expression}));`;
const rangeSource = '((("length"("a") >= 2) AND ("length"("a") <= 100)) AND ("a" ~ \'^[a-z]+$\'::"text"))';
const rangeRestored = '(("length"("a") >= 2) AND ("length"("a") <= 100) AND ("a" ~ \'^[a-z]+$\'::"text"))';
const arraySource = '(ARRAY[\'one\'::character varying, \'two\'::character varying])::"text"[]';
const arrayRestored = 'ARRAY[(\'one\'::character varying)::"text", (\'two\'::character varying)::"text"]';
const arrayCheck = array => check(`("a" = ANY (${array}))`);
for (const [left, right] of [[check(rangeSource), check(rangeRestored)], [check(`(("a" IS NULL) OR ${rangeSource})`), check(`(("a" IS NULL) OR ${rangeRestored})`)],
  [arrayCheck(arraySource), arrayCheck(arrayRestored)], [`CREATE INDEX "i" ON "t" ("a") WHERE "a" = ANY (${arraySource});`, `CREATE INDEX "i" ON "t" ("a") WHERE "a" = ANY (${arrayRestored});`],
  [check(rangeSource), check(rangeSource)]]) { assert.equal(compareRestoreSchemas(left, right).equivalent, true); passed(); }
for (const changed of [rangeRestored.replace('>= 2', '>= 3'), rangeRestored.replace('>= 2', '> 2'), rangeRestored.replace('^[a-z]+$', '^[A-Z]+$'),
  rangeRestored.replaceAll('"length"', '"char_length"'), rangeRestored.replaceAll('"a"', '"b"'), rangeRestored.replace(' AND ', ' OR '),
  'NOT ' + rangeRestored, rangeRestored.replace('(\"length\"(\"a\") >= 2) AND (\"length\"(\"a\") <= 100)', '(\"length\"(\"a\") <= 100) AND (\"length\"(\"a\") >= 2)'),
  rangeRestored.replace(' AND ', ' AND ("length"("a") >= 2) AND ')]) { assert.equal(compareRestoreSchemas(check(rangeSource), check(changed)).equivalent, false); passed(); }
for (const changed of [arrayRestored.replace("'one'", "'other'"), arrayRestored.replace("'one'", "'two'").replace(/'two'(?=::character varying\)::"text"\]$)/u, "'one'"),
  arrayRestored.replace(", ('two'::character varying)::\"text\"", ''), arrayRestored.replaceAll('character varying', 'varchar'),
  arrayRestored.replaceAll('character varying', 'character varying(20)'), arrayRestored.replaceAll('::"text"', '::"public"."text"'),
  arrayRestored.replaceAll('::"text"', '::"domain_text"'), arrayRestored.replace("'one'", 'NULL'), arrayRestored.replace("'one'", "lower('one')"),
  arrayRestored.replace('ARRAY[', 'ARRAY[ARRAY[') + ']', arrayRestored + ' COLLATE "C"', arrayRestored + '[1]']) {
  assert.equal(compareRestoreSchemas(arrayCheck(arraySource), arrayCheck(changed)).equivalent, false); passed();
}
for (const wrapper of [s => `CREATE FUNCTION f() RETURNS text AS $$\n${s}\n$$ LANGUAGE SQL;`, s => `-- ${s}\nCREATE TABLE "t"();`, s => `CREATE TABLE "t"("x" text DEFAULT '${s.replaceAll("'", "''")}');`,
  s => `/* ${s} */ CREATE TABLE "t"();`]) { assert.equal(compareRestoreSchemas(wrapper(check(rangeSource)), wrapper(check(rangeRestored))).equivalent, false); passed(); }
for (const malformed of ["SELECT 'unterminated", 'SELECT "unterminated', '/* unterminated', 'CREATE FUNCTION f() AS $tag$unterminated', 'CREATE TABLE "t"(CONSTRAINT "c" CHECK (a AND b;']) {
  assert.throws(() => compareRestoreSchemas(malformed, malformed), /SCHEMA_LEXICAL_INVALID/u); passed();
}
assert.equal(compareRestoreSchemas(check(rangeSource), check(rangeRestored).replace(' AND ', '  AND ')).equivalent, false); passed();
for (const changed of [check(`(("a" IS NULL) AND ${rangeRestored})`), check(`(NOT ("a" IS NULL) OR ${rangeRestored})`), check(`(("a" IS NULL) OR ("length"("a") >= 2)) AND (("length"("a") <= 100) AND ("a" ~ '^[a-z]+$'::"text"))`)]) {
  assert.equal(compareRestoreSchemas(check(`(("a" IS NULL) OR ${rangeSource})`), changed).equivalent, false); passed();
}
for (const wrapper of [s => `ARRAY[${s}]`, s => `(${s}) COLLATE "C"`, s => `${s}::"custom_domain"`, s => `(${s})::"custom_domain"`, s => `${s}[1]`]) {
  assert.equal(compareRestoreSchemas(arrayCheck(wrapper(arraySource)), arrayCheck(wrapper(arrayRestored))).equivalent, false); passed();
}
await assert.rejects(prepareBackup({ execute: true, 'verify-existing': true }), /MUTUALLY_EXCLUSIVE_MODES/u); passed();

// Exercise the actual verify-existing branch with original-baseline fixture hashes.
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stableFixture = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(stableFixture).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableFixture(value[key])}`).join(',')}}`;
const oldDirectory = path.join(root, 'old-failed-run'); fs.mkdirSync(oldDirectory);
const restoredIdentity = await readDatabaseTargetIdentity({ query: async () => ({ rows: [identityRow(restoreName)] }) }, '127.0.0.1');
const originalBaseline = { counts: [{ schema: 'public', table: 'users', count: '0' }], financial };
const originalRoles = { roles: [{ rolname: 'fixture', rolsuper: true }], members: [] };
const originalSchema = check(rangeSource), oldRestoredSchema = check(rangeRestored);
const originalReports = {
  sourceSchema: originalSchema, oldRestoredSchema,
  toc: '1; 1259 1 TABLE public users fixture\n',
  failure: JSON.stringify({ kind: 'local-backup-failure.v1', code: 'RESTORE_VERIFICATION_MISMATCH', actions: { creationState: 'created', restoreAttempted: true },
    isolatedDatabaseRetained: true, isolatedTarget: { host: '127.0.0.1', port: 54322, database: restoreName } }),
  operatorResult: JSON.stringify({ kind: 'local-backup-operator-result.v1', exitCode: 1, verified: false, code: 'RESTORE_VERIFICATION_MISMATCH',
    sourceFingerprint: sourceIdentity.fingerprint, sourceDatabase: 'business', restoreDatabase: restoreName }),
  verificationDetails: JSON.stringify({ kind: 'local-backup-verification-details.v1', checks: { schema: false, data: true }, sourceSchemaSha256: sha(originalSchema),
    restoredSchemaSha256: sha(oldRestoredSchema), sourceDataSha256: sha(stableFixture(originalBaseline)), sourceRolesSha256: sha(stableFixture(originalRoles)), sourceDatabasePropertiesSha256: sha(stableFixture(dbProperties)) }),
};
const artifacts = {};
for (const [name, content] of Object.entries(originalReports)) { const file = path.join(oldDirectory, `${name}.txt`); fs.writeFileSync(file, content, { flag: 'wx' }); artifacts[name] = { path: file, sha256: sha(content) }; }
const oldArchive = path.join(oldDirectory, 'database.dump'); fs.writeFileSync(oldArchive, 'PGDMPsynthetic-original', { flag: 'wx' });
const manifest = { kind: 'database-existing-restore-input.v1', schemaVersion: 1, historicalSourceFingerprint: sourceIdentity.fingerprint,
  expectedTarget: { host: '127.0.0.1', port: 54322, database: restoreName, fingerprint: restoredIdentity.fingerprint, systemIdentifier: '111' }, artifacts,
  archive: { path: oldArchive, ...archiveDigest(oldArchive), hashProvenance: 'observedDuringReverification' } };
// Manifest field is sha256 (archiveDigest already returns it); bytes are stream-counted.
const manifestFile = path.join(root, 'existing-input.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest), { flag: 'wx' });
const verifyOptions = { ...baseOptions, execute: false, 'verify-existing': true, 'confirm-source-database': restoreName,
  'confirm-source-fingerprint': restoredIdentity.fingerprint, 'input-manifest': manifestFile, 'confirm-input-manifest-sha256': sha(fs.readFileSync(manifestFile)) };
const verifyAdapters = mode => {
  const deps = adapters(mode); deps.environment.LOCAL_BACKUP_SOURCE_URL = `postgresql://fixture:synthetic-secret@127.0.0.1:54322/${restoreName}`;
  const spawn = deps.spawn;
  deps.spawn = (command, args, options) => {
    assert.ok(command.includes('pg_dump') && args.includes('--schema-only')); assert.ok(!args.includes('--format=custom'));
    const answer = spawn(command, args, options);
    const file = args.find(arg => arg.startsWith('--file=')).slice(7);
    fs.writeFileSync(file, mode === 'schema' ? check(rangeRestored.replace('>= 2', '>= 3')) : oldRestoredSchema);
    return answer;
  };
  return deps;
};
const originalHashes = Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, sha(fs.readFileSync(value.path))]));
const existingDeps = verifyAdapters('');
const supplement = await prepareBackup(verifyOptions, existingDeps);
assert.equal(supplement.verified, true); assert.equal(supplement.standardBackupReceiptIssued, false);
const supplementReport = JSON.parse(fs.readFileSync(supplement.reportPath));
assert.ok(!JSON.stringify(supplement).includes('synthetic-secret') && !JSON.stringify(supplementReport).includes('synthetic-secret'));
assert.equal(supplementReport.kind, 'database-existing-restore-verification.v1'); assert.equal(supplementReport.archive.preRestoreHashBound, false);
assert.equal(supplementReport.archive.hashProvenance, 'observedDuringReverification');
assert.equal(existingDeps.calls.creates, 0); assert.equal(existingDeps.calls.restores, 0); assert.equal(existingDeps.calls.connections.length, 1);
assert.ok(existingDeps.calls.connections.every(connection => connection.readOnly && connection.database === restoreName));
assert.ok(!existingDeps.calls.queries.some(sql => /CREATE|DROP|INSERT|UPDATE|DELETE|COMMIT/u.test(sql))); passed();
assert.equal(fs.existsSync(path.join(path.dirname(supplement.reportPath), 'backup-receipt.json')), false); passed();
const consumer = fileURLToPath(new URL('./verify-db-migration-apply-safety-zero-network.mjs', import.meta.url));
for (const receiptPath of [result.receiptPath, ipv6Result.receiptPath]) {
  const checked = spawnSync(process.execPath, [consumer], { encoding: 'utf8', env: { ...process.env, DATABASE_APPLY_SYNTHETIC_RECEIPT: receiptPath } });
  assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).syntheticProducerReceiptVerified, true); passed();
}
const rejectedSupplement = spawnSync(process.execPath, [consumer], { encoding: 'utf8', env: { ...process.env, DATABASE_APPLY_SYNTHETIC_RECEIPT: supplement.reportPath } });
assert.equal(rejectedSupplement.status, 1); assert.ok(rejectedSupplement.stderr.includes('BACKUP_EVIDENCE_FIELDS_INVALID')); passed();
for (const mode of ['schema', 'data', 'financial', 'roles', 'owner']) { const deps = verifyAdapters(mode); await assert.rejects(prepareBackup(verifyOptions, deps), /EXISTING_RESTORE_VERIFICATION_MISMATCH/u); assert.equal(deps.calls.creates + deps.calls.restores, 0); passed(); }
await assert.rejects(prepareBackup({ ...verifyOptions, 'confirm-input-manifest-sha256': '0'.repeat(64) }, verifyAdapters('')), /INPUT_MANIFEST_SHA256_MISMATCH/u); passed();
await assert.rejects(prepareBackup({ ...verifyOptions, 'output-root': oldDirectory, 'confirm-controlled-backup-root': oldDirectory }, verifyAdapters('')), /EXISTING_OUTPUT_MUST_BE_DISTINCT/u); passed();
const driftManifest = structuredClone(manifest); driftManifest.artifacts.failure.sha256 = '0'.repeat(64);
const driftFile = path.join(root, 'drift-input.json'); fs.writeFileSync(driftFile, JSON.stringify(driftManifest), { flag: 'wx' });
const driftDeps = verifyAdapters('');
await assert.rejects(prepareBackup({ ...verifyOptions, 'input-manifest': driftFile, 'confirm-input-manifest-sha256': sha(fs.readFileSync(driftFile)) }, driftDeps), /ORIGINAL_ARTIFACT_SHA256_MISMATCH/u); assert.equal(driftDeps.calls.connections.length, 0); passed();
for (const [key, entry] of Object.entries(artifacts)) assert.equal(sha(fs.readFileSync(entry.path)), originalHashes[key]); passed();

const schemaFixtureArg = process.argv.find(arg => arg.startsWith('--schema-fixture-root='));
let actualSchemaFixture = null;
if (schemaFixtureArg) {
  const directory = path.resolve(schemaFixtureArg.slice('--schema-fixture-root='.length));
  const comparison = compareRestoreSchemas(normalizeSchema(fs.readFileSync(path.join(directory, 'source-schema.sql'), 'utf8')), normalizeSchema(fs.readFileSync(path.join(directory, 'restored-schema.sql'), 'utf8')));
  assert.equal(comparison.equivalent, true); assert.equal(comparison.andAssociativityChanges, 45); assert.equal(comparison.literalArrayCastChanges, 10); assert.equal(comparison.unclassifiedDifferenceCount, 0);
  actualSchemaFixture = { ...comparison, changes: undefined, scope: 'Readonly RAM comparison of existing SQL artifacts only; no database/PG execution or recovery receipt.' }; passed();
}
console.log(JSON.stringify({ passed: true, cases, realDatabaseConnections: 0, realDatabaseWrites: 0, realPostgresToolCalls: 0,
  actualSchemaFixture,
  syntheticReceiptPath: result.receiptPath, syntheticIpv6ReceiptPath: ipv6Result.receiptPath, syntheticRoot: root, producerSha256: crypto.createHash('sha256').update(fs.readFileSync(cli)).digest('hex') }, null, 2));
