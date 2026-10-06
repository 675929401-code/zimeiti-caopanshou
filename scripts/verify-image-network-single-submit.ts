import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  ImageExactlyOnceError,
  MemoryImageExactlyOnceStore,
  runImageExactlyOnce,
} from "@/lib/image-exactly-once";
import { isRetryableImageUpstreamStatus } from "@/lib/image-model-fallback";
import { buildSecureSkillImagePayload } from "@/lib/secure-skill-image-adapter";
import { imageReferenceContractIssue, resolveImageProviderContract } from "@/lib/image-provider-contract";
import { resolveImageResolutionPrice } from "@/lib/image-resolution-pricing";
import {
  ImageUpstreamResponseTooLargeError,
  parseImageUpstreamResponse,
  readImageUpstreamResponseText,
} from "@/lib/image-upstream-response";
import { ImageRequestRejectedError } from "@/lib/image-exactly-once";

// Execute the real route's transport, candidate adapter and candidate loop.
// Only network, storage and environment bindings are replaced with in-memory fixtures.
const routeSource = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const tree = ts.createSourceFile("image-route.ts", routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set([
  "SIZE_MAP", "DALLE3_SIZE_MAP", "SEEDREAM_SIZE_MAP", "RESOLUTION_SIZE_MAPS",
  "safeUpstreamTarget", "summarizeFetchCause", "fetchImageUpstream",
  "summarizeUpstreamImageError", "ImageCandidateFailure", "generateLocalImageCandidate", "extractImageUrlFromChatResponse",
  "hasImageUpstreamAcceptanceSignal", "explicitImageProviderRejection",
]);
const definitions = tree.statements.filter((node) => {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return names.has(node.name.text);
  return ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
    ts.isIdentifier(declaration.name) && names.has(declaration.name.text));
}).map((node) => node.getText(tree));
assert.equal(definitions.length, names.size, "fixture must load every actual transport dependency");
let submitCallback = "";
function findSubmitCallback(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "runImageExactlyOnce") {
    const input = node.arguments[0];
    if (input && ts.isObjectLiteralExpression(input)) {
      const callback = input.properties.find((property) => ts.isPropertyAssignment(property)
        && property.name.getText(tree) === "submitOnce");
      if (callback && ts.isPropertyAssignment(callback)) submitCallback = callback.initializer.getText(tree);
    }
  }
  ts.forEachChild(node, findSubmitCallback);
}
findSubmitCallback(tree);
assert.ok(submitCallback, "actual route submitOnce callback missing");
const executable = ts.transpileModule(`${definitions.join("\n")}\n(${submitCallback});`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Scenario = "disconnect" | "timeout" | "502" | "503" | "504" | "invalid-json" | "empty-result" | "queued-result" | "success";
async function exercise(scenario: Scenario, strict: boolean) {
  let posts = 0;
  let persists = 0;
  const traces: Array<Record<string, unknown>> = [];
  const store = new MemoryImageExactlyOnceStore();
  const primary = {
    id: "fixture-primary", name: "Fixture image model", model_name: "fixture-image", provider: "openai_compat",
    api_endpoint: "https://fixture-primary.invalid/v1", api_key: "fixture-key", cost_price: 0.01,
    supports_image_input: false,
  };
  const callback = runInNewContext(executable, {
    URL, Error, TypeError, Response, Blob, FormData, Uint8Array, AbortSignal,
    console: { error() {}, warn() {} },
    setTimeout: (handler: () => void) => { handler(); return 0; },
    fetch: async (url: string, init: RequestInit) => {
      assert.equal(init.method, "POST");
      posts++;
      assert.match(url, /^https:\/\/fixture-primary\.invalid\//u, "fallback channel must not receive an uncertain task");
      if (scenario === "disconnect") throw new TypeError("simulated connection reset after request write");
      if (scenario === "timeout") throw new DOMException("simulated timeout after request write", "TimeoutError");
      if (["502", "503", "504"].includes(scenario)) return Response.json({ error: { message: "fixture gateway failure" } }, { status: Number(scenario) });
      if (scenario === "invalid-json") return new Response("{broken response", { status: 200 });
      if (scenario === "queued-result") return Response.json({ id: "fixture-queued", status: "queued" });
      if (scenario === "empty-result") return Response.json({ data: [] });
      return Response.json({ data: [{ url: "https://fixture-media.invalid/image.png" }] });
    },
    resolveProviderSecret: () => "fixture-key",
    resolveImageProviderContract,
    resolveImageResolutionPrice,
    imageReferenceContractIssue,
    buildSecureSkillImagePayload,
    readImageUpstreamResponseText,
    parseImageUpstreamResponse,
    ImageUpstreamResponseTooLargeError,
    ImageRequestRejectedError,
    assertAutodlH3SelfhostModelBinding: () => false,
    buildOpenAIEndpoint: (base: string, suffix: string) => `${base}/${suffix}`,
    isRetryableImageUpstreamStatus,
    AUTODL_H3_SELFHOST_PROVIDER: "autodl_h3_selfhost",
    effectiveMode: "local", ratio: "1:1", effectiveResolution: "1K", references: [],
    identityReferenceOnly: false, fullPrompt: "offline fixture", h3OperationId: "fixture-operation",
    strictImageRequest: strict, userId: "fixture-user", traceId: "fixture-trace", traceNodeId: "", traceNodeTitle: "",
    // The production route intentionally pins one provider candidate per user
    // submission. A second relay may only be tried after a new user action.
    candidates: [primary],
    writeImageTrace: async (entry: Record<string, unknown>) => { traces.push(entry); },
    persistGeneratedImage: async () => {
      persists++;
      return {
        storageUri: "object://tencent_cos/fixture.png", storageKey: "fixture.png", storageProvider: "tencent_cos",
        fileName: "fixture.png", fileSize: 10, contentType: "image/png", source: "image-generation",
        dimensions: { width: 1024, height: 1024 },
      };
    },
  }) as () => Promise<Record<string, unknown>>;
  const request = {
    store, userId: "fixture-user", clientIdempotencyKey: `fixture-${scenario}-${strict}`,
    clientTraceId: `fixture-trace-${scenario}-${strict}`, payloadFingerprint: `fixture-payload-${scenario}`,
    submitOnce: callback,
    persistProviderResult: async (result: Record<string, unknown>) => {
      persists++;
      return { imageUrl: result.rawUrl, persisted: true };
    },
  };
  if (scenario === "success") {
    const generated = await runImageExactlyOnce(request);
    assert.equal(generated.record.state, "completed");
    const replay = await runImageExactlyOnce(request);
    assert.equal(replay.replayed, true);
    assert.equal(persists, 1);
  } else {
    await assert.rejects(runImageExactlyOnce(request));
    const record = await store.get(request);
    assert.equal(record?.state, "failed_unknown", "uncertain supplier outcome must remain recorded");
    await assert.rejects(runImageExactlyOnce(request), (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_FAIL_CLOSED");
    assert.equal(persists, 0);
    assert.equal(traces.some((trace) => trace.phase === "channel_fallback_started"), false);
  }
  assert.equal(posts, 1, `${scenario}/${strict}: transport + candidate loop + replay must produce exactly one POST`);
  return { scenario, strict, upstreamPostCount: posts, storedState: (await store.get(request))?.state };
}

async function main() {
  const results = [];
  for (const scenario of ["disconnect", "timeout", "502", "503", "504", "invalid-json", "empty-result", "queued-result", "success"] as Scenario[]) {
    for (const strict of [false, true]) results.push(await exercise(scenario, strict));
  }
  console.log(JSON.stringify({ ok: true, mode: "actual-route-functions-with-in-memory-io", networkRequests: 0, realDatabaseWrites: 0, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : "IMAGE_NETWORK_SINGLE_SUBMIT_VERIFICATION_FAILED");
  process.exitCode = 1;
});
