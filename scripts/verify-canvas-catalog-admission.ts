import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { canvasModelAdmissionIssue, canvasPublicAdmissionCapabilities, readCanvasPublicCatalog } from "@/lib/canvas-public-catalog-loader";

async function main() {
  const normal = { id: "fixture", provider: "platform_public", selling_price: 0, pricePerUse: 0, capabilities: { available: true, priceReady: true } };
  assert.equal(canvasModelAdmissionIssue(normal, "image"), "", "verified zero-price models must remain usable");
  assert.equal(canvasModelAdmissionIssue(normal, "video"), "");
  assert.equal(canvasPublicAdmissionCapabilities({ publicPrice: null }).priceReady, false);
  assert.equal(canvasPublicAdmissionCapabilities({ publicPrice: 0, capabilities: { available: true } }).priceReady, true);
  const blocked = [undefined, { ...normal, capabilities: { available: false } }, { ...normal, capabilities: { catalogHealthReady: false } },
    { ...normal, capabilities: { available: true, priceReady: false } }, { ...normal, capabilities: { available: true, permissionGranted: false } }, { ...normal, selling_price: Number.NaN }];
  const manualSource = readFileSync("src/components/manual-canvas.tsx", "utf8");
  const manualTree = ts.createSourceFile("manual-canvas.tsx", manualSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function actualFunction(name: string) {
    let target: ts.FunctionDeclaration | undefined;
    function walk(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) target = node; ts.forEachChild(node, walk); }
    walk(manualTree); assert.ok(target);
    return ts.transpileModule(`globalThis.${name}=(${target.getText(manualTree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  }
  const runCode = actualFunction("runNode"), executeCode = actualFunction("executeNode");
  function actualArrow(name: string) {
    let target: ts.Expression | undefined;
    function walk(node: ts.Node) { if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer && ts.isCallExpression(node.initializer)) target = node.initializer.arguments[0]; ts.forEachChild(node, walk); }
    walk(manualTree); assert.ok(target);
    return ts.transpileModule(`globalThis.${name}=(${target.getText(manualTree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  }
  function actualManualEffect(fragment: string) {
    let target: ts.Expression | undefined;
    function walk(node: ts.Node) { if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]?.getText(manualTree).includes(fragment)) target = node.arguments[0]; ts.forEachChild(node, walk); }
    walk(manualTree); assert.ok(target);
    return ts.transpileModule(`globalThis.effect=(${target.getText(manualTree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  }
  {
    const notices: string[] = [];
    const context = vm.createContext({ canvasModelAdmissionIssue, onNotice: (message: string) => notices.push(message), promptPresets: [{ id: "fixture" }],
      consistencySourceDraftRef: { current: "explore" }, keyframeStrategyDraft: "visual-anchor", effectsLevelDraft: "rich",
      canvasImageModelId: "image-A", defaultImageModelId: "image-A", imageModels: [{ ...normal, id: "image-A", name: "text only", supports_image_input: false }, { ...normal, id: "image-B", name: "other paid channel", supports_image_input: true }],
      getImageModelCapabilities: (model: { supports_image_input: boolean }) => ({ supportsReferenceInput: model.supports_image_input }) });
    vm.runInContext(actualFunction("selectReferenceImageModel") + actualArrow("createCanvasFromScript"), context);
    await (context as unknown as { createCanvasFromScript(...args: unknown[]): Promise<void> }).createCanvasFromScript("test script", "", "16:9", "fixture");
    assert.ok(notices.some(message => message.includes("请手动选择")), "reference capability mismatch must stop instead of selecting image-B or changing consistency mode");
  }
  {
    const notices: string[] = [];
    const context = vm.createContext({ canvasModelAdmissionIssue, onNotice: (message: string) => notices.push(message),
      canvasImageModelId: "image", defaultImageModelId: "image", canvasVideoModelId: "video-A", defaultVideoModelId: "video-A",
      imageModels: [{ ...normal, id: "image" }], videoModels: [{ ...normal, id: "video-A", supportsImageInput: false }, { ...normal, id: "video-B", supportsImageInput: true }] });
    vm.runInContext(actualArrow("applyCanvasTemplate"), context);
    (context as unknown as { applyCanvasTemplate(value: string): void }).applyCanvasTemplate("video");
    assert.ok(notices.some(message => message.includes("请手动选择")), "template must not substitute video-B");
  }
  {
    let changes = 0;
    const context = vm.createContext({ requiresExactStoryboardTiming: true, allowStoryboardAutoTrim: false, canvasVideoModelId: "video-A", videoModels: [{ id: "video-A", name: "fixed model" }],
      isCanvasStoryboardVideoModelCompatible: () => false, onNotice: () => {}, setCanvasVideoModelId: () => { changes++; } });
    vm.runInContext(actualManualEffect("不支持当前精确时长"), context);
    (context as unknown as { effect(): void }).effect();
    assert.equal(changes, 0, "timing effect must preserve current selected model");
  }
  {
    const context = vm.createContext({ JSON, Number, Boolean, Error });
    vm.runInContext(actualFunction("unresolvedCanvasImageAttempt") + actualFunction("assertCanvasImageAttemptRecovery"), context);
    const api = context as unknown as { unresolvedCanvasImageAttempt(data: unknown, count: number): unknown; assertCanvasImageAttemptRecovery(attempt: unknown, index: number, fingerprint: string): void };
    const fingerprint = JSON.stringify({ batchIndex: 1, modelId: "image-A", prompt: "original" });
    const pending = api.unresolvedCanvasImageAttempt({ imageClientTraceId: "old-trace", imageClientIdempotencyKey: "old-key", imageRequestFingerprint: fingerprint, history: [] }, 3);
    api.assertCanvasImageAttemptRecovery(pending, 1, fingerprint);
    assert.throws(() => api.assertCanvasImageAttemptRecovery(pending, 1, JSON.stringify({ batchIndex: 1, prompt: "changed" })));
    assert.throws(() => api.assertCanvasImageAttemptRecovery(pending, 0, fingerprint));
    assert.throws(() => api.unresolvedCanvasImageAttempt({ imageClientTraceId: "old-trace", history: [] }, 3));
    api.assertCanvasImageAttemptRecovery(null, 2, "new batch item after prior completion");
    assert.equal(api.unresolvedCanvasImageAttempt({ imageClientTraceId: "old-trace", imageClientIdempotencyKey: "old-key", imageRequestFingerprint: fingerprint, history: [{ taskId: "old-trace", outputUrl: "completed" }] }, 3), null);
    assert.match(manualSource, /!canReuseImageAttempt && canvasModelAdmissionIssue/u);
    assert.match(manualSource, /canReuseImageAttempt \? \{ resumeDeliveryOnly: true \} : \{\}/u);
    assert.ok(manualSource.indexOf("assertCanvasImageAttemptRecovery(pendingOriginalImageAttempt") < manualSource.indexOf("const clientTraceId = canReuseImageAttempt"));
  }
  for (const model of blocked) {
    assert.ok(canvasModelAdmissionIssue(model, "image"));
    let writes = 0, providers = 0;
    const node = { id: "node", data: { kind: "image", title: "fixture", modelId: "fixture", status: "idle" } };
    const globals = { onNotice: () => {}, nodesRef: { current: [node] }, currentModelCatalogRef: { current: { imageModels: model ? [model] : [], videoModels: [] } },
      canvasModelAdmissionIssue, activeCanvasId: "fixture-canvas", recordGenerationDiagnostic: () => {},
      ensureActiveCanvasPersistedForGeneration: () => { writes++; throw new Error("MUST_NOT_SAVE"); },
      fetch: () => { providers++; throw new Error("MUST_NOT_DISPATCH"); }, Date, Error, Boolean };
    const context = vm.createContext(globals);
    vm.runInContext(runCode + executeCode, context);
    const callbacks = context as unknown as { runNode(id: string): void; executeNode(id: string, nodes: unknown[]): Promise<unknown> };
    callbacks.runNode("node");
    await assert.rejects(() => callbacks.executeNode("node", [node]));
    assert.equal(writes, 0); assert.equal(providers, 0);
  }
  let bodyReads = 0;
  const failFetch = (async () => ({ ok: false, json: async () => { bodyReads++; return { models: [] }; } })) as unknown as typeof fetch;
  await assert.rejects(() => readCanvasPublicCatalog("/bad", "models", new AbortController().signal, failFetch));
  assert.equal(bodyReads, 0);
  for (const payload of [{ ok: false, models: [] }, { models: "bad" }]) {
    await assert.rejects(() => readCanvasPublicCatalog("/bad", "models", new AbortController().signal,
      (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch));
  }
  for (const payload of [{ config: {} }, { mode: "safe_default", config: { health: { disabledImageModelIds: [] } } }]) {
    await assert.rejects(() => readCanvasPublicCatalog("/health", "runtime", new AbortController().signal,
      (async () => ({ ok: true, json: async () => payload })) as unknown as typeof fetch));
  }

  const shellSource = readFileSync("src/components/free-canvas-shell.tsx", "utf8");
  const shellTree = ts.createSourceFile("free-canvas-shell.tsx", shellSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let catalogEffect: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "useEffect" && node.arguments[0]?.getText(shellTree).includes("readCanvasPublicCatalog")) catalogEffect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(shellTree); assert.ok(catalogEffect);
  const effectCode = ts.transpileModule(`globalThis.effect=(${catalogEffect.getText(shellTree)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  for (const failRuntime of [false, true]) {
    type CatalogEntry = { id: string; capabilities?: Record<string, unknown> };
    const images: CatalogEntry[][] = [], videos: CatalogEntry[][] = [], notices: string[] = [], defaults: string[] = [];
    const fetcher = (async (url: string) => {
      if (url.includes("voice/list") || failRuntime && url.includes("runtime-config")) throw new Error("ONE_SERVICE_FAILED");
      const data = url.includes("runtime-config") ? { config: { defaults: { imageModelId: "disabled-default", videoModelId: "video" }, health: { disabledImageModelIds: ["disabled-default"] } } }
        : url.includes("pricing") ? { data: [] } : { models: url.includes("cover-models") ? [{ ...normal, id: "disabled-default", capabilities: { available: false, priceReady: true } }, { ...normal, id: "zero-price" }] : [{ ...normal, id: "video" }] };
      return { ok: true, json: async () => data };
    }) as unknown as typeof fetch;
    const context = vm.createContext({ AbortController, Set, Promise, readCanvasPublicCatalog: (url: string, shape: "models" | "runtime" | "voices" | "pricing", signal: AbortSignal) => readCanvasPublicCatalog(url, shape, signal, fetcher),
      normalizePublicCanvasImageModel: (value: unknown) => value, normalizePublicCanvasVideoModel: (value: unknown) => value,
      normalizeCanvasVoiceOption: (value: unknown) => value, normalizeCanvasVoicePricing: (value: unknown) => value,
      selectCanvasImageModel: () => "disabled-default", selectCanvasVideoModel: () => "video",
      setImageModels: (value: CatalogEntry[]) => images.push(value), setVideoModels: (value: CatalogEntry[]) => videos.push(value),
      setDefaultImageModelId: (value: string) => defaults.push(value), setDefaultVideoModelId: () => {}, setVoiceOptions: () => {}, setVoicePricing: () => {}, setNotice: (message: string) => notices.push(message) });
    vm.runInContext(effectCode, context);
    const cleanup = (context as unknown as { effect(): () => void }).effect();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(images.at(-1)?.length, 2, "failed voice service must not hide either disabled or zero-price image model");
    assert.equal(videos.at(-1)?.length, 1, "failed voice/runtime service must not clear video catalog");
    assert.ok(notices.some(message => message.includes("音色")));
    assert.equal(defaults.at(-1), failRuntime ? undefined : "disabled-default", "unknown runtime must not guess a paid default; unavailable configured default must be retained");
    if (failRuntime) assert.equal(images.at(-1)?.[1].capabilities?.catalogHealthReady, false);
    cleanup();
  }
  {
    const defaults: string[] = [];
    let releaseRuntime: (() => void) | undefined;
    const pendingRuntime = new Promise<void>(resolve => { releaseRuntime = resolve; });
    const fetcher = (async (url: string) => {
      if (url.includes("runtime-config")) await pendingRuntime;
      const value = url.includes("runtime-config") ? { config: { defaults: { imageModelId: "B", videoModelId: "B" }, health: { disabledImageModelIds: [] } } }
        : url.includes("voice/list") ? { data: { voices: [] } } : url.includes("pricing") ? { data: [] } : { models: [{ ...normal, id: "A" }, { ...normal, id: "B" }] };
      return { ok: true, json: async () => value };
    }) as unknown as typeof fetch;
    const context = vm.createContext({ AbortController, Set, Promise, readCanvasPublicCatalog: (url: string, shape: "models" | "runtime" | "voices" | "pricing", signal: AbortSignal) => readCanvasPublicCatalog(url, shape, signal, fetcher),
      normalizePublicCanvasImageModel: (value: unknown) => value, normalizePublicCanvasVideoModel: (value: unknown) => value, normalizeCanvasVoiceOption: (value: unknown) => value, normalizeCanvasVoicePricing: (value: unknown) => value,
      setImageModels: () => {}, setVideoModels: () => {}, setVoiceOptions: () => {}, setVoicePricing: () => {}, setNotice: () => {},
      setDefaultImageModelId: (value: string) => defaults.push(value), setDefaultVideoModelId: (value: string) => defaults.push(value) });
    vm.runInContext(effectCode, context);
    const cleanup = (context as unknown as { effect(): () => void }).effect();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(defaults.length, 0, "image/video directory arriving before runtime must not choose A");
    releaseRuntime!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(defaults, ["B", "B"]);
    cleanup();
    let image = "", video = "";
    const child = vm.createContext({ defaultImageModelId: "", defaultVideoModelId: "", imageModels: [{ id: "A" }, { id: "B" }], selectableCanvasVideoModels: [{ id: "A" }, { id: "B" }],
      setCanvasImageModelId: (update: (current: string) => string) => { image = update(image); }, setCanvasVideoModelId: (update: (current: string) => string) => { video = update(video); } });
    vm.runInContext(actualManualEffect("current || defaultImageModelId"), child);
    const initialize = (child as unknown as { effect(): void }).effect;
    initialize(); assert.equal(image, ""); assert.equal(video, "");
    child.defaultImageModelId = "B"; child.defaultVideoModelId = "B";
    initialize(); assert.equal(image, "B"); assert.equal(video, "B");
    image = "restored-A"; video = "restored-A";
    initialize(); assert.equal(image, "restored-A"); assert.equal(video, "restored-A");
  }
  console.log(JSON.stringify({ passed: true, actualShellEffectAndNodeCallbacks: true, independentCatalogFailures: true, disabledAndZeroPriceVisible: true, preSubmitBlockedBeforeWrites: true, zeroNetwork: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
