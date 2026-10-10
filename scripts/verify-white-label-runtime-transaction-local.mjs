#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const root = path.resolve(import.meta.dirname, "..");
const runtimePath = process.env.LOCAL_DATA_RUNTIME_PATH
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.host, "127.0.0.1");
assert.equal(Number(runtime.databasePort), 54322);
assert.equal(runtime.databaseName, "zimeiti_local");

const migrationPath = path.join(root, "supabase/migrations/20261009054000_white_label_runtime_publish.sql");
const migration = (await readFile(migrationPath, "utf8"))
  .replace(/^BEGIN;\s*/u, "")
  .replace(/\s*COMMIT;\s*$/u, "");
const rollback = (await readFile(
  path.join(root, "supabase/rollbacks/20261009054000_white_label_runtime_publish.rollback.sql"),
  "utf8",
))
  .replace(/^BEGIN;\s*/u, "")
  .replace(/\s*COMMIT;\s*$/u, "");
const client = new pg.Client({
  host: "127.0.0.1",
  port: 54322,
  database: "zimeiti_local",
  user: "postgres",
  password: String(runtime.postgresPassword),
  application_name: "codex-white-label-runtime-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const suffix = randomUUID().replaceAll("-", "");
const hostname = `runtime-${suffix}.example.cn`;
const actor = `runtime-verifier-${suffix}`;
const key = (name) => `wl-runtime-${name}-${suffix}`;
const checks = [];
const check = (name, condition, evidence) => {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) });
};

await client.connect();
let transactionOpen = false;
let baseline = null;
try {
  const identity = (await client.query(
    "SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port",
  )).rows[0];
  assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });
  baseline = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.white_label_profiles) AS profiles,
      (SELECT count(*)::integer FROM public.white_label_profile_events) AS events,
      (SELECT count(*)::integer FROM public.site_brand_releases) AS site_brand_releases,
      to_regclass('public.white_label_assets') IS NOT NULL AS runtime_assets_present
  `)).rows[0];
  await client.query("BEGIN");
  transactionOpen = true;
  await client.query(migration);
  await client.query("SAVEPOINT rollback_rehearsal");
  await client.query(rollback);
  const rolledBack = (await client.query(`
    SELECT to_regclass('public.white_label_assets') IS NULL AS assets_removed,
           to_regprocedure('public.publish_white_label_draft_atomic(uuid,integer,text,text)') IS NULL AS publish_removed,
           (public.read_white_label_admin_state()->>'schemaVersion')::integer AS restored_schema
  `)).rows[0];
  check("rollback removes runtime objects and restores the v1 admin read contract",
    rolledBack.assets_removed === true
      && rolledBack.publish_removed === true
      && rolledBack.restored_schema === 1,
    rolledBack);
  await client.query("ROLLBACK TO SAVEPOINT rollback_rehearsal");
  await client.query("RELEASE SAVEPOINT rollback_rehearsal");

  const tokenHash = sha256(`token:${suffix}`);
  const baseArgs = [
    null, 0, "运行态客户品牌", "客户品牌", "联系人", "customer_wechat", "", "",
    hostname, hostname, "", `_zimeiti-domain-verification.${hostname}`,
    tokenHash, tokenHash.slice(0, 8), "品牌标语", "品牌说明", {}, actor, key("create"),
  ];
  const created = (await client.query(
    "SELECT public.save_white_label_draft_v2_atomic($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text,$17::jsonb,$18::text,$19::text) AS result",
    baseArgs,
  )).rows[0].result;
  const profileId = created.profileId;
  check("new white-label draft is durable but unpublished", created.revision === 1 && !created.publishedReleaseId, created);

  const asset = (await client.query(
    "SELECT public.register_white_label_asset_atomic($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::integer,$9::integer,$10::integer,$11::text,$12::text) AS result",
    [profileId, 1, "contact_wechat_qr_primary", "local", `white-label-fixture/${suffix}.png`,
      sha256(`asset:${suffix}`), "image/png", 128, 64, 64, actor, key("asset")],
  )).rows[0].result;
  check("asset is owned by the white-label profile", asset.profileId === profileId && asset.replayed === false, asset);

  const saved = (await client.query(
    "SELECT public.save_white_label_draft_v2_atomic($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text,$17::jsonb,$18::text,$19::text) AS result",
    [profileId, 1, "运行态客户品牌", "客户品牌", "联系人", "customer_wechat", "", "",
      hostname, hostname, "", `_zimeiti-domain-verification.${hostname}`,
      tokenHash, tokenHash.slice(0, 8), "品牌标语", "品牌说明",
      { contact_wechat_qr_primary: asset.id }, actor, key("save-asset")],
  )).rows[0].result;
  check("draft references a profile-owned QR asset", saved.revision === 2 && saved.assetIds.contact_wechat_qr_primary === asset.id);

  const verified = (await client.query(
    "SELECT public.record_white_label_domain_verification($1::uuid,$2::integer,true,$3::text,$4::text,$5::text,'',$6::text,$7::text) AS result",
    [profileId, 2, sha256("observed"), sha256("evidence"), "local-runtime-verifier", actor, key("verify")],
  )).rows[0].result;
  check("DNS ownership verification advances the draft", verified.verified === true && verified.revision === 3);

  const published = (await client.query(
    "SELECT public.publish_white_label_draft_atomic($1::uuid,$2::integer,$3::text,$4::text) AS result",
    [profileId, 3, actor, key("publish")],
  )).rows[0].result;
  check("publication creates distinct published and next-draft releases",
    published.publishedReleaseId !== published.draftReleaseId && published.revision === 4,
    published);

  const publicBrand = (await client.query(
    "SELECT public.read_published_white_label_brand($1::text) AS brand",
    [hostname],
  )).rows[0].brand;
  check("exact Host resolves published brand, contact, wechat and QR",
    publicBrand.source === "white_label"
      && publicBrand.snapshot.name === "运行态客户品牌"
      && publicBrand.snapshot.contact.wechat === "customer_wechat"
      && publicBrand.assets.contact_wechat_qr_primary.id === asset.id,
    { revisionId: publicBrand.revisionId, hostname: publicBrand.hostname });

  const assetSource = (await client.query(
    "SELECT * FROM public.read_published_white_label_asset($1::text,$2::uuid,$3::uuid)",
    [hostname, published.publishedReleaseId, asset.id],
  )).rows[0];
  check("asset read requires exact Host and current published revision",
    assetSource?.id === asset.id && assetSource?.release_id === published.publishedReleaseId);
  const wrongHostAsset = (await client.query(
    "SELECT * FROM public.read_published_white_label_asset($1::text,$2::uuid,$3::uuid)",
    [`other-${hostname}`, published.publishedReleaseId, asset.id],
  )).rows[0];
  check("cross-Host asset read is rejected", wrongHostAsset === undefined);

  const edited = (await client.query(
    "SELECT public.save_white_label_draft_v2_atomic($1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text,$17::jsonb,$18::text,$19::text) AS result",
    [profileId, 4, "尚未发布的新草稿", "新草稿", "新联系人", "new_wechat", "", "",
      hostname, hostname, "", `_zimeiti-domain-verification.${hostname}`,
      tokenHash, tokenHash.slice(0, 8), "新标语", "新说明",
      { contact_wechat_qr_primary: asset.id }, actor, key("edit-draft")],
  )).rows[0].result;
  const stillPublished = (await client.query(
    "SELECT public.read_published_white_label_brand($1::text) AS brand",
    [hostname],
  )).rows[0].brand;
  check("editing the draft cannot mutate the published snapshot",
    edited.revision === 5
      && stillPublished.snapshot.name === "运行态客户品牌"
      && stillPublished.snapshot.contact.wechat === "customer_wechat");

  const unknown = (await client.query(
    "SELECT public.read_published_white_label_brand($1::text) AS brand",
    [`unknown-${hostname}`],
  )).rows[0].brand;
  check("unknown Host has no default white-label fallback", unknown === null);

  await client.query("ROLLBACK");
  transactionOpen = false;
  const report = {
    status: "PASS",
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    persisted: false,
    baseline,
    migrationSha256: sha256(await readFile(migrationPath)),
    rollbackSha256: sha256(await readFile(
      path.join(root, "supabase/rollbacks/20261009054000_white_label_runtime_publish.rollback.sql"),
    )),
    checks,
  };
  const evidenceDir = path.join(root, ".codex-evidence", "white-label-runtime");
  const evidencePath = path.join(evidenceDir, "transaction-rollback-rehearsal.json");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
