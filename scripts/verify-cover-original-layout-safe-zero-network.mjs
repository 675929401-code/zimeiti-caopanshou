#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checks = [], cases = [];
let externalCalls = 0, captured = [];
const forbidden = () => { externalCalls++; throw new Error("Real external I/O forbidden"); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, imports = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, Error, console, fetch: forbidden,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unexpected import ${file}: ${id}`); return imports[id]; } }, { filename: file });
  return module.exports;
}
const pure = load("src/lib/cover-composition.ts");
const durable = load("src/lib/cover-durable-attempt.ts", { "@/lib/cover-composition": pure });
const observedSharp = (...args) => {
  const pipeline = sharp(...args), composite = pipeline.composite;
  pipeline.composite = function (layers) { captured = layers; return composite.call(this, layers); };
  return pipeline;
};
const renderer = load("src/lib/cover-composition-server.ts", { "node:fs": { existsSync }, sharp: { default: observedSharp },
  "./cover-composition": pure, "./storyboard-annotation-layout": load("src/lib/storyboard-annotation-layout.ts") });
assert.ok(renderer.coverCompositionFont("reference-adaptive"), "A real local Chinese font is required");
const planFor = (ratio, width, height, changes = {}) => ({ planVersion: 2, title: "完整保留原人物", subtitle: "脸、手、衣服都不改动",
  aspectRatio: ratio, outputSpec: { aspectRatio: ratio, ...pure.COVER_OUTPUT_SPECS[ratio], format: "png", fit: "contain" },
  textRendering: { mode: "overlay", version: pure.COVER_TEXT_RENDERING_VERSION }, materialSourceId: "upload",
  layoutTemplateId: "gaoding-cover-workbench", animationStyleId: "photo-real", coverModeId: "cartoon",
  titleStyle: { color: "#FFF1B8", colorMode: "single", scale: 1 }, originalLayout: {
    version: pure.COVER_ORIGINAL_LAYOUT_VERSION, sourceWidth: width, sourceHeight: height, structure: "single", focus: "action", ...changes,
  } });
const disjoint = (a, b) => a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top;
const rgba = bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
function contrastOnWhite(red, green, blue) {
  const channel = value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  return 1.05 / (.2126 * channel(red) + .7152 * channel(green) + .0722 * channel(blue) + .05);
}
async function verifyPixels(name, source, plan) {
  assert.equal(pure.coverCompositionValidationError(plan), null);
  const inputHash = hash(source), rendered = await renderer.renderCoverComposition(source, plan), layers = captured;
  const geometry = pure.coverOriginalLayoutGeometry(plan);
  assert.ok(disjoint(geometry.image, geometry.title));
  assert.ok(layers.length >= 2 && layers.length <= 3, "Only complete photo, main title and optional subtitle are allowed");
  let minimumContrast = Infinity;
  for (const layer of layers.slice(1)) {
    const meta = await sharp(layer.input).metadata();
    const box = { left: layer.left, top: layer.top, width: meta.width, height: meta.height };
    assert.ok(disjoint(geometry.image, box), `${name} text must not touch any photo pixel`);
    assert.ok(box.left >= geometry.title.left && box.top >= geometry.title.top && box.left + box.width <= geometry.title.left + geometry.title.width && box.top + box.height <= geometry.title.top + geometry.title.height);
    const glyph = await rgba(layer.input); let opaque = 0;
    for (let i = 0; i < glyph.data.length; i += 4) if (glyph.data[i + 3] === 255) {
      opaque++; minimumContrast = Math.min(minimumContrast, contrastOnWhite(glyph.data[i], glyph.data[i + 1], glyph.data[i + 2]));
    }
    assert.ok(opaque > 0, "Real glyph interiors must be measurable");
  }
  assert.ok(minimumContrast >= 4.5, `Actual opaque glyph foreground versus white must meet 4.5:1, got ${minimumContrast}`);
  const expectedPhoto = await sharp(source).rotate().resize(geometry.image.width, geometry.image.height, { fit: "contain", withoutEnlargement: true, background: "#ffffff" }).png().toBuffer();
  const actualPhoto = await sharp(rendered.bytes).extract(geometry.image).ensureAlpha().raw().toBuffer();
  const expectedRawPhoto = await sharp(expectedPhoto).flatten({ background: "#ffffff" }).ensureAlpha().raw().toBuffer();
  assert.ok(actualPhoto.equals(expectedRawPhoto), `${name}: EVERY pixel of the complete resized photo (including face/hands/clothes) remains exact`);
  const width = rendered.width, height = rendered.height;
  const canvas = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#ffffff"/></svg>`);
  const baseline = await rgba(await sharp(canvas).composite([{ input: expectedPhoto, left: geometry.image.left, top: geometry.image.top }]).png().toBuffer());
  const actual = await rgba(rendered.bytes);
  const mask = await sharp({ create: { width, height, channels: 4, background: "#00000000" } }).composite(layers.slice(1)).ensureAlpha().raw().toBuffer();
  let changed = 0, outside = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    const different = [0, 1, 2, 3].some(offset => actual.data[i + offset] !== baseline.data[i + offset]);
    if (different) { changed++; if (mask[i + 3] === 0) outside++; }
  }
  assert.ok(changed > 0, "Real text glyph pixels must be present");
  assert.equal(outside, 0, "Every pixel outside the actual text alpha mask must equal the exact contain baseline");
  assert.equal(hash(source), inputHash);
  assert.equal(rendered.renderedText.title, plan.title); assert.equal(rendered.renderedText.subtitle, plan.subtitle);
  assert.ok(rendered.renderedText.lines.length >= 1 && rendered.renderedText.lines.length <= 2, "Main title must remain one or two visual lines");
  assert.equal(rendered.renderedText.lines.join("").replace(/\s/gu, ""), plan.title.replace(/\s/gu, ""), "No visible title character may be truncated");
  cases.push({ name, output: { width, height }, geometry: plain(geometry), mainTitleVisualLines: rendered.renderedText.lines.length,
    minimumOpaqueGlyphContrast: minimumContrast, changedTextPixels: changed, changedOutsideTextMask: outside, photoPixelsExact: true });
  return rendered;
}

const portrait = await sharp(Buffer.from('<svg width="1086" height="1448"><rect width="100%" height="100%" fill="#aabbd1"/><rect width="80" height="80" fill="red"/><rect x="1006" width="80" height="80" fill="lime"/><rect y="1368" width="80" height="80" fill="blue"/><rect x="1006" y="1368" width="80" height="80" fill="yellow"/></svg>')).png().toBuffer();
const landscape = await sharp(portrait).rotate(90).png().toBuffer();
const square = await sharp(portrait).resize(1440, 1440, { fit: "fill" }).png().toBuffer();
for (const ratio of Object.keys(pure.COVER_OUTPUT_SPECS)) {
  for (const [name, source, sw, sh] of [["portrait", portrait, 1086, 1448], ["landscape", landscape, 1448, 1086], ["square", square, 1440, 1440]]) {
    await verifyPixels(`${name}-${ratio}`, source, planFor(ratio, sw, sh));
  }
}
checks.push("12 real Sharp portrait/landscape/square cases across all output ratios preserve the complete photo and every pixel outside actual text alpha");

const w6 = planFor("4:3", 1086, 1448);
const natural = pure.coverOriginalLayoutGeometry(w6);
assert.deepEqual(plain(natural.image), { left: 315, top: 0, width: 810, height: 1080 });
assert.equal(natural.usesExistingPadding, true); assert.equal(natural.placement, "left");
const mapped = pure.mapCoverSourceRegionToOutput({ x: .25, y: .2, width: .5, height: .6 }, natural.image);
assert.deepEqual(plain(mapped), { left: 517.5, top: 216, width: 405, height: 648 });
assert.ok(disjoint(mapped, natural.title));
const expression = pure.coverOriginalLayoutGeometry({ ...w6, originalLayout: { ...w6.originalLayout, focus: "expression" } });
assert.equal(expression.placement, "right"); assert.ok(disjoint(expression.image, expression.title));
const listPlan = { ...w6, originalLayout: { ...w6.originalLayout, structure: "list" } };
const list = pure.coverOriginalLayoutGeometry(listPlan);
assert.equal(list.usesExistingPadding, false); assert.equal(list.placement, "top"); assert.ok(disjoint(list.image, list.title));
await verifyPixels("confirmed-list-intent", portrait, listPlan);
checks.push("actual W6 contain has 315px gutters, source regions map with padding, and confirmed focus/structure changes safe placement");

const long = { ...w6, title: `${"完整保留人物脸和双手衣服".repeat(4).slice(0, 39)}\n${"自然微笑与动作都保持原样".repeat(4).slice(0, 40)}`, subtitle: "必须逐字保留的长副标题和补充说明".repeat(10).slice(0, 120) };
assert.equal(pure.coverOriginalLayoutGeometry(long).usesExistingPadding, false, "Long main title must use a wide title band, not three+ sidebar lines");
await verifyPixels("long-80-title-120-subtitle", portrait, long);
await verifyPixels("long-latin-unbroken", portrait, { ...w6, title: "LongUnbrokenWord".repeat(5).slice(0, 80), subtitle: "<markup & text> remains literal" });
checks.push("80-character explicit multiline and long unbroken Latin titles plus 120-character subtitle fit by actual Pango wrapping/font reduction without truncation");
const transparent = await sharp({ create: { width: 1086, height: 1448, channels: 4, background: { r: 80, g: 140, b: 180, alpha: .5 } } }).png().toBuffer();
await verifyPixels("transparent-source-white-compositing-baseline", transparent, w6);
checks.push("transparent source is compared with its exact white-canvas alpha-composited baseline; opaque source pixels remain exact");

const sourcePath = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/qa-assets/model.png");
let actualW6 = null;
if (existsSync(sourcePath)) {
  const source = readFileSync(sourcePath); actualW6 = await verifyPixels("actual-W6-model-photo", source, w6);
  const again = await renderer.renderCoverComposition(source, w6);
  assert.equal(hash(actualW6.bytes), hash(again.bytes));
  checks.push("actual W6 model.png: all resized face/hand/clothes pixels exact, no text-mask-external change, deterministic PNG");
}
assert.deepEqual(plain(durable.projectCoverCompositionPlan(w6).originalLayout), w6.originalLayout);
const receipt = { outputKind: "cover-composition", sourceAssetId: "fixture", renderedText: { title: w6.title, subtitle: w6.subtitle },
  width: 1440, height: 1080, planVersion: 2, outputSpec: w6.outputSpec, titleStyle: w6.titleStyle, textRendering: w6.textRendering, originalLayout: w6.originalLayout };
assert.equal(pure.coverCompositionMatches(receipt, w6, "fixture"), true);
assert.equal(pure.coverCompositionMatches({ ...receipt, originalLayout: undefined }, w6, "fixture"), false);
for (const change of [value => { value.originalLayout.version = "unknown"; }, value => { value.originalLayout.focus = "unsafe"; }, value => { value.originalLayout.extra = "private"; }, value => { value.outputSpec.fit = "cover"; }, value => { value.textRendering.mode = "native"; }]) {
  const bad = plain(w6); change(bad); assert.ok(pure.coverCompositionValidationError(bad));
}
await assert.rejects(() => renderer.renderCoverComposition(portrait, { ...w6, originalLayout: { ...w6.originalLayout, sourceWidth: 1087 } }), /COVER_ORIGINAL_SOURCE_MISMATCH/);
const legacy = plain(w6); delete legacy.originalLayout;
assert.equal(pure.coverCompositionValidationError(legacy), null);
assert.equal(durable.projectCoverCompositionPlan(legacy).originalLayout, undefined);
checks.push("strict version/source/mode/schema, projection, matching receipt and unchanged legacy policy");

// Exercise the REAL render and preview handlers; only their storage/auth/DB
// boundaries are in-memory. No persistence or upload reaches a real service.
const sourceId = "00000000-0000-4000-8000-000000000002", owner = "00000000-0000-4000-8000-000000000001";
const file = { id: sourceId, user_id: owner, storage_key: "fixture", storage_provider: "tencent_cos", file_category: "image", file_size: portrait.length, content_type: "image/png" };
let historyPlan, persistCalls = 0;
const db = { from() { const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
  maybeSingle: async () => ({ data: file, error: null }) }; return query; },
  rpc: async (_name, input) => { historyPlan = input.p_plan; return { data: { asset_id: sourceId, task_no: 1, created_at: "fixture" } }; } };
class NextRequest extends Request {}
const imports = { "node:crypto": { createHash }, "next/server": { NextRequest, NextResponse: { json: (data, init) => Response.json(data, init) } }, zod: { z },
  "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: owner } }) }, "@/lib/auth": { getTokenFromHeaders: () => "fixture" },
  "@/storage/database/supabase-client": { getSupabaseClient: () => db }, "@/storage/object": { storageManager: { read: async () => portrait, readBounded: async () => portrait } },
  "@/lib/cover-composition": pure, "@/lib/cover-composition-server": renderer, "@/lib/cover-durable-attempt": durable,
  "@/app/api/image-workbench/persist/route": { POST: async () => { persistCalls++; return Response.json({ persisted: true, assetId: sourceId, historyRecordId: sourceId }); } },
  "@/lib/server/cover-request-body": { readCoverRequestJson: req => req.json(), CoverRequestBodyError: class extends Error {} } };
const render = load("src/app/api/cover/render/route.ts", imports), preview = load("src/app/api/cover/preview/route.ts", imports);
const req = plan => new NextRequest("https://fixture.invalid/api/cover/render", { method: "POST", body: JSON.stringify({ sourceAssetId: sourceId, plan }) });
const saved = await render.POST(req(w6)); assert.equal(saved.status, 200);
const body = await saved.json(); assert.deepEqual(body.originalLayout, w6.originalLayout); assert.deepEqual(plain(historyPlan.originalLayout), w6.originalLayout);
assert.equal(pure.coverCompositionMatches(body, w6, sourceId), true);
const previewed = await preview.POST(req(w6)); assert.equal(previewed.status, 200);
const previewBytes = Buffer.from(await previewed.arrayBuffer()); const expected = await renderer.renderCoverComposition(portrait, w6);
assert.equal(hash(previewBytes), hash(expected.bytes));
const before = persistCalls;
const bad = await render.POST(req({ ...w6, originalLayout: { ...w6.originalLayout, sourceWidth: 1087 } })); assert.equal(bad.status, 409); assert.equal(persistCalls, before);
checks.push("real render/preview routes retain safe policy, exact preview bytes and history plan; wrong source refuses before persistence");

assert.equal(externalCalls, 0);
const report = { passed: true, groups: checks.length, pixelCases: cases.length, networkCalls: externalCalls, realDatabaseWrites: 0, providerCalls: 0,
  actualW6PhotoVerified: Boolean(actualW6), boundary: "Local production renderer and routes, real Sharp/Pango pixels; auth/DB/storage/persist are fixtures. No browser/provider/billing acceptance is claimed.", checks, cases };
if (process.env.COVER_ORIGINAL_LAYOUT_EVIDENCE_DIR) {
  const directory = path.resolve(process.env.COVER_ORIGINAL_LAYOUT_EVIDENCE_DIR); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "pixel-report.json"), JSON.stringify(report, null, 2));
  if (actualW6) writeFileSync(path.join(directory, "model-safe-layout.png"), actualW6.bytes);
}
console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
