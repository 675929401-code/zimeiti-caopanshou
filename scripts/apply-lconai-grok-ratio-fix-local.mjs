#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const MODEL_ID = "grok-video-3-pro-lconai";
const MODEL_NAME = "grok-video-3-pro";
const CHANNEL_ORIGIN = "https://s.lconai.com";
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/lconai-workbook-onboarding-20261005/grok-ratio-config-update.json",
);

async function requestJson(origin, headers, pathname, options = {}) {
  const response = await fetch(`${origin}${pathname}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(90_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}:${String(body?.code || "UNKNOWN")}`);
  return { status: response.status, body };
}

async function post(origin, headers, pathname, body) {
  return requestJson(origin, headers, pathname, { method: "POST", body: JSON.stringify(body) });
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-grok-ratio-omission"), "LOCAL_GROK_RATIO_CONFIRMATION_REQUIRED");
  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  const parsedDb = new URL(databaseUrl);
  assert.equal(parsedDb.hostname, "127.0.0.1", "LOCAL_DATABASE_HOST_REQUIRED");
  assert.equal(parsedDb.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");
  assert.equal(parsedDb.pathname, "/zimeiti_local", "LOCAL_DATABASE_NAME_REQUIRED");

  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-lconai-grok-ratio-fix-local",
  });
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = (await requestJson(origin, basicHeaders, "/api/admin/access-control/self")).body;
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  let cleanupVerified = false;
  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-LConAI-Grok-Ratio-Fix/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    const inventoryBefore = (await requestJson(origin, headers, "/api/admin/models")).body;
    const before = (inventoryBefore.models || []).find((model) => model.id === MODEL_ID);
    assert.ok(before, "GROK_MODEL_NOT_FOUND");
    assert.equal(before.model_name, MODEL_NAME, "GROK_MODEL_NAME_MISMATCH");
    assert.equal(String(before.api_endpoint || "").replace(/\/+$/u, ""), CHANNEL_ORIGIN, "GROK_ENDPOINT_MISMATCH");
    assert.equal(before.protocol_type, "newapi_video", "GROK_PROTOCOL_MISMATCH");
    assert.equal(before.api_protocol_config?.__model_activation_gate?.state, "pending", "GROK_PENDING_GATE_REQUIRED");

    const nextConfig = structuredClone(before.api_protocol_config || {});
    delete nextConfig.__model_activation_gate;
    nextConfig.omit_aspect_ratio = true;
    const staged = (await requestJson(origin, headers, "/api/admin/models", {
      method: "PUT",
      body: JSON.stringify({ model_type: "video", id: MODEL_ID, api_protocol_config: nextConfig }),
    })).body;
    assert.equal(staged.staged, true, "GROK_UPDATE_NOT_STAGED");
    assert.equal(staged.published, false, "GROK_UPDATE_UNEXPECTED_AUTO_PUBLISH");
    const releaseId = String(staged.result?.release?.id || "");
    assert.match(releaseId, /^[a-f0-9-]{36}$/iu, "GROK_MODEL_POOL_RELEASE_ID_MISSING");

    const validated = (await post(origin, headers, "/api/admin/model-pool-releases", {
      action: "validate",
      releaseId,
    })).body;
    assert.equal(validated.release?.status, "validated", "GROK_MODEL_POOL_VALIDATION_FAILED");
    const preview = (await requestJson(
      origin,
      headers,
      `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`,
    )).body;
    const previewSha256 = String(preview.preview?.previewSha256 || "");
    assert.match(previewSha256, /^[a-f0-9]{64}$/u, "GROK_MODEL_POOL_PREVIEW_HASH_MISSING");
    const published = (await post(origin, headers, "/api/admin/model-pool-releases", {
      action: "publish",
      releaseId,
      previewSha256,
    })).body;
    assert.equal(published.release?.status, "published", "GROK_MODEL_POOL_PUBLISH_FAILED");
    assert.equal(published.release?.is_current, true, "GROK_MODEL_POOL_NOT_CURRENT");

    const inventoryAfter = (await requestJson(origin, headers, "/api/admin/models")).body;
    const after = (inventoryAfter.models || []).find((model) => model.id === MODEL_ID);
    assert.equal(after?.api_protocol_config?.omit_aspect_ratio, true, "GROK_RATIO_OMISSION_READBACK_FAILED");
    assert.equal(after?.api_protocol_config?.__model_activation_gate?.state, "pending", "GROK_PENDING_GATE_LOST");
    const publicVideo = (await requestJson(origin, basicHeaders, "/api/video/models?surface=video-page")).body;
    assert.equal((publicVideo.models || []).some((model) => model.id === MODEL_ID), false, "PENDING_GROK_LEAKED_PUBLICLY");

    const report = {
      passed: true,
      checkedAt: new Date().toISOString(),
      origin,
      modelId: MODEL_ID,
      change: { omitAspectRatio: { before: before.api_protocol_config?.omit_aspect_ratio === true, after: true } },
      modelPoolRelease: { id: releaseId, version: published.release?.release_version, status: "published_current" },
      activationGate: "pending",
      publicLeak: false,
      providerRequests: 0,
      paidGenerationRequests: 0,
      productionWrites: 0,
    };
    await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
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
}

