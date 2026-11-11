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
import { fixture, request, owner, otherOwner, sourceId, getExternalCalls } from "./verify-cover-review-server-zero-network.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const intake = ".codex-evidence/cover-rebuild-20261106-bc1a/supervisor-resume/generated-overlay-safe-frame/intake";
const checks = [], cases = [], golden = [];
let forbiddenCalls = 0, captured = [];
const forbidden = () => { forbiddenCalls++; throw new Error("Unplanned real network/provider/DB I/O forbidden"); };
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
function load(file, imports = {}) {
  const module = { exports: {} };
  const result = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, Error, console, fetch: forbidden,
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
const rendererImports = { "node:fs": { existsSync }, sharp: { default: observedSharp }, "./cover-composition": pure,
  "./storyboard-annotation-layout": load("src/lib/storyboard-annotation-layout.ts") };
const renderer = load("src/lib/cover-composition-server.ts", rendererImports);
const planFor = (ratio = "4:3") => ({ planVersion: 2, title: "薄荷香型牙膏\n净含量120 g", subtitle: "", aspectRatio: ratio,
  layoutTemplateId: "gaoding-cover-workbench", animationStyleId: "photo-real", coverModeId: "custom-composition", materialSourceId: "upload",
  subjectModeId: "product", textRendering: { mode: "overlay", version: pure.COVER_TEXT_RENDERING_VERSION },
  outputSpec: { aspectRatio: ratio, ...pure.COVER_OUTPUT_SPECS[ratio], format: "png", fit: "contain" },
  titleStyle: pure.coverGeneratedOverlayTitleStyle(), generatedOverlayLayout: pure.coverGeneratedOverlayPolicy() });
const disjoint = (a, b) => a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top;
const inside = (a, b) => a.left >= b.left && a.top >= b.top && a.left + a.width <= b.left + b.width && a.top + a.height <= b.top + b.height;
const rgba = bytes => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const luminance = values => values.map(value => { const v = value / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; })
  .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
async function verifyPixels(name, source, plan) {
  assert.equal(pure.coverCompositionValidationError(plan), null);
  const before = JSON.stringify(plan), sourceHash = hash(source);
  const rendered = await renderer.renderCoverComposition(source, plan), layers = captured;
  const geometry = pure.coverGeneratedOverlayGeometry(plan, rendered.sourceWidth, rendered.sourceHeight);
  assert.deepEqual(plain(rendered.layoutGeometry), plain(geometry)); assert.ok(disjoint(geometry.image, geometry.title));
  assert.equal(layers.length, plan.subtitle ? 3 : 2, "Only complete photo and actual glyphs; no stroke, shadow or decoration");
  let minimumContrast = Infinity;
  const backgroundLuminance = luminance([245, 245, 242]);
  for (const layer of layers.slice(1)) {
    const glyph = await rgba(layer.input), box = { left: layer.left, top: layer.top, width: glyph.info.width, height: glyph.info.height };
    assert.ok(inside(box, geometry.title)); assert.ok(disjoint(box, geometry.image));
    let opaque = 0;
    for (let i = 0; i < glyph.data.length; i += 4) if (glyph.data[i + 3] === 255) {
      opaque++; const l = luminance([...glyph.data.subarray(i, i + 3)]);
      minimumContrast = Math.min(minimumContrast, (Math.max(l, backgroundLuminance) + .05) / (Math.min(l, backgroundLuminance) + .05));
    }
    assert.ok(opaque > 0);
  }
  assert.ok(minimumContrast >= 4.5);
  const expectedPhoto = await sharp(source).rotate().resize(geometry.image.width, geometry.image.height,
    { fit: "contain", withoutEnlargement: true, background: plan.generatedOverlayLayout.canvasColor }).png().toBuffer();
  const actualPhoto = await sharp(rendered.bytes).extract(geometry.image).ensureAlpha().raw().toBuffer();
  const expectedRaw = await sharp(expectedPhoto).flatten({ background: plan.generatedOverlayLayout.canvasColor }).ensureAlpha().raw().toBuffer();
  assert.ok(actualPhoto.equals(expectedRaw), "EVERY pixel in the complete resized photograph must equal the contain baseline");
  const { width, height } = plan.outputSpec;
  const canvas = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${plan.generatedOverlayLayout.canvasColor}"/></svg>`);
  const baseline = await rgba(await sharp(canvas).composite([layers[0]]).png().toBuffer()), actual = await rgba(rendered.bytes);
  const mask = await sharp({ create: { width, height, channels: 4, background: "#00000000" } }).composite(layers.slice(1)).ensureAlpha().raw().toBuffer();
  let changed = 0, outside = 0;
  for (let i = 0; i < actual.data.length; i += 4) if ([0, 1, 2, 3].some(offset => actual.data[i + offset] !== baseline.data[i + offset])) {
    changed++; if (mask[i + 3] === 0) outside++;
  }
  assert.ok(changed > 0); assert.equal(outside, 0);
  assert.ok(rendered.renderedText.lines.length >= 1 && rendered.renderedText.lines.length <= 2);
  assert.equal(rendered.renderedText.lines.join("").replace(/\s/gu, ""), plan.title.replace(/\s/gu, ""));
  assert.ok(rendered.textGeometry.fontSize >= 24); assert.ok(inside(rendered.textGeometry.title, geometry.title));
  assert.equal(JSON.stringify(plan), before, "Measured dimensions/geometry must never mutate the frozen plan"); assert.equal(hash(source), sourceHash);
  assert.ok(!Object.hasOwn(plan.generatedOverlayLayout, "sourceWidth"));
  cases.push({ name, geometry: plain(geometry), fontSize: rendered.textGeometry.fontSize, mainTitleLines: rendered.renderedText.lines.length,
    minimumOpaqueGlyphContrast: minimumContrast, photoPixelsExact: true, changedOutsideTextMask: outside, pngSha256: hash(rendered.bytes) });
  return rendered;
}
const portrait = await sharp(Buffer.from('<svg width="1536" height="2048"><rect width="100%" height="100%" fill="#aabbd1"/><circle cx="768" cy="400" r="300" fill="#dca"/><rect width="80" height="80" fill="red"/><rect x="1456" width="80" height="80" fill="lime"/><rect y="1968" width="80" height="80" fill="blue"/><rect x="1456" y="1968" width="80" height="80" fill="yellow"/></svg>')).png().toBuffer();
const landscape = await sharp(portrait).rotate(90).png().toBuffer(), square = await sharp(portrait).resize(2048, 2048, { fit: "fill" }).png().toBuffer();
for (const ratio of Object.keys(pure.COVER_OUTPUT_SPECS)) for (const [label, source] of [["portrait", portrait], ["landscape", landscape], ["square", square]]) {
  await verifyPixels(`${label}-${ratio}`, source, planFor(ratio));
}
checks.push("12 real Sharp/Pango cases: complete contain photo, disjoint measured glyphs, high contrast, no shadow/decoration and immutable plan across all ratios");
await verifyPixels("long-80-title-120-subtitle", portrait, { ...planFor(), title: "完整保留人物脸和双手衣服".repeat(8).slice(0, 39) + "\n" + "自然微笑与动作都保持原样".repeat(8).slice(0, 40), subtitle: "完整副标题与说明".repeat(20).slice(0, 120) });
await verifyPixels("long-unbroken-latin", landscape, { ...planFor(), title: "LongUnbrokenWord".repeat(8).slice(0, 80), subtitle: "<markup & literal text>" });
const transparent = await sharp({ create: { width: 2048, height: 1536, channels: 4, background: { r: 80, g: 140, b: 180, alpha: .5 } } }).png().toBuffer();
await verifyPixels("transparent-source", transparent, planFor());
const exif = await sharp(landscape).jpeg().withMetadata({ orientation: 6 }).toBuffer();
await verifyPixels("EXIF-rotated-complete-source", exif, planFor());
await verifyPixels("escaped-markup-combining-and-emoji", portrait, { ...planFor(), title: '<字> & "120 g"\nA07 e\u0301 ⚡', subtitle: "<span foreground='#FFFFFF'>不能变成指令</span>" });
const small = await sharp({ create: { width: 128, height: 128, channels: 3, background: "#aabbd1" } }).png().toBuffer();
await assert.rejects(() => renderer.renderCoverComposition(small, planFor()), /COVER_BACKGROUND_TOO_SMALL/);
const insufficient = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#aabbd1" } }).png().toBuffer();
await assert.rejects(() => renderer.renderCoverComposition(insufficient, planFor()), /COVER_BACKGROUND_INSUFFICIENT_PIXELS/);
await assert.rejects(() => renderer.renderCoverComposition(Buffer.from("invalid image bytes"), planFor()));
let actualModel;
const modelPath = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/qa-assets/model.png");
if (existsSync(modelPath)) actualModel = await verifyPixels("actual-original-model-face-hands", readFileSync(modelPath), planFor());
let actualProduct;
const productPath = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/supervisor-resume/generated-overlay-safe-frame/existing-product-two-owned-background.png");
if (existsSync(productPath)) actualProduct = await verifyPixels("actual-owned-product-two-background-offline-prototype", readFileSync(productPath), planFor());
checks.push("long Chinese/Latin text fits in at most two real Pango lines without truncation; transparent source and actual model face/hand photo retain exact contain pixels");

const plan = planFor(), receipt = { outputKind: "cover-composition", sourceAssetId: sourceId, width: 1440, height: 1080, planVersion: 2,
  outputSpec: plan.outputSpec, titleStyle: plan.titleStyle, ...pure.coverCompositionTextReceipt(plan) };
assert.equal(pure.coverCompositionMatches(receipt, plan, sourceId), true);
assert.deepEqual(plain(durable.projectCoverCompositionPlan(plan)), plain(plan));
for (const edit of [p => delete p.generatedOverlayLayout, p => p.generatedOverlayLayout.version = "unknown", p => p.generatedOverlayLayout.placement = "bottom",
  p => p.generatedOverlayLayout.canvasColor = "#000000", p => p.generatedOverlayLayout.extra = "private", p => p.generatedOverlayLayout.sourceWidth = 2048]) {
  const changed = plain(receipt); edit(changed); assert.equal(pure.coverCompositionMatches(changed, plan, sourceId), false);
}
for (const edit of [p => p.generatedOverlayLayout.version = "unknown", p => p.generatedOverlayLayout.placement = "bottom", p => p.generatedOverlayLayout.canvasColor = "#FFFFFF",
  p => p.generatedOverlayLayout.extra = true, p => p.generatedOverlayLayout = [], p => p.textRendering.mode = "native", p => p.outputSpec.fit = "cover",
  p => delete p.planVersion, p => p.materialSourceId = "text", p => p.titleStyle.scale = .7, p => p.titleStyle.color = "#FFFFFF",
  p => p.originalLayout = { version: pure.COVER_ORIGINAL_LAYOUT_VERSION, sourceWidth: 2048, sourceHeight: 1536, structure: "single", focus: "object" }]) {
  const bad = plain(plan); edit(bad); assert.ok(pure.coverCompositionValidationError(bad));
  await assert.rejects(() => renderer.renderCoverComposition(portrait, bad), /COVER_V2_PLAN_INVALID/);
}
checks.push("strict policy version/enums/extra fields and incompatible native/original/output/material/style inputs reject; receipt rejects stripped or changed policy");

// REAL render and preview routes, with owner-filtering storage/persistence ports.
class NextRequest extends Request {}
let authOwner = owner, persistCalls = 0, historyPlan, priorHistory = null, historyLookupError = null;
const historyLookups = [];
const file = { id: sourceId, user_id: owner, storage_key: "fixture/photo", storage_provider: "tencent_cos", file_category: "image", file_size: portrait.length, content_type: "image/png" };
const db = { from(table) { const filters = [], orders = []; const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; }, order: (key, options) => { orders.push([key, options]); return query; }, limit: () => query,
  maybeSingle: async () => { if (table === "cover_generation_history") { historyLookups.push({ filters, orders }); return { data: priorHistory, error: historyLookupError }; }
    return { data: table === "user_files" && filters.every(([key, value]) => file[key] === value) ? file : null, error: null }; } }; return query; },
  rpc: async (_name, input) => { historyPlan = input.p_plan; return { data: { asset_id: sourceId, task_no: 1, created_at: "fixture" } }; } };
const routeImports = { "node:crypto": { createHash }, "next/server": { NextRequest, NextResponse: { json: (body, init) => Response.json(body, init) } }, zod: { z },
  "@/lib/current-api-user": { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId: authOwner } }) }, "@/lib/auth": { getTokenFromHeaders: () => "fixture" },
  "@/storage/database/supabase-client": { getSupabaseClient: () => db }, "@/storage/object": { storageManager: { read: async () => portrait, readBounded: async () => portrait } },
  "@/lib/cover-composition": pure, "@/lib/cover-composition-server": renderer, "@/lib/cover-durable-attempt": durable,
  "@/app/api/image-workbench/persist/route": { POST: async () => { persistCalls++; return Response.json({ persisted: true, assetId: sourceId, historyRecordId: sourceId }); } },
  "@/lib/server/cover-request-body": { readCoverRequestJson: req => req.json(), CoverRequestBodyError: class extends Error {} } };
const renderRoute = load("src/app/api/cover/render/route.ts", routeImports), previewRoute = load("src/app/api/cover/preview/route.ts", routeImports);
const req = (value, authoring) => new NextRequest("https://fixture.invalid/api/cover/render", { method: "POST", body: JSON.stringify({ sourceAssetId: sourceId, plan: value, ...(authoring ? { authoring } : {}) }) });
const saved = await renderRoute.POST(req(plan)); assert.equal(saved.status, 200); const body = await saved.json();
assert.equal(pure.coverCompositionMatches(body, plan, sourceId), true); assert.deepEqual(plain(historyPlan), plain(plan));
assert.deepEqual(body.generatedOverlayLayout, plain(plan.generatedOverlayLayout)); assert.ok(body.layoutGeometry && body.textGeometry);
const previewed = await previewRoute.POST(req(plan)); assert.equal(previewed.status, 200);
assert.equal(hash(Buffer.from(await previewed.arrayBuffer())), hash((await renderer.renderCoverComposition(portrait, plan)).bytes));
const beforeCalls = persistCalls;
for (const change of [p => p.generatedOverlayLayout.extra = "hidden", p => p.generatedOverlayLayout.version = "v2"]) {
  const bad = plain(plan); change(bad); assert.equal((await renderRoute.POST(req(bad))).status, 400); assert.equal((await previewRoute.POST(req(bad))).status, 422);
}
authOwner = otherOwner; assert.equal((await renderRoute.POST(req(plan))).status, 404); assert.equal((await previewRoute.POST(req(plan))).status, 404);
assert.equal(persistCalls, beforeCalls);
checks.push("real preview/render routes preserve exact policy/history and identical Pango bytes; malformed policy and cross-account source stop before persistence");

authOwner = owner; file.meta = { coverGeneratedExport: { schema: "cover_generated_export/1" } };
priorHistory = { user_id: owner, background_asset_id: sourceId, authoring_context: { briefText: "original private description", prompt: "PRIVATE_INHERITED_GENERATION_PROMPT" } };
const inherited = await renderRoute.POST(req(plan, { briefText: "explicit edited description", prompt: "" }));
assert.equal(inherited.status, 200); const inheritedBody = await inherited.json();
assert.equal(historyPlan._authoring.prompt, "PRIVATE_INHERITED_GENERATION_PROMPT"); assert.equal(historyPlan._authoring.briefText, "explicit edited description");
assert.equal(JSON.stringify(inheritedBody).includes("PRIVATE_INHERITED_GENERATION_PROMPT"), false);
assert.deepEqual(historyLookups.at(-1).filters, [["user_id", owner], ["background_asset_id", sourceId]]);
assert.deepEqual(plain(historyLookups.at(-1).orders), [["created_at", { ascending: true }], ["asset_id", { ascending: true }]]);
const beforeFailure = persistCalls;
for (const [row, error] of [[null, null], [{ ...priorHistory, user_id: otherOwner }, null], [{ ...priorHistory, background_asset_id: "foreign" }, null],
  [priorHistory, { message: "fixture read failure" }], [{ ...priorHistory, authoring_context: { prompt: "" } }, null]]) {
  priorHistory = row; historyLookupError = error;
  const denied = await renderRoute.POST(req(plan, { briefText: "edited", prompt: "" })); assert.equal(denied.status, 503);
  assert.equal((await denied.json()).code, "COVER_AUTHORING_SOURCE_UNKNOWN"); assert.equal(persistCalls, beforeFailure);
}
priorHistory = null; historyLookupError = null;
const beforeExplicit = historyLookups.length;
assert.equal((await renderRoute.POST(req(plan, { briefText: "explicit", prompt: "EXPLICIT_NONEMPTY_AUTHORING" }))).status, 200);
assert.equal(historyPlan._authoring.prompt, "EXPLICIT_NONEMPTY_AUTHORING"); assert.equal(historyLookups.length, beforeExplicit);
const originalPlan = plain(plan); delete originalPlan.generatedOverlayLayout;
originalPlan.originalLayout = { version: pure.COVER_ORIGINAL_LAYOUT_VERSION, sourceWidth: 1536, sourceHeight: 2048, structure: "single", focus: "action" };
assert.equal((await renderRoute.POST(req(originalPlan))).status, 200); assert.equal(historyLookups.length, beforeExplicit);
const nativePlan = plain(plan); delete nativePlan.generatedOverlayLayout; nativePlan.textRendering.mode = "native";
assert.equal((await renderRoute.POST(req(nativePlan))).status, 200); assert.equal(historyLookups.length, beforeExplicit);
delete file.meta;
checks.push("real free render inherits private authoring only from earliest exact owner/background history; foreign/missing/corrupt/read-error provenance fails closed, never leaks prompt, and explicit nonempty/native/original paths keep their semantics");

// Real confirm/compiler/projection/prepared binding. No mock output is a media acceptance.
function safeFixture() {
  const f = fixture();
  f.parent.materials.assets = [{ assetId: sourceId, role: "identity_subject", imageNumber: 1 }]; f.parent.materials.imageMode = "compose";
  f.parent.preparation.style = f.load("src/lib/cover-material-composition.ts").COVER_CUSTOM_COMPOSITION_STYLE_PROFILE;
  f.parent.preparation.route = "subject_composite"; f.parent.preparation.generatedOverlayLayout = pure.coverGeneratedOverlayPolicy();
  f.parent.preparation.outputSpec.fit = "contain"; f.parent.preparation.textRendering = { mode: "overlay", version: pure.COVER_TEXT_RENDERING_VERSION };
  return f;
}
const f = safeFixture(), parentBefore = JSON.stringify(f.parent), confirmation = await f.confirm();
assert.equal(confirmation.response.status, 200); const child = f.state.rows.find(row => row.id === confirmation.body.confirmationId);
assert.equal(JSON.stringify(f.parent), parentBefore); assert.deepEqual(plain(child.preparation.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.deepEqual(plain(child.result.task.renderPlan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.deepEqual(plain(confirmation.body.renderPlan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.deepEqual(plain(confirmation.body.task.renderPlan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.ok(child.result.generationPromptVersion.includes(pure.COVER_GENERATED_OVERLAY_LAYOUT_VERSION));
assert.ok(child.result.generationInput.prompt.includes("do not reserve an additional title zone"));
assert.equal(child.result.generationInput.prompt.includes("为后续应用排字保留连续自然的低细节区域"), false);
const claim = { task: child.result.task, payload: child.result.generationInput, referenceCount: 1 };
assert.deepEqual(plain(durable.parseCoverAttemptClaim(claim).task.renderPlan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
const guard = f.load("src/lib/server/cover-prepared-generation.ts");
const binding = { userId: owner, task: child.result.task, generationInput: child.result.generationInput,
  ...child.result.generationIdentity, requestUrl: "https://fixture.invalid/api/cover/attempt", phase: "delivery" };
assert.deepEqual(plain(await guard.validatePreparedCoverGeneration(binding)), []);
for (const edit of [p => delete p.generatedOverlayLayout, p => p.generatedOverlayLayout.version = "unknown", p => p.generatedOverlayLayout.extra = true]) {
  const changed = plain(binding); edit(changed.task.renderPlan);
  await assert.rejects(() => guard.validatePreparedCoverGeneration(changed), error => error.code === "COVER_PREPARED_INPUT_CONFLICT");
}
await assert.rejects(() => guard.validatePreparedCoverGeneration({ ...binding, userId: otherOwner }));
const old = safeFixture(); delete old.parent.preparation.generatedOverlayLayout;
const oldConfirmation = await old.confirm(); assert.equal(oldConfirmation.response.status, 200);
const oldChild = old.state.rows.find(row => row.id === oldConfirmation.body.confirmationId);
assert.equal(oldChild.result.renderPlan.generatedOverlayLayout, undefined); assert.notEqual(child.preparation.confirmedPlanHash, oldChild.preparation.confirmedPlanHash);
assert.equal(oldChild.preparation.confirmedPlanHash, old.repository.coverMaterialFingerprint({ schema: "cover-confirmed-plan/1", originalAnalysisOperationId: old.parent.id,
  originalAnalysisHash: oldChild.preparation.originalAnalysisHash, plan: oldChild.preparation.confirmedPlan, fieldOrigins: oldChild.preparation.fieldOrigins, imageQuoteHash: oldChild.preparation.quote.imageQuoteHash }));
assert.equal(f.state.writes.length, 0); assert.equal(f.state.renderCalls, 0);
const reference = safeFixture(); reference.parent.materials.imageMode = "preserve";
reference.parent.materials.assets[0].role = "style_reference"; reference.parent.preparation.route = "reference_visual";
reference.parent.preparation.style = reference.load("src/lib/cover-workbench-contract.ts").COVER_REFERENCE_STYLE_PROFILE;
const referenceConfirmation = await reference.confirm(); assert.equal(referenceConfirmation.response.status, 200);
assert.deepEqual(plain(referenceConfirmation.body.renderPlan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.equal(referenceConfirmation.body.renderPlan.materialSourceId, "template");
const referenceChild = reference.state.rows.find(row => row.id === referenceConfirmation.body.confirmationId);
assert.ok(referenceChild.result.generationInput.prompt.includes("do not reserve an additional title zone"));
for (const corrupted of [null, false, "", { ...plain(plan.generatedOverlayLayout), version: "unknown" }, { ...plain(plan.generatedOverlayLayout), extra: true }]) {
  const poisoned = safeFixture(); poisoned.parent.preparation.generatedOverlayLayout = corrupted;
  const denied = await poisoned.confirm(); assert.equal(denied.response.status, 422); assert.equal(denied.body.code, "COVER_GENERATED_LAYOUT_INVALID");
  assert.equal(poisoned.state.rows.length, 1); assert.equal(poisoned.state.writes.length, 0);
}
checks.push("real immutable confirmation/hash, task/projection/durable and delivery bind policy; stripping/changing policy or account fails, absent-policy legacy hash formula stays exact");

// Execute the real optional editor handler and derived plan, including its gates.
const uiPath = "src/components/cover-workbench-client.ts", uiSource = readFileSync(path.join(root, uiPath), "utf8");
const uiAst = ts.createSourceFile(uiPath, uiSource, ts.ScriptTarget.Latest, true);
const hook = uiAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useCoverWorkbench");
function declaration(statements, name, tree) {
  const fn = statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (fn) return fn.getText(tree).replace(/^export /u, "");
  const node = statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations]).find(item => item.name.getText(tree) === name);
  assert.ok(node, name); return `const ${node.getText(tree)};`;
}
const uiCode = [declaration(uiAst.statements, "canonicalCoverValue", uiAst), declaration(uiAst.statements, "isSavedCoverTask", uiAst),
  ...["nativeSelected", "editableSelected", "canApplyAutomaticLayout", "generatedOverlayLayout", "outputSpec", "plan", "dirty", "applyAutomaticLayout", "changeTitleStyle"].map(name => declaration(hook.body.statements, name, uiAst))].join("\n")
  + "\nresult={canApplyAutomaticLayout,generatedOverlayLayout,plan,dirty,applyAutomaticLayout,changeTitleStyle};";
const compiledUi = ts.transpileModule(uiCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function editor(overrides = {}) {
  const legacy = plain(planFor()); delete legacy.generatedOverlayLayout; legacy.titleStyle = { x: .08, y: .07, width: .84, scale: 1, color: "#FFFFFF", colorMode: "single" };
  const state = { selected: { id: "saved-one", imageOrigin: "generated", status: "done", cloudStored: true, assetId: "asset", historyRecordId: "history", backgroundAssetId: "raw", renderPlan: legacy },
    title: legacy.title, titleStyle: legacy.titleStyle, ratio: "4:3", styleKey: "custom-composition", materials: [], automaticLayoutTaskId: "", originalOrderDisplay: null, originalLayout: false,
    busy: null, uncertain: false, ...overrides };
  const refs = { requestGate: { current: false }, titleStyleTouched: { current: false }, editorRevision: { current: 0 } };
  function render() {
    const context = { ...state, ...refs, coverTextRendering: pure.coverTextRendering, coverGeneratedOverlayPolicy: pure.coverGeneratedOverlayPolicy,
      coverGeneratedOverlayTitleStyle: pure.coverGeneratedOverlayTitleStyle, coverOutputSizes: pure.COVER_OUTPUT_SPECS,
      setAutomaticLayoutTaskId: value => state.automaticLayoutTaskId = value, setTitleStyle: value => state.titleStyle = typeof value === "function" ? value(state.titleStyle) : value,
      setError: value => state.error = value, setNotice: value => state.notice = value, fetch: forbidden, result: null };
    vm.runInNewContext(compiledUi, context); return context.result;
  }
  return { state, refs, render };
}
const e = editor(), originalSaved = JSON.stringify(e.state.selected);
assert.equal(e.render().dirty, false); e.render().applyAutomaticLayout();
const projected = e.render(); assert.equal(projected.dirty, true); assert.deepEqual(plain(projected.plan.generatedOverlayLayout), plain(plan.generatedOverlayLayout));
assert.equal(JSON.stringify(e.state.selected), originalSaved); assert.equal(e.refs.editorRevision.current, 1);
projected.changeTitleStyle({ x: .7, scale: .7, color: "#FFFFFF" }); assert.deepEqual(plain(e.state.titleStyle), plain(pure.coverGeneratedOverlayTitleStyle()));
for (const change of [task => task.imageOrigin = "original", task => task.renderPlan.originalLayout = {}, task => task.renderPlan.textRendering.mode = "native",
  task => delete task.backgroundAssetId, task => task.renderPlan.materialSourceId = "text", task => task.status = "running"]) {
  const task = plain(e.state.selected); change(task); const denied = editor({ selected: task }); denied.render().applyAutomaticLayout(); assert.equal(denied.state.automaticLayoutTaskId, "");
}
const tooMany = editor({ title: "第一行\n第二行\n第三行" }); tooMany.render().applyAutomaticLayout(); assert.equal(tooMany.state.automaticLayoutTaskId, ""); assert.match(tooMany.state.error, /两行/u);
checks.push("real editor action creates only a dirty new plan with no automatic save/provider; native/original/nonmaterial/incomplete sources are gated and hidden manual style changes cannot silently alter safe geometry");

const generationClient = load("src/lib/cover-generation-attempt.ts", {
  "@/lib/image-workbench-attempt-guard": { isConfirmedTerminalImageFailure: forbidden }, "@/lib/cover-composition": pure,
  "@/lib/image-resolution-pricing": { parsePublicImageResolutionPrices: forbidden },
  "@/lib/generated-image-client-delivery": load("src/lib/generated-image-client-delivery.ts", {
    "@/lib/generated-image-reference": load("src/lib/generated-image-reference.ts", { zod: { z } }),
  }), "@/lib/cover-durable-attempt": durable,
});
const values = new Map(), memory = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const editTask = { ...e.state.selected, ratio: "4:3", title: plan.title, subtitle: "", source: "生成", prompt: "frozen real artwork prompt",
  briefText: "商品图文", createdAt: "2026-11-06T00:00:00.000Z", taskNo: 1 };
let edits = 0, submittedEdit;
const fetchEdit = async (url, options) => {
  assert.equal(url, "/api/cover/render"); assert.equal(options.method, "POST"); edits++;
  submittedEdit = JSON.parse(options.body); assert.equal(submittedEdit.sourceAssetId, "raw");
  return Response.json({ ...receipt, sourceAssetId: "raw", persisted: true, cloudStored: true, assetId: "edited-asset", historyRecordId: "edited-history",
    key: "fixture/edited.png", url: "/api/storage/files/edited-asset/content", createdAt: "2026-11-06T01:00:00.000Z", taskNo: 2 });
};
const editBefore = JSON.stringify(editTask), savedEdit = await generationClient.saveCoverCompositionEdit({ userId: owner, token: "fixture-only", task: editTask,
  plan, storage: memory, fetcher: fetchEdit, onState: () => {} });
assert.equal(edits, 1); assert.deepEqual(plain(submittedEdit.plan), plain(plan)); assert.equal(JSON.stringify(editTask), editBefore);
assert.equal(savedEdit.history[0].id, "cover-render-edited-asset"); assert.equal(savedEdit.history[0].backgroundAssetId, "raw");
assert.deepEqual(plain(savedEdit.history[0].renderPlan), plain(plan));
await assert.rejects(() => generationClient.saveCoverCompositionEdit({ userId: owner, token: "fixture-only", task: editTask, plan, storage: memory,
  fetcher: async () => Response.json({ ...receipt, generatedOverlayLayout: undefined, sourceAssetId: "raw", persisted: true, cloudStored: true,
    assetId: "stripped", key: "fixture", url: "/owned", historyRecordId: "stripped" }), onState: forbidden }), /文字保存尚未确认/u);
checks.push("real saveCompositionEdit sends one free render with the new plan, retains the original task and background, returns a distinct saved version and rejects a stripped-policy receipt");

// Optional local intake golden: compare actual pre-change renderer, including
// original policy extraction, with the same source/font and the same old plan.
if (existsSync(path.join(root, intake, "src/lib/cover-composition-server.ts"))) {
  const beforeRenderer = load(`${intake}/src/lib/cover-composition-server.ts`, rendererImports);
  const noPolicy = plain(planFor()); delete noPolicy.generatedOverlayLayout; noPolicy.titleStyle = { x: .08, y: .07, width: .84, scale: 1, color: "#FFFFFF", colorMode: "single" };
  const original = { ...noPolicy, originalLayout: { version: pure.COVER_ORIGINAL_LAYOUT_VERSION, sourceWidth: 1536, sourceHeight: 2048, structure: "single", focus: "action" } };
  const native = { ...noPolicy, textRendering: { mode: "native", version: pure.COVER_TEXT_RENDERING_VERSION } };
  for (const [name, oldPlan] of [["legacy-overlay", noPolicy], ["original-safe", original], ["native", native]]) {
    const actual = await renderer.renderCoverComposition(portrait, oldPlan), expected = await beforeRenderer.renderCoverComposition(portrait, oldPlan);
    assert.equal(hash(actual.bytes), hash(expected.bytes), `${name} output must remain byte-for-byte identical`);
    golden.push({ name, sha256: hash(actual.bytes) });
  }
  const oldMaterial = load(`${intake}/src/lib/cover-material-composition.ts`, { zod: { z } });
  const currentMaterial = load("src/lib/cover-material-composition.ts", { zod: { z } });
  const bindings = currentMaterial.resolveCoverMaterialBindings({ imageMode: "compose", text: "@图1 展示商品。", assets: [{ assetId: sourceId, role: "identity_subject", imageNumber: 1 }] });
  assert.equal(currentMaterial.compileCoverMaterialCompositionPrompt(bindings), oldMaterial.compileCoverMaterialCompositionPrompt(bindings));
  checks.push("intake golden: legacy overlay, strict original-safe and native PNG hashes are byte-identical; default material composition prompt preserves every old byte including packaging exception");
}
assert.equal(forbiddenCalls, 0); assert.equal(getExternalCalls(), 0);
const report = { passed: true, groups: checks.length, pixelCases: cases.length, networkCalls: 0, providerCalls: 0, realDatabaseWrites: 0, walletCalls: 0,
  actualModelPhotoVerified: Boolean(actualModel), actualOwnedProductBackgroundVerified: Boolean(actualProduct), boundary: "Actual source compiler/routes/bindings/editor/Pango; owner/auth/storage/DB/persistence ports are isolated fixtures. No browser/provider/billing/visual acceptance is claimed. Actual product-background output is an offline prototype only.", checks, cases, golden };
if (process.env.COVER_GENERATED_LAYOUT_EVIDENCE_DIR) {
  const directory = path.resolve(process.env.COVER_GENERATED_LAYOUT_EVIDENCE_DIR); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  if (actualModel) writeFileSync(path.join(directory, "model-generated-safe-frame.png"), actualModel.bytes);
  if (actualProduct) writeFileSync(path.join(directory, "product-two-safe-frame-offline-prototype.png"), actualProduct.bytes);
}
console.log(JSON.stringify({ ...report, cases: undefined }, null, 2));
