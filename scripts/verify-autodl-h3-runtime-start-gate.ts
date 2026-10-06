import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shouldStartAutodlH3LifecycleWorker } from "../src/lib/autodl-h3-runtime-start-gate";

const cases = [
  { name: "disabled", input: { installed: false, reason: "disabled" }, expected: false },
  { name: "failed", input: { installed: false, reason: "failed" }, expected: false },
  { name: "installed", input: { installed: true, reason: "installed" }, expected: true },
  { name: "already installed", input: { installed: true, reason: "already-installed" }, expected: true },
  { name: "defensive already-installed reason", input: { installed: false, reason: "already-installed" }, expected: true },
] as const;

for (const testCase of cases) {
  assert.equal(
    shouldStartAutodlH3LifecycleWorker(testCase.input),
    testCase.expected,
    testCase.name,
  );
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoints = ["src/instrumentation.ts", "src/server.ts"];
for (const relativePath of entrypoints) {
  const source = readFileSync(path.join(projectRoot, relativePath), "utf8");
  const installIndex = source.indexOf("installAutodlH3ProductionRuntimeSafelyFromEnvironment()");
  const gateIndex = source.indexOf("shouldStartAutodlH3LifecycleWorker(installResult)");
  const workerIndex = source.indexOf("startAutodlH3LifecycleWorkerFromEnvironment()", gateIndex);
  assert.ok(installIndex >= 0, `${relativePath}: install call missing`);
  assert.ok(gateIndex > installIndex, `${relativePath}: start gate must follow install`);
  assert.ok(workerIndex > gateIndex, `${relativePath}: worker start must follow the gate`);
}

process.stdout.write(JSON.stringify({
  audit: "autodl-h3-runtime-start-gate",
  networkUsed: false,
  pureFunctionCases: cases.length,
  entrypoints,
  verdict: "PASS",
}, null, 2) + "\n");
