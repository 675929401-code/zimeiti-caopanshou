#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const BASE_VERSION = "20261010023000";
const BASE_NAME = "video_generation_request_snapshot_v1";
const BASE_MIGRATION_FILE = `${BASE_VERSION}_${BASE_NAME}.sql`;
const ALIGNMENT_VERSION = "20261010132000";
const ALIGNMENT_NAME = "video_snapshot_function_owner_alignment";
const ALIGNMENT_MIGRATION_FILE = `${ALIGNMENT_VERSION}_${ALIGNMENT_NAME}.sql`;
const TARGET = "127.0.0.1:54322/zimeiti_local";
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const SIGNATURES = [
  "public.persist_video_generation_request_snapshot_v1_atomic(text,text,text,jsonb,text)",
  "public.reserve_video_generation_task_request_snapshot_v1_atomic(text,text,text,text,text,numeric,numeric,text,numeric,boolean,boolean,jsonb,jsonb,text,text,text,text,text,integer,text,text,text,text,text,text,numeric,text)",
  "public.reserve_queued_digital_video_task_request_snapshot_v1_atomic(jsonb,jsonb,jsonb,jsonb,text)",
];
const SEMANTIC_TOKENS = new Map([
  [SIGNATURES[0], [
    "video_generation_request_snapshot.v1",
    "VIDEO_REQUEST_SNAPSHOT_INVALID",
    "VIDEO_REQUEST_SNAPSHOT_ITEMS_INVALID",
    "VIDEO_REQUEST_SNAPSHOT_TASK_NOT_FOUND",
    "VIDEO_REQUEST_SNAPSHOT_IDENTITY_MISMATCH",
    "VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT",
    "request_snapshot_hash",
  ]],
  [SIGNATURES[1], [
    "reserve_video_generation_task_routing_atomic",
    "persist_video_generation_request_snapshot_v1_atomic",
    "request_snapshot_unavailable",
    "request_snapshot_replayed",
    "VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT",
  ]],
  [SIGNATURES[2], [
    "reserve_queued_digital_video_task_routing_atomic",
    "persist_video_generation_request_snapshot_v1_atomic",
    "request_snapshot_unavailable",
    "request_snapshot_replayed",
    "VIDEO_REQUEST_SNAPSHOT_IMMUTABLE_CONFLICT",
  ]],
]);

assert.equal(process.argv.slice(2).length, 0, "READ_ONLY_CHECKER_ACCEPTS_NO_ARGUMENTS");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const migrationSource = await fs.readFile(path.resolve("supabase/migrations", BASE_MIGRATION_FILE), "utf8");
const migrationHash = digest(migrationSource);
const alignmentMigrationSource = await fs.readFile(path.resolve("supabase/migrations", ALIGNMENT_MIGRATION_FILE), "utf8");
const alignmentMigrationHash = digest(alignmentMigrationSource);
for (const token of [
  "video_generation_request_snapshot.v1",
  "video_tasks_request_snapshot_v1_check",
  ...SIGNATURES.map(signature => signature.slice("public.".length, signature.indexOf("("))),
  "SECURITY DEFINER",
  "SET search_path = public, pg_temp",
  "TO service_role",
]) assert.ok(migrationSource.includes(token), `MIGRATION_CONTRACT_TOKEN_REQUIRED:${token}`);
for (const token of [
  "video_tasks",
  "alter function %s owner to %I",
  "alter function %s security definer",
  "alter function %s set search_path = public, pg_temp",
  "has_function_privilege",
  "v_unexpected_effective_roles",
  ...SIGNATURES,
]) assert.ok(alignmentMigrationSource.toLowerCase().includes(token.toLowerCase()), `ALIGNMENT_MIGRATION_TOKEN_REQUIRED:${token}`);

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
  application_name: "codex-local-video-request-snapshot-readiness",
  connectionTimeoutMillis: 10_000,
  query_timeout: 45_000,
});

function sameMembers(left, right) {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

await client.connect();
try {
  const identity = (await client.query(
    "select current_user,current_database() as database_name,inet_server_addr()::text as server_address,inet_server_port() as server_port",
  )).rows[0];
  assert.equal(identity.current_user, "postgres", "LOCAL_READ_ONLY_ROLE_REQUIRED");
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );

  const ledger = await client.query(
    "select version::text,name,hash,applied_by,applied_at from supabase_migrations.schema_migrations where version::text=any($1::text[]) order by version::text",
    [[BASE_VERSION, ALIGNMENT_VERSION]],
  );
  const expectedLedger = new Map([
    [BASE_VERSION, migrationHash],
    [ALIGNMENT_VERSION, alignmentMigrationHash],
  ]);
  const ledgerRows = ledger.rows.map(row => ({
    version: String(row.version || ""),
    name: String(row.name || ""),
    hash: String(row.hash || "").toLowerCase(),
    appliedBy: String(row.applied_by || ""),
    appliedAt: row.applied_at || null,
  }));
  const ledgerPresent = ledgerRows.length === expectedLedger.size
    && [...expectedLedger.keys()].every(version => ledgerRows.some(row => row.version === version));
  const ledgerHashMatches = ledgerPresent && ledgerRows.every(row => expectedLedger.get(row.version) === row.hash);
  const tableOwner = String((await client.query(
    "select pg_get_userbyid(relowner) as owner from pg_class where oid=to_regclass('public.video_tasks')",
  )).rows[0]?.owner || "");
  const columns = (await client.query(
    `select column_name,data_type
       from information_schema.columns
      where table_schema='public' and table_name='video_tasks'
        and column_name in ('request_snapshot','request_snapshot_hash','request_snapshot_version')
      order by column_name`,
  )).rows.map(row => ({ name: String(row.column_name), type: String(row.data_type) }));
  const columnsReady = sameMembers(
    columns.map(column => `${column.name}:${column.type}`),
    ["request_snapshot:jsonb", "request_snapshot_hash:text", "request_snapshot_version:integer"],
  );
  const constraintRow = (await client.query(
    `select pg_get_constraintdef(oid,true) as definition,convalidated
       from pg_constraint
      where conrelid=to_regclass('public.video_tasks')
        and conname='video_tasks_request_snapshot_v1_check'`,
  )).rows[0];
  const constraintDefinition = String(constraintRow?.definition || "");
  const constraintTokens = [
    "video_generation_request_snapshot.v1", "request_snapshot_version", "request_snapshot_hash",
    "userPrompt", "effectivePrompt", "promptNormalizations", "negativePrompt", "referenceAssets",
    "targetDurationSeconds", "effectiveDurationSeconds", "aspectRatio", "resolution", "fps", "seed",
    "generateAudio", "publicModelId", "routingConfigHash", "adapterVersion", "providerPayloadHash", "131072",
  ];
  const constraintReady = constraintRow?.convalidated === true
    && constraintTokens.every(token => constraintDefinition.includes(token));
  const counts = (await client.query(
    `select count(*) filter (where request_snapshot is null)::integer as null_count,
            count(*) filter (where request_snapshot->>'schema'='video_generation_request_snapshot.v1')::integer as v1_count,
            count(*) filter (where request_snapshot is not null and (
              request_snapshot_version is distinct from 1
              or request_snapshot_hash !~ '^[a-f0-9]{64}$'
              or request_snapshot->>'schema' is distinct from 'video_generation_request_snapshot.v1'
            ))::integer as invalid_count
       from public.video_tasks`,
  )).rows[0];

  const functions = [];
  for (const signature of SIGNATURES) {
    const row = (await client.query(
      `select pg_get_userbyid(p.proowner) as owner,
              p.prosecdef as security_definer,
              p.proconfig,
              pg_get_functiondef(p.oid) as definition,
              has_function_privilege('anon',p.oid,'execute') as anon_execute,
              has_function_privilege('authenticated',p.oid,'execute') as authenticated_execute,
              has_function_privilege('service_role',p.oid,'execute') as service_execute,
              to_jsonb(array(
                select coalesce(pg_get_userbyid(acl.grantee),'PUBLIC')
                  from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
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
    const definition = String(row?.definition || "");
    const executeGrantees = Array.isArray(row?.execute_grantees) ? row.execute_grantees.map(String) : [];
    const unexpectedEffectiveGrantees = Array.isArray(row?.unexpected_effective_grantees)
      ? row.unexpected_effective_grantees.map(String) : [];
    const semanticsReady = (SEMANTIC_TOKENS.get(signature) || []).every(token => definition.includes(token));
    const privileges = {
      anonExecute: row?.anon_execute === true,
      authenticatedExecute: row?.authenticated_execute === true,
      serviceExecute: row?.service_execute === true,
    };
    const securityReady = Boolean(tableOwner)
      && row?.owner === tableOwner
      && row?.security_definer === true
      && Array.isArray(row?.proconfig)
      && row.proconfig.length === 1
      && row.proconfig[0] === "search_path=public, pg_temp"
      && sameMembers(executeGrantees, [tableOwner, "service_role"])
      && unexpectedEffectiveGrantees.length === 0
      && privileges.anonExecute === false
      && privileges.authenticatedExecute === false
      && privileges.serviceExecute === true;
    functions.push({
      signature,
      present: Boolean(row),
      definitionSha256: definition ? digest(definition) : null,
      semanticsReady,
      owner: String(row?.owner || ""),
      ownerMatchesTable: Boolean(tableOwner) && row?.owner === tableOwner,
      securityDefiner: row?.security_definer === true,
      searchPath: Array.isArray(row?.proconfig) ? row.proconfig.map(String) : [],
      executeGrantees,
      unexpectedEffectiveGrantees,
      privileges,
      securityReady,
      ready: Boolean(row) && semanticsReady && securityReady,
    });
  }

  const live = {
    tableOwner,
    columns,
    columnsReady,
    constraint: {
      present: Boolean(constraintRow),
      validated: constraintRow?.convalidated === true,
      definitionSha256: constraintDefinition ? digest(constraintDefinition) : null,
      semanticsReady: constraintReady,
    },
    snapshotCounts: {
      null: Number(counts?.null_count || 0),
      v1: Number(counts?.v1_count || 0),
      invalid: Number(counts?.invalid_count || 0),
    },
    functions,
  };
  const ready = ledgerHashMatches
    && columnsReady
    && constraintReady
    && live.snapshotCounts.invalid === 0
    && functions.length === SIGNATURES.length
    && functions.every(item => item.ready);
  const report = {
    passed: ready,
    mode: "read-only-check",
    checkedAt: new Date().toISOString(),
    target: TARGET,
    migrations: [
      { version: BASE_VERSION, file: BASE_MIGRATION_FILE, sha256: migrationHash },
      { version: ALIGNMENT_VERSION, file: ALIGNMENT_MIGRATION_FILE, sha256: alignmentMigrationHash },
    ],
    ledger: ledgerRows,
    ledgerPresent,
    ledgerHashMatches,
    live,
    ready,
    writes: 0,
    providerCalls: 0,
    billingOperations: 0,
    credentialsPrinted: false,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = ready ? 0 : 2;
} finally {
  await client.end().catch(() => undefined);
}
