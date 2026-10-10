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
assert.equal(runtime.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.databasePort), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.databaseName, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const client = new pg.Client({
  host: "127.0.0.1",
  port: 54322,
  database: "zimeiti_local",
  user: "postgres",
  password: String(runtime.postgresPassword),
  application_name: "codex-white-label-transaction-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 120_000,
});

const checks = [];
function check(name, condition, evidence = undefined) {
  assert.ok(condition, name);
  checks.push({ name, passed: true, ...(evidence === undefined ? {} : { evidence }) });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const suffix = randomUUID().replaceAll("-", "");
const hostname = `wl-${suffix}.codex-acceptance.cn`;
const txtName = `_zimeiti-domain-verification.${hostname}`;
const tokenHash = sha256(`white-label-token:${suffix}`);
const requestKey = `wl-save-${suffix}`;
const actorId = `codex-white-label-${suffix}`;
let profileId = "";
let transactionOpen = false;

const saveSql = `
  SELECT public.save_white_label_draft_atomic(
    $1::uuid,$2::integer,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,
    $9::text,$10::text,$11::text,$12::text,$13::text,$14::text,$15::text,$16::text
  ) AS result
`;

await client.connect();
try {
  const identity = (await client.query(`
    SELECT current_database() AS database_name,
           host(inet_server_addr()) AS server_address,
           inet_server_port() AS server_port
  `)).rows[0];
  check("target is the isolated local database",
    identity.database_name === "zimeiti_local"
      && identity.server_address === "127.0.0.1"
      && Number(identity.server_port) === 54322,
    { target: "127.0.0.1:54322/zimeiti_local" });

  const catalog = await client.query(`
    SELECT permission_key, is_delegable, dependency_keys
      FROM public.admin_permission_catalog
     WHERE permission_key = ANY($1::text[])
     ORDER BY permission_key
  `, [["admin.accounts.manage", "prompts.view", "prompts.edit", "internal_tools.manage"]]);
  check("all restricted capabilities are non-delegable",
    catalog.rowCount === 4
      && catalog.rows.every((row) => row.is_delegable === false && Array.isArray(row.dependency_keys) && row.dependency_keys.length === 0),
    { keys: catalog.rows.map((row) => row.permission_key) });

  const ordinaryLeaks = await client.query(`
    SELECT user_id
      FROM public.admin_access_profiles
     WHERE admin_level = 'admin'
       AND permission_keys ?| $1::text[]
  `, [["admin.accounts.manage", "prompts.view", "prompts.edit", "internal_tools.manage"]]);
  check("ordinary admin profiles contain no owner-only permission", ordinaryLeaks.rowCount === 0);

  const privileges = (await client.query(`
    SELECT
      has_function_privilege('service_role', 'public.read_white_label_admin_state()', 'EXECUTE') AS service_read,
      has_function_privilege('service_role', 'public.save_white_label_draft_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') AS service_save,
      has_function_privilege('service_role', 'public.record_white_label_domain_verification(uuid,integer,boolean,text,text,text,text,text,text)', 'EXECUTE') AS service_verify,
      has_function_privilege('anon', 'public.read_white_label_admin_state()', 'EXECUTE') AS anon_read,
      has_function_privilege('authenticated', 'public.save_white_label_draft_atomic(uuid,integer,text,text,text,text,text,text,text,text,text,text,text,text,text,text)', 'EXECUTE') AS authenticated_save
  `)).rows[0];
  check("white-label RPCs are service-only",
    privileges.service_read === true
      && privileges.service_save === true
      && privileges.service_verify === true
      && privileges.anon_read === false
      && privileges.authenticated_save === false,
    privileges);

  await client.query("BEGIN");
  transactionOpen = true;
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='120s'");

  const saveArgs = [
    null, 0, "验收客户品牌", "验收品牌", "张经理", "codex_fixture_wechat",
    "13800000000", "service@codex-acceptance.cn", hostname, hostname, "", txtName,
    tokenHash, tokenHash.slice(0, 8), actorId, requestKey,
  ];
  const created = (await client.query(saveSql, saveArgs)).rows[0].result;
  profileId = String(created.profileId || "");
  check("draft save returns a durable revisioned receipt",
    /^[0-9a-f-]{36}$/u.test(profileId)
      && Number(created.revision) === 1
      && created.hostname === hostname
      && created.expectedTxtName === txtName
      && created.expectedTxtValue === tokenHash
      && created.replayed === false,
    { profileId, revision: created.revision, hostname: created.hostname });

  const replayed = (await client.query(saveSql, saveArgs)).rows[0].result;
  const eventCount = Number((await client.query(
    "SELECT count(*)::integer AS count FROM public.white_label_profile_events WHERE profile_id=$1",
    [profileId],
  )).rows[0].count);
  check("idempotent retry returns the same receipt without a second event",
    replayed.replayed === true && replayed.profileId === profileId && eventCount === 1,
    { eventCount });

  const state = (await client.query("SELECT public.read_white_label_admin_state() AS state")).rows[0].state;
  const profile = state.profiles.find((item) => item.profileId === profileId);
  check("admin read model returns saved customer brand, contact and domain",
    profile?.brandName === "验收客户品牌"
      && profile?.contact?.wechat === "codex_fixture_wechat"
      && profile?.hostname === hostname
      && profile?.lifecycleStatus === "pending_verification");

  await client.query("SAVEPOINT stale_revision");
  let staleRejected = false;
  try {
    await client.query(saveSql, [
      profileId, 0, "错误覆盖", "", "", "", "", "", hostname, hostname, "",
      txtName, tokenHash, tokenHash.slice(0, 8), actorId, `wl-stale-${suffix}`,
    ]);
  } catch (error) {
    staleRejected = String(error?.message || "").includes("WHITE_LABEL_REVISION_CONFLICT");
    await client.query("ROLLBACK TO SAVEPOINT stale_revision");
  }
  await client.query("RELEASE SAVEPOINT stale_revision");
  check("stale revisions cannot overwrite a newer profile", staleRejected);

  const verification = (await client.query(`
    SELECT public.record_white_label_domain_verification(
      $1::uuid,$2::integer,$3::boolean,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text
    ) AS result
  `, [
    profileId, 1, true, sha256(JSON.stringify([`zimeiti-verification=${tokenHash}`])),
    sha256(`dns-evidence:${suffix}`), "local-transaction-verifier", "", actorId, `wl-verify-${suffix}`,
  ])).rows[0].result;
  check("DNS ownership receipt advances the profile revision", verification.verified === true && Number(verification.revision) === 2);

  const runtimeBoundary = (await client.query(`
    SELECT p.lifecycle_status, c.claim_status, h.ownership_status, h.routing_status,
           h.tls_status, h.https_status, s.verification_status, b.binding_status
      FROM public.white_label_profiles p
      JOIN public.domain_claims c ON c.claim_id=p.domain_claim_id
      JOIN public.domain_hostnames h ON h.claim_id=c.claim_id
      JOIN public.site_hostnames s ON s.site_key=p.site_key AND s.tenant_key=p.tenant_key
      JOIN public.domain_brand_release_bindings b ON b.hostname_id=h.hostname_id
     WHERE p.profile_id=$1
  `, [profileId])).rows[0];
  check("DNS verification does not fabricate gateway, TLS or HTTPS readiness",
    runtimeBoundary.lifecycle_status === "domain_verified"
      && runtimeBoundary.claim_status === "verified"
      && runtimeBoundary.ownership_status === "verified"
      && runtimeBoundary.routing_status === "unavailable"
      && runtimeBoundary.tls_status === "unavailable"
      && runtimeBoundary.https_status === "unavailable"
      && runtimeBoundary.verification_status === "claimed"
      && runtimeBoundary.binding_status === "blocked",
    runtimeBoundary);

  await client.query("ROLLBACK");
  transactionOpen = false;
  const remaining = Number((await client.query(
    "SELECT count(*)::integer AS count FROM public.white_label_profiles WHERE profile_id=$1",
    [profileId],
  )).rows[0].count);
  check("transaction fixtures are fully rolled back", remaining === 0);

  const report = {
    status: "PASS",
    generatedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    paidModelCalls: 0,
    checks,
  };
  const evidenceDir = path.join(root, ".codex-evidence", "admin-white-label-20261009");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(path.join(evidenceDir, "white-label-transaction.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  await client.end();
}
