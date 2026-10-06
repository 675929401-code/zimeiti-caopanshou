import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import ts from 'typescript';

// The only writes are reservation calls inside one local BEGIN/ROLLBACK. No
// supplier calls, balance updates, schema changes, user creation, or COMMIT.
const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/u, ''));
const connection = runtime.ownerConnection;
assert.equal(connection.host, '127.0.0.1'); assert.equal(Number(connection.port), 54322); assert.equal(connection.database, 'zimeiti_local');
const report = { at: new Date().toISOString(), localDatabaseOnly: true, database: 'zimeiti_local', port: 54322, supplierRequests: 0, newUsers: 0, schemaChanges: 0, stages: [] };
const files = ['src/lib/video-admin-validation.ts', 'src/lib/video-terminal-finalizer.ts', 'src/app/api/video/generate/route.ts'];
report.sourceSha256 = Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const parse = file => { const source = fs.readFileSync(file, 'utf8'); return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); };
const helperTree = parse(files[0]);
const helperFunctions = new Set(['buildVideoAdminValidationClaimKey', 'canonical', 'serverOnly']);
const helpers = helperTree.statements.filter(node => (ts.isFunctionDeclaration(node) && helperFunctions.has(node.name?.text)) || (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(helperTree) === 'sha')) || (ts.isClassDeclaration(node) && node.name?.text === 'VideoAdminValidationError')).map(node => node.getText(helperTree)).join('\n');
const terminalTree = parse(files[1]);
const identityFunction = terminalTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'buildVideoTaskIdentity');
assert.ok(identityFunction);
const routeTree = parse(files[2]);
let identityStatement;
function walk(node) { if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(routeTree) === 'taskIdentity')) identityStatement = node.getText(routeTree); ts.forEachChild(node, walk); }
walk(routeTree); assert.ok(identityStatement);
const loadedModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(helpers + '\n' + identityFunction.getText(terminalTree) + `\nexport function actualRouteIdentity(userId: string, validationClaimKey: string, normalizedClientRequestId: string) { ${identityStatement}\nreturn taskIdentity; }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: loadedModule, exports: loadedModule.exports, createHash }, { filename: 'actual-validation-reservation-identity.ts' });
const actual = loadedModule.exports;
const client = new pg.Client({ ...connection, connectionTimeoutMillis: 5000 });
let inTransaction = false;
let stage = 'connect';
let taskId;
let userIds;
let beforeBalances;
let beforeLedger;
const fingerprint = createHash('sha256').update('reservation-rollback:' + randomUUID()).digest('hex');
const balances = async () => (await client.query('SELECT id::text AS id,cash_balance::text AS cash,credits::text AS credits FROM public.users WHERE id::text = ANY($1::text[]) ORDER BY id::text', [userIds])).rows;
const ledgerCounts = async () => (await client.query('SELECT (SELECT count(*)::int FROM public.wallet_operations WHERE user_id::text = ANY($1::text[])) AS operations,(SELECT count(*)::int FROM public.wallet_ledger_entries WHERE user_id::text = ANY($1::text[])) AS entries', [userIds])).rows[0];
const countTask = async () => (await client.query('SELECT count(*)::int AS n FROM public.video_tasks WHERE id::text=$1', [taskId])).rows[0].n;
const reserveSql = `SELECT public.reserve_video_generation_task_atomic(
  p_task_id => $1::text,p_user_id => $2::text,p_model_id => $3::text,p_client_request_id => $4::text,p_request_fingerprint => $5::text,
  p_billing_price_yuan => 0::numeric,p_billing_cost_price_yuan => 0::numeric,p_billing_unit => 'per_use'::text,p_billing_quantity => 1::numeric,
  p_explicitly_free => true,p_billing_exempt => true,p_task_label => 'local-rollback-reservation-test'::text,p_prompt => ''::text) AS receipt`;
try {
  await client.connect();
  await client.query('BEGIN'); inTransaction = true;
  await client.query("SET LOCAL statement_timeout = '5000ms'"); await client.query("SET LOCAL lock_timeout = '2000ms'");
  assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'zimeiti_local');
  stage = 'select-existing-test-user';
  const testUsers = await client.query("SELECT id::text AS id FROM public.users WHERE username ~* '^(e2e[-_]|test[-_]|local[-_].*test)' ORDER BY id::text LIMIT 2");
  userIds = testUsers.rows.map(row => row.id);
  report.existingTestUserCount = userIds.length;
  if (!userIds.length) {
    const fallback = await client.query('SELECT id::text AS id FROM public.users WHERE username=$1', ['18685178259']);
    assert.equal(fallback.rowCount, 1); userIds = [fallback.rows[0].id]; report.authorizedAdminFallback = true;
  }
  const model = (await client.query('SELECT id::text AS id FROM public.video_models ORDER BY is_active DESC,id LIMIT 1')).rows[0];
  assert.ok(model);
  const reservationRpcs = (await client.query("SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments, md5(pg_get_functiondef(p.oid)) AS digest FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reserve_video_generation_task_atomic' ORDER BY 1")).rows;
  assert.equal(reservationRpcs.length, 1, 'reservation RPC must have one PostgREST-visible overload');
  assert.match(reservationRpcs[0].arguments, /p_duration_seconds numeric(?: DEFAULT 5)?/);
  report.rpcSignature = reservationRpcs[0].signature;
  report.rpcDefinitionMd5 = reservationRpcs[0].digest;
  beforeBalances = await balances(); beforeLedger = await ledgerCounts();
  const context = { model: { id: model.id }, configurationHash: fingerprint, healthEpoch: fingerprint };
  const claim = actual.buildVideoAdminValidationClaimKey(context);
  const hiddenKey = 'vav_' + fingerprint;
  const recoveryKey = 'vrc_' + fingerprint;
  const firstIdentity = actual.actualRouteIdentity(userIds[0], claim, hiddenKey);
  const otherEntryIdentity = actual.actualRouteIdentity(userIds[0], claim, recoveryKey);
  assert.equal(firstIdentity.taskIdInternal, otherEntryIdentity.taskIdInternal);
  assert.equal(firstIdentity.providerIdempotencyKey, otherEntryIdentity.providerIdempotencyKey);
  taskId = firstIdentity.taskIdInternal;
  assert.equal(await countTask(), 0);
  stage = 'first-reservation';
  const args = [taskId, userIds[0], model.id, hiddenKey, fingerprint];
  const first = (await client.query(reserveSql, args)).rows[0].receipt;
  assert.equal(first.created, true); assert.equal(first.task_id, taskId); assert.equal(await countTask(), 1);
  report.stages.push({ name: stage, created: true, transactionTaskCount: 1 });
  stage = 'same-entry-replay';
  const replay = (await client.query(reserveSql, args)).rows[0].receipt;
  assert.equal(replay.created, false); assert.equal(replay.task_id, taskId); assert.equal(await countTask(), 1);
  report.stages.push({ name: stage, replayed: true, transactionTaskCount: 1 });
  async function expectConflict(name, parameters) {
    stage = name; await client.query('SAVEPOINT reservation_conflict');
    let conflictCode = null;
    try { await client.query(reserveSql, parameters); }
    catch (error) { conflictCode = error.code; }
    await client.query('ROLLBACK TO SAVEPOINT reservation_conflict'); await client.query('RELEASE SAVEPOINT reservation_conflict');
    assert.equal(conflictCode, '23505'); assert.equal(await countTask(), 1);
    report.stages.push({ name, conflictSqlstate: conflictCode, transactionTaskCount: 1 });
  }
  await expectConflict('same-user-other-entry-same-shared-task', [taskId, userIds[0], model.id, recoveryKey, fingerprint]);
  await expectConflict('same-entry-changed-payload', [taskId, userIds[0], model.id, hiddenKey, createHash('sha256').update(fingerprint).digest('hex')]);
  if (userIds.length >= 2) {
    assert.equal(actual.actualRouteIdentity(userIds[1], claim, 'vav_second_' + fingerprint).taskIdInternal, taskId);
    await expectConflict('different-test-user-same-shared-task', [taskId, userIds[1], model.id, 'vav_second_' + fingerprint, fingerprint]);
    report.crossUserReservationTested = true;
  } else {
    report.crossUserReservationTested = false; report.crossUserSkipReason = 'Only one existing test user; authorized same-user/different-entry fallback used.';
  }
  stage = 'rollback';
  assert.deepEqual(await balances(), beforeBalances); assert.deepEqual(await ledgerCounts(), beforeLedger);
  await client.query('ROLLBACK'); inTransaction = false;
  assert.equal(await countTask(), 0); assert.deepEqual(await balances(), beforeBalances); assert.deepEqual(await ledgerCounts(), beforeLedger);
  report.stages.push({ name: 'after-rollback', remainingOwnTasks: 0, balancesUnchanged: true, walletOperationsUnchanged: true, walletLedgerUnchanged: true });
  report.rolledBack = true; report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { stage, name: error.name, code: typeof error.code === 'string' ? error.code : 'ASSERTION_OR_RUNTIME_ERROR' };
  process.exitCode = 1;
} finally {
  if (inTransaction) { try { await client.query('ROLLBACK'); report.rolledBack = true; } catch { report.rolledBack = false; } }
  await client.end();
  const output = process.argv[2];
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify(report, null, 2));
}
