import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync('src/lib/segmenter-core.ts', 'utf8')), { module, exports: module.exports });
const core = module.exports;
const fixtures = JSON.parse(fs.readFileSync('scripts/fixtures/segmenter-verbatim-20261019.json', 'utf8'));
const pageSource = fs.readFileSync('src/app/segmenter/page.tsx', 'utf8');
const tree = ts.createSourceFile('page.tsx', pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
function visit(node) {
  if (ts.isVariableDeclaration(node) && ['handleCopy', 'viewHistoryDetail'].includes(node.name.getText(tree))) {
    callbacks.set(node.name.getText(tree), node.initializer.arguments[0].getText(tree));
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.equal(callbacks.size, 2);
let checks = 0;
const summaries = [];
function verifyBodies(result, original, duration) {
  assert.equal(core.normalizeForIntegrity(result.segments.join('')), core.normalizeForIntegrity(original));
  assert.ok(result.counts.every(count => count <= core.DURATION_MODES[duration].max));
  assert.ok(result.segments.every(segment => segment.trim()), 'No empty narration segment');
  assert.equal(result.counts.reduce((sum, count) => sum + count, 0), core.countChars(original));
  assert.ok(!result.overlapPrefixes?.some(Boolean));
  const copied = core.formatSegmentedCopy(result, original);
  const copiedBodies = copied.split('\n').map(line => {
    const match = line.match(/^\d+\.【(.*)】$/u);
    assert.ok(match);
    return match[1];
  });
  assert.equal(core.normalizeForIntegrity(copiedBodies.join('')), core.normalizeForIntegrity(original));
  checks += 6;
}

async function runPageHistoryAndCopy(value, original, duration = 10) {
  let restored, copied, failure;
  const context = vm.createContext({
    ...core, Error, Number, Object, Array, JSON,
    auth: { user: { id: 'fixture-only' }, token: 'fixture-only' }, duration,
    setSelectedHistoryId() {}, setHistoryError(value) { if (value) failure = value; },
    setInputText(value) { context.inputText = value; },
    setResult(value) { restored = value; context.result = value; },
    setDuration() {}, setSaved() {}, setShowHistory() {}, setCopied() {},
    setSegmentNotice(value) { failure = value; }, setTimeout() {},
    fetch: async () => ({ ok: true, json: async () => ({ record: {
      original_text: original, result_text: JSON.stringify(value), mode: core.DURATION_MODES[duration].label,
    } }) }),
    copyToClipboard: async value => { copied = value; return true; },
  });
  vm.runInContext(compile(`globalThis.history=${callbacks.get('viewHistoryDetail')}; globalThis.copy=${callbacks.get('handleCopy')};`), context);
  await context.history('fixture-history');
  if (restored) { context.copy(); await Promise.resolve(); }
  return { restored, copied, failure };
}

for (const fixture of fixtures) {
  assert.equal(core.countChars(fixture.originalText), fixture.expectedSourceCharacters);
  assert.equal(fixture.legacyResult.counts.reduce((sum, count) => sum + count, 0), fixture.expectedLegacyCharacters);
  const result = core.segmentTextRule(fixture.originalText, 10);
  verifyBodies(result, fixture.originalText, 10);
  const originalLegacyJson = JSON.stringify(fixture.legacyResult);
  const fromHistory = await runPageHistoryAndCopy(fixture.legacyResult, fixture.originalText);
  assert.equal(fromHistory.failure, undefined);
  verifyBodies(fromHistory.restored, fixture.originalText, 10);
  assert.equal(fromHistory.copied, core.formatSegmentedCopy(fromHistory.restored, fixture.originalText));
  assert.equal(JSON.stringify(fixture.legacyResult), originalLegacyJson, 'Historical source fixture must remain unchanged');
  const reloaded = core.restoreSegmentResult(fromHistory.restored, fixture.originalText, 10);
  assert.equal(JSON.stringify(reloaded), JSON.stringify(fromHistory.restored), 'Restore must be idempotent');
  summaries.push({ id: fixture.id, counts: result.counts, total: result.counts.reduce((sum, count) => sum + count, 0), legacyCopyCorrected: true });
  checks += 5;
}

for (const duration of Object.keys(core.DURATION_MODES).map(Number)) {
  const { max } = core.DURATION_MODES[duration];
  for (const length of [max - 1, max, max + 1, max * 2 - 1, max * 2 + 1, 400]) {
    for (const original of ['长'.repeat(length), '1'.repeat(length), '甲，'.repeat(length)]) {
      verifyBodies(core.segmentTextRule(original, duration), original, duration);
    }
  }
}
for (const original of [
  '没错，没错，物理隔离。物理隔离。第二步，继续观察。',
  '甲'.repeat(49), '“你好！”【这句话】' + '乙'.repeat(61) + '结束。',
  '  开始， keep  two spaces。\r\n\r\n第二段，2026 年 10 月。\n \n最后一段！  ',
  '开头。\n \n \n中间。\n\t\n\n\t\n结尾。',
  '1234567890'.repeat(17) + '，Latin text。🙂继续。',
]) verifyBodies(core.segmentTextRule(original, 10), original, 10);

const genuine = { segments: ['没错，', '没错，继续。'], overlapPrefixes: ['', '没错，'] };
const genuineSource = '没错，没错，继续。';
const genuinePage = await runPageHistoryAndCopy(genuine, genuineSource);
assert.equal(genuinePage.failure, undefined);
assert.equal(genuinePage.copied, '1.【没错，】\n2.【没错，继续。】');
verifyBodies(genuinePage.restored, genuineSource, 10);
const extraBridge = { segments: ['没错，', '没错，没错，继续。'], overlapPrefixes: ['', '没错，'] };
verifyBodies(core.restoreSegmentResult(extraBridge, genuineSource, 10), genuineSource, 10);
const oldLong = { segments: ['长'.repeat(61)] };
verifyBodies(core.restoreSegmentResult(oldLong, '长'.repeat(61), 10), '长'.repeat(61), 10);
for (const malformed of [
  { segments: ['结束。', '没错，继续。'], overlapPrefixes: ['', '没错，'] },
  { segments: ['没错，', '没错，继续。'], overlapPrefixes: ['', '没'] },
  { segments: ['没错，', '没错，继续。'] },
  { segments: ['没错，', '没错，继续。'], overlapPrefixes: ['', 2] },
]) {
  const observed = await runPageHistoryAndCopy(malformed, '没错，继续。');
  assert.ok(observed.failure);
  assert.equal(observed.copied, undefined);
  checks += 2;
}
assert.throws(() => core.formatSegmentedCopy(extraBridge, genuineSource));
checks += 3;
console.log(JSON.stringify({ passed: true, checks, samples: summaries, networkRequests: 0, providerCalls: 0, databaseWrites: 0 }, null, 2));
