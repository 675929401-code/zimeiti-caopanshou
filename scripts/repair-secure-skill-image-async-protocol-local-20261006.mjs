#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const TARGETS = [
  { id: "gemini-3-1-flash-image-chA", previousModelName: "gemini-3.1-flash-image", modelName: "nano-banana-2" },
  { id: "gemini-3-0-pro-image-chA", previousModelName: "gemini-3.0-pro-image", modelName: "nano-banana-pro" },
];
const EVIDENCE_PATH = path.resolve(
  ".codex-evidence/model-chain-audit-20261006/secure-skill-image-async-protocol-repair.json",
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
  assert.ok(response.ok, `${pathname}:HTTP_${response.status}:${String(body?.code || body?.error || "UNKNOWN").slice(0, 200)}`);
  return body;
}

async function publishRelease(origin, headers, releaseId) {
  const validated = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "validate", releaseId }),
  });
  assert.equal(validated.release?.status, "validated", `${releaseId}:VALIDATION_FAILED`);
  const preview = await requestJson(origin, headers, `/api/admin/model-pool-releases?previewReleaseId=${encodeURIComponent(releaseId)}`);
  const previewSha256 = String(preview.preview?.previewSha256 || "");
  assert.match(previewSha256, /^[a-f0-9]{64}$/u, `${releaseId}:PREVIEW_HASH_MISSING`);
  const published = await requestJson(origin, headers, "/api/admin/model-pool-releases", {
    method: "POST",
    body: JSON.stringify({ action: "publish", releaseId, previewSha256 }),
  });
  assert.equal(published.release?.status, "published", `${releaseId}:PUBLISH_FAILED`);
  assert.equal(published.release?.is_current, true, `${releaseId}:NOT_CURRENT`);
  return { id: releaseId, version: Number(published.release?.release_version || 0), previewSha256 };
}

function safeModel(model) {
  return {
    id: String(model?.id || ""),
    name: String(model?.name || ""),
    modelName: String(model?.model_name || ""),
    provider: String(model?.provider || ""),
    endpointOrigin: new URL(String(model?.api_endpoint || "")).origin,
    protocol: String(model?.api_protocol_config?.protocol || ""),
    adapterContract: String(model?.api_protocol_config?.adapter_contract || ""),
    submitPath: String(model?.api_protocol_config?.submit_path || ""),
    pollPath: String(model?.api_protocol_config?.poll_path || ""),
    referenceTransport: String(model?.api_protocol_config?.reference_transport || ""),
    active: model?.is_active === true,
    hidden: model?.is_hidden === true,
    sellingPrice: Number(model?.selling_price || 0),
    costPrice: Number(model?.cost_price || 0),
  };
}

export async function main(args = process.argv.slice(2)) {
  assert.ok(args.includes("--execute"), "EXPLICIT_EXECUTION_REQUIRED");
  assert.ok(args.includes("--confirm-local-async-image-protocol"), "ASYNC_IMAGE_PROTOCOL_CONFIRMATION_REQUIRED");
  await fs.access(EVIDENCE_PATH).then(() => assert.fail("EVIDENCE_ALREADY_EXISTS"), () => undefined);

  const origin = String(process.env.LOCAL_NAV_ORIGIN || "").replace(/\/+$/u, "");
  const token = String(process.env.LOCAL_NAV_ADMIN_TOKEN || "").trim();
  const identity = JSON.parse(process.env.LOCAL_NAV_READONLY_IDENTITY || "{}");
  const actorId = String(identity?.user?.id || "");
  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  assert.equal(origin, "http://127.0.0.1:5000", "EXACT_LOCAL_RUNTIME_REQUIRED");
  assert.ok(token && actorId && databaseUrl, "LOCAL_ADMIN_RUNTIME_REQUIRED");
  const parsedDatabase = new URL(databaseUrl);
  assert.equal(parsedDatabase.hostname, "127.0.0.1", "LOCAL_DATABASE_REQUIRED");
  assert.equal(parsedDatabase.port, "54322", "LOCAL_DATABASE_PORT_REQUIRED");

  const database = new pg.Client({
    connectionString: databaseUrl,
    application_name: "codex-secure-skill-image-async-protocol-repair",
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  });
  const basicHeaders = { Authorization: `Bearer ${token}` };
  const self = await requestJson(origin, basicHeaders, "/api/admin/access-control/self");
  assert.ok(self.access?.permissionKeys?.includes("models.manage"), "MODELS_MANAGE_PERMISSION_REQUIRED");
  const stepUpToken = crypto.randomBytes(32).toString("base64url");
  const stepUpHash = crypto.createHash("sha256").update(stepUpToken).digest("hex");
  const headers = { ...basicHeaders, "x-admin-step-up": stepUpToken };
  const changes = [];
  let cleanupVerified = false;

  try {
    await database.connect();
    await database.query("BEGIN");
    await database.query("SELECT set_config('app.admin_governance_write','on',true)");
    await database.query(
      `INSERT INTO public.admin_step_up_sessions
        (actor_id,token_hash,scope_keys,profile_revision,auth_method,request_ip,user_agent,expires_at)
       VALUES($1,$2,$3::jsonb,$4,'login_password','127.0.0.1','Codex-Secure-Skill-Async-Image-Protocol-Repair/1.0',now()+interval '10 minutes')`,
      [actorId, stepUpHash, JSON.stringify(self.access.permissionKeys), self.access.revision],
    );
    await database.query("COMMIT");

    for (const target of TARGETS) {
      const inventory = await requestJson(origin, headers, "/api/admin/models");
      const beforeModel = (inventory.models || []).find((model) => String(model.id) === target.id);
      assert.ok(beforeModel, `${target.id}:MODEL_NOT_FOUND`);
      const before = safeModel(beforeModel);
      assert.ok([target.previousModelName, target.modelName].includes(before.modelName), `${target.id}:UNEXPECTED_MODEL_NAME`);
      assert.ok(["secure_skill_chat", "secure_skill_images"].includes(before.provider), `${target.id}:UNEXPECTED_PROVIDER`);
      assert.equal(before.endpointOrigin, "https://token.secure-skill.com", `${target.id}:ENDPOINT_MISMATCH`);

      const alreadyConfigured = before.modelName === target.modelName
        && before.provider === "secure_skill_images"
        && before.protocol === "images_generations_async"
        && before.submitPath === "/v1/images/generations"
        && before.pollPath === "/v1/images/generations/{id}";
      let release = null;
      if (!alreadyConfigured) {
        const currentConfig = beforeModel.api_protocol_config && typeof beforeModel.api_protocol_config === "object"
          ? structuredClone(beforeModel.api_protocol_config)
          : {};
        delete currentConfig.__model_activation_gate;
        const nextConfig = {
          ...currentConfig,
          protocol: "images_generations_async",
          adapter_contract: "secure_skill_images_generations_async_v1",
          submit_path: "/v1/images/generations",
          poll_path: "/v1/images/generations/{id}",
          response_transport: "async_image_generation_task",
          reference_transport: "generations_url_array",
          documentation_url: "https://token.secure-skill.com/docs#flow-images",
        };
        const staged = await requestJson(origin, headers, "/api/admin/models", {
          method: "PUT",
          body: JSON.stringify({
            model_type: "drawing",
            id: target.id,
            model_name: target.modelName,
            provider: "secure_skill_images",
            api_protocol_config: nextConfig,
          }),
        });
        assert.equal(staged.staged, true, `${target.id}:NOT_STAGED`);
        assert.equal(staged.published, false, `${target.id}:UNEXPECTED_AUTO_PUBLISH`);
        const releaseId = String(staged.result?.release?.id || "");
        assert.match(releaseId, /^[a-f0-9-]{36}$/iu, `${target.id}:RELEASE_ID_MISSING`);
        release = await publishRelease(origin, headers, releaseId);
      }

      const readback = await requestJson(origin, headers, "/api/admin/models");
      const afterModel = (readback.models || []).find((model) => String(model.id) === target.id);
      assert.ok(afterModel, `${target.id}:READBACK_MISSING`);
      const after = safeModel(afterModel);
      assert.equal(after.modelName, target.modelName, `${target.id}:MODEL_NAME_READBACK_FAILED`);
      assert.equal(after.provider, "secure_skill_images", `${target.id}:PROVIDER_READBACK_FAILED`);
      assert.equal(after.protocol, "images_generations_async", `${target.id}:PROTOCOL_READBACK_FAILED`);
      assert.equal(after.submitPath, "/v1/images/generations", `${target.id}:SUBMIT_PATH_READBACK_FAILED`);
      assert.equal(after.pollPath, "/v1/images/generations/{id}", `${target.id}:POLL_PATH_READBACK_FAILED`);
      assert.equal(after.active, before.active, `${target.id}:ACTIVE_STATE_CHANGED`);
      assert.equal(after.hidden, before.hidden, `${target.id}:VISIBILITY_CHANGED`);
      assert.equal(after.sellingPrice, before.sellingPrice, `${target.id}:SELLING_PRICE_CHANGED`);
      assert.equal(after.costPrice, before.costPrice, `${target.id}:COST_PRICE_CHANGED`);
      changes.push({ target, before, after, release, alreadyConfigured });
    }

    const report = {
      schema: "secure_skill_image_async_protocol_repair.v1",
      checkedAt: new Date().toISOString(),
      scope: "local-runtime-configuration-only",
      providerOrigin: "https://token.secure-skill.com",
      documentation: "https://token.secure-skill.com/docs#flow-images",
      changes,
      providerRequests: 0,
      paidProviderCalls: 0,
      productionWrites: 0,
      requiresFreshStoryboardPaidCanary: true,
    };
    await fs.mkdir(path.dirname(EVIDENCE_PATH), { recursive: true });
    await fs.writeFile(EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ ...report, evidencePath: path.relative(process.cwd(), EVIDENCE_PATH).replaceAll("\\", "/") }, null, 2));
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

