import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2, configuredImageDeliveryPixelSizeFor, configuredImagePixelSizeFor,
  imageOutputPolicyVersion, parsePixelSize, validateImageOutputContract } from "../src/lib/image-output-contract";
import { createImageFailureRequestSnapshot, parseImageFailureRequestSnapshot } from "../src/lib/image-failure-history";
import { ImageExactlyOnceError, ImageRequestRejectedError, MemoryImageExactlyOnceStore, strictImagePayloadFingerprint } from "../src/lib/image-exactly-once";
import { parseImageDimensions } from "../src/lib/image-dimensions";
import { validateUploadBuffer } from "../src/lib/file-upload-security";
import { AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES, AUTODL_H3_SELFHOST_PROVIDER, autodlH3ImagePixelSize } from "../src/lib/autodl-h3-selfhost";

const file = "src/app/api/image/generate/route.ts";
const source = readFileSync(file, "utf8");
const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const declarations = new Map<string, string>();
const functions = new Map<string, string>();
const callbacks = new Map<string, string>();
function walk(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(tree));
  if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, node.getText(tree));
  }
  if (ts.isPropertyAssignment(node) && ["prepareEphemeralResult", "persistProviderResult"].includes(node.name.getText(tree))) {
    callbacks.set(node.name.getText(tree), node.initializer.getText(tree));
  }
  ts.forEachChild(node, walk);
}
walk(tree);
const compile = (code: string, context: object) => vm.runInNewContext(ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { Buffer, Error, console, URL, createHash, ...context });
const checks: string[] = [];
const snapshotInput = { surface: "storyboard-workbench", prompt: "original scene", publicModelId: "pm_first", modelName: "model", aspectRatio: "16:9", resolution: "2K",
  referenceImageUrls: [], quotedPriceYuan: 0.1, billingExempt: false, effectivePrompt: "original scene", providerProtocol: "images_generations" as const,
  outputPixelSize: "4096x2304", imageCount: 1 as const, payloadFingerprint: "a".repeat(64) };
const oldPolicy = { ...IMAGE_OUTPUT_POLICY_V1, candidatePixelSizes: { first: "2048x1152" } };
const strictPolicy = { ...IMAGE_OUTPUT_POLICY_V2, candidatePixelSizes: { first: "2048x1152" } };
const candidate = { id: "first", provider: "test", model_name: "test", api_endpoint: "https://example.test", api_protocol_config: {} };
const policyDeclarations = ["previousOutputPolicy", "outputPolicyVersion", "candidateDeliveryTargets", "outputPolicy", "deliveryOutputContract", "deliveryOutputMetadata"];
function policyContext(overrides: object = {}) {
  return { previousImageRequest: null, resumeSnapshot: null, parseImageFailureRequestSnapshot, IMAGE_OUTPUT_POLICY_V1, IMAGE_OUTPUT_POLICY_V2,
    candidates: [candidate], workflowConfig: { appId: "workflow" }, effectiveResolution: "2K", ratio: "16:9", outputPixelSize: "4096x2304",
    expectedImagePixelSize: () => "4096x2304", expectedImageDeliveryPixelSize: () => "2048x1152", configuredImageDeliveryPixelSizeFor,
    toPublicModelId: (_kind: string, id: string) => `pm_${id}`, ImageExactlyOnceError, parsePixelSize, ...overrides };
}
function policyRuntime(overrides: object = {}) {
  return compile(`${policyDeclarations.map(name => declarations.get(name)).join("\n")}\n({outputPolicy,deliveryOutputContract,deliveryOutputMetadata});`, policyContext(overrides)) as {
    outputPolicy: typeof strictPolicy; deliveryOutputContract: (id: string) => { expectedPixelSize: string; minimumDimensionScale: number; aspectRatioTolerance: number };
    deliveryOutputMetadata: (id: string) => Record<string, unknown>;
  };
}
async function main() {
  assert.equal(IMAGE_OUTPUT_POLICY_V1.minimumDimensionScale, 0.8); assert.equal(IMAGE_OUTPUT_POLICY_V2.minimumDimensionScale, 1);
  assert.equal(imageOutputPolicyVersion("image_output_policy.v0"), null);
  const inputsOnly = { request_pixel_size_by_resolution: { "2K": { "16:9": "4096x2304" } }, input_pixel_size_by_resolution: { "2K": { "16:9": "512x288" } } };
  assert.equal(configuredImagePixelSizeFor(inputsOnly, "2K", "16:9"), "4096x2304");
  assert.equal(configuredImageDeliveryPixelSizeFor(inputsOnly, "2K", "16:9"), "2048x1152");
  for (const size of ["1672x941", "1024x576", "garbage", "2048x2048"]) {
    assert.equal(configuredImageDeliveryPixelSizeFor({ output_pixel_size_by_resolution: { "2K": { "16:9": size } } }, "2K", "16:9"), null);
  }
  assert.equal(configuredImageDeliveryPixelSizeFor({ output_pixel_size_by_resolution: { "2K": { "16:9": "2560x1440" } } }, "2K", "16:9"), "2560x1440");
  checks.push("Immutable V1 and strict V2 coexist; delivery ignores provider request/input maps; underspecified native output cannot silently weaken the displayed K tier");

  const deliveryTarget = compile(`${functions.get("expectedImageDeliveryPixelSize")}\nexpectedImageDeliveryPixelSize;`, {
    AUTODL_H3_SELFHOST_PROVIDER, AUTODL_H3_SELFHOST_IMAGE_VERIFIED_OUTPUT_PIXEL_SIZES, configuredImageDeliveryPixelSizeFor,
    DALLE3_SIZE_MAP: { "16:9": "1792x1024", "1:1": "1024x1024" }, SEEDREAM_SIZE_MAP: { "16:9": "2560x1440", "1:1": "2048x2048" },
  }) as (model: object, resolution: string, ratio: string) => string | null;
  assert.equal(autodlH3ImagePixelSize("16:9"), "1280x720");
  assert.equal(deliveryTarget({ provider: AUTODL_H3_SELFHOST_PROVIDER }, "2K", "16:9"), "3640x2048");
  assert.equal(deliveryTarget({ provider: AUTODL_H3_SELFHOST_PROVIDER }, "2K", "1:1"), null);
  assert.equal(deliveryTarget({ model_name: "dall-e-3" }, "1K", "16:9"), "1792x1024");
  assert.equal(deliveryTarget({ provider: "volcengine" }, "2K", "16:9"), "2560x1440");
  checks.push("Actual route delivery resolver reuses H3 verified output 3640x2048 rather than request 1280x720; unverified H3 ratios fail closed; existing native tables preserved");

  const legacyV1 = createImageFailureRequestSnapshot({ ...snapshotInput, payloadFingerprint: undefined })!;
  const legacyV2 = createImageFailureRequestSnapshot(snapshotInput)!;
  const frozenV1 = createImageFailureRequestSnapshot({ ...snapshotInput, outputPolicy: oldPolicy })!;
  const frozenV2 = createImageFailureRequestSnapshot({ ...snapshotInput, outputPolicy: strictPolicy })!;
  for (const snapshot of [legacyV1, legacyV2, frozenV1, frozenV2]) assert.ok(parseImageFailureRequestSnapshot(snapshot));
  assert.equal(parseImageFailureRequestSnapshot({ ...frozenV2, outputPolicy: { ...strictPolicy, minimumDimensionScale: 0.8 } }), null);
  assert.equal(parseImageFailureRequestSnapshot({ ...frozenV1, outputPolicy: { ...oldPolicy, minimumDimensionScale: 1 } }), null);
  assert.equal(policyRuntime().outputPolicy.version, IMAGE_OUTPUT_POLICY_V2.version);
  assert.equal(policyRuntime().deliveryOutputContract("first").expectedPixelSize, "2048x1152");
  for (const snapshot of [legacyV1, legacyV2, frozenV1]) {
    assert.equal(policyRuntime({ previousImageRequest: { requestSnapshot: snapshot } }).outputPolicy.version, IMAGE_OUTPUT_POLICY_V1.version);
  }
  const resumed = policyRuntime({ previousImageRequest: { requestSnapshot: frozenV2 }, resumeSnapshot: frozenV2,
    expectedImageDeliveryPixelSize: () => { throw new Error("NO_CURRENT_CONFIG_DURING_RESUME"); } });
  assert.equal(resumed.deliveryOutputContract("first").expectedPixelSize, "2048x1152");
  assert.equal(resumed.deliveryOutputMetadata("first").minimumOutputWidth, 2048);
  assert.equal(resumed.deliveryOutputMetadata("first").minimumOutputHeight, 1152);
  assert.throws(() => resumed.deliveryOutputContract("unbound"), /合同无法确认/);
  checks.push("Legacy v1/v2 snapshots and V1 policies remain accepted; only new requests use V2; recovery uses the original candidate target and returns honest minimum output metadata");

  const store = new MemoryImageExactlyOnceStore();
  for (const [index, snapshot] of [legacyV1, legacyV2, frozenV1, frozenV2].entries()) {
    const identity = { userId: "owner", clientIdempotencyKey: `strict-policy-key-${index}`, clientTraceId: `strict-policy-trace-${index}`,
      payloadFingerprint: snapshot.payloadFingerprint || "a".repeat(64), requestSnapshot: snapshot as unknown as Record<string, unknown> };
    assert.equal((await store.claim(identity)).created, true);
    const selected = compile(`${declarations.get("failureRequestSnapshot")}\nfailureRequestSnapshot;`, {
      previousImageRequest: { requestSnapshot: snapshot }, createImageFailureRequestSnapshot: () => { throw new Error("MUST_RETAIN_ORIGINAL_SNAPSHOT"); },
    });
    assert.equal((await store.claim({ ...identity, requestSnapshot: selected })).created, false);
    await assert.rejects(store.claim({ ...identity, requestSnapshot: { ...identity.requestSnapshot, prompt: "different" } }), /不同请求快照/);
  }
  checks.push("Actual store claim replays legacy v1/v2 and both frozen policy versions without rewriting snapshots; changed snapshot is rejected");

  const fingerprintBase = { resumeDeliveryOnly: false, previousImageRequest: null, deliveryRequirement: undefined, validationControl: undefined,
    userId: "owner", effectiveMode: "local", modelId: "pm_first", modelConfig: candidate, candidates: [candidate], workflowConfig: {},
    workflowPrompt: "", fullPrompt: "effective prompt", prompt: "original prompt", style: "", exactCoverText: "", ratio: "16:9", effectiveResolution: "2K",
    outputPixelSize: "4096x2304", outputPolicy: strictPolicy, providerProtocol: "images_generations", IMAGE_FIXED_OUTPUT_COUNT: 1,
    body: {}, referenceImageUrls: [], references: [], referenceUsage: "general", costPrice: 0.05, sellingPrice: 0.1,
    parseImageFailureRequestSnapshot, strictImagePayloadFingerprint };
  const fingerprint = (extra: object = {}) => compile(`${declarations.get("generationFingerprint")}\ngenerationFingerprint;`, { ...fingerprintBase, ...extra }) as string;
  const initialFingerprint = fingerprint();
  assert.equal(fingerprint({ previousImageRequest: { requestSnapshot: frozenV2 } }), initialFingerprint);
  assert.notEqual(fingerprint({ prompt: "changed" }), initialFingerprint);
  assert.notEqual(fingerprint({ references: ["https://example.test/other.png"] }), initialFingerprint);
  assert.notEqual(fingerprint({ candidates: [{ ...candidate, api_protocol_config: { changed: true } }] }), initialFingerprint);
  assert.equal(fingerprint({ resumeDeliveryOnly: true, previousImageRequest: { payloadFingerprint: initialFingerprint }, outputPolicy: { ...strictPolicy, candidatePixelSizes: {} } }), initialFingerprint);
  const legacyFingerprint = fingerprint({ previousImageRequest: { requestSnapshot: legacyV2 } });
  assert.equal(fingerprint({ previousImageRequest: { requestSnapshot: legacyV2 }, outputPolicy: oldPolicy }), legacyFingerprint);
  checks.push("Actual fingerprint keeps unchanged V2 ordinary replay, rejects changed prompt/reference/config, preserves legacy algorithm, and freezes accepted V2 recovery identity");

  const helpers = compile(`${functions.get("prepareGeneratedImageBytes")}\nprepareGeneratedImageBytes;`, {
    parseImageDimensions, validateImageOutputContract, ImageRequestRejectedError,
    exactTextPlan: () => ({}), renderCoverComposition: async (bytes: Buffer) => ({ bytes, ...parseImageDimensions(bytes)! }),
  }) as (input: object) => Promise<{ buffer: Buffer }>;
  const strict = policyRuntime().deliveryOutputContract("first");
  const low = await sharp({ create: { width: 1672, height: 941, channels: 3, background: "white" } }).png().toBuffer();
  const correct = await sharp({ create: { width: 2048, height: 1152, channels: 3, background: "white" } }).png().toBuffer();
  for (const size of [[1672, 941], [2048, 1151], [2047, 1152]]) {
    assert.equal(validateImageOutputContract({ width: size[0], height: size[1], resolution: "2K", aspectRatio: "16:9", ...strict })?.code, "IMAGE_OUTPUT_RESOLUTION_MISMATCH");
  }
  assert.equal(validateImageOutputContract({ width: 1672, height: 941, resolution: "2K", aspectRatio: "16:9", expectedPixelSize: "2048x1152", ...IMAGE_OUTPUT_POLICY_V1 }), null);
  await assert.rejects(helpers({ buffer: low, resolution: "2K", aspectRatio: "16:9", ...strict }), (error: unknown) => error instanceof ImageRequestRejectedError);
  await helpers({ buffer: correct, resolution: "2K", aspectRatio: "16:9", ...strict, coverText: "exact" });
  checks.push("Actual byte validator rejects undersized strict output including either dimension one pixel short; original V1 1672x941 acceptance remains unchanged; exact target and composition pass");

  const callbackContext = { candidates: [candidate], effectiveResolution: "2K", ratio: "16:9", costPrice: 0.05, effectiveMode: "local", resumeSnapshot: null,
    workflowConfig: {}, resolveImageResolutionPrice: () => 0.05, ImageExactlyOnceError, decodeInlineImage: (value: string) => ({ buffer: Buffer.from(value.split(",")[1], "base64"), contentType: "image/png" }),
    validateUploadBuffer, AUTODL_H3_IMAGE_CONTENT_TYPES: ["image/png"], prepareGeneratedImageBytes: helpers, deliveryOutputContract: () => strict,
    exactCoverText: "", createImageEphemeralDelivery: async () => { throw new Error("UNDERSIZED_MUST_NOT_DELIVER"); },
    providerMediaUrl: (url: string) => url, ImageRequestRejectedError, AUTODL_H3_SELFHOST_PROVIDER,
    readPublicImageResult: async () => ({ buffer: low, contentType: "image/png", finalUrl: "https://example.test/result.png" }),
    AUTODL_H3_IMAGE_MAX_BYTES: 20_000_000, AUTODL_H3_IMAGE_RESULT_TIMEOUT_MS: 1000 };
  const result = { selectedModelId: "first", selectedCostPrice: 0.05, mode: "local", provider: "test", apiEndpoint: candidate.api_endpoint,
    inlineDataUrl: `data:image/png;base64,${low.toString("base64")}`, rawUrl: "https://example.test/result.png" };
  for (const name of ["prepareEphemeralResult", "persistProviderResult"]) {
    const callback = compile(`(${callbacks.get(name)});`, callbackContext) as (...args: unknown[]) => Promise<unknown>;
    await assert.rejects(callback(result, { recordId: "original" }), (error: unknown) => error instanceof ImageRequestRejectedError);
  }
  checks.push("Both actual inline and URL provider-result callbacks raise the existing typed dimension rejection before delivery/storage; no new billing path or generation call introduced");

  const directory = ".codex-evidence/storyboard-delivery-audit-20261023/repair/production-hardening/backend";
  mkdirSync(directory, { recursive: true });
  const report = { passed: true, checks, checkedAt: new Date().toISOString(), networkCalls: 0, databaseWrites: 0, paidCalls: 0,
    bindings: [file, "src/lib/image-failure-history.ts", "src/lib/image-output-contract.ts"].map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") })) };
  writeFileSync(`${directory}/strict-output-tests.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
