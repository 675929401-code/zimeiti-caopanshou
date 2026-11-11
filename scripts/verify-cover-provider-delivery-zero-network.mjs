#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

// Actual attempt/guard/render handlers, real plan checks and Sharp glyphs.
// All authentication, provider/export/persist boundaries and DB state are
// bounded in-memory fixtures. No credentials, service or provider is accessed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerA = "00000000-0000-4000-8000-000000000001";
const ownerB = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const backgroundId = "00000000-0000-4000-8000-000000000004";
const outputId = "00000000-0000-4000-8000-000000000005";
const attemptId = "00000000-0000-4000-8000-000000000006";
const historyId = "00000000-0000-4000-8000-000000000007";
const exportHistoryId = "00000000-0000-4000-8000-000000000008";
const key = `coverwb_${parentId}`;
const sha = value => createHash("sha256").update(value).digest("hex");
const clone = value => JSON.parse(JSON.stringify(value));
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error("Forbidden external I/O"); };
const source = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#598F72" } }).png().toBuffer();
const pureCache = new Map();
function compile(relative, imports) {
  const module = { exports: {} };
  const result = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), { fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.deepEqual((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, console,
    fetch: forbidden, require(id) { assert.ok(Object.hasOwn(imports, id), `Unexpected import ${relative}: ${id}`); return imports[id]; } }, { filename: relative });
  return module.exports;
}
function pure(relative) {
  if (pureCache.has(relative)) return pureCache.get(relative);
  const common = { "server-only": {}, "node:crypto": { createHash, randomUUID }, "node:fs": { existsSync }, sharp: { default: sharp }, zod: { z } };
  const definitions = {
    "src/lib/cover-composition.ts": {},
    "src/lib/storyboard-annotation-layout.ts": {},
    "src/lib/image-ephemeral-delivery.ts": {},
    "src/lib/cover-material-composition.ts": {},
    "src/lib/cover-style-catalog.ts": {},
    "src/lib/cover-number-evidence.ts": {},
    "src/lib/cover-narrative-summary.ts": { "./cover-number-evidence": () => pure("src/lib/cover-number-evidence.ts") },
    "src/lib/cover-source-spans.ts": { "./cover-number-evidence": () => pure("src/lib/cover-number-evidence.ts") },
    "src/lib/cover-benchmark-profiles.ts": { "./cover-style-catalog": () => pure("src/lib/cover-style-catalog.ts") },
    "src/lib/cover-material-usage.ts": { "./cover-material-composition": () => pure("src/lib/cover-material-composition.ts") },
    "src/lib/cover-workbench-contract.ts": {
      "./cover-material-usage": () => pure("src/lib/cover-material-usage.ts"),
      "./cover-composition": () => pure("src/lib/cover-composition.ts"),
      "./cover-benchmark-profiles": () => pure("src/lib/cover-benchmark-profiles.ts"),
      "./cover-source-spans": () => pure("src/lib/cover-source-spans.ts"),
      "./cover-number-evidence": () => pure("src/lib/cover-number-evidence.ts"),
      "./cover-narrative-summary": () => pure("src/lib/cover-narrative-summary.ts"),
      "./cover-material-composition": () => pure("src/lib/cover-material-composition.ts"),
    },
    "src/lib/cover-review-contract.ts": {},
    "src/lib/server/cover-analysis-recovery.ts": {},
    "src/lib/server/cover-public-error.ts": {},
    "src/lib/server/cover-review-projection.ts": {
      "@/lib/cover-workbench-contract": () => pure("src/lib/cover-workbench-contract.ts"),
      "@/lib/cover-review-contract": () => pure("src/lib/cover-review-contract.ts"),
      "@/lib/cover-style-catalog": () => pure("src/lib/cover-style-catalog.ts"),
      "@/lib/cover-durable-attempt": () => pure("src/lib/cover-durable-attempt.ts"),
      "@/lib/cover-composition": () => pure("src/lib/cover-composition.ts"),
      "./cover-analysis-recovery": () => pure("src/lib/server/cover-analysis-recovery.ts"),
    },
    "src/lib/cover-durable-attempt.ts": { "@/lib/cover-composition": () => pure("src/lib/cover-composition.ts") },
    "src/lib/cover-composition-server.ts": { "./cover-composition": () => pure("src/lib/cover-composition.ts"),
      "./storyboard-annotation-layout": () => pure("src/lib/storyboard-annotation-layout.ts") },
  };
  assert.ok(Object.hasOwn(definitions, relative));
  for (const [name, value] of Object.entries(definitions[relative])) common[name] = value();
  const loaded = compile(relative, common); pureCache.set(relative, loaded); return loaded;
}
const composition = pure("src/lib/cover-composition.ts");
const renderer = pure("src/lib/cover-composition-server.ts");
const ephemeral = pure("src/lib/image-ephemeral-delivery.ts");
const durable = pure("src/lib/cover-durable-attempt.ts");
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const next = { NextRequest, NextResponse: { json: (value, init) => Response.json(value, init) } };
class ExportError extends Error { constructor(code, status = 503) { super(code); this.code = code; this.status = status; } }
const checks = [];

function fixture(options = {}) {
  const key = options.legacy ? "cover_legacy_original_fixture" : `coverwb_${parentId}`;
  const plan = { title: "先做十分钟", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-cover-workbench", animationStyleId: "pixar-3d",
    coverModeId: "cartoon", materialSourceId: "text", subjectModeId: "semantic", ...(options.legacy ? {} : { planVersion: 2,
      outputSpec: { aspectRatio: "3:4", width: 1080, height: 1440, format: "png" }, titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#FFF1B8" } }) };
  if (options.native) {
    plan.textRendering = { mode: "native", version: "cover-text-rendering/1" };
    plan.outputSpec.fit = "contain";
  }
  if (options.safeFrame) {
    plan.generatedOverlayLayout = composition.coverGeneratedOverlayPolicy();
    plan.titleStyle = composition.coverGeneratedOverlayTitleStyle();
    plan.materialSourceId = "upload"; plan.outputSpec.fit = "contain";
    plan.textRendering = { mode: "overlay", version: composition.COVER_TEXT_RENDERING_VERSION };
  }
  const generationInput = { prompt: "A person begins working at a desk, no text.", modelId: "pm_fixture_image", mode: "local", style: "cartoon",
    aspectRatio: "3:4", resolution: "2K", coverText: "", referenceImageUrls: [], referenceUsage: "general", historySurface: "cover-studio" };
  const task = { id: `cover-workbench-${parentId}`, ...(options.legacy ? {} : { prepareOperationId: parentId }), title: plan.title, subtitle: "", ratio: "3:4",
    prompt: generationInput.prompt, briefText: "每天先做十分钟", source: "生成", createdAt: "2026-11-06T00:00:00.000Z", taskNo: 0, renderPlan: plan };
  const row = { id: attemptId, user_id: ownerA, surface: "cover-studio", client_idempotency_key: key, client_trace_id: key,
    state: options.state || "claimed", task, generation_input: generationInput, requires_reference_reupload: false,
    background_asset_id: null, result_asset_id: null, history_record_id: null, error_code: options.errorCode || null,
    created_at: "2026-11-06T00:00:00.000Z", updated_at: "2026-11-06T00:00:00.000Z", cancelled_at: null,
    completed_at: options.state === "failed" ? "2026-11-06T00:00:00.000Z" : null };
  const parent = { id: parentId, user_id: ownerA, state: "plan_ready", materials: { text: task.briefText, assets: [] },
    consent: { analysis: true, image: true }, preparation: { route: "text_to_image", outputSpec: plan.outputSpec, quote: { image: { amount: .30 } } },
    result: { renderPlan: clone(plan), generationInput: clone(generationInput) } };
  const recordId = sha(`${ownerA}\0${key}`);
  const image = { schemaVersion: "image_exactly_once.v1", recordId, userHash: sha(ownerA), clientIdempotencyKey: key, clientTraceId: key,
    payloadFingerprint: "a".repeat(64), requestSnapshot: { schema: "image_generation_request_snapshot.v2", surface: "cover-studio",
      prompt: generationInput.prompt, publicModelId: generationInput.modelId, aspectRatio: generationInput.aspectRatio, resolution: "2K",
      style: generationInput.style, referenceUsage: "general", payloadFingerprint: "a".repeat(64), quotedPriceYuan: .30 },
    state: "completed", deliveryState: "delivered", response: { deliveryMode: "provider_url", cashCharged: .30 },
    createdAt: row.created_at, updatedAt: row.updated_at };
  let transient;
  if (options.inline) {
    const delivery = ephemeral.createImageEphemeralDelivery({ recordId, buffer: source, contentType: "image/png", width: 2048, height: 2048,
      selectedModelId: "fixture-internal", selectedCostPrice: .1 });
    image.response = delivery.receipt; transient = delivery.transientDelivery;
  }
  const state = { owner: ownerA, authorized: true, row, parent, image: options.preexisting ? image : null,
    files: [], histories: [], messages: [], storage: new Map(), catalogUnavailable: false, afterExport: null,
    counts: { provider: 0, export: 0, render: 0, persist: 0, legacyCompose: 0, catalog: 0, parentReads: 0,
      references: 0, signedUrls: 0, storageReads: 0, recoveryCas: 0, successfulRecoveryCas: 0, begin: 0 }, mutations: [], casPredicates: [] };
  const tables = { cover_generation_attempts: () => [state.row], cover_prepare_operations: () => [state.parent], user_files: () => state.files,
    cover_generation_history: () => state.histories, conversation_messages: () => state.messages };
  function from(table) {
    assert.ok(Object.hasOwn(tables, table), `Unexpected DB table ${table}`);
    const filters = [], orders = []; let patch, cap;
    let executed;
    const execute = () => {
      if (executed) return executed;
      let matches = tables[table]().filter(row => row && filters.every(([op, field, expected]) => {
        if (op === "eq") return row[field] === expected;
        if (op === "in") return expected.includes(row[field]);
        return expected === null ? row[field] == null : row[field] === expected;
      }));
      if (table === "cover_prepare_operations") state.counts.parentReads += 1;
      if (patch) {
        assert.equal(table, "cover_generation_attempts");
        state.counts.recoveryCas += 1; state.casPredicates.push(clone(filters));
        state.counts.successfulRecoveryCas += matches.length;
        state.mutations.push({ table, patch: clone(patch), count: matches.length });
        for (const row of matches) Object.assign(row, clone(patch));
      }
      if (orders.length) matches = [...matches].sort((a, b) => String(a[orders[0]]).localeCompare(String(b[orders[0]])));
      if (cap !== undefined) matches = matches.slice(0, cap);
      executed = { data: clone(matches), error: null }; return executed;
    };
    const query = { select() { return query; }, eq(field, value) { filters.push(["eq", field, value]); return query; },
      in(field, values) { filters.push(["in", field, values]); return query; }, is(field, value) { filters.push(["is", field, value]); return query; },
      order(field) { orders.push(field); return query; }, limit(value) { cap = value; return query; }, update(value) { patch = value; return query; },
      async maybeSingle() { const result = execute(); assert.ok(result.data.length <= 1); return { ...result, data: result.data[0] || null }; },
      then(resolve, reject) { return Promise.resolve(execute()).then(resolve, reject); } };
    return query;
  }
  let tick = 0;
  const timestamp = () => new Date(Date.UTC(2026, 10, 6, 0, 0, ++tick)).toISOString();
  const db = { from, async rpc(name, input) {
    assert.equal(input.p_user_id, state.owner);
    if (name === "reconcile_stale_cover_generation_attempts") return { data: [], error: null };
    if (name === "begin_cover_generation_dispatch") {
      state.counts.begin += 1;
      const acquired = state.row.user_id === input.p_user_id && state.row.state === "claimed";
      if (acquired) Object.assign(state.row, { state: "dispatched", updated_at: timestamp() });
      return { data: { acquired, record: clone(state.row) }, error: null };
    }
    if (name === "settle_cover_generation_attempt") {
      assert.equal(input.p_client_idempotency_key, key); assert.equal(input.p_client_trace_id, key);
      if (!["completed", "failed", "cancelled"].includes(state.row.state)) {
        Object.assign(state.row, { state: input.p_state, updated_at: timestamp(),
          ...(input.p_background_asset_id ? { background_asset_id: input.p_background_asset_id } : {}),
          ...(input.p_result_asset_id ? { result_asset_id: input.p_result_asset_id } : {}),
          ...(input.p_history_record_id ? { history_record_id: input.p_history_record_id } : {}),
          ...(["completed", "failed"].includes(input.p_state) ? { completed_at: timestamp() } : {}),
          ...(input.p_error_code ? { error_code: input.p_error_code } : {}) });
      }
      return { data: { record: clone(state.row) }, error: null };
    }
    if (name === "record_cover_composition") {
      const history = { asset_id: input.p_asset_id, user_id: input.p_user_id, background_asset_id: input.p_background_asset_id,
        history_record_id: input.p_history_record_id, plan: clone(input.p_plan), output_width: input.p_output_width,
        output_height: input.p_output_height, source_width: input.p_source_width, source_height: input.p_source_height,
        task_no: 1, created_at: timestamp(), hidden_at: null };
      delete history.plan._authoring;
      state.histories.push(history);
      return { data: history, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  } };
  const storage = { async read(storageKey, provider) { assert.equal(provider, "tencent_cos"); state.counts.storageReads += 1;
    assert.ok(state.storage.has(storageKey)); return state.storage.get(storageKey); }, getSignedUrl: forbidden };
  const shared = { "next/server": next, "node:crypto": { createHash, randomUUID },
    "@/lib/current-api-user": { authorizeCurrentApiUser: async () => state.authorized ? { ok: true, user: { userId: state.owner } }
      : { ok: false, response: Response.json({ code: "UNAUTHORIZED" }, { status: 401 }) } },
    "@/storage/database/supabase-client": { getSupabaseClient: () => db }, "@/storage/object": { storageManager: storage } };
  const recovery = compile("src/lib/server/cover-analysis-recovery.ts", shared);
  const repository = compile("src/lib/server/cover-prepare-repository.ts", { ...shared, "./cover-analysis-recovery": recovery });
  const service = { object: value => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    coverOwnedAssets: async () => { state.counts.references += 1; return []; },
     coverImageSelection: async () => { state.counts.catalog += 1; if (state.catalogUnavailable) throw new Error("Current catalog must not be read during delivery"); return { amount: state.currentAmount ?? .30 }; } };
  const guard = compile("src/lib/server/cover-prepared-generation.ts", { ...shared,
    "./cover-prepare-repository": repository, "./cover-prepare-service": service,
    "./cover-review-projection": pure("src/lib/server/cover-review-projection.ts"),
    "@/lib/cover-material-composition": pure("src/lib/cover-material-composition.ts") });
  const completedReceipt = compile("src/lib/server/cover-completed-receipt.ts", { ...shared,
    "@/lib/cover-composition": composition, "./cover-prepare-repository": repository, "./cover-prepared-generation": guard });
  const generatedDelivery = compile("src/lib/cover-generated-delivery.ts", { "node:crypto": { createHash },
    "@/lib/cover-composition": composition,
    "@/lib/cover-composition-server": { renderCoverComposition: async (...args) => { state.counts.legacyCompose += 1; return renderer.renderCoverComposition(...args); } },
    "@/lib/image-ephemeral-delivery": ephemeral,
    "@/lib/server/generated-image-reference": { readGeneratedImageMaterial: async () => ({ buffer: source }) },
    "@/lib/image-failure-history": { imageFailureBillingReferenceId: (userId, requestKey) => `image:h3_${sha(`${userId}:${requestKey}`).slice(0, 48)}` } });
  const render = compile("src/app/api/cover/render/route.ts", { ...shared, zod: { z }, "@/lib/cover-composition": composition,
    "@/lib/cover-composition-server": renderer, "@/lib/auth": { getTokenFromHeaders: () => "fixture-token" },
    "@/app/api/image-workbench/persist/route": { POST: async request => {
      const body = await request.json(); state.counts.persist += 1;
      assert.equal(body.intent, "user_asset_export"); assert.match(body.url, /^data:image\/png;base64,/u);
      const bytes = Buffer.from(body.url.split(",")[1], "base64");
      state.storage.set("fixture/cover.png", bytes);
      state.files.push({ id: outputId, user_id: ownerA, storage_key: "fixture/cover.png", storage_provider: "tencent_cos", file_category: "image",
        content_type: "image/png", file_size: bytes.length });
      state.messages.push({ id: historyId, user_id: ownerA, agent_id: "image-workbench", role: "assistant" });
      return Response.json({ status: "completed", persisted: true, cloudStored: true, assetId: outputId, key: "fixture/cover.png",
        historyRecordId: historyId, url: `/api/storage/files/${outputId}/content` });
    } } });
  const exportHelper = async input => {
    state.counts.export += 1;
    assert.equal(input.userId, ownerA); assert.equal(input.recordId, recordId);
    assert.equal(input.clientIdempotencyKey, key); assert.equal(input.clientTraceId, key);
    if (!state.files.some(file => file.id === backgroundId)) state.files.push({ id: backgroundId, user_id: ownerA,
      storage_key: "fixture/background.png", storage_provider: "tencent_cos", file_category: "image", content_type: "image/png", file_size: source.length,
      ...(options.native ? { meta: { coverGeneratedExport: { nativePlan: clone(input.plan) } } } : {}) });
    state.storage.set("fixture/background.png", source);
    state.afterExport?.();
    return { success: true, persisted: true, cloudStored: true, userId: ownerA, recordId, assetId: backgroundId, historyRecordId: exportHistoryId,
      key: "fixture/background.png", storageKey: "fixture/background.png", provider: "tencent_cos", contentType: "image/png", byteLength: source.length,
      width: 2048, height: 2048, sha256: sha(source), exportTraceId: "fixture-export", reused: state.counts.export > 1 };
  };
  const attempt = compile("src/app/api/cover/attempt/route.ts", { ...shared,
    "@/lib/server/cover-completed-receipt": completedReceipt,
    "@/lib/server/cover-public-error": pure("src/lib/server/cover-public-error.ts"),
    "@/lib/cover-durable-attempt": durable, "@/lib/cover-composition": composition,
    "@/lib/server/cover-prepared-generation": guard, "@/lib/server/cover-prepare-repository": repository,
    "@/lib/server/cover-generated-export": { CoverGeneratedExportError: ExportError, exportGeneratedCoverBackground: exportHelper },
    "@/lib/cover-generated-delivery": generatedDelivery,
    "@/lib/image-exactly-once": { DatabaseImageExactlyOnceStore: class { async get(input) {
      return input.userId === ownerA && input.clientIdempotencyKey === key && input.clientTraceId === key ? clone(state.image) : null;
    } }, getImageProviderCheckpointState: () => ({ hasCheckpoint: false }), getImageRequestRejection: () => null,
    ImageRequestRejectedError: class extends Error {} },
    "@/lib/image-workbench-attempt-guard": { isConfirmedTerminalImageFailure: () => false },
    "@/app/api/image/generate/route": { POST: async request => {
      state.counts.provider += 1; assert.equal(state.counts.provider, 1, "Only the initial dispatch may call the model gateway");
      const body = await request.json(); assert.equal(body.clientIdempotencyKey, key); assert.equal(body.clientTraceId, key);
      assert.equal(body.resumeDeliveryOnly, undefined); state.image = clone(image);
      return Response.json({ success: true, status: "completed", recordId, images: options.inline
        ? [{ url: transient.dataUrl, recordId, deliveryMode: "inline_ephemeral" }] : [{ url: "https://fixture.invalid/opaque-provider-result" }] });
    } },
    "@/app/api/cover/render/route": { POST: async request => { state.counts.render += 1; return render.POST(request); } } });
  function request(method = "GET", body) { return new NextRequest(`https://fixture.invalid/api/cover/attempt?${new URLSearchParams({ clientIdempotencyKey: key, clientTraceId: key })}`,
    { method, headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  async function get() { const response = await attempt.GET(request()); return { status: response.status, body: await response.json() }; }
  async function dispatch() { const response = await attempt.POST(request("POST", { action: "dispatch", clientIdempotencyKey: key, clientTraceId: key, payload: generationInput }));
    return { status: response.status, body: await response.json() }; }
  async function claim(overrides = {}) { const response = await attempt.POST(request("POST", { action: "claim", clientIdempotencyKey: key,
    clientTraceId: key, task, payload: generationInput, referenceCount: 0, ...overrides })); return { status: response.status, body: await response.json() }; }
  return { state, get, dispatch, claim, plan, image, guard, repository };
}

{
  const test = fixture();
  const result = await test.dispatch();
  assert.equal(result.status, 200); assert.equal(result.body.completed, true);
  assert.equal(result.body.result.persisted, true); assert.equal(result.body.result.cloudStored, true);
  assert.equal(result.body.backgroundAssetId, backgroundId); assert.equal(result.body.result.assetId, outputId);
  assert.equal(composition.coverCompositionMatches(result.body.result, test.plan, backgroundId), true);
  assert.equal(test.state.row.state, "completed"); assert.equal(test.state.histories.length, 1);
  assert.equal(test.state.counts.provider, 1); assert.equal(test.state.counts.export, 1); assert.equal(test.state.counts.render, 1);
  assert.equal(test.state.counts.legacyCompose, 0); assert.equal(test.state.counts.catalog, 1);
  const png = await sharp(test.state.storage.get("fixture/cover.png")).metadata();
  assert.equal(png.width, 1080); assert.equal(png.height, 1440);
  const before = clone(test.state.counts);
  test.state.catalogUnavailable = true;
  const replay = await test.get();
  assert.equal(replay.status, 200); assert.equal(replay.body.completed, true);
  assert.equal(composition.coverCompositionMatches(replay.body.result, test.plan, backgroundId), true);
  assert.equal(replay.body.result.status, "completed"); assert.equal(replay.body.result.historyRecordId, historyId);
  assert.equal(replay.body.result.url, `/api/storage/files/${outputId}/content`);
  for (const field of ["provider", "export", "render", "persist", "catalog", "storageReads", "legacyCompose"]) assert.equal(test.state.counts[field], before[field]);
  checks.push("actual V2 dispatch exports the provider result, renders real fixed-size PNG glyphs and persists; completed GET reconstructs the owned receipt without render/model/current-catalog I/O");
  for (const corrupt of ["asset_owner", "history_owner", "history_plan", "history_dimensions", "media_owner"]) {
    const saved = { files: clone(test.state.files), histories: clone(test.state.histories), messages: clone(test.state.messages) };
    if (corrupt === "asset_owner") test.state.files.find(file => file.id === outputId).user_id = ownerB;
    if (corrupt === "history_owner") test.state.histories[0].user_id = ownerB;
    if (corrupt === "history_plan") test.state.histories[0].plan.title = "wrong title";
    if (corrupt === "history_dimensions") test.state.histories[0].output_width = 1;
    if (corrupt === "media_owner") test.state.messages[0].user_id = ownerB;
    const denied = await test.get(); assert.equal(denied.status, 503, corrupt); assert.notEqual(denied.body.completed, true);
    Object.assign(test.state, saved);
  }
  assert.equal(test.state.counts.render, before.render); assert.equal(test.state.counts.provider, before.provider);
  checks.push("completed receipt rejects cross-owner/mismatched assets, media history, frozen plan or fixed dimensions without recreating a result");
}
for (const errorCode of ["COVER_DURABLE_DELIVERY_NOT_APPLICABLE", "COVER_TEMPORARY_COMPOSITION_FAILED"]) {
  const test = fixture({ state: "failed", errorCode, preexisting: true }); test.state.catalogUnavailable = true;
  const result = await test.get();
  assert.equal(result.body.completed, true); assert.equal(result.body.result.persisted, true);
  assert.equal(test.state.counts.provider, 0); assert.equal(test.state.counts.catalog, 0); assert.equal(test.state.counts.references, 0);
  assert.equal(test.state.counts.successfulRecoveryCas, 1); assert.equal(test.state.counts.render, 1);
  assert.equal(test.state.row.error_code, null);
  assert.equal(test.state.mutations[0].patch.completed_at, null, "Recovery clears the obsolete failure timestamp before final completion");
  const predicates = test.state.casPredicates[0];
  for (const field of ["id", "user_id", "surface", "client_idempotency_key", "client_trace_id", "state", "error_code", "updated_at", "result_asset_id", "history_record_id", "cancelled_at"]) {
    assert.ok(predicates.some(([, actual]) => actual === field), `Recovery CAS must fence ${field}`);
  }
}
checks.push("each of the two obsolete temporary failures recovers by the exact fenced CAS and original image, without catalog/reference/model dispatch");
{
  const test = fixture({ state: "failed", errorCode: "COVER_DURABLE_DELIVERY_NOT_APPLICABLE", preexisting: true });
  const results = await Promise.all([test.get(), test.get()]);
  assert.ok(results.some(result => result.body.completed));
  assert.equal(test.state.counts.successfulRecoveryCas, 1); assert.equal(test.state.counts.render, 1);
  assert.equal(test.state.counts.provider, 0); assert.equal(test.state.counts.catalog, 0);
  checks.push("concurrent legacy-failure recovery acquires only one CAS; its loser reads the winner's state and never renders or overwrites it");
}
for (const block of ["owner", "consent", "cancelled", "real_failure", "result_present", "history_present", "parent_plan", "parent_prompt", "image_binding"]) {
  const test = fixture({ state: "failed", errorCode: "COVER_DURABLE_DELIVERY_NOT_APPLICABLE", preexisting: true });
  if (block === "owner") test.state.owner = ownerB;
  if (block === "consent") test.state.parent.consent.image = false;
  if (block === "cancelled") test.state.row.state = "cancelled";
  if (block === "real_failure") test.state.row.error_code = "IMAGE_PROVIDER_FAILED";
  if (block === "result_present") test.state.row.result_asset_id = outputId;
  if (block === "history_present") test.state.row.history_record_id = historyId;
  if (block === "parent_plan") test.state.parent.result.renderPlan.title = "different frozen title";
  if (block === "parent_prompt") test.state.parent.result.generationInput.prompt = "different frozen prompt";
  if (block === "image_binding") test.state.image.requestSnapshot.publicModelId = "pm_another_model";
  const result = await test.get();
  assert.notEqual(result.body.completed, true, block);
  assert.equal(test.state.counts.export, 0, block); assert.equal(test.state.counts.render, 0, block);
  assert.equal(test.state.counts.successfulRecoveryCas, 0, block); assert.equal(test.state.counts.provider, 0, block);
}
checks.push("cross-owner, missing consent, cancellation, genuine failures, preexisting result/history and changed frozen/image bindings cannot revive or export the order");
{
  const test = fixture({ state: "failed", errorCode: "COVER_DURABLE_DELIVERY_NOT_APPLICABLE", preexisting: true });
  test.state.afterExport = () => Object.assign(test.state.row, { state: "cancelled", cancelled_at: "2026-11-06T01:00:00.000Z", updated_at: "2026-11-06T01:00:00.000Z" });
  const result = await test.get();
  assert.equal(result.body.completed, false); assert.equal(test.state.row.state, "cancelled");
  assert.equal(test.state.counts.successfulRecoveryCas, 0); assert.equal(test.state.counts.render, 0); assert.equal(test.state.counts.provider, 0);
  checks.push("cancellation racing the original background export defeats CAS and is never overwritten or followed by composition");
}
for (const inline of [false, true]) {
  const test = fixture({ legacy: true, inline });
  const result = await test.dispatch();
  assert.equal(result.status, 200); assert.equal(result.body.completed, true);
  assert.equal(result.body.deliveryMode, "inline_ephemeral"); assert.equal(result.body.mediaAvailable, true);
  assert.equal(test.state.row.state, "failed"); assert.equal(test.state.row.error_code, "COVER_DURABLE_DELIVERY_NOT_APPLICABLE");
  assert.equal(test.state.counts.export, 0); assert.equal(test.state.counts.render, 0); assert.equal(test.state.counts.persist, 0);
  assert.equal(test.state.counts.legacyCompose, 1); assert.equal(test.state.counts.parentReads, 0);
}
checks.push("legacy provider-url and inline-ephemeral covers keep their original temporary composition policy without parent-table access or implicit durable export");
{
  const test = fixture({ native: true });
  const dispatched = await test.dispatch();
  assert.equal(dispatched.status, 200); assert.equal(dispatched.body.completed, true);
  const result = dispatched.body.result;
  assert.equal(result.textRendering.mode, "native"); assert.equal(result.textVerification, "unverified");
  assert.equal(result.renderedText, undefined); assert.equal(result.requestedText.title, test.plan.title);
  assert.equal(composition.coverCompositionMatches(result, test.plan, backgroundId), true);
  assert.equal(test.state.histories[0].plan.textRendering.mode, "native");
  const counts = clone(test.state.counts);
  test.state.catalogUnavailable = true;
  const restored = await test.get();
  assert.equal(restored.body.completed, true); assert.equal(restored.body.result.textRendering.mode, "native");
  assert.equal(restored.body.result.textVerification, "unverified"); assert.equal(restored.body.result.renderedText, undefined);
  assert.equal(test.state.counts.render, counts.render); assert.equal(test.state.counts.provider, counts.provider);
  assert.equal(test.state.counts.catalog, counts.catalog); assert.equal(test.state.counts.export, counts.export);
}
checks.push("actual native durable dispatch saves contain output and frozen mode/history; completed recovery returns requestedText/unverified with no catalog, provider, export or second render");
{
  const test = fixture({ native: true });
  assert.equal((await test.dispatch()).body.completed, true);
  const counts = clone(test.state.counts);
  test.state.catalogUnavailable = true;
  assert.equal((await test.claim()).body.completed, true);
  test.state.catalogUnavailable = false; test.state.currentAmount = 50;
  assert.equal((await test.claim({ action: "adopt" })).body.completed, true);
  assert.equal(test.state.counts.catalog, counts.catalog); assert.equal(test.state.counts.provider, counts.provider);
  assert.equal(test.state.counts.render, counts.render); assert.equal(test.state.counts.export, counts.export);
  const altered = clone(test.state.row.task); altered.prompt += " changed";
  const mismatch = await test.claim({ task: altered, payload: { ...test.state.row.generation_input, prompt: altered.prompt } });
  assert.equal(mismatch.status, 409); assert.equal(mismatch.body.code, "COVER_PREPARED_INPUT_CONFLICT");
}
checks.push("same-key paid claim/adopt re-entry verifies the original snapshot then recovers despite catalog loss or price changes, while changed snapshots remain rejected without generation");
{
  const test = fixture({ safeFrame: true }), frozen = clone(test.plan);
  const dispatched = await test.dispatch(); assert.equal(dispatched.status, 200); assert.equal(dispatched.body.completed, true);
  assert.deepEqual(dispatched.body.result.generatedOverlayLayout, clone(test.plan.generatedOverlayLayout));
  assert.equal(composition.coverCompositionMatches(dispatched.body.result, test.plan, backgroundId), true);
  assert.deepEqual(test.state.histories[0].plan, frozen); assert.deepEqual(clone(test.plan), frozen);
  const counts = clone(test.state.counts); test.state.catalogUnavailable = true;
  const restored = await test.get(); assert.equal(restored.body.completed, true);
  assert.deepEqual(restored.body.result.generatedOverlayLayout, clone(test.plan.generatedOverlayLayout));
  assert.equal(composition.coverCompositionMatches(restored.body.result, test.plan, backgroundId), true);
  for (const field of ["provider", "render", "export", "catalog"]) assert.equal(test.state.counts[field], counts[field]);
  delete test.state.histories[0].plan.generatedOverlayLayout;
  const stripped = await test.get(); assert.equal(stripped.status, 503); assert.notEqual(stripped.body.completed, true);
  assert.equal(test.state.counts.provider, counts.provider); assert.equal(test.state.counts.render, counts.render);
}
checks.push("safe-frame real attempt/render/delivery and shared completed GET retain exact frozen policy; stripped history policy refuses recovery without provider/catalog/render replay");
assert.equal(externalCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: externalCalls, providerCalls: 0, liveDatabaseCalls: 0,
  evidence: "Actual attempt/prepared-generation/render/repository/legacy-delivery code with real Sharp fixed-output rendering; provider, export/persist boundary, auth and DB are controlled fixtures. This is not a paid-provider or live-database acceptance.", cases: checks }, null, 2));
