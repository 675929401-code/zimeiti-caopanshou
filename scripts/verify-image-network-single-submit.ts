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
import {
  buildSecureSkillAsyncImagePayload,
  parseSecureSkillAsyncImageTask,
} from "@/lib/secure-skill-async-image-adapter";
import { imageReferenceContractIssue, resolveImageProviderContract } from "@/lib/image-provider-contract";
import { resolveImageResolutionPrice } from "@/lib/image-resolution-pricing";
import { buildApiRootEndpoint, buildOpenAIEndpoint } from "@/lib/api-endpoints";
import { validateUploadBuffer } from "@/lib/file-upload-security";
import { ImageGenerationInputError } from "@/lib/image-generation-request";
import {
  ImageUpstreamResponseTooLargeError,
  parseImageUpstreamResponse,
  readImageUpstreamResponseText,
} from "@/lib/image-upstream-response";
import { ImageRequestRejectedError } from "@/lib/image-exactly-once";
import {
  createImageProviderSubmissionReceipt,
  prepareImageProviderRequest,
} from "@/lib/image-provider-request-audit";
import { createHash } from "node:crypto";

// Execute the real route's transport, candidate adapter and candidate loop.
// Only network, storage and environment bindings are replaced with in-memory fixtures.
const routeSource = readFileSync("src/app/api/image/generate/route.ts", "utf8");
const tree = ts.createSourceFile("image-route.ts", routeSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const names = new Set([
  "DALLE3_SIZE_MAP", "SEEDREAM_SIZE_MAP",
  "safeUpstreamTarget", "summarizeFetchCause", "fetchImageUpstream",
  "fetchAuditedImageProviderPost", "readAuditedImageProviderResponseText",
  "loadReferenceImage", "summarizeUpstreamImageError", "ImageCandidateFailure", "generateLocalImageCandidate", "extractImageUrlFromChatResponse",
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
const executable = ts.transpileModule(`${definitions.join("\n")}\n({ submitCallback: (${submitCallback}), generateLocalImageCandidate, fetchAuditedImageProviderPost, readAuditedImageProviderResponseText, summarizeUpstreamImageError, safeUpstreamTarget });`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

type Scenario = "disconnect" | "timeout" | "502" | "503" | "504" | "invalid-json" | "empty-result" | "queued-result" | "success";
async function exercise(scenario: Scenario, strict: boolean) {
  let posts = 0;
  let persists = 0;
  let admissionClaims = 0;
  let admissionReleases = 0;
  const traces: Array<Record<string, unknown>> = [];
  const store = new MemoryImageExactlyOnceStore();
  const primary = {
    id: "fixture-primary", name: "Fixture image model", model_name: "fixture-image", provider: "openai_compat",
    api_endpoint: "https://fixture-primary.invalid/v1", api_key: "fixture-key", cost_price: 0.01,
    supports_image_input: false,
    api_protocol_config: { protocol: "images_generations", reference_transport: "none" },
  };
  const runtime = runInNewContext(executable, {
    URL, Error, TypeError, Response, Request, Blob, FormData, Buffer, Uint8Array, TextDecoder, AbortSignal,
    createHash, prepareImageProviderRequest, createImageProviderSubmissionReceipt,
    console: { error() {}, warn() {} },
    setTimeout: (handler: () => void) => { handler(); return 0; },
    fetch: async (input: string | Request, init: RequestInit = {}) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.equal(request.method, "POST");
      posts++;
      assert.match(request.url, /^https:\/\/fixture-primary\.invalid\//u, "fallback channel must not receive an uncertain task");
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
    buildSecureSkillAsyncImagePayload,
    parseSecureSkillAsyncImageTask,
    buildApiRootEndpoint,
    validateUploadBuffer,
    ImageGenerationInputError,
    readImageUpstreamResponseText,
    parseImageUpstreamResponse,
    ImageUpstreamResponseTooLargeError,
    ImageRequestRejectedError,
    acquireProviderAdmission: async () => {
      admissionClaims += 1;
      return { release: async () => { admissionReleases += 1; } };
    },
    holdProviderAdmissionUntilResponseEnds: async (response: Response) => response,
    imageAdmissionRejection: () => null,
    assertAutodlH3SelfhostModelBinding: () => false,
    configuredImagePixelSizeFor: () => "1024x1024",
    buildOpenAIEndpoint,
    isRetryableImageUpstreamStatus,
    AUTODL_H3_SELFHOST_PROVIDER: "autodl_h3_selfhost",
    effectiveMode: "local", ratio: "1:1", effectiveResolution: "1K", references: [], prompt: "offline fixture",
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
  }) as { submitCallback: () => Promise<Record<string, unknown>> };
  const callback = runtime.submitCallback;
  const request = {
    store, userId: "fixture-user", clientIdempotencyKey: `fixture-${scenario}-${strict}`,
    clientTraceId: `fixture-trace-${scenario}-${strict}`, payloadFingerprint: `fixture-payload-${scenario}`,
    submitOnce: callback,
    persistProviderResult: async (result: Record<string, unknown>) => {
      persists++;
      return { imageUrl: result.rawUrl, persisted: true };
    },
  };
  let firstFailure = "";
  if (scenario === "success") {
    const generated = await runImageExactlyOnce(request);
    assert.equal(generated.record.state, "completed");
    const replay = await runImageExactlyOnce(request);
    assert.equal(replay.replayed, true);
    assert.equal(persists, 1);
  } else {
    await assert.rejects(runImageExactlyOnce(request), (error: unknown) => {
      firstFailure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return true;
    });
    const record = await store.get(request);
    assert.equal(record?.state, "failed_unknown", "uncertain supplier outcome must remain recorded");
    await assert.rejects(runImageExactlyOnce(request), (error: unknown) => error instanceof ImageExactlyOnceError
      && error.code === "IMAGE_IDEMPOTENCY_FAIL_CLOSED");
    assert.equal(persists, 0);
    assert.equal(traces.some((trace) => trace.phase === "channel_fallback_started"), false);
  }
  assert.equal(posts, 1, `${scenario}/${strict}: transport + candidate loop + replay must produce exactly one POST; firstFailure=${firstFailure || "none"}`);
  assert.equal(admissionClaims, 1, `${scenario}/${strict}: the single provider POST must claim exactly one admission lease`);
  assert.equal(admissionReleases, 1, `${scenario}/${strict}: the admission lease must be released exactly once`);
  return { scenario, strict, upstreamPostCount: posts, storedState: (await store.get(request))?.state };
}

type AuditedRuntime = {
  generateLocalImageCandidate: (options: Record<string, unknown>) => Promise<string>;
  fetchAuditedImageProviderPost: (options: Record<string, unknown>) => Promise<{ response: Response; dispatchReceipt: unknown }>;
  readAuditedImageProviderResponseText: (options: Record<string, unknown>) => Promise<string>;
  summarizeUpstreamImageError: (raw: string) => string;
  safeUpstreamTarget: (url: string) => string;
};

function auditedRuntime(fetchImpl: typeof fetch) {
  return runInNewContext(executable, {
    URL, Error, TypeError, Response, Request, Blob, FormData, Buffer, Uint8Array, TextDecoder, AbortSignal,
    createHash, prepareImageProviderRequest, createImageProviderSubmissionReceipt,
    console: { error() {}, warn() {} }, fetch: fetchImpl,
    setTimeout: (handler: () => void) => { handler(); return 0; },
    resolveProviderSecret: () => "fixture-key",
    resolveImageProviderContract, imageReferenceContractIssue,
    buildSecureSkillImagePayload, buildSecureSkillAsyncImagePayload, parseSecureSkillAsyncImageTask,
    buildApiRootEndpoint, buildOpenAIEndpoint, validateUploadBuffer,
    readImageUpstreamResponseText, parseImageUpstreamResponse, ImageUpstreamResponseTooLargeError,
    ImageRequestRejectedError, ImageGenerationInputError,
    safeFetch: async () => { throw new Error("ZERO_NETWORK_REFERENCE_FETCH_FORBIDDEN"); },
    assertAutodlH3SelfhostModelBinding: () => false,
    configuredImagePixelSizeFor: () => "1024x576",
    isRetryableImageUpstreamStatus,
    AUTODL_H3_SELFHOST_PROVIDER: "autodl_h3_selfhost",
  }) as AuditedRuntime;
}

async function exerciseAuditedProtocols() {
  const protocols = [
    "google_generate_content", "chat_completions", "images_generations",
    "images_generations_async", "images_edits",
  ] as const;
  const results: Array<Record<string, unknown>> = [];
  for (const protocol of protocols) {
    let posts = 0;
    const requests: Request[] = [];
    const dispatchReceipts: Array<Record<string, unknown>> = [];
    const submissionReceipts: Array<Record<string, unknown>> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      assert.equal(request.method, "POST");
      posts += 1;
      requests.push(request.clone());
      const response = protocol === "google_generate_content"
        ? { request_id: `ack-${protocol}`, candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }] } }] }
        : protocol === "chat_completions"
          ? { request_id: `ack-${protocol}`, choices: [{ message: { images: [{ image_url: { url: "https://media.invalid/chat.png" } }] } }] }
          : protocol === "images_generations_async"
            ? { task_id: `ack-${protocol}`, status: "succeeded", data: [{ url: "https://media.invalid/async.png" }] }
            : { request_id: `ack-${protocol}`, data: [{ url: `https://media.invalid/${protocol}.png` }] };
      return Response.json(response);
    };
    const runtime = auditedRuntime(fetchImpl as typeof fetch);
    const receiptContext = {
      recordProviderDispatchReceipt: async (receipt: Record<string, unknown>) => {
        dispatchReceipts.push(receipt);
        return receipt;
      },
      recordProviderSubmissionReceipt: async (receipt: Record<string, unknown>) => {
        submissionReceipts.push(receipt);
        return receipt;
      },
    };
    const referenceImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    const model = {
      id: `fixture-${protocol}`, name: `Fixture ${protocol}`, model_name: `fixture-${protocol}`,
      provider: "openai_compat", api_endpoint: "https://fixture-protocol.invalid/v1",
      api_key: "fixture-key", cost_price: 0.01,
      supports_image_input: protocol === "images_edits",
      api_protocol_config: protocol === "images_edits"
        ? { protocol, reference_transport: "edits_multipart_single" }
        : { protocol },
    };
    let imageUrl: string;
    try {
      imageUrl = await runtime.generateLocalImageCandidate({
        model, ratio: "16:9", effectiveResolution: "1K",
        references: protocol === "images_edits" ? [referenceImage] : [],
        identityReferenceOnly: false, userPrompt: "fixed protocol fixture",
        fullPrompt: "fixed protocol fixture", idempotencyKey: `fixture-${protocol}-idempotency`,
        receiptContext, strictSingleSubmit: true,
      });
    } catch (error) {
      throw new Error(`${protocol}: ${error instanceof Error ? error.message : String(error)}`);
    }
    assert.match(imageUrl, /^(?:https:\/\/|data:image\/)/u);
    assert.equal(posts, 1, `${protocol}: exactly one provider POST required`);
    assert.equal(requests.length, 1, `${protocol}: actual Request required`);
    assert.equal(dispatchReceipts.length, 1, `${protocol}: dispatch receipt required`);
    assert.equal(submissionReceipts.length, 1, `${protocol}: submission receipt required`);
    assert.equal(dispatchReceipts[0].providerProtocol, protocol);
    assert.equal(submissionReceipts[0].providerProtocol, protocol);
    results.push({ protocol, posts, requestContentType: requests[0].headers.get("content-type") });
  }

  let coverPosts = 0;
  const coverDispatch: Array<Record<string, unknown>> = [];
  const coverSubmission: Array<Record<string, unknown>> = [];
  const coverRuntime = auditedRuntime((async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(request.method, "POST");
    coverPosts += 1;
    return Response.json({ request_id: "cover-workflow-request", output: "accepted" });
  }) as typeof fetch);
  const receiptContext = {
    recordProviderDispatchReceipt: async (receipt: Record<string, unknown>) => { coverDispatch.push(receipt); return receipt; },
    recordProviderSubmissionReceipt: async (receipt: Record<string, unknown>) => { coverSubmission.push(receipt); return receipt; },
  };
  const submitted = await coverRuntime.fetchAuditedImageProviderPost({
    url: "https://fixture-workflow.invalid/run?token=must-not-persist",
    init: { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture" }, body: "{\"prompt\":\"fixed\"}" },
    providerProtocol: "cover_workflow",
    projection: {
      userPromptSha256: createHash("sha256").update("fixed").digest("hex"),
      effectivePromptSha256: createHash("sha256").update("fixed").digest("hex"),
      modelIdSha256: createHash("sha256").update("cover-workflow").digest("hex"),
      aspectRatio: "16:9", resolution: "1K", imageCount: 1, referenceCount: 0,
    },
    receiptContext,
  });
  await coverRuntime.readAuditedImageProviderResponseText({
    response: submitted.response, maximumBytes: 1024 * 1024,
    dispatchReceipt: submitted.dispatchReceipt, receiptContext,
  });
  assert.equal(coverPosts, 1);
  assert.equal(coverDispatch.length, 1);
  assert.equal(coverSubmission.length, 1);
  assert.equal(coverDispatch[0].providerProtocol, "cover_workflow");
  assert.equal(coverSubmission[0].providerProtocol, "cover_workflow");
  results.push({ protocol: "cover_workflow", posts: coverPosts, requestContentType: "application/json" });

  let zeroReferencePosts = 0;
  const zeroReferenceRuntime = auditedRuntime((async () => {
    zeroReferencePosts += 1;
    return Response.json({ data: [{ url: "https://should-never-run.invalid/image.png" }] });
  }) as typeof fetch);
  let zeroReferenceDispatches = 0;
  await assert.rejects(() => zeroReferenceRuntime.generateLocalImageCandidate({
    model: {
      id: "fixture-edits-zero", name: "Fixture edits zero", model_name: "fixture-edits-zero",
      provider: "openai_compat", api_endpoint: "https://fixture-protocol.invalid/v1", api_key: "fixture-key",
      supports_image_input: true,
      api_protocol_config: { protocol: "images_edits", reference_transport: "edits_multipart_single" },
    },
    ratio: "16:9", effectiveResolution: "1K", references: [], identityReferenceOnly: false,
    userPrompt: "fixed protocol fixture", fullPrompt: "fixed protocol fixture",
    idempotencyKey: "fixture-edits-zero-idempotency", strictSingleSubmit: true,
    receiptContext: {
      recordProviderDispatchReceipt: async (receipt: Record<string, unknown>) => { zeroReferenceDispatches += 1; return receipt; },
      recordProviderSubmissionReceipt: async (receipt: Record<string, unknown>) => receipt,
    },
  }), (error: unknown) => error instanceof ImageGenerationInputError
    && error.status === 422 && error.code === "IMAGE_REFERENCE_REQUIRED");
  assert.equal(zeroReferencePosts, 0, "images_edits without references must fail before provider POST");
  assert.equal(zeroReferenceDispatches, 0, "images_edits without references must fail before dispatch receipt");

  const malicious = [
    "https://evil.invalid/path?token=secret-query",
    "Bearer bearer-secret",
    ["eyJabcdefghijk", "abcdefghijklmnop", "signaturevalue"].join("."),
    "data:image/png;base64," + "A".repeat(160),
    "api_key=top-secret",
  ].join(" ");
  const summary = zeroReferenceRuntime.summarizeUpstreamImageError(JSON.stringify({ error: { message: malicious } }));
  for (const forbidden of ["evil.invalid", "secret-query", "bearer-secret", "eyJabcdefghijk", "AAAAAA", "top-secret"]) {
    assert.equal(summary.includes(forbidden), false, `SAFE_UPSTREAM_SUMMARY_LEAKED:${forbidden}`);
  }
  assert.equal(zeroReferenceRuntime.safeUpstreamTarget([
    "https://", "user", ":", "pass", "@", "evil.invalid", "/private/token", "?", "api_key", "=", "secret",
  ].join("")), "https://evil.invalid");
  const embeddedRuntime = auditedRuntime((async () => Response.json({ error: { message: malicious } })) as typeof fetch);
  let embeddedDispatches = 0;
  let embeddedSubmissions = 0;
  await assert.rejects(() => embeddedRuntime.generateLocalImageCandidate({
    model: {
      id: "fixture-embedded-error", name: "Fixture embedded error", model_name: "fixture-embedded-error",
      provider: "openai_compat", api_endpoint: "https://fixture-protocol.invalid/v1", api_key: "fixture-key",
      supports_image_input: false,
      api_protocol_config: { protocol: "images_generations", reference_transport: "none" },
    },
    ratio: "16:9", effectiveResolution: "1K", references: [], identityReferenceOnly: false,
    userPrompt: "fixed protocol fixture", fullPrompt: "fixed protocol fixture",
    idempotencyKey: "fixture-embedded-error-idempotency", strictSingleSubmit: true,
    receiptContext: {
      recordProviderDispatchReceipt: async (receipt: Record<string, unknown>) => { embeddedDispatches += 1; return receipt; },
      recordProviderSubmissionReceipt: async (receipt: Record<string, unknown>) => { embeddedSubmissions += 1; return receipt; },
    },
  }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return !["evil.invalid", "secret-query", "bearer-secret", "eyJabcdefghijk", "AAAAAA", "top-secret"]
      .some(forbidden => message.includes(forbidden));
  });
  assert.equal(embeddedDispatches, 1);
  assert.equal(embeddedSubmissions, 1);
  return {
    results, zeroReferenceProviderPosts: zeroReferencePosts, safeSummaryVerified: true,
    embeddedErrorDispatches: embeddedDispatches, embeddedErrorSubmissions: embeddedSubmissions,
  };
}

async function main() {
  const results = [];
  for (const scenario of ["disconnect", "timeout", "502", "503", "504", "invalid-json", "empty-result", "queued-result", "success"] as Scenario[]) {
    for (const strict of [false, true]) results.push(await exercise(scenario, strict));
  }
  const protocolCoverage = await exerciseAuditedProtocols();
  console.log(JSON.stringify({ ok: true, mode: "actual-route-functions-with-in-memory-io", networkRequests: 0, realDatabaseWrites: 0, results, protocolCoverage }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : "IMAGE_NETWORK_SINGLE_SUBMIT_VERIFICATION_FAILED");
  process.exitCode = 1;
});
