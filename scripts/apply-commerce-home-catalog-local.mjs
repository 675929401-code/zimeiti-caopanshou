#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const migrations = [
  ["20261124010000", "commerce_home_catalog_entries"],
];
const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";

function bodyOf(source) {
  const normalized = source.replace(/^﻿/u, "").trim();
  assert.match(normalized, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(normalized, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return normalized.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim();
}

assert.ok(process.argv.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
assert.ok(process.argv.includes("--confirm-local-commerce-home-catalog"), "LOCAL_COMMERCE_HOME_CATALOG_CONFIRMATION_REQUIRED");

const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^﻿/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const sources = [];
for (const [version, name] of migrations) {
  const file = `${version}_${name}.sql`;
  const source = await fs.readFile(path.resolve("supabase/migrations", file), "utf8");
  sources.push({ version, name, file, source, hash: crypto.createHash("sha256").update(source).digest("hex") });
}

const client = new pg.Client({ ...runtime.ownerConnection });
await client.connect();
try {
  await client.query("BEGIN");
  for (const entry of sources) {
    await client.query(bodyOf(entry.source));
    console.log(JSON.stringify({ applied: entry.file, sha256: entry.hash }));
  }
  const check = await client.query(
    "SELECT entry_kind, entry_key FROM public.commerce_home_catalog_entries LIMIT 1",
  );
  console.log(JSON.stringify({ tableReady: true, sampleRows: check.rowCount }));
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
