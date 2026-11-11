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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const checks = [];
let externalCalls = 0;
const forbidden = () => { externalCalls += 1; throw new Error("External I/O forbidden"); };
function load(relative, imports = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path.join(root, relative), "utf8"), {
    fileName: relative, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, File, console,
    fetch: forbidden, require(id) { assert.ok(Object.hasOwn(imports, id), `Unexpected import ${id}`); return imports[id]; } }, { filename: relative });
  return module.exports;
}
const pure = load("src/lib/cover-composition.ts");
const annotations = load("src/lib/storyboard-annotation-layout.ts");
const renderer = load("src/lib/cover-composition-server.ts", {
  "node:fs": { existsSync }, sharp: { default: sharp }, "./cover-composition": pure,
  "./storyboard-annotation-layout": annotations,
});
assert.ok(renderer.coverCompositionFont(), "A local Chinese font is required");
const source = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#349862" } }).png().toBuffer();
const sourceHash = hash(source);
const legacy = { title: "先做十分钟", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-fixture", animationStyleId: "pet-3d", coverModeId: "cartoon" };
const v2 = ratio => ({ ...legacy, aspectRatio: ratio, planVersion: 2,
  outputSpec: { aspectRatio: ratio, ...pure.COVER_OUTPUT_SPECS[ratio], format: "png" },
  titleStyle: { x: 0.08, y: 0.08, width: 0.84, scale: 1, color: "#583A27" } });
for (const ratio of Object.keys(pure.COVER_OUTPUT_SPECS)) {
  const plan = v2(ratio);
  assert.equal(pure.coverCompositionValidationError(plan), null);
  const output = await renderer.renderCoverComposition(source, plan);
  const actual = await sharp(output.bytes).metadata();
  assert.equal(actual.width, plan.outputSpec.width); assert.equal(actual.height, plan.outputSpec.height);
  assert.equal(actual.format, "png"); assert.equal(hash(source), sourceHash);
  checks.push(`V2 ${ratio} real PNG has exact fixed pixels without mutating source`);
}
const base = await renderer.renderCoverComposition(source, v2("3:4"));
const repeated = await renderer.renderCoverComposition(source, v2("3:4"));
assert.equal(hash(base.bytes), hash(repeated.bytes));
const styled = await renderer.renderCoverComposition(source, { ...v2("3:4"), titleStyle: { x: 0.1, y: 0.2, width: 0.8, scale: 0.8, color: "#006699" } });
assert.notEqual(hash(base.bytes), hash(styled.bytes));
const scaledOnly = await renderer.renderCoverComposition(source, { ...v2("3:4"), titleStyle: { ...v2("3:4").titleStyle, scale: 0.7 } });
assert.notEqual(hash(base.bytes), hash(scaledOnly.bytes), "Scale alone must alter glyph pixels, not be cancelled by text autofit");
checks.push("same V2 plan is deterministic and position/scale/color edits change actual pixels");
const containedPlan = { ...v2("3:4"), outputSpec: { ...v2("3:4").outputSpec, fit: "contain" } };
const contained = await renderer.renderCoverComposition(source, containedPlan);
const raw = await sharp(contained.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const corner = (raw.info.height - 1) * raw.info.width * raw.info.channels;
assert.deepEqual([...raw.data.subarray(corner, corner + 3)], [255, 255, 255]);
assert.equal(hash(source), sourceHash);
checks.push("contain retains the original frame with deterministic white padding, without AI editing");
const small = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#eeeeee" } }).png().toBuffer();
await assert.rejects(() => renderer.renderCoverComposition(small, v2("3:4")), /COVER_BACKGROUND_INSUFFICIENT_PIXELS/);
await assert.rejects(() => renderer.renderCoverComposition(source, v2("3:4"), { preserveSourceDimensions: true }), /COVER_V2_PLAN_INVALID/);
checks.push("V2 rejects insufficient source pixels and conflicting source-dimension preservation");
for (const plan of [
  { ...legacy, outputSpec: v2("3:4").outputSpec },
  { ...v2("3:4"), outputSpec: { ...v2("3:4").outputSpec, width: 1000 } },
  { ...v2("3:4"), titleStyle: { x: 0.7, width: 0.84 } },
  { ...v2("3:4"), titleStyle: { y: 0.8 } },
  { ...v2("3:4"), titleStyle: { color: "url(evil)" } },
  { ...v2("3:4"), titleStyle: { scale: 2 } },
  { ...v2("3:4"), titleStyle: { unknown: 1 } },
]) assert.ok(pure.coverCompositionValidationError(plan));
checks.push("V2 validates version, fixed spec, title bounds, finite size, color and unknown style fields");
const old = await renderer.renderCoverComposition(source, legacy);
assert.equal(old.width, 1536); assert.equal(old.height, 2048);
const exact = await renderer.renderCoverComposition(source, legacy, { preserveSourceDimensions: true });
assert.equal(exact.width, 2048); assert.equal(exact.height, 2048);
const panels = Array.from({ length: 4 }, (_, i) => ({ caption: "Fixture panel", shot: i + 1, camera: "Static medium shot", action: "Subject stands still" }));
const annotated = await renderer.renderCoverComposition(source, { ...legacy, layoutTemplateId: "gaoding-storyboard-annotations", annotationPanels: panels }, { preserveSourceDimensions: true });
assert.equal(annotated.width, 2048); assert.equal(annotated.height, 2048);
assert.equal(annotated.renderedText.lines.length, 12);
checks.push("legacy crop/downsize, exact-text source preservation and four-panel annotations remain separate");

const userId = "00000000-0000-4000-8000-000000000001";
const assetId = "00000000-0000-4000-8000-000000000002";
let authorized = true, ownershipAvailable = true, uploadCalls = 0;
const db = { from(table) {
  assert.equal(table, "user_files", "materials must not write generation/history tables");
  const filters = [];
  const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; },
    maybeSingle: async () => {
      assert.ok(filters.some(([key, value]) => key === "user_id" && value === userId));
      assert.ok(filters.some(([key, value]) => key === "storage_provider" && value === "tencent_cos"));
      return { data: ownershipAvailable ? { id: assetId } : null, error: null };
    } };
  return query;
} };
const auth = { authorizeCurrentApiUser: async () => authorized ? { ok: true, user: { userId } } : { ok: false, response: Response.json({ error: "fixture unauthorized" }, { status: 401 }) } };
const next = { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } };
const persistedBodies = [], historyInputs = [];
const renderDb = { from(table) {
  assert.equal(table, "user_files");
  const filters = [];
  const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; },
    order: () => query, limit: () => query,
    maybeSingle: async () => {
      assert.ok(filters.some(([key, value]) => key === "user_id" && value === userId));
      return { error: null, data: filters.some(([key, value]) => key === "id" && value === assetId)
        ? { id: assetId, storage_key: "fixture/source.png", storage_provider: "tencent_cos", content_type: "image/png", file_size: source.length } : null };
    } };
  return query;
}, rpc: async (name, input) => {
  assert.equal(name, "record_cover_composition"); historyInputs.push(input);
  return { data: { asset_id: "fixture-result", task_no: 1, created_at: "2026-11-06T00:00:00.000Z" }, error: null };
} };
const render = load("src/app/api/cover/render/route.ts", {
  "node:crypto": { createHash }, "next/server": next, zod: { z },
  "@/lib/current-api-user": auth, "@/lib/auth": { getTokenFromHeaders: () => "fixture-only" },
  "@/lib/cover-composition": pure, "@/lib/cover-composition-server": renderer,
  "@/storage/database/supabase-client": { getSupabaseClient: () => renderDb },
  "@/storage/object": { storageManager: { read: async () => source } },
  "@/app/api/image-workbench/persist/route": { POST: async request => {
    const body = await request.json(); persistedBodies.push(body);
    assert.equal(body.intent, "user_asset_export");
    const saved = await sharp(Buffer.from(body.url.split(",")[1], "base64")).metadata();
    assert.equal(saved.width, 1080); assert.equal(saved.height, 1440);
    return Response.json({ success: true, persisted: true, status: "completed", assetId: "fixture-result", key: "fixture/result.png", url: "/fixture/result.png", historyRecordId: "fixture-history" });
  } },
});
const renderRequest = plan => {
  const body = JSON.stringify({ sourceAssetId: assetId, plan });
  return new Request("https://fixture.invalid/api/cover/render", { method: "POST", body,
    headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } });
};
const renderedResponse = await render.POST(renderRequest(v2("3:4")));
const renderedBody = await renderedResponse.json();
assert.equal(renderedResponse.status, 200);
assert.equal(renderedBody.planVersion, 2); assert.equal(renderedBody.outputSpec.width, 1080);
assert.equal(renderedBody.titleStyle.color, "#583A27");
assert.equal(historyInputs[0].p_plan.outputSpec.width, 1080);
assert.equal(historyInputs[0].p_plan.titleStyle.x, 0.08);
assert.equal(pure.coverCompositionMatches(renderedBody, v2("3:4"), assetId), true);
assert.equal(pure.coverCompositionMatches({ ...renderedBody, width: 999 }, v2("3:4"), assetId), false);
const secondResponse = await render.POST(renderRequest(v2("3:4")));
assert.equal((await secondResponse.json()).renderFingerprint, renderedBody.renderFingerprint);
assert.equal(persistedBodies[0].clientTraceId, persistedBodies[1].clientTraceId);
checks.push("actual render API validates V2, persists real fixed PNG, records style/spec and returns matching stable fingerprint");
const beforeInvalidRender = persistedBodies.length;
assert.equal((await render.POST(renderRequest({ ...v2("3:4"), outputSpec: { ...v2("3:4").outputSpec, width: 999 } }))).status, 400);
assert.equal((await render.POST(renderRequest({ ...v2("3:4"), titleStyle: { unknown: 1 } }))).status, 400);
assert.equal((await render.POST(renderRequest({ ...legacy, titleStyle: { color: "#000000" } }))).status, 400);
assert.equal(persistedBodies.length, beforeInvalidRender);
checks.push("actual render API rejects bad output size, unknown style fields and unversioned extensions before persistence");
const materials = load("src/app/api/cover/materials/route.ts", {
  "node:crypto": { createHash }, "next/server": next, sharp: { default: sharp },
  "@/lib/current-api-user": auth, "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/lib/file-upload-security": load("src/lib/file-upload-security.ts", { "node:crypto": { randomUUID } }),
  "@/storage/object": { storageManager: { upload: async (bytes, _name, mime, options) => {
    uploadCalls += 1;
    assert.equal(hash(bytes), sourceHash); assert.equal(mime, "image/png");
    assert.equal(options.userId, userId); assert.equal(options.providerType, "tencent_cos");
    assert.equal(options.strictProvider, true); assert.equal(options.requireOwnershipRecord, true); assert.equal(options.publicRead, false);
    return { key: "cover-materials/fixture.png", provider: "tencent_cos" };
  } } },
});
async function uploadRequest(bytes = source, role = "background_canvas", type = "image/png") {
  const form = new FormData(); form.set("file", new File([bytes], "fixture.png", { type })); form.set("role", role);
  const initial = new Request("https://fixture.invalid/api/cover/materials", { method: "POST", body: form });
  const body = Buffer.from(await initial.arrayBuffer());
  return new Request(initial.url, { method: "POST", headers: { "Content-Type": initial.headers.get("content-type"), "Content-Length": String(body.length) }, body });
}
const uploaded = await materials.POST(await uploadRequest());
const uploadedBody = await uploaded.json();
assert.equal(uploaded.status, 200); assert.equal(uploadedBody.assetId, assetId); assert.equal(uploadedBody.assetRevision, 1);
assert.equal(uploadedBody.sha256, sourceHash); assert.equal(uploadedBody.previewUrl, `/api/storage/files/${assetId}/content`);
assert.equal(uploadedBody.width, 2048); assert.equal(uploadedBody.height, 2048);
assert.equal(uploadedBody.url, undefined); assert.equal(uploadCalls, 1);
checks.push("materials uses strict private COS and awaits owner ID, returns authenticated preview without generation history");
ownershipAvailable = false;
assert.equal((await materials.POST(await uploadRequest())).status, 503);
checks.push("materials never reports success when ownership cannot be read back");
ownershipAvailable = true;
const beforeRejects = uploadCalls;
assert.equal((await materials.POST(await uploadRequest(source, "invalid"))).status, 400);
assert.equal((await materials.POST(await uploadRequest(Buffer.from("not an image")))).status, 415);
assert.equal((await materials.POST(await uploadRequest(source.subarray(0, 40)))).status, 415);
assert.equal((await materials.POST(await uploadRequest(Buffer.alloc(5 * 1024 * 1024 + 1)))).status, 413);
authorized = false;
assert.equal((await materials.POST(await uploadRequest())).status, 401);
assert.equal(uploadCalls, beforeRejects);
assert.equal(externalCalls, 0);
checks.push("invalid role, corrupt/oversized images and unauthorized callers are rejected before upload");
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: externalCalls, liveDatabaseCalls: 0, providerCalls: 0,
  evidence: "Actual Sharp PNG rendering, pure plan validation and actual materials POST; auth/DB/object storage are in-memory fixtures", cases: checks }, null, 2));
