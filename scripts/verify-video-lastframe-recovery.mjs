#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
const before = process.argv.find((value) => value.startsWith('--before='))?.slice(9);
assert.ok(before, 'Pass the backed-up video page with --before=');
function mapRestored(file, lastFrameUrl) {
  const source = fs.readFileSync(file, 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'restoredCard') initializer = node.initializer.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(initializer);
  const context = vm.createContext({
    t: { status: 'processing', taskIdExternal: 'original-task', modelId: 'pm_original', firstFrameUrl: 'https://owned.example/first.png', lastFrameUrl, createdAt: '2026-09-02T00:00:00Z' },
    nextLocalId: { current: 1 }, currentBatchId: { current: 'original-batch' }, merged: [],
  });
  vm.runInContext(ts.transpileModule(`globalThis.result = ${initializer};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.result;
}
const current = path.resolve('src/app/video/page.tsx');
const old = mapRestored(path.resolve(before), 'https://owned.example/last.png');
assert.equal(old.lastFrameUrl, '', 'Old callback must reproduce the lost last frame');
const restored = mapRestored(current, 'https://owned.example/last.png');
assert.equal(restored.lastFrameUrl, 'https://owned.example/last.png');
assert.equal(restored.firstFrameUrl, 'https://owned.example/first.png');
assert.equal(restored.taskId, 'original-task');
assert.equal(restored.modelId, 'pm_original');
assert.equal(mapRestored(current, undefined).lastFrameUrl, '');
console.log(JSON.stringify({ pass: true, scenarios: 3, cases: ['old mapping loses last frame', 'actual mapping preserves both original frames and task/model identity', 'legacy rows without a last frame remain empty'], upstreamRequests: 0, databaseWrites: 0 }, null, 2));
