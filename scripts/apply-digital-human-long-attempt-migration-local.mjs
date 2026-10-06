import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const RUNTIME_PATH = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const MIGRATION_FILE = '20260904025000_digital_human_long_submission_attempt_accounting.sql';
const VERSION = '20260904025000';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function main() {
  assert.ok(process.argv.includes('--execute'), 'EXPLICIT_EXECUTION_REQUIRED');
  assert.ok(process.argv.includes('--confirm-local-function-only'), 'LOCAL_FUNCTION_ONLY_CONFIRMATION_REQUIRED');
  const runtime = JSON.parse((await readFile(RUNTIME_PATH, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(runtime.localOnly, true, 'LOCAL_RUNTIME_REQUIRED');
  assert.equal(runtime.host, '127.0.0.1', 'LOCAL_RUNTIME_HOST_REQUIRED');
  assert.equal(Number(runtime.databasePort), 54322, 'LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(runtime.databaseName, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
  const connection = new URL(String(runtime.databaseUrl || ''));
  assert.equal(connection.hostname, '127.0.0.1', 'LOCAL_DATABASE_URL_HOST_REQUIRED');
  assert.equal(connection.port, '54322', 'LOCAL_DATABASE_URL_PORT_REQUIRED');
  assert.equal(connection.pathname, '/zimeiti_local', 'LOCAL_DATABASE_URL_NAME_REQUIRED');

  const migrationPath = path.resolve('supabase/migrations', MIGRATION_FILE);
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.claim_digital_human_long_segment\(p_worker text\)/u);
  assert.match(sql, /attempt_count = attempt_count \+ CASE WHEN v_segment\.state = 'queued' THEN 1 ELSE 0 END/u);
  assert.doesNotMatch(sql, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+|TRUNCATE\s+|DELETE\s+FROM/iu, 'MIGRATION_SCOPE_EXCEEDS_FUNCTION_REPLACEMENT');
  assert.doesNotMatch(sql, /CREATE OR REPLACE FUNCTION public\.claim_digital_video_dispatch/u, 'ORDINARY_CLAIM_MUST_NOT_BE_REPLACED');
  const migrationHash = sha256(sql);
  const evidenceDir = path.resolve('artifacts', `digital-human-long-migration-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
  await mkdir(evidenceDir, { recursive: true });

  const client = new pg.Client({ connectionString: connection.toString(), connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  let transactionOpen = false;
  try {
    const identity = (await client.query("SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port")).rows[0];
    assert.equal(identity.database_name, 'zimeiti_local');
    assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === '::1');
    assert.equal(Number(identity.server_port), 54322);
    const beforeLongDefinition = String((await client.query("SELECT pg_get_functiondef('public.claim_digital_human_long_segment(text)'::regprocedure) AS definition")).rows[0]?.definition || '');
    const beforeOrdinaryDefinition = String((await client.query("SELECT pg_get_functiondef('public.claim_digital_video_dispatch(text)'::regprocedure) AS definition")).rows[0]?.definition || '');
    assert.ok(beforeLongDefinition && beforeOrdinaryDefinition, 'QUEUE_FUNCTION_SNAPSHOT_MISSING');
    const beforeLongHash = sha256(beforeLongDefinition);
    const beforeOrdinaryHash = sha256(beforeOrdinaryDefinition);
    const videoTasksBefore = (await client.query("SELECT count(*)::int AS count, md5(string_agg(id||':'||status,',' ORDER BY id)) AS digest FROM public.video_tasks")).rows[0];
    const ordinaryQueueBefore = (await client.query("SELECT count(*)::int AS count, md5(string_agg(task_id||':'||state||':'||coalesce(updated_at::text,''),',' ORDER BY task_id)) AS digest FROM public.digital_video_dispatch_jobs")).rows[0];
    const backupPath = path.join(evidenceDir, 'claim_digital_human_long_segment.before.sql');
    await writeFile(backupPath, beforeLongDefinition, 'utf8');
    const backupHash = sha256(await readFile(backupPath));

    await client.query('BEGIN'); transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-human-long-migration:20260904025000',0))");
    const priorLedger = await client.query('SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1', [VERSION]);
    if (priorLedger.rowCount) {
      assert.equal(String(priorLedger.rows[0].hash || ''), migrationHash, 'MIGRATION_LEDGER_HASH_CONFLICT');
    } else {
      await client.query(sql);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [VERSION, 'digital_human_long_submission_attempt_accounting', [MIGRATION_FILE], migrationHash, 'codex-local-long-video'],
      );
    }
    const afterLongDefinition = String((await client.query("SELECT pg_get_functiondef('public.claim_digital_human_long_segment(text)'::regprocedure) AS definition")).rows[0]?.definition || '');
    const afterOrdinaryDefinition = String((await client.query("SELECT pg_get_functiondef('public.claim_digital_video_dispatch(text)'::regprocedure) AS definition")).rows[0]?.definition || '');
    assert.match(afterLongDefinition, /attempt_count = attempt_count \+\s*CASE\s*WHEN v_segment\.state = 'queued' THEN 1\s*ELSE 0\s*END/iu);
    assert.equal(sha256(afterOrdinaryDefinition), beforeOrdinaryHash, 'ORDINARY_QUEUE_FUNCTION_CHANGED');
    const videoTasksAfter = (await client.query("SELECT count(*)::int AS count, md5(string_agg(id||':'||status,',' ORDER BY id)) AS digest FROM public.video_tasks")).rows[0];
    const ordinaryQueueAfter = (await client.query("SELECT count(*)::int AS count, md5(string_agg(task_id||':'||state||':'||coalesce(updated_at::text,''),',' ORDER BY task_id)) AS digest FROM public.digital_video_dispatch_jobs")).rows[0];
    assert.deepEqual(videoTasksAfter, videoTasksBefore, 'VIDEO_TASKS_CHANGED_DURING_DEFINITION_MIGRATION');
    assert.deepEqual(ordinaryQueueAfter, ordinaryQueueBefore, 'ORDINARY_QUEUE_ROWS_CHANGED_DURING_DEFINITION_MIGRATION');
    const ledger = (await client.query('SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1', [VERSION])).rows[0];
    assert.equal(String(ledger.hash), migrationHash, 'MIGRATION_LEDGER_WRITE_FAILED');
    await client.query('COMMIT'); transactionOpen = false;

    const summary = {
      ok: true, localRuntimeOnly: true, database: identity.database_name, serverAddress: identity.server_address, serverPort: identity.server_port,
      migration: MIGRATION_FILE, migrationHash, changedObject: 'public.claim_digital_human_long_segment(text)',
      beforeLongHash, afterLongHash: sha256(afterLongDefinition), beforeOrdinaryHash, afterOrdinaryHash: sha256(afterOrdinaryDefinition),
      ordinaryFunctionUnchanged: true, videoTasksUnchanged: true, ordinaryQueueRowsUnchanged: true,
      backupPath, backupHash, ledger: { version: ledger.version, name: ledger.name, hash: ledger.hash, appliedBy: ledger.applied_by, appliedAt: ledger.applied_at },
      credentialsPrinted: false,
    };
    const summaryPath = path.join(evidenceDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify({ ...summary, backupPath, summaryPath }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), credentialsPrinted: false }));
  process.exitCode = 1;
});
