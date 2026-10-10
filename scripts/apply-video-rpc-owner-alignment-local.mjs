#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const VERSION = "20261010132000";
const NAME = "video_snapshot_function_owner_alignment";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const TARGET = "127.0.0.1:54322/zimeiti_local";
const APPLY = process.argv.includes("--apply");
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const SIGNATURES = [
  "public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)",
  "public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
  "public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)",
];

if (APPLY) {
  assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(
    process.argv.includes("--confirm-local-video-rpc-owner-alignment-only"),
    "LOCAL_VIDEO_RPC_OWNER_CONFIRMATION_REQUIRED",
  );
}

function transactionBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  assert.match(normalized, /^begin\s*;/iu, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /commit\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^begin\s*;/iu, "").replace(/commit\s*;\s*$/iu, "").trim();
}

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const sameMembers = (left, right) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
assert.ok(runtime.postgresPassword.length >= 16, "LOCAL_POSTGRES_PASSWORD_INVALID");

const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = digest(migrationSource);
const migrationBody = transactionBody(migrationSource);
for (const token of [
  "video_tasks",
  "security definer",
  "set search_path = public, pg_temp",
  "service_role",
  "has_function_privilege",
  "v_unexpected_effective_roles",
  ...SIGNATURES,
]) assert.ok(migrationSource.toLowerCase().includes(token.toLowerCase()), `MIGRATION_TOKEN_REQUIRED:${token}`);

const client = new Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-video-rpc-owner-alignment",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

async function liveProjection() {
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid='public.video_tasks'::regclass",
  )).rows[0]?.owner || "");
  const functions = [];
  for (const signature of SIGNATURES) {
    const row = (await client.query(
      `select pg_get_userbyid(p.proowner) as owner,
              p.prosecdef as security_definer,
              p.proconfig,
              to_jsonb(array(
                select distinct coalesce(pg_get_userbyid(acl.grantee), 'PUBLIC')
                  from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where acl.privilege_type='EXECUTE'
                 order by 1
              )) as execute_grantees,
              to_jsonb(array(
                select role_entry.rolname
                  from pg_roles role_entry
                 where role_entry.oid not in (p.proowner, to_regrole('service_role'))
                   and not role_entry.rolsuper
                   and has_function_privilege(role_entry.oid, p.oid, 'EXECUTE')
                 order by role_entry.rolname
              )) as unexpected_effective_grantees
         from pg_proc p where p.oid=to_regprocedure($1)`,
      [signature],
    )).rows[0];
    const privileges = (await client.query(
      `select has_function_privilege('anon',$1,'execute') as anon_execute,
              has_function_privilege('authenticated',$1,'execute') as authenticated_execute,
              has_function_privilege('service_role',$1,'execute') as service_execute`,
      [signature],
    )).rows[0];
    functions.push({
      signature,
      owner: String(row?.owner || ""),
      securityDefiner: row?.security_definer === true,
      searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [],
      executeGrantees: Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [],
      unexpectedEffectiveGrantees: Array.isArray(row?.unexpected_effective_grantees)
        ? row.unexpected_effective_grantees.map(String) : [],
      privileges: {
        anonExecute: privileges?.anon_execute === true,
        authenticatedExecute: privileges?.authenticated_execute === true,
        serviceExecute: privileges?.service_execute === true,
      },
    });
  }
  return { tableOwner, functions };
}

function isReady(live) {
  if (!live?.tableOwner || live.functions?.length !== SIGNATURES.length) return false;
  return live.functions.every(item => item.owner === live.tableOwner
    && item.securityDefiner === true
    && item.searchPath.length === 1
    && item.searchPath[0] === "search_path=public, pg_temp"
    && sameMembers(item.executeGrantees, [live.tableOwner, "service_role"])
    && item.unexpectedEffectiveGrantees.length === 0
    && item.privileges.anonExecute === false
    && item.privileges.authenticatedExecute === false
    && item.privileges.serviceExecute === true);
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "select current_user,current_database() as database_name,inet_server_addr()::text as server_address,inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.current_user, "postgres", "LOCAL_MIGRATION_ROLE_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );

  const before = await liveProjection();
  const prior = await client.query(
    "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [VERSION],
  );
  if (!APPLY) {
    const report = {
      passed: true,
      mode: "read-only-check",
      checkedAt: new Date().toISOString(),
      target: TARGET,
      migration: MIGRATION_FILE,
      migrationHash,
      ledgerPresent: prior.rowCount === 1,
      live: before,
      ready: prior.rowCount === 1 && String(prior.rows[0]?.hash || "") === migrationHash && isReady(before),
      writes: 0,
      providerCalls: 0,
      billingOperations: 0,
      credentialsPrinted: false,
    };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ready ? 0 : 2;
  } else {
    await client.query("begin");
    transactionOpen = true;
    await client.query("select pg_advisory_xact_lock(hashtextextended('video-rpc-owner-alignment:20261010132000',0))");
    const lockedPrior = await client.query(
      "select version,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1 for update",
      [VERSION],
    );
    let action = "already_applied";
    if (lockedPrior.rowCount) {
      assert.equal(String(lockedPrior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
      if (!isReady(await liveProjection())) {
        await client.query(migrationBody);
        action = "reapplied_after_verified_security_drift";
      }
    } else {
      await client.query(migrationBody);
      await client.query(
        `insert into supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         values($1,$2,$3,$4,$5,now())`,
        [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-video-rpc-owner-alignment"],
      );
      action = "applied";
    }

    const after = await liveProjection();
    assert.equal(isReady(after), true, "LIVE_VIDEO_RPC_OWNER_ALIGNMENT_INVALID");
    await client.query("commit");
    transactionOpen = false;

    const checkedAt = new Date().toISOString();
    const evidenceDir = path.resolve(".codex-evidence", "video-rpc-owner-alignment");
    const nonce = crypto.randomBytes(4).toString("hex");
    const evidenceName = `${checkedAt.replace(/[:.]/gu, "-")}-${action}-${migrationHash.slice(0, 12)}-${nonce}.json`;
    const report = {
      passed: true,
      mode: "local-transactional-apply",
      checkedAt,
      target: TARGET,
      action,
      migration: MIGRATION_FILE,
      migrationHash,
      before,
      after,
      dataRowsChanged: 0,
      providerCalls: 0,
      billingOperations: 0,
      productionWrites: 0,
      credentialsPrinted: false,
      evidenceFile: path.join(evidenceDir, evidenceName),
    };
    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(path.join(evidenceDir, evidenceName), `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    console.log(JSON.stringify(report, null, 2));
  }
} catch (error) {
  if (transactionOpen) await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
