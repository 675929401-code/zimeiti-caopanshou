#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";
import {
  DATABASE_SEMANTIC_PROFILE,
  captureSemanticSnapshot,
  sha256,
  stableJson,
} from "./lib/database-semantic-catalog.mjs";

const { Client } = pg;
const root = path.resolve(import.meta.dirname, "..");
const write = process.argv.includes("--write");
const rebindManifestOnly = process.argv.includes("--rebind-manifest-only");
const selfTestRebind = process.argv.includes("--self-test-rebind-manifest");
const contractPath = path.join(root, "deploy/policies/database-semantic-contract.v1.json");
const migrationName = "20261009054000_white_label_runtime_publish.sql";
const migrationPath = path.join(root, "supabase/migrations", migrationName);

if (selfTestRebind) {
  assert.deepEqual(process.argv.slice(2), ["--self-test-rebind-manifest"], "SELF_TEST_ACCEPTS_NO_OTHER_ARGUMENTS");
} else if (rebindManifestOnly) {
  assert.deepEqual(
    [...process.argv.slice(2)].sort(),
    ["--rebind-manifest-only", "--write"].sort(),
    "MANIFEST_REBIND_REQUIRES_EXACT_FLAGS",
  );
} else if (!write) {
  throw new Error("TRANSACTIONAL_SEMANTIC_REFRESH_REQUIRES_WRITE_FLAG");
}

function extractJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("DATABASE_PLAN_JSON_MISSING");
  return JSON.parse(output.slice(start, end + 1));
}

function contractDigest(value) {
  const core = { ...value };
  delete core.contractSha256;
  return sha256(stableJson(core));
}

function changedTopLevelKeys(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => stableJson(before[key]) !== stableJson(after[key]))
    .sort();
}

function rebindSemanticContractManifest(contract, manifestSha256) {
  assert.match(manifestSha256, /^[a-f0-9]{64}$/u, "MIGRATION_MANIFEST_SHA256_REQUIRED");
  assert.equal(contract.contractSha256, contractDigest(contract), "DATABASE_SEMANTIC_CONTRACT_INTEGRITY_FAILED");
  const snapshotBefore = stableJson(contract.snapshot);
  const next = { ...contract, migrationManifestSha256: manifestSha256 };
  next.contractSha256 = contractDigest(next);
  assert.equal(stableJson(next.snapshot), snapshotBefore, "SEMANTIC_SNAPSHOT_DRIFT_FORBIDDEN");
  const changedKeys = changedTopLevelKeys(contract, next);
  const expectedChanges = contract.migrationManifestSha256 === manifestSha256
    ? []
    : ["contractSha256", "migrationManifestSha256"];
  assert.deepEqual(changedKeys, expectedChanges, "UNEXPECTED_SEMANTIC_CONTRACT_REBIND_DIFFERENCE");
  return { next, changedKeys, snapshotSha256: contract.snapshot?.sha256 || null };
}

function migrationPlan() {
  const planResult = spawnSync(process.execPath, ["scripts/db-migration-release.mjs", "plan"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_DATABASE_URL: "", SUPABASE_DATABASE_URL: "", DATABASE_URL: "", POSTGRES_URL: "" },
  });
  if (planResult.error || planResult.status !== 0) {
    throw new Error(`DATABASE_PLAN_FAILED:${planResult.error?.message || planResult.stderr || planResult.stdout}`);
  }
  const plan = extractJson(planResult.stdout);
  assert.equal(plan.databaseWrites, 0, "DATABASE_PLAN_MUST_BE_READ_ONLY");
  assert.match(plan.manifestSha256, /^[a-f0-9]{64}$/u, "MIGRATION_MANIFEST_SHA256_REQUIRED");
  return plan;
}

if (selfTestRebind) {
  const fixtureCore = {
    schemaVersion: 1,
    kind: "database-semantic-contract",
    profile: DATABASE_SEMANTIC_PROFILE,
    generatedAt: "2026-10-10T00:00:00.000Z",
    sourceLabel: "fixture-source-must-remain",
    sourceDatabase: "fixture_database",
    migrationManifestSha256: "a".repeat(64),
    extraObjectPolicy: "structural extras warn; privilege extras block",
    snapshot: { sha256: "b".repeat(64), sections: { functions: { rows: 1, sha256: "c".repeat(64), entries: [] } } },
  };
  const fixture = { ...fixtureCore, contractSha256: contractDigest(fixtureCore) };
  const rebound = rebindSemanticContractManifest(fixture, "d".repeat(64));
  assert.equal(rebound.next.generatedAt, fixture.generatedAt);
  assert.equal(rebound.next.sourceLabel, fixture.sourceLabel);
  assert.equal(stableJson(rebound.next.snapshot), stableJson(fixture.snapshot));
  assert.deepEqual(rebound.changedKeys, ["contractSha256", "migrationManifestSha256"]);
  const unexpected = { ...rebound.next, sourceLabel: "unexpected-drift" };
  assert.throws(
    () => assert.deepEqual(
      changedTopLevelKeys(fixture, unexpected),
      ["contractSha256", "migrationManifestSha256"],
      "UNEXPECTED_SEMANTIC_CONTRACT_REBIND_DIFFERENCE",
    ),
    /UNEXPECTED_SEMANTIC_CONTRACT_REBIND_DIFFERENCE/u,
  );
  console.log(JSON.stringify({
    passed: true,
    mode: "self-test-rebind-manifest",
    snapshotUnchanged: true,
    generatedAtUnchanged: true,
    sourceLabelUnchanged: true,
    unexpectedDifferenceRejected: true,
    networkRequests: 0,
    databaseConnections: 0,
    databaseWrites: 0,
    filesystemWrites: 0,
  }, null, 2));
  process.exit(0);
}

const plan = migrationPlan();

if (rebindManifestOnly) {
  const existing = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  const rebound = rebindSemanticContractManifest(existing, plan.manifestSha256);
  const action = rebound.changedKeys.length === 0 ? "already-bound" : "manifest-rebound";
  if (action === "manifest-rebound") {
    fs.writeFileSync(contractPath, `${JSON.stringify(rebound.next, null, 2)}\n`, "utf8");
  }
  const readback = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  assert.equal(readback.contractSha256, contractDigest(readback), "DATABASE_SEMANTIC_CONTRACT_REBIND_READBACK_FAILED");
  assert.equal(readback.migrationManifestSha256, plan.manifestSha256, "DATABASE_SEMANTIC_MANIFEST_REBIND_READBACK_FAILED");
  assert.equal(stableJson(readback.snapshot), stableJson(existing.snapshot), "SEMANTIC_SNAPSHOT_DRIFT_FORBIDDEN");
  assert.equal(readback.generatedAt, existing.generatedAt, "SEMANTIC_GENERATED_AT_DRIFT_FORBIDDEN");
  assert.equal(readback.sourceLabel, existing.sourceLabel, "SEMANTIC_SOURCE_LABEL_DRIFT_FORBIDDEN");
  console.log(JSON.stringify({
    passed: true,
    mode: "rebind-manifest-only",
    action,
    contract: path.relative(root, contractPath).split(path.sep).join("/"),
    migrationManifestSha256: plan.manifestSha256,
    contractSha256: readback.contractSha256,
    semanticSnapshotSha256: readback.snapshot.sha256,
    changedKeys: rebound.changedKeys,
    networkRequests: 0,
    databaseConnections: 0,
    databaseWrites: 0,
    filesystemWrites: action === "manifest-rebound" ? 1 : 0,
    paidModelCalls: 0,
    credentialsPrinted: false,
  }, null, 2));
  process.exit(0);
}

const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

assert.ok(plan.migrations.some((entry) => entry.name === migrationName), "0540_MIGRATION_MISSING_FROM_PLAN");

const migration = (await readFile(migrationPath, "utf8"))
  .replace(/^\uFEFF/u, "")
  .replace(/^\s*BEGIN\s*;\s*/iu, "")
  .replace(/\s*COMMIT\s*;\s*$/iu, "");
const client = new Client({
  host: "127.0.0.1",
  port: 54322,
  database: "zimeiti_local",
  user: "postgres",
  password: String(runtime.postgresPassword),
  application_name: "codex-semantic-contract-transactional-refresh",
  connectionTimeoutMillis: 10_000,
  query_timeout: 180_000,
});

let transactionOpen = false;
let baseline;
let expected;
try {
  await client.connect();
  const identity = (await client.query(
    "SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port",
  )).rows[0];
  assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });
  const prerequisite = (await client.query(`
    SELECT
      to_regprocedure('public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text)') IS NOT NULL AS save_brand_v0530,
      to_regprocedure('public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text)') IS NOT NULL AS register_brand_v0530
  `)).rows[0];
  assert.equal(prerequisite.save_brand_v0530, true, "0530_PLATFORM_BRAND_SAVE_RPC_REQUIRED");
  assert.equal(prerequisite.register_brand_v0530, true, "0530_PLATFORM_BRAND_ASSET_RPC_REQUIRED");

  baseline = await captureSemanticSnapshot(client);
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query(migration);
  expected = await captureSemanticSnapshot(client);
  await client.query("ROLLBACK");
  transactionOpen = false;
  const restored = await captureSemanticSnapshot(client);
  assert.equal(restored.sha256, baseline.sha256, "TRANSACTIONAL_PREVIEW_LEFT_DATABASE_DRIFT");
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end().catch(() => undefined);
}

const core = {
  schemaVersion: 1,
  kind: "database-semantic-contract",
  profile: DATABASE_SEMANTIC_PROFILE,
  generatedAt: new Date().toISOString(),
  sourceLabel: `reviewed-local-transactional-preview:${migrationName}`,
  sourceDatabase: "zimeiti_local",
  migrationManifestSha256: plan.manifestSha256,
  extraObjectPolicy: "structural extras warn; privilege extras block",
  snapshot: expected,
};
const contract = { ...core, contractSha256: contractDigest(core) };
fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  passed: true,
  mode: "transactional-semantic-refresh",
  contract: path.relative(root, contractPath).split(path.sep).join("/"),
  migration: migrationName,
  migrationManifestSha256: plan.manifestSha256,
  contractSha256: contract.contractSha256,
  snapshotSha256: contract.snapshot.sha256,
  baselineRestoredSha256: baseline.sha256,
  sections: Object.fromEntries(Object.entries(contract.snapshot.sections).map(([name, value]) => [name, value.rows])),
  databaseWrites: 0,
  migrationLedgerWrites: 0,
  productionWrites: 0,
  paidModelCalls: 0,
  credentialsPrinted: false,
}, null, 2));
