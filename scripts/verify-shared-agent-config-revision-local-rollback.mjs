#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const migrationPath = path.resolve('supabase/migrations/20261010123000_shared_agent_config_revision.sql');
const ownerMigrationPath = path.resolve('supabase/migrations/20261010124000_shared_agent_function_owner_reconcile.sql');
const ownerRollbackPath = path.resolve('supabase/rollbacks/20261010124000_shared_agent_function_owner_reconcile.rollback.sql');
const sharedAgentFunctionNames = [
  'maintain_shared_agent_config_revision',
  'prepare_shared_agent_prompt_version_insert',
  'record_shared_agent_prompt_version',
];

function stripTransactionWrapper(source) {
  assert.match(source, /^BEGIN;\s*/u, 'MIGRATION_BEGIN_REQUIRED');
  assert.match(source, /\sCOMMIT;\s*$/u, 'MIGRATION_COMMIT_REQUIRED');
  return source.replace(/^BEGIN;\s*/u, '').replace(/\sCOMMIT;\s*$/u, '');
}

function quoteIdentifier(value) {
  assert.match(value, /^[A-Za-z_][A-Za-z0-9_$]*$/u, 'SAFE_POSTGRES_IDENTIFIER_REQUIRED');
  return `"${value.replaceAll('"', '""')}"`;
}

async function schemaSnapshot(client) {
  const columns = (await client.query(`
    SELECT table_name, column_name, udt_name, is_nullable, coalesce(column_default, '') AS column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [['agents', 'prompt_versions']])).rows;
  const triggers = (await client.query(`
    SELECT c.relname AS table_name, t.tgname AS trigger_name,
           pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ANY($1::text[])
      AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname
  `, [['agents', 'prompt_versions']])).rows;
  const indexes = (await client.query(`
    SELECT tablename, indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = ANY($1::text[])
    ORDER BY tablename, indexname
  `, [['agents', 'prompt_versions']])).rows;
  return { columns, triggers, indexes };
}

async function revisionFingerprint(client) {
  const agents = (await client.query(`
    SELECT count(*)::integer AS rows,
           coalesce(sum(config_revision), 0)::text AS revision_sum,
           md5(coalesce(string_agg(id::text || ':' || config_revision::text, ',' ORDER BY id::text), '')) AS fingerprint
    FROM public.agents
  `)).rows[0];
  const prompts = (await client.query(`
    SELECT count(*)::integer AS rows,
           count(DISTINCT (agent_id, agent_revision))::integer AS unique_revisions,
           md5(coalesce(string_agg(id::text || ':' || agent_revision::text || ':' || prompt_hash, ',' ORDER BY id::text), '')) AS fingerprint
    FROM public.prompt_versions
  `)).rows[0];
  return { agents, prompts };
}

async function functionOwnerSnapshot(client) {
  return (await client.query(`
    SELECT procedure.proname AS function_name,
           function_owner.rolname AS function_owner,
           table_owner.rolname AS agents_owner,
           procedure.prosecdef AS security_definer
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    JOIN pg_catalog.pg_roles AS function_owner
      ON function_owner.oid = procedure.proowner
    CROSS JOIN pg_catalog.pg_class AS agents_table
    JOIN pg_catalog.pg_namespace AS agents_namespace
      ON agents_namespace.oid = agents_table.relnamespace
    JOIN pg_catalog.pg_roles AS table_owner
      ON table_owner.oid = agents_table.relowner
    WHERE namespace.nspname = 'public'
      AND procedure.proname = ANY($1::text[])
      AND procedure.pronargs = 0
      AND procedure.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND agents_namespace.nspname = 'public'
      AND agents_table.relname = 'agents'
    ORDER BY procedure.proname
  `, [sharedAgentFunctionNames])).rows;
}

function assertOwnersAligned(rows) {
  assert.equal(rows.length, sharedAgentFunctionNames.length, 'SHARED_AGENT_TRIGGER_FUNCTIONS_REQUIRED');
  for (const row of rows) {
    assert.equal(row.security_definer, true, `${row.function_name}:SECURITY_DEFINER_REQUIRED`);
    assert.equal(row.function_owner, row.agents_owner, `${row.function_name}:OWNER_MUST_MATCH_AGENTS_TABLE`);
  }
}

const runtime = JSON.parse((await fs.readFile(runtimePath, 'utf8')).replace(/^\uFEFF/u, ''));
assert.equal(runtime.localOnly, true, 'LOCAL_RUNTIME_REQUIRED');
assert.equal(runtime.ownerConnection?.host, '127.0.0.1', 'LOCAL_DATABASE_HOST_REQUIRED');
assert.equal(Number(runtime.ownerConnection?.port), 54322, 'LOCAL_DATABASE_PORT_REQUIRED');
assert.equal(runtime.ownerConnection?.database, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');
assert.equal(runtime.ownerConnection?.user, runtime.ownerRole, 'LOCAL_OWNER_ROLE_MUST_MATCH_CONNECTION');
assert.equal(typeof runtime.postgresPassword, 'string', 'LOCAL_POSTGRES_PASSWORD_REQUIRED');
assert.ok(runtime.postgresPassword.length > 0, 'LOCAL_POSTGRES_PASSWORD_REQUIRED');

const migrationSource = await fs.readFile(migrationPath, 'utf8');
const migrationBody = stripTransactionWrapper(migrationSource);
const ownerMigrationSource = await fs.readFile(ownerMigrationPath, 'utf8');
const ownerMigrationBody = stripTransactionWrapper(ownerMigrationSource);
const ownerRollbackSource = await fs.readFile(ownerRollbackPath, 'utf8');
const ownerRollbackBody = stripTransactionWrapper(ownerRollbackSource);
const client = new pg.Client({
  ...runtime.ownerConnection,
  user: 'postgres',
  password: runtime.postgresPassword,
  application_name: 'codex-shared-agent-revision-rollback-verifier',
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port,
           session_user AS session_user,
           current_user AS current_user,
           current_setting('server_version_num')::integer AS server_version_num
  `)).rows[0];
  assert.equal(identity.database_name, 'zimeiti_local', 'LIVE_LOCAL_DATABASE_NAME_REQUIRED');
  assert.equal(identity.server_address, '127.0.0.1', 'LIVE_LOOPBACK_DATABASE_REQUIRED');
  assert.equal(Number(identity.server_port), 54322, 'LIVE_LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(identity.session_user, 'postgres', 'LOCAL_BOOTSTRAP_DATABASE_ROLE_REQUIRED');
  assert.equal(identity.current_user, 'postgres', 'LOCAL_BOOTSTRAP_DATABASE_ROLE_REQUIRED');

  const shaFunction = (await client.query(
    "SELECT to_regprocedure('pg_catalog.sha256(bytea)')::text AS signature",
  )).rows[0]?.signature;
  assert.equal(shaFunction, 'sha256(bytea)', 'PG_CATALOG_SHA256_REQUIRED');

  const requiredPromptColumns = (await client.query(`
    SELECT column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'prompt_versions'
      AND column_name = ANY($1::text[])
    ORDER BY column_name
  `, [['agent_id', 'created_at', 'id', 'prompt']])).rows;
  assert.deepEqual(
    requiredPromptColumns.map((row) => [row.column_name, row.udt_name]),
    [
      ['agent_id', 'text'],
      ['created_at', 'timestamptz'],
      ['id', 'uuid'],
      ['prompt', 'text'],
    ],
    'PROMPT_VERSIONS_BASE_SCHEMA_MISMATCH',
  );

  const beforeSchema = await schemaSnapshot(client);
  const beforeFunctionOwners = await functionOwnerSnapshot(client);
  const beforeCounts = (await client.query(`
    SELECT (SELECT count(*)::integer FROM public.agents) AS agents,
           (SELECT count(*)::integer FROM public.prompt_versions) AS prompt_versions
  `)).rows[0];

  await client.query('BEGIN');
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-agent-config-revision:20261010123000', 0))");
  await client.query(ownerMigrationBody);
  const reconciledFunctionOwners = await functionOwnerSnapshot(client);
  assertOwnersAligned(reconciledFunctionOwners);
  await client.query(ownerRollbackBody);
  assert.deepEqual(
    await functionOwnerSnapshot(client),
    reconciledFunctionOwners,
    'FORWARD_COMPATIBLE_ROLLBACK_MUST_RETAIN_OWNER_ALIGNMENT',
  );
  const agentsOwner = reconciledFunctionOwners[0]?.agents_owner;
  assert.equal(agentsOwner, runtime.ownerRole, 'RUNTIME_ROLE_MUST_OWN_AGENTS_TABLE');
  await client.query(`SET LOCAL ROLE ${quoteIdentifier(agentsOwner)}`);
  await client.query(migrationBody);
  assertOwnersAligned(await functionOwnerSnapshot(client));

  const migratedColumns = (await client.query(`
    SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ('agents', 'config_revision'),
        ('prompt_versions', 'agent_revision'),
        ('prompt_versions', 'prompt_hash')
      )
    ORDER BY table_name, column_name
  `)).rows;
  assert.deepEqual(
    migratedColumns.map((row) => [row.table_name, row.column_name, row.udt_name, row.is_nullable]),
    [
      ['agents', 'config_revision', 'int8', 'NO'],
      ['prompt_versions', 'agent_revision', 'int8', 'NO'],
      ['prompt_versions', 'prompt_hash', 'text', 'NO'],
    ],
    'REVISION_COLUMNS_NOT_READY',
  );

  const integrity = (await client.query(`
    SELECT count(*) FILTER (WHERE config_revision < 1)::integer AS invalid_agent_revisions,
           (SELECT count(*)::integer FROM public.prompt_versions WHERE agent_revision < 1 OR prompt_hash !~ '^[0-9a-f]{64}$') AS invalid_prompt_versions,
           (SELECT count(*)::integer FROM (
              SELECT agent_id, agent_revision
              FROM public.prompt_versions
              GROUP BY agent_id, agent_revision
              HAVING count(*) > 1
            ) duplicates) AS duplicate_prompt_revisions
    FROM public.agents
  `)).rows[0];
  assert.deepEqual(integrity, {
    invalid_agent_revisions: 0,
    invalid_prompt_versions: 0,
    duplicate_prompt_revisions: 0,
  });

  const firstFingerprint = await revisionFingerprint(client);
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query(migrationBody);
  assertOwnersAligned(await functionOwnerSnapshot(client));
  const secondFingerprint = await revisionFingerprint(client);
  assert.deepEqual(secondFingerprint, firstFingerprint, 'MIGRATION_REPLAY_CHANGED_REVISION_STATE');

  const fixtureId = `rev-check-${crypto.randomUUID().slice(0, 8)}`;
  const firstPrompt = 'transaction rollback prompt v1';
  const secondPrompt = 'transaction rollback prompt v2';
  const inserted = (await client.query(`
    INSERT INTO public.agents (id, name, category, description, system_prompt)
    VALUES ($1, 'Revision rollback verifier', '通用', 'fixture', $2)
    RETURNING config_revision
  `, [fixtureId, firstPrompt])).rows[0];
  assert.equal(Number(inserted.config_revision), 1);

  const initialHistory = (await client.query(`
    SELECT agent_revision, prompt_hash
    FROM public.prompt_versions
    WHERE agent_id = $1
  `, [fixtureId])).rows;
  assert.deepEqual(initialHistory, [{
    agent_revision: '1',
    prompt_hash: crypto.createHash('sha256').update(firstPrompt).digest('hex'),
  }]);

  const legacyDuplicate = await client.query(`
    INSERT INTO public.prompt_versions (agent_id, prompt)
    VALUES ($1, $2)
    RETURNING id
  `, [fixtureId, firstPrompt]);
  assert.equal(legacyDuplicate.rowCount, 0, 'LEGACY_DUPLICATE_INSERT_MUST_BE_IDEMPOTENT');

  const casUpdate = await client.query(`
    UPDATE public.agents
    SET description = 'cas-success'
    WHERE id = $1 AND config_revision = 1
    RETURNING config_revision
  `, [fixtureId]);
  assert.equal(Number(casUpdate.rows[0]?.config_revision), 2);
  const staleUpdate = await client.query(`
    UPDATE public.agents
    SET description = 'stale-must-not-win'
    WHERE id = $1 AND config_revision = 1
    RETURNING config_revision
  `, [fixtureId]);
  assert.equal(staleUpdate.rowCount, 0, 'STALE_CAS_MUST_NOT_UPDATE');

  const promptUpdate = await client.query(`
    UPDATE public.agents
    SET system_prompt = $2
    WHERE id = $1 AND config_revision = 2
    RETURNING config_revision
  `, [fixtureId, secondPrompt]);
  assert.equal(Number(promptUpdate.rows[0]?.config_revision), 3);
  const secondHistory = (await client.query(`
    SELECT agent_revision, prompt_hash
    FROM public.prompt_versions
    WHERE agent_id = $1 AND agent_revision = 3
  `, [fixtureId])).rows[0];
  assert.deepEqual(secondHistory, {
    agent_revision: '3',
    prompt_hash: crypto.createHash('sha256').update(secondPrompt).digest('hex'),
  });

  const legacyPostUpdate = await client.query(`
    INSERT INTO public.prompt_versions (agent_id, prompt)
    VALUES ($1, $2)
    RETURNING id
  `, [fixtureId, secondPrompt]);
  assert.equal(legacyPostUpdate.rowCount, 0, 'LEGACY_POST_UPDATE_INSERT_MUST_BE_IDEMPOTENT');

  await client.query('SAVEPOINT expected_prompt_conflict');
  let conflictCode = null;
  try {
    await client.query(`
      INSERT INTO public.prompt_versions (agent_id, prompt)
      VALUES ($1, 'conflicting direct prompt')
    `, [fixtureId]);
  } catch (error) {
    conflictCode = error?.code || null;
    await client.query('ROLLBACK TO SAVEPOINT expected_prompt_conflict');
  }
  await client.query('RELEASE SAVEPOINT expected_prompt_conflict');
  assert.equal(conflictCode, '23505', 'CONFLICTING_DIRECT_PROMPT_MUST_FAIL_CLOSED');

  await client.query('ROLLBACK');
  transactionOpen = false;

  const afterSchema = await schemaSnapshot(client);
  const afterFunctionOwners = await functionOwnerSnapshot(client);
  const afterCounts = (await client.query(`
    SELECT (SELECT count(*)::integer FROM public.agents) AS agents,
           (SELECT count(*)::integer FROM public.prompt_versions) AS prompt_versions
  `)).rows[0];
  assert.deepEqual(afterSchema, beforeSchema, 'ROLLBACK_MUST_RESTORE_SCHEMA');
  assert.deepEqual(afterFunctionOwners, beforeFunctionOwners, 'ROLLBACK_MUST_RESTORE_FUNCTION_OWNERS');
  assert.deepEqual(afterCounts, beforeCounts, 'ROLLBACK_MUST_RESTORE_ROWS');

  process.stdout.write(`${JSON.stringify({
    passed: true,
    mode: 'local-loopback-bootstrap-reconcile-runtime-replay-transaction-rollback',
    target: '127.0.0.1:54322/zimeiti_local',
    serverVersionNum: identity.server_version_num,
    baseSchema: {
      pgCatalogSha256: shaFunction,
      promptVersions: requiredPromptColumns.map((row) => ({
        column: row.column_name,
        type: row.udt_name,
        nullable: row.is_nullable,
      })),
    },
    checks: {
      migrationExecuted: true,
      ownerMigrationExecutedByBootstrapRoleBeforeReplay: true,
      forwardCompatibleOwnerRollbackRetainedAlignment: true,
      originalMigrationReplayedAsAgentsTableOwner: true,
      triggerFunctionOwnersMatchAgentsTable: true,
      migrationReplayStable: true,
      historyUnique: true,
      legacyDirectInsertCompatible: true,
      conflictingDirectInsertFailClosed: true,
      staleCasRejected: true,
      schemaRestoredAfterRollback: true,
      rowCountsRestoredAfterRollback: true,
    },
    sideEffects: {
      committedDatabaseWrites: 0,
      productionWrites: 0,
      networkRequestsOutsideLoopback: 0,
      paidRequests: 0,
    },
  }, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
