#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const VERSION = "20261010134000";
const NAME = "video_provider_request_projection";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const ROLLBACK_FILE = `${VERSION}_${NAME}.rollback.sql`;
const TARGET = "127.0.0.1:54322/zimeiti_local";
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const SIGNATURES = new Map([
  ["public.record_video_provider_dispatch_receipt_atomic(text,text,text,jsonb)", [
    "schemaVersion", "wireBodySha256", "wireBodyBytes", "requestProjection", "effectivePromptSha256",
    "referenceImageCount", "referenceAudioCount", "generateAudioState", "endpointPath", "attemptOrdinal",
    "dispatchIdentitySha256", "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT",
    "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT", "VIDEO_PROVIDER_DISPATCH_RECEIPT_V2_INVALID",
  ]],
  ["public.record_video_provider_submission_receipt_atomic(text,text,text,text,text,jsonb)", [
    "dispatchReceiptSha256", "dispatchWireBodySha256s", "dispatchIdentitySha256s", "dispatchAttemptCount",
    "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_DISPATCH",
  ]],
]);

assert.equal(process.argv.slice(2).length, 0, "READ_ONLY_CHECKER_ACCEPTS_NO_ARGUMENTS");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const migrationSource = await fs.readFile(path.resolve("supabase/migrations", MIGRATION_FILE), "utf8");
const migrationHash = digest(migrationSource);
const rollbackSource = await fs.readFile(path.resolve("supabase/rollbacks", ROLLBACK_FILE), "utf8");
const rollbackHash = digest(rollbackSource);
const rollbackGuardTokens = [
  "attemptOrdinal", "dispatchIdentitySha256", "VIDEO_PROVIDER_DISPATCH_ATTEMPT_ORDINAL_CONFLICT",
  "VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT", "raise exception ''VIDEO_PROVIDER_DUPLICATE_WIRE_BODY_CONFLICT''",
  "dispatchIdentitySha256s", "dispatchAttemptCount", "VIDEO_PROVIDER_SUBMISSION_RECEIPT_WITHOUT_V2_DISPATCH",
  "pg_roles", "has_function_privilege", "rolsuper", "VIDEO_PROVIDER_PROJECTION_ACL_REPAIR_REQUIRED",
];
const rollbackSemanticsReady = rollbackGuardTokens.every(token => rollbackSource.includes(token));
for (const token of ["security definer", "set search_path = public, pg_temp", "service_role", ...SIGNATURES.keys()]) {
  assert.ok(migrationSource.toLowerCase().includes(token.toLowerCase()), `MIGRATION_CONTRACT_TOKEN_REQUIRED:${token}`);
}

const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");
assert.equal(typeof runtime.postgresPassword, "string", "LOCAL_POSTGRES_PASSWORD_REQUIRED");
assert.ok(runtime.postgresPassword.length >= 16, "LOCAL_POSTGRES_PASSWORD_INVALID");

const client = new Client({
  ...runtime.ownerConnection,
  user: "postgres",
  password: runtime.postgresPassword,
  application_name: "codex-local-video-provider-projection-readiness",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

await client.connect();
try {
  const identity = (await client.query(
    "select current_user,current_database() as database_name,inet_server_addr()::text as server_address,inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.current_user, "postgres", "LOCAL_READ_ONLY_ROLE_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1", "LIVE_DATABASE_HOST_MISMATCH");

  const ledger = (await client.query(
    "select version::text,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=$1",
    [VERSION],
  )).rows[0];
  const ledgerPresent = Boolean(ledger);
  const ledgerHashMatches = ledgerPresent && String(ledger.hash || "").toLowerCase() === migrationHash;
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid=to_regclass('public.video_tasks')",
  )).rows[0]?.owner || "");
  const columns = (await client.query(
    `select column_name,data_type from information_schema.columns
      where table_schema='public' and table_name='video_tasks'
        and column_name in ('provider_dispatch_receipt','provider_submission_receipt') order by column_name`,
  )).rows.map(row => ({ name: String(row.column_name), type: String(row.data_type) }));
  const constraints = (await client.query(
    `select conname,convalidated,pg_get_constraintdef(oid,true) as definition
       from pg_constraint where conrelid='public.video_tasks'::regclass
        and conname in ('video_tasks_provider_dispatch_receipt_check','video_tasks_provider_submission_receipt_check')
       order by conname`,
  )).rows.map(row => {
    const definition = String(row.definition || "");
    return {
      name: String(row.conname), validated: row.convalidated === true,
      definitionSha256: definition ? digest(definition) : null,
      semanticsReady: definition.includes("schemaVersion") && definition.includes("32768"),
    };
  });
  const functions = [];
  for (const [signature, tokens] of SIGNATURES) {
    const row = (await client.query(
      `select pg_get_userbyid(p.proowner) as owner,p.prosecdef as security_definer,p.proconfig,
              pg_get_functiondef(p.oid) as definition,
              to_jsonb(array(select coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')
                from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
                where acl.privilege_type='EXECUTE' order by 1)) as execute_grantees,
              has_function_privilege('anon',p.oid,'execute') as anon_execute,
              has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
              has_function_privilege('service_role',p.oid,'execute') as service_execute
         from pg_proc p where p.oid=to_regprocedure($1)`,
      [signature],
    )).rows[0];
    const unauthorized = row ? (await client.query(
      `select rolname from pg_roles
        where not rolsuper and rolname not in ($2,'service_role')
          and has_function_privilege(oid,to_regprocedure($1),'execute') order by rolname`,
      [signature, tableOwner],
    )).rows.map(item => String(item.rolname)) : [];
    const definition = String(row?.definition || "");
    const executeGrantees = Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [];
    const semanticsReady = tokens.every(token => definition.includes(token));
    const securityReady = Boolean(row) && Boolean(tableOwner) && row.owner === tableOwner
      && row.security_definer === true && Array.isArray(row.proconfig)
      && row.proconfig.length === 1 && row.proconfig[0] === "search_path=public, pg_temp"
      && JSON.stringify([...executeGrantees].sort()) === JSON.stringify([tableOwner, "service_role"].sort())
      && row.anon_execute === false && row.authenticated_execute === false && row.service_execute === true
      && unauthorized.length === 0;
    functions.push({
      signature, present: Boolean(row), definitionSha256: definition ? digest(definition) : null,
      semanticsReady, owner: String(row?.owner || ""), ownerMatchesTable: row?.owner === tableOwner,
      securityDefiner: row?.security_definer === true,
      searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [], executeGrantees,
      unexpectedEffectiveGrantees: unauthorized,
      privileges: { anonExecute: row?.anon_execute === true, authenticatedExecute: row?.authenticated_execute === true, serviceExecute: row?.service_execute === true },
      securityReady, ready: Boolean(row) && semanticsReady && securityReady,
    });
  }
  const columnsReady = JSON.stringify(columns) === JSON.stringify([
    { name: "provider_dispatch_receipt", type: "jsonb" },
    { name: "provider_submission_receipt", type: "jsonb" },
  ]);
  const constraintsReady = constraints.length === 2 && constraints.every(item => item.validated && item.semanticsReady);
  const ready = ledgerHashMatches && rollbackSemanticsReady && columnsReady && constraintsReady
    && functions.length === SIGNATURES.size && functions.every(item => item.ready);
  console.log(JSON.stringify({
    passed: ready, mode: "read-only-check", checkedAt: new Date().toISOString(), target: TARGET,
    migration: { version: VERSION, name: NAME, file: MIGRATION_FILE, sha256: migrationHash },
    rollback: { file: ROLLBACK_FILE, sha256: rollbackHash, semanticsReady: rollbackSemanticsReady },
    ledger: ledger ? { version: String(ledger.version), name: String(ledger.name || ""), hash: String(ledger.hash || "").toLowerCase(), appliedBy: String(ledger.applied_by || ""), appliedAt: ledger.applied_at || null } : null,
    ledgerPresent, ledgerHashMatches,
    live: { tableOwner, columns, columnsReady, constraints, constraintsReady, functions }, ready,
    writes: 0, providerCalls: 0, billingOperations: 0, credentialsPrinted: false,
  }, null, 2));
  process.exitCode = ready ? 0 : 2;
} finally {
  await client.end().catch(() => undefined);
}
