#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

// Real operations, repository, projection, compiler, execution and HTTP routes.
// Database/auth/catalog/attempt/render service boundaries are local fixtures.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000002";
const parentId = "00000000-0000-4000-8000-000000000003";
const sourceId = "00000000-0000-4000-8000-000000000004";
const outputId = "00000000-0000-4000-8000-000000000005";
const historyId = "00000000-0000-4000-8000-000000000006";
const clone = value => JSON.parse(JSON.stringify(value));
let externalCalls = 0;
const forbidden = () => { externalCalls++; throw new Error("Forbidden external I/O"); };
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
const next = { NextRequest, NextResponse: { json: (value, init) => Response.json(value, init) } };
const request = (route, method = "GET", body) => new NextRequest(`https://fixture.invalid${route}`, {
  method, headers: { authorization: "Bearer fixture", "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function fixture(options = {}) {
  const state = { rows: [], attempts: [], images: [], messages: [], histories: [], files: [], mutations: [], filters: [], writes: [], readiness: true,
    unknownRead: false, unknownDispatch: false, originalAnalysisReads: 0, renderCalls: 0, attemptReads: 0, referenceReads: 0,
    amount: .3, catalogCalls: 0, userId: owner };
  const tables = { cover_prepare_operations: state.rows, cover_generation_attempts: state.attempts,
    cover_generation_history: state.histories, user_files: state.files, image_generation_requests: state.images, conversation_messages: state.messages };
  const db = { from(table) {
    assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
    const filters = [], orders = []; let inserted, range;
    const query = {
      select() { return query; }, order(key, options = {}) { orders.push([key, options.ascending !== false]); return query; }, limit() { return query; },
      range(first, last) { range = [first, last]; return query; },
      in(key, values) { filters.push([key, { inValues: values }]); return query; },
      then(resolve, reject) { return query.all().then(resolve, reject); },
      eq(key, value) { filters.push([key, value]); state.filters.push({ table, key, value }); return query; },
      insert(row) { inserted = clone(row); return query; },
      update() { throw new Error("Confirmation must append without changing parent or bill"); },
      async maybeSingle() { return query.single(); },
      async single() {
        if (inserted) {
          if (tables[table].some(row => row.id === inserted.id || row.user_id === inserted.user_id && row.client_request_id === inserted.client_request_id)) return { data: null, error: { code: "23505" } };
          state.mutations.push({ table, kind: "insert", id: inserted.id }); tables[table].push(inserted);
          return { data: clone(inserted), error: null };
        }
        const result = (await query.all()).data[0];
        return { data: result ? clone(result) : null, error: null };
      },
      async all() {
        let result = tables[table].filter(row => filters.every(([key, value]) => {
          const actual = key.includes("->>") ? row[key.split("->>")[0]]?.[key.split("->>")[1]] : row[key];
          if (value?.inValues) return value.inValues.includes(actual);
          return key === "plan" ? JSON.stringify(actual) === value : actual === value;
        }));
        for (const [key, ascending] of [...orders].reverse()) result.sort((a, b) => String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1));
        if (range) result = result.slice(range[0], range[1] + 1);
        return { data: clone(result), error: null };
      },
    };
    return query;
  } };
  const mocks = {
    "node:child_process": { execFileSync: forbidden },
    "node:os": { default: { homedir: () => "C:/fixture-home" } },
    "node:fs": { existsSync: forbidden, readFileSync: forbidden, statSync: forbidden },
    "server-only": {}, "next/server": next, "node:crypto": { createHash, randomUUID }, zod: { z }, sharp: { default: sharp },
    "@/storage/database/supabase-client": { getSupabaseClient: () => db, getSupabaseAdminClient: () => db },
    "node:fs/promises": { mkdir: forbidden, readFile: forbidden, rename: forbidden, writeFile: forbidden },
    "node:path": { default: path }, "@/lib/runtime-paths": { resolveAppRuntimeDir: forbidden },
    "@/storage/object": { storageManager: { getSignedUrl: async () => { state.referenceReads++; return "https://fixture.invalid/owned-reference"; } } },
    "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: state.userId } }) },
    "@/app/api/cover-models/route": { GET: forbidden },
    "@/lib/manga-agent-model-policy": { buildMangaAgentModelCatalog: forbidden },
    "@/app/api/cover/prepare/route": {
      GET: async () => { state.originalAnalysisReads++; return Response.json({ success: true }); }, POST: forbidden,
    },
    "@/app/api/cover/attempt/route": {
      GET: async req => { state.attemptReads++;
        const exact = options.exactAttemptKeys ? state.attempts.find(row => row.user_id === state.userId
          && row.client_idempotency_key === new URL(req.url).searchParams.get("clientIdempotencyKey")) : null;
        return Response.json(state.unknownRead ? { success: false, error: "PRIVATE_PROVIDER_ECHO" }
          : state.attemptPayload || { success: true, activeAttempt: clone(options.exactAttemptKeys ? exact?.projection || null : state.active || null), ...(state.imageState ? { imageState: state.imageState } : {}) }); },
      POST: async req => {
        const body = await req.json(); state.writes.push(clone(body));
        if (options.exactAttemptKeys) state.active = clone(state.attempts.find(row => row.user_id === state.userId && row.client_idempotency_key === body.clientIdempotencyKey)?.projection || null);
        const persist = () => {
          const previous = state.attempts.find(row => row.user_id === state.userId && row.client_idempotency_key === body.clientIdempotencyKey);
          const parsed = body.action === "claim" ? load("src/lib/cover-durable-attempt.ts").parseCoverAttemptClaim(body) : null;
          const record = { ...previous, id: state.active.id, user_id: state.userId, surface: "cover-studio",
            client_idempotency_key: body.clientIdempotencyKey, client_trace_id: body.clientTraceId, state: state.active.state,
            task: parsed?.task || previous?.task, generation_input: parsed?.generationInput || previous?.generation_input,
            requires_reference_reupload: false, created_at: "2026-11-06T00:00:00.000Z", updated_at: "2026-11-06T00:00:00.000Z", projection: clone(state.active) };
          if (previous) state.attempts.splice(state.attempts.indexOf(previous), 1, record); else state.attempts.push(record);
        };
        if (body.action === "claim") {
          state.active = { ...clone(body), state: "claimed", id: randomUUID() };
          persist();
          return Response.json({ success: true, activeAttempt: state.active });
        }
        assert.equal(body.action, "dispatch");
        state.active.state = "dispatched";
        persist();
        if (state.unknownDispatch) return Response.json({ success: false, code: "PRIVATE_DISPATCH_ECHO", error: "PRIVATE_PROVIDER_ECHO" }, { status: 503 });
        return Response.json({ success: true, activeAttempt: state.active });
      },
    },
    "@/app/api/cover/render/route": {
      GET: async () => Response.json({ ready: state.readiness }),
      POST: async req => { state.renderCalls++; state.renderBody = await req.json(); return Response.json({ success: false }, { status: 503 }); },
    },
  };
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const module = { exports: {} }; cache.set(relative, module.exports);
    const result = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), { fileName: relative,
      reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
    assert.deepEqual((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
    vm.runInNewContext(result.outputText, { module, exports: module.exports, Buffer, URL, URLSearchParams, Request, Response, Headers,
      TextEncoder, TextDecoder, console, fetch: forbidden, process: { env: {}, platform: "win32" },
      require(id) {
        if (Object.hasOwn(mocks, id)) return mocks[id];
        const target = id.startsWith("@/") ? `src/${id.slice(2)}.ts` : id.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(relative), `${id}.ts`)) : null;
        assert.ok(target && target.startsWith("src/"), `Unexpected import ${relative}: ${id}`);
        return load(target);
      },
    }, { filename: relative });
    cache.set(relative, module.exports); return module.exports;
  }
  const contract = load("src/lib/cover-workbench-contract.ts");
  const repository = load("src/lib/server/cover-prepare-repository.ts");
  const projection = load("src/lib/server/cover-review-projection.ts");
  const service = load("src/lib/server/cover-prepare-service.ts");
  const generationSpec = contract.CoverGenerationSpecSchema.parse({ modelId: "pm_fixture", resolution: "2K", aspectRatio: "3:4", outputRatio: "3:4", ratioEvidence: "declared_native" });
  // Keep pure production compiler, substitute only owned-asset and catalog I/O.
  service.coverOwnedAssets = async () => [];
  service.readCoverOriginalSourceDimensions = async () => ({ sourceWidth: 2048, sourceHeight: 2048 });
  service.coverImageSelection = async () => {
    state.catalogCalls++;
    return { amount: state.amount, resolution: "2K", model: { displayName: "Fixture image", capabilities: {} }, generation: { generationSpec } };
  };
  const operations = load("src/lib/server/cover-review-operations.ts");
  const execution = load("src/lib/server/cover-review-execution.ts");
  const executeRoute = load("src/app/api/cover-workbench/execute/route.ts");
  const confirmRoute = load("src/app/api/cover-workbench/confirm/route.ts");
  const operationsRoute = load("src/app/api/cover-workbench/operations/route.ts");
  const materials = contract.parseCoverPrepareInput({ clientRequestId: "analysis_original_fixture", text: "每天先做十分钟，再逐步扩大行动。", styleKey: "cartoon",
    outputRatio: "3:4", modelId: "pm_fixture", resolution: "2K",
    assets: options.original ? [{ assetId: sourceId, role: "background_canvas", imageNumber: 1 }] : [] });
  const conclusion = text => ({ text, evidenceRefs: ["e1"] });
  const analysis = contract.CoverContentAnalysisSchema.parse({ schemaVersion: "cover-content-analysis/1", status: "ready", topic: "从小行动开始",
    primaryTitle: "先做十分钟", secondaryTitle: null, visualBrief: { subject: "亚洲青年", action: "在桌前动手", scene: "工作室", emotion: "专注" },
    titleCandidates: [{ id: "t1", text: "先做十分钟", evidenceRefs: ["e1"] }],
    evidence: [{ id: "e1", source: "text", quote: "每天先做十分钟", fields: ["topic", "primaryTitle", "visualBrief.subject"] }], missingInformation: [],
    layoutIntent: { structure: "single", focus: "action", evidenceRefs: ["e1"] },
    contentBreakdown: { summary: conclusion("从小行动开始"), keyPoints: [conclusion("每天做一点")], logic: conclusion("先行动再扩大"), coverFocus: conclusion("开始行动的瞬间") } });
  const parent = { id: parentId, user_id: owner, client_request_id: materials.clientRequestId, material_fingerprint: repository.coverMaterialFingerprint(materials),
    revision: 1, state: "plan_ready", materials, preparation: { workflowVersion: 3, recordKind: "analysis", route: options.original ? "original_layout" : "new_visual",
      style: contract.resolveCoverStyle("cartoon"), outputSpec: contract.coverOutputSpec("3:4"), generationSpec,
      promptDependencies: { promptPack: null }, promptDependenciesFingerprint: "b".repeat(64),
      privatePromptSentinel: "PRIVATE_STYLE_PROMPT", ...(options.original ? { sourceAssetId: sourceId } : {}),
      quote: { analysis: { amount: 8, unit: "credits" }, image: { modelId: "pm_fixture", modelName: "Fixture image", amount: .3, unit: "yuan", resolution: "2K", ready: true } } },
    result: { analysis, visualObservations: [] }, analysis_request_id: "cover_analysis_original", analysis_attempt_id: "original_bill_record",
    billing: { credits_charged: 8, operation_id: "original_bill_record" }, consent: { analysis: true }, error_code: null,
    created_at: "2026-11-06T00:00:00.000Z", updated_at: "2026-11-06T00:00:00.000Z" };
  state.rows.push(parent);
  async function input(edits = {}, clientRequestId = "confirmation_fixture_1") {
    const quote = await operations.readCoverReviewImageQuote(parent, "https://fixture.invalid");
    return { operationId: parentId, clientRequestId, expectedAnalysisHash: projection.coverReviewAnalysisHash(parent),
      expectedImageQuoteHash: projection.coverReviewImageQuoteHash(quote.imageQuote, quote.generationSpec, parent.preparation.outputSpec), edits, consent: { image: true } };
  }
  async function confirm(edits = {}, key) {
    const body = await input(edits, key);
    const response = await confirmRoute.POST(request("/api/cover-workbench/confirm", "POST", body));
    return { response, body: await response.json(), input: body };
  }
  return { state, parent, operations, execution, executeRoute, operationsRoute, repository, projection, service, input, confirm, load };
}

export { fixture, request, owner, otherOwner, parentId, sourceId, outputId, historyId };
export const getExternalCalls = () => externalCalls;

const checks = [];
if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
{
  const f = fixture();
  const result = await f.confirm({ primaryTitle: "第一行\n第二行\n第三行" });
  assert.equal(result.response.status, 422); assert.equal(result.body.code, "COVER_TITLE_LINE_LIMIT");
  assert.match(result.body.error, /最多使用两行/u);
  assert.equal(f.state.rows.length, 1); assert.equal(f.state.mutations.length, 0);
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.renderCalls, 0);
  assert.equal(JSON.stringify(result.body).includes("PRIVATE_STYLE_PROMPT"), false);
  checks.push("new three-line confirmation returns precise Chinese 422 before child creation, provider dispatch or rendering");
}
{
  const f = fixture(), title = "旧标题第一行\n旧标题第二行\n旧标题第三行";
  f.parent.result.analysis.primaryTitle = title;
  f.parent.preparation.style.typography.maxLines = 3;
  const response = await f.operationsRoute.GET(request(`/api/cover-workbench/operations?operationId=${parentId}`));
  const visible = await response.json();
  assert.equal(response.status, 200); assert.equal(visible.analysis.primaryTitle, title);
  assert.equal(visible.editablePlan.primaryTitle, title);
  assert.equal(f.state.mutations.length, 0); assert.equal(f.state.writes.length, 0); assert.equal(f.state.renderCalls, 0);
  const blocked = await f.confirm();
  assert.equal(blocked.response.status, 422); assert.equal(blocked.body.code, "COVER_TITLE_LINE_LIMIT");
  assert.equal(f.state.rows.length, 1); assert.equal(f.state.mutations.length, 0); assert.equal(f.state.renderCalls, 0);
  checks.push("GET preserves old frozen three-line analysis for viewing/restoration; a new confirmation asks for two lines without rerender or a new analysis");
}
{
  const f = fixture(); const before = JSON.stringify(f.parent);
  const edits = { primaryTitle: "现在就开始", secondaryTitle: "每天一点", visualBrief: { action: "拿起工具" },
    contentBreakdown: { summary: "先开始，再迭代", keyPoints: ["开始行动", "逐步扩大"] }, layoutIntent: { structure: "comparison", focus: "object" } };
  const result = await f.confirm(edits);
  assert.equal(result.response.status, 200); const id = result.body.confirmationId;
  assert.ok(id && id !== parentId); assert.equal(JSON.stringify(f.parent), before);
  assert.equal(f.state.rows.length, 2); assert.equal(f.state.mutations.length, 1);
  const saved = f.state.rows.find(row => row.id === id);
  assert.equal(saved.preparation.confirmedPlan.primaryTitle, edits.primaryTitle);
  assert.equal(saved.preparation.confirmedPlan.visualBrief.action, edits.visualBrief.action);
  assert.equal(saved.preparation.confirmedPlan.contentBreakdown.summary, edits.contentBreakdown.summary);
  assert.equal(saved.preparation.fieldOrigins.primaryTitle.source, "user_override");
  assert.equal(saved.preparation.fieldOrigins.topic.source, "analysis");
  assert.equal(saved.result.task.prepareOperationId, id); assert.equal(saved.result.task.prompt, saved.result.generationInput.prompt);
  assert.ok(saved.result.generationInput.prompt.length > 100);
  assert.equal(saved.result.renderPlan.title, edits.primaryTitle); assert.equal(saved.result.renderPlan.subtitle, edits.secondaryTitle);
  assert.equal(saved.result.generationIdentity.clientIdempotencyKey, `coverwb_${id}`);
  assert.equal(saved.result.generationIdentity.clientTraceId, `coverwb_${id}`);
  assert.equal(saved.consent.imageQuoteHash, result.input.expectedImageQuoteHash);
  assert.equal(saved.preparation.quote.imageQuoteHash, result.input.expectedImageQuoteHash);
  assert.equal(saved.preparation.originalAnalysisHash, result.input.expectedAnalysisHash);
  assert.equal(saved.billing.credits_charged, 0); assert.equal(saved.preparation.originalAnalysisBilling.creditsCharged, 8);
  assert.equal(saved.preparation.originalAnalysisBilling.chargedAgain, false);
  assert.equal(result.body.task.prompt, ""); assert.equal(result.body.generationInput, undefined);
  assert.equal(JSON.stringify(result.body).includes("PRIVATE_STYLE_PROMPT"), false);
  assert.equal(JSON.stringify(result.body).includes(saved.result.generationInput.prompt), false);
  const reread = await f.operations.getCoverReviewOperation(request("/api/cover-workbench/operations"), owner, id);
  assert.equal(reread.confirmedPlan.primaryTitle, edits.primaryTitle);
  const replay = await f.confirm(edits); assert.equal(replay.body.confirmationId, id); assert.equal(f.state.rows.length, 2);
  const conflict = await f.confirm({ primaryTitle: "同标识不同方案" });
  assert.equal(conflict.response.status, 409); assert.equal(conflict.body.code, "COVER_CONFIRMATION_KEY_CONFLICT");
  assert.equal(JSON.stringify(f.parent), before); assert.equal(f.state.writes.length, 0);
  checks.push("real confirmation route appends edited immutable child, preserves original analysis/bill, binds distinct image keys, rereads/replays exactly once and returns no private prompt");
}
{
  const f = fixture(); const before = JSON.stringify(f.parent);
  const raced = await Promise.all([f.confirm({ primaryTitle: "并发确认" }), f.confirm({ primaryTitle: "并发确认" })]);
  assert.equal(raced[0].response.status, 200); assert.equal(raced[1].response.status, 200);
  assert.equal(raced[0].body.confirmationId, raced[1].body.confirmationId); assert.equal(f.state.rows.length, 2);
  const separate = await f.confirm({ primaryTitle: "第二份明确方案" }, "confirmation_fixture_2");
  assert.equal(separate.response.status, 200); assert.notEqual(separate.body.confirmationId, raced[0].body.confirmationId);
  assert.equal(JSON.stringify(f.parent), before); assert.equal(f.state.rows.length, 3);
  assert.equal(f.state.rows.filter(row => row.id !== parentId).every(row => row.billing.credits_charged === 0), true);
  assert.equal(f.state.writes.length, 0);
  checks.push("concurrent identical confirmation keys converge on one append; a separate explicit confirmation gets its own image key without rebilling or changing the original analysis");
}
{
  const f = fixture(); const body = await f.input({ primaryTitle: "费用改变前的审核" }); f.state.amount = .8;
  await assert.rejects(f.operations.confirmCoverReviewOperation(request("/api/cover-workbench/confirm"), owner, body), error => error.code === "COVER_IMAGE_QUOTE_CHANGED" && error.publicData.quote.image.amount === .8);
  assert.equal(f.state.rows.length, 1); assert.equal(f.state.writes.length, 0);
  const changedAnalysis = await f.input(); f.parent.revision++;
  await assert.rejects(f.operations.confirmCoverReviewOperation(request("/api/cover-workbench/confirm"), owner, changedAnalysis), error => error.code === "COVER_ANALYSIS_REVIEW_STALE");
  f.state.userId = otherOwner;
  const denied = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: parentId }));
  assert.equal(denied.status, 404); assert.equal(f.state.writes.length, 0);
  checks.push("quote and original-analysis hashes fence confirmation; changed price/analysis and cross-account access cannot append or dispatch");
}
{
  const f = fixture(); const confirmed = await f.confirm(); const id = confirmed.body.confirmationId;
  for (const body of [{ confirmationId: id, prompt: "injected" }, { confirmationId: id, payload: {} }, { operationId: id }]) {
    const response = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", body)); assert.equal(response.status, 422);
  }
  assert.equal(f.state.attemptReads, 0); assert.equal(f.state.writes.length, 0);
  const response = await f.executeRoute.GET(request(`/api/cover-workbench/execute?confirmationId=${id}`));
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "confirmed"); assert.equal(f.state.writes.length, 0);
  const unconfirmed = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: parentId }));
  assert.equal(unconfirmed.status, 409); assert.equal(f.state.writes.length, 0);
  checks.push("execute accepts only confirmationId; injected prompts/payloads and analysis IDs are rejected, GET never claims or dispatches");
}
{
  const f = fixture(); const { body: confirmed } = await f.confirm(); const id = confirmed.confirmationId;
  f.state.readiness = false;
  const result = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: id }));
  const body = await result.json(); assert.equal(body.status, "claimed"); assert.equal(body.issue.code, "COVER_RENDER_NOT_READY");
  assert.deepEqual(f.state.writes.map(item => item.action), ["claim"]);
  assert.equal(f.state.referenceReads, 0);
  f.state.readiness = true; f.state.unknownDispatch = true;
  const dispatched = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: id }));
  const unknown = await dispatched.json(); assert.equal(unknown.status, "unknown"); assert.equal(unknown.issue.action, "query_original");
  assert.equal(JSON.stringify(unknown).includes("PRIVATE_PROVIDER_ECHO"), false);
  const before = f.state.writes.length;
  f.state.imageState = "failed_unknown";
  for (const method of ["GET", "POST", "POST"]) {
    const query = method === "GET" ? `/api/cover-workbench/execute?confirmationId=${id}` : "/api/cover-workbench/execute";
    const polled = await f.executeRoute[method](request(query, method, method === "POST" ? { confirmationId: id } : undefined));
    assert.equal(polled.status, 200);
    const recovered = await polled.json();
    assert.equal(recovered.status, "unknown"); assert.equal(recovered.task.status, "unknown"); assert.equal(recovered.canPoll, true);
    assert.equal(recovered.activeAttempt.state, "dispatched", "Keep factual local dispatch while image result remains unknown");
    assert.equal(recovered.issue.action, "query_original");
  }
  assert.equal(f.state.writes.length, before); assert.deepEqual(f.state.writes.map(item => item.action), ["claim", "dispatch"]);
  assert.equal(f.state.writes[1].clientIdempotencyKey, `coverwb_${id}`);
  assert.equal(f.state.writes[1].clientTraceId, `coverwb_${id}`);
  checks.push("claimed order waits for render readiness; a lost dispatch response and repeated GET/POST reconcile the same order without redispatch or provider-text exposure");
}
{
  const f = fixture(); const { body: confirmed } = await f.confirm(); const id = confirmed.confirmationId;
  const child = f.state.rows.find(row => row.id === id);
  const get = async () => (await f.executeRoute.GET(request(`/api/cover-workbench/execute?confirmationId=${id}`))).json();
  assert.equal((await get()).status, "confirmed", "No attempt still needs an explicit first submission");
  f.state.active = { id: "fixture-active", state: "claimed", task: clone(child.result.task), clientIdempotencyKey: `coverwb_${id}`, clientTraceId: `coverwb_${id}` };
  assert.equal((await get()).status, "claimed");
  f.state.active.state = "dispatched"; f.state.imageState = "intent";
  assert.equal((await get()).status, "submitted", "An original in-progress intent retains submitted state");
  f.state.imageState = "unknown";
  const unknown = await get(); assert.equal(unknown.status, "unknown"); assert.equal(unknown.task.status, "unknown");
  f.state.active.state = "delivery_pending"; f.state.imageState = "failed_unknown";
  assert.equal((await get()).status, "unknown", "Unconfirmed image result cannot be advertised as delivery progress");
  f.state.attemptPayload = { success: true, activeAttempt: null, completed: true, result: {
    cloudStored: true, persisted: true, assetId: outputId, historyRecordId: historyId, width: 1080, height: 1440 } };
  const completed = await get(); assert.equal(completed.status, "completed"); assert.equal(completed.task.status, "display_pending");
  assert.equal(completed.task.assetId, outputId);
  f.state.attemptPayload.result.url = `/api/storage/files/${outputId}/content`;
  assert.equal((await get()).task.status, "done");
  f.state.attemptPayload = { success: true, terminalAttempt: { state: "failed", task: clone(child.result.task) }, imageState: "failed_unknown" };
  assert.equal((await get()).status, "failed", "A confirmed terminal attempt is not relabelled as unknown");
  assert.equal(f.state.writes.length, 0, "All GET projections remain query-only");
  checks.push("original image failed_unknown/unknown survives V3 GET as unknown instead of running; confirmed/claimed/in-progress/completed/terminal recovery retain their real states");
}
{
  const f = fixture(); const { body: confirmed } = await f.confirm(); f.state.unknownRead = true;
  const response = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: confirmed.confirmationId }));
  const result = await response.json(); assert.equal(result.status, "unknown"); assert.equal(result.issue.action, "query_original");
  assert.equal(f.state.writes.length, 0); assert.equal(JSON.stringify(result).includes("PRIVATE_PROVIDER_ECHO"), false);
  f.parent.state = "unknown";
  await f.operations.getCoverReviewOperation(request("/api/cover-workbench/operations"), owner, parentId);
  assert.equal(f.state.originalAnalysisReads, 1); assert.equal(f.state.writes.length, 0);
  checks.push("unknown original read blocks all writes; analysis recovery reads only its existing billed operation");
}
{
  const f = fixture({ original: true }); const { body: confirmed } = await f.confirm({ primaryTitle: "原图审核标题" });
  const child = f.state.rows.find(row => row.id === confirmed.confirmationId);
  const plan = child.result.renderPlan;
  assert.equal(Object.hasOwn(plan, "_authoring"), false);
  assert.equal(plan.outputSpec.fit, "contain");
  assert.equal(plan.originalLayout.version, "cover-original-layout/1");
  assert.equal(plan.originalLayout.focus, "action");
  assert.equal(f.parent.preparation.originalLayout, undefined, "Paid parent is not rewritten to retrofit a layout policy");
  const edited = await f.confirm({ layoutIntent: { structure: "comparison", focus: "expression" } }, "original_confirmed_layout_edit");
  assert.equal(edited.response.status, 200);
  const editedPlan = f.state.rows.find(row => row.id === edited.body.confirmationId).result.renderPlan;
  assert.equal(editedPlan.originalLayout.structure, "comparison"); assert.equal(editedPlan.originalLayout.focus, "expression");
  assert.equal(f.parent.result.analysis.layoutIntent.structure, "single"); assert.equal(f.parent.billing.credits_charged, 8);
  f.state.histories.push({ user_id: owner, asset_id: outputId, history_record_id: historyId, background_asset_id: sourceId,
    plan: clone(plan), output_width: plan.outputSpec.width, output_height: plan.outputSpec.height, source_width: 2048,
    source_height: 2048, task_no: 1, created_at: "2026-11-06T01:00:00.000Z" });
  f.state.files.push({ id: outputId, user_id: owner, storage_key: "fixture/original-cover.png", storage_provider: "tencent_cos",
    file_category: "image", content_type: "image/png", file_size: 1024 });
  for (const method of ["GET", "POST"]) {
    const route = method === "GET" ? `/api/cover-workbench/execute?confirmationId=${child.id}` : "/api/cover-workbench/execute";
    const response = await f.executeRoute[method](request(route, method, method === "POST" ? { confirmationId: child.id } : undefined));
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.status, "completed");
    assert.equal(body.task.imageOrigin, "original"); assert.equal(body.result.assetId, outputId); assert.equal(body.task.prompt, "");
  }
  const filter = f.state.filters.find(item => item.table === "cover_generation_history" && item.key === "plan");
  assert.equal(filter.value, JSON.stringify(plan)); assert.equal(filter.value.includes("_authoring"), false);
  assert.equal(filter.value.includes(f.parent.materials.text), false);
  assert.equal(f.state.renderCalls, 0); assert.equal(f.state.attemptReads, 0); assert.equal(f.state.writes.length, 0);
  f.state.files[0].user_id = otherOwner;
  const broken = await f.executeRoute.GET(request(`/api/cover-workbench/execute?confirmationId=${child.id}`));
  assert.equal(broken.status, 503); assert.equal(f.state.renderCalls, 0);
  checks.push("original_layout real compiled plan has no _authoring; exact stored SQL-plan readback returns owned saved receipt for GET/POST without re-render, and rejects foreign files");
}
{
  const f = fixture({ original: true }); const { body: confirmed } = await f.confirm({ primaryTitle: "完整保留原图" });
  assert.equal(confirmed.quote.image.amount, 0);
  f.state.active = { id: "other-unresolved-attempt", state: "dispatched", clientIdempotencyKey: "coverwb_other_unknown", clientTraceId: "coverwb_other_unknown" };
  f.state.imageState = "failed_unknown";
  const response = await f.executeRoute.POST(request("/api/cover-workbench/execute", "POST", { confirmationId: confirmed.confirmationId }));
  assert.equal(response.status, 200);
  assert.equal(f.state.renderCalls, 1, "Independent original-layout task goes directly to its owned render route");
  assert.equal(f.state.attemptReads, 0); assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.active.state, "dispatched"); assert.equal(f.state.imageState, "failed_unknown");
  checks.push("independent original-layout confirmation remains zero image quote and reaches render with an unresolved image task preserved, without claim/dispatch/cancel or attempt reads");
}
{
  const f = fixture({ original: true });
  const changed = await f.confirm({ materialUsage: [{ assetId: sourceId, imageNumber: 1, role: "style_reference" }] });
  assert.equal(changed.response.status, 422); assert.equal(changed.body.code, "COVER_CONFIRMATION_MODE_CHANGE_REQUIRED");
  assert.equal(f.state.rows.length, 1); assert.equal(f.state.writes.length, 0);
  const swapped = await f.confirm({ materialUsage: [{ assetId: outputId, imageNumber: 1, role: "background_canvas" }] });
  assert.equal(swapped.response.status, 422); assert.equal(swapped.body.code, "COVER_CONFIRMATION_ASSET_BINDING_INVALID");
  assert.equal(f.state.rows.length, 1);
  checks.push("review cannot silently remove the retained original canvas or swap numbered owned-material bindings; explicit mode changes are required before generation");
}
assert.equal(externalCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: externalCalls, providerCalls: 0, liveDatabaseCalls: 0,
  evidence: "Actual V3 operations/repository/compiler/projection/execution/HTTP routes with bounded database/auth/catalog/attempt/render fixtures; not live database or paid-provider acceptance.", cases: checks }, null, 2));
}
