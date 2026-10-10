#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { captureSemanticSnapshot } from "./lib/database-semantic-catalog.mjs";

const root = path.resolve(import.meta.dirname, "..");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const rollbackPath = path.join(
  root,
  "supabase/rollbacks/20261009053000_platform_brand_contact_qr.rollback.sql",
);
const rollback = (await readFile(rollbackPath, "utf8"))
  .replace(/^\uFEFF/u, "")
  .replace(/^\s*BEGIN\s*;\s*/iu, "")
  .replace(/\s*COMMIT\s*;\s*$/iu, "");
const client = new pg.Client({
  host: "127.0.0.1",
  port: 54322,
  database: "zimeiti_local",
  user: "postgres",
  password: String(runtime.postgresPassword),
  application_name: "codex-platform-brand-contact-qr-rollback-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});
const suffix = randomUUID().replaceAll("-", "");
const checks = [];
const check = (name, condition, evidence) => {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) });
};

async function expectGuard(savepoint, setupSql, parameters) {
  await client.query(`SAVEPOINT ${savepoint}`);
  await client.query(setupSql, parameters);
  let error;
  try {
    await client.query(rollback);
  } catch (caught) {
    error = caught;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  check(
    `${savepoint} blocks the destructive rollback`,
    error?.code === "55000"
      && error?.message === "ROLLBACK_BLOCKED_PLATFORM_BRAND_CONTACT_QR_DATA_EXISTS",
    { code: error?.code, message: error?.message },
  );
}

await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query(
    "SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port",
  )).rows[0];
  assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });
  const baseline = await captureSemanticSnapshot(client);
  const relatedData = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.platform_brand_revisions
        WHERE snapshot ? 'contact'
           OR coalesce(snapshot->'assetIds', '{}'::jsonb) ?| ARRAY[
             'contact_wechat_qr_primary', 'contact_wechat_qr_secondary'
           ]) AS revisions,
      (SELECT count(*)::integer FROM public.platform_brand_assets
        WHERE purpose IN ('contact_wechat_qr_primary', 'contact_wechat_qr_secondary')) AS assets,
      (SELECT count(*)::integer FROM public.platform_brand_revision_assets
        WHERE purpose IN ('contact_wechat_qr_primary', 'contact_wechat_qr_secondary')) AS mappings
  `)).rows[0];
  const protectedDataPresent = Object.values(relatedData).some((value) => Number(value) > 0);

  if (protectedDataPresent) {
    await client.query("BEGIN");
    transactionOpen = true;
    let guardError;
    try {
      await client.query(rollback);
    } catch (caught) {
      guardError = caught;
    }
    check(
      "existing contact and QR data blocks the destructive schema rollback",
      guardError?.code === "55000"
        && guardError?.message === "ROLLBACK_BLOCKED_PLATFORM_BRAND_CONTACT_QR_DATA_EXISTS",
      { relatedData, code: guardError?.code, message: guardError?.message },
    );
    await client.query("ROLLBACK");
    transactionOpen = false;
    const finalSnapshot = await captureSemanticSnapshot(client);
    check("guard-only rehearsal preserves the baseline semantic snapshot",
      finalSnapshot.sha256 === baseline.sha256,
      { baseline: baseline.sha256, restored: finalSnapshot.sha256 });
    console.log(JSON.stringify({
      status: "PASS",
      target: "127.0.0.1:54322/zimeiti_local",
      mode: "protected-data-guard-only",
      destructiveRollbackSkipped: true,
      persisted: false,
      checks,
    }, null, 2));
  } else {

  await client.query("BEGIN");
  transactionOpen = true;
  await expectGuard("contact_guard_probe", `
    INSERT INTO public.platform_brand_revisions (
      profile_id, revision_version, status, snapshot, snapshot_sha256, created_by
    )
    SELECT 'default', coalesce(max(revision_version), 0) + 1, 'draft', $1::jsonb,
           repeat('0', 64), $2::uuid
      FROM public.platform_brand_revisions
     WHERE profile_id = 'default'
  `, [JSON.stringify({
    schema: "platform-brand/v1",
    name: "Rollback guard fixture",
    shortName: "fixture",
    slogan: "",
    welcomeMessage: "",
    description: "",
    seo: { title: "", description: "" },
    colors: { primary: "#000000", accent: "#FFFFFF" },
    contact: { name: "", wechat: "", phone: "", email: "" },
    assetIds: {},
  }), randomUUID()]);
  await expectGuard("qr_asset_guard_probe", `
    INSERT INTO public.platform_brand_assets (
      profile_id, purpose, storage_provider, storage_key, sha256,
      mime_type, bytes, width, height, created_by
    ) VALUES (
      'default', 'contact_wechat_qr_secondary', 'local', $1,
      repeat('1', 64), 'image/png', 1, 16, 16, $2::uuid
    )
  `, [`rollback-guard-fixture/${suffix}.png`, randomUUID()]);

  await client.query(rollback);
  const restored = (await client.query(`
    SELECT
      to_regclass('public.platform_brand_profiles') IS NOT NULL AS profiles_preserved,
      to_regclass('public.platform_brand_revisions') IS NOT NULL AS revisions_preserved,
      to_regclass('public.platform_brand_assets') IS NOT NULL AS assets_preserved,
      to_regclass('public.platform_brand_revision_assets') IS NOT NULL AS mappings_preserved,
      to_regclass('public.platform_brand_events') IS NOT NULL AS events_preserved,
      pg_get_constraintdef((
        SELECT oid FROM pg_constraint
         WHERE conrelid = 'public.platform_brand_revisions'::regclass
           AND conname = 'platform_brand_revisions_snapshot_check'
      )) AS snapshot_constraint,
      pg_get_constraintdef((
        SELECT oid FROM pg_constraint
         WHERE conrelid = 'public.platform_brand_assets'::regclass
           AND conname = 'platform_brand_assets_purpose_check'
      )) AS asset_constraint,
      pg_get_constraintdef((
        SELECT oid FROM pg_constraint
         WHERE conrelid = 'public.platform_brand_revision_assets'::regclass
           AND conname = 'platform_brand_revision_assets_purpose_check'
      )) AS mapping_constraint,
      pg_get_functiondef('public.save_platform_brand_draft_atomic(bigint,jsonb,text,uuid,text)'::regprocedure) AS save_function,
      pg_get_functiondef('public.register_platform_brand_asset_atomic(text,text,text,text,text,bigint,integer,integer,uuid,text)'::regprocedure) AS register_function
  `)).rows[0];
  check("rollback preserves the complete platform-brand control plane",
    restored.profiles_preserved && restored.revisions_preserved && restored.assets_preserved
      && restored.mappings_preserved && restored.events_preserved);
  for (const [name, definition] of [
    ["snapshot constraint", restored.snapshot_constraint],
    ["asset purpose constraint", restored.asset_constraint],
    ["revision-asset purpose constraint", restored.mapping_constraint],
    ["save function", restored.save_function],
    ["register function", restored.register_function],
  ]) {
    check(`${name} rejects 0530 contact/QR semantics`,
      !definition.includes("contact_wechat_qr_primary")
        && !definition.includes("contact_wechat_qr_secondary")
        && (name !== "snapshot constraint" || !definition.includes("'contact'")));
  }

  await client.query("ROLLBACK");
  transactionOpen = false;
  const finalSnapshot = await captureSemanticSnapshot(client);
  check("outer rollback restores the baseline semantic snapshot",
    finalSnapshot.sha256 === baseline.sha256,
    { baseline: baseline.sha256, restored: finalSnapshot.sha256 });
  console.log(JSON.stringify({
    status: "PASS",
    target: "127.0.0.1:54322/zimeiti_local",
    mode: "clean-fixture-full-rollback",
    destructiveRollbackSkipped: false,
    persisted: false,
    checks,
  }, null, 2));
  }
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end().catch(() => undefined);
}
