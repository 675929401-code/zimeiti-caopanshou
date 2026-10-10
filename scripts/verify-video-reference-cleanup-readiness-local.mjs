#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { evaluateFunctionAcl } from "./lib/video-reference-readiness-acl.mjs";

assert.equal(process.argv.length, 2, "READ_ONLY_CHECKER_ACCEPTS_NO_ARGUMENTS");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const version = "20261010135000";
const source = await readFile(`supabase/migrations/${version}_video_reference_asset_cleanup_outbox.sql`, "utf8");
const rollbackSource = await readFile(`supabase/rollbacks/${version}_video_reference_asset_cleanup_outbox.rollback.sql`, "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const signatures = [
  { signature: "public.guard_video_reference_assets_during_reservation_v1()", serviceCallable: false },
  { signature: "public.register_video_reference_asset_guard_v1(text,text,text,text,text,text,text,text)", serviceCallable: true },
  { signature: "public.claim_video_reference_asset_cleanup_v1(text,text,text,text,text,text,text,text)", serviceCallable: true },
  { signature: "public.mark_video_reference_asset_object_deleted_v1(text,text)", serviceCallable: true },
  { signature: "public.complete_video_reference_asset_cleanup_v1(text,text,text,text,text,text)", serviceCallable: true },
  { signature: "public.record_video_reference_asset_cleanup_failure_v1(text,text,text)", serviceCallable: true },
];
const client = new pg.Client({ ...runtime.ownerConnection, user: "postgres", password: runtime.postgresPassword,
  application_name: "codex-video-reference-cleanup-readiness", connectionTimeoutMillis: 10_000, query_timeout: 45_000 });
await client.connect();
try {
  const identity = (await client.query("select current_database() database,inet_server_addr()::text host,inet_server_port() port")).rows[0];
  assert.equal(identity.database, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  const ledger = (await client.query("select hash from supabase_migrations.schema_migrations where version::text=$1", [version])).rows[0];
  const duplicateRows = (await client.query(`select storage_provider,storage_key,count(*)::integer copies
    from public.user_files where source='video-page-reference'
    group by storage_provider,storage_key having count(*)>1 order by copies desc limit 20`)).rows;
  const tableOwner = String((await client.query("select pg_get_userbyid(relowner) owner from pg_class where oid='public.video_tasks'::regclass")).rows[0]?.owner || "");
  const functions = [];
  for (const contract of signatures) {
    const row = (await client.query(`select pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,
      has_function_privilege('service_role',p.oid,'execute') service_execute,
      has_function_privilege('anon',p.oid,'execute') anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
      array(select role_entry.rolname::text from pg_roles role_entry
        where role_entry.oid not in (p.proowner,to_regrole('service_role')) and not role_entry.rolsuper
          and has_function_privilege(role_entry.oid,p.oid,'execute') order by role_entry.rolname)::text[] unexpected_roles
      from pg_proc p where p.oid=to_regprocedure($1)`, [contract.signature])).rows[0];
    const acl = evaluateFunctionAcl(row, contract.serviceCallable);
    functions.push({ signature: contract.signature, present: Boolean(row), owner: row?.owner || null,
      securityDefiner: row?.prosecdef === true, searchPath: row?.proconfig || [],
      serviceExecute: acl.serviceExecute, anonExecute: acl.anonExecute,
      authenticatedExecute: acl.authenticatedExecute, unexpectedRoles: acl.unexpectedRoles,
      serviceOnly: acl.serviceOnly,
      ownerMatches: Boolean(row) && row.owner === tableOwner });
  }
  const triggerPresent = Boolean((await client.query(`select 1 from pg_trigger where tgrelid='public.video_tasks'::regclass
    and tgname='video_tasks_reference_asset_reservation_guard' and not tgisinternal`)).rowCount);
  const tablePresent = Boolean((await client.query("select to_regclass('public.video_reference_asset_cleanup_outbox')::text name")).rows[0]?.name);
  const timestampColumns = tablePresent ? (await client.query(`select column_name,is_nullable,column_default
    from information_schema.columns where table_schema='public' and table_name='video_reference_asset_cleanup_outbox'
      and column_name in ('registered_at','claimed_at') order by column_name`)).rows : [];
  const timestampSemanticsReady = timestampColumns.length === 2
    && timestampColumns.some(column => column.column_name === "registered_at" && column.is_nullable === "NO"
      && String(column.column_default || "").includes("clock_timestamp"))
    && timestampColumns.some(column => column.column_name === "claimed_at" && column.is_nullable === "YES");
  const rollbackSafetyReady = source.includes("registered_at timestamptz not null default clock_timestamp()")
    && source.includes("claimed_at timestamptz,")
    && (source.match(/lock table public\.video_tasks in access share mode;/gu) || []).length === 6
    && rollbackSource.includes("lock table public.video_tasks in access exclusive mode;")
    && rollbackSource.includes("lock table public.video_reference_asset_cleanup_outbox in access exclusive mode")
    && rollbackSource.includes("VIDEO_REFERENCE_CLEANUP_ROLLBACK_BLOCKED_NONTERMINAL")
    && rollbackSource.includes("state in (''claimed'',''object_deleted'')");
  const ready = ledger && String(ledger.hash || "").toLowerCase() === hash && duplicateRows.length === 0
    && tablePresent && triggerPresent && timestampSemanticsReady && rollbackSafetyReady
    && functions.every(item => item.present && item.ownerMatches
      && item.securityDefiner && item.searchPath.includes("search_path=public, pg_temp") && item.serviceOnly);
  console.log(JSON.stringify({ ready: Boolean(ready), target: "127.0.0.1:54322/zimeiti_local", version,
    migrationHash: hash, ledgerHash: ledger?.hash || null, duplicateRows, tablePresent, triggerPresent,
    timestampColumns, timestampSemanticsReady, rollbackSafetyReady, tableOwner, functions }, null, 2));
  if (!ready) process.exitCode = 2;
} finally { await client.end(); }
