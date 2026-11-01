import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';

const version = '20261023090000';
const name = 'storyboard_video_archive_lifecycle';
assert.ok(process.argv.includes('--execute') && process.argv.includes('--confirm-local-storyboard-archive'), 'EXPLICIT_LOCAL_EXECUTION_REQUIRED');
const runtime = JSON.parse((await fs.readFile('F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json', 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection.host, '127.0.0.1');
assert.equal(Number(runtime.ownerConnection.port), 54322);
assert.equal(runtime.ownerConnection.database, 'zimeiti_local');
const sql = (await fs.readFile(`supabase/migrations/${version}_${name}.sql`, 'utf8')).trim();
assert.match(sql, /^BEGIN\s*;/u); assert.match(sql, /COMMIT\s*;$/u);
const migrationHash = crypto.createHash('sha256').update(sql).digest('hex');
const db = new pg.Client({ ...runtime.ownerConnection, user: 'postgres', password: runtime.postgresPassword,
  connectionTimeoutMillis: 5000, query_timeout: 30000, application_name: 'codex-local-storyboard-archive-migration' });
let open = false;
await db.connect();
try {
  const identity = (await db.query('select current_database() db,host(inet_server_addr()) addr,inet_server_port() port')).rows[0];
  assert.deepEqual(identity, { db: 'zimeiti_local', addr: '127.0.0.1', port: 54322 });
  await db.query('BEGIN'); open = true;
  await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='20s'");
  await db.query("select pg_advisory_xact_lock(hashtextextended('storyboard-archive-migration:20261023090000',0))");
  const prior = await db.query('select hash from supabase_migrations.schema_migrations where version::text=$1', [version]);
  const before = (await db.query('select count(*)::text count,coalesce(sum(price_charged),0)::text fees from video_tasks')).rows[0];
  if (prior.rowCount) assert.equal(prior.rows[0].hash, migrationHash, 'MIGRATION_HASH_CONFLICT');
  else {
    await db.query(sql.replace(/^BEGIN\s*;/u, '').replace(/COMMIT\s*;$/u, ''));
    await db.query(`insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
      values($1,$2,$3,$4,$5,now())`, [version, name, [`${version}_${name}.sql`], migrationHash, 'codex-local-storyboard-history']);
  }
  const after = (await db.query('select count(*)::text count,coalesce(sum(price_charged),0)::text fees from video_tasks')).rows[0];
  assert.deepEqual(after, before, 'TASK_OR_FEE_TOTAL_CHANGED');
  const permission = (await db.query(`select
    has_function_privilege('anon','public.claim_storyboard_video_archive(text,integer)','execute') anon,
    has_function_privilege('authenticated','public.storyboard_archive_mutate(text,uuid,text,text,text,jsonb)','execute') authenticated,
    has_function_privilege('service_role','public.claim_storyboard_video_archive(text,integer)','execute') service`)).rows[0];
  assert.deepEqual(permission, { anon: false, authenticated: false, service: true });
  await db.query('COMMIT'); open = false;
  const report = { passed: true, checkedAt: new Date().toISOString(), target: '127.0.0.1:54322/zimeiti_local',
    action: prior.rowCount ? 'already_applied' : 'applied', migrationHash, taskCountBefore: before.count, taskCountAfter: after.count,
    feeTotalUnchanged: before.fees === after.fees, permission, productionWrites: 0 };
  const output = path.resolve('.codex-evidence/storyboard-history-20261023/archive-migration-apply.json');
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) { if (open) await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
