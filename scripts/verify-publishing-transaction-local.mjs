#!/usr/bin/env node
// Default: rollback-only. Explicit --allow-temporary-config-version also runs
// real multi-connection races using committed unique fixtures, a temporary new
// config version and finally cleanup. Never changes an existing config version.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim() || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_REQUIRED");
const client = new pg.Client({ ...runtime.ownerConnection, application_name: "codex-publishing-rollback-test", connectionTimeoutMillis: 10000, query_timeout: 120000 });
const connectionConfig = { ...runtime.ownerConnection, application_name: "codex-publishing-concurrent-fixture", connectionTimeoutMillis: 10000, query_timeout: 120000 };
const concurrentFixtures = process.argv.includes("--allow-temporary-config-version");
if (concurrentFixtures) assert.notEqual(process.env.PUBLISHING_EXTERNAL_EXECUTION_ENABLED, "true", "EXTERNAL_EXECUTION_MUST_REMAIN_OFF");
if (concurrentFixtures) {
  assert.ok(process.env.LOCAL_NAV_ORIGIN && process.env.LOCAL_NAV_ADMIN_TOKEN && process.env.LOCAL_ADMIN_STEP_UP_TOKEN, "LOCAL_WEB_AUTH_AND_STEP_UP_CONTEXT_REQUIRED");
  const origin = new URL(process.env.LOCAL_NAV_ORIGIN);
  assert.equal(origin.origin, "http://127.0.0.1:5000", "EXACT_LOCAL_WEB_ORIGIN_REQUIRED");
  assert.equal(origin.username, "", "LOCAL_ORIGIN_CREDENTIALS_FORBIDDEN");
  assert.equal(origin.password, "", "LOCAL_ORIGIN_CREDENTIALS_FORBIDDEN");
  const response = await fetch(new URL("/api/admin/publishing", origin), { headers: { Authorization: `Bearer ${process.env.LOCAL_NAV_ADMIN_TOKEN}`, "x-admin-step-up": process.env.LOCAL_ADMIN_STEP_UP_TOKEN }, redirect: "error", signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, "LOCAL_WEB_PUBLISHING_GATE_READ_REQUIRED");
  const state = await response.json();
  assert.equal(state.config?.runtimeExecutionEnabled, false, "ACTUAL_LOCAL_WEB_EXECUTION_MUST_REMAIN_OFF");
}
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push({ name, passed: true }); };
const hash = (value) => createHash("sha256").update(value).digest("hex");
const configHash = async (database = client) => hash(JSON.stringify((await database.query("SELECT * FROM public.pub_config_versions ORDER BY version")).rows));
const userA = randomUUID(), userB = randomUUID(), userDenied = randomUUID(), planId = randomUUID();
const purchaseSql = "SELECT public.purchase_publish_package_atomic($1::text,$2::uuid,$3::integer,$4::text,$5::text) AS result";
const claimSql = "SELECT public.claim_publish_execution_atomic($1::text,$2::uuid,$3::integer,$4::uuid,$5::uuid,$6::text,$7::text) AS result";
const call = async (sql, args) => (await client.query(sql, args)).rows[0].result;
let point = 0;
async function expectError(name, code, body) {
  const savepoint = `publishing_test_${++point}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let rejected = false;
  let observed = "NO_ERROR";
  const allowedCodes = Array.isArray(code) ? code : [code];
  try { await body(); } catch (error) {
    rejected = allowedCodes.some((candidate) => String(error.message).includes(candidate));
    observed = `${String(error.code || "UNKNOWN")}: ${String(error.message || "").slice(0, 180)}`;
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(rejected, `${name}: expected ${allowedCodes.join(" or ")}; observed ${observed}`);
  check(name, true);
}
await client.connect();
let transaction = false;
let fixtureCommitted = false;
let sessionLocked = false;
let concurrentVersion = null;
let baselineConfigHash = null;
const raceClients = [];
try {
  const identity = (await client.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];
  assert.deepEqual(identity, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 }, "LIVE_LOCAL_IDENTITY_REQUIRED");
  await client.query("BEGIN"); transaction = true;
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='120s'");
  const tables = (await client.query("SELECT c.relname,c.relrowsecurity,has_table_privilege('anon',c.oid,'SELECT') AS anon_read,has_table_privilege('authenticated',c.oid,'INSERT') AS member_write FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])", [["pub_config_versions", "pub_plan_versions", "pub_purchases", "pub_entitlements", "pub_accounts", "pub_drafts", "pub_tasks"]])).rows;
  check("all seven tables use RLS and deny ordinary direct access", tables.length === 7 && tables.every((row) => row.relrowsecurity && !row.anon_read && !row.member_write));
  const functions = (await client.query("SELECT p.proname,has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,has_function_privilege('authenticated',p.oid,'EXECUTE') AS member_execute,has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=ANY($1::text[])", [["pub_assert_actor", "purchase_publish_package_atomic", "claim_publish_execution_atomic", "save_publish_draft_atomic", "save_publish_account_atomic", "report_publish_execution_atomic", "save_publish_config_atomic", "save_publish_plan_atomic"]])).rows;
  check("all mutation RPCs are service-only security definers with pinned search_path", functions.length === 8 && functions.every((row) => !row.anon_execute && !row.member_execute && row.service_execute && row.prosecdef && row.proconfig?.some((item) => /search_path=public, pg_temp/.test(item))));
  await client.query("SELECT set_config('app.member_permission_write','on',true)");
  for (const [index, userId] of [userA, userB, userDenied].entries()) {
    const suffix = userId.replaceAll("-", "");
    await client.query("INSERT INTO public.users(id,username,phone,email,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status) VALUES($1::text,$2,$3,$4,'local-unusable-password-hash','发布回滚验收','student',0,100,true,'active','inactive')", [userId, `pub-test-${suffix}`, `19${suffix.replace(/\D/g, "").padEnd(9, String(index)).slice(0, 9)}`, `pub-${suffix}@fixture.invalid`]);
    const features = userId === userDenied ? "[]" : '["publish_center"]';
    await client.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,$2::jsonb,'[]',1,public.member_permission_checksum($1::text,$2::jsonb,'[]',1),'custom','rollback-only publishing fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys=EXCLUDED.agent_navigation_keys,revision=1,checksum=EXCLUDED.checksum", [userId, features]);
  }
  const configVersion = Number((await client.query("SELECT max(version) AS version FROM public.pub_config_versions")).rows[0].version);
  await client.query("INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,operator_links,enabled_platforms) VALUES($1,true,true,'{}','[\"xhs\",\"douyin\",\"wxSph\"]')", [configVersion + 1]);
  await client.query("INSERT INTO public.pub_plan_versions(id,version,name,price_cents,quota,valid_days,platforms,enabled) VALUES($1,1,'rollback-only test plan',125,1,30,'[\"xhs\"]',true)", [planId]);

  const purchaseArgs = [userA, planId, 1, "rollback-purchase-1", hash("purchase-1")];
  const blockedPlanId = randomUUID();
  await client.query("INSERT INTO public.pub_plan_versions(id,version,name,price_cents,quota,valid_days,platforms,enabled) VALUES($1,1,'disabled-platform fixture',125,1,1,'[\"xhs\",\"douyin\"]',true)", [blockedPlanId]);
  await client.query("INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,operator_links,enabled_platforms) VALUES($1,true,true,'{}','[\"xhs\"]')", [configVersion + 2]);
  await expectError("package cannot be sold when one promised platform is disabled", "PUBLISH_PLATFORM_DISABLED", () => call(purchaseSql, [userA, blockedPlanId, 1, "rollback-disabled-platform", hash("disabled-platform")]));
  const purchased = await call(purchaseSql, purchaseArgs);
  const replayedPurchase = await call(purchaseSql, purchaseArgs);
  check("purchase retry preserves one receipt and entitlement", purchased.purchase.id === replayedPurchase.purchase.id && replayedPurchase.alreadyFulfilled === true && purchased.entitlement.id === replayedPurchase.entitlement.id);
  check("purchase debits exactly the server-plan cash price once", Number((await client.query("SELECT cash_balance FROM public.users WHERE id=$1", [userA])).rows[0].cash_balance) === 98.75);
  await expectError("same purchase key with different payload is rejected", "PUBLISH_IDEMPOTENCY_CONFLICT", () => call(purchaseSql, [...purchaseArgs.slice(0, 4), hash("different")]));
  await expectError("membership permission is required before any charge", "PUBLISH_ACCESS_DENIED", () => call(purchaseSql, [userDenied, planId, 1, "rollback-denied-1", hash("denied")]));
  await client.query("UPDATE public.users SET is_active=false WHERE id=$1", [userB]);
  await expectError("disabled user cannot purchase", "PUBLISH_USER_DISABLED", () => call(purchaseSql, [userB, planId, 1, "rollback-disabled", hash("disabled")]));
  await client.query("UPDATE public.users SET is_active=true,cash_balance=0 WHERE id=$1", [userB]);
  await expectError("insufficient cash cannot purchase", ["INSUFFICIENT_CASH", "VIDEO_BUDGET_CASH_RESERVED"], () => call(purchaseSql, [userB, planId, 1, "rollback-no-cash", hash("no-cash")]));
  await client.query("UPDATE public.users SET cash_balance=100 WHERE id=$1", [userB]);
  const beforeFailure = (await client.query("SELECT cash_balance,(SELECT count(*) FROM public.wallet_operations WHERE user_id=$1::text) AS operations FROM public.users WHERE id=$1::text", [userB])).rows[0];
  await client.query(`ALTER TABLE public.pub_entitlements ADD CONSTRAINT pub_fixture_grant_failure CHECK(user_id <> '${userB}')`);
  await expectError("grant failure rejects the entire purchase", "pub_fixture_grant_failure", () => call(purchaseSql, [userB, planId, 1, "rollback-fail-grant", hash("fail-grant")]));
  const afterFailure = (await client.query("SELECT cash_balance,(SELECT count(*) FROM public.wallet_operations WHERE user_id=$1::text) AS operations FROM public.users WHERE id=$1::text", [userB])).rows[0];
  check("grant failure rolls back wallet balance and operation row", JSON.stringify(beforeFailure) === JSON.stringify(afterFailure));
  await client.query("ALTER TABLE public.pub_entitlements DROP CONSTRAINT pub_fixture_grant_failure");
  const payload = { title: "临时成片", body: "仅回滚验收", topics: ["测试"], platforms: ["xhs"], assets: [{ fileName: "fixture.mp4", size: 10, type: "video/mp4", lastModified: 1 }] };
  const draft = await call("SELECT public.save_publish_draft_atomic($1,NULL,0,$2::jsonb,false) AS result", [userA, JSON.stringify(payload)]);
  await expectError("stale draft revision cannot overwrite saved content", "PUBLISH_REVISION_CONFLICT", () => call("SELECT public.save_publish_draft_atomic($1,$2::uuid,0,$3::jsonb,false) AS result", [userA, draft.id, JSON.stringify(payload)]));
  const account = await call("SELECT public.save_publish_account_atomic($1,'xhs','fixture-account','验收账号',NULL) AS result", [userA]);
  const claimArgs = [userA, draft.id, 1, account.id, purchased.entitlement.id, "rollback-claim-1", hash("claim-1")];
  const claimed = await call(claimSql, claimArgs);
  const replayedClaim = await call(claimSql, claimArgs);
  check("first claim permits execution and retry never requests a second execution", claimed.shouldExecute === true && replayedClaim.shouldExecute === false && claimed.task.id === replayedClaim.task.id);
  check("claim retry consumes exactly one execution", Number((await client.query("SELECT used FROM public.pub_entitlements WHERE id=$1", [purchased.entitlement.id])).rows[0].used) === 1);
  await expectError("changed claim payload under the same key is rejected", "PUBLISH_IDEMPOTENCY_CONFLICT", () => call(claimSql, [...claimArgs.slice(0, 6), hash("different")]));
  await expectError("new execution cannot exceed quota", "PUBLISH_NO_QUOTA", () => call(claimSql, [...claimArgs.slice(0, 5), "rollback-claim-noquota", hash("noquota")]));
  await expectError("other owner cannot claim a draft", "PUBLISH_DRAFT_NOT_FOUND", () => call(claimSql, [userB, ...claimArgs.slice(1, 5), "rollback-cross-draft", hash("cross-draft")]));
  const draftB = await call("SELECT public.save_publish_draft_atomic($1,NULL,0,$2::jsonb,false) AS result", [userB, JSON.stringify(payload)]);
  await expectError("other owner cannot claim an account", "PUBLISH_ACCOUNT_NOT_FOUND", () => call(claimSql, [userB, draftB.id, 1, account.id, purchased.entitlement.id, "rollback-cross-account", hash("cross-account")]));
  const accountB = await call("SELECT public.save_publish_account_atomic($1,'xhs','fixture-account-b','验收账号B',NULL) AS result", [userB]);
  await expectError("other owner cannot consume an entitlement", "PUBLISH_ENTITLEMENT_NOT_FOUND", () => call(claimSql, [userB, draftB.id, 1, accountB.id, purchased.entitlement.id, "rollback-cross-quota", hash("cross-quota")]));
  await expectError("other owner cannot edit a draft", "PUBLISH_DRAFT_NOT_FOUND", () => call("SELECT public.save_publish_draft_atomic($1,$2::uuid,1,$3::jsonb,false) AS result", [userB, draft.id, JSON.stringify(payload)]));
  await expectError("other owner cannot report a task", "PUBLISH_TASK_NOT_FOUND", () => call("SELECT public.report_publish_execution_atomic($1,$2::uuid,$3::jsonb) AS result", [userB, claimed.task.id, '{"success":true}']));
  await client.query("UPDATE public.pub_entitlements SET expires_at=now()-interval '1 day' WHERE id=$1", [purchased.entitlement.id]);
  await expectError("expired entitlement refuses execution", "PUBLISH_ENTITLEMENT_EXPIRED", () => call(claimSql, [...claimArgs.slice(0, 5), "rollback-expired-claim", hash("expired")]));
  await client.query("UPDATE public.pub_entitlements SET expires_at=now()+interval '1 day' WHERE id=$1", [purchased.entitlement.id]);
  const report = await call("SELECT public.report_publish_execution_atomic($1,$2::uuid,$3::jsonb) AS result", [userA, claimed.task.id, '{"success":true,"workId":"browser-only"}']);
  check("plugin report remains browser_reported and does not create trusted success", report.status === "browser_reported" && report.receipt_source === "browser_reported");
  await expectError("conflicting receipt cannot replace an existing report", "PUBLISH_RECEIPT_CONFLICT", () => call("SELECT public.report_publish_execution_atomic($1,$2::uuid,$3::jsonb) AS result", [userA, claimed.task.id, '{"success":false}']));
  await expectError("anon cannot read publishing tables", "permission denied", async () => { await client.query("SET LOCAL ROLE anon"); await client.query("SELECT * FROM public.pub_tasks LIMIT 1"); });
  await expectError("authenticated cannot invoke purchase RPC", "permission denied", async () => { await client.query("SET LOCAL ROLE authenticated"); await call(purchaseSql, purchaseArgs); });
  await client.query("ROLLBACK"); transaction = false;
  check("temporary fixture users are fully rolled back", Number((await client.query("SELECT count(*) FROM public.users WHERE id=ANY($1::text[])", [[userA, userB, userDenied]])).rows[0].count) === 0);
  if (concurrentFixtures) {
    await client.query("SELECT pg_advisory_lock(hashtextextended('publish-center:config',0))"); sessionLocked = true;
    baselineConfigHash = await configHash();
    concurrentVersion = Number((await client.query("SELECT max(version) AS version FROM public.pub_config_versions")).rows[0].version) + 1;
    await client.query("BEGIN"); transaction = true;
    await client.query("SELECT set_config('app.member_permission_write','on',true)");
    const suffix = userA.replaceAll("-", "");
    await client.query("INSERT INTO public.users(id,username,phone,email,password_hash,display_name,role,credits,cash_balance,is_active,status,member_status) VALUES($1::text,$2,$3,$4,'local-unusable-password-hash','并发回滚验收','student',0,100,true,'active','inactive')", [userA, `pub-race-${suffix}`, `18${suffix.replace(/\D/g, "").padEnd(9, "7").slice(0, 9)}`, `pub-race-${suffix}@fixture.invalid`]);
    await client.query("INSERT INTO public.member_permission_assignments(user_id,feature_navigation_keys,agent_navigation_keys,revision,checksum,source,reason) VALUES($1::text,'[\"publish_center\"]','[]',1,public.member_permission_checksum($1::text,'[\"publish_center\"]','[]',1),'custom','isolated concurrent fixture') ON CONFLICT(user_id) DO UPDATE SET feature_navigation_keys=EXCLUDED.feature_navigation_keys,agent_navigation_keys=EXCLUDED.agent_navigation_keys,revision=1,checksum=EXCLUDED.checksum", [userA]);
    await client.query("INSERT INTO public.pub_config_versions(version,execution_enabled,sales_enabled,operator_links,enabled_platforms,created_by) VALUES($1,true,true,'{}','[\"xhs\"]',$2)", [concurrentVersion, userA]);
    await client.query("INSERT INTO public.pub_plan_versions(id,version,name,price_cents,quota,valid_days,platforms,enabled,created_by) VALUES($1,1,'isolated concurrent fixture',125,1,1,'[\"xhs\"]',true,$2)", [planId, userA]);
    // Record non-secret cleanup selectors before COMMIT: even a lost commit
    // response must enter finally cleanup and perform an owner-scoped readback.
    fixtureCommitted = true;
    process.stdout.write(`${JSON.stringify({ fixturePrepared: true, ownerId: userA, planId, configVersion: concurrentVersion })}\n`);
    await client.query("COMMIT"); transaction = false;
    for (let index = 0; index < 2; index++) { const peer = new pg.Client(connectionConfig); await peer.connect(); raceClients.push(peer); }
    const racePurchaseArgs = [userA, planId, 1, "race-purchase-key", hash("race-purchase")];
    const purchaseResults = await Promise.all(raceClients.map((peer) => peer.query(purchaseSql, racePurchaseArgs).then((result) => result.rows[0].result)));
    check("real concurrent purchase returns one debit and one entitlement", purchaseResults[0].purchase.id === purchaseResults[1].purchase.id && purchaseResults.filter((item) => item.alreadyFulfilled === false).length === 1 && Number((await client.query("SELECT cash_balance FROM public.users WHERE id=$1", [userA])).rows[0].cash_balance) === 98.75);
    const raceDraft = await call("SELECT public.save_publish_draft_atomic($1,NULL,0,$2::jsonb,false) AS result", [userA, JSON.stringify(payload)]);
    const raceAccount = await call("SELECT public.save_publish_account_atomic($1,'xhs','race-fixture-account','并发验收账号',NULL) AS result", [userA]);
    const raceClaimArgs = [userA, raceDraft.id, 1, raceAccount.id, purchaseResults[0].entitlement.id, "race-claim-key", hash("race-claim")];
    const claimResults = await Promise.all(raceClients.map((peer) => peer.query(claimSql, raceClaimArgs).then((result) => result.rows[0].result)));
    check("real concurrent claim consumes one quota and permits exactly one browser execution", claimResults[0].task.id === claimResults[1].task.id && claimResults.filter((item) => item.shouldExecute === true).length === 1 && Number((await client.query("SELECT used FROM public.pub_entitlements WHERE id=$1", [purchaseResults[0].entitlement.id])).rows[0].used) === 1);
  }
} finally {
  let cleanupClient = client;
  let cleanupError = null;
  try {
    if (transaction) { try { await client.query("ROLLBACK"); } catch { /* Reconnect below for a potentially committed fixture. */ } }
    await Promise.allSettled(raceClients.map((peer) => peer.end()));
    if (fixtureCommitted) {
      try { await client.query("SELECT 1"); } catch {
        await client.end().catch(() => {});
        sessionLocked = false;
        cleanupClient = new pg.Client(connectionConfig);
        await cleanupClient.connect();
        const target = (await cleanupClient.query("SELECT current_database() AS db,host(inet_server_addr()) AS host,inet_server_port() AS port")).rows[0];
        assert.deepEqual(target, { db: "zimeiti_local", host: "127.0.0.1", port: 54322 }, "CLEANUP_LIVE_LOCAL_IDENTITY_REQUIRED");
        await cleanupClient.query("SELECT pg_advisory_lock(hashtextextended('publish-center:config',0))");
        sessionLocked = true;
      }
      await cleanupClient.query("BEGIN");
      try {
        await cleanupClient.query("SELECT set_config('app.member_permission_write','on',true)");
        for (const table of ["pub_tasks", "pub_drafts", "pub_accounts", "pub_entitlements", "pub_purchases"]) await cleanupClient.query(`DELETE FROM public.${table} WHERE user_id=$1`, [userA]);
        await cleanupClient.query("DELETE FROM public.pub_plan_versions WHERE id=$1 AND created_by=$2", [planId, userA]);
        await cleanupClient.query("DELETE FROM public.pub_config_versions WHERE version=$1 AND created_by=$2", [concurrentVersion, userA]);
        await cleanupClient.query("DELETE FROM public.cash_transactions WHERE user_id=$1::uuid", [userA]);
        await cleanupClient.query("DELETE FROM public.wallet_ledger_entries WHERE user_id=$1", [userA]);
        await cleanupClient.query("DELETE FROM public.wallet_operations WHERE user_id=$1", [userA]);
        // Permission events only allow deletion through the existing user-delete cascade.
        await cleanupClient.query("DELETE FROM public.users WHERE id=$1 AND username=$2", [userA, `pub-race-${userA.replaceAll("-", "")}`]);
        await cleanupClient.query("COMMIT");
      } catch (error) { await cleanupClient.query("ROLLBACK").catch(() => {}); throw error; }
      const residual = await cleanupClient.query("SELECT (SELECT count(*) FROM public.users WHERE id=$1::text)+(SELECT count(*) FROM public.wallet_operations WHERE user_id=$1::text)+(SELECT count(*) FROM public.wallet_ledger_entries WHERE user_id=$1::text)+(SELECT count(*) FROM public.cash_transactions WHERE user_id=$1::uuid)+(SELECT count(*) FROM public.pub_tasks WHERE user_id=$1::text)+(SELECT count(*) FROM public.pub_purchases WHERE user_id=$1::text)+(SELECT count(*) FROM public.pub_plan_versions WHERE id=$2::uuid) AS remaining", [userA, planId]);
      check("concurrent committed fixture user and ledger are removed", Number(residual.rows[0].remaining) === 0);
      check("original configuration versions match the baseline hash after cleanup", baselineConfigHash === await configHash(cleanupClient));
    }
  } catch (error) {
    cleanupError = error;
    process.stdout.write(`${JSON.stringify({ cleanupStatus: "UNKNOWN", ownerId: userA, planId, configVersion: concurrentVersion, errorCode: String(error?.code || "CLEANUP_UNCONFIRMED") })}\n`);
  } finally {
    if (sessionLocked) await cleanupClient.query("SELECT pg_advisory_unlock(hashtextextended('publish-center:config',0))").catch(() => {});
    await cleanupClient.end().catch(() => {});
    if (cleanupClient !== client) await client.end().catch(() => {});
  }
  if (cleanupError) throw new Error("PUBLISHING_FIXTURE_CLEANUP_UNKNOWN: inspect the non-secret owner/plan/config selectors above; no cleanup success is claimed");
}
process.stdout.write(`${JSON.stringify({ status: "passed", scope: concurrentFixtures ? "local-rollback-and-cleaned-concurrency-fixtures" : "local-rollback-only", concurrentExecutionTested: concurrentFixtures, externalCalls: 0, checks }, null, 2)}\n`);
