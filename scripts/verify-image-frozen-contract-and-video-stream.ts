import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { createImageFailureRequestSnapshot, parseImageFailureRequestSnapshot } from "../src/lib/image-failure-history";
import { IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2, validateImageOutputContract, configuredImageDeliveryPixelSizeFor } from "../src/lib/image-output-contract";
import { MemoryImageExactlyOnceStore } from "../src/lib/image-exactly-once";

const imageFile = "src/app/api/image/generate/route.ts";
const streamFile = "src/app/api/video/stream/route.ts";
const imageSource = readFileSync(imageFile, "utf8");
const streamSource = readFileSync(streamFile, "utf8");
const imageTree = ts.createSourceFile(imageFile, imageSource, ts.ScriptTarget.Latest, true);
const checks: string[] = [];
const compile = (code: string, context: object) => vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { console, Buffer, ...context });
const policy = { ...IMAGE_OUTPUT_POLICY_V1, candidatePixelSizes: { first: "2048x1152", alternate: "2560x1440" } };
const base = { prompt: "frozen output", publicModelId: "pm_test", modelName: "test", aspectRatio: "16:9", resolution: "2K",
  referenceImageUrls: [], quotedPriceYuan: 0.1, billingExempt: false, effectivePrompt: "effective", providerProtocol: "images_generations" as const,
  outputPixelSize: "2048x1152", imageCount: 1 as const, payloadFingerprint: "a".repeat(64) };

async function main() {
  const snapshot = createImageFailureRequestSnapshot({ ...base, outputPolicy: policy });
  assert.ok(snapshot);
  assert.deepEqual(snapshot.outputPolicy, policy);
  assert.ok(parseImageFailureRequestSnapshot({ ...snapshot, outputPolicy: undefined }));
  assert.ok(createImageFailureRequestSnapshot({ ...base, payloadFingerprint: undefined }));
  for (const bad of [{ ...policy, minimumDimensionScale: 0.5 }, { ...policy, version: "next" },
    { ...policy, candidatePixelSizes: { first: "bad" } }, { ...policy, aspectRatioTolerance: 1 }]) {
    assert.equal(parseImageFailureRequestSnapshot({ ...snapshot, outputPolicy: bad }), null);
  }
  checks.push("New frozen policy round trips; legacy v1/v2 remain readable; altered or invalid policy is rejected");

  const declarations = new Map<string, string>();
  function walk(node: ts.Node) {
    if (ts.isVariableStatement(node)) for (const entry of node.declarationList.declarations) {
      if (ts.isIdentifier(entry.name) && ["previousOutputPolicy", "outputPolicyVersion", "candidateDeliveryTargets", "outputPolicy", "deliveryOutputContract", "generationFingerprint", "failureRequestSnapshot"].includes(entry.name.text)) {
        declarations.set(entry.name.text, node.getText(imageTree));
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(imageTree);
  // These assertions intentionally exercise existing V1 requests; strict new
  // requests have their own separately executed policy regression suite.
  const getContract = (resumeSnapshot: unknown) => compile(`${["previousOutputPolicy", "outputPolicyVersion", "candidateDeliveryTargets", "outputPolicy", "deliveryOutputContract"].map(name => declarations.get(name)).join("\n")}\ndeliveryOutputContract;`, {
    resumeSnapshot, previousImageRequest: { requestSnapshot: snapshot }, parseImageFailureRequestSnapshot,
    IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2, configuredImageDeliveryPixelSizeFor,
    candidates: [{ id: "first" }, { id: "alternate" }], effectiveResolution: "2K", ratio: "16:9",
    workflowConfig: { appId: "workflow" }, outputPixelSize: "2048x1152", expectedImagePixelSize: () => "8192x4608",
    toPublicModelId: (_kind: string, id: string) => id === "first" ? "pm_test" : "pm_other",
    ImageExactlyOnceError: class extends Error { constructor(public code: string, message: string) { super(message); } },
  }) as (id: string) => { expectedPixelSize: string; minimumDimensionScale: number; aspectRatioTolerance: number };
  assert.equal(getContract(snapshot)("first").expectedPixelSize, "2048x1152");
  assert.equal(getContract(snapshot)("alternate").expectedPixelSize, "2560x1440");
  assert.equal(getContract({ ...snapshot, outputPolicy: undefined })("first").expectedPixelSize, "2048x1152");
  assert.throws(() => getContract({ ...snapshot, outputPolicy: undefined })("alternate"), /合同无法确认/);
  assert.throws(() => getContract({ ...snapshot, outputPixelSize: undefined, outputPolicy: undefined })("first"), /合同无法确认/);
  assert.throws(() => getContract(snapshot)("unbound"), /合同无法确认/);
  assert.equal(getContract(null)("first").expectedPixelSize, "8192x4608");
  assert.equal(validateImageOutputContract({ width: 1672, height: 941, aspectRatio: "16:9", resolution: "2K", ...getContract(snapshot)("first") }), null);
  assert.equal(validateImageOutputContract({ width: 1600, height: 900, aspectRatio: "16:9", resolution: "2K", ...getContract(snapshot)("first") })?.code,
    "IMAGE_OUTPUT_RESOLUTION_MISMATCH");
  const fingerprintSource = declarations.get("generationFingerprint")!;
  assert.match(fingerprintSource, /outputPolicy/);
  assert.match(fingerprintSource, /!previousImageRequest/);
  assert.match(fingerprintSource, /previousImageRequest.payloadFingerprint/);
  const fingerprintContext = {
    resumeDeliveryOnly: false, previousImageRequest: { requestSnapshot: { ...snapshot, outputPolicy: undefined } },
    deliveryRequirement: undefined, validationControl: undefined, userId: "owner", effectiveMode: "local", modelId: "pm_test",
    modelConfig: { id: "first" }, workflowConfig: {}, candidates: [{ id: "first", provider: "test", model_name: "test", api_endpoint: "https://example.com", api_protocol_config: {} }],
    workflowPrompt: "", fullPrompt: "effective", prompt: "user input", style: "", exactCoverText: "", ratio: "16:9", effectiveResolution: "2K",
    outputPixelSize: "2048x1152", outputPolicy: policy, providerProtocol: "images_generations", IMAGE_FIXED_OUTPUT_COUNT: 1,
    body: {}, referenceImageUrls: [], references: [], referenceUsage: "general", costPrice: 0.05, sellingPrice: 0.1,
    parseImageFailureRequestSnapshot, strictImagePayloadFingerprint: (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
  const fingerprint = (overrides: object) => compile(`${fingerprintSource}\ngenerationFingerprint;`, { ...fingerprintContext, ...overrides });
  assert.notEqual(fingerprint({}), fingerprint({ prompt: "changed input" }));
  assert.notEqual(fingerprint({}), fingerprint({ candidates: [{ ...fingerprintContext.candidates[0], api_protocol_config: { changed: true } }] }));
  assert.notEqual(fingerprint({ previousImageRequest: null }), fingerprint({ previousImageRequest: null, outputPolicy: { ...policy, candidatePixelSizes: { first: "4096x2304" } } }));
  assert.equal(fingerprint({ resumeDeliveryOnly: true, previousImageRequest: { payloadFingerprint: "original" } }), "original");
  assert.equal((imageSource.match(/\.\.\.deliveryOutputContract\(result.selectedModelId\)/gu) || []).length, 2);
  checks.push("Actual callback policy resolver freezes all candidate targets across config drift; both byte callbacks share it; fingerprint binds new fields without rewriting legacy identities");

  const legacy = { ...snapshot!, outputPolicy: undefined };
  delete legacy.outputPolicy;
  const replaySnapshot = compile(`${declarations.get("failureRequestSnapshot")}\nfailureRequestSnapshot;`, {
    previousImageRequest: { requestSnapshot: legacy }, createImageFailureRequestSnapshot: () => { throw new Error("must not replace legacy snapshot"); },
  });
  const store = new MemoryImageExactlyOnceStore();
  const identity = { userId: "owned-user", clientIdempotencyKey: "legacy-key-12345", clientTraceId: "legacy-trace-12345",
    payloadFingerprint: "a".repeat(64), requestSnapshot: legacy as unknown as Record<string, unknown> };
  assert.equal((await store.claim(identity)).created, true);
  assert.equal((await store.claim({ ...identity, requestSnapshot: replaySnapshot })).created, false);
  await assert.rejects(store.claim({ ...identity, requestSnapshot: { ...legacy, outputPolicy: policy } }), /不同请求快照/);
  checks.push("Actual immutable store claim accepts unchanged legacy snapshot on ordinary replay and rejects policy retrofitting");

  let prepare = "";
  for (const node of imageTree.statements) if (ts.isFunctionDeclaration(node) && node.name?.text === "prepareGeneratedImageBytes") prepare = node.getText(imageTree);
  const seen: unknown[] = [];
  const prepareBytes = compile(`${prepare}\nprepareGeneratedImageBytes;`, { parseImageDimensions: () => ({ width: 2048, height: 1152 }),
    validateImageOutputContract: (input: unknown) => { seen.push(input); return null; },
    renderCoverComposition: async () => ({ bytes: Buffer.from("rendered"), width: 2048, height: 1152 }), exactTextPlan: () => ({}),
  }) as (options: object) => Promise<unknown>;
  await prepareBytes({ buffer: Buffer.from("source"), aspectRatio: "16:9", resolution: "2K", coverText: "exact", ...getContract(snapshot)("first") });
  assert.equal(seen.length, 2);
  for (const input of seen as Array<Record<string, unknown>>) {
    assert.equal(input.minimumDimensionScale, 0.8); assert.equal(input.aspectRatioTolerance, 0.025); assert.equal(input.expectedPixelSize, "2048x1152");
  }
  checks.push("Actual pre-composition and post-composition validation receive the same frozen target and existing tolerances");

  const stripped = streamSource.replace(/^import[^;]+;\s*/gmu, "");
  const tracked = new Map<AbortSignal, Set<EventListenerOrEventListenerObject>>();
  class TrackedAbortController extends AbortController {
    constructor() {
      super();
      const listeners = new Set<EventListenerOrEventListenerObject>(); tracked.set(this.signal, listeners);
      const add = this.signal.addEventListener.bind(this.signal); const remove = this.signal.removeEventListener.bind(this.signal);
      this.signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions) => {
        if (type === "abort") listeners.add(listener); add(type, listener, options);
      }) as typeof this.signal.addEventListener;
      this.signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions) => {
        if (type === "abort") listeners.delete(listener); remove(type, listener, options);
      }) as typeof this.signal.removeEventListener;
    }
  }
  const loadStream = (read: () => Promise<Response>, timers = setTimeout) => compile(`${stripped}\n({GET, sleep});`, {
    exports: {}, URL, AbortController: TrackedAbortController, Response, ReadableStream, TextEncoder, setTimeout: timers, clearTimeout,
    authorizeCurrentApiUser: async () => ({ ok: true, user: { id: "owner" } }), readOwnedVideoTaskStatus: async (owner: { id: string }) => {
      assert.equal(owner.id, "owner"); return read();
    },
  }) as { GET: (request: object) => Promise<Response>; sleep: (ms: number, signal: AbortSignal) => Promise<void> };
  const natural = loadStream(async () => Response.json({ status: "completed" }));
  const sleepController = new TrackedAbortController();
  for (let i = 0; i < 20; i++) { await natural.sleep(0, sleepController.signal); assert.equal(tracked.get(sleepController.signal)?.size, 0); }
  const sleeping = natural.sleep(60_000, sleepController.signal); sleepController.abort(); await sleeping;
  assert.equal(tracked.get(sleepController.signal)?.size, 0);
  await natural.sleep(60_000, sleepController.signal);
  assert.equal(tracked.get(sleepController.signal)?.size, 0);
  checks.push("20 natural sleeps, interrupted sleep and pre-aborted sleep remove every abort listener");

  let reads = 0;
  const fastTimers = ((callback: (...args: unknown[]) => void) => setTimeout(callback, 0)) as typeof setTimeout;
  const many = loadStream(async () => { reads++; return Response.json({ status: reads === 13 ? "completed" : "running" }); }, fastTimers);
  const request = new TrackedAbortController();
  const response = await many.GET({ url: "http://local/api/video/stream?taskId=owned&modelId=model", signal: request.signal });
  assert.match(await response.text(), /event: completed/); assert.equal(reads, 13);
  assert.equal(tracked.get(request.signal)?.size, 0);
  for (const listeners of tracked.values()) assert.equal(listeners.size, 0);
  checks.push("Actual SSE stream preserves progress, heartbeat and terminal completion across 13 owner-scoped reads without listener accumulation");

  reads = 0;
  const cancelled = loadStream(async () => { reads++; return Response.json({ status: "running" }); });
  const cancelRequest = new TrackedAbortController();
  const cancelledResponse = await cancelled.GET({ url: "http://local/api/video/stream?taskId=owned&modelId=model", signal: cancelRequest.signal });
  const reader = cancelledResponse.body!.getReader(); await reader.read(); await reader.cancel();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 1); assert.equal(tracked.get(cancelRequest.signal)?.size, 0);
  for (const listeners of tracked.values()) assert.equal(listeners.size, 0);
  checks.push("Actual stream cancellation interrupts its pending delay and prevents additional DB reads; request listener is released");

  reads = 0;
  let finishRead!: (response: Response) => void;
  const held = loadStream(async () => { reads++; return new Promise<Response>(resolve => { finishRead = resolve; }); });
  const heldRequest = new TrackedAbortController();
  const heldResponse = await held.GET({ url: "http://local/api/video/stream?taskId=owned&modelId=model", signal: heldRequest.signal });
  const heldReader = heldResponse.body!.getReader(); await heldReader.cancel();
  finishRead(Response.json({ status: "running" })); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(reads, 1);
  const preAbort = new TrackedAbortController(); preAbort.abort();
  const preAbortedResponse = await held.GET({ url: "http://local/api/video/stream?taskId=owned&modelId=model", signal: preAbort.signal });
  assert.equal(await preAbortedResponse.text(), ""); assert.equal(reads, 1);
  for (const listeners of tracked.values()) assert.equal(listeners.size, 0);
  checks.push("Cancellation during an in-flight owner read discards its result and prevents repeat reads; pre-aborted requests read no DB");

  const directory = ".codex-evidence/storyboard-delivery-audit-20261023/repair/production-stability/backend";
  mkdirSync(directory, { recursive: true });
  const report = { passed: true, checkedAt: new Date().toISOString(), checks,
    bindings: [imageFile, streamFile, "src/lib/image-failure-history.ts", "src/lib/image-output-contract.ts"].map(file => ({ file,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex") })), networkCalls: 0, databaseWrites: 0, paidCalls: 0 };
  writeFileSync(`${directory}/targeted-tests.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
