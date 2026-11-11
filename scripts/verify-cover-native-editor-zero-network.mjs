import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/components/cover-workbench-client.ts", "utf8");
const ast = ts.createSourceFile("client.ts", source, ts.ScriptTarget.Latest, true);
const hook = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "useCoverWorkbench");
const composition = fs.readFileSync("src/lib/cover-composition.ts", "utf8");
const compositionAst = ts.createSourceFile("composition.ts", composition, ts.ScriptTarget.Latest, true);
function extract(statements, name, tree) {
  const fn = statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  if (fn) return fn.getText(tree).replace(/^export /u, "");
  const variable = statements.filter(ts.isVariableStatement).flatMap(n => [...n.declarationList.declarations]).find(n => n.name.getText(tree) === name);
  assert.ok(variable, `actual ${name} declaration required`);
  return `const ${variable.getText(tree)};`;
}
const common = ["COVER_TEXT_RENDERING_VERSION", "coverTextRendering"].map(n => extract(compositionAst.statements, n, compositionAst)).join("\n");
const body = ["nativeSelected", "editableSelected", "changeTitle", "changeTitleStyle"].map(n => extract(hook.body.statements, n, ast)).join("\n");
const script = ts.transpileModule(`${common}\n${body}\nresult = {nativeSelected, editableSelected}; changeTitle('新标题'); changeTitleStyle({scale:1.2});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const cases = [];
for (const mode of ["native", "overlay", "legacy"]) {
  let edits = 0, notices = [];
  const context = { originalOrderDisplay: null, generatedOverlayLayout: undefined, selected: { backgroundAssetId: "owned-source", renderPlan: { planVersion: 2,
    ...(mode !== "legacy" ? { textRendering: { mode, version: "cover-text-rendering/1" } } : {}) } },
    setNotice: value => notices.push(value), setTitle: () => edits++, setManualTitle: () => {}, setTitleStyle: () => edits++,
    manualTitleRef: { current: false }, titleRevision: { current: 0 }, titleStyleTouched: { current: false }, editorRevision: { current: 0 }, bump: () => {}, result: null };
  vm.runInNewContext(script, context, { timeout: 1000 });
  assert.equal(context.result.nativeSelected, mode === "native");
  assert.equal(context.result.editableSelected, mode !== "native");
  assert.equal(edits, mode === "native" ? 0 : 2);
  assert.equal(notices.length, mode === "native" ? 1 : 0);
  cases.push({ mode, editable: context.result.editableSelected, edits });
}
const componentSource = fs.readFileSync("src/components/cover-workbench.tsx", "utf8");
const componentAst = ts.createSourceFile("component.tsx", componentSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const account = componentAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "AccountCoverWorkbench");
const previewScript = ts.transpileModule(["output", "previewOutput"].map(n => extract(account.body.statements, n, componentAst)).join("\n")
  + "\nresult = previewOutput;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const coverOutputSizes = { "3:4": { width: 1080, height: 1440 }, "16:9": { width: 1920, height: 1080 } };
for (const editableSelected of [false, true]) {
  const context = { workbench: { ratio: "16:9", editableSelected, selected: { ratio: "3:4", outputWidth: 1080, outputHeight: 1440 } }, coverOutputSizes, result: null };
  vm.runInNewContext(previewScript, context);
  assert.equal(context.result.width, editableSelected ? 1920 : 1080);
  assert.equal(context.result.height, editableSelected ? 1080 : 1440);
  cases.push({ case: "saved-preview-after-new-draft-ratio", editableSelected, actualPreview: context.result });
}
console.log(JSON.stringify({ passed: true, checks: cases.length, cases, networkCalls: 0, source: "actual client edit gates, preview dimensions and shared mode resolver" }, null, 2));
