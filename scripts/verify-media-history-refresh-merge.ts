import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const pageSource = readFileSync("src/app/media-history/page.tsx", "utf8");
const sourceFile = ts.createSourceFile(
  "media-history-page.tsx",
  pageSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const declaration = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration => (
  ts.isFunctionDeclaration(statement) && statement.name?.text === "mergeHistoryItems"
));

assert.ok(declaration, "media history page must define mergeHistoryItems");
const functionSource = pageSource.slice(declaration.getStart(sourceFile), declaration.end);
const executable = ts.transpileModule(
  `${functionSource}\nglobalThis.mergeHistoryItems = mergeHistoryItems;`,
  { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
).outputText;
const sandbox: { mergeHistoryItems?: MergeHistoryItems } = {};
vm.runInNewContext(executable, sandbox);
assert.ok(sandbox.mergeHistoryItems, "mergeHistoryItems must be executable in isolation");

interface FixtureItem {
  id: string;
  status: "processing" | "completed";
}

type MergeHistoryItems = (
  previous: FixtureItem[],
  incoming: FixtureItem[],
  incomingFirst: boolean,
) => FixtureItem[];

const previous: FixtureItem[] = [
  { id: "task-refresh", status: "processing" },
  { id: "previous-only", status: "completed" },
];
const incoming: FixtureItem[] = [
  { id: "incoming-first", status: "completed" },
  { id: "task-refresh", status: "completed" },
];

const refreshed = sandbox.mergeHistoryItems(previous, incoming, true);
assert.deepEqual(
  Array.from(refreshed, (item) => item.id),
  ["incoming-first", "task-refresh", "previous-only"],
  "background page-0 refresh must preserve incoming order before unmatched existing items",
);
assert.equal(
  refreshed.find((item) => item.id === "task-refresh")?.status,
  "completed",
  "fresh completed state must replace the previous processing state",
);
assert.ok(
  refreshed.some((item) => item.id === "previous-only"),
  "background page-0 refresh must retain existing items omitted from the response",
);

const nextPage = sandbox.mergeHistoryItems(previous, incoming, false);
assert.deepEqual(
  Array.from(nextPage, (item) => item.id),
  ["task-refresh", "previous-only", "incoming-first"],
  "load-more merge must preserve existing page positions and append newly returned items",
);
assert.equal(
  nextPage.find((item) => item.id === "task-refresh")?.status,
  "completed",
  "load-more overlap must also prefer the incoming record",
);

assert.match(
  pageSource,
  /return mergeHistoryItems\(previous, incoming, offset === 0\);/u,
  "history loader must use incoming-first merge for page-0 background refreshes",
);
assert.doesNotMatch(
  functionSource,
  /fetch\(|axios|XMLHttpRequest|\/api\//u,
  "merge helper must remain a zero-network in-memory operation",
);

console.log(JSON.stringify({
  passed: true,
  checks: [
    "processing-to-completed",
    "retain-unreturned-existing-item",
    "incoming-order",
    "stable-load-more-order",
  ],
  networkCalls: 0,
  businessWrites: 0,
  paidRequests: 0,
}, null, 2));
