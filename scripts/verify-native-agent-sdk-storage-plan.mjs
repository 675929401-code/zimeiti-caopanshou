import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/** Read-only local prerequisite audit; never applies a migration or changes a wallet. */
export async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '54322'); assert.equal(url.pathname, '/zimeiti_local');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'codex-native-sdk-storage-plan' });
  const expected = '92485af5b003f80443230f044428342b0e4b11160c3a0f763473f0e936574448';
  await client.connect();
  let report;
  try {
    await client.query('BEGIN READ ONLY');
    const prerequisites = (await client.query(`SELECT
      to_regclass('public.pub_native_agent_tasks') IS NOT NULL AS tasks,
      to_regclass('public.pub_native_agent_turns') IS NOT NULL AS turns,
      to_regclass('public.pub_native_agent_events') IS NOT NULL AS events,
      to_regclass('public.llm_credit_reservations') IS NOT NULL AS reservations,
      to_regclass('public.pub_native_agent_runtime_config') IS NOT NULL AS new_config_present,
      to_regclass('public.pub_native_agent_runtime_calls') IS NOT NULL AS new_calls_present,
      to_regclass('public.pub_native_agent_runtime_sessions') IS NOT NULL AS new_sessions_present`)).rows[0];
    const recovery = (await client.query(`SELECT encode(sha256(convert_to(pg_get_functiondef(oid),'UTF8')),'hex') AS fingerprint,
      pg_get_userbyid(proowner) AS owner,
      has_function_privilege('anon',oid,'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role',oid,'EXECUTE') AS service_execute
      FROM pg_proc WHERE oid=to_regprocedure('public.recover_llm_credit_reservations_atomic(text)')`)).rows[0];
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='llm_models' ORDER BY ordinal_position`)).rows.map(row => row.column_name);
    const needed = ['id','name','model_name','description','category','is_active','is_hidden','user_access','sort_order','provider','api_protocol_config','api_endpoint','proxy_url','token_billing_enabled','input_cost_per_million','output_cost_per_million','cached_cost_per_million','profit_margin','token_rounding_unit'];
    report = { scope: 'local read-only prerequisite plan; no migration or business acceptance', prerequisites,
      recovery, approvedRecoveryBaselineMatches: recovery?.fingerprint === expected && recovery?.owner === 'zimeiti_owner' && recovery?.anon_execute === false && recovery?.authenticated_execute === false && recovery?.service_execute === true,
      missingModelColumns: needed.filter(column => !columns.includes(column)), databaseWrites: 0, providerCalls: 0, migrationApplied: false };
    await client.query('ROLLBACK');
  } finally { await client.end(); }
  const filename=path.resolve('.codex-evidence/native-agent-first-repair-acb6ffc7/storage-plan.json');
  await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
