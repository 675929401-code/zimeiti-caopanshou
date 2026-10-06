#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261002120000";
const NAME = "platform_brand_control_plane";
const FILE = `${VERSION}_${NAME}.sql`;
const apply = process.argv.includes("--apply");
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const target = "127.0.0.1:54322/zimeiti_local";

if (apply) {
  assert.ok(
    process.argv.includes("--confirm-local-platform-brand-control-plane"),
    "LOCAL_PLATFORM_BRAND_CONTROL_PLANE_CONFIRMATION_REQUIRED",
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function snapshot(name) {
  return {
    schema: "platform-brand/v1",
    name,
    shortName: "操盘手",
    slogan: "让内容经营有据可循",
    welcomeMessage: "欢迎使用",
    description: "本地品牌控制面事务探针",
    seo: { title: name, description: "本地验证，不会持久化" },
    colors: { primary: "#168D7A", accent: "#2F80FF" },
    assetIds: {},
  };
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

async function expectDatabaseError(client, label, expectedCode, callback) {
  await client.query(`SAVEPOINT ${label}`);
  try {
    await callback();
    assert.fail(`${label.toUpperCase()}_EXPECTED_DATABASE_ERROR`);
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${label}`);
    assert.equal(error?.code, expectedCode, `${label.toUpperCase()}_ERROR_CODE`);
  }
  await client.query(`RELEASE SAVEPOINT ${label}`);
}

async function inspectSchema(client) {
  const tables = (await client.query(`
    SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname
  `, [[
    "platform_brand_profiles",
    "platform_brand_revisions",
    "platform_brand_assets",
    "platform_brand_revision_assets",
    "platform_brand_events",
  ]])).rows;
  assert.equal(tables.length, 5, "PLATFORM_BRAND_TABLES_INCOMPLETE");
  assert.ok(tables.every((row) => row.rls_enabled === true), "PLATFORM_BRAND_RLS_REQUIRED");

  const rpcRows = (await client.query(`
    SELECT p.oid::regprocedure::text AS signature
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY($1::text[])
     ORDER BY p.proname
  `, [[
    "save_platform_brand_draft_atomic",
    "publish_platform_brand_revision_atomic",
    "rollback_platform_brand_revision_atomic",
    "register_platform_brand_asset_atomic",
    "read_published_platform_brand",
    "read_published_platform_brand_asset",
  ]])).rows.map((row) => row.signature);
  assert.equal(rpcRows.length, 6, "PLATFORM_BRAND_RPCS_INCOMPLETE");

  const privileges = (await client.query(`
    SELECT
      has_table_privilege('anon', 'public.platform_brand_profiles', 'SELECT') AS anon_table,
      has_table_privilege('authenticated', 'public.platform_brand_profiles', 'SELECT') AS authenticated_table,
      has_table_privilege('service_role', 'public.platform_brand_profiles', 'SELECT') AS service_table,
      has_function_privilege('anon', 'public.read_published_platform_brand()', 'EXECUTE') AS anon_rpc,
      has_function_privilege('authenticated', 'public.read_published_platform_brand()', 'EXECUTE') AS authenticated_rpc,
      has_function_privilege('service_role', 'public.read_published_platform_brand()', 'EXECUTE') AS service_rpc
  `)).rows[0];
  assert.deepEqual(privileges, {
    anon_table: false,
    authenticated_table: false,
    service_table: true,
    anon_rpc: false,
    authenticated_rpc: false,
    service_rpc: true,
  });

  const triggers = (await client.query(`
    SELECT tgname
      FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname = ANY($1::text[])
     ORDER BY tgname
  `, [[
    "platform_brand_asset_immutable",
    "platform_brand_event_immutable",
    "platform_brand_revision_assets_immutable",
    "platform_brand_revision_immutable",
    "platform_settings_reject_signed_brand_url",
  ]])).rows.map((row) => row.tgname);
  assert.equal(triggers.length, 5, "PLATFORM_BRAND_TRIGGERS_INCOMPLETE");

  const profile = (await client.query(`
    SELECT id, generation, draft_revision_id, published_revision_id
      FROM public.platform_brand_profiles
     WHERE id = 'default'
  `)).rows[0];
  assert.ok(profile, "DEFAULT_PLATFORM_BRAND_PROFILE_REQUIRED");
  assert.ok(Number.isSafeInteger(Number(profile.generation)) && Number(profile.generation) >= 0);

  const initialPublished = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  const legacySettings = (await client.query(`
    SELECT setting_key, setting_value
      FROM public.platform_settings
     WHERE setting_key = ANY($1::text[])
     ORDER BY setting_key
  `, [["platform_name", "platform_cover", "welcome_message"]])).rows;

  return {
    tables,
    rpcSignatures: rpcRows,
    privileges,
    triggers,
    profile: {
      id: profile.id,
      generation: Number(profile.generation),
      hasDraft: Boolean(profile.draft_revision_id),
      hasPublished: Boolean(profile.published_revision_id),
    },
    publishedSource: initialPublished ? "published" : "legacy-fallback",
    legacySettingKeys: legacySettings.map((row) => row.setting_key),
  };
}

async function runFunctionalProbe(client) {
  await client.query("SAVEPOINT brand_functional_probe");
  try {
    const actorId = crypto.randomUUID();
    const startGeneration = Number((await client.query(
      "SELECT generation FROM public.platform_brand_profiles WHERE id='default' FOR UPDATE",
    )).rows[0].generation);

    const firstSnapshot = snapshot("品牌事务探针 A");
    const firstDraft = (await client.query(
      "SELECT public.save_platform_brand_draft_atomic($1,$2::jsonb,$3,$4::uuid,$5) AS value",
      [startGeneration, JSON.stringify(firstSnapshot), sha256Json(firstSnapshot), actorId, "local-brand-probe-a"],
    )).rows[0].value;
    assert.equal(Number(firstDraft.generation), startGeneration + 1);

    await expectDatabaseError(client, "brand_stale_generation", "40001", () => client.query(
      "SELECT public.save_platform_brand_draft_atomic($1,$2::jsonb,$3,$4::uuid,$5)",
      [startGeneration, JSON.stringify(firstSnapshot), sha256Json(firstSnapshot), actorId, "local-brand-probe-stale"],
    ));

    const firstPublished = (await client.query(
      "SELECT public.publish_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
      [startGeneration + 1, firstDraft.revisionId, actorId, "local-brand-probe-publish-a"],
    )).rows[0].value;
    assert.equal(firstPublished.status, "published");

    const secondSnapshot = snapshot("品牌事务探针 B");
    const secondDraft = (await client.query(
      "SELECT public.save_platform_brand_draft_atomic($1,$2::jsonb,$3,$4::uuid,$5) AS value",
      [startGeneration + 2, JSON.stringify(secondSnapshot), sha256Json(secondSnapshot), actorId, "local-brand-probe-b"],
    )).rows[0].value;
    const secondPublished = (await client.query(
      "SELECT public.publish_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
      [startGeneration + 3, secondDraft.revisionId, actorId, "local-brand-probe-publish-b"],
    )).rows[0].value;
    assert.equal(secondPublished.status, "published");

    const rolledBack = (await client.query(
      "SELECT public.rollback_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
      [startGeneration + 4, firstDraft.revisionId, actorId, "local-brand-probe-rollback"],
    )).rows[0].value;
    assert.equal(rolledBack.status, "published");
    assert.equal(Number(rolledBack.generation), startGeneration + 5);

    const publicValue = (await client.query(
      "SELECT public.read_published_platform_brand() AS value",
    )).rows[0].value;
    assert.equal(publicValue.snapshot.name, firstSnapshot.name);
    assert.equal(publicValue.snapshotSha256, sha256Json(firstSnapshot));

    await client.query(`
      INSERT INTO public.platform_settings(setting_key, setting_value, updated_at)
      VALUES('platform_cover', '/brand/local-probe.png', now())
      ON CONFLICT (setting_key) DO UPDATE
        SET setting_value = EXCLUDED.setting_value, updated_at = now()
    `);
    await expectDatabaseError(client, "brand_signed_legacy_url", "22023", () => client.query(`
      UPDATE public.platform_settings
         SET setting_value = 'https://cdn.example/logo.png?X-Amz-Signature=secret', updated_at = now()
       WHERE setting_key = 'platform_cover'
    `));

    const eventCount = Number((await client.query(`
      SELECT count(*)::bigint AS count
        FROM public.platform_brand_events
       WHERE actor_id = $1::uuid
    `, [actorId])).rows[0].count);
    assert.equal(eventCount, 5, "PLATFORM_BRAND_EVENT_CHAIN_INCOMPLETE");

    return {
      draftPublishRollback: true,
      staleGenerationRejected: true,
      signedLegacyUrlRejected: true,
      immutableEventsRecorded: eventCount,
      probePersisted: false,
    };
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT brand_functional_probe");
    await client.query("RELEASE SAVEPOINT brand_functional_probe");
  }
}

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
assert.match(source, /CREATE TABLE IF NOT EXISTS public\.platform_brand_profiles/u);
assert.match(source, /CREATE OR REPLACE FUNCTION public\.rollback_platform_brand_revision_atomic/u);
assert.match(source, /REVOKE ALL ON public\.platform_brand_assets FROM PUBLIC, anon, authenticated/u);
assert.match(source, /PLATFORM_BRAND_SIGNED_URL_FORBIDDEN/u);
const migrationHash = crypto.createHash("sha256").update(source).digest("hex");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-platform-brand-control-plane",
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
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('platform-brand-control-plane:20261002120000',0))");
  const prior = await client.query(
    "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let action = apply ? "already_applied" : "checked_existing";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(source);
    action = apply ? "applied" : "validated_then_rolled_back";
    if (apply) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [VERSION, NAME, [FILE], migrationHash, "codex-local-platform-brand-control-plane"],
      );
    }
  }

  const schema = await inspectSchema(client);
  const functionalProbe = await runFunctionalProbe(client);

  if (apply) {
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query("COMMIT");
  } else {
    await client.query("ROLLBACK");
  }
  transactionOpen = false;

  const ledger = apply
    ? (await client.query(
      "SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [VERSION],
    )).rows[0]
    : prior.rows[0] || null;
  if (apply) assert.equal(String(ledger?.hash || ""), migrationHash, "COMMITTED_LEDGER_HASH_MISMATCH");

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target,
    mode: apply ? "apply" : "check-rollback",
    migration: FILE,
    migrationHash,
    action,
    identity: {
      databaseName: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: Number(identity.server_port),
      databaseUser: identity.database_user,
      serverVersion: identity.server_version,
    },
    ledger: ledger ? {
      version: String(ledger.version),
      name: ledger.name,
      hash: ledger.hash,
      appliedBy: ledger.applied_by,
      appliedAt: ledger.applied_at,
    } : null,
    schema,
    functionalProbe,
    productionWrites: 0,
    paidCalls: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "platform-brand-control-plane");
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
