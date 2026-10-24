#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const file = 'src/app/segmenter/page.tsx';
const source = fs.readFileSync(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'getSegmentCountLabel');
assert.ok(fn);
const context = vm.createContext({});
vm.runInContext(ts.transpileModule(`${fn.getText(tree)}\nglobalThis.label=getSegmentCountLabel;`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const cases = [
  [40, 40, 48, true, 'target', '✓ 目标范围内'],
  [48, 40, 48, true, 'target', '✓ 目标范围内'],
  [39, 40, 48, true, 'tail', '短段，保留原文'],
  [49, 50, 60, true, 'tail', '短段，保留原文'],
  [39, 40, 48, false, 'outside', '偏短'],
  [49, 40, 48, false, 'outside', '偏长'],
];
for (const [count, min, max, accepted, kind, label] of cases) {
  const result = context.label(count, min, max, accepted);
  assert.equal(result.kind, kind);
  assert.equal(result.label, label);
}
assert.doesNotMatch(source, /语义宽限|semanticAccepted/u);
const result = { passed: true, scenarios: cases.length, ruleLabelsOnly: true, generationRequests: 0 };
console.log(JSON.stringify(result));
