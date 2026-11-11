#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const file = new URL("../src/components/cover-workbench-client.ts", import.meta.url);
const source = readFileSync(file, "utf8");
const ast = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true);
const hook = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "useCoverWorkbench");
const outputDeclaration = hook.body.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations])
  .find(node => ts.isIdentifier(node.name) && node.name.text === "outputSpec");
assert.ok(outputDeclaration);
const previewDeclarations = ["requestedPreviewStamp", "currentRenderedPreviewUrl"].map(name => {
  const node = hook.body.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name);
  assert.ok(node); return `const ${node.getText(ast)};`;
}).join("\n");
const names = ["canonicalCoverValue", "inferCoverScenario", "assignCoverScenarioRoles", "ensureCoverImageNumbers"];
const actual = names.map(name => {
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, `Missing actual helper ${name}`);
  return found.getText(ast).replace(/^export /u, "");
}).join("\n");
const compiled = ts.transpileModule(`${actual}\nfunction actualOutputSpec(selected, originalLayout, generatedOverlayLayout = selected?.renderPlan?.generatedOverlayLayout) { const ratio='16:9'; const coverOutputSizes={'16:9':{width:1920,height:1080}}; const ${outputDeclaration.getText(ast)}; return outputSpec; }\nfunction actualPreviewUrl(previewSourceAssetId,previewPlanFingerprint,renderedPreviewStamp,renderedPreviewUrl){${previewDeclarations}\nreturn currentRenderedPreviewUrl;}\nmodule.exports={${names.join(",")},actualOutputSpec,actualPreviewUrl};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const module = { exports: {} };
vm.runInNewContext(compiled.outputText, { module, Object, JSON }, { timeout: 2000 });
const { canonicalCoverValue, inferCoverScenario, assignCoverScenarioRoles, ensureCoverImageNumbers, actualOutputSpec, actualPreviewUrl } = module.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const saved = {
  title: "你几点关灯\n它就几点开饭", subtitle: "", aspectRatio: "16:9", planVersion: 2,
  outputSpec: { height: 1080, width: 1920, format: "png", aspectRatio: "16:9" },
  titleStyle: { y: .07, x: .08, color: "#FFF1B8", scale: 1, width: .84 },
  coverModeId: "cartoon", animationStyleId: "pixar-3d", layoutTemplateId: "gaoding-cover-workbench",
  materialSourceId: "text", subjectModeId: "semantic",
};
const editor = { ...saved,
  outputSpec: { aspectRatio: "16:9", width: 1920, height: 1080, format: "png" },
  titleStyle: { x: .08, y: .07, width: .84, scale: 1, color: "#FFF1B8", colorMode: undefined },
};
assert.notEqual(JSON.stringify(saved), JSON.stringify(editor), "Regression must exercise JSONB key reordering");
assert.equal(canonicalCoverValue(saved), canonicalCoverValue(editor), "Opening unchanged JSONB plan must permit direct download");
assert.equal(actualOutputSpec({ renderPlan: saved }, true).fit, undefined, "A retained-image draft cannot change a generated history cover's crop policy");
assert.equal(actualOutputSpec({ renderPlan: { ...saved, outputSpec: { ...saved.outputSpec, fit: "contain" } } }, false).fit, "contain");
assert.equal(actualOutputSpec(null, true).fit, "contain", "Only new retained-image layouts adopt the draft policy");
assert.equal(actualOutputSpec({ renderPlan: { ...saved, generatedOverlayLayout: true } }, false).fit, "contain", "A saved generated overlay keeps the complete background within the cover");
assert.equal(actualPreviewUrl("a", "plan1", "a\0plan1", "blob:preview"), "blob:preview");
assert.equal(actualPreviewUrl("b", "plan1", "a\0plan1", "blob:preview"), "", "Changing source immediately hides the old preview");
assert.equal(actualPreviewUrl(undefined, "plan1", "a\0plan1", "blob:preview"), "", "Composition without an original canvas cannot show an old retained-image preview");
assert.equal(actualPreviewUrl("a", "plan2", "a\0plan1", "blob:preview"), "", "A previous title/layout render cannot qualify as the current saved preview");
for (const change of [
  { ...editor, title: "新的封面标题" },
  { ...editor, outputSpec: { ...editor.outputSpec, width: 1080 } },
  { ...editor, titleStyle: { ...editor.titleStyle, y: .12 } },
  { ...editor, titleStyle: { ...editor.titleStyle, colorMode: "palette" } },
]) assert.notEqual(canonicalCoverValue(saved), canonicalCoverValue(change), "Real edits must remain unsaved changes");
assert.notEqual(canonicalCoverValue(["一", "二"]), canonicalCoverValue(["二", "一"]), "Title/array ordering remains meaningful");
const assets = ["one", "two", "three"].map((id, index) => ({ id, assetId: `asset-${id}`, role: index ? "style_reference" : "background_canvas", previewUrl: `blob:${id}`, status: "ready" }));
const original = plain(assets);
assert.deepEqual(plain(assignCoverScenarioRoles(assets, "product")).map(item => item.role), ["identity_subject", "style_reference", "style_reference"]);
assert.deepEqual(plain(assignCoverScenarioRoles(assets, "reference")).map(item => item.role), ["style_reference", "style_reference", "style_reference"]);
assert.deepEqual(plain(assignCoverScenarioRoles(assets, "background")).map(item => item.role), ["background_canvas", "style_reference", "style_reference"]);
assert.deepEqual(plain(assignCoverScenarioRoles(assets, "script")), original, "Text-only mode parks image drafts without deleting or mutating them");
assert.deepEqual(assets, original, "Switching modes must not mutate already frozen material snapshots");
assert.equal(inferCoverScenario([]), "script");
for (const scenario of ["product", "reference", "background"]) assert.equal(inferCoverScenario(assignCoverScenarioRoles(assets, scenario)), scenario);
assert.deepEqual(plain(assignCoverScenarioRoles(assets.slice(1), "product")).map(item => item.role), ["identity_subject", "style_reference"], "After removing the first image the next image acquires the required role");
const numbered = ensureCoverImageNumbers(assets, 1);
assert.deepEqual(plain(numbered.assets).map(asset => asset.imageNumber), [1, 2, 3]);
const afterDelete = ensureCoverImageNumbers(numbered.assets.slice(1), numbered.next);
assert.deepEqual(plain(afterDelete.assets).map(asset => asset.imageNumber), [2, 3], "Deletion never relabels @图2 as @图1");
const afterAdd = ensureCoverImageNumbers([...afterDelete.assets, { ...assets[0], id: "new" }], afterDelete.next);
assert.deepEqual(plain(afterAdd.assets).map(asset => asset.imageNumber), [2, 3, 4], "New image cannot steal a deleted image's number");
assert.deepEqual(plain(ensureCoverImageNumbers([{ ...assets[0], imageNumber: 7 }, assets[1]], 3).assets).map(asset => asset.imageNumber), [7, 8]);
console.log(JSON.stringify({ passed: true, checks: 27, sourceSha256: createHash("sha256").update(source).digest("hex"), networkCalls: 0 }));
