#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

// Actual parent repository, domain/prompts, preparation service, HTTP handlers
// and generation guard; DB/auth/catalog/LLM/storage are isolated fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerA = "00000000-0000-4000-8000-000000000001";
const ownerB = "00000000-0000-4000-8000-000000000002";
const referenceId = "00000000-0000-4000-8000-000000000003";
const sha = value => createHash("sha256").update(value).digest("hex");
const clone = value => structuredClone(value);
const fields = ["topic", "primaryTitle", "secondaryTitle", "visualBrief.subject", "visualBrief.action", "visualBrief.scene", "visualBrief.emotion"];
const checks = [];
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }

function harness() {
  const state = { owner: ownerA, gatewayCalls: 0, gatewayBodies: [], storageReads: 0, signedUrls: 0, mode: "success", tableReads: [], parents: [], children: [], settings: [], modelRevision: 0, modelResolutions: 0 };
  const imageModel = { id: "pm_fixture_image", displayName: "Fixture image", publicPrice: 0.1, capabilities: {
    available: true, generationReady: true, protocolBindingReady: true, priceReady: true,
    supportsReferenceInput: true, referenceInputMode: "multi", maxReferenceImages: 3,
    aspectRatios: ["16:9", "9:16", "4:3", "3:4"], resolutionOptions: ["2K", "4K"], defaultResolution: "2K", resolutionPrices: ["2K=0.1", "4K=0.2"],
  } };
  const imageModels = [imageModel, { ...imageModel, id: "pm_fixture_image_alt", displayName: "Fixture alternate", publicPrice: 0.3,
    capabilities: { ...imageModel.capabilities, resolutionPrices: ["2K=0.3", "4K=0.6"] } }];
  const assets = [{ id: referenceId, user_id: ownerA, storage_key: "fixture/reference.png", storage_provider: "tencent_cos",
    file_category: "image", content_type: "image/png", file_size: 32 }];
  const table = name => name === "cover_prepare_operations" ? state.parents : name === "llm_request_attempts" ? state.children
    : name === "llm_models" ? [{ id: "fixture-text" }] : name === "platform_settings" ? state.settings : name === "cover_generation_attempts" ? [] : name === "user_files" ? assets : assert.fail(`Unexpected table ${name}`);
  const db = { from(name) {
    state.tableReads.push(name);
    const filters = [], orders = []; let action = "select", payload, options, cap, rangeStart = 0, rangeEnd;
    const run = single => {
      const rows = table(name);
      if (action === "insert") {
        assert.equal(name, "cover_prepare_operations");
        if (rows.some(row => row.id === payload.id || row.user_id === payload.user_id && row.client_request_id === payload.client_request_id)) return { data: null, error: { code: "23505" } };
        rows.push(clone(payload)); return { data: clone(payload), error: null };
      }
      if (action === "upsert") {
        assert.equal(name, "cover_prepare_operations"); assert.equal(options.ignoreDuplicates, true);
        const old = rows.find(row => row.user_id === payload.user_id && row.client_request_id === payload.client_request_id);
        if (!old) rows.push({ id: randomUUID(), state: "prepared", result: null, billing: {}, consent: null,
          analysis_attempt_id: null, error_code: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...clone(payload) });
        return { data: null, error: null };
      }
      const field = (row, key) => key.includes("->>") ? row[key.split("->>")[0]]?.[key.split("->>")[1]] : row[key];
      let matched = rows.filter(row => filters.every(([key, value, operation]) => operation === "in" ? value.includes(field(row, key)) : field(row, key) === value));
      for (const [key, order] of orders.toReversed()) matched.sort((left, right) => String(field(left, key)).localeCompare(String(field(right, key))) * (order.ascending === false ? -1 : 1));
      if (rangeEnd !== undefined) matched = matched.slice(rangeStart, rangeEnd + 1);
      if (cap !== undefined) matched = matched.slice(0, cap);
      if (action === "update") {
        assert.equal(name, "cover_prepare_operations");
        for (const row of matched) Object.assign(row, clone(payload));
      }
      return { data: clone(single ? matched[0] || null : matched), error: null };
    };
    const query = {
      select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
      in(key, value) { filters.push([key, value, "in"]); return query; }, order(key, options = {}) { orders.push([key, options]); return query; }, limit(value) { cap = value; return query; },
      range(start, end) { rangeStart = start; rangeEnd = end; return query; },
      upsert(value, opts) { action = "upsert"; payload = value; options = opts; return query; },
      insert(value) { action = "insert"; payload = value; return query; },
      update(value) { action = "update"; payload = value; return query; },
      single: async () => run(true), maybeSingle: async () => run(true),
      then(resolve, reject) { return Promise.resolve(run(false)).then(resolve, reject); },
    };
    return query;
  } };
  const cache = new Map();
  const allowed = new Set([
    "src/lib/cover-composition.ts", "src/lib/cover-workbench-contract.ts", "src/lib/cover-workbench-prompts.ts", "src/lib/cover-reference-layout.ts",
    "src/lib/image-resolution-pricing.ts", "src/lib/llm-request-idempotency.ts",
    "src/lib/server/cover-request-body.ts",
    "src/lib/server/cover-prepare-repository.ts", "src/lib/server/cover-prepare-service.ts",
    "src/lib/server/cover-workflow-publication.ts", "src/lib/server/cover-analysis-message-preparation.ts", "src/lib/server/cover-analysis-authority.ts",
    "src/lib/server/cover-analysis-business-defaults.ts",
    "src/lib/server/cover-analysis-recovery.ts", "src/lib/cover-benchmark-profiles.ts", "src/lib/cover-benchmark-prompt-packs.ts", "src/lib/cover-source-spans.ts",
    "src/lib/cover-number-evidence.ts", "src/lib/cover-material-composition.ts", "src/lib/cover-material-usage.ts",
    "src/lib/cover-benchmark-layout.ts",
    "src/lib/cover-analysis-envelope.ts",
    "src/lib/cover-narrative-summary.ts", "src/lib/cover-animation-brief.ts",
    "src/lib/server/cover-prepared-generation.ts", "src/app/api/cover/prepare/route.ts",
    "src/lib/cover-style-catalog.ts", "src/lib/cover-review-contract.ts", "src/lib/cover-durable-attempt.ts",
    "src/lib/server/cover-style-config.ts", "src/lib/server/cover-style-defaults.ts", "src/lib/server/cover-style-store.ts",
    "src/lib/server/cover-review-projection.ts", "src/lib/server/cover-review-operations.ts", "src/lib/server/cover-review-http.ts",
    "src/lib/server/cover-review-generation-fence.ts", "src/lib/server/cover-completed-receipt.ts", "src/lib/cover-durable-attempt.ts",
    "src/app/api/cover-workbench/prepare/route.ts", "src/app/api/cover-workbench/analyze/route.ts",
    "src/app/api/cover-workbench/operations/route.ts", "src/app/api/cover-workbench/confirm/route.ts",
  ]);
  function load(relative) {
    relative = relative.replaceAll("\\", "/");
    if (cache.has(relative)) return cache.get(relative);
    assert.ok(allowed.has(relative), `Unexpected executable source ${relative}`);
    const module = { exports: {} }; cache.set(relative, module.exports);
    const imports = {
      "server-only": {},
      "node:crypto": { createHash, randomUUID }, zod: { z }, sharp: { default: sharp },
      "next/server": { NextRequest, NextResponse: { json: (body, init) => Response.json(body, init) } },
      "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { id: state.owner, userId: state.owner } }) },
      "@/storage/database/supabase-client": { getSupabaseClient: () => db, getSupabaseAdminClient: () => db },
      "@/lib/image-exactly-once": {
        // This preparation suite has no image attempts. A store read is an
        // isolated empty DB port; no terminal proof is invented here. The
        // separate parent-confirmation suite executes the real typed parser.
        DatabaseImageExactlyOnceStore: class { async get() { return null; } },
        getImageRequestRejection: () => assert.fail("No image failure proof is planned in preparation fixtures"),
      },
      "@/storage/object": { storageManager: {
        readBounded: async () => { state.storageReads += 1; return Buffer.from("fixture-reference-bytes"); },
        getSignedUrl: async () => { state.signedUrls += 1; return `https://fixture.invalid/reference.png?ticket=${state.signedUrls}`; },
      } },
      "@/lib/manga-agent-model-policy": { buildMangaAgentModelCatalog: () => ({ models: [{ id: "pm_fixture_text", displayName: "Fixture text", capabilities: { imageParsing: true } }] }) },
      "./cover-admin-runtime": { resolveCoverAnalysisModel: async (workflow, vision) => {
        state.modelResolutions++; state.onModelResolve?.(state.modelResolutions);
        const internalId = (vision ? workflow.imageModelId : workflow.textModelId) || "fixture-text";
        return { id: internalId === "fixture-text" ? "pm_fixture_text" : `pm_${internalId.replaceAll("-", "_")}`, internalId, displayName: "Fixture text",
          imageParsing: true, maxContextTokens: 0, maxReplyTokens: 0, fingerprint: sha(`${internalId}:${state.modelRevision}`) };
      } },
      "@/app/api/cover-models/route": { GET: async () => Response.json({ models: imageModels }) },
      "@/app/api/llm/route": { POST: async request => gateway(request.url, { body: await request.text(), headers: { "Idempotency-Key": request.headers.get("idempotency-key") } }) },
      "./story-director-overtime-gate": { STORY_DIRECTOR_MOVIE_AGENT_ID: "fixture-movie", STORY_DIRECTOR_HIGH_ENERGY_AGENT_ID: "fixture-energy" },
    };
    const compiled = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), {
      fileName: relative, reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Request, Response, Headers, AbortSignal, Error, structuredClone, console,
      fetch: () => assert.fail("Preparation must invoke the existing authenticated LLM handler directly, without a second HTTP request"),
      require(id) {
        if (Object.hasOwn(imports, id)) return imports[id];
        const resolved = id.startsWith("@/") ? `src/${id.slice(2)}.ts` : id.startsWith(".") ? `${path.posix.normalize(path.posix.join(path.posix.dirname(relative), id))}.ts` : id;
        return load(resolved);
      } }, { filename: relative });
    return module.exports;
  }
  function responsePayload(materials) {
    const analysis = { schemaVersion: "cover-content-analysis/1", status: "ready", topic: "从小事开始行动", primaryTitle: "先做十分钟", secondaryTitle: null,
      visualBrief: { subject: "一个人", action: "开始做事", scene: "桌面", emotion: "期待" },
      titleCandidates: [{ id: "t1", text: "先做十分钟", evidenceRefs: ["e1"] }],
      evidence: [{ id: "e1", source: "text", quote: materials.text, fields }], missingInformation: [] };
    analysis.layoutIntent = { structure: "single", focus: "action", evidenceRefs: ["e1"] };
    const conclusion = { text: "从当前材料提炼明确的内容重点", evidenceRefs: ["e1"] };
    analysis.contentBreakdown = { summary: conclusion, keyPoints: [conclusion], logic: conclusion, coverFocus: conclusion };
    if (state.mode === "missing-breakdown") delete analysis.contentBreakdown;
    if (state.mode === "subtitle") analysis.secondaryTitle = "今天就开始";
    if (state.mode === "product") {
      analysis.topic = "通勤使用便携水杯"; analysis.primaryTitle = "通勤带上500毫升";
      analysis.titleCandidates[0].text = analysis.primaryTitle;
      analysis.visualBrief = { subject: "便携水杯", action: "随身携带", scene: "日常通勤", emotion: "轻松" };
    }
    if (state.mode === "relationship-layout") {
      analysis.topic = "等待中的陪伴"; analysis.primaryTitle = "它把饭点排在你后面";
      analysis.titleCandidates[0].text = analysis.primaryTitle;
      analysis.visualBrief = { subject: "狗子与主人", action: "等主人关灯后开饭", scene: "居家餐桌", emotion: "期待与陪伴" };
      analysis.layoutIntent = { structure: "relationship", focus: "expression", evidenceRefs: ["e1"] };
    }
    const visualObservations = materials.assets.map(asset => ({ schemaVersion: "cover-visual-analysis/1", assetId: asset.assetId, assetRevision: 1,
      status: "ready", observations: [{ id: "obs1", kind: "background", description: "绿色背景", region: null }], ocr: [], palette: ["#349862"], uncertainties: [] }));
    if (materials.assets.length) analysis.materialUsage = materials.assets.map((asset, index) => ({ assetId: asset.assetId,
      imageNumber: asset.imageNumber ?? index + 1, role: asset.role, source: "ui_role", evidenceRefs: [] }));
    if (state.usageFixture) {
      analysis.topic = "模特展示牙膏"; analysis.primaryTitle = "模特展示牙膏"; analysis.secondaryTitle = null;
      analysis.titleCandidates[0].text = analysis.primaryTitle;
      analysis.visualBrief = { subject: "模特与牙膏", action: "自然持握", scene: "简洁生活场景", emotion: "自信" };
      analysis.evidence.push(...clone(state.usageFixture.evidence || []));
      if (state.usageFixture.usage === null) delete analysis.materialUsage;
      else analysis.materialUsage = clone(state.usageFixture.usage);
      for (const visual of visualObservations) visual.observations.push({ id: "zone", kind: "title_zone", description: "标题建议区域",
        region: visual.assetId === state.usageFixture.referenceAssetId ? { x: .25, y: .18, width: .6, height: .2 } : { x: .08, y: .04, width: .84, height: .2 } });
      if (state.usageFixture.needsInput) {
        analysis.status = "needs_input"; analysis.topic = ""; analysis.primaryTitle = ""; analysis.visualBrief = { subject: "", action: "", scene: "", emotion: "" };
        analysis.titleCandidates = []; analysis.missingInformation = ["@图1只作风格参考，还是保留图中本人外观？请明确一种用途。"];
        delete analysis.contentBreakdown; delete analysis.layoutIntent; delete analysis.materialUsage;
      }
    }
    const content = state.mode === "extra-envelope-brace" ? JSON.stringify({ analysis, visualObservations }).replace(',"visualObservations":', '},"visualObservations":')
      : state.mode === "bad-format" ? "not-json" : JSON.stringify({ analysis, visualObservations });
    return { choices: [{ message: { content } }],
      _billing: { operation_id: "fixture-billing-operation", credits_charged: 2 } };
  }
  function successfulChild(row) {
    const raw = JSON.stringify(responsePayload(row.materials));
    const recordId = sha(`${row.user_id}\0${row.analysis_request_id}`), fingerprint = sha(raw);
    return { record_id: recordId, user_id: row.user_id, client_request_id: row.analysis_request_id,
      payload_fingerprint: row.preparation.analysisPayloadFingerprint, state: "succeeded", attempt_no: 1, http_status: 200,
      response_body: raw, response_fingerprint: fingerprint, result_reference: `llm-result:${recordId}:1:${fingerprint}`, updated_at: new Date().toISOString() };
  }
  async function gateway(url, init) {
    assert.equal(new URL(url).pathname, "/api/llm", "No image/provider endpoint may execute");
    state.gatewayCalls += 1;
    const body = JSON.parse(init.body), key = body.client_request_id;
    state.gatewayBodies.push(clone(body));
    const row = state.parents.find(item => item.user_id === state.owner && item.analysis_request_id === key);
    assert.ok(row, "Durable parent must precede gateway dispatch");
    assert.equal(row.state, "analyzing");
    assert.equal(init.headers["Idempotency-Key"], key);
    const expectedFingerprint = load("src/lib/llm-request-idempotency.ts").fingerprintLlmRequest(Object.fromEntries(Object.entries(body).filter(([field]) => !["client_request_id", "userId"].includes(field))));
    assert.equal(row.preparation.analysisPayloadFingerprint, expectedFingerprint, "Persist the exact request digest before gateway dispatch");
    assert.equal(/data:image|fixture-reference-bytes|ticket=/.test(JSON.stringify(row)), false, "Transient references must not enter parent storage");
    const child = successfulChild(row);
    if (state.mode === "unknown") {
      child.state = "failed_unknown"; child.response_body = null;
      state.children.push(child);
      return Response.json({ code: "LLM_UPSTREAM_RESULT_UNKNOWN" }, { status: 503 });
    }
    state.children.push(child);
    return Response.json(responsePayload(row.materials), { headers: { "x-llm-attempt-id": child.record_id } });
  }
  const legacyRoute = load("src/app/api/cover/prepare/route.ts");
  const route = load("src/app/api/cover-workbench/prepare/route.ts");
  const analyzeRoute = load("src/app/api/cover-workbench/analyze/route.ts");
  const operationsRoute = load("src/app/api/cover-workbench/operations/route.ts");
  const confirmRoute = load("src/app/api/cover-workbench/confirm/route.ts");
  const repo = load("src/lib/server/cover-prepare-repository.ts");
  const service = load("src/lib/server/cover-prepare-service.ts");
  const guard = load("src/lib/server/cover-prepared-generation.ts");
  const request = (body, pathname = "/api/cover-workbench/prepare") => {
    const value = JSON.stringify(body);
    return new NextRequest(`https://fixture.invalid${pathname}`, { method: "POST", body: value,
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(value)), Authorization: "Bearer fixture-only" } });
  };
  const owned = id => state.parents.find(row => row.id === id && row.user_id === state.owner && row.preparation.recordKind !== "confirmation");
  const confirmationFor = parentId => state.parents.find(row => row.user_id === state.owner && row.preparation.originalAnalysisOperationId === parentId);
  // Snapshot assertions inspect the private fixture database, NEVER an HTTP
  // projection. Actual public response bodies remain separate and are checked.
  function inspection(body, row, child) {
    if (!row) return clone(body);
    return { ...clone(body), ...clone(row.preparation), ...clone(row.result || {}),
      ...(child ? clone(child.result || {}) : {}), operationId: row.id, status: row.state, billing: clone(row.billing), materials: clone(row.materials),
      ...(row.result?.analysisIssue ? { analysisIssue: clone(row.result.analysisIssue) } : {}) };
  }
  function assertPublic(body) {
    assert.equal(body.generationInput, undefined); assert.equal(body.promptDependencies, undefined);
    assert.equal(body.preparation, undefined); assert.equal(body.analysisTransportNormalization, undefined);
    if (body.task) assert.equal(body.task.prompt, "");
    const forbiddenKeys = new Set(["generationInput", "promptDependencies", "promptPack", "analysisRules", "nativeCoverRules", "artworkRules",
      "analysisPrompt", "generationPrompt", "frozenStyleRuntime", "frozenWorkflowRuntime", "analysisModelSnapshot", "dispatchInput", "system_prompt", "sourceEvidence", "researchSources",
      "analysisTransportNormalization", "analysisSourceAudit", "analysisSourceNormalization"]);
    const inspect = value => {
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        assert.equal(forbiddenKeys.has(key), false, `Private field ${key} must not appear anywhere in a public HTTP body`);
        if (key === "prompt") assert.equal(item, "");
        inspect(item);
      }
    };
    inspect(body);
  }
  async function responseValue(response, row, child) {
    const body = await response.json(); assertPublic(body);
    return { status: response.status, body, snapshot: inspection(body, row || owned(body.operationId), child) };
  }
  async function post(body) {
    if (body.action === "prepare") return responseValue(await route.POST(request({ materials: body.materials })));
    if (body.action === "get") return get(body.operationId);
    const payload = { operationId: body.operationId, ...(body.consent ? { consent: { analysis: body.consent.analysis } } : {}) };
    return responseValue(await analyzeRoute.POST(request(payload, "/api/cover-workbench/analyze")), owned(body.operationId));
  }
  // Explicit two-phase TEST helper: first the real analysis-only HTTP action;
  // only after review_ready, issue a separate real confirmation with image
  // consent. No generation/execute/provider action is called by this suite.
  async function analyzeAndConfirm(body) {
    const analyzed = await post(body);
    if (analyzed.body.status !== "review_ready") return analyzed;
    assert.equal(body.consent?.analysis, true); assert.equal(body.consent?.image, true);
    const parent = owned(body.operationId);
    assert.equal(parent.consent.analysis, true); assert.equal(parent.consent.image, undefined);
    assert.equal(parent.result.task, undefined); assert.equal(parent.result.generationInput, undefined);
    assert.equal(parent.result.generationIdentity, undefined);
    const confirmation = await confirmRoute.POST(request({ operationId: parent.id,
      clientRequestId: `confirm_${parent.id.replaceAll("-", "")}`, expectedAnalysisHash: analyzed.body.analysisHash,
      expectedImageQuoteHash: analyzed.body.quote.imageQuoteHash, edits: {}, consent: { image: true } }, "/api/cover-workbench/confirm"));
    const confirmed = await responseValue(confirmation);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const child = state.parents.find(row => row.id === confirmed.body.confirmationId);
    assert.equal(child.preparation.recordKind, "confirmation"); assert.equal(child.billing.credits_charged, 0);
    assert.equal(child.billing.reused_from_operation_id, parent.id);
    return { ...analyzed, confirmationBody: confirmed.body, snapshot: inspection(analyzed.body, parent, child) };
  }
  async function postRaw(body, declaredLength) {
    const headers = { "Content-Type": "application/json" };
    if (declaredLength !== undefined) headers["Content-Length"] = String(declaredLength);
    return responseValue(await route.POST(new NextRequest("https://fixture.invalid/api/cover-workbench/prepare", { method: "POST", body, headers })));
  }
  async function get(operationId) {
    const response = await operationsRoute.GET(new NextRequest(`https://fixture.invalid/api/cover-workbench/operations?operationId=${encodeURIComponent(operationId)}`));
    return responseValue(response, owned(operationId));
  }

  const materials = key => ({ schemaVersion: "cover-prepare/1", clientRequestId: key, materialRevision: 1,
    text: "以前总拖到最后，现在每天先做十分钟，终于开始行动。", assets: [], styleKey: "cartoon", outputRatio: "3:4", modelId: imageModel.id, resolution: "2K" });
  return { state, route, legacyRoute, analyzeRoute, repo, service, guard, post, analyzeAndConfirm, postRaw, get, materials, successfulChild, imageModel, assetFixtures: assets, confirmationFor,
    styleConfig: load("src/lib/server/cover-style-config.ts"), styleDefaults: load("src/lib/server/cover-style-defaults.ts") };
}

const h = harness();
{
  const retired = harness();
  const legacyRequest = body => new NextRequest("https://fixture.invalid/api/cover/prepare", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  const blocked = await retired.legacyRoute.POST(legacyRequest({ action: "prepare", materials: retired.materials("retired_v2_creation") }));
  assert.equal(blocked.status, 409); assert.equal((await blocked.json()).code, "COVER_REVIEW_WORKFLOW_REQUIRED");
  assert.equal(retired.state.parents.length, 0); assert.equal(retired.state.gatewayCalls, 0);
  const prepared = await retired.post({ action: "prepare", materials: retired.materials("retired_v2_unpaid") });
  const old = retired.state.parents.find(row => row.id === prepared.body.operationId);
  old.preparation.workflowVersion = 2; delete old.preparation.recordKind;
  const original = clone(old);
  const analyzed = await retired.legacyRoute.POST(legacyRequest({ action: "analyze", operationId: old.id, consent: { analysis: true, image: true } }));
  assert.equal(analyzed.status, 409); assert.equal((await analyzed.json()).code, "COVER_REVIEW_WORKFLOW_REQUIRED");
  assert.deepEqual(old, original); assert.equal(retired.state.gatewayCalls, 0);
  checks.push("retired V2 public creation and unpaid V2 analysis explicitly reject with 409/new-workflow guidance before parent creation, consent or billing");
}
{
  const consent = harness();
  const prepared = await consent.post({ action: "prepare", materials: consent.materials("v3_analysis_consent_boundary") });
  for (const permission of [{ image: true }, { analysis: true, image: true }, {}]) {
    const response = await consent.analyzeRoute.POST(new NextRequest("https://fixture.invalid/api/cover-workbench/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: prepared.body.operationId, consent: permission }) }));
    assert.equal(response.status, 422);
  }
  assert.equal(consent.state.gatewayCalls, 0); assert.equal(consent.state.parents[0].consent, null);
  assert.equal(consent.state.parents[0].billing.credits_charged, undefined);
  checks.push("V3 analysis HTTP only admits analysis consent; image-only/combined/empty consent rejects before claim or charge; confirmations use a distinct image consent");
}
const envelopeBrace = harness(); envelopeBrace.state.mode = "extra-envelope-brace";
const bracePrepared = await envelopeBrace.post({ action: "prepare", materials: envelopeBrace.materials("fixture_extra_envelope_brace") });
const braceReady = await envelopeBrace.analyzeAndConfirm({ action: "analyze", operationId: bracePrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(braceReady.snapshot.status, "plan_ready", JSON.stringify(braceReady.snapshot));
assert.equal(braceReady.snapshot.analysisTransportNormalization.kind, "single_premature_envelope_closure");
assert.equal(envelopeBrace.state.gatewayCalls, 1);
assert.ok(envelopeBrace.state.children[0].response_body.includes('},\\"visualObservations\\":'));
checks.push("the observed single premature envelope brace is normalized without changing values, audited by both hashes, and preserves its exact original paid child with one gateway call");
const missingBreakdown = harness(); missingBreakdown.state.mode = "missing-breakdown";
const incompletePrepared = await missingBreakdown.post({ action: "prepare", materials: missingBreakdown.materials("fixture_missing_breakdown") });
const incomplete = await missingBreakdown.analyzeAndConfirm({ action: "analyze", operationId: incompletePrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(incomplete.snapshot.code, "ANALYSIS_CONTENT_BREAKDOWN_MISSING");
assert.equal(missingBreakdown.state.gatewayCalls, 1);
assert.equal(missingBreakdown.state.children.length, 1);
assert.equal(missingBreakdown.state.parents[0].state, "failed");
checks.push("new analysis without the promised content breakdown stops before image generation and preserves its original paid child without retry");
const subtitle = harness(); subtitle.state.mode = "subtitle";
const subtitlePrepared = await subtitle.post({ action: "prepare", materials: subtitle.materials("fixture_editable_title") });
const subtitleDone = await subtitle.analyzeAndConfirm({ action: "analyze", operationId: subtitlePrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(subtitleDone.status, 200, JSON.stringify(subtitleDone.snapshot));
assert.equal(subtitleDone.snapshot.renderPlan.title, "先做十分钟");
assert.equal(subtitleDone.snapshot.renderPlan.subtitle, "今天就开始");
assert.ok(subtitleDone.snapshot.generationInput.prompt.includes('"subtitle":"今天就开始"'));
checks.push("native primary and secondary requested text remain separate in the full-cover prompt; no independently editable subtitle layer is claimed");
const omittedResolution = harness();
omittedResolution.imageModel.capabilities.defaultResolution = "4K";
const omittedMaterials = omittedResolution.materials("fixture_omitted_resolution");
delete omittedMaterials.resolution;
const omittedPrepared = await omittedResolution.post({ action: "prepare", materials: omittedMaterials });
assert.equal(omittedPrepared.status, 200);
assert.equal(omittedPrepared.snapshot.generationSpec.resolution, "2K");
assert.equal(omittedPrepared.snapshot.quote.image.resolution, "2K");
assert.equal(omittedPrepared.snapshot.quote.image.amount, 0.1);
checks.push("omitted resolution uses the same 2K generation spec and quoted price even when the catalog default is 4K");
const oversized = JSON.stringify({ action: "prepare", materials: { text: "x".repeat(100_001) } });
assert.equal((await h.postRaw(oversized, 1)).status, 413);
assert.equal((await h.postRaw(oversized)).status, 413);
assert.equal(h.state.gatewayCalls, 0); assert.equal(h.state.parents.length, 0);
checks.push("actual bounded body reader rejects oversized streams with false or absent Content-Length before parent/gateway work");
const input = h.materials("fixture_prepare_01");
const first = await h.post({ action: "prepare", materials: input });
assert.equal(first.status, 200, JSON.stringify(first.snapshot));
const catalogReadsBeforeReplay = h.state.tableReads.filter(name => name === "llm_models").length;
const second = await h.post({ action: "prepare", materials: Object.fromEntries(Object.entries(input).reverse()) });
assert.equal(second.snapshot.operationId, first.snapshot.operationId); assert.equal(h.state.parents.length, 1); assert.equal(h.state.gatewayCalls, 0);
assert.equal(h.state.tableReads.filter(name => name === "llm_models").length, catalogReadsBeforeReplay);
checks.push("real repository creates one owned parent for repeated/reordered same-key preparation, without gateway calls");
const conflicting = await h.post({ action: "prepare", materials: { ...input, text: "另一份材料" } });
assert.equal(conflicting.status, 409); assert.equal(conflicting.snapshot.code, "COVER_MATERIAL_CONFLICT");
assert.equal(h.state.tableReads.filter(name => name === "llm_models").length, catalogReadsBeforeReplay);
checks.push("same key with changed materials returns conflict without overwriting the frozen parent");
checks.push("idempotent replays and material conflicts read the frozen parent without re-reading model availability or repricing");
const id = first.snapshot.operationId;
h.state.owner = ownerB;
assert.equal((await h.get(id)).status, 404);
assert.equal((await h.post({ action: "get", operationId: id })).status, 404);
assert.equal((await h.analyzeAndConfirm({ action: "analyze", operationId: id, consent: { analysis: true, image: true } })).status, 404);
assert.equal(h.state.gatewayCalls, 0);
h.state.owner = ownerA;
checks.push("another owner cannot read or analyze a known parent ID");
assert.equal((await h.post({ action: "analyze", operationId: id })).status, 422);
const analyzed = await Promise.all([0, 1].map(() => h.analyzeAndConfirm({ action: "analyze", operationId: id, consent: { analysis: true, image: true } })));
assert.ok(analyzed.some(item => item.snapshot.status === "plan_ready"), JSON.stringify(analyzed));
assert.equal(h.state.gatewayCalls, 1); assert.equal(h.state.parents[0].billing.credits_charged, 2);
checks.push("actual CAS allows one analysis gateway call under concurrent submits and retains the billing receipt");
const row = h.confirmationFor(id);
const validGeneration = { userId: ownerA, task: clone(row.result.task), generationInput: clone(row.result.generationInput),
  ...row.result.generationIdentity, requestUrl: "https://fixture.invalid/api/cover/attempt" };
assert.equal((await h.guard.validatePreparedCoverGeneration(validGeneration)).length, 0);
for (const mutation of [
  value => { value.userId = ownerB; }, value => { value.clientIdempotencyKey = "coverwb_wrong_parent"; },
  value => { value.clientTraceId = "coverwb_wrong_trace"; }, value => { value.generationInput.prompt += "changed"; },
  value => { value.generationInput.modelId = "pm_other"; }, value => { value.task.renderPlan.outputSpec.width = 999; },
  value => { value.task.renderPlan.textRendering.mode = "overlay"; }, value => { delete value.task.renderPlan.textRendering; },
  value => { value.task.renderPlan.textRendering.version = "unbound-version"; },
  value => { value.task.renderPlan = { title: "legacy" }; },
]) {
  const candidate = clone(validGeneration); mutation(candidate);
  await assert.rejects(() => h.guard.validatePreparedCoverGeneration(candidate));
}
const parentReads = h.state.tableReads.filter(name => name === "cover_prepare_operations").length;
assert.equal(await h.guard.validatePreparedCoverGeneration({ ...validGeneration,
  clientIdempotencyKey: "cover_legacy_test", clientTraceId: "cover_legacy_test", task: { id: "legacy", renderPlan: { title: "legacy" } } }), null);
assert.equal(h.state.tableReads.filter(name => name === "cover_prepare_operations").length, parentReads);
checks.push("V3 confirmation guard binds owner/analysis+confirmation/key/trace/prompt/model/output/text mode and rejects downgrade; true legacy never reads the parent table");

const failure = harness(); failure.state.mode = "bad-format";
const failedPrepared = await failure.post({ action: "prepare", materials: failure.materials("fixture_bad_format") });
const failed = await failure.analyzeAndConfirm({ action: "analyze", operationId: failedPrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(failed.snapshot.status, "failed"); assert.equal(failed.snapshot.billing.credits_charged, 2);
await failure.post({ action: "get", operationId: failedPrepared.snapshot.operationId });
assert.equal(failure.state.gatewayCalls, 1);
checks.push("a charged but invalid-format response retains its receipt and does not silently buy another analysis");

const reuse = harness();
const reuseInput = reuse.materials("fixture_reuse_source");
const reusePrepared = await reuse.post({ action: "prepare", materials: reuseInput });
await reuse.analyzeAndConfirm({ action: "analyze", operationId: reusePrepared.snapshot.operationId, consent: { analysis: true, image: true } });
const originalPaid = clone(reuse.state.parents[0].billing);
assert.equal(originalPaid.credits_charged, 2);
for (const [name, settings] of [
  ["ratio", { outputRatio: "16:9" }],
  ["model", { modelId: "pm_fixture_image_alt", resolution: "4K" }],
]) {
  const prepared = await reuse.post({ action: "prepare", materials: { ...reuseInput, clientRequestId: `fixture_reuse_${name}`, materialRevision: 2, ...settings } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.snapshot.quote.analysis.amount, 0);
  assert.ok(prepared.snapshot.reuseAnalysisOperationId);
  const response = await reuse.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  assert.equal(response.snapshot.status, "plan_ready", JSON.stringify(response));
  assert.equal(response.snapshot.billing.credits_charged, 0);
  assert.equal(response.snapshot.billing.reused_from_operation_id, prepared.snapshot.reuseAnalysisOperationId);
  assert.equal(response.snapshot.renderPlan.aspectRatio, settings.outputRatio || "3:4");
  assert.equal(response.snapshot.renderPlan.coverModeId, "cartoon");
  assert.equal(response.snapshot.generationInput.modelId, settings.modelId || reuseInput.modelId);
  assert.equal(response.snapshot.quote.image.amount, name === "model" ? 0.6 : 0.1, "Image quote remains independent from free analysis reuse");
  assert.equal(reuse.state.gatewayCalls, 1);
  assert.deepEqual(reuse.state.parents.find(row => row.id === reusePrepared.snapshot.operationId).billing, originalPaid);
}
const changedStyle = await reuse.post({ action: "prepare", materials: { ...reuseInput, clientRequestId: "fixture_style_requires_separate_analysis", styleKey: "funny-cartoon" } });
assert.equal(changedStyle.snapshot.quote.analysis.amount, null);
assert.equal(changedStyle.snapshot.reuseAnalysisOperationId, undefined);
assert.notEqual(changedStyle.snapshot.contentFingerprint, reusePrepared.snapshot.contentFingerprint);
assert.equal(reuse.state.gatewayCalls, 1, "A style change only prepares a separate quote; it does not silently purchase analysis");
reuse.state.owner = ownerB;
const otherOwnerReuse = await reuse.post({ action: "prepare", materials: { ...reuseInput, clientRequestId: "fixture_reuse_other_owner" } });
assert.equal(otherOwnerReuse.snapshot.reuseAnalysisOperationId, undefined);
assert.equal(otherOwnerReuse.snapshot.quote.analysis.amount, null);
checks.push("same-style same-owner analysis reuses across ratio/model edits; a different style/pack gets a separate quote without hidden analysis or changing the original paid receipt");
for (const corrupt of ["missing", "invalid-schema"]) {
  const stopped = harness();
  const original = await stopped.post({ action: "prepare", materials: stopped.materials(`fixture_cache_source_${corrupt}`) });
  await stopped.analyzeAndConfirm({ action: "analyze", operationId: original.snapshot.operationId, consent: { analysis: true, image: true } });
  const prepared = await stopped.post({ action: "prepare", materials: stopped.materials(`fixture_cache_reuse_${corrupt}`) });
  assert.equal(prepared.snapshot.quote.analysis.amount, 0);
  assert.equal(prepared.snapshot.reuseAnalysisOperationId, original.snapshot.operationId);
  if (corrupt === "missing") stopped.state.parents.splice(stopped.state.parents.findIndex(row => row.id === original.snapshot.operationId), 1);
  else stopped.state.parents.find(row => row.id === original.snapshot.operationId).result.analysis.primaryTitle = 123;
  const failed = await stopped.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  assert.equal(failed.snapshot.status, "failed", `${corrupt}: ${JSON.stringify(failed)}`);
  assert.equal(failed.snapshot.billing.credits_charged, 0);
  await stopped.get(prepared.snapshot.operationId);
  await stopped.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  assert.equal(stopped.state.gatewayCalls, 1, "An advertised free cache reuse must never silently fall back to a paid call");
}
checks.push("missing or schema-corrupted reused analysis fails closed with zero new charge and no automatic paid fallback");

for (const corrupt of [null, "response_hash", "result_reference", "payload_fingerprint", "record_id", "http_status"]) {
  const recover = harness(); recover.state.mode = "unknown";
  const prepared = await recover.post({ action: "prepare", materials: recover.materials(`fixture_recover_${corrupt || "valid"}`) });
  const operationId = prepared.snapshot.operationId;
  const uncertain = await recover.analyzeAndConfirm({ action: "analyze", operationId, consent: { analysis: true, image: true } });
  assert.equal(uncertain.snapshot.status, "unknown");
  await recover.analyzeAndConfirm({ action: "analyze", operationId, consent: { analysis: true, image: true } });
  assert.equal(recover.state.gatewayCalls, 1);
  recover.state.mode = "success";
  const child = recover.successfulChild(recover.state.parents[0]);
  if (corrupt === "response_hash") child.response_fingerprint = "0".repeat(64);
  else if (corrupt === "result_reference") child.result_reference = "nonempty-but-wrong-reference";
  else if (corrupt === "payload_fingerprint") child.payload_fingerprint = "0".repeat(64);
  else if (corrupt === "record_id") child.record_id = "0".repeat(64);
  else if (corrupt === "http_status") child.http_status = 503;
  recover.state.children[0] = child;
  const restored = await recover.get(operationId);
  assert.equal(restored.snapshot.status, corrupt ? "unknown" : "plan_ready", `${corrupt}: ${JSON.stringify(restored)}`);
  if (corrupt) assert.equal(restored.snapshot.code, "COVER_ANALYSIS_REPLAY_INVALID");
  assert.equal(recover.state.gatewayCalls, 1);
}
checks.push("unknown recovery only queries the original child; valid replay recovers and five corrupted receipt bindings stay unknown");

const refs = harness();
const refInput = { ...refs.materials("fixture_reference_01"), assets: [{ assetId: referenceId, role: "style_reference" }] };
const refPrepared = await refs.post({ action: "prepare", materials: refInput });
await refs.analyzeAndConfirm({ action: "analyze", operationId: refPrepared.snapshot.operationId, consent: { analysis: true, image: true } });
const refRow = refs.confirmationFor(refPrepared.snapshot.operationId);
assert.equal(refRow.state, "plan_ready", JSON.stringify(refRow));
assert.equal(refRow.preparation.style.key, "reference-adaptive");
assert.equal(refRow.result.generationInput.style, "reference-adaptive");
assert.equal(refRow.preparation.generatedOverlayLayout.version, "cover-generated-overlay-safe-frame/1");
assert.deepEqual(clone(refRow.result.renderPlan.generatedOverlayLayout), clone(refRow.preparation.generatedOverlayLayout));
assert.equal(refRow.result.renderPlan.outputSpec.fit, "contain");
assert.equal(refRow.result.renderPlan.titleStyle.color, "#152332");
assert.ok(refRow.result.generationInput.prompt.includes("do not reserve an additional title zone"));
assert.equal(/warm_story|圆润且有可信情绪/u.test(refRow.result.generationInput.prompt), false);
checks.push("reference-image mode uses its observed style profile without silently inheriting the animation-author preset");
const links = await refs.guard.validatePreparedCoverGeneration({ userId: ownerA, task: clone(refRow.result.task),
  generationInput: clone(refRow.result.generationInput), ...refRow.result.generationIdentity,
  requestUrl: "https://fixture.invalid/api/cover/attempt", resolveReferences: true });
assert.equal(links.length, 1); assert.match(links[0], /^https:\/\/fixture\.invalid\//u);
assert.equal(refs.state.storageReads, 1);
assert.equal(/data:image|fixture-reference-bytes|ticket=/.test(JSON.stringify(refs.state.parents)), false);
checks.push("owned reference bytes and signed links exist only in transient requests, never parent materials/results");
const ambiguous = harness();
const extraAssetId = "00000000-0000-4000-8000-000000000004";
ambiguous.assetFixtures.push({ ...ambiguous.assetFixtures[0], id: extraAssetId });
const ambiguousResult = await ambiguous.post({ action: "prepare", materials: { ...ambiguous.materials("ambiguous_preserve_01"),
  assets: [{ assetId: referenceId, role: "background_canvas" }, { assetId: extraAssetId, role: "identity_subject" }] } });
assert.equal(ambiguousResult.status, 422);
assert.equal(ambiguousResult.snapshot.code, "COVER_MULTIPLE_PRESERVED_IMAGES_UNAVAILABLE");
assert.equal(ambiguous.state.gatewayCalls, 0); assert.equal(ambiguous.state.storageReads, 0);
checks.push("multiple preserved originals require an explicit image-role correction before analysis or image reads, never silently dropping a subject");

const composed = harness();
composed.assetFixtures.push({ ...composed.assetFixtures[0], id: extraAssetId, storage_key: "fixture/scene.png" });
const composeInput = { ...composed.materials("fixture_numbered_compose"), imageMode: "compose",
  text: "用@图9里的模特，搭配@图2里的场景。以前总拖到最后，现在每天先做十分钟，终于开始行动。",
  assets: [{ assetId: referenceId, role: "identity_subject", imageNumber: 9 }, { assetId: extraAssetId, role: "background_canvas", imageNumber: 2 }] };
const composePrepared = await composed.post({ action: "prepare", materials: composeInput });
assert.equal(composePrepared.status, 200); assert.equal(composePrepared.snapshot.route, "subject_composite");
assert.equal(composePrepared.snapshot.style.key, "custom-composition"); assert.equal(composePrepared.snapshot.sourceAssetId, undefined);
assert.equal(composed.state.gatewayCalls, 0); assert.equal(composed.state.storageReads, 0, "Composition must not run original-canvas pixel preflight");
const composeReady = await composed.analyzeAndConfirm({ action: "analyze", operationId: composePrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(composeReady.snapshot.status, "plan_ready", JSON.stringify(composeReady.snapshot.analysisIssue));
assert.equal(composeReady.snapshot.renderPlan.animationStyleId, "photo-real"); assert.equal(composeReady.snapshot.renderPlan.titleStyle.colorMode, "single");
const imageParts = composed.state.gatewayBodies[0].messages.find(message => message.role === "user").content;
const attached = imageParts.filter(part => part.type === "image_url"); assert.equal(attached.length, 2);
assert.match(imageParts[1].text, /实际第1张图片，@图9/u); assert.match(imageParts[3].text, /实际第2张图片，@图2/u);
assert.ok(imageParts[1].text.includes(referenceId) && imageParts[3].text.includes(extraAssetId));
assert.match(composeReady.snapshot.generationInput.prompt, /编号与图片资产固定绑定/u);
assert.ok(composeReady.snapshot.generationInput.prompt.includes("@图9") && composeReady.snapshot.generationInput.prompt.includes("@图2"));
const allReferences = await composed.guard.validatePreparedCoverGeneration({ userId: ownerA, task: clone(composeReady.snapshot.task),
  generationInput: clone(composeReady.snapshot.generationInput), ...composeReady.snapshot.generationIdentity,
  requestUrl: "https://fixture.invalid/api/cover/attempt", resolveReferences: true });
assert.equal(allReferences.length, 2); assert.equal(composed.state.signedUrls, 2);
assert.equal(/data:image|fixture-reference-bytes|ticket=/.test(JSON.stringify(composed.state.parents)), false);
checks.push("actual compose preparation/analysis/guard use both owned subject+scene images in stable input order, bind @numbers and compile the photographic composition prompt without treating either photo as a retained canvas");

for (const bad of ["missing", "duplicate", "capacity"]) {
  const rejected = harness(); rejected.assetFixtures.push({ ...rejected.assetFixtures[0], id: extraAssetId });
  const input = clone(composeInput); input.clientRequestId = `fixture_compose_${bad}`;
  if (bad === "missing") input.text += "再加入@图3";
  if (bad === "duplicate") input.assets[1].imageNumber = 9;
  if (bad === "capacity") rejected.imageModel.capabilities.maxReferenceImages = 1;
  const result = await rejected.post({ action: "prepare", materials: input });
  assert.equal(result.status, 422); assert.equal(rejected.state.gatewayCalls, 0); assert.equal(rejected.state.storageReads, 0);
  assert.equal(rejected.state.parents.length, 0, "Bad references/capacity must fail before persisting a billable plan");
}
checks.push("missing/duplicate @image bindings and insufficient model reference capacity reject in free preparation before analysis, image reads or a billable parent");

const productOnly = harness(); productOnly.state.mode = "product";
const productInput = { ...productOnly.materials("fixture_description_product"), contentKind: "product", text: "这款水杯容量500毫升，适合日常通勤和随身携带。", assets: [] };
const productPrepared = await productOnly.post({ action: "prepare", materials: productInput });
assert.equal(productPrepared.status, 200); assert.equal(productPrepared.snapshot.style.key, "custom-composition");
assert.equal(productPrepared.snapshot.materials.imageMode, undefined);
const productReady = await productOnly.analyzeAndConfirm({ action: "analyze", operationId: productPrepared.snapshot.operationId, consent: { analysis: true, image: true } });
assert.equal(productReady.snapshot.status, "plan_ready", JSON.stringify(productReady.snapshot.analysisIssue));
assert.equal(productReady.snapshot.renderPlan.animationStyleId, "photo-real");
assert.equal(productReady.snapshot.layoutPlan, undefined, "Description-only products must not inherit a benchmark layout");
assert.match(productOnly.state.gatewayBodies[0].messages[0].content, /没有商品照片.*创意示意图/u);
assert.match(productReady.snapshot.generationInput.prompt, /description-only product/u);
assert.equal(productOnly.state.storageReads, 0);
checks.push("a description-only product needs no photo or imageMode, uses its explicit facts and photographic concept profile rather than either animation-author preset");

const compatible = harness();
const originalCompatible = await compatible.post({ action: "prepare", materials: compatible.materials("fixture_old_protocol") });
await compatible.analyzeAndConfirm({ action: "analyze", operationId: originalCompatible.snapshot.operationId, consent: { analysis: true, image: true } });
const oldRow = compatible.state.parents[0], oldBilling = clone(oldRow.billing);
delete oldRow.result.analysis.layoutIntent;
delete oldRow.result.analysis.contentBreakdown;
oldRow.preparation.contentFingerprint = compatible.repo.coverMaterialFingerprint({ text: oldRow.materials.text, assets: oldRow.materials.assets,
  manualTitle: null, promptVersion: "cover-content-analysis/1.0.0" });
const compatibleInput = { ...compatible.materials("fixture_new_protocol_same_content"), outputRatio: "16:9", styleKey: "funny-cartoon" };
const compatiblePrepared = await compatible.post({ action: "prepare", materials: compatibleInput });
assert.equal(compatiblePrepared.snapshot.quote.analysis.amount, null);
assert.equal(compatiblePrepared.snapshot.reuseAnalysisOperationId, undefined);
const compatibleReady = await compatible.get(oldRow.id);
assert.equal(compatibleReady.snapshot.status, "plan_ready"); assert.equal(compatible.state.gatewayCalls, 1);
assert.deepEqual(oldRow.billing, oldBilling);
assert.equal(compatibleReady.snapshot.analysis.primaryTitle, oldRow.result.analysis.primaryTitle);
checks.push("legacy paid operation remains readable under its original ID and receipt; it is never labelled as fresh analysis for a new style/pack");

for (const [styleKey, outputRatio] of [["cartoon", "16:9"], ["funny-cartoon", "3:4"]]) {
  const layout = harness(); layout.state.mode = "relationship-layout";
  const input = { ...layout.materials(`fixture_layout_${styleKey}`), styleKey, outputRatio,
    text: "狗子等主人关灯后才开饭，主人停下工作才发现它一直陪着自己。" };
  const prepared = await layout.post({ action: "prepare", materials: input });
  const ready = await layout.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  assert.equal(ready.snapshot.status, "plan_ready", JSON.stringify(ready.snapshot.analysisIssue));
  const confirmedRow = layout.confirmationFor(prepared.snapshot.operationId);
  assert.equal(confirmedRow.preparation.confirmedPlan.layoutIntent.structure, "relationship");
  assert.equal(confirmedRow.preparation.confirmedPlan.layoutIntent.focus, "expression");
  assert.ok(ready.snapshot.generationInput.prompt.includes('"structure":"relationship"'));
  assert.ok(ready.snapshot.generationInput.prompt.includes('"focus":"expression"'));
  // The retired benchmark template compiler remains a pure compatibility
  // contract. New V3 confirmations use their frozen published style release.
  const parent = layout.state.parents.find(row => row.id === prepared.snapshot.operationId);
  const legacyCompiled = layout.service.compileCoverPlanFromAnalysis({ ...parent, preparation: { ...parent.preparation, workflowVersion: 2 } }, parent.result.analysis, []);
  const planned = legacyCompiled.layoutPlan;
  assert.equal(planned.source, "semantic_intent"); assert.match(planned.templateId, /^gaoding-benchmark-/u);
  assert.equal(legacyCompiled.renderPlan.layoutTemplateId, planned.templateId);
  for (const field of ["x", "y", "width", "scale"]) assert.equal(legacyCompiled.renderPlan.titleStyle[field], planned.titleStyle[field]);
  assert.ok(legacyCompiled.generationInput.prompt.includes(planned.templateId));
  assert.equal(ready.snapshot.renderPlan.textRendering.mode, "native");
  assert.equal(ready.snapshot.renderPlan.outputSpec.fit, "contain");
  assert.equal(ready.snapshot.generationInput.coverText, "");
  assert.equal(ready.snapshot.generationInput.prompt.includes("Do not draw title text"), false);
  assert.ok(legacyCompiled.generationInput.prompt.includes(JSON.stringify(planned.titleZone)));
  assert.equal(ready.snapshot.renderPlan.titleStyle.colorMode, "palette");
}
assert.equal(refRow.result.layoutPlan, undefined, "Reference-adaptive styles keep their observed layout path");
checks.push("V3 confirmation freezes relationship/expression intent in actual native prompts; the pure legacy compiler retains benchmark template/title geometry, and reference/product layouts stay independent");

for (const corrupt of ["old-protocol", "pack", "compiler", "messages", "style"]) {
  const stale = harness();
  const prepared = await stale.post({ action: "prepare", materials: stale.materials(`fixture_stale_${corrupt}`) });
  assert.equal(prepared.snapshot.status, "prepared");
  const row = stale.state.parents[0];
  if (corrupt === "old-protocol") { row.preparation.analysisPromptVersion = "cover-content-analysis/1.0.0"; delete row.preparation.promptDependencies; }
  if (corrupt === "pack") row.preparation.promptDependencies.promptPackVersion = "stale";
  if (corrupt === "compiler") row.preparation.promptDependencies.analysisCompilerFingerprint = "a".repeat(64);
  if (corrupt === "messages") row.preparation.analysisMessagesFingerprint = "b".repeat(64);
  if (corrupt === "style") row.preparation.style.version = "changed-without-new-preparation";
  const before = clone(row);
  const response = await stale.analyzeAndConfirm({ action: "analyze", operationId: row.id, consent: { analysis: true, image: true } });
  assert.equal(response.status, 409, `${corrupt}: ${JSON.stringify(response)}`);
  assert.equal(response.snapshot.code, "COVER_PREPARATION_STALE"); assert.equal(response.snapshot.reprepareRequired, true);
  assert.deepEqual(row, before); assert.equal(stale.state.gatewayCalls, 0);
  assert.equal((await stale.get(row.id)).snapshot.status, "prepared");
}
checks.push("old unpaid prepared protocol, pack, compiler, material-message and style drift return explicit 409 before claim, consent, billing or model dispatch");
{
  const configured = harness();
  const first = await configured.post({ action: "prepare", materials: configured.materials("workflow_original_paid") });
  const paid = await configured.analyzeAndConfirm({ action: "analyze", operationId: first.body.operationId, consent: { analysis: true, image: true } });
  assert.equal(paid.snapshot.status, "plan_ready"); const oldParent = clone(configured.state.parents[0]);
  const waiting = await configured.post({ action: "prepare", materials: { ...configured.materials("workflow_waiting_old"), text: "以前总拖到最后，现在每天先做十分钟，终于开始行动。请保留具体动作。" } });
  const config = configured.styleConfig, defaults = configured.styleDefaults;
  const catalog = defaults.createDefaultCoverStyleCatalog(), original = defaults.createDefaultCoverWorkflowRelease();
  const payload = { ...original, releaseId: "fixture:workflow:2.0.0", version: "2.0.0", sequence: 2,
    sharedRules: "GLOBAL_PUBLISHED_SENTINEL：先辨识原文具体动作与关系。", textModelId: "fixture-pinned", imageModelId: null };
  const release = { ...payload, snapshotSha256: config.coverWorkflowReleaseHash(payload) };
  const pointer = { releaseId: release.releaseId, publishedAt: release.createdAt, publishedBy: "fixture-admin" };
  catalog.workflow = { draftReleaseId: null, current: pointer, releases: [original, release], publications: [{ ...pointer, action: "publish" }] };
  configured.state.settings = [{ id: "fixture-cover-catalog", setting_key: config.COVER_STYLE_SETTING_KEY,
    setting_value: config.coverStyleStableJson(catalog), updated_at: "2026-11-08T08:00:00.000Z" }];
  const stale = await configured.post({ action: "analyze", operationId: waiting.body.operationId, consent: { analysis: true } });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "COVER_PREPARATION_STALE"); assert.equal(configured.state.gatewayCalls, 1);
  const fresh = await configured.post({ action: "prepare", materials: configured.materials("workflow_new_published") });
  const freshRow = configured.state.parents.find(row => row.id === fresh.body.operationId);
  assert.equal(freshRow.preparation.quote.analysis.modelId, "pm_fixture_pinned");
  assert.equal(freshRow.preparation.frozenWorkflowRuntime.releaseId, release.releaseId);
  assert.equal(freshRow.preparation.reuseAnalysisOperationId, undefined, "Changed common rules/model must not reuse the old paid analysis");
  assert.notEqual(freshRow.preparation.contentFingerprint, oldParent.preparation.contentFingerprint);
  assert.equal(configured.state.gatewayCalls, 1, "A real free prepare must not dispatch analysis");
  const draftPayload = { ...release, releaseId: "fixture:workflow:3.0.0", version: "3.0.0", sequence: 3, sharedRules: "UNPUBLISHED_DRAFT_SENTINEL" };
  const draft = { ...draftPayload, snapshotSha256: config.coverWorkflowReleaseHash(draftPayload) };
  catalog.workflow.releases.push(draft); catalog.workflow.draftReleaseId = draft.releaseId;
  configured.state.settings[0].setting_value = config.coverStyleStableJson(catalog);
  const completed = await configured.analyzeAndConfirm({ action: "analyze", operationId: freshRow.id, consent: { analysis: true, image: true } });
  assert.equal(completed.snapshot.status, "plan_ready"); assert.equal(configured.state.gatewayCalls, 2);
  const body = configured.state.gatewayBodies[1];
  assert.equal(body.modelId, freshRow.preparation.quote.analysis.modelId);
  assert.ok(body.system_prompt.includes("GLOBAL_PUBLISHED_SENTINEL")); assert.ok(!body.system_prompt.includes("UNPUBLISHED_DRAFT_SENTINEL"));
  const child = configured.state.parents.find(row => row.id === completed.confirmationBody.confirmationId);
  assert.deepEqual(child.preparation.frozenWorkflowRuntime, freshRow.preparation.frozenWorkflowRuntime);
  assert.deepEqual(child.preparation.analysisModelSnapshot, freshRow.preparation.analysisModelSnapshot);
  const unchangedPaid = await configured.get(oldParent.id);
  assert.equal(unchangedPaid.snapshot.billing.credits_charged, oldParent.billing.credits_charged);
  assert.equal(configured.state.gatewayCalls, 2); assert.deepEqual(configured.state.parents.find(row => row.id === oldParent.id), oldParent);
  const drift = await configured.post({ action: "prepare", materials: { ...configured.materials("workflow_model_drift"), text: "每天先做十分钟，按当前事项开始行动。" } });
  configured.state.modelRevision++;
  const rejected = await configured.post({ action: "analyze", operationId: drift.body.operationId, consent: { analysis: true } });
  assert.equal(rejected.status, 409); assert.equal(configured.state.gatewayCalls, 2);
}
checks.push("real free prepare freezes configured public model/global release before reuse; actual publication and model drift stale unpaid tasks, draft-only changes do not; exact gateway messages and confirmation snapshots retain the published rules while original paid receipts remain untouched");
for (const change of ["disabled", "version"]) {
  const stale = harness(), config = stale.styleConfig, defaults = stale.styleDefaults;
  const first = await stale.post({ action: "prepare", materials: stale.materials(`style_${change}_paid`) });
  await stale.analyzeAndConfirm({ action: "analyze", operationId: first.body.operationId, consent: { analysis: true, image: true } });
  const oldPaid = clone(stale.state.parents.find(row => row.id === first.body.operationId));
  const waiting = await stale.post({ action: "prepare", materials: { ...stale.materials(`style_${change}_waiting`), text: "现在每天先做十分钟，按原有事项开始行动。" } });
  const catalog = defaults.createDefaultCoverStyleCatalog(), entry = catalog.entries[0];
  if (change === "disabled") entry.enabled = false;
  else {
    const payload = { ...entry.releases[0], releaseId: "fixture:style:2.0.0", sequence: 2, version: "2.0.0" };
    const release = { ...payload, snapshotSha256: config.coverStyleReleaseHash(payload) };
    entry.releases.push(release); entry.current = { ...entry.current, releaseId: release.releaseId };
    entry.publications.push({ ...entry.current, action: "publish" });
  }
  stale.state.settings = [{ id: "fixture-style-state", setting_key: config.COVER_STYLE_SETTING_KEY,
    setting_value: config.coverStyleStableJson(catalog), updated_at: "2026-11-08T09:00:00.000Z" }];
  const rejected = await stale.post({ action: "analyze", operationId: waiting.body.operationId, consent: { analysis: true } });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, "COVER_PREPARATION_STALE"); assert.equal(rejected.body.reprepareRequired, true);
  const fresh = await stale.post({ action: "prepare", materials: { ...stale.materials(`style_${change}_new`), styleVersion: "1.0.0" } });
  assert.equal(fresh.status, 409); assert.equal(fresh.body.code, change === "disabled" ? "COVER_STYLE_UNAVAILABLE" : "COVER_STYLE_VERSION_CHANGED");
  const recovered = await stale.get(oldPaid.id); assert.equal(recovered.snapshot.billing.credits_charged, oldPaid.billing.credits_charged);
  assert.deepEqual(stale.state.parents.find(row => row.id === oldPaid.id), oldPaid); assert.equal(stale.state.gatewayCalls, 1);
}
checks.push("style disable/publication drift returns safe stale 409 for unpaid work, clear unavailable/version codes on new prepare, and leaves original paid receipt readable without redispatch");
{
  const raced = harness(), config = raced.styleConfig, defaults = raced.styleDefaults;
  const prepared = await raced.post({ action: "prepare", materials: raced.materials("second_current_gate_race") });
  raced.state.onModelResolve = count => {
    if (count !== 2) return;
    const catalog = defaults.createDefaultCoverStyleCatalog(), original = defaults.createDefaultCoverWorkflowRelease();
    const payload = { ...original, releaseId: "fixture:workflow:race", version: "2.0.0", sequence: 2, sharedRules: "PUBLISHED_DURING_FIRST_CURRENT_CHECK" };
    const release = { ...payload, snapshotSha256: config.coverWorkflowReleaseHash(payload) };
    const pointer = { releaseId: release.releaseId, publishedAt: release.createdAt, publishedBy: "fixture-admin" };
    catalog.workflow = { draftReleaseId: null, current: pointer, releases: [original, release], publications: [{ ...pointer, action: "publish" }] };
    raced.state.settings = [{ id: "fixture-workflow-race", setting_key: config.COVER_STYLE_SETTING_KEY,
      setting_value: config.coverStyleStableJson(catalog), updated_at: "2026-11-08T10:00:00.000Z" }];
  };
  const rejected = await raced.post({ action: "analyze", operationId: prepared.body.operationId, consent: { analysis: true } });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.code, "COVER_PREPARATION_STALE"); assert.equal(rejected.body.reprepareRequired, true);
  assert.equal(raced.state.gatewayCalls, 0); assert.equal(raced.state.parents[0].billing.credits_charged, 0);
}
checks.push("second current-release check catches publication between initial admission and dispatch, returns 409 with reprepare guidance and zero gateway/charge");
{
  const concurrent = harness();
  await concurrent.post({ action: "prepare", materials: concurrent.materials("fixture_prepared_race") });
  const row = clone(concurrent.state.parents[0]);
  const outcomes = await Promise.all([concurrent.repo.claimCoverAnalysis(row, { analysis: true, image: true }), concurrent.repo.claimCoverAnalysis(row, { analysis: true, image: true })]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(concurrent.state.gatewayCalls, 0);
  const outdated = clone(row); concurrent.state.parents[0].state = "prepared"; concurrent.state.parents[0].updated_at = "2030-01-01T00:00:00.000Z";
  assert.equal(await concurrent.repo.claimCoverAnalysis(outdated, { analysis: true, image: true }), null);
}
checks.push("prepared CAS admits one claimant and refuses a stale updated_at snapshot without any provider dispatch");
{
  const unknownLegacy = harness(); unknownLegacy.state.mode = "unknown";
  const prepared = await unknownLegacy.post({ action: "prepare", materials: unknownLegacy.materials("fixture_old_paid_unknown") });
  await unknownLegacy.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  const row = unknownLegacy.state.parents[0];
  // Explicit genuine historical fixture: V2 paid operations had both consents.
  delete row.preparation.workflowVersion; delete row.preparation.recordKind;
  row.consent.image = true;
  row.preparation.analysisPromptVersion = "cover-content-analysis/1.0.0";
  delete row.preparation.promptDependencies; delete row.preparation.promptDependenciesFingerprint; delete row.preparation.textRendering;
  unknownLegacy.state.mode = "success";
  unknownLegacy.state.children[0] = unknownLegacy.successfulChild(row);
  const recovered = await unknownLegacy.get(row.id);
  assert.equal(recovered.snapshot.status, "plan_ready", JSON.stringify(recovered));
  assert.equal(recovered.snapshot.renderPlan.textRendering, undefined);
  assert.equal(recovered.snapshot.billing.credits_charged, 2); assert.equal(unknownLegacy.state.gatewayCalls, 1);
  await unknownLegacy.post({ action: "analyze", operationId: row.id, consent: { analysis: true, image: true } });
  assert.equal(unknownLegacy.state.gatewayCalls, 1);
  assert.equal(unknownLegacy.state.parents.filter(item => item.preparation.recordKind === "confirmation").length, 0, "Original recovery must not append a new generation confirmation");
}
checks.push("legacy unknown paid child recovers only its original verified reply and bill as overlay, bypassing current unpaid-preparation checks without resubmission");
{
  const fallback = harness();
  fallback.imageModel.capabilities.aspectRatios = ["9:16", "16:9"];
  const prepared = await fallback.post({ action: "prepare", materials: fallback.materials("fixture_native_contain_fallback") });
  assert.equal(prepared.status, 200); assert.equal(prepared.snapshot.generationSpec.ratioEvidence, "application_contain_mapping");
  assert.equal(prepared.snapshot.generationSpec.aspectRatio, "9:16"); assert.equal(prepared.snapshot.generationSpec.crop, undefined);
  assert.ok(prepared.snapshot.notices.some(notice => notice.includes("完整保留") && notice.includes("留白")));
  const ready = await fallback.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
  assert.equal(ready.snapshot.status, "plan_ready", JSON.stringify(ready.snapshot.analysisIssue));
  assert.equal(ready.snapshot.generationInput.prompt.includes("center_crop"), false);
  assert.equal(ready.snapshot.renderPlan.outputSpec.fit, "contain");
  const guarded = { userId: ownerA, task: ready.snapshot.task, generationInput: ready.snapshot.generationInput,
    ...ready.snapshot.generationIdentity, requestUrl: "https://fixture.invalid/api/cover/attempt" };
  await fallback.guard.validatePreparedCoverGeneration(guarded);
  fallback.imageModel.capabilities.aspectRatios = ["3:4", "16:9"];
  await assert.rejects(() => fallback.guard.validatePreparedCoverGeneration(guarded), error => error.code === "COVER_IMAGE_CONFIGURATION_CHANGED");
  assert.equal((await fallback.guard.validatePreparedCoverGeneration({ ...guarded, phase: "delivery" })).length, 0);
  assert.equal(fallback.state.gatewayCalls, 1);
}
checks.push("native fallback freezes contain mapping without crop; changing current generation ratio blocks new dispatch but never blocks already-paid delivery");
{
  const ids = [referenceId, "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
  const phrases = ["@图1 是模特，请保留本人外观。", "@图2 是牙膏，请使用包装外观。", "@图3 是参考封面，只借鉴构图与标题层级。"];
  const text = phrases.join("") + "模特展示牙膏。";
  const usage = ids.map((assetId, index) => ({ assetId, imageNumber: index + 1, role: index === 2 ? "style_reference" : "identity_subject",
    source: "explicit_user", evidenceRefs: [`usage${index + 1}`] }));
  const evidence = phrases.map((quote, index) => ({ id: `usage${index + 1}`, source: "text", quote, fields: ["visualBrief.subject"] }));
  for (const corruption of [null, "nonsequential", "neighbor-evidence", "wrong-number", "missing-usage", "conflicting-roles", "clarification"]) {
    const semantic = harness();
    for (const id of ids.slice(1)) semantic.assetFixtures.push({ ...semantic.assetFixtures[0], id });
    const producedUsage = clone(usage);
    const numbers = corruption === "nonsequential" ? [7, 1, 3] : [1, 2, 3];
    const currentPhrases = phrases.map((phrase, index) => phrase.replace(`@图${index + 1}`, `@图${numbers[index]}`));
    producedUsage.forEach((entry, index) => { entry.imageNumber = numbers[index]; });
    if (corruption === "neighbor-evidence") producedUsage[2].evidenceRefs = ["usage1"];
    if (corruption === "wrong-number") producedUsage[2].imageNumber = 1;
    if (corruption === "conflicting-roles") producedUsage[2] = { ...producedUsage[0], role: "style_reference" };
    semantic.state.usageFixture = { usage: corruption === "missing-usage" ? null : producedUsage,
      evidence: evidence.map((item, index) => ({ ...item, quote: currentPhrases[index] })), referenceAssetId: ids[2], needsInput: corruption === "clarification" };
    const input = { ...semantic.materials(`fixture_semantic_${corruption || "valid"}`), text: corruption === "clarification"
      ? "@图1只作风格参考、不用本人外观，同时必须保留本人外观。" : corruption === "nonsequential" ? currentPhrases.join("") + "模特展示牙膏。" : text, imageMode: "compose",
      assets: ids.map((assetId, index) => ({ assetId, imageNumber: numbers[index], role: "style_reference" })) };
    if (corruption === "clarification") semantic.state.usageFixture.evidence = [];
    const prepared = await semantic.post({ action: "prepare", materials: input });
    const done = await semantic.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
    assert.equal(semantic.state.gatewayCalls, 1);
    if (corruption === null || corruption === "nonsequential") {
      assert.equal(done.snapshot.status, "plan_ready", JSON.stringify(done.snapshot.analysisIssue));
      assert.equal(done.snapshot.renderPlan.generatedOverlayLayout.version, "cover-generated-overlay-safe-frame/1");
      assert.equal(done.snapshot.renderPlan.generatedOverlayLayout.placement, "top");
      assert.equal(done.snapshot.renderPlan.outputSpec.fit, "contain");
      assert.equal(done.snapshot.renderPlan.titleStyle.x, .04); assert.equal(done.snapshot.renderPlan.titleStyle.y, .025);
      assert.ok(done.snapshot.generationInput.prompt.includes("do not reserve an additional title zone"));
      assert.equal(done.snapshot.analysis.materialUsage[2].assetId, ids[2]);
      assert.ok(done.snapshot.generationInput.prompt.includes(`"assetId":"${ids[0]}"`));
      assert.ok(done.snapshot.generationInput.prompt.includes('"role":"identity_subject"'));
      const observationText = done.snapshot.generationInput.prompt.split("参考图已验证的视觉观察（cover-visual-binding/1）：")[1];
      const boundObservations = JSON.parse(observationText);
      assert.deepEqual(boundObservations.map(item => [item.assetId, item.inputIndex, item.imageNumber, item.reference, item.role]),
        ids.map((assetId, index) => [assetId, index + 1, numbers[index], `@图${numbers[index]}`, usage[index].role]));
      assert.ok(boundObservations.every(item => Number.isSafeInteger(item.assetRevision) && item.assetRevision > 0));
      if (corruption === "nonsequential") assert.ok(done.snapshot.generationInput.prompt.includes('"inputIndex":1,"reference":"@图7"'));
      assert.equal(semantic.state.parents[0].materials.assets[0].role, "style_reference", "Semantic overrides cannot rewrite the original input snapshot");
    } else if (corruption === "clarification") {
      assert.equal(done.snapshot.status, "needs_input", JSON.stringify(done.snapshot.analysisIssue));
      assert.ok(done.snapshot.error.includes("@图1")); assert.equal(done.snapshot.generationInput, undefined);
      assert.equal(done.snapshot.billing.credits_charged, 2);
    } else {
      assert.equal(done.snapshot.status, "failed"); assert.equal(done.snapshot.generationInput, undefined);
      assert.equal(done.snapshot.analysisIssue.category, "materials"); assert.equal(done.snapshot.billing.credits_charged, 2);
      if (corruption === "conflicting-roles") assert.equal(done.snapshot.code, "COVER_MATERIAL_ROLE_CONFLICT");
    }
    await semantic.analyzeAndConfirm({ action: "analyze", operationId: prepared.snapshot.operationId, consent: { analysis: true, image: true } });
    assert.equal(semantic.state.gatewayCalls, 1, "Role validation or clarification never purchases a second analysis");
  }
}
checks.push("actual three-image analysis roles drive reference and generation bindings while an independent safe header replaces guessed generated-image coordinates; source snapshot stays fixed, adjacent-image proofs/number swaps/missing usage fail, and explicit role conflict requests clarification without generation or repeat charge");
{
  // PostgreSQL JSONB reorders nested object keys. Fingerprinting a JSON string
  // compiled from raw asset objects must not treat that round trip as an edit.
  const jsonb = value => Array.isArray(value) ? value.map(jsonb) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)).map(([key, item]) => [key, jsonb(item)])) : value;
  for (const count of [1, 3]) {
    const current = harness();
    const ids = Array.from({ length: count }, (_, i) => `00000000-0000-4000-8000-00000000000${i + 3}`);
    for (const id of ids.slice(1)) current.assetFixtures.push({ ...current.assetFixtures[0], id });
    const input = { ...current.materials(`jsonb_asset_order_${count}`),
      ...(count > 1 ? { imageMode: "compose" } : {}),
      assets: ids.map((assetId, i) => ({ assetId, role: "style_reference", imageNumber: i + 1 })) };
    const prepared = await current.post({ action: "prepare", materials: input });
    assert.equal(prepared.status, 200);
    const row = current.state.parents.find(item => item.id === prepared.snapshot.operationId);
    const beforeMessages = await current.service.coverAnalysisRequest(row);
    row.materials = jsonb(row.materials);
    row.preparation = jsonb(row.preparation);
    assert.equal(Object.keys(row.materials.assets[0])[0], "role", "Exercise actual JSONB-like property reordering");
    assert.doesNotThrow(() => current.service.assertCoverPreparationCurrent(row));
    assert.equal(JSON.stringify(await current.service.coverAnalysisRequest(row)), JSON.stringify(beforeMessages));
    const unchanged = clone(row.materials);
    row.materials.assets[0].role = "identity_subject";
    assert.throws(() => current.service.assertCoverPreparationCurrent(row), /制作方案已更新/u, "Real binding changes must still fail closed");
    row.materials = clone(unchanged);
    row.materials.assets[0].assetId = ownerB;
    assert.throws(() => current.service.assertCoverPreparationCurrent(row), /制作方案已更新/u);
    row.materials = clone(unchanged);
    if (count > 1) {
      row.materials.assets.reverse();
      assert.throws(() => current.service.assertCoverPreparationCurrent(row), /制作方案已更新/u, "Image order remains significant");
    }
    assert.equal(current.state.gatewayCalls, 0);
  }
}
checks.push("one/three image material JSONB key reordering preserves exact compiled messages and preparation fingerprints; asset ID, role and image-order changes still reject before any gateway call");
{
  const current = harness();
  const ids = [referenceId, "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
  const input = { ...current.materials("visual_binding_reverse"), imageMode: "compose", assets: ids.map((assetId, index) => ({
    assetId, imageNumber: [7, 1, 3][index], role: ["identity_subject", "identity_subject", "style_reference"][index],
  })) };
  const observations = ids.map((assetId, index) => ({ assetId, assetRevision: index + 10, observations: [{ description: `owned image ${index}` }], palette: ["#123456"] })).reverse();
  const before = JSON.stringify({ input, observations });
  const bound = current.service.compileBoundCoverVisualObservations(input, observations);
  assert.deepEqual(bound.map(item => [item.assetId, item.assetRevision, item.inputIndex, item.imageNumber, item.reference, item.role]),
    ids.map((assetId, index) => [assetId, index + 10, index + 1, [7, 1, 3][index], `@图${[7, 1, 3][index]}`, input.assets[index].role]));
  for (const item of bound) {
    assert.deepEqual(item.observations, observations.find(original => original.assetId === item.assetId).observations);
    assert.deepEqual(item.palette, observations.find(original => original.assetId === item.assetId).palette);
  }
  assert.equal(JSON.stringify({ input, observations }), before);
  assert.throws(() => current.service.compileBoundCoverVisualObservations(input, [...observations, observations[0]]), error => error.code === "COVER_VISUAL_OBSERVATION_BINDING_INVALID");
  assert.throws(() => current.service.compileBoundCoverVisualObservations(input, [{ ...observations[0], assetId: ownerB }]), error => error.code === "COVER_VISUAL_OBSERVATION_BINDING_INVALID");
  assert.equal(current.state.gatewayCalls, 0); assert.equal(current.state.storageReads, 0);
}
checks.push("visual observations follow owned asset bindings rather than response order; nonsequential image numbers, reviewed roles, original revisions/observations/colors and input bytes survive, while duplicate or foreign observations fail closed");
const report = { passed: true, checks: checks.length, originalScenarioGroupsPreserved: 28, additionalWorkflowBoundaryGroups: 2, additionalPersistenceGroups: 1,
  networkCalls: 0, providerCalls: 0, liveDatabaseCalls: 0,
  evidence: "Actual V3 prepare/analyze/operations/confirm HTTP routes, repository/service/compiler and confirmation-bound generation guard; public responses stay separate from explicitly inspected private fixture snapshots. Catalogs, LLM gateway, storage and DB are in-memory fixtures. No execute/render/provider request is made.", cases: checks };
if (process.env.COVER_PREPARE_REGRESSION_EVIDENCE_DIR) {
  const directory = path.resolve(process.env.COVER_PREPARE_REGRESSION_EVIDENCE_DIR); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "zero-network-report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
