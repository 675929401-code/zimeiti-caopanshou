import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the real history projection and hydration boundary. All fixtures stay
// in memory; neither recovery nor index normalization can call a real endpoint.
const componentPath = "src/components/storyboard-workbench.tsx";
const source = readFileSync(componentPath, "utf8");
const tree = ts.createSourceFile(componentPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const helperSource = readFileSync("src/lib/storyboard-history-view.ts", "utf8");
const helperTree = ts.createSourceFile("history-view.ts", helperSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const normalize = helperTree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "normalizeStoryboardHistoryCardIndex");
assert.ok(normalize, "history index normalization must have one shared owner");
let projection;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "videoHistoryItems") {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    projection = node.initializer.arguments[0].getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(projection, "the current workbench history projection must exist");
const hydration = tree.statements.filter(node => ts.isFunctionDeclaration(node)
  && ["hydrateRunVideoTasks", "normalizeRemoteVideoStatus"].includes(node.name?.text))
  .map(node => node.getText(tree)).join("\n");
assert.ok(hydration.includes("function hydrateRunVideoTasks"));
const code = [normalize.getText(helperTree).replace(/^export\s/u, ""), hydration,
  `globalThis.projectHistory = (tasks) => { const videoHistoryTasks = tasks; return (${projection})(); };`,
  "globalThis.hydrate = hydrateRunVideoTasks;"].join("\n");
let networkRequests = 0;
const sandbox = { fetch: () => { networkRequests += 1; throw new Error("NETWORK_FORBIDDEN"); } };
vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, sandbox);
const clone = value => JSON.parse(JSON.stringify(value));
const tasks = [
  { id: "segment-1-first", batchId: "batch", cardIndex: 1, status: "completed", canRetry: false },
  { id: "segment-1-retry", batchId: "batch", cardIndex: 1, status: "failed", canRetry: true },
  { id: "segment-2", batchId: "batch", cardIndex: 2, status: "completed" },
];
const originals = clone(tasks);
const items = sandbox.projectHistory(tasks);
assert.deepEqual(clone(items.map(item => item.cardIndex)), [0, 0, 1]);
assert.equal(items.length, 3, "repeated attempts of the same segment retain their task records");
assert.deepEqual(clone(items.map(item => item.taskId)), tasks.map(task => task.id));
assert.equal(items[0].canRetry, false);
assert.equal(items[1].canRetry, true);
for (const value of [undefined, null, 0, -1, 1.5, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.equal(sandbox.projectHistory([{ id: "unknown", cardIndex: value }])[0].cardIndex, undefined,
    "missing or invalid DB segment indices must remain unnumbered");
}
assert.deepEqual(tasks, originals, "DTO normalization must not mutate DB-shaped task records");
const run = { id: "batch", cards: [
  { id: "card-1", order: 1, videoStatus: "idle" },
  { id: "card-2", order: 2, videoStatus: "idle" },
] };
const hydrated = sandbox.hydrate(run, [tasks[0], tasks[2]]);
assert.equal(hydrated.cards[0].videoTaskId, "segment-1-first", "hydration must still match DB index 1 to card order 1");
assert.equal(hydrated.cards[1].videoTaskId, "segment-2");
assert.equal(hydrated.cards[0].videoRetryable, false);
assert.equal(run.cards[0].videoTaskId, undefined);
assert.equal(source.includes("sbw-history-page-navigation"), false, "history must not render a second navigation strip");
const pageCss = readFileSync("src/app/storyboard-workbench/storyboard-history-page.css", "utf8");
assert.match(pageCss, /\.sbw-root\s+\[hidden\]\s*\{\s*display:\s*none\s*!important/u);
assert.equal(pageCss.includes("sbw-history-page-navigation"), false);
assert.equal(networkRequests, 0);
console.log(JSON.stringify({ passed: true, checks: ["DB index to display index", "same-segment attempts retained", "invalid indices unnumbered", "retry eligibility preserved", "DB-shaped tasks immutable", "one-based hydration preserved", "single history navigation", "hidden workbench retained"], networkRequests }, null, 2));
