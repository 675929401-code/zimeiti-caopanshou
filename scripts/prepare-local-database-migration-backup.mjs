#!/usr/bin/env node
// Dedicated local pre-migration evidence producer. Never runs migrations or workers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDatabaseTargetIdentity } from './lib/database-target-identity.mjs';
import { compareRestoreSchemas } from './lib/database-restore-schema-comparison.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
class BackupError extends Error {}
const fail = code => { throw new BackupError(code); };
const safeCode = error => error instanceof BackupError ? error.message : 'BACKUP_OPERATION_FAILED';
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
const normalizedHost = host => loopback(host) ? 'loopback' : host;
const iso = () => new Date().toISOString();
const sameTuple = (a, b) => normalizedHost(a.host) === normalizedHost(b.host) && a.port === b.port && a.database === b.database;
const within = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

export function parseArguments(args) {
  const allowed = new Set(['execute', 'output-root', 'confirm-controlled-backup-root', 'pg-bin', 'restore-database',
    'confirm-source-host', 'confirm-source-port', 'confirm-source-database', 'confirm-source-fingerprint',
    'verify-existing', 'input-manifest', 'confirm-input-manifest-sha256']);
  const options = {};
  for (const arg of args) {
    const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/u.exec(arg);
    if (!match || !allowed.has(match[1]) || Object.hasOwn(options, match[1])) fail('ARGUMENT_INVALID');
    const flag = ['execute', 'verify-existing'].includes(match[1]);
    if (flag ? match[2] !== undefined : !match[2]) fail('ARGUMENT_INVALID');
    options[match[1]] = flag ? true : match[2];
  }
  return options;
}

export function parseLocalConnection(value) {
  let url;
  try { url = new URL(value); } catch { fail('CONNECTION_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) fail('CONNECTION_OPTIONS_FORBIDDEN');
  // Preserve configured URL spelling for the shared runner fingerprint; strip brackets only for transport.
  const host = url.hostname.toLowerCase();
  if (!loopback(host)) fail('REMOTE_TARGET_FORBIDDEN');
  let user, password, database;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); database = decodeURIComponent(url.pathname.slice(1)); }
  catch { fail('CONNECTION_INVALID'); }
  const port = Number(url.port || 5432);
  if (!user || !database || !password || password.includes('\0') || /[\x00-\x1f/\\]/u.test(database + user)
    || !Number.isInteger(port) || port < 1 || port > 65535) fail('CONNECTION_INVALID');
  return { host, port, user, password, database };
}

export function archiveDigest(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const before = fs.fstatSync(fd), buffer = Buffer.alloc(1024 * 1024), digest = crypto.createHash('sha256');
    if (!before.isFile() || before.size < 5 || !Number.isSafeInteger(before.size)) fail('ARCHIVE_INVALID');
    let bytes = 0, header = '';
    for (;;) {
      const length = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!length) break;
      if (bytes < 5) header += buffer.subarray(0, Math.min(length, 5 - bytes)).toString('ascii');
      digest.update(buffer.subarray(0, length)); bytes += length;
    }
    const after = fs.fstatSync(fd), current = fs.statSync(file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key] || before[key] !== current[key]) || bytes !== before.size) fail('ARCHIVE_CHANGED');
    if (header !== 'PGDMP') fail('ARCHIVE_HEADER_INVALID');
    return { sha256: digest.digest('hex'), bytes };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function smallBytes(file, limit = 16 * 1024 * 1024) {
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > limit) fail('EVIDENCE_SIZE_INVALID');
  const value = fs.readFileSync(file);
  if (value.length > limit) fail('EVIDENCE_SIZE_INVALID');
  return value;
}

export function normalizeSchema(text) {
  const lines = text.split(/\r?\n/u), remove = new Set();
  let token = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], restrict = /^\\restrict ([A-Za-z0-9]+)$/u.exec(line);
    if (restrict) {
      if (token) fail('SCHEMA_OUTER_BOUNDARY_AMBIGUOUS');
      token = restrict[1]; remove.add(index); continue;
    }
    if (!line.trim() || line.startsWith('--')) {
      if (/^-- Dumped (?:from database|by pg_dump) version [A-Za-z0-9 .()+_-]+$/u.test(line)) remove.add(index);
      continue;
    }
    break;
  }
  if (token) {
    let found = false;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].trim() || lines[index].startsWith('--')) continue;
      if (lines[index] === `\\unrestrict ${token}`) { remove.add(index); found = true; }
      break;
    }
    if (!found) fail('SCHEMA_OUTER_BOUNDARY_AMBIGUOUS');
  }
  return lines.filter((_, index) => !remove.has(index)).join('\n');
}

function childEnvironment(config, environment) {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (environment[key] !== undefined) result[key] = environment[key];
  }
  return { ...result, PGHOST: config.host.replace(/^\[(.*)\]$/u, '$1'), PGPORT: String(config.port), PGDATABASE: config.database,
    PGUSER: config.user, PGPASSWORD: config.password, PGCONNECT_TIMEOUT: '10', PGSSLMODE: 'disable',
    PGAPPNAME: 'local-isolated-backup-producer' };
}

async function defaultConnect(config, readOnly) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ host: config.host.replace(/^\[(.*)\]$/u, '$1'), port: config.port, database: config.database,
    user: config.user, password: config.password, ssl: false, connectionTimeoutMillis: 10000,
    query_timeout: 120000, statement_timeout: 120000,
    application_name: 'local-isolated-backup-producer', options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'}` });
  await client.connect(); return client;
}

const ROLES_SQL = `select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,rolconfig
  from pg_roles order by rolname`;
const MEMBERS_SQL = `select parent.rolname as role_name,member.rolname as member_name,grantor.rolname as grantor_name,m.admin_option,
  to_jsonb(m)->>'inherit_option' as inherit_option,to_jsonb(m)->>'set_option' as set_option
  from pg_auth_members m join pg_roles parent on parent.oid=m.roleid join pg_roles member on member.oid=m.member
  join pg_roles grantor on grantor.oid=m.grantor order by parent.rolname,member.rolname,grantor.rolname`;
const FINANCIAL_SQL = `select jsonb_build_object(
  'users',(select count(*)::text from public.users),
  'creditsBalance',(select coalesce(sum(credits),0)::text from public.users),
  'cashBalance',(select coalesce(sum(cash_balance),0)::text from public.users),
  'creditsReserved',(select coalesce(sum(credits_reserved),0)::text from public.users),
  'creditTransactions',(select count(*)::text from public.credit_transactions),
  'creditTransactionAmount',(select coalesce(sum(amount),0)::text from public.credit_transactions),
  'cashTransactions',(select count(*)::text from public.cash_transactions),
  'cashTransactionAmount',(select coalesce(sum(amount),0)::text from public.cash_transactions),
  'walletLedgerEntries',(select count(*)::text from public.wallet_ledger_entries),
  'walletLedgerDelta',(select coalesce(sum(delta),0)::text from public.wallet_ledger_entries),
  'paymentOrders',(select count(*)::text from public.payment_orders),
  'paymentOrderAmount',(select coalesce(sum(amount),0)::text from public.payment_orders)) as evidence`;
const DATABASE_SQL = `select pg_get_userbyid(d.datdba) as owner,
  array(select a::text from unnest(coalesce(d.datacl,acldefault('d',d.datdba))) a order by a::text)
    = array(select a::text from unnest(acldefault('d',d.datdba)) a order by a::text) as default_acl,
  pg_encoding_to_char(d.encoding) as encoding,d.datcollate as collate,d.datctype as ctype,
  coalesce(to_jsonb(d)->>'datlocprovider','c') as locale_provider,
  to_jsonb(d)->>'datcollversion' as collation_version,d.datconnlimit as connection_limit,
  d.datallowconn as allow_connections,d.datistemplate as is_template,
  (select count(*)::text from pg_db_role_setting s where s.setdatabase=d.oid) as settings_count
  from pg_database d where d.datname=current_database()`;

async function dataBaseline(client) {
  const tables = await client.query("select schemaname,tablename from pg_tables where schemaname <> 'information_schema' and schemaname !~ '^pg_' order by schemaname,tablename");
  const counts = [];
  for (const row of tables.rows) {
    const result = await client.query(`select count(*)::text as count from ${quote(row.schemaname)}.${quote(row.tablename)}`);
    if (!/^\d+$/u.test(result.rows[0]?.count || '')) fail('ROW_COUNT_INVALID');
    counts.push({ schema: row.schemaname, table: row.tablename, count: result.rows[0].count });
  }
  const financial = (await client.query(FINANCIAL_SQL)).rows[0]?.evidence;
  if (!financial || Object.keys(financial).length !== 12) fail('FINANCIAL_BASELINE_INCOMPLETE');
  return { counts, financial };
}

// Dependency injection is import-only for offline safety tests; the CLI always uses real adapters.
export async function prepareBackup(options, dependencies = {}) {
  if (options.execute && options['verify-existing']) fail('MUTUALLY_EXCLUSIVE_MODES');
  if (options['verify-existing']) return verifyExisting(options, dependencies);
  if (!options.execute) return { mode: 'plan', executed: false, databaseConnected: false, filesWritten: false,
    sourceEnvironment: 'LOCAL_BACKUP_SOURCE_URL', restoreAdminEnvironment: 'LOCAL_BACKUP_RESTORE_ADMIN_URL',
    requiredArguments: ['--execute', '--output-root', '--confirm-controlled-backup-root', '--pg-bin', '--restore-database',
      '--confirm-source-host', '--confirm-source-port', '--confirm-source-database', '--confirm-source-fingerprint'],
    targetClass: 'local-loopback-only', restorePrefix: 'zimeiti_restore_YYYYMMDDHHMMSS_<8 lowercase hex>',
    existingVerification: { flag: '--verify-existing', sourceEnvironmentMeans: 'Existing isolated B; historical A identity comes only from the bound input manifest.',
      requiredAdditionalArguments: ['--input-manifest', '--confirm-input-manifest-sha256'], standardBackupReceiptIssued: false },
    cleanup: 'Isolated databases are retained; deletion requires a separate action.' };

  const environment = dependencies.environment || process.env;
  // pg's val() falls back to ambient PG* for false/empty values. Do not authorize that separate source.
  if (!dependencies.connect && Object.keys(process.env).some(key => /^PG/iu.test(key))) fail('AMBIENT_PG_ENVIRONMENT_FORBIDDEN');
  const source = parseLocalConnection(environment.LOCAL_BACKUP_SOURCE_URL || '');
  const admin = parseLocalConnection(environment.LOCAL_BACKUP_RESTORE_ADMIN_URL || '');
  const destination = { ...admin, database: options['restore-database'] };
  if (!/^zimeiti_restore_\d{14}_[a-f0-9]{8}$/u.test(destination.database || '')) fail('RESTORE_NAME_INVALID');
  if (admin.database !== 'postgres' || ['postgres', 'template0', 'template1'].includes(source.database)) fail('DATABASE_ROLE_INVALID');
  if (sameTuple(source, destination)) fail('SOURCE_RESTORE_SAME_TARGET');
  if (normalizedHost(source.host) !== normalizedHost(admin.host) || source.port !== admin.port) fail('SAME_LOCAL_CLUSTER_REQUIRED');
  if (options['confirm-source-host'] !== source.host || Number(options['confirm-source-port']) !== source.port
    || options['confirm-source-database'] !== source.database || !/^[a-f0-9]{64}$/u.test(options['confirm-source-fingerprint'] || '')) fail('SOURCE_CONFIRMATION_REQUIRED');
  const requestedRoot = options['output-root'];
  if (!requestedRoot || !path.isAbsolute(requestedRoot) || options['confirm-controlled-backup-root'] !== requestedRoot) fail('CONTROLLED_BACKUP_ROOT_REQUIRED');
  const outputRoot = fs.realpathSync(requestedRoot);
  if (path.resolve(requestedRoot) !== outputRoot || within(sourceRoot, outputRoot) || !fs.statSync(outputRoot).isDirectory()) fail('BACKUP_ROOT_UNSAFE');
  const pgBin = options['pg-bin'];
  if (!pgBin || !path.isAbsolute(pgBin)) fail('PG_BIN_REQUIRED');
  const tools = Object.fromEntries(['pg_dump', 'pg_restore'].map(name => {
    const file = path.join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''));
    if (!fs.statSync(file).isFile()) fail('PG_TOOL_INVALID');
    return [name, file];
  }));
  const connect = dependencies.connect || defaultConnect;
  const spawn = dependencies.spawn || spawnSync;
  let sourceClient, adminClient, restoredClient, directory, transactionOpen = false, restoreTransactionOpen = false;
  const actions = { sourceReadOnly: true, isolatedDatabaseCreated: false, createAttempted: false,
    creationState: 'not_started', creationObservation: 'not_checked', restoreAttempted: false, filesWritten: 0 };
  const write = (name, value) => {
    fs.writeFileSync(path.join(directory, name), typeof value === 'string' || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 }); actions.filesWritten++;
  };
  const run = (name, args, config) => {
    const result = spawn(tools[name], args, { env: childEnvironment(config, environment), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) fail(name === 'pg_dump' ? 'DUMP_FAILED' : 'RESTORE_TOOL_FAILED');
    return result.stdout || '';
  };
  try {
    sourceClient = await connect(source, true);
    adminClient = await connect(admin, false);
    const sourceIdentity = await readDatabaseTargetIdentity(sourceClient, source.host);
    const adminIdentity = await readDatabaseTargetIdentity(adminClient, admin.host);
    if (sourceIdentity.databaseName !== source.database || adminIdentity.databaseName !== admin.database
      || sourceIdentity.fingerprint !== options['confirm-source-fingerprint']) fail('ACTUAL_TARGET_MISMATCH');
    const clusterSql = 'select system_identifier::text as system_identifier from pg_control_system()';
    const sourceCluster = (await sourceClient.query(clusterSql)).rows[0]?.system_identifier;
    const adminCluster = (await adminClient.query(clusterSql)).rows[0]?.system_identifier;
    if (!/^\d+$/u.test(sourceCluster || '') || sourceCluster !== adminCluster) fail('ACTUAL_CLUSTER_MISMATCH');
    const existing = await adminClient.query('select datname from pg_database where datname=$1', [destination.database]);
    if (existing.rows.length) fail('RESTORE_DATABASE_ALREADY_EXISTS');
    await sourceClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transactionOpen = true;
    await sourceClient.query('SET LOCAL row_security=off');
    const db = (await sourceClient.query(DATABASE_SQL)).rows[0];
    if (!db?.owner || db.default_acl !== true) fail('DATABASE_LEVEL_ACL_UNSUPPORTED');
    if (db.locale_provider !== 'c' || db.settings_count !== '0' || db.allow_connections !== true || db.is_template !== false
      || !db.encoding || !db.collate || !db.ctype || !Number.isInteger(db.connection_limit)
      || Number(sourceIdentity.serverVersion) < 150000) fail('DATABASE_PROPERTIES_UNSUPPORTED');
    const snapshot = (await sourceClient.query('select pg_export_snapshot() as snapshot')).rows[0]?.snapshot;
    if (!/^[A-Za-z0-9._:-]+$/u.test(snapshot || '')) fail('SNAPSHOT_INVALID');
    const createdAt = iso();
    directory = path.join(outputRoot, `local-migration-backup-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const archivePath = path.join(directory, 'database.dump');
    run('pg_dump', ['--format=custom', '--compress=9', `--snapshot=${snapshot}`, `--file=${archivePath}`], source);
    actions.filesWritten++;
    run('pg_dump', ['--schema-only', '--quote-all-identifiers', `--snapshot=${snapshot}`, `--file=${path.join(directory, 'source-schema.sql')}`], source);
    actions.filesWritten++;
    const baseline = await dataBaseline(sourceClient);
    const roles = { roles: (await sourceClient.query(ROLES_SQL)).rows, members: (await sourceClient.query(MEMBERS_SQL)).rows };
    const schema = normalizeSchema(smallBytes(path.join(directory, 'source-schema.sql')).toString('utf8'));
    if (!schema.trim()) fail('SCHEMA_BASELINE_EMPTY');
    const archive = archiveDigest(archivePath);
    const toc = run('pg_restore', ['--list', archivePath], source);
    if (Buffer.byteLength(toc, 'utf8') > 16 * 1024 * 1024) fail('TOC_TOO_LARGE');
    const entryCount = toc.split(/\r?\n/u).filter(line => /^\d+;/u.test(line.trim())).length;
    if (!entryCount) fail('TOC_EMPTY');
    write('archive-toc.txt', toc);
    const completedAt = iso();
    await sourceClient.query('COMMIT'); transactionOpen = false;
    // CREATE has no IF NOT EXISTS: a concurrent name collision fails without touching that database.
    actions.createAttempted = true; actions.creationState = 'submitted_unknown'; actions.isolatedDatabaseCreated = null;
    try {
      await adminClient.query(`CREATE DATABASE ${quote(destination.database)} WITH TEMPLATE template0 OWNER ${quote(db.owner)}
        ENCODING ${literal(db.encoding)} LC_COLLATE ${literal(db.collate)} LC_CTYPE ${literal(db.ctype)}
        LOCALE_PROVIDER libc CONNECTION LIMIT ${db.connection_limit}`);
    } catch (error) {
      try {
        const observation = await adminClient.query('select datname from pg_database where datname=$1', [destination.database]);
        actions.creationObservation = observation.rows.length ? 'database_exists' : 'database_not_observed';
      } catch { actions.creationObservation = 'unknown'; }
      throw error;
    }
    actions.creationState = 'created';
    actions.isolatedDatabaseCreated = true;
    restoredClient = await connect(destination, true);
    const restoredIdentity = await readDatabaseTargetIdentity(restoredClient, destination.host);
    if (restoredIdentity.databaseName !== destination.database || sameTuple(source, { ...destination, database: restoredIdentity.databaseName })
      || (await restoredClient.query(clusterSql)).rows[0]?.system_identifier !== sourceCluster) fail('RESTORE_ACTUAL_TARGET_MISMATCH');
    if ((await restoredClient.query("select count(*)::text as count from pg_tables where schemaname <> 'information_schema' and schemaname !~ '^pg_'")).rows[0]?.count !== '0') fail('RESTORE_DATABASE_NOT_EMPTY');
    actions.restoreAttempted = true;
    run('pg_restore', ['--exit-on-error', '--single-transaction', `--dbname=${destination.database}`, archivePath], destination);
    if (stable(archiveDigest(archivePath)) !== stable(archive)) fail('ARCHIVE_CHANGED');
    await restoredClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); restoreTransactionOpen = true;
    await restoredClient.query('SET LOCAL row_security=off');
    const restoredSnapshot = (await restoredClient.query('select pg_export_snapshot() as snapshot')).rows[0]?.snapshot;
    if (!/^[A-Za-z0-9._:-]+$/u.test(restoredSnapshot || '')) fail('RESTORE_SNAPSHOT_INVALID');
    run('pg_dump', ['--schema-only', '--quote-all-identifiers', `--snapshot=${restoredSnapshot}`, `--file=${path.join(directory, 'restored-schema.sql')}`], destination);
    actions.filesWritten++;
    const restoredSchema = normalizeSchema(smallBytes(path.join(directory, 'restored-schema.sql')).toString('utf8'));
    const restoredData = await dataBaseline(restoredClient);
    const restoredRoles = { roles: (await restoredClient.query(ROLES_SQL)).rows, members: (await restoredClient.query(MEMBERS_SQL)).rows };
    const restoredDb = (await restoredClient.query(DATABASE_SQL)).rows[0];
    const schemaComparison = compareRestoreSchemas(schema, restoredSchema);
    const checks = { schema: schemaComparison.equivalent && stable(db) === stable(restoredDb) && stable(roles) === stable(restoredRoles), data: stable(baseline) === stable(restoredData) };
    write('verification-details.json', { kind: 'local-backup-verification-details.v1', checks, actions,
      schemaComparison, sourceSchemaSha256: hash(schema), restoredSchemaSha256: hash(restoredSchema), sourceDataSha256: hash(stable(baseline)),
      restoredDataSha256: hash(stable(restoredData)), sourceRolesSha256: hash(stable(roles)), restoredRolesSha256: hash(stable(restoredRoles)),
      scope: 'Same-cluster PostgreSQL 15+ libc, default database ACL, no database-specific settings; full object schema/owner/ACL and snapshot counts/financial aggregates. Not general disaster recovery.',
      workerIsolation: { applicationConfigurationChanged: false, workersStarted: false, providerCalls: 0 },
      sourceDatabasePropertiesSha256: hash(stable(db)), restoredDatabasePropertiesSha256: hash(stable(restoredDb)) });
    if (!checks.schema || !checks.data) fail('RESTORE_VERIFICATION_MISMATCH');
    await restoredClient.query('COMMIT'); restoreTransactionOpen = false;
    const report = { kind: 'database-isolated-restore-report.v1', archiveSha256: archive.sha256, sourceTargetFingerprint: sourceIdentity.fingerprint,
      exitCode: 0, targetIsolated: true, target: { host: destination.host, port: destination.port, database: destination.database }, checks, completedAt: iso() };
    write('restore-report.json', report);
    const receipt = { kind: 'pre-migration-database-backup-receipt.v1', schemaVersion: 1, targetClass: 'local-loopback-only',
      targetHost: source.host, targetPort: source.port, database: source.database, targetFingerprint: sourceIdentity.fingerprint,
      createdAt, completedAt, archivePath: 'database.dump', archiveSha256: archive.sha256, archiveBytes: archive.bytes, format: 'postgres-custom',
      readability: { tool: 'pg_restore --list', exitCode: 0, entryCount, evidencePath: 'archive-toc.txt', evidenceSha256: hash(smallBytes(path.join(directory, 'archive-toc.txt'))) },
      restore: { status: 'verified', evidencePath: 'restore-report.json', evidenceSha256: hash(smallBytes(path.join(directory, 'restore-report.json'))) } };
    write('backup-receipt.json', receipt);
    return { mode: 'execute', verified: true, receiptPath: path.join(directory, 'backup-receipt.json'),
      receiptSha256: hash(smallBytes(path.join(directory, 'backup-receipt.json'))), archiveSha256: archive.sha256, actions };
  } catch (error) {
    const code = safeCode(error);
    if (directory) { try { write('failure.json', { kind: 'local-backup-failure.v1', code, actions, completedAt: iso(),
      isolatedTarget: { host: destination.host, port: destination.port, database: destination.database },
      isolatedDatabaseRetained: actions.creationState === 'submitted_unknown' ? null : actions.isolatedDatabaseCreated,
      nextAction: actions.creationState === 'submitted_unknown' ? 'Inspect the named database before any retry; no automatic retry or deletion.' : 'Retain artifacts and any isolated database for review.' }); } catch {} }
    fail(code);
  } finally {
    if (transactionOpen) await sourceClient.query('ROLLBACK').catch(() => {});
    if (restoreTransactionOpen) await restoredClient.query('ROLLBACK').catch(() => {});
    for (const client of [restoredClient, adminClient, sourceClient]) if (client) await client.end().catch(() => {});
  }
}

function fields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(value, key))) fail('INPUT_MANIFEST_INVALID');
}

// Supplement only: never CREATE/restore/migrate, never issue a standard backup receipt.
async function verifyExisting(options, dependencies) {
  const environment = dependencies.environment || process.env;
  if (!dependencies.connect && Object.keys(process.env).some(key => /^PG/iu.test(key))) fail('AMBIENT_PG_ENVIRONMENT_FORBIDDEN');
  const source = parseLocalConnection(environment.LOCAL_BACKUP_SOURCE_URL || '');
  const requestedRoot = options['output-root'];
  if (!requestedRoot || !path.isAbsolute(requestedRoot) || options['confirm-controlled-backup-root'] !== requestedRoot) fail('CONTROLLED_BACKUP_ROOT_REQUIRED');
  const outputRoot = fs.realpathSync(requestedRoot);
  if (path.resolve(requestedRoot) !== outputRoot || within(sourceRoot, outputRoot) || !fs.statSync(outputRoot).isDirectory()) fail('BACKUP_ROOT_UNSAFE');
  const manifestPath = options['input-manifest'];
  if (!manifestPath || !path.isAbsolute(manifestPath) || within(sourceRoot, manifestPath)) fail('INPUT_MANIFEST_PATH_INVALID');
  const manifestBytes = smallBytes(manifestPath, 64 * 1024), manifestSha256 = hash(manifestBytes);
  if (!/^[a-f0-9]{64}$/u.test(options['confirm-input-manifest-sha256'] || '') || manifestSha256 !== options['confirm-input-manifest-sha256']) fail('INPUT_MANIFEST_SHA256_MISMATCH');
  let manifest; try { manifest = JSON.parse(manifestBytes); } catch { fail('INPUT_MANIFEST_INVALID'); }
  fields(manifest, ['kind', 'schemaVersion', 'historicalSourceFingerprint', 'expectedTarget', 'artifacts', 'archive']);
  fields(manifest.expectedTarget, ['host', 'port', 'database', 'fingerprint', 'systemIdentifier']);
  fields(manifest.artifacts, ['operatorResult', 'failure', 'verificationDetails', 'sourceSchema', 'oldRestoredSchema', 'toc']);
  fields(manifest.archive, ['path', 'sha256', 'bytes', 'hashProvenance']);
  const target = manifest.expectedTarget;
  if (manifest.kind !== 'database-existing-restore-input.v1' || manifest.schemaVersion !== 1
    || !/^[a-f0-9]{64}$/u.test(manifest.historicalSourceFingerprint || '') || manifest.historicalSourceFingerprint === target.fingerprint
    || !/^zimeiti_restore_\d{14}_[a-f0-9]{8}$/u.test(target.database || '') || !/^\d+$/u.test(target.systemIdentifier || '')
    || target.host !== source.host || target.port !== source.port || target.database !== source.database
    || options['confirm-source-host'] !== source.host || Number(options['confirm-source-port']) !== source.port
    || options['confirm-source-database'] !== source.database || options['confirm-source-fingerprint'] !== target.fingerprint
    || !/^[a-f0-9]{64}$/u.test(target.fingerprint || '') || manifest.archive.hashProvenance !== 'observedDuringReverification') fail('EXISTING_TARGET_CONFIRMATION_REQUIRED');
  const artifacts = {}, artifactHashes = {};
  for (const [name, entry] of Object.entries(manifest.artifacts)) {
    fields(entry, ['path', 'sha256']);
    if (!path.isAbsolute(entry.path) || within(sourceRoot, entry.path) || fs.lstatSync(entry.path).isSymbolicLink()
      || !/^[a-f0-9]{64}$/u.test(entry.sha256 || '')) fail('ORIGINAL_ARTIFACT_INVALID');
    const bytes = smallBytes(entry.path);
    if (hash(bytes) !== entry.sha256) fail('ORIGINAL_ARTIFACT_SHA256_MISMATCH');
    artifacts[name] = bytes; artifactHashes[name] = entry.sha256;
  }
  const originalDirectory = path.dirname(manifest.artifacts.sourceSchema.path);
  if (within(originalDirectory, outputRoot)) fail('EXISTING_OUTPUT_MUST_BE_DISTINCT');
  for (const name of ['failure', 'verificationDetails', 'oldRestoredSchema', 'toc']) if (path.dirname(manifest.artifacts[name].path) !== originalDirectory) fail('ORIGINAL_ARTIFACT_DIRECTORY_MISMATCH');
  if (!path.isAbsolute(manifest.archive.path) || path.dirname(manifest.archive.path) !== originalDirectory || fs.lstatSync(manifest.archive.path).isSymbolicLink()) fail('ARCHIVE_INVALID');
  const archive = archiveDigest(manifest.archive.path);
  if (archive.sha256 !== manifest.archive.sha256 || archive.bytes !== manifest.archive.bytes) fail('ARCHIVE_CHANGED');
  let details, failure, operator;
  try { details = JSON.parse(artifacts.verificationDetails); failure = JSON.parse(artifacts.failure); operator = JSON.parse(artifacts.operatorResult); } catch { fail('ORIGINAL_REPORT_INVALID'); }
  const originalSchema = normalizeSchema(artifacts.sourceSchema.toString('utf8'));
  const oldSchema = normalizeSchema(artifacts.oldRestoredSchema.toString('utf8'));
  if (details.kind !== 'local-backup-verification-details.v1' || failure.kind !== 'local-backup-failure.v1'
    || failure.code !== 'RESTORE_VERIFICATION_MISMATCH' || failure.actions?.creationState !== 'created' || failure.actions?.restoreAttempted !== true
    || failure.isolatedDatabaseRetained !== true || failure.isolatedTarget?.host !== target.host || failure.isolatedTarget?.port !== target.port || failure.isolatedTarget?.database !== target.database
    || operator.kind !== 'local-backup-operator-result.v1' || operator.exitCode !== 1 || operator.verified !== false
    || operator.code !== 'RESTORE_VERIFICATION_MISMATCH' || operator.sourceFingerprint !== manifest.historicalSourceFingerprint
    || operator.restoreDatabase !== target.database || operator.sourceDatabase === target.database
    || details.sourceSchemaSha256 !== hash(originalSchema) || details.restoredSchemaSha256 !== hash(oldSchema)
    || details.checks?.data !== true || !compareRestoreSchemas(originalSchema, oldSchema).equivalent
    || !['sourceDataSha256', 'sourceRolesSha256', 'sourceDatabasePropertiesSha256'].every(key => /^[a-f0-9]{64}$/u.test(details[key] || ''))
    || !artifacts.toc.toString('utf8').split(/\r?\n/u).some(line => /^\d+;/u.test(line.trim()))) fail('ORIGINAL_BASELINE_INVALID');
  const pgBin = options['pg-bin'];
  if (!pgBin || !path.isAbsolute(pgBin)) fail('PG_BIN_REQUIRED');
  const pgDump = path.join(pgBin, 'pg_dump' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.statSync(pgDump).isFile()) fail('PG_TOOL_INVALID');
  let client, directory, transactionOpen = false;
  const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    client = await (dependencies.connect || defaultConnect)(source, true);
    const identity = await readDatabaseTargetIdentity(client, source.host);
    const cluster = (await client.query('select system_identifier::text as system_identifier from pg_control_system()')).rows[0]?.system_identifier;
    if (identity.databaseName !== target.database || identity.fingerprint !== target.fingerprint || cluster !== target.systemIdentifier) fail('EXISTING_LIVE_IDENTITY_MISMATCH');
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transactionOpen = true;
    await client.query('SET LOCAL row_security=off');
    const snapshot = (await client.query('select pg_export_snapshot() as snapshot')).rows[0]?.snapshot;
    if (!/^[A-Za-z0-9._:-]+$/u.test(snapshot || '')) fail('SNAPSHOT_INVALID');
    directory = path.join(outputRoot, `existing-restore-verification-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    const schemaPath = path.join(directory, 'existing-schema.sql');
    const dump = (dependencies.spawn || spawnSync)(pgDump, ['--schema-only', '--quote-all-identifiers', `--snapshot=${snapshot}`, `--file=${schemaPath}`],
      { env: childEnvironment(source, environment), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000 });
    if (dump.error || dump.status !== 0) fail('DUMP_FAILED');
    const currentSchemaBytes = smallBytes(schemaPath), currentSchema = normalizeSchema(currentSchemaBytes.toString('utf8'));
    const schemaComparison = compareRestoreSchemas(originalSchema, currentSchema);
    const dataHash = hash(stable(await dataBaseline(client)));
    const rolesHash = hash(stable({ roles: (await client.query(ROLES_SQL)).rows, members: (await client.query(MEMBERS_SQL)).rows }));
    const databasePropertiesHash = hash(stable((await client.query(DATABASE_SQL)).rows[0]));
    const checks = { schema: schemaComparison.equivalent, data: dataHash === details.sourceDataSha256,
      roles: rolesHash === details.sourceRolesSha256, databaseProperties: databasePropertiesHash === details.sourceDatabasePropertiesSha256 };
    if (hash(smallBytes(manifestPath, 64 * 1024)) !== manifestSha256 || stable(archiveDigest(manifest.archive.path)) !== stable(archive)
      || Object.entries(manifest.artifacts).some(([name, entry]) => hash(smallBytes(entry.path)) !== artifactHashes[name])) fail('ORIGINAL_ARTIFACT_CHANGED');
    if (Object.values(checks).some(value => value !== true)) fail('EXISTING_RESTORE_VERIFICATION_MISMATCH');
    const report = { kind: 'database-existing-restore-verification.v1', verified: true, completedAt: iso(), inputManifestSha256: manifestSha256,
      producerSha256: hash(smallBytes(fileURLToPath(import.meta.url))), comparatorSha256: hash(smallBytes(fileURLToPath(new URL('./lib/database-restore-schema-comparison.mjs', import.meta.url)))),
      historicalSourceFingerprint: manifest.historicalSourceFingerprint, liveTarget: identity, systemIdentifier: cluster,
      originalArtifactSha256: artifactHashes, archive: { sha256: archive.sha256, bytes: archive.bytes, hashProvenance: 'observedDuringReverification', preRestoreHashBound: false },
      freshSchemaFileSha256: hash(currentSchemaBytes), schemaComparison, checks, currentDataSha256: dataHash, currentRolesSha256: rolesHash, currentDatabasePropertiesSha256: databasePropertiesHash,
      scope: 'Existing B matches original recorded snapshot baselines. Supplement only; original failure retained; not a standard backup receipt or retrospective pre-restore archive binding.',
      databaseWrites: 0, migrationsRun: 0, databasesCreated: 0, providerCalls: 0 };
    write('existing-restore-verification.json', report);
    return { mode: 'verify-existing', verified: true, reportPath: path.join(directory, 'existing-restore-verification.json'),
      reportSha256: hash(smallBytes(path.join(directory, 'existing-restore-verification.json'))), databaseWrites: 0, standardBackupReceiptIssued: false };
  } catch (error) {
    if (directory) { try { write('verification-failure.json', { kind: 'database-existing-restore-verification-failure.v1', verified: false,
      code: safeCode(error), inputManifestSha256: manifestSha256, completedAt: iso(), databaseWrites: 0, automaticRetry: false }); } catch {} }
    fail(safeCode(error));
  } finally {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    if (client) await client.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareBackup(parseArguments(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(JSON.stringify({ verified: false, code: safeCode(error) })); process.exitCode = 1; }
}
