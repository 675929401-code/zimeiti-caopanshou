import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const RUNTIME_PATH = 'F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json';
const MIGRATION_FILE = '20260921114500_image_visible_disabled_catalog.sql';
const VERSION = '20260921114500';
const FUNCTION_SIGNATURE = 'public.read_image_model_publication_state(text)';
const EXPECTED_DISABLED_IDS = [
  'pending-cover-model-gpt-image-2-image-2-1k',
  'pending-cover-model-gpt-image-2-official',
];
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function migrationBody(sql) {
  const normalized = sql.replace(/^\uFEFF/u, '').trim();
  assert.match(normalized, /^BEGIN\s*;/iu, 'MIGRATION_BEGIN_REQUIRED');
  assert.match(normalized, /COMMIT\s*;\s*$/iu, 'MIGRATION_COMMIT_REQUIRED');
  return normalized
    .replace(/^BEGIN\s*;/iu, '')
    .replace(/COMMIT\s*;\s*$/iu, '')
    .trim();
}

async function main() {
  assert.ok(process.argv.includes('--execute'), 'EXPLICIT_EXECUTION_REQUIRED');
  assert.ok(process.argv.includes('--confirm-local-catalog-function-only'), 'LOCAL_CATALOG_FUNCTION_CONFIRMATION_REQUIRED');

  const runtime = JSON.parse((await readFile(RUNTIME_PATH, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.equal(runtime.localOnly, true, 'LOCAL_RUNTIME_REQUIRED');
  assert.equal(runtime.host, '127.0.0.1', 'LOCAL_RUNTIME_HOST_REQUIRED');
  assert.equal(Number(runtime.databasePort), 54322, 'LOCAL_DATABASE_PORT_REQUIRED');
  assert.equal(runtime.databaseName, 'zimeiti_local', 'LOCAL_DATABASE_NAME_REQUIRED');

  const connection = new URL(String(runtime.ownerDatabaseUrl || runtime.databaseUrl || ''));
  assert.equal(connection.hostname, '127.0.0.1', 'LOCAL_DATABASE_URL_HOST_REQUIRED');
  assert.equal(connection.port, '54322', 'LOCAL_DATABASE_URL_PORT_REQUIRED');
  assert.equal(connection.pathname, '/zimeiti_local', 'LOCAL_DATABASE_URL_NAME_REQUIRED');

  const migrationPath = path.resolve('supabase/migrations', MIGRATION_FILE);
  const sql = await readFile(migrationPath, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.read_image_model_publication_state\(p_model_id text DEFAULT NULL\)/u);
  assert.match(sql, /catalog_visibility'='visible_disabled'/u);
  assert.doesNotMatch(sql, /CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+|TRUNCATE\s+|DELETE\s+FROM|UPDATE\s+|INSERT\s+INTO/iu, 'MIGRATION_SCOPE_EXCEEDS_FUNCTION_REPLACEMENT');
  const body = migrationBody(sql);
  const migrationHash = sha256(sql);
  const evidenceDir = path.resolve('.codex-evidence/gpt-image2-three-groups-live/local-function-migration');
  await mkdir(evidenceDir, { recursive: true });

  const client = new pg.Client({
    connectionString: connection.toString(),
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  let transactionOpen = false;
  try {
    const identity = (await client.query(
      'SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port',
    )).rows[0];
    assert.equal(identity.database_name, 'zimeiti_local');
    assert.ok(/^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === '::1');
    assert.equal(Number(identity.server_port), 54322);

    const beforeDefinition = String((await client.query(
      `SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`,
    )).rows[0]?.definition || '');
    assert.ok(beforeDefinition, 'PUBLICATION_FUNCTION_SNAPSHOT_MISSING');
    const beforeDefinitionHash = sha256(beforeDefinition);
    const beforeCatalog = (await client.query(
      'SELECT public.read_image_model_publication_state(NULL::text) AS catalog',
    )).rows[0]?.catalog || [];
    const beforeCatalogIds = beforeCatalog.map((entry) => String(entry?.model?.id || '')).filter(Boolean);
    const beforeBackupPath = path.join(evidenceDir, 'read_image_model_publication_state.before.sql');
    await writeFile(beforeBackupPath, beforeDefinition, 'utf8');

    await client.query('BEGIN');
    transactionOpen = true;
    await client.query('SELECT pg_advisory_xact_lock($1)', ['260830500011']);
    const priorLedger = await client.query(
      'SELECT version, hash FROM supabase_migrations.schema_migrations WHERE version::text=$1',
      [VERSION],
    );
    if (priorLedger.rowCount) {
      assert.equal(String(priorLedger.rows[0].hash || ''), migrationHash, 'MIGRATION_LEDGER_HASH_CONFLICT');
    } else {
      await client.query(body);
      await client.query(
        `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [VERSION, 'image_visible_disabled_catalog', [MIGRATION_FILE], migrationHash, 'codex-local-image-catalog'],
      );
    }

    const afterDefinition = String((await client.query(
      `SELECT pg_get_functiondef('${FUNCTION_SIGNATURE}'::regprocedure) AS definition`,
    )).rows[0]?.definition || '');
    assert.match(
      afterDefinition,
      /api_protocol_config\s*->>\s*'catalog_visibility'(?:\s*::\s*text)?\s*=\s*'visible_disabled'(?:\s*::\s*text)?/iu,
    );
    const afterCatalog = (await client.query(
      'SELECT public.read_image_model_publication_state(NULL::text) AS catalog',
    )).rows[0]?.catalog || [];
    const afterCatalogIds = afterCatalog.map((entry) => String(entry?.model?.id || '')).filter(Boolean);
    for (const modelId of EXPECTED_DISABLED_IDS) {
      assert.ok(afterCatalogIds.includes(modelId), `VISIBLE_DISABLED_MODEL_MISSING:${modelId}`);
    }
    const modelRows = (await client.query(
      `SELECT id, is_active, is_hidden, api_protocol_config->>'catalog_visibility' AS catalog_visibility
       FROM public.cover_models WHERE id = ANY($1::text[]) ORDER BY id`,
      [EXPECTED_DISABLED_IDS],
    )).rows;
    assert.equal(modelRows.length, EXPECTED_DISABLED_IDS.length, 'EXPECTED_DISABLED_MODEL_ROWS_MISSING');
    for (const row of modelRows) {
      assert.equal(row.is_active, false, `DISABLED_MODEL_MUST_STAY_INACTIVE:${row.id}`);
      assert.equal(row.is_hidden, false, `VISIBLE_DISABLED_MODEL_MUST_NOT_BE_HIDDEN:${row.id}`);
      assert.equal(row.catalog_visibility, 'visible_disabled', `CATALOG_VISIBILITY_MISMATCH:${row.id}`);
    }

    const ledger = (await client.query(
      'SELECT version,name,hash,applied_by,applied_at FROM supabase_migrations.schema_migrations WHERE version::text=$1',
      [VERSION],
    )).rows[0];
    assert.equal(String(ledger.hash), migrationHash, 'MIGRATION_LEDGER_WRITE_FAILED');
    await client.query("NOTIFY pgrst, 'reload schema'");
    await client.query('COMMIT');
    transactionOpen = false;

    const summary = {
      ok: true,
      localRuntimeOnly: true,
      database: identity.database_name,
      serverAddress: identity.server_address,
      serverPort: identity.server_port,
      migration: MIGRATION_FILE,
      migrationHash,
      changedObject: FUNCTION_SIGNATURE,
      beforeDefinitionHash,
      afterDefinitionHash: sha256(afterDefinition),
      beforeCatalogCount: beforeCatalogIds.length,
      afterCatalogCount: afterCatalogIds.length,
      newlyVisibleIds: afterCatalogIds.filter((id) => !beforeCatalogIds.includes(id)),
      visibleDisabledModels: modelRows,
      generationGatePreserved: modelRows.every((row) => row.is_active === false),
      backupPath: beforeBackupPath,
      backupHash: sha256(await readFile(beforeBackupPath)),
      ledger: {
        version: ledger.version,
        name: ledger.name,
        hash: ledger.hash,
        appliedBy: ledger.applied_by,
        appliedAt: ledger.applied_at,
      },
      providerRequests: 0,
      paidModelCalls: 0,
      credentialsPrinted: false,
    };
    const summaryPath = path.join(evidenceDir, 'summary.json');
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(JSON.stringify({ ...summary, summaryPath }, null, 2));
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    databaseWrites: 0,
    providerRequests: 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }));
  process.exitCode = 1;
});
