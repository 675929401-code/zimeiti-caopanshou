#!/usr/bin/env node
// Explicitly scoped local replica bootstrap. Source is read-only; rows never enter logs or files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const evidence = path.join(root, '.codex-evidence/local-data-bootstrap-20260902');
const phase = process.argv.find(arg => arg.startsWith('--phase='))?.slice(8) || 'plan';
const supported = ['plan', 'schema', 'copy', 'core', 'verify'];
if (!supported.includes(phase)) throw new Error('Unknown bootstrap phase');
if (phase === 'plan') {
  console.log(JSON.stringify({ mode: 'LOCAL_REPLICA_ONLY', phases: supported.slice(1), source: 'current protected .env.local (read-only)', target: '127.0.0.1:54322/zimeiti_local', historicalRows: 'copied, not discarded', remoteWrites: false }));
  process.exit(0);
}
const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/u, ''));
const connection = runtime.ownerConnection;
if (!connection || connection.host !== '127.0.0.1' || connection.port !== 54322
  || connection.database !== 'zimeiti_local' || connection.user !== 'zimeiti_owner') {
  throw new Error('Only the isolated local replica is allowed');
}
const client = new pg.Client({ ...connection, connectionTimeoutMillis: 10000 });
const { definitions } = JSON.parse(fs.readFileSync(path.join(evidence, 'schema-source.json'), 'utf8'));
const ident = name => {
  if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new Error('Invalid identifier');
  return `"${name}"`;
};
const hash = value => createHash('sha256').update(value).digest('hex');
let tableBeingProcessed = null;
const result = { phase, startedAt: new Date().toISOString(), target: '127.0.0.1:54322/zimeiti_local', remoteWrites: 0 };
try {
  await client.connect();
  const identity = await client.query('SELECT current_database() AS db, current_user AS role, host(inet_server_addr()) AS host');
  if (identity.rows[0]?.db !== 'zimeiti_local' || identity.rows[0]?.host !== '127.0.0.1') throw new Error('Local identity mismatch');
  if (phase === 'schema') {
    await client.query(fs.readFileSync(path.join(root, 'deploy/local/task-baseline.sql'), 'utf8'));
    await client.query('CREATE SCHEMA local_replica_meta; CREATE TABLE local_replica_meta.imports (id integer PRIMARY KEY CHECK(id=1), source_address_sha256 text NOT NULL, copied_at timestamptz NOT NULL, table_counts jsonb NOT NULL)');
    result.tablesCreated = Object.keys(definitions).length;
  }
  if (phase === 'copy') {
    const prior = await client.query('SELECT count(*) FROM local_replica_meta.imports');
    if (Number(prior.rows[0].count) !== 0) throw new Error('Replica import already completed; do not overwrite local work');
    const source = dotenv.parse(fs.readFileSync(path.join(root, '.env.local')));
    const sourceUrl = source.COZE_SUPABASE_URL;
    if (hash(sourceUrl || '') !== '935da8553e6525828288160c3d37d8373cbbb49a4db3f229756b6c7979213119'
      || !source.COZE_SUPABASE_SERVICE_ROLE_KEY) throw new Error('Reviewed source address mismatch');
    const counts = {};
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    for (const [table, definition] of Object.entries(definitions)) {
      tableBeingProcessed = table;
      const existing = await client.query(`SELECT count(*) FROM public.${ident(table)}`);
      if (Number(existing.rows[0].count) !== 0) throw new Error('Target table is not empty');
      const primary = Object.entries(definition.properties).filter(([, p]) => p.description?.includes('<pk/>')).map(([name]) => name);
      let count = 0;
      let total = null;
      for (;;) {
        const url = new URL(`${sourceUrl}/rest/v1/${table}`);
        url.searchParams.set('select', '*'); url.searchParams.set('limit', '500'); url.searchParams.set('offset', String(count));
        if (primary.length) url.searchParams.set('order', primary.map(name => `${name}.asc`).join(','));
        const response = await fetch(url, { headers: {
          apikey: source.COZE_SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${source.COZE_SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact',
        }, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw Object.assign(new Error('Source table read failed'), { code: `SOURCE_HTTP_${response.status}` });
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error('Source rows invalid');
        const range = response.headers.get('content-range')?.split('/').pop();
        if (range && range !== '*') total = Number(range);
        if (rows.length) {
          const columns = Object.keys(definition.properties).map(ident).join(',');
          await client.query(`INSERT INTO public.${ident(table)} (${columns}) SELECT ${columns} FROM jsonb_populate_recordset(NULL::public.${ident(table)}, $1::jsonb)`, [JSON.stringify(rows)]);
        }
        count += rows.length;
        if ((total !== null && count >= total) || rows.length === 0 || (total === null && rows.length < 500)) break;
      }
      if (total !== null && count !== total) throw new Error('Source count changed while copying');
      counts[table] = count;
      console.log(JSON.stringify({ phase: 'copy', table, copiedRows: count }));
    }
    for (const [table, definition] of Object.entries(definitions)) {
      for (const [column, prop] of Object.entries(definition.properties)) {
        if (prop.description?.includes('<pk/>') && ['bigint', 'integer', 'smallint'].includes(prop.format)) {
          await client.query(`SELECT setval(pg_get_serial_sequence($1,$2),greatest(coalesce(max(${ident(column)}),0),1),max(${ident(column)}) IS NOT NULL) FROM public.${ident(table)}`, [table, column]);
        }
      }
    }
    await client.query('INSERT INTO local_replica_meta.imports VALUES (1,$1,now(),$2::jsonb)', [hash(sourceUrl), JSON.stringify(counts)]);
    await client.query('COMMIT');
    result.tableCounts = counts;
    result.totalRows = Object.values(counts).reduce((sum, count) => sum + count, 0);
    result.consistency = 'Each table copied through read-only paginated REST; not a coordinated production transaction snapshot';
  }
  if (phase === 'core') {
    const imported = await client.query('SELECT count(*) FROM local_replica_meta.imports');
    if (Number(imported.rows[0].count) !== 1) throw new Error('Copy the existing records before applying migrations');
    const pointer = JSON.parse(fs.readFileSync(path.join(root, '.codex-evidence/core-migration-20260902/CURRENT.json'), 'utf8').replace(/^\uFEFF/u, ''));
    const bundle = fs.readFileSync(path.join(root, pointer.candidateDirectory, 'apply-all.sql'));
    if (hash(bundle) !== pointer.bundleSha256) throw new Error('Reviewed core migration bundle mismatch');
    for (const [key, value] of Object.entries({
      'app.core_migration_manifest_sha256': pointer.manifestSha256,
      'app.core_migration_target_database': 'zimeiti_local',
      'app.core_migration_backup_ref': 'new-local-replica-source-preserved-20260902',
      'app.core_migration_actor': 'local-task-repair',
    })) await client.query('SELECT set_config($1,$2,false)', [key, value]);
    await client.query(bundle.toString('utf8'));
    // This independent forward migration is now tested only on the new local replica.
    await client.query(fs.readFileSync(path.join(root, 'supabase/migrations/20260902203000_admin_credit_adjustments_atomic.sql'), 'utf8'));
    result.bundleSha256 = pointer.bundleSha256;
    result.migrationFilesApplied = 8;
  }
  if (phase === 'verify') {
    const imported = await client.query('SELECT table_counts FROM local_replica_meta.imports WHERE id=1');
    const counts = imported.rows[0]?.table_counts;
    if (!counts) throw new Error('Import evidence unavailable');
    result.countChecks = [];
    for (const [table, original] of Object.entries(counts)) {
      const read = await client.query(`SELECT count(*) FROM public.${ident(table)}`);
      const current = Number(read.rows[0].count);
      result.countChecks.push({ table, sourceRows: original, localRows: current, pass: original === current });
    }
    if (result.countChecks.some(check => !check.pass)) throw new Error('Local record counts differ');
    result.nativeCoreFunctions = (await client.query("SELECT proname FROM pg_proc JOIN pg_namespace ON pronamespace=pg_namespace.oid WHERE nspname='public' AND proname IN ('claim_extraction_attempt_atomic','reserve_video_generation_task_atomic','claim_image_generation_request','apply_wallet_operation_atomic') ORDER BY proname")).rows.map(row => row.proname);
    if (result.nativeCoreFunctions.length !== 4) throw new Error('Required native functions unavailable');
  }
  result.passed = true;
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(evidence, `${phase}-result.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ phase, passed: true, target: result.target, totalRows: result.totalRows, evidence: `${phase}-result.json` }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // PostgreSQL error detail can contain full private rows; never output it or a stack here.
  const failure = { phase, passed: false, table: tableBeingProcessed, code: String(error?.code || 'LOCAL_BOOTSTRAP_FAILED') };
  fs.writeFileSync(path.join(evidence, `${phase}-failure.json`), `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
