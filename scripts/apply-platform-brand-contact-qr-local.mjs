#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261009053000";
const NAME = "platform_brand_contact_qr";
const MIGRATION_FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--apply"), "APPLY_FLAG_REQUIRED");
assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-brand-contact-qr"), "LOCAL_BRAND_CONTACT_QR_CONFIRMATION_REQUIRED");

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const runtime = JSON.parse((await readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const migrationPath = path.resolve("supabase/migrations", MIGRATION_FILE);
const migrationSourceRaw = (await readFile(migrationPath, "utf8")).replace(/^\uFEFF/u, "");
const migrationSource = migrationSourceRaw.trim();
// The release manifest hashes the exact committed bytes. An earlier local-only
// runner trimmed surrounding whitespace before hashing, which produced a
// semantically-correct but release-incompatible ledger value. Keep that legacy
// digest only as an explicitly verified one-time reconciliation input.
const migrationHash = sha256(migrationSourceRaw);
const legacyTrimmedHash = sha256(migrationSource);
assert.match(migrationSource, /contact_wechat_qr_primary/u);
assert.match(migrationSource, /contact_wechat_qr_secondary/u);
assert.doesNotMatch(migrationSource, /^\s*(?:BEGIN|COMMIT)\s*;/imu, "MIGRATION_MUST_BE_WRAPPED_BY_RUNNER");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-local-platform-brand-contact-qr",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS database_name, inet_server_addr()::text AS server_address, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local", "LIVE_DATABASE_NAME_MISMATCH");
  assert.equal(Number(identity.server_port), 54322, "LIVE_DATABASE_PORT_MISMATCH");
  assert.ok(
    /^127\.0\.0\.1(?:\/32)?$/u.test(String(identity.server_address)) || identity.server_address === "::1",
    "LIVE_DATABASE_HOST_MISMATCH",
  );

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`platform-brand-contact-qr:${VERSION}`]);
  const prior = await client.query(
    "SELECT version,hash FROM supabase_migrations.schema_migrations WHERE version::text=$1",
    [VERSION],
  );
  let reconciledLegacyHash = false;
  if (prior.rowCount) {
    const recordedHash = String(prior.rows[0].hash || "");
    assert.ok(
      recordedHash === migrationHash || recordedHash === legacyTrimmedHash,
      "MIGRATION_LEDGER_HASH_CONFLICT",
    );
    if (recordedHash === legacyTrimmedHash && recordedHash !== migrationHash) {
      const reconciled = await client.query(
        `UPDATE supabase_migrations.schema_migrations
            SET hash=$2,name=$3,statements=$4,applied_by=$5,applied_at=now()
          WHERE version::text=$1 AND hash=$6`,
        [
          VERSION,
          migrationHash,
          NAME,
          [MIGRATION_FILE],
          "codex-local-platform-brand-contact-qr-hash-reconcile",
          legacyTrimmedHash,
        ],
      );
      assert.equal(reconciled.rowCount, 1, "MIGRATION_LEDGER_HASH_RECONCILE_CONFLICT");
      reconciledLegacyHash = true;
    }
  } else {
    await client.query(migrationSource);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [MIGRATION_FILE], migrationHash, "codex-local-platform-brand-contact-qr"],
    );
  }

  const constraint = await client.query(`
    SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid='public.platform_brand_revisions'::regclass
       AND conname='platform_brand_revisions_snapshot_check'
  `);
  assert.equal(constraint.rowCount, 1, "PLATFORM_BRAND_SNAPSHOT_CONSTRAINT_REQUIRED");
  assert.match(String(constraint.rows[0].definition), /contact_wechat_qr_primary/u);
  assert.match(String(constraint.rows[0].definition), /contact_wechat_qr_secondary/u);

  const functions = await client.query(`
    SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public'
       AND p.proname = ANY($1::text[])
  `, [["save_platform_brand_draft_atomic", "register_platform_brand_asset_atomic"]]);
  assert.equal(functions.rowCount, 2, "PLATFORM_BRAND_FUNCTIONS_REQUIRED");
  for (const row of functions.rows) {
    assert.match(String(row.definition), /contact_wechat_qr_primary/u, `${row.proname}:PRIMARY_QR_MISSING`);
    assert.match(String(row.definition), /contact_wechat_qr_secondary/u, `${row.proname}:SECONDARY_QR_MISSING`);
  }

  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.query("COMMIT");
  transactionOpen = false;

  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    action: reconciledLegacyHash ? "ledger_hash_reconciled" : prior.rowCount ? "already_applied" : "applied",
    migration: MIGRATION_FILE,
    migrationHash,
    productionWrites: 0,
    credentialsPrinted: false,
  };
  const evidenceDir = path.resolve(".codex-evidence", "platform-brand-contact-qr");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "local-apply.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
