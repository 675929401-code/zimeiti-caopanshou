#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20260930232500";
const NAME = "offline_payment_receipt_immutability";
const FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-offline-payment-immutability"), "LOCAL_OFFLINE_PAYMENT_IMMUTABILITY_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
assert.match(normalized, /OFFLINE_PAYMENT_RECEIPT_IMMUTABLE/u);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const migrationHash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-local-offline-payment-immutability", connectionTimeoutMillis: 10_000, query_timeout: 120_000 });

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query("SELECT current_database() AS db,inet_server_port() AS port")).rows[0];
  assert.equal(identity.db, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SELECT pg_advisory_xact_lock($1)", [260930232500]);
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), migrationHash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], migrationHash, "codex-local-offline-payment-immutability"],
    );
    action = "applied";
  }
  const trigger = (await client.query(
    `SELECT tgname FROM pg_trigger JOIN pg_class ON pg_class.oid=pg_trigger.tgrelid
     JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
     WHERE pg_namespace.nspname='public' AND pg_class.relname='offline_payment_receipts'
       AND tgname='offline_payment_receipt_immutability_guard' AND NOT tgisinternal`,
  )).rows[0];
  assert.equal(trigger?.tgname, "offline_payment_receipt_immutability_guard", "IMMUTABILITY_TRIGGER_REQUIRED");
  const privileges = (await client.query(
    `SELECT
       has_table_privilege('service_role','public.offline_payment_receipts','SELECT') AS can_select,
       has_table_privilege('service_role','public.offline_payment_receipts','INSERT') AS can_insert,
       has_table_privilege('service_role','public.offline_payment_receipts','UPDATE') AS can_update,
       has_table_privilege('service_role','public.offline_payment_receipts','DELETE') AS can_delete`,
  )).rows[0];
  assert.equal(privileges.can_select, true);
  assert.equal(privileges.can_insert, false);
  assert.equal(privileges.can_update, false);
  assert.equal(privileges.can_delete, false);
  await client.query("COMMIT");
  transactionOpen = false;
  const report = { passed: true, checkedAt: new Date().toISOString(), target: "127.0.0.1:54322/zimeiti_local", migration: FILE, migrationHash, action, privileges, productionWrites: 0 };
  const evidenceDir = path.resolve(".codex-evidence", "member-activation-workflow");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "offline-payment-immutability.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
