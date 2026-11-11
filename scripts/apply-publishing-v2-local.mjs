#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';

const supportedMigrations = {
  '20261110010000': 'publish_center_native_v2',
  '20261110020000': 'fix_native_image_cover_projection',
  '20261110030000': 'fix_native_asset_reference_regex',
  '20261110040000': 'publish_center_official_api',
  '20261110050000': 'native_operations_metadata',
  '20261110060000': 'native_core_operations',
  '20261110070000': 'native_agent_tasks',
  '20261110080000': 'native_auxiliary_replay',
  '20261110090000': 'publishing_oauth_authorizations',
  '20261110100000': 'native_agent_reconciliation',
  '20261110110000': 'native_unissued_quota_release',
  '20261110120000': 'native_ai_durable_actions',
  '20261110130000': 'native_main_media_references',
  '20261110140000': 'native_model_surface_orders',
  '20261110141000': 'native_main_media_bridge',
};
const version = process.argv.find(value => value.startsWith('--migration='))?.slice('--migration='.length) || '20261110010000';
assert.ok(Object.hasOwn(supportedMigrations, version), 'REVIEWED_NATIVE_MIGRATION_REQUIRED');
const name = supportedMigrations[version];
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
const database = new pg.Client({ ...runtime.ownerConnection, application_name: 'codex-publishing-v2-local-migration', connectionTimeoutMillis: 10000, query_timeout: 120000 });
const snapshot = async () => (await database.query(`SELECT
  (SELECT count(*)::text FROM public.users) users,
  (SELECT md5(coalesce(jsonb_agg(to_jsonb(u) ORDER BY id)::text,'[]')) FROM public.users u) users_digest,
  (SELECT md5(coalesce(jsonb_agg(to_jsonb(c) ORDER BY version)::text,'[]')) FROM public.pub_config_versions c) config_digest,
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
    await database.query('INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at) VALUES($1,$2,$3,$4,$5,now())', [version, name, [file], hash, 'codex-publishing-v2-local-migration']);
    action = 'applied';
  }
  const after = await snapshot();
  assert.deepEqual(after, before, 'EXISTING_MEMBER_OR_WALLET_STATE_CHANGED');
  const config = (await database.query('SELECT execution_enabled,sales_enabled FROM public.pub_config_versions ORDER BY version DESC LIMIT 1')).rows[0];
  assert.equal(config.execution_enabled, false); assert.equal(config.sales_enabled, false);
  await database.query("NOTIFY pgrst, 'reload schema'");
  await database.query('COMMIT'); open = false;
  const report = { passed: true, checkedAt: new Date().toISOString(), target: identity, file, hash, action, existingMemberAndWalletInvariant: true, defaultSalesAndExecutionDisabled: true, productionWrites: 0, externalCalls: 0 };
  const directory = path.resolve(version >= '20261110040000' ? '.codex-evidence/publish-center-delivery-4b3ab51a' : '.codex-evidence/publish-center-native-20261110-a6b42cea');
  await fs.mkdir(directory, {recursive:true});
  await fs.writeFile(path.join(directory, `${version}-local-migration.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  if (open) await database.query('ROLLBACK').catch(() => {});
  await database.end();
}
