import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const version = '20261018095000';
const file = `${version}_video_token_billing.sql`;
const runtime = JSON.parse((await readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.host, '127.0.0.1');
assert.equal(Number(runtime.databasePort), 54322);
assert.equal(runtime.databaseName, 'zimeiti_local');
assert.ok(process.argv.includes('--apply-local-schema'));
const db = new pg.Client({ ...runtime.ownerConnection, application_name: 'codex-token-schema-local' });
const sql = await readFile(path.resolve('supabase/migrations', file), 'utf8');
const hash = createHash('sha256').update(sql).digest('hex');
const evidence = path.resolve('../运行日志/Seedance-Token修复-20261018');
await mkdir(evidence, { recursive: true });
await db.connect();
try {
  const identity = (await db.query('SELECT current_database() AS db,inet_server_addr()::text AS host,inet_server_port() AS port')).rows[0];
  assert.equal(identity.db, 'zimeiti_local'); assert.equal(identity.port, 54322);
  assert.ok(/^(?:127\.0\.0\.1(?:\/32)?|::1(?:\/128)?)$/u.test(identity.host));
  const backup = (await db.query(`SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('enforce_video_budget_reservation_atomic','reserve_video_token_task_v1_atomic','record_video_token_usage_v1_atomic','settle_video_token_task_v1_atomic','guard_video_token_wallet_charge')`)).rows;
  const constraints = (await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.video_tasks'::regclass")).rows;
  const audit = async () => (await db.query(`SELECT
    (SELECT md5(string_agg(id::text||':'||coalesce(cash_balance::text,'')||':'||coalesce(credits::text,''),',' ORDER BY id)) FROM public.users) AS balances,
    (SELECT md5(string_agg(id::text||':'||status||':'||coalesce(price_charged::text,''),',' ORDER BY id)) FROM public.video_tasks) AS tasks,
    (SELECT count(*)::int FROM public.wallet_operations) AS wallet_count`)).rows[0];
  const before = await audit();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await writeFile(path.join(evidence, `schema-before-${stamp}.json`), JSON.stringify({ identity, backup, constraints, before }, null, 2));
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('video-token-billing-schema',0))");
  const ledger = (await db.query('SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1', [version])).rows[0];
  if (ledger) assert.equal(ledger.hash, hash, 'MIGRATION_ALREADY_APPLIED_WITH_DIFFERENT_HASH');
  else {
    assert.match(sql, /\bBEGIN;/u); assert.match(sql, /COMMIT;\s*$/u);
    await db.query(sql.replace(/\bBEGIN;/u, '').replace(/COMMIT;\s*$/u, ''));
    await db.query(`INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      VALUES($1,$2,$3,$4,'codex-local-token-billing',now())`, [version, 'video_token_billing', [file], hash]);
  }
  assert.deepEqual(await audit(), before, 'SCHEMA_MIGRATION_CHANGED_BUSINESS_ROWS');
  await db.query('COMMIT');
  const report = { passed: true, identity, migration: file, hash, businessRowsUnchanged: true, providerRequests: 0, paidGenerationCalls: 0 };
  await writeFile(path.join(evidence, `schema-apply-${stamp}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
finally { await db.end(); }
