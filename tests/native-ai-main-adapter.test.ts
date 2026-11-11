import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";
import { compileNativeAiMainAction, invokeNativeAiMain, nativeAiMoney, type NativeAiMainCompilerDependencies } from "../src/lib/server/native-ai-main-adapter";
import { buildNativeAiPriceHash } from "../src/lib/server/native-ai-admission";
import { buildSelectedModelBillingSnapshot } from "../src/lib/llm-billing";
import { quoteLlmStreamReservation } from "../src/lib/llm-credit-reservation";
import { requireVideoPriceSnapshot } from "../src/lib/video-terminal-finalizer";
import { nativeAiHash, nativeAiRequestKey, type NativeAiInternalTool } from "../src/lib/native-ai-contract";

type Row = Record<string, unknown>;
type DB = Parameters<typeof compileNativeAiMainAction>[0];
const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = uuid(1), actionId = uuid(2), permissionRevision = "user:7:fixture";
const originalFetch = globalThis.fetch;
let networkCalls = 0;
test.before(() => { globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN_IN_MAIN_ADAPTER_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });
const db = new Proxy({}, { get() { throw new Error("REAL_DB_FORBIDDEN_IN_MAIN_ADAPTER_TEST"); } }) as DB;
const mediaArgs = { modelId: "pm_image_fixture", prompt: "保留这份原文🙂", aspectRatio: "1:1", resolution: "1k", referenceAssets: [] };
const imageTool = (count = 1): Extract<NativeAiInternalTool, { kind: "generate_image" }> => ({ kind: "generate_image", args: { ...mediaArgs, count } });
function dependencies(model: Row = { id: uuid(20), model_name: "image fixture", cost_price: 0.2, selling_price: 0.5, api_protocol_config: { resolution_cost_prices: { "1K": 0.3 }, resolution_prices: { "1K": 0.7 } } }) {
  const calls: { kind: string; modelId: string }[] = [], references: unknown[] = [];
  const deps: NativeAiMainCompilerDependencies = {
    catalog: async (kind, modelId) => { calls.push({ kind, modelId }); return { id: modelId, capabilities: { priceReady: true, generationReady: true } }; },
    model: async (_db, kind, modelId) => { calls.push({ kind: `private:${kind}`, modelId }); return model; },
    imageReference: async (_db, actor, reference) => { assert.equal(actor, owner); references.push(reference); return { source: { kind: "main_asset", reference }, contentPath: "/api/media-history/content?recordId=fixture", fileName: "ref.png", mime: "image/png", size: 300, connectionCurrent: true }; },
  };
  return { deps, calls, references, model };
}
const errorCode = (code: string) => (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === code;

test("image quote uses actual resolution prices and gives every image its own immutable main key", async () => {
  const f = dependencies(), tool = imageTool(2);
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps });
  assert.equal(snapshot.quote.unit, "CNY"); assert.equal(snapshot.quote.quotedAmount, "1.4"); assert.equal(snapshot.quote.maxAmount, "1.4");
  assert.equal(snapshot.surface, "publish-center-image"); assert.equal(snapshot.slots.length, 2);
  assert.equal(new Set(snapshot.slots.map(slot => slot.requestKey)).size, 2);
  for (const [slot, wire] of snapshot.slots.entries()) {
    assert.equal(wire.requestKey, nativeAiRequestKey(actionId, slot));
    assert.equal(wire.wireRequestHash, await nativeAiHash(wire.wireRequest));
    assert.equal(wire.wireRequest.noRetry, true); assert.equal(wire.wireRequest.strictSingleSubmit, true);
    assert.equal(wire.wireRequest.deliveryRequirement, "recoverable_reference"); assert.equal(wire.wireRequest.resolution, "1K");
  }
  assert.equal(snapshot.quote.priceHash, await buildNativeAiPriceHash({ consumer: "main_image", modelPublicId: tool.args.modelId, surface: "publish-center-image", pricing: { mode: "local", resolution: "1K", costPrice: 0.3, sellingPrice: 0.7, imageCount: 1 } }));
  assert.deepEqual(f.calls.map(call => call.kind), ["generate_image", "private:generate_image"]);
});

test("zero price is a real CNY quote and absent prices never become zero", async () => {
  const free = dependencies({ cost_price: 0, selling_price: 0 });
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, imageTool(), permissionRevision, { dependencies: free.deps });
  assert.equal(snapshot.quote.quotedAmount, "0"); assert.equal(snapshot.quote.maxAmount, "0"); assert.equal(snapshot.quote.unit, "CNY");
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, imageTool(), permissionRevision, { dependencies: dependencies({}).deps }), errorCode("NATIVE_AI_MODEL_NOT_READY"));
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, imageTool(2), permissionRevision, { maxAmount: "1", dependencies: dependencies().deps }), { code: "NATIVE_AI_BUDGET_EXCEEDED", status: 409 });
});

test("a catalog or owner reference failure stops compilation before a wire can be dispatched", async () => {
  const f = dependencies(); let privateReads = 0;
  f.deps.catalog = async () => { throw new Error("fixture catalog unavailable"); };
  f.deps.model = async () => { privateReads++; throw new Error("must not read"); };
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, imageTool(), permissionRevision, { dependencies: f.deps }), /fixture catalog unavailable/);
  assert.equal(privateReads, 0);
  const g = dependencies(), tool = imageTool(); tool.args.referenceAssets = [{ kind: "image_record", id: "other-owner" }];
  g.deps.imageReference = async () => { throw new Error("fixture wrong owner"); };
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: g.deps }), /fixture wrong owner/);
});

test("references are ownership-checked in order and only opaque identities enter frozen image wires", async () => {
  const f = dependencies(), tool = imageTool();
  tool.args.referenceAssets = [{ kind: "image_record", id: "record:first" }, { kind: "image_asset", id: uuid(30) }];
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps });
  assert.deepEqual(f.references, tool.args.referenceAssets);
  assert.deepEqual(snapshot.slots[0].wireRequest.referenceImageUrls, ["native-owned-image://image_record/record:first", `native-owned-image://image_asset/${uuid(30)}`]);
  assert.equal(JSON.stringify(snapshot).includes("https://"), false);
});

test("text planning uses actual credit reservation and the same rate hash as consumer admission", async () => {
  const model = { id: uuid(21), model_name: "fixture-chat", token_billing_enabled: true, input_cost_per_million: 1, output_cost_per_million: 2, cached_cost_per_million: 0.5, profit_margin: 20 };
  const f = dependencies(model), publicId = "pm_chat_fixture";
  const config = { inputCostPerMillion: 1, outputCostPerMillion: 2, cachedCostPerMillion: 0.5, profitMargin: 20, creditsPerYuan: 50, tokenRoundingEnabled: false, tokenRoundingUnit: 1, tokenRoundingMin: 1, tokenRoundingMax: 1000 };
  const billing = buildSelectedModelBillingSnapshot(publicId, model, config); assert.ok(billing);
  f.deps.selectedTextBilling = async () => billing;
  const tool = { kind: "plan_text", args: { modelId: publicId, prompt: "为当前会员策划", contextSnapshotHash: "a".repeat(64), maxReplyTokens: 128, maxContextRounds: 0, maxContextTokens: 1024 } } as const;
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps });
  const wire = snapshot.slots[0].wireRequest;
  const quote = quoteLlmStreamReservation({ model: model.model_name, messages: wire.messages as { role: "user"; content: string }[], max_tokens: 128 }, billing.config, 1); assert.ok(quote);
  assert.equal(snapshot.quote.unit, "credits"); assert.equal(snapshot.quote.quotedAmount, nativeAiMoney(quote.amount));
  assert.equal(snapshot.quote.priceHash, await buildNativeAiPriceHash({ consumer: "main_llm", modelPublicId: publicId, surface: "native-agent-text", pricing: billing.priceSnapshot }));
  assert.equal("quote_expectation" in wire, false); assert.equal(wire.agentId, "__free_chat__"); assert.equal(wire.stream, true);
  f.deps.selectedTextBilling = async () => undefined;
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps }), errorCode("NATIVE_AI_MODEL_NOT_READY"));
});

const videoModel = (extra: Row = {}) => ({ id: uuid(22), model_name: "fixture-video", price_per_use: 0.6, cost_price: 0.2, duration_seconds: 8, max_duration: 8, supports_image_input: false, api_protocol_config: { workflow_input_mode: "text", supports_prompt: true, duration_options: [8], resolution_options: ["720p"], default_resolution: "720p", min_reference_images: 0, max_reference_images: 0, ...extra } });
const videoTool = (): Extract<NativeAiInternalTool, { kind: "generate_video" }> => ({ kind: "generate_video", args: { modelId: "pm_video_fixture", prompt: "真实视频描述", aspectRatio: "16:9", resolution: "720p", referenceAssets: [], duration: 8 } });

test("video quote matches the main fixed price snapshot and preserves its explicit scene", async () => {
  const f = dependencies(videoModel()), tool = videoTool();
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps });
  const price = requireVideoPriceSnapshot(f.model, "720p", 8);
  assert.equal(snapshot.quote.quotedAmount, nativeAiMoney(price.priceYuan)); assert.equal(snapshot.quote.unit, "CNY");
  assert.equal(snapshot.quote.priceHash, await buildNativeAiPriceHash({ consumer: "main_video", modelPublicId: tool.args.modelId, surface: "publish-center-video", pricing: price }));
  assert.equal(snapshot.slots[0].wireRequest.surface, "publish-center-video"); assert.equal(snapshot.slots[0].wireRequest.client_request_id, nativeAiRequestKey(actionId, 0));
  const bad = videoTool(); bad.args.duration = 20;
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, bad, permissionRevision, { dependencies: f.deps }), errorCode("NATIVE_AI_MODEL_NOT_READY"));
});

test("token video requires explicit CNY consent and quotes its maximum instead of a zero display price", async () => {
  const rates = { "720p:no_reference_video": 12, "720p:reference_video": 8 }, costs = { "720p:no_reference_video": 6, "720p:reference_video": 4 };
  const f = dependencies(videoModel({ provider_billing_unit: "token", token_sale_prices_per_million: rates, token_cost_prices_per_million: costs }));
  await assert.rejects(compileNativeAiMainAction(db, owner, actionId, videoTool(), permissionRevision, { dependencies: f.deps }), errorCode("NATIVE_AI_MODEL_NOT_READY"));
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, videoTool(), permissionRevision, { maxAmount: "2.35", dependencies: f.deps });
  assert.equal(snapshot.quote.quotedAmount, "2.35"); assert.equal(snapshot.quote.maxAmount, "2.35"); assert.equal(snapshot.quote.unit, "CNY");
  assert.equal((snapshot.slots[0].wireRequest.tokenBilling as Row).maxChargeYuan, 2.35);
});

test("video first and last frame mapping preserves ordered owner references without signed URLs", async () => {
  const f = dependencies(videoModel({ workflow_input_mode: "first_last_frame", min_reference_images: 2, max_reference_images: 2 })), tool = videoTool();
  tool.args.referenceAssets = [{ kind: "image_record", id: "first-frame" }, { kind: "image_record", id: "last-frame" }];
  const snapshot = await compileNativeAiMainAction(db, owner, actionId, tool, permissionRevision, { dependencies: f.deps });
  assert.equal(snapshot.slots[0].wireRequest.image_url, "native-owned-image://image_record/first-frame");
  assert.equal(snapshot.slots[0].wireRequest.last_frame_url, "native-owned-image://image_record/last-frame");
  assert.deepEqual(snapshot.slots[0].wireRequest.reference_image_urls, []);
});

test("fixed main handler dispatch forwards only the current cookie and consumes all bytes without asserting success", async () => {
  for (const [consumer, path] of [["main_llm", "/api/llm"], ["main_image", "/api/image/generate"], ["main_video", "/api/video/generate"]] as const) {
    let calls = 0, pulls = 0;
    const wire = { client_request_id: "fixture-stable-key", prompt: "原始正文" };
    const result = await invokeNativeAiMain(consumer, wire, new Headers({ cookie: "fixture-session=owner", "x-untrusted": "never-forward", "x-native-csrf": "fixture" }), { [consumer]: async (request: NextRequest) => {
      calls++; assert.equal(new URL(request.url).pathname, path); assert.equal(request.method, "POST");
      assert.equal(request.headers.get("cookie"), "fixture-session=owner"); assert.equal(request.headers.get("authorization"), null); assert.equal(request.headers.get("x-untrusted"), null);
      assert.equal(request.headers.get("x-native-csrf"), null); assert.deepEqual(await request.json(), wire);
      return new Response(new ReadableStream({ pull(controller) { pulls++; if (pulls <= 2) controller.enqueue(new TextEncoder().encode(pulls === 1 ? '{"status":"succeeded"}' : "no durable receipt")); else controller.close(); } }), { status: 200 });
    } });
    assert.equal(calls, 1); assert.equal(pulls, 3); assert.equal(result, undefined);
  }
});

test("a non-success HTTP response remains evidence to reconcile; missing session or bearer injection never dispatches", async () => {
  let calls = 0;
  const handler = async () => { calls++; return new Response('{"error":"fixture unknown"}', { status: 503 }); };
  assert.equal(await invokeNativeAiMain("main_image", {}, new Headers({ cookie: "fixture-session=owner" }), { main_image: handler }), undefined);
  for (const headers of [new Headers(), new Headers({ cookie: "fixture-session=owner", authorization: "Bearer fixture-forbidden" })]) {
    await assert.rejects(invokeNativeAiMain("main_image", {}, headers, { main_image: handler }), errorCode("NATIVE_AI_SESSION_REQUIRED"));
  }
  assert.equal(calls, 1);
});

test("money formatting preserves integer zeroes, rounds tiny positive prices upward and rejects invalid amounts", () => {
  for (const [amount, expected] of [[0, "0"], [10, "10"], [100, "100"], [120.5, "120.5"], [0.0000001, "0.000001"], [0.1234561, "0.123457"]] as const) assert.equal(nativeAiMoney(amount), expected);
  for (const amount of [-1, Number.NaN, Infinity, 1_000_000_000_000]) assert.throws(() => nativeAiMoney(amount));
});
