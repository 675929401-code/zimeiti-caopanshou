#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import pg from "pg";

const runtimePath = process.env.LOCAL_ACCEPTANCE_RUNTIME_PATH?.trim()
  || "F:/总项目文件/Skill存储系统/运行数据/自媒体操盘手/local-data-20260902/config/runtime.json";
const runtime = JSON.parse((await fs.readFile(runtimePath, "utf8")).replace(/^\uFEFF/u, ""));
const connection = runtime.ownerConnection;
assert.equal(runtime.localOnly, true);
assert.equal(connection?.host, "127.0.0.1");
assert.equal(Number(connection?.port), 54322);
assert.equal(connection?.database, "zimeiti_local");
const db = new pg.Client({ ...connection, application_name: "codex-auth-session-coexistence-sql", connectionTimeoutMillis: 10_000 });
const [firstOwner, secondOwner] = [randomUUID(), randomUUID()];
const issuedSessions = [];

await db.connect();
try {
  const { rows: [identity] } = await db.query("SELECT current_database() AS name, inet_server_port() AS port");
  assert.equal(identity.name, "zimeiti_local");
  assert.equal(Number(identity.port), 54322);
  await db.query("BEGIN");
  try {
    for (const id of [firstOwner, secondOwner]) {
      await db.query(
        "INSERT INTO public.users(id,username,password_hash,display_name,role,credits,is_active,status) VALUES($1,$2,'fixture','本地验收','student',0,true,'active')",
        [id, "authqa_" + randomBytes(6).toString("hex")],
      );
    }
    for (const [owner, count] of [[firstOwner, 9], [secondOwner, 3]]) {
      for (let index = 0; index < count; index++) {
        const session = randomBytes(32).toString("hex");
        const { rows: [{ result }] } = await db.query(
          "SELECT public.issue_user_auth_session($1,$2,$3,$4,now()+interval '1 day') AS result",
          [owner, session, "qa-ip-" + (index % 3), "qa-browser-" + index],
        );
        assert.equal(result.ok, true);
        assert.equal(result.activeCount, index + 1);
        assert.equal(result.evictedCount, 0);
        issuedSessions.push(session);
      }
    }

    const { rows: [{ result }] } = await db.query("SELECT public.revoke_user_auth_session($1,$2,'logout') AS result", [firstOwner, issuedSessions[0]]);
    assert.equal(result.ok, true);
    const { rows: active } = await db.query(
      "SELECT session_id FROM public.user_auth_sessions WHERE user_id=ANY($1::text[]) AND revoked_at IS NULL",
      [[firstOwner, secondOwner]],
    );
    assert.deepEqual(new Set(active.map(row => row.session_id)), new Set(issuedSessions.slice(1)));
  } finally {
    await db.query("ROLLBACK");
  }
  const { rowCount } = await db.query("SELECT id FROM public.users WHERE id=ANY($1::text[])", [[firstOwner, secondOwner]]);
  assert.equal(rowCount, 0);
  console.log(JSON.stringify({ passed: true, sessionsIssued: issuedSessions.length, loginEvictions: 0, explicitRevocations: 1, rolledBack: true }));
} finally {
  await db.end();
}
