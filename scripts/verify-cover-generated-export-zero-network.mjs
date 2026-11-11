import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { NextRequest } from "next/server.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
// Execute the actual pure provider method, without initializing an SDK or reading configuration.
const providerSource = ts.createSourceFile("tencent-cos.ts", readFileSync("src/storage/object/providers/tencent-cos.ts", "utf8"), ts.ScriptTarget.Latest, true);
const categoryPrefixes = providerSource.statements.find(statement => ts.isVariableStatement(statement)
  && statement.declarationList.declarations.some(declaration => declaration.name.getText(providerSource) === "CATEGORY_PREFIX"));
const providerClass = providerSource.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === "TencentCOSProvider");
const buildKeyMethod = providerClass?.members.find(member => ts.isMethodDeclaration(member) && member.name.getText(providerSource) === "buildKey");
assert.ok(categoryPrefixes && buildKeyMethod, "Actual Tencent COS category prefixes and buildKey method must be present");
const pureProvider = ts.transpileModule(`${categoryPrefixes.getText(providerSource)}\nclass PureProvider { ${buildKeyMethod.getText(providerSource)} }\nmodule.exports = new PureProvider();`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function providerPhysicalKey(logicalName, now = "2026-11-06T08:00:00.000Z") {
  const pureModule = { exports: {} };
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  runInNewContext(pureProvider, { module: pureModule, Date: FixedDate, createHash });
  return pureModule.exports.buildKey(logicalName, "image");
}
const source = readFileSync("src/lib/server/cover-generated-export.ts", "utf8");
const transpiled = ts.transpileModule(source, { fileName: "cover-generated-export.ts", reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } });
assert.deepEqual((transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const bytes = await sharp({ create: { width: 96, height: 128, channels: 3, background: "#4c6f9a" } }).png().toBuffer();
const module = { exports: {} };
const compositionModule = { exports: {} };
runInNewContext(ts.transpileModule(readFileSync("src/lib/cover-composition.ts", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { module: compositionModule, exports: compositionModule.exports });
let bareFetches = 0;
const mockedImports = {
  "server-only": {}, "node:crypto": { createHash }, "next/server": { NextRequest }, sharp,
  "@/lib/current-api-user": { authorizeCurrentApiUser: () => { throw new Error("Unmocked auth"); } },
  "@/lib/image-exactly-once": { DatabaseImageExactlyOnceStore: class {} },
  "@/lib/server/generated-image-reference": { readGeneratedImageMaterial: () => { throw new Error("Unmocked source reader"); } },
  "@/storage/database/supabase-client": { getSupabaseClient: () => { throw new Error("Database forbidden"); } },
  "@/storage/object": { storageManager: {} },
  "@/app/api/image-workbench/persist/route": { POST: () => { throw new Error("Unmocked persist handler"); } },
  "@/lib/cover-composition": compositionModule.exports,
};
runInNewContext(transpiled.outputText, { module, exports: module.exports, Buffer, URL, Headers, Response,
  fetch: () => { bareFetches++; throw new Error("Network forbidden"); },
  require: (name) => { if (!Object.hasOwn(mockedImports, name)) throw new Error(`Unexpected import ${name}`); return mockedImports[name]; } });
const { exportGeneratedCoverBackground: exportBackground, CoverGeneratedExportError } = module.exports;
const cases = [];
const passed = (name) => cases.push(name);
const ASSET = "11111111-1111-4111-8111-111111111111";
const HISTORY = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const userId = "fixture-owner", clientIdempotencyKey = "coverwb_original_fixture", clientTraceId = clientIdempotencyKey;
  const recordId = hash(`${userId}\0${clientIdempotencyKey}`);
  const record = { recordId, userHash: hash(userId), clientIdempotencyKey, clientTraceId, state: "completed", deliveryState: "delivered",
    response: { deliveryMode: "provider_url", providerUrl: "https://provider.invalid/private-result?secret=never-print" } };
  const input = { request: new NextRequest("http://127.0.0.1:5000/api/cover/attempt", { headers: { "x-fixture-owner": userId } }), userId, recordId, clientIdempotencyKey, clientTraceId };
  const state = { asset: null, stored: null, readCalls: 0, persistCalls: 0, uploads: 0, binds: 0, mode: "ok", material: bytes, contentType: "image/png", requests: [], now: "2026-11-06T08:00:00.000Z" };
  const deps = {
    async authorize(request) { const owner = request.headers.get("x-fixture-owner"); return owner ? { ok: true, user: { id: owner, userId: owner } } : { ok: false, response: new Response(null, { status: 401 }) }; },
    async getRecord(keys) { assert.equal(keys.userId, userId); assert.equal(keys.clientIdempotencyKey, clientIdempotencyKey); return record; },
    async readMaterial(value) {
      state.readCalls++; assert.equal(value.userId, userId); assert.equal(value.reference.recordId, recordId);
      assert.equal(value.reference.schema, "generated_image_ref.v1"); assert.equal(value.reference.transform, undefined);
      assert.equal(value.maxBytes, 25 * 1024 * 1024);
      if (state.mode === "source-fail") throw new Error("https://provider.invalid/private?secret=hidden");
      return { buffer: state.material, contentType: state.contentType };
    },
    async findAsset(owner, trace) {
      assert.equal(owner, userId); assert.ok(trace.startsWith("coverwb_bg_"));
      if (state.mode === "lookup-fail") throw new Error("https://database.invalid/private?secret=hidden");
      return state.asset;
    },
    async readStored(key) {
      assert.equal(key, state.asset.storage_key);
      if (state.mode === "storage-fail") throw new Error("https://storage.invalid/private?secret=hidden");
      return state.stored;
    },
    async bindAsset(asset, binding) {
      state.binds++; assert.equal(asset.id, ASSET);
      if (state.mode !== "binding-no-write") state.asset = { ...state.asset, meta: { ...state.asset.meta, coverGeneratedExport: { ...binding } } };
    },
    async persist(request) {
      state.persistCalls++;
      const body = await request.json(); state.requests.push(body);
      assert.equal(body.intent, "user_asset_export"); assert.equal(body.index, 1); assert.equal(body.transform, undefined);
      assert.equal(request.headers.get("content-length"), String(Buffer.byteLength(JSON.stringify(body))));
      if (!body.storageKey) {
        assert.ok(body.url.startsWith("data:image/png;base64,"));
        const data = Buffer.from(body.url.split(",")[1], "base64"); assert.deepEqual(data, state.material);
        const key = providerPhysicalKey(`image-workbench/by-trace/${hash(`${userId}\0${body.clientTraceId}`).slice(0, 48)}-1.png`, state.now);
        state.uploads++; state.stored = data;
        state.asset = { id: ASSET, user_id: userId, storage_key: key, storage_provider: "tencent_cos", file_category: "image", source: "image-workbench",
          content_type: "image/png", file_size: data.length, meta: { clientTraceId: body.clientTraceId, index: "1" } };
      } else { assert.equal(body.assetId, ASSET); assert.equal(body.storageKey, state.asset.storage_key); assert.equal(body.url, undefined); }
      if (state.mode === "history-pending") return Response.json({ persisted: false, assetId: ASSET, code: "IMAGE_HISTORY_INDEX_PENDING" }, { status: 503 });
      const receipt = { success: true, persisted: true, historyRecorded: true, assetId: ASSET, historyRecordId: HISTORY, key: state.asset.storage_key,
        url: "https://cos.invalid/owned?signature=never-print" };
      if (state.mode === "missing-history") delete receipt.historyRecordId;
      if (state.mode === "wrong-asset") receipt.assetId = "33333333-3333-4333-8333-333333333333";
      if (state.mode === "false-cloud") receipt.cloudStored = false;
      if (state.mode === "corrupt-after-persist") state.stored = Buffer.from("corrupted stored bytes");
      return Response.json(receipt);
    },
  };
  return { input, record, state, deps };
}
async function rejects(f, code, input = f.input) {
  const counts = { reads: f.state.readCalls, writes: f.state.persistCalls };
  await assert.rejects(exportBackground(input, f.deps), (error) => {
    assert.ok(error instanceof CoverGeneratedExportError); assert.equal(error.code, `COVER_GENERATED_EXPORT_${code}`);
    assert.equal(/https?:|secret=|signature=/u.test(error.message), false); return true;
  });
  return counts;
}

{
  const f = fixture(), result = await exportBackground(f.input, f.deps);
  assert.equal(result.persisted, true); assert.equal(result.cloudStored, true); assert.equal(result.assetId, ASSET); assert.equal(result.historyRecordId, HISTORY);
  assert.equal(result.provider, "tencent_cos"); assert.equal(result.recordId, f.input.recordId); assert.equal(result.sha256, hash(bytes));
  assert.equal(result.width, 96); assert.equal(result.height, 128); assert.equal(result.byteLength, bytes.length);
  assert.equal(f.state.readCalls, 1); assert.equal(f.state.uploads, 1); assert.equal(f.state.binds, 1);
  assert.match(result.key, /^images\/2026\/11\/06\/image-workbench\/by-trace\/[a-f0-9]{48}-1\.png$/u);
  assert.equal(/https?:|secret=|signature=/u.test(JSON.stringify(result)), false);
  passed("owned provider result exports original bytes using the actual COS buildKey category/date prefix with complete verified receipt and no URL disclosure");
  f.state.mode = "source-fail";
  f.state.now = "2026-11-07T08:00:00.000Z";
  assert.notEqual(providerPhysicalKey(result.key.split("/").slice(-3).join("/"), f.state.now), result.key);
  const again = await exportBackground(f.input, f.deps);
  assert.equal(again.assetId, result.assetId); assert.equal(again.key, result.key); assert.equal(again.exportTraceId, result.exportTraceId); assert.equal(again.reused, true);
  assert.equal(f.state.readCalls, 1); assert.equal(f.state.uploads, 1); assert.equal(f.state.requests[1].url, undefined);
  passed("cross-day COS recovery reuses yesterday's exact physical key/history without a provider read or second upload when provider source is unavailable");
}
{
  const f = fixture(); await exportBackground(f.input, f.deps);
  f.state.asset.storage_key = f.state.asset.storage_key.split("/").slice(-3).join("/");
  const reused = await exportBackground(f.input, f.deps);
  assert.equal(reused.key, f.state.asset.storage_key); assert.equal(f.state.uploads, 1);
  passed("legacy logical storage keys remain supported with the same original-byte and owner binding");
}
for (const [name, change] of [
  ["traversal", key => key.replace("images/", "images/../")],
  ["dot segment", key => key.replace("images/", "images/./")],
  ["backslash", key => key.replace("images/", "images\\")],
  ["query", key => `${key}?signature=untrusted`],
  ["fragment", key => `${key}#untrusted`],
  ["encoded traversal", key => key.replace("images/", "images/%2e%2e/")],
  ["wrong prefix", key => key.replace("images/", "other/")],
  ["extra directory", key => `extra/${key}`],
  ["suffix without directory boundary", key => key.replace("/image-workbench/", "/fake-image-workbench/")],
  ["wrong owner-trace digest", key => key.replace(/[a-f0-9]{48}-1[.]png$/u, `${"f".repeat(48)}-1.png`)],
  ["wrong sequence", key => key.replace("-1.png", "-2.png")],
  ["extension tail", key => `${key}.bak`],
  ["invalid date directory", key => key.replace("/11/06/", "/13/32/")],
]) {
  const f = fixture(); await exportBackground(f.input, f.deps);
  f.state.asset.storage_key = change(f.state.asset.storage_key);
  const reads = f.state.readCalls, persists = f.state.persistCalls, binds = f.state.binds;
  await rejects(f, "ASSET_BINDING_MISMATCH");
  assert.equal(f.state.readCalls, reads); assert.equal(f.state.persistCalls, persists); assert.equal(f.state.binds, binds);
  passed(`physical storage path rejects ${name} before source access, persistence or binding`);
}
{
  const f = fixture(); const [one, two] = await Promise.all([exportBackground(f.input, f.deps), exportBackground(f.input, f.deps)]);
  assert.equal(one.assetId, two.assetId); assert.equal(f.state.readCalls, 1); assert.equal(f.state.persistCalls, 1);
  passed("simultaneous same-binding exports join one in-process operation");
}
{
  const f = fixture(); await rejects(f, "OWNER_MISMATCH", { ...f.input, request: new NextRequest(f.input.request.url, { headers: { "x-fixture-owner": "other-owner" } }) });
  assert.equal(f.state.readCalls, 0); assert.equal(f.state.persistCalls, 0); passed("cross-account input is rejected before material access or persistence");
}
{
  const f = fixture(); await rejects(f, "AUTH_REQUIRED", { ...f.input, request: new NextRequest(f.input.request.url) });
  assert.equal(f.state.readCalls, 0); passed("unauthenticated input cannot join an export or read source bytes");
}
{
  const f = fixture(); await rejects(f, "BINDING_INVALID", { ...f.input, recordId: "a".repeat(64) });
  assert.equal(f.state.readCalls, 0); passed("record ID cannot be substituted independently of owner and original request key");
}
{
  const f = fixture(); f.record.clientTraceId = "different_trace_key"; await rejects(f, "RECORD_BINDING_MISMATCH");
  assert.equal(f.state.persistCalls, 0); passed("original trace mismatch is rejected without export");
}
for (const [state, delivery] of [["intent", "delivered"], ["completed", "held"], ["failed_unknown", "held"]]) {
  const f = fixture(); f.record.state = state; f.record.deliveryState = delivery; await rejects(f, "RESULT_NOT_READY");
  assert.equal(f.state.readCalls, 0); assert.equal(f.state.persistCalls, 0); passed(`unconfirmed generation ${state}/${delivery} cannot be exported or re-submitted`);
}
{
  const f = fixture(); f.record.response.deliveryMode = "inline_ephemeral"; await rejects(f, "INLINE_UNAVAILABLE");
  assert.equal(f.state.readCalls, 0); assert.equal(f.state.persistCalls, 0); passed("lost inline-ephemeral bytes remain unavailable and cannot be reconstructed");
}
{
  const f = fixture(); f.state.mode = "source-fail"; await rejects(f, "SOURCE_UNAVAILABLE");
  assert.equal(f.state.persistCalls, 0); passed("provider read failure is safe and does not expose its private URL or persist substitute bytes");
}
for (const [name, material, type] of [["oversize", Buffer.alloc(25 * 1024 * 1024 + 1), "image/png"], ["unsupported type", bytes, "image/gif"], ["MIME mismatch", bytes, "image/jpeg"], ["corrupt image", Buffer.from("not an image"), "image/png"]]) {
  const f = fixture(); f.state.material = material; f.state.contentType = type; await rejects(f, "IMAGE_INVALID");
  assert.equal(f.state.persistCalls, 0); passed(`${name} is rejected before persistence`);
}
{
  const f = fixture(); f.state.mode = "history-pending"; await rejects(f, "PERSIST_PENDING");
  assert.ok(f.state.asset.meta.coverGeneratedExport); assert.equal(f.state.uploads, 1);
  f.state.mode = "source-fail"; const result = await exportBackground(f.input, f.deps);
  assert.equal(result.persisted, true); assert.equal(result.historyRecordId, HISTORY); assert.equal(f.state.readCalls, 1); assert.equal(f.state.uploads, 1);
  passed("history projection failure preserves a verified source binding so retry only repairs history without upstream read or generation");
}
for (const mode of ["missing-history", "wrong-asset", "false-cloud"]) {
  const f = fixture(); f.state.mode = mode; await rejects(f, "PERSIST_PENDING"); passed(`incomplete or contradictory persist receipt ${mode} cannot become success`);
}
{
  const f = fixture(); f.state.mode = "corrupt-after-persist"; await rejects(f, "ASSET_BINDING_MISMATCH"); passed("COS bytes must match the exact original digest before cloudStored can be true");
}
{
  const f = fixture(); f.state.mode = "binding-no-write"; await rejects(f, "PERSIST_PENDING"); passed("source metadata CAS must be read back before successful export");
}
{
  const f = fixture(); await exportBackground(f.input, f.deps); f.state.asset.meta.coverGeneratedExport.recordId = "a".repeat(64);
  await rejects(f, "ASSET_BINDING_MISMATCH"); assert.equal(f.state.readCalls, 1); assert.equal(f.state.persistCalls, 1);
  passed("tampered existing source binding cannot reuse or overwrite the asset");
}
{
  const f = fixture(); await exportBackground(f.input, f.deps); delete f.state.asset.meta.coverGeneratedExport; f.state.stored = Buffer.from("substituted");
  const count = f.state.persistCalls; await rejects(f, "ASSET_BINDING_MISMATCH"); assert.equal(f.state.persistCalls, count);
  passed("a client-chosen duplicate trace without an attested original digest is not blindly reused");
}
{
  const f = fixture(); await exportBackground(f.input, f.deps); delete f.state.asset.meta.coverGeneratedExport;
  const uploads = f.state.uploads; await exportBackground(f.input, f.deps); assert.equal(f.state.uploads, uploads); assert.ok(f.state.asset.meta.coverGeneratedExport);
  passed("an unbound partial export is safely adopted only after comparing original provider and owned stored bytes");
}
{
  const f = fixture(); f.state.mode = "lookup-fail"; await rejects(f, "PERSIST_PENDING"); assert.equal(f.state.readCalls, 0);
  passed("unexpected lookup errors are sanitized and cannot trigger a provider read");
}
assert.equal(bareFetches, 0);
{
  const f = fixture();
  f.input.plan = { title: "猫咪在等你", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-cover-workbench", animationStyleId: "pixar-3d",
    planVersion: 2, outputSpec: { aspectRatio: "3:4", width: 1080, height: 1440, format: "png", fit: "contain" },
    textRendering: { mode: "native", version: "cover-text-rendering/1" } };
  await exportBackground(f.input, f.deps);
  assert.equal(JSON.stringify(f.state.asset.meta.coverGeneratedExport.nativePlan), JSON.stringify(f.input.plan));
  await exportBackground(f.input, f.deps);
  assert.equal(f.state.readCalls, 1); assert.equal(f.state.uploads, 1);
  await rejects(f, "ASSET_BINDING_MISMATCH", { ...f.input, plan: { ...f.input.plan, title: "改过的文字" } });
  await rejects(f, "ASSET_BINDING_MISMATCH", { ...f.input, plan: undefined });
  assert.equal(f.state.readCalls, 1); assert.equal(f.state.uploads, 1);
  passed("native export freezes the full plan in owner-bound source metadata; replay keeps one original image and rejects changed/deleted native plan");
}
assert.equal(/\/api\/(?:image\/generate|llm)|runCoverGeneration|settle_cover_generation_attempt|delivery_asset_id/u.test(source), false);
passed("helper has no model/LLM dispatch, cover history settlement or image delivery-state mutation");
console.log(JSON.stringify({ passed: true, checks: cases.length, cases, networkCalls: bareFetches,
  scope: "actual helper with real image decoding; authentication, exact record store, COS, user_files CAS and persist handler are injected zero-network dependencies; no real DB/provider/billing proof" }, null, 2));
