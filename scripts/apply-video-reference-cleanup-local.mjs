#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const CONFIRM = "--confirm-local-video-reference-cleanup-apply";
assert.deepEqual(process.argv.slice(2), [CONFIRM], `EXPLICIT_CONFIRMATION_REQUIRED:${CONFIRM}`);
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");

const version = "20261010135000";
const name = "video_reference_asset_cleanup_outbox";
const source = await readFile(`supabase/migrations/${version}_${name}.sql`, "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const migrationBody = source
  .replace(/^\s*begin;\s*/iu, "")
  .replace(/\s*commit;\s*$/iu, "");
const client = new pg.Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-video-reference-cleanup-apply",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  const identity = (await client.query("select current_database() database,inet_server_addr()::text host,inet_server_port() port")).rows[0];
  assert.equal(identity.database, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  const duplicates = await client.query(`
    select storage_provider,storage_key,count(*)::integer copies
      from public.user_files
     where source='video-page-reference'
     group by storage_provider,storage_key having count(*)>1 limit 20
  `);
  assert.equal(duplicates.rowCount, 0, "VIDEO_REFERENCE_DUPLICATE_KEYS_REQUIRE_REPAIR");
  const existing = (await client.query(
    "select hash from supabase_migrations.schema_migrations where version::text=$1",
    [version],
  )).rows[0];
  if (existing) {
    assert.equal(String(existing.hash || "").toLowerCase(), hash, "MIGRATION_LEDGER_HASH_MISMATCH");
    console.log(JSON.stringify({ applied: false, alreadyApplied: true, version, hash }, null, 2));
  } else {
    await client.query("begin");
    try {
      await client.query(migrationBody);
      await client.query(
        `insert into supabase_migrations.schema_migrations(version,name,hash,applied_by)
         values($1,$2,$3,current_user)`,
        [version, name, hash],
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
