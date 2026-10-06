import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

// Exercises the real local failure-finalization RPC inside one transaction.
// Every temporary row mutation is rolled back and no supplier endpoint is called.
const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/u, ''));
const connection = runtime.ownerConnection;
assert.equal(connection.host, '127.0.0.1');
assert.equal(Number(connection.port), 54322);
assert.equal(connection.database, 'zimeiti_local');

const sourceFiles = [
  'supabase/migrations/20260904025500_video_provider_failure_terminal.sql',
  'src/lib/video-terminal-finalizer.ts',
  'src/lib/video-task-status.ts',
];
const report = {
  at: new Date().toISOString(),
  localDatabaseOnly: true,
  database: connection.database,
  port: Number(connection.port),
  supplierRequests: 0,
  committedDatabaseWrites: 0,
  sourceSha256: Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  stages: [],
};

const client = new pg.Client({ ...connection, connectionTimeoutMillis: 5000 });
let inTransaction = false;
let stage = 'connect';
let task;
let beforeTask;
let beforeBalance;
let beforeLedger;

const taskColumns = `id::text AS id,user_id::text AS user_id,task_id_external,status,billing_state,
  coalesce(price_charged,0)::text AS price_charged,billing_operation_id::text,
  submission_error_code,error_message,completed_at::text`;
const readTask = async taskId => (await client.query(`SELECT ${taskColumns} FROM public.video_tasks WHERE id::text=$1`, [taskId])).rows[0] || null;
const readBalance = async userId => (await client.query('SELECT id::text AS id,cash_balance::text AS cash,credits::text AS credits FROM public.users WHERE id::text=$1', [userId])).rows[0];
const readLedger = async userId => (await client.query(`SELECT
  (SELECT count(*)::int FROM public.wallet_operations WHERE user_id::text=$1) AS operations,
  (SELECT count(*)::int FROM public.wallet_ledger_entries WHERE user_id::text=$1) AS entries`, [userId])).rows[0];
const finalizeSql = `SELECT public.finalize_video_generation_failure_atomic(
  p_task_id => $1::text,
  p_user_id => $2::text,
  p_provider_task_id => $3::text,
  p_error_code => $4::text,
  p_error_message => $5::text
) AS receipt`;

async function expectSqlstate(name, parameters, expected) {
  stage = name;
  await client.query('SAVEPOINT failure_case');
  let code = null;
  try {
    await client.query(finalizeSql, parameters);
  } catch (error) {
    code = error.code || null;
  }
  await client.query('ROLLBACK TO SAVEPOINT failure_case');
  await client.query('RELEASE SAVEPOINT failure_case');
  assert.equal(code, expected);
  report.stages.push({ name, sqlstate: code });
}

try {
  await client.connect();
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'zimeiti_local');

  stage = 'inspect-rpc-contract';
  const rpcRows = (await client.query(`SELECT p.oid::regprocedure::text AS signature,
      pg_get_function_arguments(p.oid) AS arguments,
      md5(pg_get_functiondef(p.oid)) AS definition_md5,
      has_function_privilege('service_role',p.oid,'EXECUTE') AS service_role_execute,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('public',p.oid,'EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='finalize_video_generation_failure_atomic'`)).rows;
  assert.equal(rpcRows.length, 1);
  assert.equal(rpcRows[0].service_role_execute, true);
  assert.equal(rpcRows[0].anon_execute, false);
  assert.equal(rpcRows[0].authenticated_execute, false);
  assert.equal(rpcRows[0].public_execute, false);
  report.rpc = rpcRows[0];

  stage = 'select-real-zero-charge-failed-task';
  task = (await client.query(`SELECT ${taskColumns} FROM public.video_tasks
    WHERE status='failed' AND billing_state='failed' AND coalesce(price_charged,0)=0
      AND billing_operation_id IS NULL AND nullif(trim(coalesce(task_id_external,'')),'') IS NOT NULL
    ORDER BY completed_at DESC NULLS LAST LIMIT 1`)).rows[0];
  assert.ok(task?.id && task.user_id && task.task_id_external);
  beforeTask = await readTask(task.id);
  beforeBalance = await readBalance(task.user_id);
  beforeLedger = await readLedger(task.user_id);

  await client.query('BEGIN');
  inTransaction = true;
  await client.query("SET LOCAL statement_timeout = '5000ms'");
  await client.query("SET LOCAL lock_timeout = '2000ms'");

  stage = 'prepare-provider-submitted-fixture';
  await client.query(`UPDATE public.video_tasks SET status='processing',billing_state='provider_submitted',
      price_charged=0,submission_error_code=NULL,error_message='provider pending',completed_at=NULL
    WHERE id::text=$1 AND user_id::text=$2`, [task.id, task.user_id]);

  stage = 'first-finalization';
  const first = (await client.query(finalizeSql, [task.id, task.user_id, task.task_id_external, 'VIDEO_INPUT_UNAVAILABLE', 'Provider could not read the source media'])).rows[0].receipt;
  assert.equal(first.status, 'failed');
  assert.equal(first.billing_state, 'failed');
  assert.equal(Number(first.price_charged), 0);
  assert.equal(first.already_failed, false);
  const settled = await readTask(task.id);
  assert.equal(settled.status, 'failed');
  assert.equal(settled.billing_state, 'failed');
  assert.equal(Number(settled.price_charged), 0);
  assert.equal(settled.submission_error_code, 'VIDEO_INPUT_UNAVAILABLE');
  assert.equal(settled.error_message, 'Provider could not read the source media');
  assert.ok(settled.completed_at);
  report.stages.push({ name: stage, status: settled.status, billingState: settled.billing_state, priceCharged: 0 });

  stage = 'idempotent-replay';
  const replay = (await client.query(finalizeSql, [task.id, task.user_id, task.task_id_external, 'OTHER_CODE', 'A replay must not replace terminal evidence'])).rows[0].receipt;
  assert.equal(replay.already_failed, true);
  const replayed = await readTask(task.id);
  assert.equal(replayed.submission_error_code, 'VIDEO_INPUT_UNAVAILABLE');
  assert.equal(replayed.error_message, 'Provider could not read the source media');
  report.stages.push({ name: stage, alreadyFailed: true, terminalEvidencePreserved: true });

  await expectSqlstate('provider-task-conflict', [task.id, task.user_id, `${task.task_id_external}-other`, 'ERR', 'conflict'], '23505');
  await expectSqlstate('wrong-owner-is-not-found', [task.id, '00000000-0000-0000-0000-000000000000', task.task_id_external, 'ERR', 'wrong owner'], 'P0002');
  await expectSqlstate('invalid-empty-message', [task.id, task.user_id, task.task_id_external, 'ERR', ''], '22023');

  stage = 'billing-guard';
  await client.query('SAVEPOINT billing_guard');
  await client.query("UPDATE public.video_tasks SET status='processing',billing_state='provider_submitted',price_charged=0.01 WHERE id::text=$1", [task.id]);
  let billingGuardCode = null;
  try {
    await client.query(finalizeSql, [task.id, task.user_id, task.task_id_external, 'ERR', 'must fail closed']);
  } catch (error) {
    billingGuardCode = error.code || null;
  }
  await client.query('ROLLBACK TO SAVEPOINT billing_guard');
  await client.query('RELEASE SAVEPOINT billing_guard');
  assert.equal(billingGuardCode, '23514');
  report.stages.push({ name: stage, sqlstate: billingGuardCode, failedClosed: true });

  stage = 'terminal-completed-conflict';
  await client.query('SAVEPOINT terminal_conflict');
  await client.query("UPDATE public.video_tasks SET status='completed',billing_state='not_required',price_charged=0 WHERE id::text=$1", [task.id]);
  let terminalCode = null;
  try {
    await client.query(finalizeSql, [task.id, task.user_id, task.task_id_external, 'ERR', 'must not overwrite completed']);
  } catch (error) {
    terminalCode = error.code || null;
  }
  await client.query('ROLLBACK TO SAVEPOINT terminal_conflict');
  await client.query('RELEASE SAVEPOINT terminal_conflict');
  assert.equal(terminalCode, '23505');
  report.stages.push({ name: stage, sqlstate: terminalCode, completedTaskPreserved: true });

  stage = 'wallet-unchanged-inside-transaction';
  assert.deepEqual(await readBalance(task.user_id), beforeBalance);
  assert.deepEqual(await readLedger(task.user_id), beforeLedger);
  report.stages.push({ name: stage, balancesUnchanged: true, walletLedgerUnchanged: true });

  stage = 'rollback';
  await client.query('ROLLBACK');
  inTransaction = false;
  assert.deepEqual(await readTask(task.id), beforeTask);
  assert.deepEqual(await readBalance(task.user_id), beforeBalance);
  assert.deepEqual(await readLedger(task.user_id), beforeLedger);
  report.stages.push({ name: 'after-rollback', originalTaskRestored: true, balancesUnchanged: true, walletLedgerUnchanged: true });

  const statusSource = fs.readFileSync('src/lib/video-task-status.ts', 'utf8');
  assert.ok((statusSource.match(/finalizeVideoGenerationFailure\s*\(/gu) || []).length >= 3);
  assert.doesNotMatch(statusSource, /为避免重复扣费[，,；;：:]?\s*请人工/gu);
  report.routeContract = { atomicFailureFinalizerCallSites: (statusSource.match(/finalizeVideoGenerationFailure\s*\(/gu) || []).length, legacyManualReconciliationCopy: false };
  report.rolledBack = true;
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = { stage, name: error.name, code: typeof error.code === 'string' ? error.code : 'ASSERTION_OR_RUNTIME_ERROR', message: String(error.message || '').slice(0, 300) };
  process.exitCode = 1;
} finally {
  if (inTransaction) {
    try {
      await client.query('ROLLBACK');
      report.rolledBack = true;
    } catch {
      report.rolledBack = false;
    }
  }
  await client.end();
  const output = process.argv[2];
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
}
