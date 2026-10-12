import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MemoryImageExactlyOnceStore, ImageExactlyOnceError, runImageExactlyOnce, strictImagePayloadFingerprint, type ImageExactlyOnceRecord } from "../src/lib/image-exactly-once";
import { assertImageDurableMetadata, createImageEphemeralDelivery, decodeInlineImage, imageEphemeralStatus, isImageEphemeralReceipt, matchesImageEphemeralReceipt } from "../src/lib/image-ephemeral-delivery";
import { prepareImageProviderRequest, createImageProviderSubmissionReceipt } from "../src/lib/image-provider-request-audit";
import { evaluateImageGenerationReadiness } from "../src/lib/image-generation-readiness";
import type { ProductionDatabaseReadiness } from "../src/lib/production-database-readiness";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const pixels = Buffer.from("ephemeral-image-fixture-pixels");
const dataUrl = `data:image/png;base64,${pixels.toString("base64")}`;
let checks = 0;
function check(label: string, fn: () => void) { fn(); checks++; }
async function main() {
  function setup() {
    const store = new MemoryImageExactlyOnceStore();
    const counters = { provider: 0, charges: 0, checkpoints: 0, durableWrites: 0, reads: 0 };
    const originalGet = store.get.bind(store);
    store.get = async input => { counters.reads++; return originalGet(input); };
    const originalSave = store.save.bind(store);
    store.save = async record => { counters.durableWrites++; assertImageDurableMetadata(record); return originalSave(record); };
    const originalCheckpoint = store.claimProviderPersistence.bind(store);
    store.claimProviderPersistence = async (...args) => { counters.checkpoints++; assertImageDurableMetadata(args[1]); return originalCheckpoint(...args); };
    const options = {
      store, userId: "fixture-user", clientIdempotencyKey: "fixture_inline_key", clientTraceId: "fixture_inline_trace",
      payloadFingerprint: strictImagePayloadFingerprint({ prompt: "fixture metadata: prose", model: "fixture-model" }),
      requestSnapshot: { quotedPriceYuan: 1, billingExempt: false }, billingReferenceId: "image:fixture-reference",
      beforeSubmitOnce: async () => { counters.charges++; },
      submitOnce: async (context: Parameters<Parameters<typeof runImageExactlyOnce>[0]["submitOnce"]>[0]) => {
        counters.provider++;
        const dispatch = await prepareImageProviderRequest({ url: "https://provider.invalid/v1/images/generations",
          init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "fixture" }) },
          providerProtocol: "images_generations", projection: { userPromptSha256: sha("fixture"), effectivePromptSha256: sha("fixture"), modelIdSha256: sha("fixture-model"), aspectRatio: "1:1", resolution: "1K", imageCount: 1, referenceCount: 0 },
        });
        await context.recordProviderDispatchReceipt(dispatch.receipt);
        await context.recordProviderSubmissionReceipt(createImageProviderSubmissionReceipt({ dispatchReceipt: dispatch.receipt,
          transportState: "response_received", responseStatus: 200, responseContentType: "application/json",
          responseBody: Buffer.from(JSON.stringify({ data: [{ b64_json: pixels.toString("base64") }] })),
        }));
        return { schema: "image_provider_result.v1", kind: "inline", inlineDataUrl: dataUrl, mode: "local", selectedModelId: "fixture-model", selectedCostPrice: 0.1, provider: "fixture", apiEndpoint: "https://provider.invalid/v1/images/generations", source: "image-generation" };
      },
      persistProviderResult: async () => { throw new Error("inline must not checkpoint or download"); },
      prepareEphemeralResult: async (_result: unknown, recordId: string) => createImageEphemeralDelivery({ recordId, buffer: pixels, contentType: "image/png", width: 1024, height: 1024, selectedModelId: "fixture-model", selectedCostPrice: 0.1 }),
    };
    return { store, counters, options };
  }
  const first = setup();
  const completed = await runImageExactlyOnce(first.options);
  check("first response holds transient image outside response", () => {
    assert.equal(completed.replayed, false); assert.equal("transientDelivery" in completed && completed.transientDelivery?.dataUrl, dataUrl);
    assert.equal(isImageEphemeralReceipt(completed.response), true); assertImageDurableMetadata(completed.record);
    assert.equal(JSON.stringify(completed.record).includes(pixels.toString("base64")), false);
    assert.equal(first.counters.checkpoints, 0); assert.equal(first.counters.charges, 1); assert.equal(first.counters.provider, 1);
  });
  const replay = await runImageExactlyOnce(first.options);
  check("replay is receipt only", () => {
    assert.equal(replay.replayed, true); assert.equal("transientDelivery" in replay, false);
    assert.equal(first.counters.charges, 1); assert.equal(first.counters.provider, 1);
    assert.ok(isImageEphemeralReceipt(replay.response));
    const status = imageEphemeralStatus(replay.response);
    assert.equal(status.mediaAvailable, false); assert.equal(status.canRecover, false); assert.deepEqual(status.images, []);
  });
  check("foreign owner cannot read or complete", () => assert.equal(completed.record.userHash, sha(first.options.userId)));
  assert.equal(await first.store.get({ ...first.options, userId: "foreign-owner" }), null); checks++;
  assert.equal(await first.store.completeEphemeralDelivery(completed.record, "foreign-owner", completed.response as never, first.options.billingReferenceId), null); checks++;
  await assert.rejects(() => runImageExactlyOnce({ ...first.options, payloadFingerprint: sha("different") }), /IMAGE_IDEMPOTENCY_CONFLICT|不同请求/u); checks++;
  await assert.rejects(() => runImageExactlyOnce({ ...first.options, clientTraceId: "fixture_other_trace" }), /IMAGE_IDEMPOTENCY_TRACE_CONFLICT|clientTraceId/u); checks++;

  const concurrent = setup();
  const races = await Promise.allSettled(Array.from({ length: 20 }, () => runImageExactlyOnce(concurrent.options)));
  check("one concurrent creator", () => {
    assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.counters.provider, 1); assert.equal(concurrent.counters.charges, 1); assert.equal(concurrent.counters.checkpoints, 0);
  });
  const lostAck = setup();
  const complete = lostAck.store.completeEphemeralDelivery.bind(lostAck.store);
  lostAck.store.completeEphemeralDelivery = async (...args) => { await complete(...args); throw new Error("lost ACK"); };
  const confirmed = await runImageExactlyOnce(lostAck.options);
  check("committed ACK loss readback preserves original RAM delivery", () => {
    assert.equal("transientDelivery" in confirmed && confirmed.transientDelivery?.dataUrl, dataUrl);
    assert.equal(lostAck.counters.reads, 1); assert.equal(lostAck.counters.durableWrites, 0);
  });
  const ackReplay = await runImageExactlyOnce(lostAck.options);
  check("ACK loss replay never regenerates", () => {
    assert.equal("transientDelivery" in ackReplay, false); assert.equal(lostAck.counters.charges, 1); assert.equal(lostAck.counters.provider, 1);
  });
  const beforeCommit = setup();
  beforeCommit.store.completeEphemeralDelivery = async () => { throw new Error("unavailable before commit"); };
  await assert.rejects(() => runImageExactlyOnce(beforeCommit.options), (error: unknown) => error instanceof ImageExactlyOnceError && error.code === "IMAGE_EPHEMERAL_COMPLETION_UNCONFIRMED"); checks++;
  await assert.rejects(() => runImageExactlyOnce(beforeCommit.options), (error: unknown) => error instanceof ImageExactlyOnceError && error.code === "IMAGE_IDEMPOTENCY_FAIL_CLOSED"); checks++;
  check("unconfirmed completion stays locked without overwrite", () => {
    assert.equal(beforeCommit.counters.durableWrites, 0); assert.equal(beforeCommit.counters.charges, 1); assert.equal(beforeCommit.counters.provider, 1);
  });
  const wrongDigest = setup();
  const commitCorrect = wrongDigest.store.completeEphemeralDelivery.bind(wrongDigest.store);
  wrongDigest.store.completeEphemeralDelivery = async (...args) => {
    const committed = await commitCorrect(...args);
    if (committed) committed.response = { ...committed.response, sha256: sha("wrong") };
    return committed;
  };
  await assert.rejects(() => runImageExactlyOnce(wrongDigest.options), /临时交付状态待确认/u); checks++;
  check("digest mismatch never leaks bytes or overwrites a completed row", () => assert.equal(wrongDigest.counters.durableWrites, 0));

  for (const unsafe of [{ nested: { output: dataUrl } }, { nested: { bytes: pixels } }, { response: { b64_json: pixels.toString("base64") } }, { response: { transientDelivery: { dataUrl } } }, { api_key: "fixture-secret-not-a-credential" }]) {
    check("durable boundary rejects media or secret", () => assert.throws(() => assertImageDurableMetadata(unsafe), /IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN/u));
  }
  check("ordinary prose remains valid", () => assert.doesNotThrow(() => assertImageDurableMetadata({ prompt: "show metadata: field" })));
  const legacy = setup();
  await assert.rejects(() => runImageExactlyOnce({ ...legacy.options, prepareEphemeralResult: undefined, persistProviderResult: undefined,
    submitOnce: async () => ({ nested: { imageUrl: dataUrl } }),
  }), /IMAGE_DURABLE_MEDIA_BYTES_FORBIDDEN/u); checks++;
  const storedLegacy = await legacy.store.get(legacy.options);
  check("legacy no-persister path cannot save inline", () => { assert.equal(storedLegacy?.response, undefined); assertImageDurableMetadata(storedLegacy); });
  await assert.rejects(() => first.store.save({ ...completed.record, response: { hidden: dataUrl } })); checks++;
  await assert.rejects(() => first.store.claimProviderPersistence(completed.record, { kind: "inline", inlineDataUrl: dataUrl } as never, "fixture")); checks++;
  check("canonical decoder validates exact bytes", () => assert.equal(decodeInlineImage(dataUrl).buffer.equals(pixels), true));
  for (const invalid of ["data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,AAAAA", "data:image/png;base64,!!!!", "data:text/html;base64,YQ=="]) check("invalid inline rejected", () => assert.throws(() => decodeInlineImage(invalid), /IMAGE_INLINE_RESULT_INVALID/u));
  check("receipt rejects unknown fields and different digest", () => {
    assert.equal(isImageEphemeralReceipt({ ...completed.response, hidden: dataUrl }), false);
    assert.equal(matchesImageEphemeralReceipt({ ...completed.response, sha256: sha("wrong") }, completed.response as never), false);
  });
  const ready: ProductionDatabaseReadiness = { ok: true, state: "ready", contractId: "fixture", contractVersion: "fixture", tableCount: 0, rpcCount: 0, missingTables: [], missingColumns: [], missingRpcs: [], missingRpcArguments: [], forbiddenRpcsPresent: [] };
  check("ephemeral delivery needs no object store", () => assert.deepEqual(evaluateImageGenerationReadiness(ready, { initializedProviders: [] }, true), { ready: true }));
  check("ephemeral RPC absent fails precharge readiness", () => assert.equal(evaluateImageGenerationReadiness({ ...ready, missingRpcs: ["complete_image_ephemeral_delivery"] }, { initializedProviders: [] }, true).ready, false));
  console.log(JSON.stringify({ ok: true, checks, concurrentRequests: 20, networkCalls: 0, paidCalls: 0, actualDatabaseConnections: 0, mediaWrites: 0 }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
