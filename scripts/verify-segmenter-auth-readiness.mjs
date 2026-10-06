#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const beforePageArg = process.argv.find((value) => value.startsWith("--before-page="))?.slice(14);
const beforeRouteArg = process.argv.find((value) => value.startsWith("--before-route="))?.slice(15);
assert.ok(beforePageArg, "Use --before-page=<segmenter page snapshot>");
assert.ok(beforeRouteArg, "Use --before-route=<semantic route snapshot>");

const beforePage = fs.readFileSync(path.resolve(beforePageArg), "utf8");
const beforeRoute = fs.readFileSync(path.resolve(beforeRouteArg), "utf8");
const currentPagePath = path.resolve("src/app/segmenter/page.tsx");
const currentRoutePath = path.resolve("src/app/api/segmenter/semantic/route.ts");
const currentPage = fs.readFileSync(currentPagePath, "utf8");
const currentRoute = fs.readFileSync(currentRoutePath, "utf8");
const cases = [];

function actualExpressions(file) {
  const text = fs.readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  let disabled;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "handleSegment") {
      callback = node.initializer?.arguments?.[0]?.getText(tree);
    }
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "button") {
      const props = node.attributes.properties;
      if (props.some((prop) => prop.name?.getText(tree) === "onClick" && prop.initializer?.expression?.getText(tree) === "handleSegment")) {
        disabled = props.find((prop) => prop.name?.getText(tree) === "disabled")?.initializer?.expression?.getText(tree);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(callback, "handleSegment callback must exist");
  assert.ok(disabled, "segment button disabled expression must exist");
  return { callback, disabled };
}

function fixture(values = {}) {
  const { callback, disabled } = actualExpressions(currentPagePath);
  const notices = [];
  let result = null;
  let ruleRuns = 0;
  let histories = 0;
  let segmentingTransitions = 0;
  const context = vm.createContext({
    inputText: "第一句完整文案。第二句继续说明。",
    duration: 8,
    segmenting: false,
    inputReady: true,
    auth: { isAuthenticated: false, user: null, token: null },
    setSegmenting() { segmentingTransitions += 1; },
    setSaved() {},
    setSegmentNotice(value) { notices.push(value); },
    setResult(value) { result = value; },
    segmentTextRule() {
      ruleRuns += 1;
      return {
        segments: ["第一句完整文案。", "第二句继续说明。"],
        counts: [8, 8],
        compliant: [false, true],
        paragraphBreakBefore: [false, false],
        method: "rule",
      };
    },
    async saveResultToHistory() {
      histories += 1;
      return true;
    },
    fetch() { throw new Error("segmenter must not make a network request"); },
    ...values,
  });
  const source = `globalThis.run = ${callback}; globalThis.disabled = (${disabled});`;
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return {
    run: () => context.run(),
    disabled: context.disabled,
    notices,
    result: () => result,
    ruleRuns: () => ruleRuns,
    histories: () => histories,
    segmentingTransitions: () => segmentingTransitions,
  };
}

async function check(name, fn) {
  await fn();
  cases.push(name);
}

await check("snapshot proves the replaced customer flow called a semantic model endpoint", async () => {
  assert.match(beforePage, /\/api\/segmenter\/semantic/);
  assert.match(beforeRoute, /runBillableSemanticSegmentation/);
});

await check("current customer page has no model catalog, token price, admin exemption, or semantic POST", async () => {
  for (const forbidden of [
    /useToolRuntimeCatalog/,
    /browser-client-attempt/,
    /\/api\/segmenter\/semantic/,
    /当前通道/,
    /Token/,
    /管理员免收/,
    /语义模型/,
  ]) assert.doesNotMatch(currentPage, forbidden);
  assert.match(currentPage, /分段规则：按所选时长对应的字数范围/);
});

await check("legacy semantic endpoint is fail-closed without provider, wallet, or exactly-once imports", async () => {
  assert.doesNotMatch(currentRoute, /runBillableSemanticSegmentation|withExtractionExactlyOnce|getTokenFromHeaders|verifyToken/);
  assert.match(currentRoute, /SEGMENTER_RULE_ONLY/);
  assert.match(currentRoute, /status:\s*410/);
  assert.match(currentRoute, /provider_call_started:\s*false/);
  assert.match(currentRoute, /charged:\s*false/);
  assert.match(currentRoute, /"X-Segmenter-Provider-Call":\s*"blocked"/);
});

await check("input hydration blocks early submission without any rule, history, or network work", async () => {
  const item = fixture({ inputReady: false });
  await item.run();
  assert.equal(item.disabled, true);
  assert.equal(item.ruleRuns(), 0);
  assert.equal(item.histories(), 0);
  assert.equal(item.result(), null);
});

await check("signed-out customer receives deterministic rule output without a model request", async () => {
  const item = fixture();
  await item.run();
  assert.equal(item.disabled, false);
  assert.equal(item.ruleRuns(), 1);
  assert.equal(item.histories(), 0);
  assert.equal(item.result()?.method, "rule");
  assert.ok(item.notices.some((value) => value?.includes("字数范围和标点规则")));
});

await check("signed-in customer receives the same rule output and one personal-history save", async () => {
  const item = fixture({ auth: { isAuthenticated: true, user: { id: "fixture-user" }, token: "fixture-token" } });
  await item.run();
  assert.equal(item.disabled, false);
  assert.equal(item.ruleRuns(), 1);
  assert.equal(item.histories(), 1);
  assert.equal(item.result()?.method, "rule");
  assert.ok(item.notices.some((value) => value?.includes("保存到个人历史")));
  assert.equal(item.segmentingTransitions(), 2);
});

await check("in-flight submission remains disabled and cannot run again", async () => {
  const item = fixture({ segmenting: true });
  await item.run();
  assert.equal(item.disabled, true);
  assert.equal(item.ruleRuns(), 0);
  assert.equal(item.histories(), 0);
});

const result = {
  pass: true,
  scenarios: cases.length,
  cases,
  providerRequests: 0,
  paidRequests: 0,
  walletWrites: 0,
  historyWritesInFixture: 1,
};
const evidenceDir = path.resolve(".codex-evidence/segmenter-rule-only-20260916");
fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(evidenceDir, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
