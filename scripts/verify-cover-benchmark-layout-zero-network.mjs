import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import vm from "node:vm";
import ts from "typescript";

let networkCalls = 0;
const forbidden = () => { networkCalls += 1; throw new Error("NETWORK_DATABASE_PROVIDER_FORBIDDEN"); };
const files = ["src/lib/cover-composition.ts", "src/lib/cover-benchmark-profiles.ts", "src/lib/cover-benchmark-layout.ts"];
const sourceHashes = Object.fromEntries(files.map(file => [file, createHash("sha256").update(readFileSync(file)).digest("hex")]));
function load(file, imports = {}) {
  const source = readFileSync(file, "utf8"), module = { exports: {} };
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  assert.equal(ast.parseDiagnostics.length, 0);
  const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  vm.runInNewContext(compiled.outputText, { module, exports: module.exports, console, fetch: forbidden,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unapproved runtime dependency ${id}`); return imports[id]; } }, { filename: file });
  return module.exports;
}
const composition = load(files[0]), metadata = load("src/lib/cover-style-catalog.ts", { zod: { z } }), profiles = load(files[1], { "./cover-style-catalog": metadata });
const { resolveBenchmarkCoverLayout: resolve } = load(files[2], { "./cover-composition": composition, "./cover-benchmark-profiles": profiles });
const checks = [];
const analysis = { primaryTitle: "先行动\n再调整", visualBrief: { subject: "年轻人", action: "在桌前开始做事", scene: "日常工作环境", emotion: "从犹豫到行动" } };
const structures = ["single", "relationship", "comparison", "list"], focuses = ["expression", "action", "object"];
const geometries = plan => JSON.stringify({ title: plan.titleZone, subject: plan.subjectZone });
function validRegion(region) {
  assert.deepEqual(Object.keys(region).sort(), ["height", "width", "x", "y"]);
  for (const value of Object.values(region)) assert.ok(Number.isFinite(value));
  assert.ok(region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0);
  assert.ok(region.x + region.width <= 1 + 1e-12 && region.y + region.height <= 1 + 1e-12);
}
function overlap(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
}
let matrixCases = 0;
const results = new Map();
for (const styleKey of ["cartoon", "funny-cartoon"]) for (const ratio of Object.keys(composition.COVER_OUTPUT_SPECS)) {
  for (const structure of structures) for (const focus of focuses) {
    const input = { analysis: { ...analysis, layoutIntent: { structure, focus, evidenceRefs: ["e1"] } }, styleKey, ratio };
    const before = JSON.stringify(input), plan = resolve(input);
    assert.equal(JSON.stringify(input), before); assert.equal(JSON.stringify(resolve(input)), JSON.stringify(plan));
    assert.equal(plan.source, "semantic_intent"); assert.match(plan.templateId, /^gaoding-[a-z0-9-]{1,48}$/u);
    assert.ok(plan.displayName.trim() && plan.reason.includes("依据已验证"));
    assert.equal(plan.outputSpec.aspectRatio, ratio); assert.equal(plan.outputSpec.format, "png");
    assert.equal(plan.outputSpec.width, composition.COVER_OUTPUT_SPECS[ratio].width);
    assert.equal(plan.outputSpec.height, composition.COVER_OUTPUT_SPECS[ratio].height);
    validRegion(plan.titleZone); validRegion(plan.subjectZone); assert.equal(overlap(plan.titleZone, plan.subjectZone), 0);
    const title = plan.titleStyle;
    assert.ok(title.x >= .02 && title.x <= .7 && title.y >= .02 && title.y <= .5 && title.width >= .2 && title.x + title.width <= .98 + 1e-12);
    assert.ok(title.scale >= .7 && title.scale <= 1.3); assert.equal(title.colorMode, "palette");
    assert.equal(title.x, plan.titleZone.x); assert.equal(title.y, plan.titleZone.y); assert.equal(title.width, plan.titleZone.width);
    assert.ok(plan.subjectZone.width * plan.subjectZone.height > .3, "main subject must have a substantial composition region");
    assert.ok(plan.sceneDirectives.some(line => line.includes(JSON.stringify(plan.titleZone))));
    assert.ok(plan.sceneDirectives.some(line => line.includes(JSON.stringify(plan.subjectZone))));
    assert.ok(plan.sceneDirectives.some(line => line.includes("不能仅凭归一化区域宣称像素级避让已验收")));
    assert.equal(plan.researchSources.length, 0, "public layout plans do not expose private research provenance");
    results.set(`${styleKey}/${ratio}/${structure}/${focus}`, plan); matrixCases += 1;
  }
}
checks.push("96 semantic structure/focus/style/ratio cases are deterministic, bounded, non-overlapping and use the four shared fixed outputs");
for (const ratio of Object.keys(composition.COVER_OUTPUT_SPECS)) for (const structure of structures) for (const focus of focuses) {
  assert.notEqual(geometries(results.get(`cartoon/${ratio}/${structure}/${focus}`)), geometries(results.get(`funny-cartoon/${ratio}/${structure}/${focus}`)));
}
checks.push("warm and funny families differ in actual title/subject geometry across every semantic case");
for (const styleKey of ["cartoon", "funny-cartoon"]) for (const ratio of Object.keys(composition.COVER_OUTPUT_SPECS)) {
  assert.equal(new Set(structures.map(structure => geometries(results.get(`${styleKey}/${ratio}/${structure}/action`)))).size, 4);
  assert.equal(new Set(focuses.map(focus => geometries(results.get(`${styleKey}/${ratio}/single/${focus}`)))).size, 3);
}
checks.push("changing semantic structure or single-subject focus changes geometry rather than only a template name");
for (const styleKey of ["cartoon", "funny-cartoon"]) {
  assert.notEqual(geometries(results.get(`${styleKey}/3:4/single/action`)), geometries(results.get(`${styleKey}/9:16/single/action`)));
  assert.notEqual(geometries(results.get(`${styleKey}/16:9/single/action`)), geometries(results.get(`${styleKey}/4:3/single/action`)));
}
checks.push("each of the four aspect ratios receives explicit geometry adaptation");
let legacyCases = 0;
for (const styleKey of ["cartoon", "funny-cartoon"]) for (const ratio of Object.keys(composition.COVER_OUTPUT_SPECS)) {
  const oldAnalysis = { ...analysis, primaryTitle: "3个动作\n两个人的关系" };
  const before = JSON.stringify(oldAnalysis), plan = resolve({ analysis: oldAnalysis, styleKey, ratio });
  assert.equal(plan.source, "legacy_default"); assert.ok(plan.reason.includes("不从标题关键词猜清单或关系"));
  assert.equal(geometries(plan), geometries(results.get(`${styleKey}/${ratio}/single/action`)));
  assert.equal(JSON.stringify(oldAnalysis), before); assert.equal(Object.hasOwn(oldAnalysis, "layoutIntent"), false); legacyCases += 1;
}
checks.push("eight legacy cases remain explicit single/action defaults; numbers and relationship words cannot fake semantic analysis");
for (const patch of [
  { styleKey: "reference-adaptive" }, { styleKey: "custom-composition" }, { ratio: "1:1" },
  { analysis: { ...analysis, primaryTitle: "" } },
  { analysis: { ...analysis, layoutIntent: { structure: "unknown", focus: "action", evidenceRefs: ["e1"] } } },
  { analysis: { ...analysis, layoutIntent: { structure: "list", focus: "action", evidenceRefs: [] } } },
]) assert.throws(() => resolve({ analysis, styleKey: "cartoon", ratio: "3:4", ...patch }), error => /^COVER_BENCHMARK_LAYOUT_/u.test(error.code));
checks.push("reference/custom routes, unsupported ratios and malformed semantic intent fail instead of silently adopting benchmark style");
assert.equal(networkCalls, 0);
console.log(JSON.stringify({ passed: true, checks: checks.length, semanticMatrixCases: matrixCases, legacyCases,
  networkCalls, liveDatabaseCalls: 0, providerCalls: 0, sourceHashes,
  limitation: "Pure layout geometry and prompt directives only; no generated image, actual face detection, pixel glyph exclusion or visual-author similarity is asserted", cases: checks }, null, 2));
