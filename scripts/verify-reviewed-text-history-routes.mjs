#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

// Execute the actual routes with no filesystem, network, provider or database
// capabilities in the VM. Only the transaction and authentication are fixtures.
const now = Date.parse("2026-11-04T00:16:00Z");
class FixtureDate extends Date { static now() { return now; } }
function load(file, modules) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(compiled, { exports, URL, Date: FixtureDate, process: { env: { NODE_ENV: "production" } },
    require(id) { assert.ok(Object.hasOwn(modules, id), `UNEXPECTED_IMPORT:${id}`); return modules[id]; } });
  return exports;
}
const gate = load("src/lib/llm-model-validation-gate.ts", {
  "node:crypto": crypto, "./model-activation-gate": { PENDING_TEXT_USER_ACCESS: "pending_model_activation" },
});
const history = load("src/lib/server/text-model-reviewed-history.ts", { "../llm-model-validation-gate": gate });
const target = history.REVIEWED_TEXT_HISTORY;
const body = { id: target.modelId, model_type: "text", reviewedHistory: {
  evidenceSha256: target.evidenceSha256, requestKey: history.REVIEWED_HISTORY_REQUEST_KEY,
} };
const actorId = "00000000-0000-4000-8000-000000000001";
const auditId = "00000000-0000-4000-8000-000000000002";
const createdAt = new Date(now).toISOString();

function fixture({ maintenance = false, password = "login_password", mismatchedHash = false, tamperReceipt = false } = {}) {
  const model = { id: target.modelId, model_name: "deepseek-flash", api_key: "fixture-only",
    is_active: false, is_hidden: false, user_access: "pending_model_activation", updated_at: createdAt };
  let audit = null;
  let writes = 0;
  let saved = null;
  const db = {
    from(table) {
      const query = {
        select: () => query, eq: () => query, order: () => query, limit: () => query,
        then(yes, no) {
          const rows = { llm_models: [{ ...model }], llm_model_validation_evidence: saved ? [saved] : [],
            cover_models: [], video_models: [], image_model_validations: [], video_channel_health: [],
            platform_model_credential_bindings: [{ model_key: `llm_models:${target.modelId}`, updated_at: createdAt }] };
          assert.ok(Object.hasOwn(rows, table));
          return Promise.resolve({ data: rows[table] }).then(yes, no);
        },
        maybeSingle: async () => {
          if (table === "llm_models") return { data: { ...model } };
          if (table === "admin_governance_audit") return { data: audit };
          if (table === "llm_model_validation_evidence") return { data: saved };
          assert.fail(`UNEXPECTED_TABLE:${table}`);
        },
      };
      return query;
    },
    async rpc(name, args) {
      if (name === "read_agent_catalog_model_guard_v1") return { data: { poolCount: 1, rowVersion: "7" } };
      assert.equal(name, "activate_reviewed_deepseek_history_v1");
      assert.equal(args.p_expected_row_version, "7");
      assert.equal(args.p_model_id, target.modelId);
      assert.equal(args.p_agent_id, target.agentId);
      assert.equal(args.p_configuration_hash, target.configurationHash);
      const idempotent = Boolean(audit);
      if (!audit) {
        writes++;
        audit = { id: auditId, actor_id: actorId, actor_level: "super_admin", permission_key: "models.manage",
          action: "accept_reviewed_text_history", result: "success", reason_code: "THREE_LOCAL_SETTLED_TEXT_REQUESTS",
          resource: target.modelId, request_key: body.reviewedHistory.requestKey, request_path: "/api/admin/models/activate",
          request_method: "POST", created_at: createdAt, metadata: { ...target } };
        Object.assign(model, { is_active: true, user_access: "available" });
      }
      return { data: { activated: true, idempotent, acceptance: {
        id: tamperReceipt ? "wrong" : auditId, source: target.source, checkedAt: target.checkedAt, auditCreatedAt: createdAt,
      } } };
    },
  };
  const modules = {
    "node:crypto": crypto,
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    "@/lib/server/admin-governance-authority": {
      authorizeAdminCapability: async () => ({ ok: true, actor: { userId: actorId }, access: {
        adminLevel: "super_admin", authorityStatus: "ready", profileActive: true, integrityValid: true, revision: 3, checksum: "fixture",
      }, stepUp: { status: "ready", authMethod: password, sessionId: "fixture-session" },
      maintenanceLock: { status: "ready", enabled: maintenance } }),
      getAdminStepUpToken: () => "fixture", hashAdminStepUpToken: () => "a".repeat(64),
    },
    "@/lib/model-activation-gate": { ModelActivationGateError: class extends Error {} },
    "@/lib/llm-model-validation-gate": { ...gate,
      // The real credential fingerprint is never available to offline fixtures.
      llmModelValidationConfigurationHash: () => mismatchedHash ? "b".repeat(64) : target.configurationHash },
    "@/lib/provider-secret": { resolveProviderSecret: () => "fixture-only" },
    "@/lib/server/platform-configuration-compatibility": { assertPublishedModelPoolEntry: async () => ({}) },
    "@/lib/server/platform-configuration-admin": { PlatformConfigurationError: class extends Error {} },
    "@/storage/database/supabase-client": { getSupabaseAdminClient: () => db },
    "@/storage/database/configuration-source": { sharedConfigurationConnection: () => null },
    "@/lib/server/text-model-reviewed-history": history,
  };
  const route = load("src/app/api/admin/models/activate/route.ts", modules);
  const health = load("src/app/api/admin/credential-health/route.ts", modules);
  return {
    writes: () => writes,
    async health() {
      const response = await health.GET({});
      assert.equal(response.status, 200);
      return (await response.json()).credentials[0];
    },
    async request(payload, origin = "https://zyuani8.com") {
      const response = await route.POST({ json: async () => payload, nextUrl: new URL("https://zyuani8.com/api/admin/models/activate"),
        headers: new Headers({ host: "zyuani8.com", origin }) });
      return { status: response.status, data: await response.json() };
    },
    setSaved() {
      Object.assign(model, { is_active: true, user_access: "available" });
      saved = { id: "saved-proof", model_id: model.id, configuration_hash: gate.llmModelValidationConfigurationHash(model, "fixture-only"),
        checked_at: target.checkedAt };
    },
  };
}

test("explicit owner adoption returns historical provenance and no credential or instruction receipt", async () => {
  const state = fixture();
  for (const idempotent of [false, true]) {
    const { status, data } = await state.request(body);
    assert.equal(status, 200);
    assert.equal(data.activated, true);
    assert.equal(data.idempotent, idempotent);
    assert.equal(data.operationalAdmission.auditId, auditId);
    assert.equal(data.operationalAdmission.source, target.source);
    assert.equal(data.evidence_id, undefined);
    assert.equal(data.model.api_key, undefined);
  }
  assert.equal(state.writes(), 1);
});

test("original managed route neither adopts historical proof on its own nor changes its success shape", async () => {
  const state = fixture();
  const ordinary = { id: target.modelId, model_type: "text" };
  assert.equal((await state.request(ordinary)).data.code, "TEXT_MODEL_VALIDATION_EVIDENCE_REQUIRED");
  state.setSaved();
  const { status, data } = await state.request(ordinary);
  assert.equal(status, 200);
  assert.equal(data.evidence_id, "saved-proof");
  assert.equal(data.operationalAdmission, undefined);
  assert.equal(state.writes(), 0);
});

test("ordinary privilege, maintenance bypass, changed configuration, cross-origin and wrong ID are denied before mutation", async () => {
  for (const [options, payload, origin, code] of [
    [{ password: "management_password" }, body, undefined, "REVIEWED_HISTORY_OWNER_REQUIRED"],
    [{ maintenance: true }, body, undefined, "REVIEWED_HISTORY_OWNER_REQUIRED"],
    [{ mismatchedHash: true }, body, undefined, "REVIEWED_HISTORY_CONFIGURATION_CHANGED"],
    [{}, { ...body, id: "other" }, undefined, "REVIEWED_HISTORY_REQUEST_INVALID"],
    [{}, body, "https://other.invalid", "REVIEWED_HISTORY_DESTINATION_REQUIRED"],
  ]) {
    const state = fixture(options);
    assert.equal((await state.request(payload, origin)).data.code, code);
    assert.equal(state.writes(), 0);
  }
});

test("mismatched transaction readback cannot be reported as completed", async () => {
  const state = fixture({ tamperReceipt: true });
  assert.equal((await state.request(body)).data.code, "REVIEWED_HISTORY_READBACK_REQUIRED");
  assert.equal(state.writes(), 1);
});

test("health shows the adopted business history without upgrading instruction validation status", async () => {
  const state = fixture();
  const before = await state.health();
  assert.equal(before.validationStatus, "unverified");
  assert.equal(before.operationalAdmission, null);
  assert.equal((await state.request(body)).status, 200);
  const after = await state.health();
  assert.equal(after.validationStatus, "unverified");
  assert.equal(after.lastValidatedAt, null);
  assert.equal(after.operationalAdmission.source, target.source);
  assert.equal(after.operationalAdmission.checkedAt, target.checkedAt);
  assert.match(after.validationExplanation, /三笔成功且已结算/u);
  assert.equal(after.historicalAdmissionReadFailed, false);
  assert.equal(JSON.stringify(after).includes("fixture-only"), false);
  assert.equal(JSON.stringify(after).includes(target.configurationHash), false);
});
