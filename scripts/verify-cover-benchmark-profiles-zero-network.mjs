import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";

const checks = [];
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls += 1; throw new Error("NETWORK_PROVIDER_OR_LIVE_DATABASE_FORBIDDEN"); };
function load(file, imports = {}) {
  const module = { exports: {} };
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(parsed.parseDiagnostics.length, 0, `${file} AST parse failed`);
  const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, Buffer, URL, Request, Response, console,
    fetch: forbidden, require(id) { assert.ok(Object.hasOwn(imports, id), `Unapproved runtime dependency ${id}`); return imports[id]; } }, { filename: file });
  return module.exports;
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const metadata = load("src/lib/cover-style-catalog.ts", { zod: { z } });
const profiles = load("src/lib/cover-benchmark-profiles.ts", { "./cover-style-catalog": metadata });
const packs = load("src/lib/cover-benchmark-prompt-packs.ts", { "server-only": {} });
const config = load("src/lib/server/cover-style-config.ts", { "server-only": {}, zod: { z }, "node:crypto": { createHash }, "../cover-style-catalog": metadata });
const privateDefaults = load("src/lib/server/cover-style-defaults.ts", { "server-only": {}, "../cover-style-catalog": metadata,
  "../cover-benchmark-prompt-packs": packs, "./cover-style-config": config });
const pure = load("src/lib/cover-composition.ts");
// The actual production style schema validates both data profiles. No copied
// schema in this verifier can silently accept a divergent field shape.
const contractImports = { zod: { z }, "./cover-composition": pure, "./cover-benchmark-profiles": profiles };
contractImports["./cover-material-composition"] = load("src/lib/cover-material-composition.ts", { zod: { z } });
contractImports["./cover-material-usage"] = load("src/lib/cover-material-usage.ts", { zod: { z }, "./cover-material-composition": contractImports["./cover-material-composition"] });
const contractSource = readFileSync("src/lib/cover-workbench-contract.ts", "utf8");
const numericEvidence = load("src/lib/cover-number-evidence.ts");
contractImports["./cover-number-evidence"] = numericEvidence;
if (contractSource.includes('"./cover-source-spans"')) contractImports["./cover-source-spans"] = load("src/lib/cover-source-spans.ts", { "./cover-number-evidence": numericEvidence });
const contract = load("src/lib/cover-workbench-contract.ts", contractImports);
for (const profile of profiles.COVER_BENCHMARK_STYLE_PROFILES) {
  const parsed = contract.CoverStyleDefinitionSchema.parse(profile);
  assert.equal(parsed.version, "3.0.0"); assert.ok(parsed.visualGrammar.length <= 20);
  assert.equal(parsed.visualGrammar.length, 0); assert.equal(parsed.researchSources.length, 0);
}
assert.deepEqual(Array.from(profiles.COVER_BENCHMARK_STYLE_PROFILES, profile => profile.key), ["cartoon", "funny-cartoon"]);
checks.push("both compatibility profiles satisfy the production schema and expose only neutral metadata");
for (const pack of Object.values(packs.COVER_BENCHMARK_PROMPT_PACKS)) { assert.ok(existsSync(pack.sourceEvidence.report)); assert.ok(existsSync(pack.sourceEvidence.matrix)); }
assert.equal(Object.values(packs.COVER_BENCHMARK_PROMPT_PACKS).reduce((sum, pack) => sum + pack.sourceEvidence.sampleCount, 0), 35);
for (const profile of privateDefaults.COVER_PRIVATE_LEGACY_STYLE_PROFILES) assert.ok(profile.visualGrammar.length >= 10);
checks.push("private server packs retain original 17 + 18 provenance paths and complete legacy grammar");
const dataAst = ts.createSourceFile("profiles.ts", readFileSync("src/lib/cover-benchmark-profiles.ts", "utf8"), ts.ScriptTarget.Latest, true);
assert.deepEqual(dataAst.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text), ["./cover-style-catalog"]);
assert.ok(privateDefaults.COVER_BENCHMARK_ANALYSIS_RULES.length > 0);
checks.push("public profiles import only public metadata while analysis rules stay server-only");

const annotations = load("src/lib/storyboard-annotation-layout.ts");
const renderer = load("src/lib/cover-composition-server.ts", {
  "node:fs": { existsSync }, sharp: { default: sharp }, "./cover-composition": pure, "./storyboard-annotation-layout": annotations,
});
assert.ok(renderer.coverCompositionFont("funny-cartoon"), "A local Chinese font is required");
const source = await sharp({ create: { width: 2048, height: 2048, channels: 3, background: "#13202a" } }).png().toBuffer();
const base = { title: "先做10分钟\n再调整方法\n行动有了进展", subtitle: "", aspectRatio: "3:4", layoutTemplateId: "gaoding-cover-workbench",
  animationStyleId: "pixar-3d", coverModeId: "funny-cartoon", materialSourceId: "text", subjectModeId: "semantic", planVersion: 2,
  outputSpec: { aspectRatio: "3:4", ...pure.COVER_OUTPUT_SPECS["3:4"], format: "png" },
  titleStyle: { x: .08, y: .07, width: .84, scale: 1 } };
const withStyle = patch => ({ ...base, titleStyle: { ...base.titleStyle, ...patch } });
const palettePlan = withStyle({ colorMode: "palette", color: "#00aa22" });
const singlePlan = withStyle({ colorMode: "single", color: "#00aa22" });
for (const plan of [base, palettePlan, singlePlan, withStyle({ color: "#00aa22" })]) assert.equal(pure.coverCompositionValidationError(plan), null);
for (const patch of [{ colorMode: "invalid" }, { colorMode: "single" }, { colorMode: "palette", color: "bad" }, { colorMode: "palette", extra: true }]) {
  assert.ok(pure.coverCompositionValidationError(withStyle(patch)));
}
checks.push("pure validation admits palette/single/legacy and rejects malformed modes or missing single color");
const palette = await renderer.renderCoverComposition(source, palettePlan);
const changedPicker = await renderer.renderCoverComposition(source, withStyle({ colorMode: "palette", color: "#ff0000" }));
const automaticLegacy = await renderer.renderCoverComposition(source, base);
assert.equal(digest(palette.bytes), digest(changedPicker.bytes));
assert.equal(digest(palette.bytes), digest(automaticLegacy.bytes));
const single = await renderer.renderCoverComposition(source, singlePlan);
const legacySingle = await renderer.renderCoverComposition(source, withStyle({ color: "#00aa22" }));
assert.equal(digest(single.bytes), digest(legacySingle.bytes));
assert.notEqual(digest(single.bytes), digest(palette.bytes));
checks.push("actual PNGs prove palette ignores picker residue and explicit single preserves byte-identical legacy output");
const photographicProduct = await renderer.renderCoverComposition(source, { ...singlePlan, animationStyleId: "photo-real", subjectModeId: "product" });
assert.equal(photographicProduct.compositionProfile, "reference-adaptive", "A description-only photographic product must not inherit story-cartoon decorations");
assert.equal(palette.compositionProfile, "funny-cartoon", "Restored benchmark typography stays separate from custom photography");
checks.push("photographic V2 product concepts select adaptive typography even without an uploaded image; animation benchmarks retain their own profile");
async function colorCounts(bytes, colors) {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = Object.fromEntries(colors.map(color => [color, 0]));
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const color = `#${data.subarray(offset, offset + 3).toString("hex")}`;
    if (Object.hasOwn(counts, color)) counts[color] += 1;
  }
  return counts;
}
const colors = ["#ffcf4a", "#ff779f", "#66e4ff", "#00aa22"];
const paletteCounts = await colorCounts(palette.bytes, colors), singleCounts = await colorCounts(single.bytes, colors);
for (const color of colors.slice(0, 3)) { assert.ok(paletteCounts[color] > 100, `missing real per-line glyph color ${color}`); assert.equal(singleCounts[color], 0); }
assert.equal(paletteCounts["#00aa22"], 0); assert.ok(singleCounts["#00aa22"] > 300);
assert.equal((await sharp(palette.bytes).metadata()).width, 1080); assert.equal((await sharp(palette.bytes).metadata()).height, 1440);
checks.push("decoded three-line glyph pixels contain yellow/pink/cyan in palette and only chosen green in single");
{
  const {data,info}=await sharp(palette.bytes).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const bands=colors.slice(0,3).map(color=>{
    const rgb=Buffer.from(color.slice(1),'hex');let top=info.height,bottom=-1;
    for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++){
      const offset=(y*info.width+x)*info.channels;
      if(data[offset]===rgb[0]&&data[offset+1]===rgb[1]&&data[offset+2]===rgb[2]){top=Math.min(top,y);bottom=Math.max(bottom,y);}
    }
    assert.ok(bottom>=top);return{top,bottom,height:bottom-top+1};
  });
  for(let index=1;index<bands.length;index++){
    const gap=bands[index].top-bands[index-1].bottom-1;
    assert.ok(gap>0&&gap<Math.max(bands[index].height,bands[index-1].height)*.65,
      'Width-fitted glyphs must form a compact readable title block, rather than retain an oversized empty line box');
  }
  checks.push("actual decoded multi-line glyph bands remain separated and compact after width fitting instead of inheriting oversized line-box gaps");
}

const receipt = plan => ({ outputKind: "cover-composition", sourceAssetId: "source", renderedText: { title: plan.title, subtitle: plan.subtitle },
  planVersion: 2, width: 1080, height: 1440, outputSpec: plan.outputSpec, titleStyle: plan.titleStyle });
assert.equal(pure.coverCompositionMatches(receipt(singlePlan), withStyle({ color: "#00AA22" }), "source"), true);
assert.equal(pure.coverCompositionMatches(receipt(palettePlan), withStyle({ colorMode: "palette", color: "#ff0000" }), "source"), true);
assert.equal(pure.coverCompositionMatches(receipt(base), withStyle({ colorMode: "palette" }), "source"), true);
assert.equal(pure.coverCompositionMatches(receipt(singlePlan), palettePlan, "source"), false);
assert.equal(pure.coverCompositionMatches(receipt(withStyle({ color: "#ff0000" })), singlePlan, "source"), false);
checks.push("receipt matching compares effective color semantics while distinguishing manual color and palette");

const userId = "00000000-0000-4000-8000-000000000001", assetId = "00000000-0000-4000-8000-000000000002";
const next = { NextRequest: Request, NextResponse: { json: (body, init) => Response.json(body, init) } };
const auth = { authorizeCurrentApiUser: async () => ({ ok: true, user: { userId } }) };
let persistCalls = 0;
const historyPlans = [];
const db = { from(table) {
  assert.equal(table, "user_files"); const filters = [];
  const query = { select: () => query, eq: (key, value) => { filters.push([key, value]); return query; }, order: () => query, limit: () => query,
    maybeSingle: async () => ({ error: null, data: filters.some(([key, value]) => key === "id" && value === assetId)
      ? { id: assetId, user_id: userId, storage_key: "fixture/source.png", storage_provider: "tencent_cos", file_category: "image", content_type: "image/png", file_size: source.length } : null }) };
  return query;
}, rpc: async (name, input) => {
  assert.equal(name, "record_cover_composition"); historyPlans.push(input.p_plan);
  return { data: { asset_id: "fixture-result", task_no: 1, created_at: "2026-11-06T00:00:00.000Z" }, error: null };
} };
const renderRoute = load("src/app/api/cover/render/route.ts", {
  "node:crypto": { createHash }, "next/server": next, zod: { z }, "@/lib/current-api-user": auth,
  "@/lib/auth": { getTokenFromHeaders: () => "fixture-only" }, "@/lib/cover-composition": pure, "@/lib/cover-composition-server": renderer,
  "@/storage/database/supabase-client": { getSupabaseClient: () => db }, "@/storage/object": { storageManager: { read: async () => source } },
  "@/app/api/image-workbench/persist/route": { POST: async req => {
    persistCalls += 1; const body = await req.json(); assert.equal(body.intent, "user_asset_export");
    const bytes = Buffer.from(body.url.split(",")[1], "base64"); assert.equal(digest(bytes), digest(palette.bytes));
    return Response.json({ success: true, persisted: true, status: "completed", assetId: "fixture-result", key: "fixture/result.png", url: "/fixture/result.png", historyRecordId: "fixture-history" });
  } },
});
const request = (route, plan) => { const body = JSON.stringify({ sourceAssetId: assetId, plan });
  return new Request(`https://fixture.invalid/api/cover/${route}`, { method: "POST", body, headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)) } }); };
const renderedResponse = await renderRoute.POST(request("render", palettePlan));
const renderedBody = await renderedResponse.json();
assert.equal(renderedResponse.status, 200); assert.equal(renderedBody.titleStyle.colorMode, "palette");
assert.equal(historyPlans[0].titleStyle.colorMode, "palette"); assert.equal(pure.coverCompositionMatches(renderedBody, palettePlan, assetId), true);
assert.equal((await renderRoute.POST(request("render", withStyle({ colorMode: "single" })))).status, 400);
assert.equal((await renderRoute.POST(request("render", withStyle({ colorMode: "unknown" })))).status, 400);
assert.equal(persistCalls, 1);
checks.push("actual render POST admits/persists palette mode and rejects invalid color modes before persistence");
const durable = load("src/lib/cover-durable-attempt.ts", { "@/lib/cover-composition": pure });
const bodyReader = load("src/lib/server/cover-request-body.ts");
const previewRoute = load("src/app/api/cover/preview/route.ts", {
  zod: { z }, "@/lib/current-api-user": auth, "@/lib/cover-composition": pure, "@/lib/cover-durable-attempt": durable,
  "@/lib/cover-composition-server": renderer, "@/storage/database/supabase-client": { getSupabaseClient: () => db },
  "@/storage/object": { storageManager: { readBounded: async () => source } }, "@/lib/server/cover-request-body": bodyReader,
});
const previewed = await previewRoute.POST(request("preview", palettePlan));
assert.equal(previewed.status, 200); assert.equal(digest(Buffer.from(await previewed.arrayBuffer())), digest(palette.bytes));
assert.equal((await previewRoute.POST(request("preview", withStyle({ colorMode: "single" })))).status, 422);
assert.equal(forbiddenCalls, 0);
checks.push("actual preview POST and actual durable projection preserve palette and render the same export glyph bytes");
console.log(JSON.stringify({ passed: true, checks: checks.length, networkCalls: forbiddenCalls, liveDatabaseCalls: 0, providerCalls: 0,
  evidence: "Actual TypeScript AST/modules, production style schema, Sharp pixels and actual render/preview route functions; auth/DB/storage/persist are in-memory fixtures", cases: checks }, null, 2));
