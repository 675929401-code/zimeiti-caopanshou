#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  expectedFunctionSemanticDescriptor,
  functionAclAssessment,
  functionSemanticHash,
  liveFunctionSemanticDescriptor,
} from "./lib/shared-agent-function-definition.mjs";

const CONFIRM = "--execute-transaction-rollback-probe";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_NON_PERSISTENT_PROBE_CONFIRMATION_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const stripEnvelope = source => source.replace(/^\s*begin;\s*/iu, "")
  .replace(/\s*notify pgrst,\s*'reload schema';\s*/giu, "").replace(/\s*commit;\s*$/iu, "");
const migration = stripEnvelope(await readFile("supabase/migrations/20261010140000_shared_agent_batch_cas.sql", "utf8"));
const rollback = stripEnvelope(await readFile("supabase/rollbacks/20261010140000_shared_agent_batch_cas.rollback.sql", "utf8"));
const migrationSource = await readFile("supabase/migrations/20261010140000_shared_agent_batch_cas.sql", "utf8");
const migrationHash = crypto.createHash("sha256").update(migrationSource).digest("hex");
const client = new pg.Client({ ...runtime.ownerConnection, user: "postgres", password: runtime.postgresPassword,
  application_name: "codex-shared-agent-batch-cas-rollback-probe", connectionTimeoutMillis: 10_000, query_timeout: 120_000 });
await client.connect();
let open = false;
try {
  const initialState = (await client.query(`select
    to_regprocedure('public.apply_agent_reorder_cas_v1(jsonb)') is not null reorder_present,
    to_regprocedure('public.apply_coze_agent_import_cas_v1(jsonb)') is not null coze_present,
    exists(select 1 from supabase_migrations.schema_migrations where version::text='20261010140000') ledger_present,
    coalesce((select hash from supabase_migrations.schema_migrations where version::text='20261010140000' limit 1),'') ledger_hash`)).rows[0];
  assert.equal(initialState.reorder_present, initialState.coze_present, "INITIAL_FUNCTIONS_MUST_MOVE_TOGETHER");
  assert.equal(initialState.reorder_present, initialState.ledger_present, "INITIAL_LEDGER_MUST_MATCH_FUNCTIONS");
  await client.query("begin"); open = true;
  if (initialState.ledger_present) await client.query(rollback);
  const isolatedBaseline = (await client.query(`select
    to_regprocedure('public.apply_agent_reorder_cas_v1(jsonb)') is null reorder_absent,
    to_regprocedure('public.apply_coze_agent_import_cas_v1(jsonb)') is null coze_absent,
    not exists(select 1 from supabase_migrations.schema_migrations where version::text='20261010140000') ledger_absent`)).rows[0];
  assert.deepEqual(isolatedBaseline, { reorder_absent: true, coze_absent: true, ledger_absent: true },
    "ISOLATED_BASELINE_REQUIRED");
  await client.query(migration);
  await client.query(`insert into supabase_migrations.schema_migrations(version,name,hash,applied_by)
    values('20261010140000','shared_agent_batch_cas',$1,current_user)`, [migrationHash]);
  const suffix = crypto.randomUUID().slice(0, 8);
  const firstId = `batch-cas-first-${suffix}`;
  const secondId = `batch-cas-second-${suffix}`;
  const fixtureCategory = `batch-cas-${suffix}`;
  await client.query(`insert into public.agents(id,name,category,description,system_prompt,sort_order,is_active,source,bot_id)
    values($1,'first',$5,'fixture','',10,true,'coze',$3),($2,'second',$5,'fixture','',20,true,'coze',$4)`,
  [firstId, secondId, `fixture-first-${suffix}`, `fixture-second-${suffix}`, fixtureCategory]);
  const before = (await client.query("select id,sort_order,config_revision from public.agents where id=any($1::text[]) order by id", [[firstId, secondId]])).rows;

  await client.query("savepoint filtered_reorder");
  let filteredConflict = false;
  try {
    await client.query("select public.apply_agent_reorder_cas_v1($1::jsonb)", [JSON.stringify([
      { id: firstId, expected_revision: Number(before.find(row => row.id === firstId).config_revision) },
    ])]);
  } catch (error) {
    filteredConflict = error?.code === "40001";
    await client.query("rollback to savepoint filtered_reorder");
  }
  await client.query("release savepoint filtered_reorder");
  assert.equal(filteredConflict, true, "FILTERED_REORDER_MUST_CONFLICT");
  assert.deepEqual((await client.query("select id,sort_order,config_revision from public.agents where id=any($1::text[]) order by id", [[firstId, secondId]])).rows,
    before, "FILTERED_REORDER_MUST_WRITE_ZERO_ROWS");

  await client.query("savepoint reorder_second_conflict");
  let reorderConflict = false;
  try {
    await client.query("select public.apply_agent_reorder_cas_v1($1::jsonb)", [JSON.stringify([
      { id: firstId, expected_revision: Number(before.find(row => row.id === firstId).config_revision) },
      { id: secondId, expected_revision: Number(before.find(row => row.id === secondId).config_revision) + 1 },
    ])]);
  } catch (error) {
    reorderConflict = error?.code === "40001";
    await client.query("rollback to savepoint reorder_second_conflict");
  }
  await client.query("release savepoint reorder_second_conflict");
  assert.equal(reorderConflict, true, "SECOND_ROW_REORDER_CONFLICT_REQUIRED");
  assert.deepEqual((await client.query("select id,sort_order,config_revision from public.agents where id=any($1::text[]) order by id", [[firstId, secondId]])).rows,
    before, "SECOND_ROW_REORDER_CONFLICT_MUST_WRITE_ZERO_ROWS");

  const insertedId = `batch-cas-insert-${suffix}`;
  await client.query("savepoint coze_second_conflict");
  let cozeConflict = false;
  try {
    await client.query("select public.apply_coze_agent_import_cas_v1($1::jsonb)", [JSON.stringify([
      { operation: "insert", id: insertedId, bot_id: `fixture-new-${suffix}`, name: "new", description: "", avatar: "", system_prompt: "" },
      { operation: "update", id: secondId, bot_id: `fixture-second-${suffix}`, name: "second changed", description: "", avatar: "", system_prompt: "", expected_revision: Number(before.find(row => row.id === secondId).config_revision) + 1 },
    ])]);
  } catch (error) {
    cozeConflict = error?.code === "40001";
    await client.query("rollback to savepoint coze_second_conflict");
  }
  await client.query("release savepoint coze_second_conflict");
  assert.equal(cozeConflict, true, "SECOND_ROW_COZE_CONFLICT_REQUIRED");
  assert.equal(Number((await client.query("select count(*) count from public.agents where id=$1", [insertedId])).rows[0].count), 0,
    "MIXED_COZE_CONFLICT_MUST_NOT_INSERT");
  assert.deepEqual((await client.query("select id,sort_order,config_revision from public.agents where id=any($1::text[]) order by id", [[firstId, secondId]])).rows,
    before, "MIXED_COZE_CONFLICT_MUST_WRITE_ZERO_ROWS");

  for (const fixture of [
    { label: "23505", entries: [
      { operation: "insert", id: `collision-${suffix}`, bot_id: `fixture-first-${suffix}`, name: "collision" },
      { operation: "update", id: secondId, bot_id: `fixture-second-${suffix}`, name: "valid", expected_revision: Number(before.find(row => row.id === secondId).config_revision) },
    ] },
    { label: "P0002", entries: [
      { operation: "insert", id: `must-not-insert-${suffix}`, bot_id: `must-not-insert-${suffix}`, name: "new" },
      { operation: "update", id: `missing-${suffix}`, bot_id: `missing-${suffix}`, name: "missing", expected_revision: 1 },
    ] },
  ]) {
    await client.query(`savepoint conflict_${fixture.label.toLowerCase()}`);
    let code = "";
    try { await client.query("select public.apply_coze_agent_import_cas_v1($1::jsonb)", [JSON.stringify(fixture.entries)]); }
    catch (error) { code = String(error?.code || ""); await client.query(`rollback to savepoint conflict_${fixture.label.toLowerCase()}`); }
    await client.query(`release savepoint conflict_${fixture.label.toLowerCase()}`);
    assert.equal(code, fixture.label, `${fixture.label}_CONFLICT_REQUIRED`);
  }
  assert.equal(Number((await client.query("select count(*) count from public.agents where id in ($1,$2)",
    [`collision-${suffix}`, `must-not-insert-${suffix}`])).rows[0].count), 0, "CONCURRENCY_FIXTURES_MUST_WRITE_ZERO_ROWS");

  await client.query(rollback);
  const rolledBack = (await client.query(`select
    to_regprocedure('public.apply_agent_reorder_cas_v1(jsonb)') is null reorder_absent,
    to_regprocedure('public.apply_coze_agent_import_cas_v1(jsonb)') is null coze_absent,
    not exists(select 1 from supabase_migrations.schema_migrations where version::text='20261010140000') ledger_absent`)).rows[0];
  assert.deepEqual(rolledBack, { reorder_absent: true, coze_absent: true, ledger_absent: true }, "ROLLBACK_MUST_REMOVE_FUNCTIONS_AND_LEDGER");

  await client.query(migration);
  await client.query(`insert into supabase_migrations.schema_migrations(version,name,hash,applied_by)
    values('20261010140000','shared_agent_batch_cas',$1,current_user)`, [migrationHash]);
  for (const name of ["apply_agent_reorder_cas_v1", "apply_coze_agent_import_cas_v1"]) {
    const row = (await client.query(`select pg_get_functiondef(p.oid) function_definition,
      pg_get_function_identity_arguments(p.oid) identity_arguments,pg_get_function_result(p.oid) result,
      l.lanname language,p.provolatile volatility,p.proisstrict strict,p.proparallel parallel,
      p.proleakproof leakproof,p.prokind kind,p.proretset returns_set,p.prosecdef security_definer,
      p.procost cost,p.prorows rows,p.prosupport::regproc::text support,p.proconfig config,
      pg_get_userbyid(p.proowner)=pg_get_userbyid(c.relowner) owner_matches,
      has_function_privilege('service_role',p.oid,'execute') service_execute,
      has_function_privilege('anon',p.oid,'execute') anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
      coalesce((select jsonb_agg(role_entry.rolname::text order by role_entry.rolname::text) from pg_roles role_entry
        where role_entry.oid not in (p.proowner,to_regrole('service_role')) and not role_entry.rolsuper
          and has_function_privilege(role_entry.oid,p.oid,'execute')), '[]'::jsonb) unexpected_roles
      from pg_proc p join pg_language l on l.oid=p.prolang cross join pg_class c
      where p.oid=to_regprocedure($1) and c.oid='public.agents'::regclass`,
    [`public.${name}(jsonb)`])).rows[0];
    assert.ok(row?.function_definition.includes(`FUNCTION public.${name}`), `READINESS_FUNCTIONDEF_MISSING:${name}`);
    const expectedDescriptor = expectedFunctionSemanticDescriptor(migrationSource, name);
    const liveDescriptor = liveFunctionSemanticDescriptor(row);
    const acl = functionAclAssessment(row);
    assert.equal(functionSemanticHash(liveDescriptor), functionSemanticHash(expectedDescriptor), `READINESS_SEMANTIC_HASH_MISMATCH:${name}`);
    assert.equal(row.security_definer && row.owner_matches && acl.serviceOnly, true, `READINESS_SECURITY_MISMATCH:${name}:${JSON.stringify(acl)}`);
    assert.ok(row.config.includes("search_path=public, pg_temp"), `READINESS_SEARCH_PATH_MISMATCH:${name}`);
  }
  await client.query("rollback"); open = false;
  const restoredState = (await client.query(`select
    to_regprocedure('public.apply_agent_reorder_cas_v1(jsonb)') is not null reorder_present,
    to_regprocedure('public.apply_coze_agent_import_cas_v1(jsonb)') is not null coze_present,
    exists(select 1 from supabase_migrations.schema_migrations where version::text='20261010140000') ledger_present,
    coalesce((select hash from supabase_migrations.schema_migrations where version::text='20261010140000' limit 1),'') ledger_hash`)).rows[0];
  assert.deepEqual(restoredState, initialState, "OUTER_ROLLBACK_MUST_RESTORE_INITIAL_STATE");
  console.log(JSON.stringify({ passed: true, persisted: false, target: "127.0.0.1:54322/zimeiti_local",
    initialMigrationApplied: initialState.ledger_present, migrationHash,
    checks: ["pre-applied and not-yet-applied local states are isolated inside the outer transaction",
      "filtered reorder writes zero rows", "second-row reorder conflict writes zero rows",
      "mixed Coze insert/update conflict writes zero rows", "23505 and P0002 write zero rows",
      "rollback removes functions and ledger", "rollback -> reapply -> semantic/security ready",
      "outer transaction rollback restores the exact initial state"] }, null, 2));
} finally {
  if (open) await client.query("rollback").catch(() => {});
  await client.end();
}
