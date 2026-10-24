import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

// Audit only: execute the existing helper with controlled IO, never the API.
const file = 'src/app/api/image/generate/route.ts';
const source = await readFile(file, 'utf8');
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const names = ['exactTextPlan', 'prepareGeneratedImageBytes', 'buildCoverTextPrompt'];
const declarations = new Map();
const calls = [];
let providerDelivery = '';
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) declarations.set(node.name.text, node.getText(tree));
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'prepareGeneratedImageBytes') {
    calls.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      properties: node.arguments[0].properties.map(property => property.name?.getText(tree)) });
  }
  if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'persistProviderResult') providerDelivery = node.initializer.getText(tree);
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(declarations.size, 3);
assert.equal(calls.length, 2);
assert.ok(calls.every(call => !call.properties.includes('coverText')));
let renderCalls = 0;
const code = ts.transpileModule([...declarations.values()].join('\n') + '\n({prepareGeneratedImageBytes, buildCoverTextPrompt});', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const actual = vm.runInNewContext(code, {
  parseImageDimensions: () => ({ width: 160, height: 90 }),
  validateImageOutputContract: () => null,
  renderCoverComposition: async () => { renderCalls += 1; return { bytes: Buffer.from('rendered'), width: 160, height: 90 }; },
  ImageRequestRejectedError: Error,
});
const buffer = Buffer.from('controlled-image-bytes');
const input = { buffer, aspectRatio: '16:9', resolution: '2K', expectedPixelSize: '160x90' };
const currentResult = await actual.prepareGeneratedImageBytes(input);
assert.equal(currentResult.buffer, buffer);
assert.equal(renderCalls, 0);
const requestedText = 'AUDIT_EXACT_GLYPHS_文字';
await actual.prepareGeneratedImageBytes({ ...input, coverText: requestedText });
assert.equal(renderCalls, 1);
const providerPrompt = actual.buildCoverTextPrompt(requestedText, '', '16:9', 'A simple scene');
assert.ok(!providerPrompt.includes(requestedText));
assert.match(providerPrompt, /without any visible text/);
assert.match(providerDelivery, /deliveryMode: "provider_url", providerUrl:/);
assert.ok(!providerDelivery.includes('prepared.buffer'));
const report = {
  schema: 'storyboard-exact-text-audit.v1', status: 'BUG_REPRODUCED_NOT_FIXED', priority: 'P2',
  source: { file, sha256: createHash('sha256').update(source).digest('hex') },
  calls, currentPath: { passesCoverText: false, originalBytesReturned: currentResult.buffer === buffer, renderCalls: 0 },
  positiveControl: { renderCalls: 1 }, providerPromptContainsExactText: false,
  providerUrlBranchDeliversOriginalUrl: true,
  scope: 'Enabled or restored exact-text projects only; default new cards disable exact-text composition.',
  realNetworkRequests: 0, realProviderCalls: 0, databaseWrites: 0,
};
const output = '.codex-evidence/storyboard-delivery-audit-20261023/exact-text';
await mkdir(output, { recursive: true });
await writeFile(`${output}/receipt.json`, JSON.stringify(report, null, 2) + '\n');
await writeFile(`${output}/extracted-helper.txt`, [...declarations.values()].join('\n\n'));
console.log(JSON.stringify(report));
