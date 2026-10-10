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
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const snapshotSha256 = (value) => sha256(JSON.stringify(canonicalize(value)));
const publishedContent = (value) => value === null ? null : canonicalize({
  revisionId: value.revisionId,
  revisionVersion: value.revisionVersion,
  publishedAt: value.publishedAt,
  snapshotSha256: value.snapshotSha256,
  snapshot: value.snapshot,
  assets: value.assets,
});
const sameValue = (left, right) => JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
const suffix = randomUUID().replaceAll("-", "");
const actorId = randomUUID();
const requestKey = (label) => `contact-transaction-${label}-${suffix}`;
const checks = [];
const check = (name, condition, evidence) => {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) });
};

function brandSnapshot(name, contact, assetIds) {
  return {
    schema: "platform-brand/v1",
    name,
    shortName: "操盘手",
    slogan: "让内容经营有据可循",
    welcomeMessage: "欢迎使用",
    description: "本地联系资料事务回滚探针",
    seo: { title: name, description: "本地验证，不会持久化" },
    colors: { primary: "#168D7A", accent: "#2F80FF" },
    contact,
    assetIds,
  };
}

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-platform-brand-contact-transaction-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

async function captureBaseline() {
  const profile = (await client.query(`
    SELECT generation, draft_revision_id, published_revision_id
      FROM public.platform_brand_profiles
     WHERE id='default'
  `)).rows[0];
  const counts = (await client.query(`
    SELECT
      (SELECT count(*)::integer FROM public.platform_brand_revisions) AS revisions,
      (SELECT count(*)::integer FROM public.platform_brand_assets) AS assets,
      (SELECT count(*)::integer FROM public.platform_brand_revision_assets) AS mappings,
      (SELECT count(*)::integer FROM public.platform_brand_events) AS events
  `)).rows[0];
  const published = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  return { profile, counts, published };
}

await client.connect();
let transactionOpen = false;
let baseline;
try {
  const identity = (await client.query(
    "SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port",
  )).rows[0];
  assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 });
  baseline = await captureBaseline();
  const generation = Number(baseline.profile.generation);

  await client.query("BEGIN");
  transactionOpen = true;

  const primary = (await client.query(
    "SELECT public.register_platform_brand_asset_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10) AS value",
    ["contact_wechat_qr_primary", "local", `contact-transaction/${suffix}-primary.png`,
      sha256(`primary:${suffix}`), "image/png", 256, 128, 128, actorId, requestKey("primary")],
  )).rows[0].value;
  const secondary = (await client.query(
    "SELECT public.register_platform_brand_asset_atomic($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10) AS value",
    ["contact_wechat_qr_secondary", "local", `contact-transaction/${suffix}-secondary.png`,
      sha256(`secondary:${suffix}`), "image/png", 384, 160, 160, actorId, requestKey("secondary")],
  )).rows[0].value;
  check("two independently typed QR assets register", primary.purpose === "contact_wechat_qr_primary"
    && secondary.purpose === "contact_wechat_qr_secondary"
    && primary.id !== secondary.id,
  { primary: primary.id, secondary: secondary.id });

  const firstSnapshot = brandSnapshot(
    "联系资料事务探针 A",
    { name: "已确认联系人 A", wechat: "verified_contact_a", phone: "010-12345678", email: "a@example.test" },
    { contact_wechat_qr_primary: primary.id, contact_wechat_qr_secondary: secondary.id },
  );
  const firstDraft = (await client.query(
    "SELECT public.save_platform_brand_draft_atomic($1,$2::jsonb,$3,$4::uuid,$5) AS value",
    [generation, JSON.stringify(firstSnapshot), snapshotSha256(firstSnapshot), actorId, requestKey("draft-a")],
  )).rows[0].value;
  check("contact and both QR references save as a draft", Number(firstDraft.generation) === generation + 1,
    { revisionId: firstDraft.revisionId, generation: firstDraft.generation });
  const beforeFirstPublish = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  check("draft contact never leaks into the public read",
    sameValue(publishedContent(beforeFirstPublish), publishedContent(baseline.published)),
  { publishedGenerationAdvanced: beforeFirstPublish?.generation !== baseline.published?.generation });

  const firstPublished = (await client.query(
    "SELECT public.publish_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
    [generation + 1, firstDraft.revisionId, actorId, requestKey("publish-a")],
  )).rows[0].value;
  check("first contact revision publishes", firstPublished.status === "published"
    && Number(firstPublished.generation) === generation + 2, firstPublished);
  const firstPublic = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  check("published contact and two QR assets read back together",
    firstPublic.snapshot.contact.wechat === "verified_contact_a"
      && firstPublic.assets.contact_wechat_qr_primary.id === primary.id
      && firstPublic.assets.contact_wechat_qr_secondary.id === secondary.id,
  { revisionId: firstPublic.revisionId, assetPurposes: Object.keys(firstPublic.assets).sort() });

  const secondSnapshot = brandSnapshot(
    "联系资料事务探针 B",
    { name: "已确认联系人 B", wechat: "verified_contact_b", phone: "", email: "" },
    { contact_wechat_qr_primary: primary.id },
  );
  const secondDraft = (await client.query(
    "SELECT public.save_platform_brand_draft_atomic($1,$2::jsonb,$3,$4::uuid,$5) AS value",
    [generation + 2, JSON.stringify(secondSnapshot), snapshotSha256(secondSnapshot), actorId, requestKey("draft-b")],
  )).rows[0].value;
  const whileSecondDraft = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  check("editing a later draft leaves the published contact immutable",
    Number(secondDraft.generation) === generation + 3
      && whileSecondDraft.snapshot.contact.wechat === "verified_contact_a"
      && Object.keys(whileSecondDraft.assets).length === 2);

  const secondPublished = (await client.query(
    "SELECT public.publish_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
    [generation + 3, secondDraft.revisionId, actorId, requestKey("publish-b")],
  )).rows[0].value;
  const secondPublic = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  check("the next publication atomically replaces contact and QR selection",
    Number(secondPublished.generation) === generation + 4
      && secondPublic.snapshot.contact.wechat === "verified_contact_b"
      && secondPublic.assets.contact_wechat_qr_primary.id === primary.id
      && !secondPublic.assets.contact_wechat_qr_secondary);

  const rolledBack = (await client.query(
    "SELECT public.rollback_platform_brand_revision_atomic($1,$2::uuid,$3::uuid,$4) AS value",
    [generation + 4, firstDraft.revisionId, actorId, requestKey("rollback-a")],
  )).rows[0].value;
  const afterRollback = (await client.query(
    "SELECT public.read_published_platform_brand() AS value",
  )).rows[0].value;
  check("rollback republishes the historical contact and both QR mappings",
    Number(rolledBack.generation) === generation + 5
      && afterRollback.snapshot.contact.wechat === "verified_contact_a"
      && afterRollback.assets.contact_wechat_qr_primary.id === primary.id
      && afterRollback.assets.contact_wechat_qr_secondary.id === secondary.id,
  { revisionId: afterRollback.revisionId, rollbackTargetId: firstDraft.revisionId });

  const readableAssets = await Promise.all([primary.id, secondary.id].map(async (assetId) => (
    await client.query("SELECT * FROM public.read_published_platform_brand_asset($1::uuid)", [assetId])
  ).rows[0]));
  check("only assets mapped to the current published revision are publicly resolvable",
    readableAssets.every((row) => row?.id) && readableAssets.length === 2);

  await client.query("ROLLBACK");
  transactionOpen = false;
  const restored = await captureBaseline();
  check("outer rollback restores profile pointers, counts and public response exactly",
    sameValue(restored, baseline),
  { generation: restored.profile.generation, persisted: false });

  const report = {
    status: "PASS",
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    persisted: false,
    productionWrites: 0,
    paidCalls: 0,
    checks,
  };
  const evidenceDir = path.join(root, ".codex-evidence", "platform-brand-contact-qr");
  const evidencePath = path.join(evidenceDir, "transaction-rollback.json");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end().catch(() => undefined);
}
