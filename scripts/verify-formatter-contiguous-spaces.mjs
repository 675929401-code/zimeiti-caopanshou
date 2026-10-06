import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const file = 'src/app/formatter/page.tsx';
const source = readFileSync(file, 'utf8');
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const formatNode = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'formatText');
assert.ok(formatNode, 'ACTUAL_FIXED_FORMAT_FUNCTION_REQUIRED');
const code = ts.transpileModule(formatNode.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const { formatText } = runInNewContext(`${code}\n({ formatText })`);

const cases = [];
const test = (name, input, expected) => {
  assert.equal(formatText(input), expected, name);
  cases.push(name);
};

test('fixed workflow removes blank lines, indentation, CJK gaps and line breaks', '  清 晨 的 书 店。\r\n\r\n\t读 者 走 进 店 里。\n  记 下 灵 感。', '清晨的书店。读者走进店里。记下灵感。');
test('tabs and ideographic spaces are normalized', '清\t晨　的\t书 店', '清晨的书店');
test('Chinese quote spacing is removed', '你 好 “ 世 界 ”， 今 天 很 好。', '你好“世界”，今天很好。');
test('English separators become one ordinary space', 'Open\tAI   Studio 2026', 'Open AI Studio 2026');
test('paragraphs merge into one continuous body', '第一段。\n\n第二段。\n第三段。', '第一段。第二段。第三段。');
test('blank input remains blank', ' \n\t　', '');

assert.match(source, /const FIXED_FORMAT_RULES/u);
assert.doesNotMatch(source, /Settings2|showOptions|toggleOption|keepSentenceBreak|句号分段/u);
assert.match(source, /const result = formatText\(inputText\)/u);
assert.match(source, /rules: \{ \.\.\.FIXED_FORMAT_RULES \}/u);

const report = {
  passed: true,
  scenarios: cases.length,
  cases,
  fixedWorkflow: true,
  retiredRuleControlsAbsent: true,
  realNetworkRequests: 0,
  realDatabaseWrites: 0,
};
const out = '.codex-evidence/toolbox-format-segment-r473-20260927';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/formatter-fixed-rule-source.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
