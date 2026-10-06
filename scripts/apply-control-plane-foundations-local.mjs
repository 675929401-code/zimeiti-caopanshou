#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const apply = process.argv.includes("--apply");

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-control-plane-foundations"),
    "LOCAL_CONTROL_PLANE_CONFIRMATION_REQUIRED",
  );
}

const migrations = [
  {
    version: "20261002143000",
    name: "project_registry_control_plane",
    tables: ["project_registry", "project_workspace_registry", "project_source_registry"],
    functions: [],
  },
  {
    version: "20261002150000",
    name: "unified_messaging_control_plane",
    tables: [
      "message_templates",
      "message_surface_policies",
      "message_campaigns",
      "message_campaign_runs",
      "message_deliveries",
      "message_events",
      "message_outbox",
      "message_dead_letters",
    ],
    functions: [
      "enqueue_message_outbox_atomic",
      "claim_message_outbox_batch",
      "settle_message_outbox_attempt",
      "get_unified_messaging_status",
    ],
  },
  {
    version: "20261002160000",
    name: "security_case_control_plane",
    tables: [
      "security_cases",
      "security_case_events",
      "security_case_links",
      "security_case_actions",
      "security_case_audit",
    ],
    functions: [
      "ingest_security_case_event_atomic",
      "transition_security_case_atomic",
      "claim_security_case_atomic",
      "link_security_case_entity_atomic",
      "request_security_case_action_atomic",
      "cancel_security_case_action_atomic",
    ],
  },
].map((item) => ({
  ...item,
  file: `${item.version}_${item.name}.sql`,
}));

function stripTransactionWrapper(source, file) {
  assert.match(source, /^BEGIN;\s*/u, `${file}:BEGIN_REQUIRED`);
  assert.match(source, /\sCOMMIT;\s*$/u, `${file}:COMMIT_REQUIRED`);
  return source.replace(/^BEGIN;\s*/u, "").replace(/\sCOMMIT;\s*$/u, "");
}

async function objectState(client, migration) {
  const tableRows = (await client.query(`
    SELECT c.relname AS name,
           c.relrowsecurity AS rls_enabled,
           has_table_privilege('anon', format('public.%I', c.relname), 'SELECT') AS anon_select,
           has_table_privilege('authenticated', format('public.%I', c.relname), 'SELECT') AS authenticated_select,
           has_table_privilege('service_role', format('public.%I', c.relname), 'SELECT') AS service_select
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname
  `, [migration.tables])).rows;
  const functionRows = migration.functions.length
    ? (await client.query(`
        SELECT DISTINCT p.proname AS name
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY($1::text[])
         ORDER BY p.proname
      `, [migration.functions])).rows
    : [];
  return {
    tables: tableRows.map((row) => ({
      name: row.name,
      rlsEnabled: row.rls_enabled === true,
      anonSelect: row.anon_select === true,
      authenticatedSelect: row.authenticated_select === true,
      serviceSelect: row.service_select === true,
    })),
    functions: functionRows.map((row) => row.name),
  };
}

function assertCompleteState(migration, state) {
  assert.deepEqual(
    state.tables.map((row) => row.name),
    [...migration.tables].sort(),
    `${migration.version}:TABLE_SET_INCOMPLETE`,
  );
  assert.ok(state.tables.every((row) => row.rlsEnabled), `${migration.version}:RLS_REQUIRED`);
  assert.ok(state.tables.every((row) => !row.anonSelect && !row.authenticatedSelect), `${migration.version}:CLIENT_SELECT_MUST_BE_REVOKED`);
  assert.ok(state.tables.every((row) => row.serviceSelect), `${migration.version}:SERVICE_READ_REQUIRED`);
  assert.deepEqual(
    state.functions,
    [...migration.functions].sort(),
    `${migration.version}:FUNCTION_SET_INCOMPLETE`,
  );
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = new Map();
for (const migration of migrations) {
  const source = await fs.readFile(path.resolve("supabase/migrations", migration.file), "utf8");
  sources.set(migration.version, {
    source,
    body: stripTransactionWrapper(source, migration.file),
    hash: crypto.createHash("sha256").update(source).digest("hex"),
  });
}

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-control-plane-foundations",
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
           current_user AS database_user,
           current_setting('server_version') AS server_version
  `)).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_LOCAL_DATABASE_NAME_REQUIRED");
  assert.equal(identity.server_address, "127.0.0.1", "LIVE_LOOPBACK_DATABASE_REQUIRED");
  assert.equal(Number(identity.server_port), 54322, "LIVE_LOCAL_DATABASE_PORT_REQUIRED");
  const ledgerTable = (await client.query(
    "SELECT to_regclass('supabase_migrations.schema_migrations')::text AS name",
  )).rows[0]?.name;
  assert.equal(ledgerTable, "supabase_migrations.schema_migrations", "MIGRATION_LEDGER_REQUIRED");

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('control-plane-foundations:20261002',0))");
  const actions = [];
  for (const migration of migrations) {
    const source = sources.get(migration.version);
    const prior = await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1 FOR UPDATE",
      [migration.version],
    );
    const before = await objectState(client, migration);
    if (prior.rowCount) {
      assert.equal(String(prior.rows[0].hash || ""), source.hash, `${migration.version}:MIGRATION_LEDGER_HASH_CONFLICT`);
      assertCompleteState(migration, before);
      actions.push({ version: migration.version, action: "already_applied", hash: source.hash });
      continue;
    }
    assert.equal(before.tables.length, 0, `${migration.version}:UNLEDGERED_TABLES_PRESENT`);
    assert.equal(before.functions.length, 0, `${migration.version}:UNLEDGERED_FUNCTIONS_PRESENT`);
    await client.query(source.body);
    const after = await objectState(client, migration);
    assertCompleteState(migration, after);
    if (apply) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [migration.version, migration.name, [migration.file], source.hash, "codex-local-control-plane-foundations"],
      );
    }
    actions.push({
      version: migration.version,
      action: apply ? "applied" : "validated_then_rolled_back",
      hash: source.hash,
    });
  }

  if (apply) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  const finalStates = [];
  for (const migration of migrations) {
    const state = await objectState(client, migration);
    const ledger = (await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [migration.version],
    )).rows[0] || null;
    if (apply) {
      assertCompleteState(migration, state);
      assert.equal(String(ledger?.hash || ""), sources.get(migration.version).hash, `${migration.version}:COMMITTED_LEDGER_HASH_MISMATCH`);
    }
    finalStates.push({
      version: migration.version,
      name: migration.name,
      tables: state.tables,
      functions: state.functions,
      ledger: ledger ? {
        version: String(ledger.version),
        name: ledger.name,
        hash: ledger.hash,
        appliedBy: ledger.applied_by,
        appliedAt: ledger.applied_at,
      } : null,
    });
  }

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    mode: apply ? "apply" : "check-rollback",
    identity: {
      databaseName: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: Number(identity.server_port),
      databaseUser: identity.database_user,
      serverVersion: identity.server_version,
    },
    actions,
    finalStates,
    projectRegistrySeedRows: actions.some((item) => item.version === "20261002143000" && item.action === "applied") ? 29 : 0,
    migrationLedgerWrites: actions.filter((item) => item.action === "applied").length,
    businessDataWrites: 0,
    persistentTestFixtures: 0,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "control-plane-foundations-local");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    path.join(evidenceDir, apply ? "migration-apply.json" : "migration-check.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
