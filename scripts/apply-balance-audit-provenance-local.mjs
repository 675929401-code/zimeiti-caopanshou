#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const VERSION = "20261001012000";
const NAME = "balance_audit_provenance";
const FILE = `${VERSION}_${NAME}.sql`;
const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-billing-audit"), "LOCAL_BILLING_AUDIT_CONFIRMATION_REQUIRED");
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const source = await fs.readFile(path.resolve("supabase/migrations", FILE), "utf8");
const normalized = source.replace(/^\uFEFF/u, "").trim();
assert.match(normalized, /^BEGIN\s*;/u);
assert.match(normalized, /COMMIT\s*;\s*$/u);
assert.match(normalized, /balance_audit_source_facets/u);
assert.match(normalized, /ip_address/u);
assert.doesNotMatch(normalized, /UPDATE\s+public\.balance_audit_log/iu);
assert.doesNotMatch(normalized, /DELETE\s+FROM\s+public\.balance_audit_log/iu);
const body = normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
const hash = crypto.createHash("sha256").update(source).digest("hex");
const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-balance-audit-provenance",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('balance-audit-provenance:20261001012000',0))");
  const prior = await client.query("SELECT hash FROM supabase_migrations.schema_migrations WHERE version::text=$1", [VERSION]);
  let action = "already_applied";
  if (prior.rowCount) {
    assert.equal(String(prior.rows[0].hash || ""), hash, "MIGRATION_LEDGER_HASH_CONFLICT");
  } else {
    await client.query(body);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations(version,name,statements,hash,applied_by,applied_at)
       VALUES($1,$2,$3,$4,$5,now())`,
      [VERSION, NAME, [FILE], hash, "codex-local-billing-audit"],
    );
    action = "applied";
  }
  const columns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='balance_audit_log'
       AND column_name IN ('ip_address','context') ORDER BY column_name`,
  );
  assert.deepEqual(columns.rows.map((row) => row.column_name), ["context", "ip_address"]);
  const facets = await client.query("SELECT * FROM public.balance_audit_source_facets()");
  const total = facets.rows.reduce((sum, row) => sum + Number(row.record_count || 0), 0);
  const auditCount = Number((await client.query("SELECT count(*) AS count FROM public.balance_audit_log")).rows[0]?.count || 0);
  assert.equal(total, auditCount, "SOURCE_FACET_COUNT_MISMATCH");
  await client.query("COMMIT");
  console.log(JSON.stringify({
    passed: true,
    migration: FILE,
    hash,
    action,
    observedRawSources: facets.rows,
    auditRows: auditCount,
    productionWrites: 0,
  }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
