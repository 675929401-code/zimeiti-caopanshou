#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import pg from "pg";

const { Client } = pg;
const outputRootIndex = process.argv.indexOf("--output-root");
const outputRoot = outputRootIndex >= 0 ? path.resolve(process.argv[outputRootIndex + 1] || "") : "";
const databaseUrl = String(process.env.DEPLOY_DATABASE_URL || "").trim();
const postgresToolRoot = String(process.env.ZIMEITI_PG_BIN || "").trim();

function redactDiagnostic(value) {
  let redacted = String(value || "");
  if (databaseUrl) redacted = redacted.replaceAll(databaseUrl, "[REDACTED_DATABASE_REFERENCE]");
  return redacted.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[REDACTED_DATABASE_REFERENCE]");
}

process.on("uncaughtException", error => {
  console.error(`POSTGRES_BACKUP_FAILED:${redactDiagnostic(error instanceof Error ? error.message : error).slice(0, 1000)}`);
  process.exit(1);
});
process.on("unhandledRejection", error => {
  console.error(`POSTGRES_BACKUP_FAILED:${redactDiagnostic(error instanceof Error ? error.message : error).slice(0, 1000)}`);
  process.exit(1);
});

if (!outputRoot || !fs.existsSync(outputRoot)) throw new Error("POSTGRES_BACKUP_OUTPUT_ROOT_REQUIRED");
if (!databaseUrl) throw new Error("DEPLOY_DATABASE_URL_REQUIRED");

const postgresDirectory = path.join(outputRoot, "postgres");
const auditDirectory = path.join(outputRoot, "audits");
if (!fs.statSync(postgresDirectory).isDirectory() || !fs.statSync(auditDirectory).isDirectory()) {
  throw new Error("POSTGRES_BACKUP_OUTPUT_DIRECTORIES_REQUIRED");
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function buildLibpqEnvironment(connectionString) {
  const parsed = new URL(connectionString);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DEPLOY_DATABASE_URL_PROTOCOL_INVALID");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!parsed.hostname || !databaseName || !parsed.username) {
    throw new Error("DEPLOY_DATABASE_URL_COMPONENTS_REQUIRED");
  }

  const environment = {
    ...process.env,
    PGHOST: parsed.hostname.replace(/^\[(.*)\]$/u, "$1"),
    PGPORT: parsed.port || "5432",
    PGDATABASE: databaseName,
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
  for (const parameter of ["sslmode", "connect_timeout", "target_session_attrs", "application_name", "options"]) {
    const value = parsed.searchParams.get(parameter);
    if (value) environment[`PG${parameter.toUpperCase()}`] = value;
  }
  return environment;
}

const libpqEnvironment = buildLibpqEnvironment(databaseUrl);

function postgresCommand(name) {
  if (!postgresToolRoot) return name;
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidate = path.join(postgresToolRoot, executable);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    throw new Error(`POSTGRES_TOOL_MISSING:${name}`);
  }
  return candidate;
}

function run(commandName, args) {
  const command = postgresCommand(commandName);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    env: libpqEnvironment,
  });
  if (result.status !== 0) {
    const diagnostic = redactDiagnostic(
      result.stderr || result.stdout || result.error?.message || `exit=${String(result.status)}`,
    ).trim().slice(0, 1000);
    throw new Error(`${commandName.toUpperCase()}_FAILED:${diagnostic}`);
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const client = new Client({
  connectionString: databaseUrl,
  application_name: "zimeiti-consistent-encrypted-backup",
  statement_timeout: 0,
  query_timeout: 0,
});

const startedEpoch = Math.floor(Date.now() / 1000);
await client.connect();
let transactionOpen = false;
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  transactionOpen = true;
  const snapshotResult = await client.query("SELECT pg_export_snapshot() AS snapshot");
  const snapshot = String(snapshotResult.rows[0]?.snapshot || "");
  if (!/^[A-Za-z0-9._:-]+$/u.test(snapshot)) throw new Error("POSTGRES_EXPORTED_SNAPSHOT_INVALID");

  run("pg_dump", [
    "--format=custom",
    "--compress=9",
    "--no-owner",
    "--no-acl",
    `--snapshot=${snapshot}`,
    `--file=${path.join(postgresDirectory, "database.dump")}`,
  ]);
  run("pg_dump", [
    "--schema-only",
    "--format=plain",
    "--no-owner",
    "--no-acl",
    `--snapshot=${snapshot}`,
    `--file=${path.join(postgresDirectory, "schema.sql")}`,
  ]);
  run("pg_dumpall", [
    "--globals-only",
    "--no-role-passwords",
    `--file=${path.join(postgresDirectory, "globals.sql")}`,
  ]);

  const identity = await client.query(`
    SELECT current_setting('server_version') AS server_version,
           current_database() AS database_name,
           current_user AS database_user,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
  `);
  writeJson(path.join(postgresDirectory, "version.json"), {
    serverVersion: identity.rows[0]?.server_version,
    database: identity.rows[0]?.database_name,
    databaseUser: identity.rows[0]?.database_user,
    systemIdentifier: identity.rows[0]?.system_identifier,
    schema: "all-non-system",
    exportedSnapshot: snapshot,
  });

  const tables = await client.query(
    "SELECT schemaname,tablename FROM pg_tables WHERE schemaname <> 'information_schema' AND schemaname !~ '^pg_' ORDER BY schemaname,tablename",
  );
  const rowCounts = {};
  for (const table of tables.rows) {
    const schema = String(table.schemaname);
    const name = String(table.tablename);
    const result = await client.query(`SELECT count(*)::text AS count FROM ${quoteIdentifier(schema)}.${quoteIdentifier(name)}`);
    rowCounts[`${schema}.${name}`] = String(result.rows[0]?.count || "0");
  }
  writeJson(path.join(auditDirectory, "postgres-row-counts.json"), rowCounts);

  const financial = await client.query(`
    SELECT jsonb_build_object(
      'users', (SELECT count(*)::text FROM public.users),
      'creditsBalance', (SELECT coalesce(sum(credits),0)::text FROM public.users),
      'cashBalance', (SELECT coalesce(sum(cash_balance),0)::text FROM public.users),
      'creditsReserved', (SELECT coalesce(sum(credits_reserved),0)::text FROM public.users),
      'creditTransactions', (SELECT count(*)::text FROM public.credit_transactions),
      'creditTransactionAmount', (SELECT coalesce(sum(amount),0)::text FROM public.credit_transactions),
      'cashTransactions', (SELECT count(*)::text FROM public.cash_transactions),
      'cashTransactionAmount', (SELECT coalesce(sum(amount),0)::text FROM public.cash_transactions),
      'walletLedgerEntries', (SELECT count(*)::text FROM public.wallet_ledger_entries),
      'walletLedgerDelta', (SELECT coalesce(sum(delta),0)::text FROM public.wallet_ledger_entries),
      'paymentOrders', (SELECT count(*)::text FROM public.payment_orders),
      'paymentOrderAmount', (SELECT coalesce(sum(amount),0)::text FROM public.payment_orders)
    ) AS evidence
  `);
  writeJson(path.join(auditDirectory, "postgres-financial-check.json"), financial.rows[0]?.evidence || {});
  const completedEpoch = Math.floor(Date.now() / 1000);
  const evidenceFiles = [
    path.join(postgresDirectory, "database.dump"),
    path.join(postgresDirectory, "schema.sql"),
    path.join(postgresDirectory, "version.json"),
    path.join(auditDirectory, "postgres-row-counts.json"),
    path.join(auditDirectory, "postgres-financial-check.json"),
  ];
  const evidenceSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(evidenceFiles.map(file => ({ name: path.basename(file), sha256: sha256(file) }))))
    .digest("hex");
  writeJson(path.join(auditDirectory, "postgres-component-snapshot.json"), {
    schemaVersion: "zimeiti-postgres-component-snapshot.v1",
    componentSnapshot: {
      component: "postgresql",
      method: "exported-repeatable-read-snapshot",
      startedEpoch,
      completedEpoch,
      consistency: "verified",
      sharedWithOtherComponents: false,
      evidenceSha256,
    },
  });
  await client.query("COMMIT");
  transactionOpen = false;
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
