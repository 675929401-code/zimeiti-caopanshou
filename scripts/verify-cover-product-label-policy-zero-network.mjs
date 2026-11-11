#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.join(root, ".codex-evidence/cover-rebuild-20261106-bc1a/product-label-policy");
const prepareTestPath = "scripts/verify-cover-prepare-zero-network.mjs";
const prepareTestSource = readFileSync(path.join(root, prepareTestPath), "utf8");
const prepareAst = ts.createSourceFile(prepareTestPath, prepareTestSource, ts.ScriptTarget.Latest, true);
const originalHarness = prepareAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "harness");
assert.ok(originalHarness?.body);
// Reuse the current regression's REAL module loader/routes and I/O fixtures.
// Only expose two existing local test ports; no production code or assertion
// is rewritten and none of the original 31 groups executes in this suite.
const statements = [...originalHarness.body.statements];
const last = statements.at(-1);
assert.ok(ts.isReturnStatement(last) && last.expression && ts.isObjectLiteralExpression(last.expression));
statements[statements.length - 1] = ts.factory.updateReturnStatement(last, ts.factory.updateObjectLiteralExpression(last.expression,
  [...last.expression.properties, ts.factory.createShorthandPropertyAssignment("load"), ts.factory.createShorthandPropertyAssignment("confirmRoute")]));
const harness = ts.factory.updateFunctionDeclaration(originalHarness, originalHarness.modifiers, originalHarness.asteriskToken,
  originalHarness.name, originalHarness.typeParameters, originalHarness.parameters, originalHarness.type,
  ts.factory.updateBlock(originalHarness.body, statements));
const printer = ts.createPrinter();
const declarations = ["ownerA", "ownerB", "referenceId", "sha", "clone", "fields"].map(name => {
  const node = prepareAst.statements.filter(ts.isVariableStatement).flatMap(item => [...item.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === name);
  assert.ok(node); return `const ${node.getText(prepareAst)};`;
});
const harnessCode = `${declarations.join("\n")}\n${printer.printNode(ts.EmitHint.Unspecified, harness, prepareAst)}\nmodule.exports.make=harness;`;
const harnessCompiled = ts.transpileModule(harnessCode, { fileName: "actual-prepare-harness.ts", compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
const files = ["src/lib/cover-workbench-prompts.ts", "src/lib/cover-material-composition.ts"];
const before = Object.fromEntries(files.map(file => [path.resolve(root, file), readFileSync(path.join(evidence, "before", file), "utf8")]));
const checks = [], nativeGolden = [];
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error("Real network/provider I/O forbidden"); };
const plain = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
class NextRequest extends Request { get nextUrl() { return new URL(this.url); } }
function make(previous = false) {
  const module = { exports: {} };
  const read = (file, ...options) => previous && Object.hasOwn(before, path.resolve(String(file))) ? before[path.resolve(String(file))] : readFileSync(file, ...options);
  // Execute the test harness in the host realm, just like its original .mjs;
  // production modules still use its exact strict VM loader. This preserves
  // native assert/diagnostics array prototypes rather than weakening asserts.
  const ports = { module, exports: module.exports, root, assert, createHash, randomUUID,
    readFileSync: read, path, vm, sharp, ts, z, NextRequest, Request, Response, Buffer, URL, URLSearchParams, AbortSignal,
    Error, structuredClone, console, fetch: forbidden };
  const install = new Function(...Object.keys(ports), harnessCompiled.outputText);
  install(...Object.values(ports));
  return module.exports.make();
}
const current = make(), previous = make(true);
const prompts = current.load("src/lib/cover-workbench-prompts.ts"), oldPrompts = previous.load("src/lib/cover-workbench-prompts.ts");
const material = current.load("src/lib/cover-material-composition.ts"), oldMaterial = previous.load("src/lib/cover-material-composition.ts");
const contract = current.load("src/lib/cover-workbench-contract.ts");
const oldContract = previous.load("src/lib/cover-workbench-contract.ts");
assert.equal(prompts.COVER_BACKGROUND_PROMPT_VERSION, "cover-background/2.4.0");
assert.equal(material.COVER_CUSTOM_COMPOSITION_STYLE_PROFILE.version, "1.1.0");
assert.equal(material.COVER_CUSTOM_COMPOSITION_STYLE_PROFILE.typography.maxLines, 2);
assert.equal(prompts.COVER_NATIVE_PROMPT_VERSION, oldPrompts.COVER_NATIVE_PROMPT_VERSION);
assert.equal(prompts.COVER_ANALYSIS_PROMPT_VERSION, oldPrompts.COVER_ANALYSIS_PROMPT_VERSION);
function functionSource(source, name) {
  const ast = ts.createSourceFile("prompt.ts", source, ts.ScriptTarget.Latest, true);
  return ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)?.getText(ast);
}
for (const name of ["compileCoverNativePrompt", "coverNativeTitleLines"]) {
  assert.equal(functionSource(readFileSync(path.join(root, files[0]), "utf8"), name), functionSource(before[path.resolve(root, files[0])], name), `${name} must remain unchanged`);
}
assert.ok(functionSource(readFileSync(path.join(root, files[0]), "utf8"), "compileCoverAnalysisMessages").includes("assetBindings: materials.assets.map(asset => ({ assetId: asset.assetId, role: asset.role,"));
// The separately versioned compose-only explicit-constraint branch is an
// authorized later change. Compare COMPLETE actual outputs for every unaffected
// family instead of freezing the whole analysis function's source text.
const unchangedAnalysis = [
  ...["cartoon", "funny-cartoon"].flatMap(styleKey => ["3:4", "16:9", "4:3", "9:16"].map(outputRatio =>
    ({ ...current.materials("unchanged_animation_analysis"), styleKey, outputRatio }))),
  ...[undefined, "preserve"].flatMap(imageMode => ["identity_subject", "background_canvas", "style_reference"].map(role =>
    ({ ...current.materials("unchanged_preserved_analysis"), ...(imageMode ? { imageMode } : {}), assets: [{ assetId: "00000000-0000-4000-8000-000000000003", role }] }))),
  { ...current.materials("unchanged_description_analysis"), contentKind: "product" },
];
for (const input of unchangedAnalysis) {
  assert.equal(JSON.stringify(prompts.compileCoverAnalysisMessages(input)), JSON.stringify(oldPrompts.compileCoverAnalysisMessages(input)), "Unaffected analysis messages must preserve every old byte");
  assert.equal(Object.hasOwn(prompts.coverAnalysisDependencySnapshot(input), "materialExplicitConstraintsVersion"), false, "Unaffected dependencies must not acquire the optional material marker");
}
const composeAnalysis = { ...current.materials("compose_explicit_rules"), imageMode: "compose", assets: [{ assetId: "00000000-0000-4000-8000-000000000003", imageNumber: 1, role: "style_reference" }] };
const changedMessages = prompts.compileCoverAnalysisMessages(composeAnalysis);
assert.equal(JSON.parse(changedMessages[1].content).materialExplicitConstraintsVersion, material.COVER_MATERIAL_EXPLICIT_CONSTRAINTS_VERSION);
assert.ok(changedMessages[0].content.includes("fields覆盖visualBrief.scene及visualBrief.action"));
assert.ok(changedMessages[0].content.includes("primaryTitle必须实际换行表达"));
checks.push("15 noncompose animation/preserved/description analysis outputs are byte-identical to intake without a material dependency marker; compose explicit constraints are separately versioned; native/title-line function bytes and fixed asset serialization remain unchanged");

const ids = ["00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
const numbers = [9, 2, 5];
const phrases = ["@图9 是模特，请保留人物外观。", "@图2 是牙膏，请保留商品包装外观。", "@图5 是参考封面，只借鉴构图与色彩。"];
const text = `${phrases.join("")}请保留牙膏原图已清晰可读的120g/样品A07，不补写看不清的字。模特展示牙膏。`;
const policy = prompt => prompt.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } })
  .find(value => value?.schemaVersion === "cover-product-label-policy/1");
const compositeData = prompt => prompt.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } })
  .find(value => value?.schemaVersion === "cover-material-composition/1");
const bindingData = prompt => prompt.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } })
  .find(value => value?.schemaVersion === "cover-material-bindings/1");
function configure(h, useExplicitAnalysisRoles) {
  h.assetFixtures[0].storage_key = "fixture/model.png";
  h.assetFixtures.push({ ...h.assetFixtures[0], id: ids[1], storage_key: "fixture/toothpaste.png" },
    { ...h.assetFixtures[0], id: ids[2], storage_key: "fixture/reference.png" });
  h.state.usageFixture = { referenceAssetId: ids[2],
    usage: ids.map((assetId, index) => ({ assetId, imageNumber: numbers[index], role: useExplicitAnalysisRoles && index < 2 ? "identity_subject" : "style_reference",
      source: useExplicitAnalysisRoles ? "explicit_user" : "ui_role", evidenceRefs: useExplicitAnalysisRoles ? [`u${index + 1}`] : [] })),
    evidence: useExplicitAnalysisRoles ? phrases.map((quote, index) => ({ id: `u${index + 1}`, source: "text", quote, fields: ["visualBrief.subject"] })) : [] };
  return { ...h.materials("product_label_roles"), text, imageMode: "compose", assets: ids.map((assetId, index) => ({ assetId, imageNumber: numbers[index], role: "style_reference" })) };
}
function assertAllowed(prompt, expectedIds) {
  const rule = policy(prompt); assert.ok(rule);
  assert.deepEqual(Array.from(rule.candidateIdentityImages, image => image.assetId), expectedIds);
  assert.equal(rule.requiresActualProductSurface, true); assert.equal(rule.requiresClearlyReadableOriginalText, true);
  assert.equal(rule.mayInventCharacters, false); assert.equal(rule.requiresVisualVerification, true);
  assert.deepEqual(Array.from(compositeData(prompt).productLabelCandidates, image => image.assetId), expectedIds);
  assert.ok(prompt.includes("same product surface")); assert.ok(prompt.includes("人物、动物并不自动成为商品"));
  for (const phrase of ["clothing text", "watermarks", "reference-cover titles/Logos/prices", "unreadable characters", "not verified facts", "not a preserved pixel layer"]) assert.ok(prompt.includes(phrase));
  assert.equal(prompt.includes("Do not draw title text, subtitles, letters, numbers"), false, "An unconditional all-letter ban must not contradict the narrow packaging exception");
  assert.equal(prompt.includes("生成一张无字封面底图"), false); assert.equal(prompt.includes("already present in a preserved original asset"), false);
  assert.ok(prompt.includes("成品包装字仍须实际看图核对"));
}
async function guardedLinks(h, child) {
  const signedKeys = [], imports = {
    "@/storage/object": { storageManager: { getSignedUrl: async key => { signedKeys.push(key); return `https://fixture.invalid/${encodeURIComponent(key)}`; } } },
    "./cover-prepare-repository": h.repo, "./cover-prepare-service": h.service,
    "@/lib/cover-material-composition": h.load("src/lib/cover-material-composition.ts"),
    "./cover-review-projection": h.load("src/lib/server/cover-review-projection.ts"),
  };
  const module = { exports: {} }, source = readFileSync(path.join(root, "src/lib/server/cover-prepared-generation.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Error, require: name => { assert.ok(Object.hasOwn(imports, name)); return imports[name]; }, fetch: forbidden },
    { filename: "actual-cover-prepared-generation.ts" });
  const links = await module.exports.validatePreparedCoverGeneration({ userId: child.user_id, task: child.result.task,
    generationInput: child.result.generationInput, ...child.result.generationIdentity, requestUrl: "https://fixture.invalid/api/cover/attempt", resolveReferences: true });
  assert.deepEqual(signedKeys, ["fixture/model.png", "fixture/toothpaste.png", "fixture/reference.png"]);
  assert.deepEqual(Array.from(links), signedKeys.map(key => `https://fixture.invalid/${encodeURIComponent(key)}`));
}

let exampleAnalysis;
{
  const h = make(), input = configure(h, true);
  assert.equal(material.coverProductLabelCandidates(material.resolveCoverMaterialBindings(input)).length, 0, "Initial UI style roles alone do not authorize packaging text");
  const prepared = await h.post({ action: "prepare", materials: input }); assert.equal(prepared.status, 200);
  assert.equal(prepared.snapshot.style.version, "1.1.0");
  const done = await h.analyzeAndConfirm({ action: "analyze", operationId: prepared.body.operationId, consent: { analysis: true, image: true } });
  assert.equal(done.status, 200); assert.equal(h.state.gatewayCalls, 1);
  const parent = h.state.parents.find(row => row.id === prepared.body.operationId), child = h.confirmationFor(parent.id);
  exampleAnalysis = plain(parent.result.analysis);
  assert.deepEqual(parent.materials.assets.map(asset => asset.role), ["style_reference", "style_reference", "style_reference"]);
  assert.deepEqual(child.materials.assets.map(asset => asset.role), ["identity_subject", "identity_subject", "style_reference"]);
  assert.equal(parent.billing.credits_charged, 2); assert.equal(child.billing.credits_charged, 0);
  assert.equal(parent.preparation.promptDependencies.materialExplicitConstraintsVersion, material.COVER_MATERIAL_EXPLICIT_CONSTRAINTS_VERSION);
  assert.equal(child.result.generationPromptVersion, `cover-background/2.4.0+visual-binding-v1+cover-generated-overlay-safe-frame/1+${material.COVER_MATERIAL_EXPLICIT_CONSTRAINTS_VERSION}`); assert.equal(child.result.generationInput.coverText, "");
  assertAllowed(child.result.generationInput.prompt, ids.slice(0, 2));
  const bindings = bindingData(child.result.generationInput.prompt);
  assert.deepEqual(Array.from(bindings.images, image => [image.inputIndex, image.imageNumber, image.assetId]), [[1, 9, ids[0]], [2, 2, ids[1]], [3, 5, ids[2]]]);
  await guardedLinks(h, child);
  checks.push("actual prepare/analyze/confirm resolves explicit analysis roles before packaging policy; original UI roles/bill remain immutable and all three owned image inputs retain 9/2/5 numbering and original order");
  assert.deepEqual(plain(child.result.renderPlan.generatedOverlayLayout), plain(parent.preparation.generatedOverlayLayout));
  assert.ok(child.result.generationInput.prompt.includes("do not reserve an additional title zone"));
  assert.ok(child.result.generationInput.prompt.includes("底图自然铺满完整主体与环境，不再预留同一标题带"));
  assert.equal(child.result.generationInput.prompt.includes("为后续应用排字保留连续自然的低细节区域"), false);
  assertAllowed(child.result.generationInput.prompt, ids.slice(0, 2));
  checks.push("frozen safe-frame composition avoids a duplicate raw title band while retaining the exact bound readable product-surface packaging exception; reference cover titles and invented text remain forbidden");
}
{
  const h = make(), input = configure(h, false);
  const prepared = await h.post({ action: "prepare", materials: input });
  const analyzed = await h.post({ action: "analyze", operationId: prepared.body.operationId, consent: { analysis: true } });
  assert.equal(analyzed.body.status, "review_ready");
  const edits = { materialUsage: [2, 0, 1].map(index => ({ assetId: ids[index], imageNumber: numbers[index], role: index < 2 ? "identity_subject" : "style_reference" })) };
  const raw = { operationId: prepared.body.operationId, clientRequestId: "manual_label_confirmation", expectedAnalysisHash: analyzed.body.analysisHash,
    expectedImageQuoteHash: analyzed.body.quote.imageQuoteHash, edits, consent: { image: true } };
  const confirmed = await h.confirmRoute.POST(new NextRequest("https://fixture.invalid/api/cover-workbench/confirm", { method: "POST",
    headers: { authorization: "Bearer fixture-only", "content-type": "application/json" }, body: JSON.stringify(raw) }));
  assert.equal(confirmed.status, 200, JSON.stringify(await confirmed.clone().json()));
  const child = h.confirmationFor(prepared.body.operationId);
  assertAllowed(child.result.generationInput.prompt, ids.slice(0, 2));
  assert.deepEqual(child.materials.assets.map(asset => asset.assetId), ids, "Edits array order must not reorder actual images");
  assert.equal(h.state.parents[0].result.analysis.materialUsage.every(item => item.role === "style_reference"), true);
  assert.equal(h.state.gatewayCalls, 1); assert.equal(child.billing.credits_charged, 0);
  await guardedLinks(h, child);
  checks.push("actual manual confirmation roles drive policy after reviewedAnalysis clears original usage; edited role-list order cannot reorder model/product/reference image inputs or trigger a second analysis");
}
{
  const input = contract.parseCoverPrepareInput({ clientRequestId: "plain_product_labels", contentKind: "product", text: "这款水杯容量500毫升，适合日常通勤。", assets: [] });
  const prompt = prompts.compileCoverBackgroundPrompt({ analysis: exampleAnalysis, materials: input, style: material.COVER_CUSTOM_COMPOSITION_STYLE_PROFILE,
    generationSpec: { modelId: "pm_fixture_image", resolution: "2K", aspectRatio: "3:4", outputRatio: "3:4", ratioEvidence: "declared_native" }, outputSpec: contract.coverOutputSpec("3:4") });
  assert.equal(policy(prompt), undefined); assert.ok(prompt.includes("Do not draw title text, subtitles, letters, numbers"));
  assert.ok(prompt.includes("never claim an authentic SKU, invented packaging/brand/label"));
  const references = { ...input, imageMode: "compose", assets: [{ assetId: ids[2], imageNumber: 5, role: "style_reference" }] };
  const refPrompt = prompts.compileCoverBackgroundPrompt({ analysis: exampleAnalysis, materials: references, style: material.COVER_CUSTOM_COMPOSITION_STYLE_PROFILE,
    generationSpec: { modelId: "pm_fixture_image", resolution: "2K", aspectRatio: "3:4", outputRatio: "3:4", ratioEvidence: "declared_native" }, outputSpec: contract.coverOutputSpec("3:4") });
  assert.equal(policy(refPrompt), undefined); assert.deepEqual(Array.from(compositeData(refPrompt).productLabelCandidates), []);
  assert.ok(refPrompt.includes("Do not draw title text, subtitles, letters, numbers"));
  const preserved = material.resolveCoverMaterialBindings({ imageMode: "preserve", text: "保留原图", assets: [{ assetId: ids[1], role: "identity_subject" }] });
  assert.equal(material.coverProductLabelCandidates(preserved).length, 0);
  checks.push("description-only products, style-reference-only composites and preserved-image mode cannot enable packaging text or borrow supplied labels as new facts");
}
{
  const modelOnly = material.resolveCoverMaterialBindings({ imageMode: "compose", text: "@图9只用人物，不画商品。不要复制衣服上的A07。", assets: [{ assetId: ids[0], imageNumber: 9, role: "identity_subject" }] });
  const rule = material.compileCoverMaterialCompositionPrompt(modelOnly);
  assert.ok(rule.includes("人物、动物并不自动成为商品")); assert.ok(rule.includes("人物衣物文字"));
  assert.ok(rule.includes("图中不存在、模糊、遮挡或无法确认的包装字符不得按用户字串"));
  assert.ok(rule.includes("不是已核验事实")); assert.ok(rule.includes("不能宣称已经抠图、逐像素保留"));
  checks.push("identity_subject is only an eligibility candidate: person/animal images do not authorize clothing text, guessed packaging characters or unverified efficacy claims");
}
{
  const canonical = make(); const prepared = await canonical.post({ action: "prepare", materials: canonical.materials("native_unchanged_analysis") });
  await canonical.post({ action: "analyze", operationId: prepared.body.operationId, consent: { analysis: true } });
  const analysis = canonical.state.parents[0].result.analysis;
  for (const styleKey of ["cartoon", "funny-cartoon"]) for (const ratio of ["3:4", "16:9"]) for (const subtitle of [null, "今天就开始"]) {
    const materials = contract.parseCoverPrepareInput({ ...canonical.materials("native_unchanged_prompt"), styleKey, outputRatio: ratio });
    const scene = { ...plain(analysis), secondaryTitle: subtitle };
    const generationSpec = { modelId: "pm_fixture_image", resolution: "2K", aspectRatio: ratio, outputRatio: ratio, ratioEvidence: "declared_native" };
    const actual = prompts.compileCoverNativePrompt({ materials, analysis: scene, style: contract.resolveCoverStyle(styleKey), generationSpec, outputSpec: contract.coverOutputSpec(ratio) });
    const expected = oldPrompts.compileCoverNativePrompt({ materials, analysis: scene, style: oldContract.resolveCoverStyle(styleKey), generationSpec, outputSpec: oldContract.coverOutputSpec(ratio) });
    assert.equal(actual, expected); assert.equal(actual.includes("cover-product-label-policy/1"), false);
    nativeGolden.push({ styleKey, ratio, subtitle: Boolean(subtitle), sha256: hash(actual) });
  }
  assert.equal(oldMaterial.COVER_CUSTOM_COMPOSITION_STYLE_PROFILE.version, "1.0.0");
  checks.push("eight native animation prompts are byte-for-byte equal to the scoped before modules across two styles, two ratios and optional subtitles; no packaging exception enters native compilation");
}
assert.equal(readFileSync(path.join(root, prepareTestPath), "utf8"), prepareTestSource, "Existing 31-group regression was not modified");
assert.equal(forbiddenCalls, 0);
const report = { passed: true, groups: checks.length, nativeGoldenCount: nativeGolden.length, realNetworkCalls: 0, providerCalls: 0, realDatabaseCalls: 0,
  boundary: "Actual compiler and production prepare/analyze/confirm/guard with the current 31-group suite's in-memory I/O fixtures; no model was asked to read or reproduce packaging. Actual W6 label accuracy, imagery and billing remain browser/provider acceptance.", checks, nativeGolden };
if (process.env.COVER_PRODUCT_LABEL_EVIDENCE_DIR) {
  const directory = path.resolve(process.env.COVER_PRODUCT_LABEL_EVIDENCE_DIR); mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "focused-report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
