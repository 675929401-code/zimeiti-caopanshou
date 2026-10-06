#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const RUNTIME_FILE = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(RUNTIME_FILE, "utf8")).replace(/^\uFEFF/u, ""));
assert.equal(runtime.localOnly, true);
assert.equal(runtime.ownerConnection?.host, "127.0.0.1");
assert.equal(Number(runtime.ownerConnection?.port), 54322);
assert.equal(runtime.ownerConnection?.database, "zimeiti_local");

const client = new pg.Client({
  ...runtime.ownerConnection,
  application_name: "codex-auth-two-session-verifier",
  connectionTimeoutMillis: 10_000,
  query_timeout: 30_000,
});
await client.connect();
let transactionOpen = false;
try {
  const identity = (await client.query("SELECT current_database() AS database_name, inet_server_port() AS server_port")).rows[0];
  assert.equal(identity.database_name, "zimeiti_local");
  assert.equal(Number(identity.server_port), 54322);

  await client.query("BEGIN");
  transactionOpen = true;
  const userId = crypto.randomUUID();
  const username = `auth_contract_${crypto.randomBytes(6).toString("hex")}`;
  await client.query(
    `INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status)
     VALUES($1,$2,$3,$4,'student',0,true,'active')`,
    [userId, username, "$2b$10$8QzQfP5V1xw4v9C2zH1qQ.7P0qt0b4pJ0d2xjW4d1wS8uC2kGqkTa", "Auth Contract"],
  );

  const sessionIds = [1, 2, 3].map(() => crypto.randomBytes(32).toString("hex"));
  for (const sessionId of sessionIds) {
    const result = (await client.query(
      "SELECT public.issue_user_auth_session($1,$2,$3,$4,$5::timestamptz) AS result",
      [userId, sessionId, "fixture-ip-hash", "fixture-user-agent-hash", new Date(Date.now() + 86_400_000).toISOString()],
    )).rows[0].result;
    assert.equal(result.ok, true);
  }

  const rows = (await client.query(
    `SELECT session_id, revoked_at, revoke_reason FROM public.user_auth_sessions
     WHERE user_id=$1 ORDER BY created_at,id`,
    [userId],
  )).rows;
  assert.equal(rows.length, 3);
  const bySession = new Map(rows.map((row) => [row.session_id, row]));
  assert.equal(bySession.get(sessionIds[0])?.revoke_reason, "concurrency_limit");
  assert.ok(bySession.get(sessionIds[0])?.revoked_at);
  assert.equal(bySession.get(sessionIds[1])?.revoked_at, null);
  assert.equal(bySession.get(sessionIds[2])?.revoked_at, null);

  const revoke = (await client.query(
    "SELECT public.revoke_user_auth_session($1,$2,$3) AS result",
    [userId, sessionIds[1], "logout"],
  )).rows[0].result;
  assert.equal(revoke.ok, true);
  assert.equal(revoke.revoked, true);
  assert.equal(revoke.latestSessionId, sessionIds[2]);
  const remaining = await client.query(
    "SELECT session_id FROM public.user_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()",
    [userId],
  );
  assert.deepEqual(remaining.rows.map((row) => row.session_id), [sessionIds[2]]);

  await client.query("UPDATE public.users SET session_id=NULL WHERE id=$1", [userId]);
  const activeAfterCredentialReset = await client.query(
    "SELECT 1 FROM public.user_auth_sessions WHERE user_id=$1 AND revoked_at IS NULL",
    [userId],
  );
  assert.equal(activeAfterCredentialReset.rowCount, 0);

  await client.query("ROLLBACK");
  transactionOpen = false;
  const report = {
    passed: true,
    checkedAt: new Date().toISOString(),
    target: "127.0.0.1:54322/zimeiti_local",
    assertions: {
      firstTwoRemainActive: true,
      thirdLoginRevokesOldestOnly: true,
      logoutRevokesCurrentOnly: true,
      credentialResetRevokesAll: true,
      transactionRolledBack: true,
    },
    providerRequests: 0,
  };
  const evidenceDir = path.resolve(".codex-evidence", "auth-two-session");
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, "database-contract.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
