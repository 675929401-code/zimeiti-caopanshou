import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import {
  NativeAiActionSnapshotSchema, nativeAiHash, nativeAiRequestKey, nativeAiDecimalMicros,
  type NativeAiActionDto,
} from "../src/lib/native-ai-contract";
import {
  admitNativeAiConsumer, buildNativeAiPriceHash, NativeAiAdmissionError, resolveNativeAiConsumer,
  toNativeAiReservationAmount,
} from "../src/lib/server/native-ai-admission";
import { normalizeImageGenerationInput, readImageGenerationInput } from "../src/lib/image-generation-request";
import { imageWorkspaceSurfaceFromRequest, videoWorkspaceSurfaceFromRequest } from "../src/lib/workspace-model-policy";
import { isVisibleInPublicWorkspace } from "../src/lib/video-workspace-catalog";
import { createImageFailureRequestSnapshot, parseImageFailureRequestSnapshot } from "../src/lib/image-failure-history";
import { buildVideoGenerationRequestSnapshot } from "../src/lib/video-budget-reservation";

let realNetworkCalls = 0;
const originalFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { realNetworkCalls++; throw new Error("NETWORK_FORBIDDEN_IN_ADMISSION_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(realNetworkCalls, 0); });

type Row = Record<string, unknown>;
type Db = Parameters<typeof resolveNativeAiConsumer>[0]["db"];
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = id(1), stranger = id(2), modelId = "pm_image_fixture", now = "2026-11-10T00:00:00.000Z";
const permission = async () => ({ authorityStatus: "ready", integrityValid: true, checksum: "fixture", featureNavigationKeys: ["publish_center"] });
const rejected = (code: string) => (error: unknown) => error instanceof NativeAiAdmissionError && error.code === code;
async function fixture(options: { count?: number; cap?: string; batchCap?: string; zero?: boolean } = {}) {
  const actionId = id(10), count = options.count ?? 1;
  const pricing = { mode: "local", resolution: "1K", costPrice: 0.1, sellingPrice: options.zero ? 0 : 0.5, imageCount: 1 };
  const priceHash = await buildNativeAiPriceHash({ consumer: "main_image", modelPublicId: modelId, surface: "publish-center-image", pricing });
  const wires = Array.from({ length: count }, (_, slot) => ({ mode: "local", prompt: "isolated fixture", modelId, aspectRatio: "1:1", resolution: "1K", referenceImageUrls: [], historySurface: "publish-center-image", clientTraceId: nativeAiRequestKey(actionId, slot), clientIdempotencyKey: nativeAiRequestKey(actionId, slot), noRetry: true, strictSingleSubmit: true, deliveryRequirement: "recoverable_reference" }));
  const snapshot = NativeAiActionSnapshotSchema.parse({ version: "native-ai-action.v1", kind: "generate_image", args: { modelId, prompt: "isolated fixture", aspectRatio: "1:1", resolution: "1K", referenceAssets: [], count }, sourceActionId: null, resources: [], quote: { unit: "CNY", quotedAmount: options.zero ? "0" : "0.5", maxAmount: options.cap ?? "2", priceHash, expiresAt: "2099-01-01T00:00:00.000Z" }, surface: "publish-center-image", permissionRevision: "fixture:1", slots: await Promise.all(wires.map(async (wireRequest, slot) => ({ slot, consumer: "main_image", requestKey: nativeAiRequestKey(actionId, slot), wireRequest, wireRequestHash: await nativeAiHash(wireRequest) }))) });
  const action: NativeAiActionDto = { id: actionId, scope: { kind: "batch", batchId: id(20), itemId: id(21) }, revision: 1, state: "dispatch_claimed", kind: snapshot.kind, actionHash: await nativeAiHash(snapshot), args: snapshot.args, quote: snapshot.quote, slots: snapshot.slots.map(slot => ({ slot: slot.slot, requestKey: slot.requestKey, consumer: slot.consumer, state: "dispatch_claimed", dispatchId: id(100 + slot.slot), receipt: null })), createdAt: now, updatedAt: now };
  const calls: { name: string; owner: string; input: Row }[] = [], admitted = new Map<number, string>();
  let rpcError: unknown = null;
  const db = { async rpc(name: string, raw: unknown) {
    const args = raw as { p_user_id: string; p_input: Row }, input = args.p_input;
    calls.push({ name, owner: args.p_user_id, input });
    if (rpcError) return { data: null, error: rpcError };
    if (name === "read_native_ai_atomic") {
      const slot = action.slots.find(row => row.requestKey === input.mainRequestKey && row.consumer === input.consumer);
      return { data: args.p_user_id === owner && slot ? { found: true, action, slot, snapshot } : { found: false }, error: null };
    }
    assert.equal(name, "mutate_native_ai_atomic"); assert.equal(input.action, "admit-consumer"); assert.equal(args.p_user_id, owner);
    const slot = Number(input.slot), amount = String(input.reservationAmount), prior = admitted.get(slot);
    const total = [...admitted.values()].reduce((sum, value) => sum + nativeAiDecimalMicros(value), BigInt(0));
    if (!prior && total + nativeAiDecimalMicros(amount) > nativeAiDecimalMicros(options.batchCap ?? options.cap ?? "2")) return { data: null, error: { message: "NATIVE_AI_BUDGET_EXCEEDED" } };
    admitted.set(slot, amount);
    return { data: { action, slot: action.slots[slot], admission: { newlyAdmitted: prior === undefined, reservationAmount: amount, unit: input.unit } }, error: null };
  } } as unknown as Db;
  const resolve = (slot = 0, userId = owner, wireRequest: unknown = wires[slot]) => resolveNativeAiConsumer({ db, userId, consumer: "main_image", requestKey: nativeAiRequestKey(actionId, slot), wireRequest });
  const admit = async (slot = 0, amount = "0.5") => admitNativeAiConsumer({ db, userId: owner, invocation: await resolve(slot), modelPublicId: modelId, surface: "publish-center-image", priceHash, reservationAmount: amount, unit: "CNY" }, { readPermission: permission });
  return { db, snapshot, action, calls, wires, priceHash, pricing, resolve, admit, admitted, fail: (error: unknown) => { rpcError = error; } };
}
async function rebind(f: Awaited<ReturnType<typeof fixture>>, consumer: "main_llm" | "main_video", wire: Row) {
  const modelPublicId = consumer === "main_llm" ? "pm_chat_fixture" : "pm_video_fixture";
  const surface = consumer === "main_llm" ? "native-agent-text" : "publish-center-video";
  f.snapshot.kind = consumer === "main_llm" ? "plan_text" : "generate_video";
  f.snapshot.args = consumer === "main_llm" ? { modelId: modelPublicId, prompt: "fixture", contextSnapshotHash: "a".repeat(64), maxReplyTokens: 128, maxContextRounds: 1, maxContextTokens: 1024 }
    : { modelId: modelPublicId, prompt: "fixture", aspectRatio: "16:9", resolution: "720p", referenceAssets: [], duration: 5 };
  const pricing = consumer === "main_llm" ? { schemaVersion: "llm_public_model_price.v1", publicModelId: modelPublicId, internalModelId: "fixture", modelName: "fixture", inputCostPerMillion: 1, outputCostPerMillion: 2 }
    : { priceYuan: 1, costPriceYuan: 0, billingUnit: "token", billingQuantity: 1, resolution: "720p", explicitlyFree: false, tokenQuote: { maxChargeYuan: 1, priceVersion: "fixture" } };
  const priceHash = await buildNativeAiPriceHash({ consumer, modelPublicId, surface, pricing });
  f.snapshot.surface = surface; f.snapshot.quote.unit = consumer === "main_llm" ? "credits" : "CNY"; f.snapshot.quote.priceHash = priceHash;
  const requestKey = String(wire.client_request_id);
  f.snapshot.slots[0] = { slot: 0, consumer, requestKey, wireRequest: wire, wireRequestHash: await nativeAiHash(wire) };
  f.action.kind = f.snapshot.kind; f.action.args = f.snapshot.args; f.action.quote = f.snapshot.quote;
  f.action.slots[0].consumer = consumer; f.action.slots[0].requestKey = requestKey; f.action.actionHash = await nativeAiHash(f.snapshot);
  const invocation = await resolveNativeAiConsumer({ db: f.db, userId: owner, consumer, requestKey, wireRequest: wire });
  return { invocation, modelPublicId, surface, priceHash } as const;
}

test("ordinary main requests perform no native lookup, permission read, reservation or dispatch", async () => {
  const f = await fixture();
  assert.equal(await resolveNativeAiConsumer({ db: f.db, userId: owner, consumer: "main_image", requestKey: "ordinary-main-request", wireRequest: {} }), null);
  assert.equal(await admitNativeAiConsumer({ db: f.db, userId: owner, invocation: null, modelPublicId: "", surface: null, priceHash: "", reservationAmount: "0", unit: "CNY" }, { readPermission: async () => { throw new Error("UNEXPECTED_PERMISSION_READ"); } }), null);
  assert.equal(f.calls.length, 0);
});
test("reserved missing/wrong owner/malformed native action fails closed; unbound legacy Agent remains ordinary", async () => {
  const f = await fixture();
  await assert.rejects(f.resolve(0, stranger), rejected("NATIVE_AI_ACTION_REQUIRED"));
  await assert.rejects(resolveNativeAiConsumer({ db: f.db, userId: owner, consumer: "main_image", requestKey: "native_not-a-valid-action_0", wireRequest: {} }), rejected("NATIVE_AI_KEY_INVALID"));
  assert.equal(await resolveNativeAiConsumer({ db: f.db, userId: owner, consumer: "main_llm", requestKey: `native-agent:${id(90)}:llm:0`, wireRequest: {} }), null);
});
test("database lookup failure never becomes ordinary behavior or not-found", async () => {
  const f = await fixture(); f.fail({ message: "fixture lookup unavailable" });
  await assert.rejects(f.resolve(), rejected("NATIVE_AI_ADMISSION_UNAVAILABLE"));
});
test("frozen whole-wire hash catches model/surface/body changes before admission", async () => {
  const f = await fixture();
  for (const patch of [{ modelId: "pm_foreign" }, { historySurface: "cover-studio" }, { prompt: "changed" }, { adminValidation: {} }]) await assert.rejects(f.resolve(0, owner, { ...f.wires[0], ...patch }), rejected("NATIVE_AI_WIRE_MISMATCH"));
  assert.equal(f.calls.filter(call => call.name.startsWith("mutate")).length, 0);
});
test("a valid frozen wire still rejects privileged, workflow or owner fields", async () => {
  for (const patch of [{ adminValidation: {} }, { proxyUrl: "https://fixture.example.com" }, { userId: stranger }, { mode: "workflow" }]) {
    const f = await fixture(); Object.assign(f.wires[0], patch); f.snapshot.slots[0].wireRequest = f.wires[0]; f.snapshot.slots[0].wireRequestHash = await nativeAiHash(f.wires[0]); f.action.actionHash = await nativeAiHash(f.snapshot);
    await assert.rejects(f.resolve(), (error: unknown) => error instanceof NativeAiAdmissionError && ["NATIVE_AI_WIRE_INVALID", "NATIVE_AI_SURFACE_REQUIRED"].includes(error.code));
  }
});
test("dispatch identity is required and cannot be borrowed from another action", async () => {
  const f = await fixture(); f.action.slots[0].dispatchId = null;
  await assert.rejects(f.resolve(), rejected("NATIVE_AI_BINDING_MISMATCH"));
});
test("actual model, surface, unit and rate snapshot are checked before consumer RPC", async () => {
  const f = await fixture(), invocation = await f.resolve();
  for (const patch of [{ modelPublicId: "pm_other" }, { surface: "publish-center-video" as const }, { unit: "credits" as const }, { priceHash: "0".repeat(64) }]) await assert.rejects(admitNativeAiConsumer({ db: f.db, userId: owner, invocation, modelPublicId: modelId, surface: "publish-center-image", priceHash: f.priceHash, reservationAmount: "0.5", unit: "CNY", ...patch }, { readPermission: permission }), rejected("NATIVE_AI_PRICE_CHANGED"));
  assert.equal(f.calls.filter(call => call.name.startsWith("mutate")).length, 0);
});
test("current feature authority is rechecked even for an explicitly free model", async () => {
  const f = await fixture({ zero: true }), invocation = await f.resolve();
  await assert.rejects(admitNativeAiConsumer({ db: f.db, userId: owner, invocation, modelPublicId: modelId, surface: "publish-center-image", priceHash: f.priceHash, reservationAmount: "0", unit: "CNY" }, { readPermission: async () => ({ ...await permission(), featureNavigationKeys: [] }) }), rejected("NATIVE_AI_ACCESS_DENIED"));
  assert.equal(f.calls.filter(call => call.name.startsWith("mutate")).length, 0);
  await f.admit(0, "0"); assert.equal(f.calls.filter(call => call.name.startsWith("mutate")).length, 1); assert.equal(f.admitted.get(0), "0");
});
test("same-key admitted receipt cannot authorize a second dispatch", async () => {
  const f = await fixture(); let dispatches = 0;
  await f.admit(); dispatches++;
  await assert.rejects(f.admit(), rejected("NATIVE_AI_ALREADY_ADMITTED"));
  assert.equal(dispatches, 1); assert.equal(f.admitted.size, 1);
});
test("per-action maximum and atomic batch aggregate cap are enforced", async () => {
  const f = await fixture({ count: 2, cap: "2", batchCap: "1.5" });
  await assert.rejects(f.admit(0, "2.000001"), rejected("NATIVE_AI_BUDGET_EXCEEDED"));
  await f.admit(0, "1"); await assert.rejects(f.admit(1, "1"), rejected("NATIVE_AI_BUDGET_EXCEEDED"));
  assert.equal(f.admitted.size, 1);
});
test("linked legacy Agent text uses exact main request and actual credits without quote_expectation", async () => {
  const f = await fixture();
  const bound = await rebind(f, "main_llm", { agentId: "__free_chat__", modelId: "pm_chat_fixture", model_overridden: true, stream: true, max_reply_tokens: 128, max_context_rounds: 1, max_context_tokens: 1024, client_request_id: `native-agent:${id(90)}:llm:0`, messages: [{ role: "user", content: "fixture" }] });
  await admitNativeAiConsumer({ db: f.db, userId: owner, ...bound, reservationAmount: "1", unit: "credits" }, { readPermission: permission });
  const last = f.calls.at(-1)!; assert.equal(last.input.consumer, "main_llm"); assert.equal(last.input.unit, "credits"); assert.equal(last.input.reservationAmount, "1");
  assert.equal("quote_expectation" in f.snapshot.slots[0].wireRequest, false);
});
test("native video uses CNY maximum token reservation and separate explicit surface", async () => {
  const f = await fixture();
  const bound = await rebind(f, "main_video", { model_id: "pm_video_fixture", prompt: "fixture", duration: 5, aspect_ratio: "16:9", resolution: "720p", reference_image_urls: [], client_request_id: nativeAiRequestKey(id(10), 0), surface: "publish-center-video", tokenBilling: { maxChargeYuan: 1, priceVersion: "fixture" } });
  await admitNativeAiConsumer({ db: f.db, userId: owner, ...bound, reservationAmount: "1", unit: "CNY" }, { readPermission: permission });
  assert.equal(f.calls.at(-1)!.input.reservationAmount, "1"); assert.equal(f.calls.at(-1)!.input.consumer, "main_video");
});
test("frozen native text cannot enable tools, multi-stage thinking, multimodal or a nonstream request", async () => {
  for (const patch of [{ tools: [] }, { stream: false }, { deep_thinking_type: 1 }, { messages: [{ role: "user", content: [{ type: "image_url", image_url: "https://fixture.example.com/a.png" }] }] }]) {
    const f = await fixture();
    await assert.rejects(rebind(f, "main_llm", { agentId: "__free_chat__", modelId: "pm_chat_fixture", model_overridden: true, stream: true, max_reply_tokens: 128, max_context_rounds: 1, max_context_tokens: 1024, client_request_id: nativeAiRequestKey(id(10), 0), messages: [{ role: "user", content: "fixture" }], ...patch }), (error: unknown) => error instanceof NativeAiAdmissionError && ["NATIVE_AI_WIRE_INVALID", "NATIVE_AI_TEXT_UNBOUNDED"].includes(error.code));
    assert.equal(f.calls.filter(call => call.name.startsWith("mutate")).length, 0);
  }
});
test("Decimal6 rejects negative, nonfinite, exponent/extra precision and canonicalizes harmless floating noise", () => {
  assert.equal(toNativeAiReservationAmount(0), "0"); assert.equal(toNativeAiReservationAmount(10), "10"); assert.equal(toNativeAiReservationAmount(0.1 + 0.2), "0.3");
  for (const amount of [-1, Infinity, NaN, 1e-7, 1e12]) assert.throws(() => toNativeAiReservationAmount(amount));
});
test("price hash uses real rates/options without request identity or credentials", async () => {
  const f = await fixture();
  assert.notEqual(f.priceHash, await buildNativeAiPriceHash({ consumer: "main_image", modelPublicId: modelId, surface: "publish-center-image", pricing: { ...f.pricing, sellingPrice: 0.6 } }));
  await assert.rejects(buildNativeAiPriceHash({ consumer: "main_image", modelPublicId: modelId, surface: "publish-center-image", pricing: { ...f.pricing, api_key: "fixture-only-never-a-secret" } }), rejected("NATIVE_AI_PRICE_INVALID"));
  const base = { priceYuan: 1, costPriceYuan: 0, billingUnit: "token", billingQuantity: 1, resolution: "720p", explicitlyFree: false, tokenQuote: { maxChargeYuan: 1, priceVersion: "fixture", requestPayloadHash: "a".repeat(64) } };
  const hash = await buildNativeAiPriceHash({ consumer: "main_video", modelPublicId: "pm_video_fixture", surface: "publish-center-video", pricing: base });
  assert.equal(hash, await buildNativeAiPriceHash({ consumer: "main_video", modelPublicId: "pm_video_fixture", surface: "publish-center-video", pricing: { ...base, tokenQuote: { ...base.tokenQuote, requestPayloadHash: "b".repeat(64) } } }));
});
test("image parser verifies original wire before native-only async reference resolution", async () => {
  const f = await fixture(); const raw = { ...f.wires[0], referenceImageUrls: [`native-owned-image://image_record/${id(80)}`] };
  let observed: unknown;
  const result = await readImageGenerationInput(new Request("http://fixture.local/api/image/generate", { method: "POST", body: JSON.stringify(raw) }), { onWireRequest: value => { observed = value; }, transformWireRequest: async value => ({ ...value as Row, referenceImageUrls: ["https://assets.example.com/fixture.png"] }) });
  assert.deepEqual(observed, raw); assert.equal(result.historySurface, "publish-center-image"); assert.deepEqual(result.referenceImageUrls, ["https://assets.example.com/fixture.png"]);
  assert.throws(() => normalizeImageGenerationInput(raw));
});
test("new explicit native scenes do not masquerade as cover/video pages or hide incompatible catalogue entries", () => {
  assert.equal(imageWorkspaceSurfaceFromRequest("publish-center-image"), "publish-center-image"); assert.equal(videoWorkspaceSurfaceFromRequest("publish-center-video"), "publish-center-video");
  assert.equal(imageWorkspaceSurfaceFromRequest("publish-center-video"), null); assert.equal(videoWorkspaceSurfaceFromRequest("publish-center-image"), null);
  assert.equal(isVisibleInPublicWorkspace({ surfaceCompatible: false, maxReferenceImages: 0 }, "publish-center-video"), true);
});
test("native image history retains its explicit scene and hashes opaque reference identity", () => {
  const uri = `native-owned-image://image_record/${id(80)}`;
  const snapshot = createImageFailureRequestSnapshot({ surface: "publish-center-image", prompt: "fixture", publicModelId: modelId, modelName: "Fixture", aspectRatio: "1:1", resolution: "1K", referenceImageUrls: [uri], quotedPriceYuan: 0.5, billingExempt: false });
  assert.ok(snapshot); assert.equal(snapshot.surface, "publish-center-image"); assert.equal(parseImageFailureRequestSnapshot(snapshot)?.surface, "publish-center-image");
  assert.equal(snapshot.referenceAssetRefs.length, 1); assert.equal(JSON.stringify(snapshot).includes("https://"), false);
});
test("native video durable snapshot accepts only the closed owned-image URI form and contains no temporary URL", () => {
  const input = { userPrompt: "fixture", effectivePrompt: "fixture", promptNormalizations: [], negativePrompt: "", referenceAssets: [{ role: "reference_image_list" as const, index: 0, ref: `native-owned-image://image_asset/${id(81)}` }], targetDurationSeconds: 5, effectiveDurationSeconds: 5, aspectRatio: "16:9", resolution: "720p", fps: null, seed: null, generateAudio: null, publicModelId: "pm_video_fixture", routingConfigHash: "a".repeat(64), adapterVersion: "fixture:v1", providerPayload: { reference_image_urls: [`native-owned-image://image_asset/${id(81)}`] } };
  const snapshot = buildVideoGenerationRequestSnapshot(input);
  assert.equal(snapshot.referenceAssets[0].ref, input.referenceAssets[0].ref); assert.equal(JSON.stringify(snapshot).includes("https://"), false);
  for (const ref of ["native-owned-image://image_asset/not-a-uuid", "native-owned-image://video_task/foreign", "native-owned-image://image_record/a?token=fixture"]) assert.throws(() => buildVideoGenerationRequestSnapshot({ ...input, referenceAssets: [{ role: "reference_image_list", index: 0, ref }] }));
});
test("actual handlers keep native admission before every paid reserve/debt/asset bridge and preserve normal wallets", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const image = read("src/app/api/image/generate/route.ts"), video = read("src/app/api/video/generate/route.ts"), llm = read("src/app/api/llm/route.ts");
  assert.ok(image.indexOf("await admitNativeAiConsumer") < image.indexOf("await checkAndCollectDebt"));
  assert.ok(image.indexOf("await admitNativeAiConsumer") < image.indexOf("await executeCashDeduction"));
  assert.ok(video.indexOf("await admitNativeAiConsumer") < video.indexOf("await bridgeGeneratedImageForVideoProvider"));
  assert.ok(video.indexOf("await admitNativeAiConsumer") < video.indexOf("await bridgeVideoProviderAsset"));
  assert.equal((video.match(/await reserveVideoGenerationTask\(/g) || []).length, 2);
  assert.ok(video.indexOf("await admitNativeAiConsumer") < video.indexOf("await reserveVideoGenerationTask"));
  assert.ok(llm.indexOf("NATIVE_AI_TEXT_UNBOUNDED") < llm.indexOf("await handleDeepThinkingType1"));
  assert.ok(llm.indexOf("await admitNativeAiConsumer") < llm.indexOf("await reserveLlmStreamCredits"));
  assert.ok(image.includes('historySurface === "publish-center-image" && !nativeInput.invocation') || image.includes('wire.historySurface === "publish-center-image" && !nativeInput.invocation'));
  assert.ok(video.includes('body?.surface === "publish-center-video" && !nativeInvocation'));
});
