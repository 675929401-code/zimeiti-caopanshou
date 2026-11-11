#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

let networkCalls = 0, fontReads = 0, writes = 0;
const persistTraces = [];
const forbidden = () => { networkCalls++; throw new Error("External I/O forbidden"); };
function load(file, imports = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Headers, Request, Response, console, fetch: forbidden,
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${file}: ${name}`); return imports[name]; } }, { filename: file });
  return module.exports;
}
const pure = load("src/lib/cover-composition.ts");
const durable = load("src/lib/cover-durable-attempt.ts", { "@/lib/cover-composition": pure });
const renderer = load("src/lib/cover-composition-server.ts", {
  "node:fs": { existsSync() { fontReads++; throw new Error("Native export must never read a font"); } },
  sharp: { default: sharp }, "./cover-composition": pure,
  "./storyboard-annotation-layout": load("src/lib/storyboard-annotation-layout.ts"),
});
const plan = { title: "猫咪等你回家", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-cover-workbench",
  animationStyleId: "pixar-3d", coverModeId: "cartoon", materialSourceId: "text", subjectModeId: "semantic", planVersion: 2,
  outputSpec: { aspectRatio: "3:4", width: 1080, height: 1440, format: "png", fit: "contain" },
  textRendering: { mode: "native", version: pure.COVER_TEXT_RENDERING_VERSION } };
const clone = value => structuredClone(value);
const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
const checks = [];
assert.equal(pure.coverCompositionValidationError(plan), null);
same(durable.projectCoverCompositionPlan(plan).textRendering, plan.textRendering);
const legacy = clone(plan); delete legacy.textRendering; delete legacy.outputSpec.fit;
assert.equal(pure.coverTextRendering(legacy).mode, "overlay");
assert.ok(pure.coverCompositionValidationError({ ...plan, textRendering: { mode: "native", version: "future" } }));
assert.ok(pure.coverCompositionValidationError({ ...plan, outputSpec: { ...plan.outputSpec, fit: "cover" } }));
checks.push("versioned text mode survives actual durable projection; historical plans remain overlay and invalid versions/cropping fail");

// Red edge strips are evidence that a 16:9 provider image is retained in full,
// rather than cropped to portrait. This is a pixel fixture, not model output.
const source = await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#226699" } })
  .composite([{ input: { create: { width: 80, height: 1080, channels: 3, background: "#ff0000" } }, left: 0, top: 0 },
    { input: { create: { width: 80, height: 1080, channels: 3, background: "#00ff00" } }, left: 1840, top: 0 }]).png().toBuffer();
const rendered = await renderer.renderCoverComposition(source, plan);
assert.equal(fontReads, 0); assert.equal(rendered.width, 1080); assert.equal(rendered.height, 1440);
assert.equal(rendered.renderedText, undefined); assert.equal(rendered.textVerification, "unverified");
same(rendered.requestedText, { title: plan.title, subtitle: "" });
const pixels = await sharp(rendered.bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const pixel = (x, y) => [...pixels.data.subarray((y * pixels.info.width + x) * pixels.info.channels, (y * pixels.info.width + x) * pixels.info.channels + 3)];
same(pixel(10, 720), [255, 0, 0]); same(pixel(1070, 720), [0, 255, 0]); same(pixel(540, 10), [255, 255, 255]);
await assert.rejects(renderer.renderCoverComposition(await sharp({ create: { width: 600, height: 600, channels: 3, background: "#112233" } }).png().toBuffer(), plan), /COVER_BACKGROUND_INSUFFICIENT_PIXELS/u);
const exact = await sharp({ create: { width: 1080, height: 1440, channels: 3, background: "#445566" } }).png().toBuffer();
const exactRendered = await renderer.renderCoverComposition(exact, plan);
assert.deepEqual(await sharp(exactRendered.bytes).raw().toBuffer(), await sharp(exact).raw().toBuffer());
checks.push("actual native renderer performs no font or text/decorative layer work, retains edge pixels with contain, preserves exact pixels, and refuses enlargement");

const sourceId = "00000000-0000-4000-8000-000000000002", outputId = "00000000-0000-4000-8000-000000000003";
const metadata = { coverGeneratedExport: { nativePlan: clone(plan) } };
assert.equal(pure.coverSourcePlanBindingError(metadata, plan), null);
for (const change of [value => { delete value.textRendering; }, value => { value.textRendering.mode = "overlay"; }, value => { value.title = "另一标题"; }, value => { value.outputSpec.fit = "cover"; }]) {
  const altered = clone(plan); change(altered); assert.ok(pure.coverSourcePlanBindingError(metadata, altered));
}
assert.equal(pure.coverSourcePlanBindingError({}, legacy), null);
const receipt = { outputKind: "cover-composition", sourceAssetId: sourceId, planVersion: 2, outputSpec: plan.outputSpec,
  width: 1080, height: 1440, ...pure.coverCompositionTextReceipt(plan) };
assert.equal(pure.coverCompositionMatches(receipt, plan, sourceId), true);
assert.equal(pure.coverCompositionMatches({ ...receipt, renderedText: { title: plan.title, subtitle: "" } }, plan, sourceId), false);
assert.equal(pure.coverCompositionMatches({ ...receipt, textVerification: "verified" }, plan, sourceId), false);
checks.push("native source metadata rejects title/mode/geometry changes; requested glyph binding stays unverified and cannot masquerade as renderedText");

const file = { id: sourceId, user_id: "fixture-owner", storage_key: "fixture/native.png", storage_provider: "tencent_cos",
  content_type: "image/png", file_size: source.length, meta: metadata };
const db = { from() { const query = { select() { return query; }, eq() { return query; }, order() { return query; }, limit() { return query; },
  maybeSingle: async () => ({ data: file, error: null }), then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } }; return query; },
  async rpc(name) { assert.equal(name, "record_cover_composition"); writes++; return { data: { asset_id: outputId, task_no: 1, created_at: "2026-11-06T00:00:00.000Z" } }; } };
const imports = {
  "next/server": { NextRequest: Request, NextResponse: { json: (value, init) => Response.json(value, init) } },
  "node:crypto": { createHash }, zod: { z }, "@/lib/cover-composition": pure, "@/lib/cover-durable-attempt": durable,
  "@/lib/cover-composition-server": renderer, "@/lib/auth": { getTokenFromHeaders: () => "fixture-not-real" },
  "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: "fixture-owner" } }) },
  "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/storage/object": { storageManager: { read: async () => source, readBounded: async () => source } },
  "@/app/api/image-workbench/persist/route": { POST: async request => { persistTraces.push((await request.json()).clientTraceId); writes++; return Response.json({ success: true, persisted: true,
    cloudStored: true, assetId: outputId, historyRecordId: outputId, key: "fixture/result.png", url: "/fixture-result" }); } },
  "@/lib/server/cover-request-body": { readCoverRequestJson: request => request.json(), CoverRequestBodyError: class extends Error {} },
};
const renderRoute = load("src/app/api/cover/render/route.ts", imports), preview = load("src/app/api/cover/preview/route.ts", imports);
const request = body => new Request("http://127.0.0.1:5000/api/cover/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// No prior output exists in this fixture; source lookup remains owner scoped in
// the real route. The persistence dependency is deliberately an in-memory fake.
const altered = clone(plan); altered.title = "不能偷偷改字";
assert.equal((await renderRoute.POST(request({ sourceAssetId: sourceId, plan: altered }))).status, 409);
assert.equal((await preview.POST(request({ sourceAssetId: sourceId, plan: altered }))).status, 409);
assert.equal(writes, 0);
const previewResponse = await preview.POST(request({ sourceAssetId: sourceId, plan }));
assert.equal(previewResponse.status, 200); assert.equal(previewResponse.headers.get("content-type"), "image/png");
assert.equal(fontReads, 0); assert.equal(writes, 0); assert.equal(networkCalls, 0);
checks.push("actual render and preview routes share immutable source guard; native preview reads no font and performs no save or provider request");
for (let index = 0; index < 2; index++) {
  const saved = await renderRoute.POST(request({ sourceAssetId: sourceId, plan }));
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.equal(body.textVerification, "unverified"); assert.equal(body.renderedText, undefined);
  same(body.requestedText, { title: plan.title, subtitle: plan.subtitle });
  assert.equal(pure.coverCompositionMatches(body, plan, sourceId), true);
}
assert.equal(persistTraces[0], persistTraces[1]); assert.equal(fontReads, 0); assert.equal(networkCalls, 0);
checks.push("actual native save returns requestedText/unverified without font dependencies and reuses the same stable persistence trace for the same source/plan");
console.log(JSON.stringify({ passed: true, assertions: checks.length, networkCalls, fontReads, businessWrites: 0, fixturePersistenceCalls: writes,
  evidence: "Actual pure contracts, renderer and route handlers with synthetic pixels, fixture owner/DB/storage; no real model or text-accuracy claim", checks }, null, 2));
