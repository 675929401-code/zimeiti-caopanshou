import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeAiActionSnapshotSchema, NativeAiBatchSnapshotSchema, NativeAiConsumerInvocationResultSchema,
  NativeAiDecisionSchema, NativeAiDecimal6Schema, NativeAiInternalToolSchema, NativeAiPlanReplySchema,
  NativeAiQuoteSchema, NativeAiToolSchema, nativeAiCanonical, nativeAiDecimalMicros, nativeAiHash,
  nativeAiRequestKey, nativeAiBudgetShare,
} from "../src/lib/native-ai-contract";
import {
  NativeMediaSourceSchema, NativeOwnedMediaRefSchema, nativeMainMediaPath, nativeMainMediaReference,
  type NativeOwnedMediaRef,
} from "../src/lib/native-main-media-contract";

const originalFetch = globalThis.fetch;
let networkCalls = 0;
test.before(() => { globalThis.fetch = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN_IN_NATIVE_CONTRACT_TEST"); }; });
test.after(() => { globalThis.fetch = originalFetch; assert.equal(networkCalls, 0); });

const id = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const mediaArgs = { modelId: "pm_fixture_image", prompt: "保留用户的原始创作意图", aspectRatio: "1:1", resolution: "1K", referenceAssets: [] };
const imageTool = { kind: "generate_image", args: { ...mediaArgs, count: 2 } };
const planTool = { kind: "plan_text", args: { modelId: "pm_fixture_text", prompt: "只准备确认卡", contextSnapshotHash: "a".repeat(64), maxReplyTokens: 1024, maxContextRounds: 0, maxContextTokens: 4096 } };
const quote = { unit: "CNY", quotedAmount: "0.2", maxAmount: "0.3", priceHash: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z" };

test("per-item budgets retain exact micro-unit totals and round video consent down to whole cents", () => {
  assert.deepEqual([0, 1, 2].map(ordinal => nativeAiBudgetShare("1", 3, ordinal)), ["0.333333", "0.333333", "0.333334"]);
  assert.deepEqual([0, 1, 2].map(ordinal => nativeAiBudgetShare("1.005", 3, ordinal, true)), ["0.33", "0.33", "0.34"]);
  for (const amount of ["0", "0.000001", "1.000001", "999999999999.999999"]) {
    const values = Array.from({ length: 10 }, (_, ordinal) => nativeAiBudgetShare(amount, 10, ordinal));
    assert.equal(values.reduce((total, value) => total + nativeAiDecimalMicros(value), BigInt(0)), nativeAiDecimalMicros(amount));
  }
  for (const [quantity, ordinal] of [[0, 0], [11, 0], [2, -1], [2, 2], [1.5, 0]]) assert.throws(() => nativeAiBudgetShare("1", quantity, ordinal));
});
function imageSnapshot() {
  return {
    version: "native-ai-action.v1", kind: imageTool.kind, args: imageTool.args, sourceActionId: null,
    resources: [], quote: { ...quote }, surface: "publish-center-image", permissionRevision: "user:1:fixture",
    slots: [0, 1].map(slot => ({ slot, consumer: "main_image", requestKey: nativeAiRequestKey(id(1), slot), wireRequest: { modelId: mediaArgs.modelId, prompt: mediaArgs.prompt }, wireRequestHash: "c".repeat(64) })),
  };
}
function batchSnapshot() {
  return {
    version: "native-ai-batch.v1", mode: "image_text", collectionId: id(2), prompt: "写两份独立作品",
    captionPrompt: "保持标题和话题", quantity: 2, imageCount: 2, plannerModelId: "pm_fixture_text", generationModelId: "pm_fixture_image",
    options: { aspectRatio: "1:1", resolution: "1K", duration: null }, platforms: ["xhs"],
    budget: { credits: "1.000001", CNY: "0.3" }, savePolicy: "confirm_resolved_drafts",
  };
}

test("Decimal6 remains exact at micro-unit and maximum integer boundaries", () => {
  for (const value of ["0", "0.000001", "1", "1.000001", "999999999999.999999"]) assert.equal(NativeAiDecimal6Schema.parse(value), value);
  assert.equal(nativeAiDecimalMicros("0.000001"), BigInt(1));
  assert.equal(nativeAiDecimalMicros("1.000001"), BigInt(1000001));
  assert.equal(nativeAiDecimalMicros("999999999999.999999"), BigInt("999999999999999999"));
  assert.equal(nativeAiDecimalMicros("0.1") + nativeAiDecimalMicros("0.2"), nativeAiDecimalMicros("0.3"));
});

test("Decimal6 rejects ambiguous, negative, nonstring and excessive precision amounts", () => {
  for (const value of ["", "00", "01", "-0", "-1", "+1", ".1", "1.", "1.0", "0.000000", "1e3", "1E-6", " 1", "1 ", "1.1234567", "1000000000000", 0, 0.1, null, Infinity]) {
    assert.equal(NativeAiDecimal6Schema.safeParse(value).success, false, String(value));
  }
});

test("quote compares canonical decimal caps without floating-point rounding", () => {
  assert.equal(NativeAiQuoteSchema.safeParse({ ...quote, quotedAmount: "999999999999.999998", maxAmount: "999999999999.999999" }).success, true);
  assert.equal(NativeAiQuoteSchema.safeParse({ ...quote, quotedAmount: "0.300001", maxAmount: "0.3" }).success, false);
  assert.equal(NativeAiQuoteSchema.safeParse({ ...quote, quotedAmount: "0", maxAmount: "0" }).success, true);
  assert.equal(NativeAiQuoteSchema.safeParse({ ...quote, amount: "0" }).success, false);
});

test("canonical JSON sorts object keys by ASCII while preserving ordered materials", async () => {
  const left = { z: ["素材B", "素材A"], a: { z: 1, A: false, a: null } };
  const right = { a: { a: null, A: false, z: 1 }, z: ["素材B", "素材A"] };
  assert.equal(nativeAiCanonical(left), '{"a":{"A":false,"a":null,"z":1},"z":["素材B","素材A"]}');
  assert.equal(await nativeAiHash(left), await nativeAiHash(right));
  assert.notEqual(await nativeAiHash(left), await nativeAiHash({ ...left, z: ["素材A", "素材B"] }));
  assert.match(await nativeAiHash(left), /^[a-f0-9]{64}$/u);
});

test("canonical JSON rejects non-JSON values rather than silently dropping them", async () => {
  for (const value of [undefined, NaN, Infinity, -Infinity, BigInt(1), () => 1, Symbol("private"), new Date(), new Map(), { omitted: undefined }, [undefined]]) {
    assert.throws(() => nativeAiCanonical(value), /NATIVE_AI_CANONICAL_INPUT_INVALID/u);
    await assert.rejects(nativeAiHash(value), /NATIVE_AI_CANONICAL_INPUT_INVALID/u);
  }
  const nullPrototype = Object.assign(Object.create(null), { valid: true });
  assert.equal(nativeAiCanonical(nullPrototype), '{"valid":true}');
});

test("canonical JSON rejects sparse arrays so they cannot collide with empty or dense arrays", () => {
  assert.throws(() => nativeAiCanonical(new Array(1)), /NATIVE_AI_CANONICAL_INPUT_INVALID/u);
  const nested = { media: ["first", , "last"] };
  assert.throws(() => nativeAiCanonical(nested), /NATIVE_AI_CANONICAL_INPUT_INVALID/u);
});

test("public tools exclude the internal planner and do not accept owner, shell or arbitrary URLs", () => {
  assert.equal(NativeAiToolSchema.safeParse(imageTool).success, true);
  assert.equal(NativeAiToolSchema.safeParse(planTool).success, false);
  assert.equal(NativeAiInternalToolSchema.safeParse(planTool).success, true);
  for (const args of [{ ...imageTool.args, ownerId: id(3) }, { ...imageTool.args, url: "https://outside.invalid/image.png" }, { ...imageTool.args, shell: "anything" }, { ...imageTool.args, referenceAssets: [{ kind: "image_asset", id: id(4), url: "https://outside.invalid/image.png" }] }]) {
    assert.equal(NativeAiToolSchema.safeParse({ kind: "generate_image", args }).success, false);
  }
  assert.equal(NativeAiToolSchema.safeParse({ ...imageTool, providerUrl: "https://outside.invalid/" }).success, false);
});

test("image count and public model identifiers stay bounded at the user action boundary", () => {
  for (const count of [1, 9]) assert.equal(NativeAiToolSchema.safeParse({ ...imageTool, args: { ...imageTool.args, count } }).success, true);
  for (const count of [0, 10, 1.5]) assert.equal(NativeAiToolSchema.safeParse({ ...imageTool, args: { ...imageTool.args, count } }).success, false);
  for (const modelId of ["private-model-row", "https://outside.invalid/model", "pm_", "pm_fixture?admin=true"]) assert.equal(NativeAiToolSchema.safeParse({ ...imageTool, args: { ...imageTool.args, modelId } }).success, false);
});

test("typed action binds the image scene, CNY unit, exact slot count and ordered consumers", () => {
  const snapshot = imageSnapshot();
  assert.equal(NativeAiActionSnapshotSchema.safeParse(snapshot).success, true);
  for (const value of [
    { ...snapshot, surface: "native-agent-text" },
    { ...snapshot, quote: { ...snapshot.quote, unit: "credits" } },
    { ...snapshot, slots: snapshot.slots.slice(0, 1) },
    { ...snapshot, slots: [...snapshot.slots].reverse() },
    { ...snapshot, slots: snapshot.slots.map(slot => ({ ...slot, consumer: "main_video" })) },
    { ...snapshot, slots: snapshot.slots.map(slot => ({ ...slot, requestKey: snapshot.slots[0].requestKey })) },
  ]) assert.equal(NativeAiActionSnapshotSchema.safeParse(value).success, false);
});

test("internal planner requires a single text slot and credits rather than media cash", () => {
  const image = imageSnapshot();
  const planner = { ...image, kind: planTool.kind, args: planTool.args, surface: "native-agent-text", quote: { ...quote, unit: "credits" }, slots: [{ ...image.slots[0], consumer: "main_llm" }] };
  assert.equal(NativeAiActionSnapshotSchema.safeParse(planner).success, true);
  assert.equal(NativeAiActionSnapshotSchema.safeParse({ ...planner, quote }).success, false);
  assert.equal(NativeAiActionSnapshotSchema.safeParse({ ...planner, slots: [...planner.slots, { ...planner.slots[0], slot: 1, requestKey: nativeAiRequestKey(id(1), 1) }] }).success, false);
});

test("action snapshots reject noncanonical private wire values", () => {
  const snapshot = imageSnapshot();
  const slot = snapshot.slots[0];
  assert.equal(NativeAiActionSnapshotSchema.safeParse({ ...snapshot, slots: [{ ...slot, wireRequest: { prompt: undefined } }, snapshot.slots[1]] }).success, false);
  assert.equal(NativeAiActionSnapshotSchema.safeParse({ ...snapshot, ownerId: id(3) }).success, false);
});

test("decision is only an explicit approval or rejection of the loaded revision", () => {
  const decision = { proposalId: id(1), expectedRevision: 1, decision: "approve", requestKey: "decision-fixture-1" };
  assert.equal(NativeAiDecisionSchema.safeParse(decision).success, true);
  assert.equal(NativeAiDecisionSchema.safeParse({ ...decision, args: imageTool.args }).success, false);
  assert.equal(NativeAiDecisionSchema.safeParse({ ...decision, maxAmount: "99" }).success, false);
  assert.equal(NativeAiDecisionSchema.safeParse({ ...decision, expectedRevision: 0 }).success, false);
  assert.equal(NativeAiDecisionSchema.safeParse({ ...decision, decision: "retry" }).success, false);
});

test("batch keeps credits and CNY as separate explicit budgets and only confirmed draft saves", () => {
  const snapshot = batchSnapshot();
  assert.equal(NativeAiBatchSnapshotSchema.safeParse(snapshot).success, true);
  for (const budget of [{ credits: "1" }, { CNY: "1" }, { credits: "1", CNY: "0", USD: "1" }, { credits: "1", CNY: 0 }]) assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...snapshot, budget }).success, false);
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...snapshot, savePolicy: "auto_publish" }).success, false);
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...snapshot, quantity: 11 }).success, false);
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...snapshot, platforms: ["xhs", "xhs"] }).success, false);
});

test("batch video and image modes require their own complete generation choices", () => {
  const snapshot = batchSnapshot();
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...snapshot, imageCount: null }).success, false);
  const video = { ...snapshot, mode: "video", imageCount: null, options: { ...snapshot.options, duration: 5 } };
  assert.equal(NativeAiBatchSnapshotSchema.safeParse(video).success, true);
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...video, imageCount: 1 }).success, false);
  assert.equal(NativeAiBatchSnapshotSchema.safeParse({ ...video, options: { ...video.options, duration: null } }).success, false);
});

test("lookup not-found is an explicit closed fact and cannot contain a partial action", () => {
  assert.deepEqual(NativeAiConsumerInvocationResultSchema.parse({ found: false }), { found: false });
  for (const value of [null, {}, { found: false, action: null }, { found: true }, { error: "database-unavailable" }]) assert.equal(NativeAiConsumerInvocationResultSchema.safeParse(value).success, false);
});

test("model plans may suggest only public tools without executable override fields", () => {
  assert.equal(NativeAiPlanReplySchema.safeParse({ reply: "请确认后执行", actions: [imageTool] }).success, true);
  assert.equal(NativeAiPlanReplySchema.safeParse({ reply: "已发布", actions: [planTool] }).success, false);
  assert.equal(NativeAiPlanReplySchema.safeParse({ reply: "建议", actions: [{ ...imageTool, confirmed: true }] }).success, false);
  assert.equal(NativeAiPlanReplySchema.safeParse({ reply: "建议", actions: [], completed: true }).success, false);
});

test("stable slot request keys are local UUID-bound, distinct and bounded", () => {
  assert.equal(nativeAiRequestKey(id(1), 0), `native_${id(1)}_0`);
  assert.notEqual(nativeAiRequestKey(id(1), 0), nativeAiRequestKey(id(1), 1));
  assert.notEqual(nativeAiRequestKey(id(1), 0), nativeAiRequestKey(id(2), 0));
  for (const slot of [-1, 9, 0.5, NaN]) assert.throws(() => nativeAiRequestKey(id(1), slot));
  assert.throws(() => nativeAiRequestKey("owner-chosen-path", 0));
});

test("owned main media references round-trip only through exact same-origin content paths", () => {
  const origin = "http://127.0.0.1:5000";
  const refs: NativeOwnedMediaRef[] = [{ kind: "image_record", id: "image-record:fixture_1" }, { kind: "image_asset", id: id(7) }, { kind: "video_task", id: "video-task.fixture:1" }];
  for (const ref of refs) {
    const path = nativeMainMediaPath(ref);
    assert.deepEqual(nativeMainMediaReference(path, origin), ref);
    assert.deepEqual(nativeMainMediaReference(`${origin}${path}`, origin), ref);
    assert.equal(nativeMainMediaReference(`https://outside.invalid${path}`, origin), null);
    assert.equal(nativeMainMediaReference(`${path}#ignored`, origin), null);
    assert.equal(nativeMainMediaReference(`${path}${path.includes("?") ? "&" : "?"}token=forbidden`, origin), null);
  }
});

test("media parsers reject remote URLs, encoded alternate forms and authority-bearing fields", () => {
  const valid = `/api/media-history/content?assetId=${id(7)}`;
  const invalid = [
    `//outside.invalid${valid}`, `/api/media-history/content?assetId=${id(7)}&assetId=${id(7)}`,
    `/api/media-history/content?recordId=fixture%2Fother`, "/api/video/storage/fixture%2fother",
    "/api/video/storage/fixture/other", "/api/media-history/content?recordId=fixture%3a1",
    "/api/media-history/content?unknown=fixture", "data:image/png;base64,AAAA", "javascript:alert(1)",
  ];
  for (const value of invalid) assert.equal(nativeMainMediaReference(value), null, value);
  assert.equal(NativeOwnedMediaRefSchema.safeParse({ kind: "image_asset", id: id(7), url: "https://outside.invalid/" }).success, false);
  assert.equal(NativeMediaSourceSchema.safeParse({ kind: "main_asset", reference: { kind: "image_asset", id: id(7) }, ownerId: id(2) }).success, false);
  assert.equal(NativeMediaSourceSchema.safeParse({ kind: "provider_asset", assetId: id(7) }).success, true);
  assert.equal(NativeMediaSourceSchema.safeParse({ kind: "url", url: "https://outside.invalid/" }).success, false);
});
