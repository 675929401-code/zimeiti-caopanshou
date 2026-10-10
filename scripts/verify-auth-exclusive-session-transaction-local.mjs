#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const runtimeFile = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const migrationFiles = [
  path.resolve("supabase/migrations/20261009055000_user_auth_session_exclusivity.sql"),
  path.resolve("supabase/migrations/20261009056000_user_auth_session_direct_write_guard.sql"),
];
const runtime = JSON.parse((await fs.readFile(runtimeFile, "utf8")).replace(/^\uFEFF/u, ""));
const migrations = await Promise.all(migrationFiles.map(async file => {
  const source = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/u, "").trim();
  assert.match(source, /^BEGIN\s*;/u, "MIGRATION_BEGIN_REQUIRED");
  assert.match(source, /COMMIT\s*;\s*$/u, "MIGRATION_COMMIT_REQUIRED");
  return {
    file,
    body: source.replace(/^BEGIN\s*;/u, "").replace(/COMMIT\s*;\s*$/u, "").trim(),
  };
}));

assert.equal(runtime.localOnly, true, "LOCAL_RUNTIME_REQUIRED");
assert.equal(runtime.ownerConnection?.host, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
assert.equal(Number(runtime.ownerConnection?.port), 54322, "LOCAL_DATABASE_PORT_REQUIRED");
assert.equal(runtime.ownerConnection?.database, "zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

const db = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-auth-exclusive-session-transaction",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
const outputDir = path.resolve(".codex-evidence/auth-exclusive-session");
const report = {
  passed: false,
  checkedAt: new Date().toISOString(),
  target: "127.0.0.1:54322/zimeiti_local",
  migrations: migrationFiles.map(file => path.basename(file)),
  assertions: {},
  transactionRolledBack: false,
  providerRequests: 0,
};

const issue = async (userId, sessionId, ipHash) => (await db.query(
  "SELECT public.issue_user_auth_session($1,$2,$3,$4,$5::timestamptz) AS result",
  [userId, sessionId, ipHash, `ua-${sessionId.slice(0, 8)}`, new Date(Date.now() + 86_400_000).toISOString()],
)).rows[0].result;

await fs.mkdir(outputDir, { recursive: true });
await db.connect();
let transactionOpen = false;
try {
  const identity = (await db.query(
    "SELECT current_database() AS database_name, inet_server_port() AS server_port",
  )).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  await db.query("BEGIN");
  transactionOpen = true;
  for (const migration of migrations) await db.query(migration.body);

  const obsoleteIndexes = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname=ANY($1::text[])
      ORDER BY indexname`,
    [["user_auth_sessions_one_active_ip_idx", "user_auth_sessions_one_active_user_idx"]],
  );
  assert.equal(obsoleteIndexes.rowCount, 0, "OBSOLETE_EXCLUSIVE_SESSION_INDEXES_PRESENT");
  const supportIndexes = await db.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public'
        AND indexname=ANY($1::text[])
      ORDER BY indexname`,
    [["user_auth_sessions_active_ip_user_idx", "user_auth_sessions_active_user_ip_idx"]],
  );
  assert.equal(supportIndexes.rowCount, 2, "SESSION_SCOPE_SUPPORT_INDEXES_MISSING");
  report.assertions.sameIpMultiSessionIndexesPresent = true;
  const guard = await db.query(
    "SELECT 1 FROM pg_trigger WHERE tgrelid='public.user_auth_sessions'::regclass AND tgname='user_auth_sessions_exclusive_write_guard' AND NOT tgisinternal",
  );
  assert.equal(guard.rowCount, 1, "DIRECT_SESSION_WRITE_GUARD_MISSING");
  report.assertions.directSessionWriteGuardPresent = true;

  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await db.query(
    `INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status)
     VALUES($1,$2,'fixture','用户A','student',0,true,'active'),
           ($3,$4,'fixture','用户B','student',0,true,'active')`,
    [userA, `auth_a_${crypto.randomBytes(5).toString("hex")}`, userB, `auth_b_${crypto.randomBytes(5).toString("hex")}`],
  );

  const [a1, a2, a3, b1, a4, a5, b2, b3, b4] = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    .map(() => crypto.randomBytes(32).toString("hex"));
  assert.equal((await issue(userA, a1, "ip-one")).activeCount, 1);
  const sameIpSecond = await issue(userA, a2, "ip-one");
  assert.equal(sameIpSecond.ok, true);
  assert.equal(sameIpSecond.activeCount, 2);
  assert.equal(sameIpSecond.evictedCount, 0);
  let active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id,created_at,id",
    [[userA, userB]],
  );
  assert.deepEqual(new Set(active.rows.map(row => row.session_id)), new Set([a1, a2]));
  assert.ok(active.rows.every(row => row.user_id === userA && row.ip_hash === "ip-one"));
  report.assertions.sameAccountSameIpMultipleBrowsersRemainActive = true;

  const movedIp = await issue(userA, a3, "ip-two");
  assert.equal(movedIp.ok, true);
  assert.equal(movedIp.activeCount, 1);
  assert.equal(movedIp.evictedCount, 2);
  active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id,created_at,id",
    [[userA, userB]],
  );
  assert.deepEqual(active.rows, [{ user_id: userA, session_id: a3, ip_hash: "ip-two" }]);
  const priorIpRows = await db.query(
    "SELECT revoke_reason FROM public.user_auth_sessions WHERE session_id=ANY($1::text[]) ORDER BY session_id",
    [[a1, a2]],
  );
  assert.equal(priorIpRows.rowCount, 2);
  assert.ok(priorIpRows.rows.every(row => row.revoke_reason === "superseded_by_new_ip"));
  report.assertions.sameAccountDifferentIpRevokesPriorIpSessions = true;

  assert.equal((await issue(userB, b1, "ip-two")).ok, true);
  active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id",
    [[userA, userB]],
  );
  assert.deepEqual(active.rows, [{ user_id: userB, session_id: b1, ip_hash: "ip-two" }]);
  const a3Row = (await db.query(
    "SELECT revoke_reason FROM public.user_auth_sessions WHERE session_id=$1",
    [a3],
  )).rows[0];
  assert.equal(a3Row.revoke_reason, "ip_account_replaced");
  assert.equal((await db.query("SELECT session_id FROM public.users WHERE id=$1", [userA])).rows[0].session_id, null);
  report.assertions.sameIpDifferentAccountRevokesPriorAccount = true;

  assert.equal((await issue(userA, a4, "ip-one")).ok, true);
  active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id,created_at,id",
    [[userA, userB]],
  );
  assert.equal(active.rowCount, 2);
  const activeByUser = new Map(active.rows.map((row) => [row.user_id, row]));
  assert.deepEqual(activeByUser.get(userA), { user_id: userA, session_id: a4, ip_hash: "ip-one" });
  assert.deepEqual(activeByUser.get(userB), { user_id: userB, session_id: b1, ip_hash: "ip-two" });
  report.assertions.differentUsersOnDifferentIpsRemainActive = true;

  await db.query(
    `INSERT INTO public.user_auth_sessions(user_id,session_id,ip_hash,user_agent_hash,created_at,expires_at)
     VALUES($1,$2,$3,'direct-writer',clock_timestamp(),clock_timestamp()+interval '1 day')`,
    [userA, a5, "ip-one"],
  );
  active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id,created_at,id",
    [[userA, userB]],
  );
  assert.equal(active.rowCount, 3);
  assert.deepEqual(
    new Set(active.rows.filter(row => row.user_id === userA).map(row => row.session_id)),
    new Set([a4, a5]),
  );
  assert.equal(active.rows.find(row => row.user_id === userB)?.session_id, b1);
  report.assertions.directWriterPreservesSameAccountSameIpSessions = true;

  await db.query(
    `INSERT INTO public.user_auth_sessions(user_id,session_id,ip_hash,user_agent_hash,created_at,expires_at)
     VALUES($1,$2,$3,'direct-writer-switch',clock_timestamp(),clock_timestamp()+interval '1 day')`,
    [userB, b2, "ip-one"],
  );
  active = await db.query(
    "SELECT user_id,session_id,ip_hash FROM public.user_auth_sessions WHERE revoked_at IS NULL AND user_id=ANY($1::text[]) ORDER BY user_id,created_at,id",
    [[userA, userB]],
  );
  assert.deepEqual(active.rows, [{ user_id: userB, session_id: b2, ip_hash: "ip-one" }]);
  report.assertions.directWriterEnforcesAccountIpMapping = true;

  assert.equal((await issue(userB, b3, "ip-one")).activeCount, 2);
  assert.equal((await issue(userB, b4, "ip-one")).activeCount, 3);
  const revokeLatest = (await db.query(
    "SELECT public.revoke_user_auth_session($1,$2,'logout') AS result",
    [userB, b4],
  )).rows[0].result;
  assert.equal(revokeLatest.ok, true);
  assert.equal(revokeLatest.revoked, true);
  assert.equal(revokeLatest.latestSessionId, b3);
  assert.equal((await db.query("SELECT session_id FROM public.users WHERE id=$1", [userB])).rows[0].session_id, b3);
  const siblingSessions = await db.query(
    "SELECT session_id FROM public.user_auth_sessions WHERE user_id=$1 AND ip_hash='ip-one' AND revoked_at IS NULL ORDER BY created_at,id",
    [userB],
  );
  assert.deepEqual(new Set(siblingSessions.rows.map(row => row.session_id)), new Set([b2, b3]));
  report.assertions.singleBrowserLogoutPreservesSameIpSiblingSessions = true;

  const userDuplicates = await db.query(
    `SELECT user_id FROM public.user_auth_sessions
      WHERE revoked_at IS NULL AND ip_hash IS NOT NULL
      GROUP BY user_id HAVING count(DISTINCT ip_hash) > 1`,
  );
  const ipDuplicates = await db.query(
    `SELECT ip_hash FROM public.user_auth_sessions
      WHERE revoked_at IS NULL AND ip_hash IS NOT NULL
      GROUP BY ip_hash HAVING count(DISTINCT user_id) > 1`,
  );
  assert.equal(userDuplicates.rowCount, 0);
  assert.equal(ipDuplicates.rowCount, 0);
  report.assertions.databaseAccountIpScopeInvariantHolds = true;

  await db.query("ROLLBACK");
  transactionOpen = false;
  report.transactionRolledBack = true;
  report.passed = true;
} finally {
  if (transactionOpen) {
    await db.query("ROLLBACK").catch(() => undefined);
    report.transactionRolledBack = true;
  }
  await db.end();
  report.checkedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, "transaction-contract.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify(report, null, 2));
