#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

const version = '20261109010000';
const name = 'publish_center_membership_and_execution';
const file = `${version}_${name}.sql`;
assert.ok(process.argv.includes('--execute'), 'EXPLICIT_LOCAL_EXECUTION_REQUIRED');
const reviewedHash = process.argv.find(value => value.startsWith('--reviewed-sha='))?.slice('--reviewed-sha='.length);
assert.match(reviewedHash || '', /^[a-f0-9]{64}$/, 'REVIEWED_MIGRATION_HASH_REQUIRED');
const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection?.host, '127.0.0.1');
assert.equal(Number(runtime.ownerConnection?.port), 54322);
assert.equal(runtime.ownerConnection?.database, 'zimeiti_local');
assert.notEqual(process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, 'true');
const source = await fs.readFile(path.resolve('supabase/migrations', file), 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
assert.equal(hash, reviewedHash, 'MIGRATION_CHANGED_SINCE_REVIEW');
const body = source.replace(/^\uFEFF/u, '').trim();
assert.match(body, /^BEGIN\s*;/u); assert.match(body, /COMMIT\s*;\s*$/u);
const database = new pg.Client({ ...runtime.ownerConnection, application_name: 'codex-publishing-local-migration', connectionTimeoutMillis: 10000, query_timeout: 120000 });
const snapshot = async () => (await database.query(`SELECT
  (SELECT count(*)::text FROM public.users) users,
  (SELECT coalesce(sum(cash_balance),0)::text FROM public.users) cash_total,
  (SELECT coalesce(sum(credits),0)::text FROM public.users) credits_total,
  (SELECT count(*)::text FROM public.wallet_operations) wallet_operations,
  (SELECT md5(coalesce(string_agg(user_id::text || ':' || revision::text || ':' || checksum,'|' ORDER BY user_id),'')) FROM public.member_permission_assignments) permission_digest`)).rows[0];
let open = false;
await database.connect();
try {
  const identity = (await database.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];
  assert.deepEqual(identity, { db: 'zimeiti_local', host: '127.0.0.1', port: 54322 });
  await database.query('BEGIN'); open = true;
  await database.query("SET LOCAL lock_timeout='10s'");
  await database.query("SELECT pg_advisory_xact_lock(hashtextextended('publish-center:migration',0))");
  const before = await snapshot();
  const prior = await database.query('SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1', [version]);
  let action = 'already_applied';
  if (prior.rowCount) assert.equal(prior.rows[0].hash, hash, 'MIGRATION_LEDGER_HASH_CONFLICT');
  else {
    await database.query(body.replace(/^BEGIN\s*;/u, '').replace(/COMMIT\s*;\s*$/u, ''));
    await database.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now())', [version, name, [file], hash, 'codex-publishing-local-migration']);
    action = 'applied';
  }
  const after = await snapshot();
  assert.deepEqual(after, before, 'EXISTING_MEMBER_OR_WALLET_STATE_CHANGED');
  const config = (await database.query('SELECT execution_enabled,sales_enabled FROM public.pub_config_versions ORDER BY version DESC LIMIT 1')).rows[0];
  assert.equal(config.execution_enabled, false); assert.equal(config.sales_enabled, false);
  await database.query("NOTIFY pgrst, 'reload schema'");
  await database.query('COMMIT'); open = false;
  const report = { passed: true, checkedAt: new Date().toISOString(), target: identity, file, hash, action, existingMemberAndWalletInvariant: true, defaultSalesAndExecutionDisabled: true, productionWrites: 0, externalCalls: 0 };
  const directory = path.resolve('.codex-evidence/publish-center-20261109-c12aa131');
  await fs.writeFile(path.join(directory, 'local-migration.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (open) await database.query('ROLLBACK').catch(() => {});
  await database.end();
}
