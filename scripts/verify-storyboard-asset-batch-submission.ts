import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync("src/components/storyboard-workbench.tsx", "utf8");
const tree = ts.createSourceFile("storyboard-workbench.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string) {
  let expression: ts.Expression | undefined;
  function walk(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0];
    ts.forEachChild(node, walk);
  }
  walk(tree);
  assert.ok(expression && ts.isArrowFunction(expression), `actual ${name} useCallback must exist`);
  return ts.transpileModule(`globalThis.${name} = (${expression.getText(tree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
const singleCode = callback("generateVisualAsset"), batchCode = callback("generateVisualAssets");
type Input = { planId: string; role: string; name: string; prompt: string; tags: string[]; customCategory: string };
const person: Input = { planId: "person", role: "character", name: "女主人", prompt: "同一女主人正面侧面背面", tags: [], customCategory: "人物" };
const dog: Input = { planId: "dog", role: "pet", name: "柯基", prompt: "同一柯基正面侧面背面", tags: [], customCategory: "宠物" };

function harness(failFirst = false) {
  let releaseSave: ((saved: boolean) => void) | undefined;
  let announceSave: (() => void) | undefined;
  const saveEntered = new Promise<void>((resolve) => { announceSave = resolve; });
  const model = { id: "gpt-image-fixture", name: "GPT-2.5 fixture", prices: { "1K": 0.4, "2K": 0.8 } as Record<string, number> };
  const run: { id: string; imageModelId: string; imageResolution: string; ratio: string; imageRatio?: string } = { id: "project-a", imageModelId: model.id, imageResolution: "1K", ratio: "16:9" };
  const posts: Array<Record<string, unknown>> = [];
  const pendingWrites: Array<unknown[]> = [];
  const errors: string[] = [];
  const confirms: string[] = [];
  const candidates: unknown[] = [];
  let uuid = 0, saveCalls = 0;
  const globals = {
    contextReadyRef: {current:true}, navigationRef: {current:false}, scopeMountedRef:{current:true}, referenceOnly: false, token: "nonsecret-fixture-token", userId: "fixture-user", activeImageModel: model, activeImageSelectionIssue: "", activeImageResolution: "1K",
    visualAssetGenerationRef: { current: false }, visualAssetGenerationIssue: "", visualAssetBatchRef: { current: null as unknown }, runRef: { current: run },
    window: { localStorage: {}, confirm: (message: string) => { confirms.push(message); return true; } },
    readStoryboardAssetAttempts: () => [], setPendingAssetAttempts: () => { throw new Error("UNEXPECTED_PENDING_READ"); },
    setVisualAssetError: (message: string) => { errors.push(message); }, setVisualAssetGenerating: () => {},
    storyboardImagePrice: (selected: typeof model, resolution: string) => selected.prices[resolution],
    storyboardImageModelName: (selected: typeof model) => selected.name,
    effectiveImageResolution: (_selected: typeof model, requested: string) => requested,
    effectiveImageRatio: (current: typeof run) => current.imageRatio ?? current.ratio,
    visualAssetRoleLabel: (role: string) => role,
    createStoryboardPersistenceSnapshot: (value: typeof run) => structuredClone(value),
    saveVisualAssetContext: async () => { saveCalls++; if (saveCalls > 1) return true; announceSave?.(); return await new Promise<boolean>((resolve) => { releaseSave = resolve; }); },
    updateAssetAttempts: (attempts: unknown[]) => { pendingWrites.push(structuredClone(attempts)); },
    crypto: { randomUUID: () => `fixture-${++uuid}` }, AbortSignal: { timeout: () => undefined },
    fetch: async (path: string, init: { method?: string; body?: string }) => {
      assert.equal(path, "/api/image/generate"); assert.equal(init.method, "POST");
      posts.push(JSON.parse(init.body || "null"));
      return failFirst ? { ok: false, json: async () => ({ error: "上游状态未知，请查询原请求" }) }
        : { ok: true, json: async () => ({ images: [{ url: "https://generated.example.org/image.png", assetId: "11111111-1111-4111-8111-111111111111" }] }) };
    },
    buildVisualAssetPrompt: (_role: string, prompt: string) => prompt,
    assetAttemptWasNotAccepted: () => false, STRICT_GPT_IMAGE_PUBLIC_ID: model.id,
    rememberVisualAssetCandidate: (candidate: unknown) => { candidates.push(candidate); return run; },
    setVisualAssetCandidates: (updater: (items: unknown[]) => unknown[]) => { candidates.splice(0, candidates.length, ...updater(candidates)); },
    setNotice: () => {}, structuredClone, Map, Set, JSON, Date, Number, String, Boolean, Error,
  };
  const context = vm.createContext(globals);
  vm.runInContext(singleCode, context);
  vm.runInContext(batchCode, context);
  const callbacks = context as unknown as { generateVisualAsset(input: Input, batch?: unknown): Promise<unknown>; generateVisualAssets(inputs: Input[]): Promise<unknown[]> };
  const batch = { runId: run.id, modelId: model.id, resolution: "1K", ratio: "16:9", price: 0.4, inputs: new Map([[person.planId, JSON.stringify(person)]]), started: new Set<string>() };
  return { model, run, globals, callbacks, batch, posts, pendingWrites, errors, confirms, candidates, saveEntered,
    release: () => { assert.ok(releaseSave, "must actually pause in real callback's awaited save"); releaseSave(true); },
    saveCalls: () => saveCalls,
  };
}

async function main() {
  const mutations = [
    { name: "ratio", mutate: (h: ReturnType<typeof harness>) => { h.run.ratio = "9:16"; } },
    { name: "model", mutate: (h: ReturnType<typeof harness>) => { h.run.imageModelId = "different-model"; } },
    { name: "resolution", mutate: (h: ReturnType<typeof harness>) => { h.run.imageResolution = "2K"; } },
    { name: "price", mutate: (h: ReturnType<typeof harness>) => { h.model.prices["1K"] = 9; } },
    { name: "project", mutate: (h: ReturnType<typeof harness>) => { h.run.id = "project-b"; } },
  ];
  for (const scenario of mutations) {
    const h = harness();
    h.globals.visualAssetBatchRef.current = h.batch;
    const running = h.callbacks.generateVisualAsset(person, h.batch);
    await h.saveEntered;
    assert.equal(h.batch.started.has(person.planId), true, `${scenario.name}: batch admission must have passed before await gap`);
    scenario.mutate(h);
    h.release();
    assert.equal(await running, null, scenario.name);
    assert.equal(h.posts.length, 0, `${scenario.name}: changed selection must not dispatch`);
    assert.equal(h.pendingWrites.length, 0, `${scenario.name}: changed selection must not persist a new pending attempt`);
    assert.ok(h.errors.some((message) => message.includes("已改变")), scenario.name);
    assert.equal(h.globals.visualAssetGenerationRef.current, false);
  }
  {
    const h = harness();
    h.globals.visualAssetBatchRef.current = h.batch;
    const running = h.callbacks.generateVisualAsset(person, h.batch);
    await h.saveEntered;
    h.release();
    assert.ok(await running);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].aspectRatio, h.batch.ratio);
    assert.equal(h.posts[0].resolution, h.batch.resolution);
    assert.equal(h.posts[0].modelId, h.batch.modelId);
    assert.equal(h.posts[0].noRetry, true);
    assert.equal(h.pendingWrites.length, 2, "pending attempt written before dispatch, then cleared after confirmed result");
    const attempt = h.pendingWrites[0][0] as Record<string, unknown>;
    assert.equal(attempt.ratio, "16:9"); assert.equal(attempt.resolution, "1K"); assert.equal(attempt.quotedPrice, 0.4);
    assert.equal(h.confirms.length, 0, "individual callbacks must use batch authorization instead of another confirmation");
  }
  {
    const h = harness(true);
    const running = h.callbacks.generateVisualAssets([person, dog]);
    await h.saveEntered;
    h.release();
    const results = await running;
    assert.equal(results.length, 1);
    assert.equal(results[0], null);
    assert.equal(h.saveCalls(), 1, "second asset must not start after first unknown/null result");
    assert.equal(h.posts.length, 1);
    assert.equal(h.pendingWrites.length, 1, "unknown first request must remain recoverable, not cleared or overwritten by second");
    assert.equal(h.confirms.length, 1);
    assert.equal(h.globals.visualAssetBatchRef.current, null);
  }
  console.log(JSON.stringify({ passed: true, actualCallbacksExtractedWithTypeScriptAst: true, changedDuringAwaitCases: mutations.length,
    changedCasesZeroPostAndPendingWrites: true, frozenParametersOnePost: true, stopsAfterFirstNull: true, zeroNetwork: true }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
