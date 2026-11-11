#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src/lib/cover-number-evidence.ts"), "utf8");
const compiled = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
assert.deepEqual((compiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const module = { exports: {} };
vm.runInNewContext(compiled.outputText, { module, exports: module.exports, require() { throw Error("NO_IMPORTS_ALLOWED"); } });
const { coverNumbersAreGrounded: grounded, coverNumericClaims } = module.exports;
const positives = [
  ["先做10分钟", "每天先做十分钟"], ["十分钟", "10分钟"], ["1000元", "1,000元"], ["增长10%", "增长百分之十"],
  ["增长10％", "增长10%"], ["负0.50元", "-0.5元"], ["0.10毫升", "0.1ml"], ["100元", "一百元"],
  ["102个", "一百零二个"], ["23页", "二十三页"], ["10000件", "一万件"], ["第10章", "第十章"],
  ["原价10元", "原价十元"], ["不超过10分钟", "不超过十分钟"], ["10分钟", "不是20分钟，而是十分钟"],
];
const negatives = [
  ["20分钟", "十分钟"], ["10升", "十毫升"], ["10元", "十美元"], ["10分钟", "十"], ["10", "十分钟"],
  ["10分钟", "不超过十分钟"], ["需要10分钟", "不需要十分钟"], ["原价10元", "现价10元"], ["售价10元", "成本十元"],
  ["0.2元", "0.20%"], ["0.333元", "0.3333元"], ["0.5元", "负0.5元"], ["12元", "1元、2元"],
  ["120个", "一百二个"], ["1心1意", "一心一意"], ["10分开心", "十分开心"], ["ABC1000", "ABC1,000"],
  ["第10章", "十章"], ["20分钟", "10-20分钟"], ["10元", "10毫升"],
];
for (const [text, quote] of positives) assert.equal(grounded(text, quote), true, `Equivalent number failed: ${JSON.stringify({ text, quote, claims: coverNumericClaims(text), evidence: coverNumericClaims(quote) })}`);
for (const [text, quote] of negatives) assert.equal(grounded(text, quote), false, `Ungrounded number accepted: ${JSON.stringify({ text, quote, claims: coverNumericClaims(text), evidence: coverNumericClaims(quote) })}`);
assert.equal(coverNumericClaims("一心一意十分开心").length, 0);
console.log(JSON.stringify({ passed: true, positiveCases: positives.length, negativeCases: negatives.length, networkCalls: 0, providerCalls: 0, databaseCalls: 0,
  evidence: "Actual pure numeric checker in isolated TypeScript VM; exact number/value/unit/negation/context comparison, no live I/O" }, null, 2));
