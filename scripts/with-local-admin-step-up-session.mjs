#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";

const target = process.argv[2];
const args = process.argv.slice(3);

export async function main() {
  assert.ok(target && target.startsWith("scripts/") && !target.includes(".."), "A workspace script target is required");
  const absoluteTarget = path.resolve(process.cwd(), target);
  const scriptsRoot = `${path.resolve(process.cwd(), "scripts")}${path.sep}`;
  assert.ok(absoluteTarget.startsWith(scriptsRoot) && path.extname(absoluteTarget) === ".mjs", "Only scripts/*.mjs targets are allowed");

  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const adminToken = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(adminToken && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  const parsedDb = new URL(databaseUrl);
  assert.equal(parsedDb.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDb.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDb.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const selfResponse = await fetch(`${origin}/api/admin/access-control/self`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const self = await selfResponse.json().catch(() => ({}));
  assert.ok(selfResponse.ok, `ADMIN_ACCESS_CONTEXT_HTTP_${selfResponse.status}`);
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");

  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-local-admin-step-up-wrapper",
  });
  let cleanupVerified = false;
  let childStatus = 1;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-Local-Step-Up-Wrapper/1.0',now()+interval '30 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    const result = spawnSync(process.execPath, [...process.execArgv, absoluteTarget, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, LOCAL_ADMIN_STEP_UP_TOKEN: stepUpToken },
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    childStatus = result.status ?? 1;
  } finally {
    try {
      await database.query("BEGIN");
      await database.query("SELECT set_config('app.admin_governance_write','on',true)");
      await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
      await database.query("COMMIT");
      const remaining = await database.query(
        "SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1",
        [stepUpHash],
      );
      cleanupVerified = Number(remaining.rows[0]?.count || 0) === 0;
    } catch {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    await database.end().catch(() => undefined);
  }
  assert.equal(cleanupVerified, true, "TEMPORARY_STEP_UP_CLEANUP_FAILED");
  process.exitCode = childStatus;
}
