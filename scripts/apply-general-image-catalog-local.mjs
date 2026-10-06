import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_PATH = "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const MIGRATIONS = [
  ["20260908193000", "cover_model_protocol_config", "20260908193000_cover_model_protocol_config.sql"],
  ["20260921114500", "image_visible_disabled_catalog", "20260921114500_image_visible_disabled_catalog.sql"],
  ["20260923090000", "general_image_catalog_visibility", "20260923090000_general_image_catalog_visibility.sql"],
];
const TARGET_IDS = ["cover-model-seedream-5", "gemini-3-0-pro-image-chA"];

function bodyOf(sql) {
  const normalized = sql.replace(/^\uFEFF/u, "").trim();
  const beginIndex = normalized.search(/(?:^|\n)BEGIN\s*;/iu);
  assert.ok(beginIndex >= 0, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/iu, "MIGRATION_COMMIT_REQUIRED");
  return normalized.slice(beginIndex).replace(/^\s*BEGIN\s*;/iu, "").replace(/COMMIT\s*;\s*$/iu, "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-image-catalog"), "LOCAL_IMAGE_CATALOG_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(RUNTIME_PATH, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.host, "127.0.0.1", "LOCAL_RUNTIME_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const connectionOptions = runtime.ownerDatabaseUrl || runtime.databaseUrl
  ? { connectionString: String(runtime.ownerDatabaseUrl || runtime.databaseUrl) }
  : runtime.ownerConnection;
assert.ok(connectionOptions && typeof connectionOptions === "object", "LOCAL_OWNER_DATABASE_CONNECTION_REQUIRED");

const sources = [];
for (const [version, name, filename] of MIGRATIONS) {
  const sql = await fs.readFile(path.resolve("supabase/migrations", filename), "utf8");
  sources.push({ version, name, filename, sql, body: bodyOf(sql), hash: sha256(sql) });
}

const client = new pg.Client({ ...connectionOptions, query_timeout: 30_000, connectionTimeoutMillis: 10_000 });
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1");
  assert.equal(Number(identity.server_port), 54322);

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260923090000]);
  const applied = [];
  for (const source of sources) {
    const ledger = await client.query(
      "SELECT version, hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
      [source.version],
    );
    if (ledger.rowCount) assert.equal(String(ledger.rows[0].hash || ""), source.hash, `MIGRATION_LEDGER_HASH_CONFLICT:${source.version}`);

    // All three migrations are idempotent. Replaying the exact checked-in SQL
    // repairs a drifted local schema even when an old ledger row survived.
    await client.query(source.body);
    if (!ledger.rowCount) {
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [source.version, source.name, [source.filename], source.hash, "codex-local-general-image-catalog"],
      );
    }
    applied.push({ version: source.version, file: source.filename, action: ledger.rowCount ? "idempotent_repair" : "applied" });
  }

  const column = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='cover_models' AND column_name='api_protocol_config'`,
  );
  assert.equal(column.rowCount, 1, "COVER_MODEL_PROTOCOL_COLUMN_MISSING");
  const definition = String((await client.query(
    "SELECT pg_get_functiondef('public.read_image_model_publication_state(text)'::regprocedure) AS definition",
  )).rows[0]?.definition || "");
  assert.match(definition, /catalog_visibility/iu, "VISIBLE_DISABLED_PUBLICATION_RULE_MISSING");
  const rows = (await client.query(
    `SELECT id,is_active,is_hidden,api_protocol_config->>'catalog_visibility' AS catalog_visibility
     FROM public.cover_models WHERE id=ANY($1::text[]) ORDER BY id`,
    [TARGET_IDS],
  )).rows;
  assert.equal(rows.length, TARGET_IDS.length, "EXPECTED_IMAGE_MODELS_MISSING");
  for (const row of rows) {
    assert.equal(row.is_active, false, `DISABLED_MODEL_BECAME_ACTIVE:${row.id}`);
    assert.equal(row.is_hidden, false, `MODEL_BECAME_HIDDEN:${row.id}`);
    assert.equal(row.catalog_visibility, "visible_disabled", `VISIBLE_DISABLED_NOT_SET:${row.id}`);
  }
  const catalog = (await client.query(
    "SELECT public.read_image_model_publication_state(NULL::text) AS catalog",
  )).rows[0]?.catalog || [];
  const catalogIds = catalog.map((entry) => String(entry?.model?.id || "")).filter(Boolean);
  for (const id of TARGET_IDS) assert.ok(catalogIds.includes(id), `PUBLIC_CATALOG_MODEL_MISSING:${id}`);

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    providerRequests: 0,
    migrations: applied,
    visibleDisabledModels: rows,
    publicationCatalogCount: catalogIds.length,
  };
  const evidenceDir = path.resolve(".codex-evidence", "general-image-catalog-local");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "migration-summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
