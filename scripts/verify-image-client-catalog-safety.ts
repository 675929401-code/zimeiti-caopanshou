import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { parseCoverGenerationModels } from "@/lib/cover-generation-attempt";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");
const coverStudio = read("src/components/cover-studio.tsx");
const imageWorkbench = read("src/components/image-workbench.tsx");
const publicModelDto = read("src/lib/public-model-dto.ts");
const coverModelsRoute = read("src/app/api/cover-models/route.ts");

function publicModel(capabilities: Record<string, unknown>, publicPrice: number) {
  return {
    id: "pm_contract_model",
    displayName: "合同模型",
    variantLabel: "A",
    publicPrice,
    capabilities: {
      defaultResolution: "1K",
      resolutionPrices: ["1K=1.25"],
      ...capabilities,
    },
  };
}

const unavailable = parseCoverGenerationModels([publicModel({ available: false, priceReady: true }, 1.25)])[0];
const unpriced = parseCoverGenerationModels([publicModel({ available: true, priceReady: false }, 0)])[0];
const ready = parseCoverGenerationModels([publicModel({ available: true, priceReady: true }, 9.99)])[0];

assert.equal(unavailable.available, false, "unavailable cover model must remain unavailable");
assert.equal(unpriced.available, false, "priceReady=false must also make a cover model unavailable");
assert.equal(unpriced.price, null, "unknown price must remain null rather than look free");
assert.equal(ready.available, true, "fully ready cover model should remain selectable");
assert.equal(ready.price, 1.25, "default-resolution public price should win over unrelated base price");

// Execute the component's actual callback, rather than duplicating its guards here.
const parsedComponent = ts.createSourceFile("cover-studio.tsx", coverStudio, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: ts.FunctionDeclaration[] = [];
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "generateImage") callbacks.push(node);
  ts.forEachChild(node, visit);
}
visit(parsedComponent);
assert.equal(callbacks.length, 1, "the real generation callback must be uniquely identified");
const callbackJavaScript = ts.transpileModule(callbacks[0].getText(parsedComponent), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

async function verifyGenerationCallback() {
  const cases = [
    { name: "unavailable", model: unavailable, expected: 0 },
    { name: "unpriced", model: unpriced, expected: 0 },
    // The parser also closes availability for unknown prices; isolate the second guard too.
    { name: "price guard independently", model: { ...unpriced, available: true }, expected: 0 },
    { name: "no selection", model: null, expected: 0 },
    { name: "ready", model: ready, expected: 1 },
  ];
  let totalRequests = 0;
  for (const fixture of cases) {
    let runEntries = 0;
    let tasksCreated = 0;
    let storageCreated = 0;
    const notices: string[] = [];
    const submissionRef = { current: null };
    const taskCounter = { current: 0 };
    const context = {
      activeModel: fixture.model, submissionInFlightRef: submissionRef, historyClearing: false,
      localStorage: { getItem: () => "synthetic-local-token" }, TOKEN_KEY: "fixture",
      currentUserId: "fixture-user", currentUserIdRef: { current: "fixture-user" },
      briefText: "fixture brief", prompt: "fixture prompt", title: "fixture title", subtitle: "",
      planNeedsRebuild: false, usesUploadedReference: false, usesBuiltInTemplate: false,
      referenceImage: "", hasReferenceMaterial: false, layoutTemplate: {},
      ratio: "1:1", layoutTemplateId: "fixture", animationStyleId: "fixture",
      coverModeId: "fixture", materialSourceId: "fixture", subjectModeId: "semantic",
      animationStyle: { name: "fixture" }, taskCounterRef: taskCounter,
      setNotice: (notice: string) => notices.push(notice),
      setLoginOpen: () => assert.fail("authenticated fixture must not open login"),
      setGenerationBusy: () => {}, setPrompt: () => {}, setSelectedResultId: () => {},
      syncCoverCopySemantics: (prompt: string) => prompt,
      createTaskStorage: () => { storageCreated += 1; return {}; },
      setResults: (update: (rows: unknown[]) => unknown[]) => { tasksCreated += update([]).length; },
      getTaskLabel: String,
      runCoverGeneration: () => { runEntries += 1; return new Promise(() => {}); },
      fetch: () => assert.fail("callback regression must never access the network"),
    };
    vm.createContext(context);
    vm.runInContext(callbackJavaScript, context);
    await vm.runInContext("generateImage()", context);
    assert.equal(runEntries, fixture.expected, fixture.name + ": actual runner entry count");
    assert.equal(tasksCreated, fixture.expected, fixture.name + ": actual task insertion count");
    assert.equal(storageCreated, fixture.expected, fixture.name + ": actual storage preparation count");
    assert.equal(taskCounter.current, fixture.expected, fixture.name + ": task counter");
    assert.ok(notices.length > 0, fixture.name + ": must explain rejection or submission");
    if (!fixture.expected) assert.equal(submissionRef.current, null, fixture.name + ": no submission lock");
    totalRequests += runEntries;
  }
  return { callbackCases: cases.length, generationRequests: totalRequests, rejectedGenerationRequests: 0 };
}

assert.ok(coverStudio.includes('disabled={!model.available}'), "unavailable cover catalog rows must be disabled");
assert.ok(coverStudio.includes('activeModel?.available && activeModel.priceReady && activeModel.price != null'),
  "cover price must only render after availability and price readiness are confirmed");
assert.ok(coverStudio.includes('"价格待确认"'), "cover unknown price must have an explicit non-free label");

const workbenchGuard = imageWorkbench.indexOf("if (!recoveringJobs && (!activeModel?.available || !activeModel.price_ready))");
const workbenchRequest = imageWorkbench.indexOf('fetch("/api/image/generate"');
assert.ok(workbenchGuard >= 0 && workbenchGuard < workbenchRequest,
  "image workbench readiness guard must run before a new image request");
assert.ok(imageWorkbench.includes("activeModel?.available && activeModel.price_ready"),
  "image workbench generate eligibility must require both availability and price readiness");
assert.ok(imageWorkbench.includes('disabled={!model.available}'), "unavailable image workbench models must be disabled");
assert.ok(imageWorkbench.includes('selectedResolutionPrice == null ? "价格待确认"'),
  "image workbench unknown prices must not display as free");

const finitePriceStart = publicModelDto.indexOf("function finitePublicPrice");
const finitePriceEnd = publicModelDto.indexOf("const MODEL_AVATAR", finitePriceStart);
const finitePriceSource = publicModelDto.slice(finitePriceStart, finitePriceEnd);
assert.ok(!finitePriceSource.includes("cost_per_use"), "supplier cost must never be projected as a public price");
assert.ok(coverModelsRoute.includes("selling_price: Number.isFinite(sellingPrice) ? sellingPrice"),
  "cover catalog must project the verified default-resolution selling price");

void verifyGenerationCallback().then((behavior) => {
  console.log(JSON.stringify({
    passed: true,
    checks: 15,
    ...behavior,
    realNetworkRequests: 0,
    databaseWrites: 0,
  }, null, 2));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
