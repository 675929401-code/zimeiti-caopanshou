#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  expectedFunctionSemanticDescriptor,
  functionAclAssessment,
  functionSemanticHash,
  liveFunctionSemanticDescriptor,
} from "./lib/shared-agent-function-definition.mjs";

assert.equal(process.argv.length, 2, "READ_ONLY_CHECKER_ACCEPTS_NO_ARGUMENTS");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const version = "20261010140000";
const source = await readFile(`supabase/migrations/${version}_shared_agent_batch_cas.sql`, "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const signatures = [
  "public.apply_agent_reorder_cas_v1(jsonb)",
  "public.apply_coze_agent_import_cas_v1(jsonb)",
];
const client = new pg.Client({ ...runtime.ownerConnection, user: "postgres", password: runtime.postgresPassword,
  application_name: "codex-shared-agent-batch-cas-readiness", connectionTimeoutMillis: 10_000, query_timeout: 45_000 });
await client.connect();
try {
  const identity = (await client.query("select current_database() database,inet_server_addr()::text host,inet_server_port() port")).rows[0];
  assert.equal(identity.database, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  const ledger = (await client.query("select hash from supabase_migrations.schema_migrations where version::text=$1", [version])).rows[0];
  const tableOwner = String((await client.query("select pg_get_userbyid(relowner) owner from pg_class where oid='public.agents'::regclass")).rows[0]?.owner || "");
  const functions = [];
  for (const signature of signatures) {
    const row = (await client.query(`select pg_get_userbyid(p.proowner) owner,p.prosecdef security_definer,p.proconfig config,
      pg_get_functiondef(p.oid) function_definition,pg_get_function_identity_arguments(p.oid) identity_arguments,
      pg_get_function_result(p.oid) result,l.lanname language,p.provolatile volatility,p.proisstrict strict,
      p.proparallel parallel,p.proleakproof leakproof,p.prokind kind,p.proretset returns_set,
      p.procost cost,p.prorows rows,p.prosupport::regproc::text support,
      has_function_privilege('service_role',p.oid,'execute') service_execute,
      has_function_privilege('anon',p.oid,'execute') anon_execute,
      has_function_privilege('authenticated',p.oid,'execute') authenticated_execute,
      coalesce((select jsonb_agg(role_entry.rolname::text order by role_entry.rolname::text) from pg_roles role_entry
        where role_entry.oid not in (p.proowner,to_regrole('service_role')) and not role_entry.rolsuper
          and has_function_privilege(role_entry.oid,p.oid,'execute')), '[]'::jsonb) unexpected_roles
      from pg_proc p join pg_language l on l.oid=p.prolang where p.oid=to_regprocedure($1)`, [signature])).rows[0];
    const name = signature.slice("public.".length, signature.indexOf("("));
    const expectedDescriptor = expectedFunctionSemanticDescriptor(source, name);
    const liveDescriptor = row ? liveFunctionSemanticDescriptor(row) : null;
    const expectedSemanticHash = functionSemanticHash(expectedDescriptor);
    const liveSemanticHash = liveDescriptor ? functionSemanticHash(liveDescriptor) : null;
    const definition = String(row?.function_definition || "");
    const acl = functionAclAssessment(row);
    functions.push({ signature, present: Boolean(row), owner: row?.owner || null,
      securityDefiner: row?.security_definer === true, searchPath: row?.config || [],
      serviceExecute: acl.serviceExecute, anonExecute: acl.anonExecute,
      authenticatedExecute: acl.authenticatedExecute, unexpectedRoles: acl.unexpectedRoles,
      serviceOnly: acl.serviceOnly,
      ownerMatches: Boolean(row) && row.owner === tableOwner,
      pgGetFunctiondefPresent: definition.includes(`FUNCTION public.${name}`),
      expectedSemanticHash, liveSemanticHash, expectedDescriptor, liveDescriptor,
      semanticHashMatches: liveSemanticHash === expectedSemanticHash });
  }
  const securityReady = ledger && String(ledger.hash || "").toLowerCase() === hash
    && functions.every(item => item.present && item.ownerMatches && item.securityDefiner
      && item.searchPath.includes("search_path=public, pg_temp") && item.serviceOnly);
  const semanticReady = functions.every(item => item.pgGetFunctiondefPresent && item.semanticHashMatches);
  const ready = Boolean(securityReady && semanticReady);
  console.log(JSON.stringify({ ready, target: "127.0.0.1:54322/zimeiti_local", version,
    migrationHash: hash, ledgerHash: ledger?.hash || null, tableOwner, semanticReady, functions }, null, 2));
  if (!ready) process.exitCode = 2;
} finally { await client.end(); }
