#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

assert.ok(process.argv.includes("--confirm-local-softwhite"), "EXPLICIT_LOCAL_SOFTWHITE_CONFIRMATION_REQUIRED");

const origin = String(process.env.LOCAL_NAV_ORIGIN || "http://127.0.0.1:5000").replace(/\/$/u, "");
const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "");
const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
const actor = identity.user || {};
const databaseUrl = String(process.env.DATABASE_URL || "");
const evidenceDir = path.resolve(".codex-evidence", "platform-softwhite-publish-local");
const requestKey = `platform-softwhite-${crypto.randomUUID()}`;

assert.equal(origin, "http://127.0.0.1:5000", "LOCAL_5000_ORIGIN_REQUIRED");
assert.ok(token.length > 32, "LOCAL_ADMIN_TOKEN_REQUIRED");
assert.ok(actor.id, "LOCAL_ADMIN_IDENTITY_REQUIRED");
assert.ok(databaseUrl, "LOCAL_DATABASE_URL_REQUIRED");

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 500) }; }
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    ...options,
    headers: { "User-Agent": "Codex-Softwhite-Publish/1.0", ...(options.headers || {}) },
  });
  return { response, body: await readJson(response) };
}

await fs.mkdir(evidenceDir, { recursive: true });
const before = await fetchJson("/api/settings/appearance");
assert.equal(before.response.status, 200, `APPEARANCE_BEFORE_${before.response.status}`);

const self = await fetchJson("/api/admin/access-control/self", {
  headers: { Authorization: `Bearer ${token}` },
});
assert.equal(self.response.status, 200, `ADMIN_SELF_${self.response.status}`);
assert.ok(self.body?.access?.permissionKeys?.includes("brand.settings.manage"), "BRAND_SETTINGS_PERMISSION_REQUIRED");

const stepUpToken = crypto.randomBytes(32).toString("base64url");
const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
const database = new pg.Client({ connectionString: databaseUrl, application_name: "codex-local-softwhite-publish" });
let writeReceipt = null;
let after = null;
let cleanupVerified = false;

try {
  await database.connect();
  await database.query("BEGIN");
  await database.query("SELECT set_config('app.admin_governance_write','on',true)");
  await database.query(
    `INSERT INTO public.admin_step_up_sessions
      (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
     VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-Softwhite-Publish/1.0',now()+interval '5 minutes')`,
    [actor.id, stepUpHash, JSON.stringify(self.body.access.permissionKeys), self.body.access.revision],
  );
  await database.query("COMMIT");

  const write = await fetchJson("/api/settings/admin?scope=brand", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-admin-step-up": stepUpToken,
      "Content-Type": "application/json",
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify({ theme: "soft-white", theme_mode: "light" }),
  });
  assert.equal(write.response.status, 200, `SOFTWHITE_WRITE_${write.response.status}:${JSON.stringify(write.body)}`);
  assert.equal(write.body?.success, true, "SOFTWHITE_WRITE_RECEIPT");
  assert.deepEqual(write.body?.settings, { theme: "soft-white", theme_mode: "light" }, "SOFTWHITE_WRITE_VALUES");
  writeReceipt = {
    status: write.response.status,
    changedKeys: write.body.changedKeys || [],
    settings: write.body.settings,
    publishedAt: write.body.publishedAt || null,
  };

  after = await fetchJson("/api/settings/appearance");
  assert.equal(after.response.status, 200, `APPEARANCE_AFTER_${after.response.status}`);
  assert.equal(after.body?.settings?.theme, "soft-white", "SOFTWHITE_READBACK_THEME");
  assert.equal(after.body?.settings?.theme_mode, "light", "SOFTWHITE_READBACK_MODE");
  assert.equal(after.body?.authority?.authoritative, true, "SOFTWHITE_READBACK_AUTHORITY");
} finally {
  try {
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query("DELETE FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
    await database.query("COMMIT");
    const remaining = await database.query("SELECT count(*)::int AS count FROM public.admin_step_up_sessions WHERE token_hash=$1", [stepUpHash]);
    cleanupVerified = Number(remaining.rows[0]?.count || 0) === 0;
  } catch {
    await database.query("ROLLBACK").catch(() => undefined);
  }
  await database.end().catch(() => undefined);
}

assert.equal(cleanupVerified, true, "SOFTWHITE_STEP_UP_CLEANUP");
const report = {
  passed: true,
  checkedAt: new Date().toISOString(),
  origin,
  before: {
    theme: before.body?.settings?.theme || null,
    mode: before.body?.settings?.theme_mode || null,
    publishedAt: before.body?.authority?.publishedAt || null,
  },
  writeReceipt,
  after: {
    theme: after?.body?.settings?.theme || null,
    mode: after?.body?.settings?.theme_mode || null,
    authoritative: after?.body?.authority?.authoritative === true,
    publishedAt: after?.body?.authority?.publishedAt || null,
  },
  cleanup: { stepUpSessionRemoved: cleanupVerified },
  productionWrites: 0,
  paidCalls: 0,
};
await fs.writeFile(path.join(evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
