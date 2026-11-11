import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync("src/components/unified-model-dialog.tsx", "utf8");
const tree = ts.createSourceFile("dialog.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let declaration, capabilityBranch;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "saveData" && node.initializer
    && node.initializer.getText(tree).includes("...form")) declaration = node;
  if (ts.isIfStatement(node) && node.expression.getText(tree) === 'form.model_type === "text"'
    && node.thenStatement.getText(tree).includes("saveData.image_parsing")) capabilityBranch = node.thenStatement;
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(declaration && capabilityBranch, "actual model save payload and text branch must be found");
const javascript = ts.transpileModule(`let saveData = ${declaration.initializer.getText(tree)}; ${capabilityBranch.getText(tree)}; result = saveData;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const cases = [];
for (const [image, file] of [["none", "none"], ["gpt_vision", "global"], ["reverse", "reverse"], ["global", "none"], ["1", "1"], ["true", "true"]]) {
  const context = {
    form: { model_type: "text", name: "只修改显示名称", model_name: "existing-model", billing_mode: "token",
      image_parsing: image, file_parsing: file, input_cost_per_million: "0.6", output_cost_per_million: "3",
      cached_cost_per_million: "0.06", profit_margin: "10", temperature: "", response_format: "",
      provider: "custom", protocol_type: "openai_chat", api_protocol_config: {} },
    modelName: "existing-model", endpoint: "https://fixture.invalid/v1", getLlmProviderPreset: () => ({ provider: "custom" }), result: null,
  };
  vm.runInNewContext(javascript, context, { timeout: 1000 });
  assert.equal(context.result.image_parsing, image, "unrelated save must preserve image capability");
  assert.equal(context.result.file_parsing, file, "unrelated save must preserve file capability");
  assert.equal(context.result.name, "只修改显示名称");
  cases.push({ image, file, preserved: true });
}
console.log(JSON.stringify({ passed: true, checks: cases.length, cases, source: "actual AST-extracted model save payload", networkCalls: 0, providerCalls: 0, databaseWrites: 0 }, null, 2));
