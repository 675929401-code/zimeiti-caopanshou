#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const CONFIRM = "--confirm-local-shared-agent-batch-cas-apply";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_CONFIRMATION_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");

const version = "20261010140000";
const name = "shared_agent_batch_cas";
const source = await readFile(`supabase/migrations/${version}_${name}.sql`, "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const migrationBody = source.replace(/^\s*begin;\s*/iu, "").replace(/\s*commit;\s*$/iu, "");
const client = new pg.Client({ ...runtime.ownerConnection, user: "postgres", password: runtime.postgresPassword,
  application_name: "codex-local-shared-agent-batch-cas-apply", connectionTimeoutMillis: 10_000, query_timeout: 120_000 });

await client.connect();
try {
  const identity = (await client.query("select current_database() database,inet_server_addr()::text host,inet_server_port() port")).rows[0];
  assert.equal(identity.database, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  assert.ok(await client.query("select to_regprocedure('public.maintain_shared_agent_config_revision()') is not null ready")
    .then(result => result.rows[0]?.ready === true), "SHARED_AGENT_REVISION_BASE_REQUIRED");
  const existing = (await client.query(
    "select hash from supabase_migrations.schema_migrations where version::text=$1", [version],
  )).rows[0];
  if (existing) {
    assert.equal(String(existing.hash || "").toLowerCase(), hash, "MIGRATION_LEDGER_HASH_MISMATCH");
    const functionsReady = await client.query(`select
      to_regprocedure('public.apply_agent_reorder_cas_v1(jsonb)') is not null reorder_ready,
      to_regprocedure('public.apply_coze_agent_import_cas_v1(jsonb)') is not null coze_ready`);
    assert.equal(functionsReady.rows[0]?.reorder_ready, true, "LEDGER_SCHEMA_DIVERGENCE:REORDER_FUNCTION_MISSING");
    assert.equal(functionsReady.rows[0]?.coze_ready, true, "LEDGER_SCHEMA_DIVERGENCE:COZE_FUNCTION_MISSING");
    console.log(JSON.stringify({ applied: false, alreadyApplied: true, version, hash }, null, 2));
  } else {
    await client.query("begin");
    try {
      await client.query(migrationBody);
      await client.query(
        `insert into supabase_migrations.schema_migrations(version,name,hash,applied_by)
         values($1,$2,$3,current_user)`, [version, name, hash],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
    console.log(JSON.stringify({ applied: true, target: "127.0.0.1:54322/zimeiti_local", version, hash }, null, 2));
  }
} finally {
  await client.end();
}
