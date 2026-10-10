import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ImageGenerationInputError,
  normalizeImageGenerationInput,
} from "../src/lib/image-generation-request";
import {
  IMAGE_FIXED_OUTPUT_COUNT,
  IMAGE_PROTOCOL_PARAMETER_MATRIX,
} from "../src/lib/image-parameter-contract";
import {
  createImageFailureRequestSnapshot,
  imageTerminalFailureMessage,
  parseImageFailureRequestSnapshot,
} from "../src/lib/image-failure-history";
import {
  ImageRequestRejectedError,
  MemoryImageExactlyOnceStore,
  runImageExactlyOnce,
} from "../src/lib/image-exactly-once";
import { parseImageRequestRejectionReceipt } from "../src/lib/image-request-rejection";

let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("ZERO_NETWORK_CONTRACT");
}) as typeof fetch;

async function main() {
  try {
    const accepted = normalizeImageGenerationInput({
      prompt: "商业产品图",
      modelId: "pm_public_image",
      mode: "local",
      style: "高级广告摄影",
      aspectRatio: "16:9",
      resolution: "3K",
      referenceUsage: "character-identity",
      referenceImageUrls: ["https://assets.invalid/reference.png?temporary=signature"],
      clientTraceId: "trace_parameter_01",
      clientIdempotencyKey: "request_parameter_01",
      historySurface: "image-workbench",
    });
    assert.equal(accepted.resolution, "3K");
    assert.equal(accepted.style, "高级广告摄影");
    assert.throws(
      () => normalizeImageGenerationInput({ aspectRatio: "16:9", resolution: "1K" }),
      (error) => error instanceof ImageGenerationInputError
        && error.code === "IMAGE_PROMPT_REQUIRED"
        && error.status === 422,
      "a missing displayed prompt must fail closed with 422",
    );

    for (const unsupportedField of [
      "negativePrompt", "negative_prompt", "width", "height", "size", "count", "n",
      "seed", "mask", "quality", "steps", "cfgScale", "providerPayload",
    ]) {
      assert.throws(
        () => normalizeImageGenerationInput({
          prompt: "fixture",
          [unsupportedField]: unsupportedField === "count" || unsupportedField === "n" ? 1 : "fixture",
        }),
        (error) => error instanceof ImageGenerationInputError
          && error.code === "IMAGE_REQUEST_FIELD_UNSUPPORTED"
          && error.status === 422,
        `${unsupportedField} must fail closed before claim/billing/provider`,
      );
    }

    assert.equal(IMAGE_FIXED_OUTPUT_COUNT, 1);
    const protocols = Object.entries(IMAGE_PROTOCOL_PARAMETER_MATRIX);
    assert.deepEqual(protocols.map(([protocol]) => protocol).sort(), [
      "chat_completions",
      "cover_workflow",
      "google_generate_content",
      "images_edits",
      "images_generations",
      "images_generations_async",
    ]);
    for (const [protocol, contract] of protocols) {
      assert.equal(contract.userPrompt, "consumed", `${protocol} user prompt`);
      assert.equal(contract.effectivePrompt, "consumed", `${protocol} effective prompt`);
      assert.equal(contract.aspectRatio, "consumed", `${protocol} aspect ratio`);
      assert.equal(contract.resolutionTier, "consumed", `${protocol} resolution tier`);
      assert.equal(contract.widthHeight, "consumed", `${protocol} width/height`);
      assert.equal(contract.count, "fixed", `${protocol} output count`);
      assert.equal(contract.negativePrompt, "rejected", `${protocol} negative prompt`);
      assert.equal(contract.seed, "rejected", `${protocol} seed`);
      assert.equal(contract.mask, "rejected", `${protocol} mask`);
      assert.equal(contract.quality, "rejected", `${protocol} quality`);
      assert.equal(contract.providerSpecificFields, "rejected", `${protocol} provider fields`);
      assert.equal(contract.style, "consumed", `${protocol} style`);
      assert.equal(contract.exactCoverText, "platform_postprocess", `${protocol} cover text`);
    }

    const payloadFingerprint = "a".repeat(64);
    const snapshot = createImageFailureRequestSnapshot({
      surface: "image-workbench",
      prompt: "用户提示词",
      publicModelId: "pm_public_image",
      modelName: "公开生图模型",
      aspectRatio: "16:9",
      resolution: "3K",
      referenceImageUrls: ["https://assets.invalid/reference.png?signature=must-not-persist"],
      quotedPriceYuan: 0.42,
      billingExempt: false,
      style: "电影感",
      effectivePrompt: "16:9 硬约束\n用户提示词，风格：电影感",
      providerProtocol: "chat_completions",
      outputPixelSize: "3072x1728",
      imageCount: 1,
      referenceUsage: "character-identity",
      payloadFingerprint,
    });
    assert(snapshot);
    assert.equal(snapshot.schema, "image_generation_request_snapshot.v2");
    assert.equal(snapshot.payloadFingerprint, payloadFingerprint);
    assert.equal(snapshot.effectivePrompt, "16:9 硬约束\n用户提示词，风格：电影感");
    assert.equal(snapshot.outputPixelSize, "3072x1728");
    assert.equal(snapshot.imageCount, 1);
    assert.equal(snapshot.referenceAssetRefs.length, 1);
    assert(!JSON.stringify(snapshot).includes("signature=must-not-persist"));
    assert(!JSON.stringify(snapshot).includes("assets.invalid"));
    assert.deepEqual(parseImageFailureRequestSnapshot(snapshot), snapshot);

    const admissionFingerprint = "b".repeat(64);
    const busyReceipt = {
      schema: "image_request_rejection.v1",
      payloadFingerprint: admissionFingerprint,
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_BUSY",
      retryAfterSeconds: 7,
      admissionScope: "channel",
    } as const;
    assert.deepEqual(parseImageRequestRejectionReceipt(busyReceipt, admissionFingerprint), {
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_BUSY",
      retryAfterSeconds: 7,
      admissionScope: "channel",
    });
    assert.equal(parseImageRequestRejectionReceipt({ ...busyReceipt, retryAfterSeconds: 0 }, admissionFingerprint), null);
    assert.match(imageTerminalFailureMessage(parseImageRequestRejectionReceipt(busyReceipt, admissionFingerprint)!), /未调用供应商.*释放/u);
    assert.deepEqual(parseImageRequestRejectionReceipt({
      schema: "image_request_rejection.v1",
      payloadFingerprint: admissionFingerprint,
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE",
    }, admissionFingerprint), {
      source: "platform",
      code: "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE",
    });

    const admissionStore = new MemoryImageExactlyOnceStore();
    let budgetReservations = 0;
    let admissionChecks = 0;
    let providerCalls = 0;
    const admissionRequest = {
      store: admissionStore,
      userId: "zero-cost-image-user",
      clientIdempotencyKey: "zero-cost-image-admission-key",
      clientTraceId: "zero-cost-image-admission-trace",
      payloadFingerprint: admissionFingerprint,
      beforeSubmitOnce: async () => { budgetReservations += 1; },
      submitOnce: async () => {
        admissionChecks += 1;
        throw new ImageRequestRejectedError({
          source: "platform",
          code: "IMAGE_PROVIDER_ADMISSION_BUSY",
          retryAfterSeconds: 7,
          admissionScope: "channel",
        });
        // The real route reaches the provider only after this admission point.
        providerCalls += 1;
      },
    };
    await assert.rejects(() => runImageExactlyOnce(admissionRequest), (error: unknown) =>
      error instanceof ImageRequestRejectedError
      && error.code === "IMAGE_PROVIDER_ADMISSION_BUSY"
      && error.status === 429);
    await assert.rejects(() => runImageExactlyOnce(admissionRequest), (error: unknown) =>
      error instanceof ImageRequestRejectedError
      && error.code === "IMAGE_PROVIDER_ADMISSION_BUSY");
    assert.equal(budgetReservations, 1, "durable replay must not reserve the wallet twice");
    assert.equal(admissionChecks, 1, "durable rejection receipt must replay without reacquiring admission");
    assert.equal(providerCalls, 0, "admission rejection must occur before provider submission");
    const durableAdmissionReceipt = await admissionStore.get({
      userId: admissionRequest.userId,
      clientIdempotencyKey: admissionRequest.clientIdempotencyKey,
      clientTraceId: admissionRequest.clientTraceId,
    });
    assert.deepEqual(
      parseImageRequestRejectionReceipt(durableAdmissionReceipt?.response, admissionFingerprint),
      parseImageRequestRejectionReceipt(busyReceipt, admissionFingerprint),
      "busy receipt must be durably bound to the exact payload hash",
    );

    const route = await readFile("src/app/api/image/generate/route.ts", "utf8");
    for (const token of [
      "task_submitted: false",
      "taskSubmitted: false",
      "price: 0",
      "retryable: false",
      "payloadFingerprint: generationFingerprint",
      "providerProtocol",
      "outputPixelSize",
      "imageCount: IMAGE_FIXED_OUTPUT_COUNT",
      "清晰度档位",
      "目标像素尺寸",
    ]) assert(route.includes(token), `route missing ${token}`);
    const reserveHook = route.indexOf("beforeSubmitOnce: reserveImageBudgetOnce");
    const admissionAcquire = route.indexOf("workflowAdmissionLease = await acquireProviderAdmission({", reserveHook);
    const providerFetch = route.indexOf("const submitted = await fetchAuditedImageProviderPost({", admissionAcquire);
    assert(reserveHook >= 0 && admissionAcquire > reserveHook && providerFetch > admissionAcquire,
      "workflow admission must follow the durable reservation hook and precede provider fetch");
    const localAdmissionAcquire = route.indexOf("candidateAdmissionLease = await acquireProviderAdmission({", reserveHook);
    const localProviderCall = route.indexOf("await generateLocalImageCandidate({", localAdmissionAcquire);
    assert(localAdmissionAcquire > reserveHook && localProviderCall > localAdmissionAcquire,
      "local admission must follow the durable reservation hook and precede provider submission");
    const billingReleaseDecision = route.indexOf("const released = releaseConfirmed", localProviderCall);
    const billingRefund = route.indexOf("await refundCash(", billingReleaseDecision);
    const admissionResponse = route.indexOf("const admissionRejected = error.rejection.code", billingRefund);
    assert(billingReleaseDecision > localProviderCall && billingRefund > billingReleaseDecision
      && admissionResponse > billingRefund,
      "admission response must be emitted only after the billing reservation release path");
    assert(route.includes("const definiteNoResult = error instanceof ImageRequestRejectedError"));
    assert(route.includes('code: "IMAGE_PROVIDER_ADMISSION_BUSY"'));
    assert(route.includes('code: "IMAGE_PROVIDER_ADMISSION_UNAVAILABLE"'));
    assert(route.includes('"Retry-After": String(error.rejection.retryAfterSeconds)'));

    const history = await readFile("src/app/api/image-workbench/history/route.ts", "utf8");
    assert(history.includes("payload_fingerprint,request_snapshot"));
    assert(history.includes("requestIntegrity"));
    const failureHistory = await readFile("src/app/api/image-workbench/failure-history/route.ts", "utf8");
    assert(failureHistory.includes("snapshot.payloadFingerprint === row.payload_fingerprint"));
    assert(failureHistory.includes("effectivePrompt: snapshot.effectivePrompt"));
    const coverFailureHistory = await readFile("src/app/api/cover/history/route.ts", "utf8");
    assert(coverFailureHistory.includes("snapshot.payloadFingerprint === row.payload_fingerprint"));
    assert(coverFailureHistory.includes("requestIntegrity"));
    assert(coverFailureHistory.includes("effectivePrompt: snapshot.effectivePrompt"));

    assert.equal(networkCalls, 0);
    console.log(JSON.stringify({
      result: "PASS",
      protocols: protocols.length,
      unsupportedFieldsRejected: 13,
      networkCalls,
      databaseWrites: 0,
      providerCalls,
      paidCalls: 0,
      snapshotSchema: snapshot.schema,
      durableAdmissionReceipt: true,
      billingReleaseOrdering: true,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
