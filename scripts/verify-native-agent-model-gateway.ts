import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createNativeAgentModelGateway, createNativeAgentLlmAccountingAdapter, NativeAgentModelGatewayError,
  type NativeAgentModelBinding, type NativeAgentModelCallContext, type NativeAgentModelGatewayPorts,
} from "../src/lib/server/native-agent-model-gateway";
import {
  nativeAgentCanonicalJson, parseNativeAgentAnthropicRequest, NativeAgentModelProtocolError,
  type NativeAgentAnthropicRequest,
} from "../src/lib/native-agent-model-protocol";
import type { LlmRequestAttemptRecord, LlmRequestAttemptStore } from "../src/lib/llm-request-idempotency";
import type { BillingResult } from "../src/lib/billing";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const context: NativeAgentModelCallContext = { ownerId: "owner-a", taskId: "task-a", turnId: "turn-a", callId: "call-1", configHash: "a".repeat(64), modelId: "catalog-claude" };
const binding: NativeAgentModelBinding = {
  ownerId: context.ownerId, taskId: context.taskId, turnId: context.turnId, configHash: context.configHash,
  protocol: "anthropic_messages", protocolValidated: true, publicModelId: context.modelId, providerModelId: "claude-confirmed",
  maxInputTokens: 100_000, maxOutputTokens: 2048, maxCredits: 10,
  pricing: { publicModelId: context.modelId, internalModelId: "model-row-a", modelName: "Confirmed test model",
    config: { inputCostPerMillion: 10, outputCostPerMillion: 30, cachedCostPerMillion: 1, profitMargin: 50,
      creditsPerYuan: 50, tokenRoundingEnabled: false, tokenRoundingUnit: 0, tokenRoundingMin: 100, tokenRoundingMax: 10000 },
    priceSnapshot: { source: "offline-owned-model", input: 10, output: 30, cached: 1, margin: 50 } },
};
const request: NativeAgentAnthropicRequest = {
  model: "catalog-claude", max_tokens: 100, stream: false,
  system: [{ type: "text", text: "读取会员已有草稿，再生成新草稿" }],
  tools: [{ name: "read_owned_draft", description: "读取当前会员草稿", input_schema: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"] } },
    { name: "save_new_draft", input_schema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } } } }],
  messages: [
    { role: "user", content: "请改写已有草稿" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_read_1", name: "read_owned_draft", input: { draftId: "draft-1" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: [{ type: "text", text: JSON.stringify({ title: "原标题", body: "原正文", ownerId: "owner-a" }) }] }] },
  ],
};
const message = () => ({ id: "msg_native_1", type: "message", role: "assistant", model: "claude-confirmed",
  content: [{ type: "text", text: "已读草稿🙂" }, { type: "tool_use", id: "toolu_save_1", name: "save_new_draft", input: { title: "新标题", body: "新正文", tags: ["原创"] } }],
  stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 27, output_tokens: 14, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const sse = () => {
  const frame = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return frame("message_start", { message: { id: "msg_native_1", type: "message", role: "assistant", model: "claude-confirmed", content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 27, output_tokens: 0, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 } } })
    + frame("ping")
    + frame("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + frame("content_block_delta", { index: 0, delta: { type: "text_delta", text: "已读草稿🙂" } })
    + frame("content_block_stop", { index: 0 })
    + frame("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_save_1", name: "save_new_draft", input: {} } })
    + frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"title":"新标题",' } })
    + frame("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '"body":"新正文","tags":["原创"]}' } })
    + frame("content_block_stop", { index: 1 })
    + frame("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 14 } })
    + frame("message_stop");
};

function fixture() {
  const records = new Map<string, LlmRequestAttemptRecord>();
  const effects = { claim: 0, reserve: 0, mark: 0, send: 0, settle: 0, release: 0, finalize: 0, freeze: 0 };
  const persistedFrozen = new Set<string>();
  const sent: NativeAgentAnthropicRequest[] = [];
  const prices: Array<Parameters<NativeAgentModelGatewayPorts["accounting"]["reserve"]>[0]> = [];
  let response = () => jsonResponse(message());
  let chosenBinding = copy(binding);
  const store: LlmRequestAttemptStore = {
    async claim(input) {
      effects.claim++;
      const key = `${input.userId}:${input.clientRequestId}`;
      const previous = records.get(key);
      if (previous) {
        if (previous.payloadFingerprint !== input.payloadFingerprint) throw new NativeAgentModelGatewayError("NATIVE_AGENT_ATTEMPT_CONFLICT", "hash conflict", 409);
        return previous.state === "succeeded" ? { action: "replay", record: copy(previous) }
          : { action: "reconciliation_required", record: copy(previous) };
      }
      const record: LlmRequestAttemptRecord = { recordId: digest(`${input.userId}\u0000${input.clientRequestId}`), userId: input.userId, clientRequestId: input.clientRequestId,
        payloadFingerprint: input.payloadFingerprint, state: "running", attemptNo: 1, leaseOwner: input.leaseOwner,
        leaseToken: 1, leaseExpiresAt: "2099-01-01T00:00:00Z", providerCallStartedAt: null, httpStatus: null,
        responseHeaders: {}, responseBody: null, responseFingerprint: null, resultReference: null, errorCode: null, errorMessage: null,
        createdAt: "2026-11-10T00:00:00Z", updatedAt: "2026-11-10T00:00:00Z" };
      records.set(key, copy(record)); return { action: "execute", execution: { record, leaseOwner: input.leaseOwner, leaseToken: 1 } };
    },
    async markProviderCallStarted(execution) {
      effects.mark++;
      const record = { ...execution.record, providerCallStartedAt: "2026-11-10T00:00:01Z" };
      records.set(`${record.userId}:${record.clientRequestId}`, copy(record)); return { ...execution, record };
    },
    async finalize(input) {
      effects.finalize++;
      const record = { ...input.execution.record, state: input.state, httpStatus: input.httpStatus || null,
        responseHeaders: input.responseHeaders || {}, responseBody: input.responseBody || null, responseFingerprint: input.responseFingerprint || null,
        resultReference: input.resultReference || null, errorCode: input.errorCode || null, errorMessage: input.errorMessage || null };
      records.set(`${record.userId}:${record.clientRequestId}`, copy(record)); return record;
    },
  };
  const ports: NativeAgentModelGatewayPorts = {
    async authorize(ctx) { if (persistedFrozen.has(ctx.turnId)) throw new NativeAgentModelGatewayError("NATIVE_AGENT_TURN_FROZEN", "persisted freeze", 409); return copy(chosenBinding); },
    attempts: store,
    transport: { async send(input) { effects.send++; sent.push(copy(input.request)); return response(); } },
    accounting: {
      async quote() { return 2; },
      async reserve(input) { effects.reserve++; prices.push(input); return { recordId: input.execution.record.recordId, leaseOwner: input.execution.leaseOwner, leaseToken: input.execution.leaseToken, amount: input.budget.amount }; },
      async settle() { effects.settle++; return { operationId: "wallet-native-call-1", creditsCharged: 0.04 }; },
      async release() { effects.release++; },
    },
    async freezeTurn({ context: ctx }) { effects.freeze++; persistedFrozen.add(ctx.turnId); },
  };
  return { ports, records, effects, sent, prices, persistedFrozen, gateway: createNativeAgentModelGateway(ports),
    setResponse(fn: () => Response) { response = fn; }, setBinding(value: NativeAgentModelBinding) { chosenBinding = copy(value); } };
}

async function main() {
  const checks: string[] = [];
  let forbiddenNetwork = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { forbiddenNetwork++; throw new Error("REAL_NETWORK_FORBIDDEN"); };
  const check = async (name: string, run: () => void | Promise<void>) => { await run(); checks.push(name); };
  const rejects = async (action: () => Promise<unknown>, code?: string) => {
    await assert.rejects(action, error => {
      assert.ok(error instanceof NativeAgentModelGatewayError || error instanceof NativeAgentModelProtocolError);
      if (code) assert.equal(error.code, code);
      return true;
    });
  };
  try {
    await check("production accounting adapter uses atomic reserve, full snapshot and shared settlement semantics", async () => {
      const f = fixture(); const seed = await f.gateway.call({ context, request }); const reserveInput = f.prices[0];
      let reserveCalls = 0; let settleCalls = 0; let releaseCalls = 0; let validationCalls = 0;
      let safetyConfirmed = true;
      const calculated: BillingResult = { actualCostRmb: 0.01, sellPriceRmb: 0.02, profitRmb: 0.01, creditsCharged: 2,
        baseFeeCredits: 0, tokenCredits: 2, breakdown: { inputCostRmb: 0, outputCostRmb: 0, cachedCostRmb: 0,
          inputSellRmb: 0, outputSellRmb: 0, cachedSellRmb: 0, inputCredits: 0, outputCredits: 0, cachedCredits: 0 } };
      const adapter = await createNativeAgentLlmAccountingAdapter({
        async verifyReservationSafety(input) { assert.deepEqual(input.context, context); return { policy: "native-agent-unknown-hold.v1", databaseVerified: true,
          preservesUnknownHolds: safetyConfirmed as true, preservesExpiredProviderHolds: true, policyFingerprint: "c".repeat(64) }; },
        primitives: {
        calculateCredits(config, input, output, cached) {
          assert.equal(config.inputCostPerMillion, binding.pricing.config.inputCostPerMillion);
          assert.equal(input, reserveInput.budget.inputTokens); assert.equal(output, request.max_tokens); assert.equal(cached, 0);
          return copy(calculated);
        },
        validateLlmStreamReservationSettlement(hold, bill) { validationCalls++; assert.equal(hold.amount, bill.creditsCharged); return bill; },
        async reserveLlmStreamCredits(execution, amount, snapshot) {
          reserveCalls++; assert.equal(execution, reserveInput.execution); assert.equal(amount, 2);
          assert.deepEqual(snapshot.native_agent, { ...context, requestHash: seed.receipt.requestHash, clientRequestId: seed.receipt.clientRequestId,
            protocol: binding.protocol, providerModelId: binding.providerModelId, budget: reserveInput.budget, billingConfig: binding.pricing.config, reservationPolicyFingerprint: "c".repeat(64) });
          return { recordId: execution.record.recordId, leaseOwner: execution.leaseOwner, leaseToken: execution.leaseToken, amount };
        },
        async settleLlmUsage(owner, agent, model, prompt, output, cached, agentId, options) {
          settleCalls++; assert.equal(owner, context.ownerId); assert.equal(model, binding.providerModelId);
          assert.equal(prompt, 30); assert.equal(output, 14); assert.equal(cached, 3); assert.equal(agentId, undefined);
          assert.equal(options.clientRequestId, seed.receipt.clientRequestId); assert.equal(options.phase, "response");
          assert.deepEqual(options.billingSnapshot, binding.pricing); assert.equal(options.reservation?.amount, 2);
          return { success: true, billing: calculated, operationId: "atomic-wallet-operation" };
        },
        async releaseLlmStreamCredits(hold, reason) { releaseCalls++; assert.equal(hold.amount, 2); assert.equal(reason, "before-send"); },
        },
      });
      assert.equal(await adapter.quote({ binding, inputTokens: reserveInput.budget.inputTokens, outputTokens: request.max_tokens }), 2);
      const held = await adapter.reserve(reserveInput);
      assert.deepEqual(await adapter.settle({ context, clientRequestId: seed.receipt.clientRequestId, requestHash: seed.receipt.requestHash,
        binding, reservation: held, message: seed.message }), { operationId: "atomic-wallet-operation", creditsCharged: 2 });
      await adapter.release(held, "before-send"); assert.deepEqual([reserveCalls, settleCalls, releaseCalls, validationCalls], [1, 1, 1, 1]);
      safetyConfirmed = false;
      await rejects(() => adapter.reserve(reserveInput), "NATIVE_AGENT_RESERVATION_POLICY_UNCONFIRMED");
      assert.deepEqual([reserveCalls, settleCalls, releaseCalls], [1, 1, 1]);
      await rejects(() => createNativeAgentLlmAccountingAdapter(undefined as unknown as Parameters<typeof createNativeAgentLlmAccountingAdapter>[0]), "NATIVE_AGENT_RESERVATION_POLICY_UNCONFIRMED");
      checks.push("production safety rejection blocks atomic reserve and charge; missing safety has no default bypass");
    });
    await check("structured system/tools/messages/tool_result preserved without a chat-string rewrite", async () => {
      const f = fixture(); const result = await f.gateway.call({ context, request });
      assert.deepEqual(f.sent[0], { ...request, model: binding.providerModelId });
      assert.deepEqual(result.message, message());
      assert.equal(result.receipt.ownerId, context.ownerId); assert.equal(result.receipt.configHash, context.configHash);
      assert.equal(result.receipt.modelId, context.modelId); assert.equal(result.receipt.usage.cache_read_input_tokens, 3);
      assert.equal(f.prices[0].requestHash, result.receipt.requestHash);
      assert.ok(f.prices[0].budget.inputTokens > Buffer.byteLength(JSON.stringify(request), "utf8"));
      assert.equal(f.effects.send, 1); assert.equal(f.effects.settle, 1); assert.equal(f.effects.finalize, 1);
    });
    await check("same call ID replays settled response without another reserve/send/charge", async () => {
      const f = fixture(); const original = await f.gateway.call({ context, request }); const replay = await f.gateway.call({ context, request });
      assert.equal(replay.replayed, true); assert.deepEqual(replay.message, original.message);
      assert.equal(f.effects.reserve, 1); assert.equal(f.effects.send, 1); assert.equal(f.effects.settle, 1);
    });
    await check("full canonical request hash includes system/schema/tool-result/sampling and price snapshot", async () => {
      for (const mutate of [
        (r: NativeAgentAnthropicRequest) => { r.system = "changed"; },
        (r: NativeAgentAnthropicRequest) => { r.tools![0].input_schema.required = ["other"]; },
        (r: NativeAgentAnthropicRequest) => { r.messages[2].content = [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "changed" }]; },
        (r: NativeAgentAnthropicRequest) => { r.temperature = 0.5; },
      ]) {
        const f = fixture(); await f.gateway.call({ context, request }); const changed = copy(request); mutate(changed);
        await rejects(() => f.gateway.call({ context, request: changed }), "NATIVE_AGENT_ATTEMPT_CONFLICT"); assert.equal(f.effects.send, 1);
      }
      const f = fixture(); await f.gateway.call({ context, request }); const b = copy(binding); b.pricing.config.outputCostPerMillion = 31; f.setBinding(b);
      await rejects(() => f.gateway.call({ context, request }), "NATIVE_AGENT_ATTEMPT_CONFLICT"); assert.equal(f.effects.send, 1);
      assert.equal(nativeAgentCanonicalJson({ z: 1, a: { b: 2, a: 1 } }), nativeAgentCanonicalJson({ a: { a: 1, b: 2 }, z: 1 }));
    });
    await check("cross-owner/task/config and unconfirmed native protocol blocked before claim", async () => {
      for (const change of [{ ownerId: "owner-b" }, { taskId: "task-b" }, { configHash: "b".repeat(64) }, { protocolValidated: false }]) {
        const f = fixture(); f.setBinding({ ...binding, ...change } as NativeAgentModelBinding);
        await rejects(() => f.gateway.call({ context, request })); assert.equal(f.effects.claim, 0); assert.equal(f.effects.send, 0);
      }
    });
    await check("input/output/credit ceilings stop unbounded tools before reserve or send", async () => {
      for (const change of [{ maxInputTokens: 8193 }, { maxOutputTokens: 99 }, { maxCredits: 1 }]) {
        const f = fixture(); f.setBinding({ ...binding, ...change });
        await rejects(() => f.gateway.call({ context, request })); assert.equal(f.effects.reserve, 0); assert.equal(f.effects.send, 0);
      }
    });
    await check("unknown endpoint/credential fields and images/documents/URL sources rejected", async () => {
      for (const bad of [ { ...request, apiKey: "fixture-only" }, { ...request, baseURL: "https://offline.invalid" },
        { ...request, thinking: { type: "enabled", budget_tokens: 100 } },
        { ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://offline.invalid/image" } }] }] },
        { ...request, tools: [{ name: "unsafe", type: "web_search_20250305" }] },
        { ...request, system: "a".repeat(512 * 1024 + 1) },
      ]) {
        const f = fixture(); await rejects(() => f.gateway.call({ context, request: bad })); assert.equal(f.effects.claim, 0);
      }
    });
    await check("unmatched tool results and duplicate tool invocation IDs rejected", async () => {
      const bad = copy(request); bad.messages[2].content = [{ type: "tool_result", tool_use_id: "unknown", content: "bad" }];
      assert.throws(() => parseNativeAgentAnthropicRequest(bad), NativeAgentModelProtocolError);
      bad.messages[2] = copy(bad.messages[1]); assert.throws(() => parseNativeAgentAnthropicRequest(bad), NativeAgentModelProtocolError);
    });
    await check("JSON accessors/cycles/sparse arrays/depth overflow reject without invoking getters", () => {
      let getters = 0;
      const accessor = copy(request); Object.defineProperty(accessor, "model", { enumerable: true, get() { getters++; return request.model; } });
      assert.throws(() => parseNativeAgentAnthropicRequest(accessor), NativeAgentModelProtocolError);
      const arrayAccessor = copy(request); Object.defineProperty(arrayAccessor.messages, "0", { enumerable: true, get() { getters++; return request.messages[0]; } });
      assert.throws(() => parseNativeAgentAnthropicRequest(arrayAccessor), NativeAgentModelProtocolError); assert.equal(getters, 0);
      const cyclic: Record<string, unknown> = { ...request }; cyclic.self = cyclic;
      assert.throws(() => parseNativeAgentAnthropicRequest(cyclic), NativeAgentModelProtocolError);
      assert.throws(() => parseNativeAgentAnthropicRequest({ ...request, messages: new Array(2) }), NativeAgentModelProtocolError);
      let deep: unknown = "leaf"; for (let i = 0; i < 30; i++) deep = { nested: deep };
      assert.throws(() => parseNativeAgentAnthropicRequest({ ...request, tool_choice: deep }), NativeAgentModelProtocolError);
    });
    await check("original SSE bytes replay intact after terminal usage validation and settlement", async () => {
      const f = fixture(); const body = sse(); f.setResponse(() => {
        const encoded = new TextEncoder().encode(body);
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < encoded.length; i += 3) controller.enqueue(encoded.slice(i, i + 3)); controller.close(); } }),
          { headers: { "content-type": "text/event-stream; charset=utf-8" } });
      });
      const result = await f.gateway.call({ context, request: { ...request, stream: true } });
      assert.equal(result.delivery.mode, "buffered_original_sse"); assert.equal(result.delivery.body, body); assert.deepEqual(result.message, message());
      const replay = await f.gateway.call({ context, request: { ...request, stream: true } }); assert.equal(replay.delivery.body, body); assert.equal(f.effects.send, 1);
    });
    await check("stream true plus provider JSON stays explicit JSON mode without synthetic SSE", async () => {
      const f = fixture(); const result = await f.gateway.call({ context, request: { ...request, stream: true } });
      assert.equal(result.delivery.mode, "json"); assert.equal(result.delivery.body, JSON.stringify(message()));
    });
    await check("settlement promise gates both tool delivery and next call", async () => {
      const f = fixture(); let unlock!: () => void; let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }); const pending = new Promise<void>(resolve => { unlock = resolve; });
      f.ports.accounting.settle = async () => { f.effects.settle++; entered(); await pending; return { operationId: "wallet-held", creditsCharged: 1 }; };
      let delivered = false; const result = f.gateway.call({ context, request }).then(value => { delivered = true; return value; });
      await started; assert.equal(delivered, false); assert.equal(f.effects.finalize, 0);
      await rejects(() => f.gateway.call({ context: { ...context, callId: "call-2" }, request }), "NATIVE_AGENT_TURN_BUSY");
      unlock(); assert.equal((await result).message.content[1].type, "tool_use");
    });
    await check("wallet failure withholds tools and persists turn freeze across gateway instances", async () => {
      const f = fixture(); f.ports.accounting.settle = async () => { f.effects.settle++; throw new Error("settlement unavailable"); };
      await rejects(() => f.gateway.call({ context, request }), "NATIVE_AGENT_SETTLEMENT_UNKNOWN");
      assert.equal(f.effects.release, 0); assert.equal(f.effects.freeze, 1);
      assert.equal([...f.records.values()][0].state, "reconciliation_required");
      await rejects(() => f.gateway.call({ context: { ...context, callId: "call-2" }, request }), "NATIVE_AGENT_TURN_FROZEN");
      await rejects(() => createNativeAgentModelGateway(f.ports).call({ context: { ...context, callId: "call-3" }, request }), "NATIVE_AGENT_TURN_FROZEN");
      assert.equal(f.effects.send, 1); assert.equal(f.effects.settle, 1);
    });
    await check("overspent/missing usage/cache-write/stop reason/tool mismatch retain hold and freeze", async () => {
      const variants = [
        { ...message(), usage: { input_tokens: 30, output_tokens: 101 } },
        { ...message(), usage: { output_tokens: 14 } },
        { ...message(), usage: { input_tokens: 999_999, output_tokens: 14 } },
        { ...message(), usage: { input_tokens: 30, output_tokens: 14, cache_creation_input_tokens: 1 } },
        { ...message(), stop_reason: null }, { ...message(), stop_reason: "end_turn" },
        { ...message(), model: "unapproved-model" },
      ];
      for (const response of variants) {
        const f = fixture(); f.setResponse(() => jsonResponse(response)); await rejects(() => f.gateway.call({ context, request }));
        assert.equal(f.effects.settle, 0); assert.equal(f.effects.release, 0); assert.equal(f.effects.freeze, 1);
        assert.equal([...f.records.values()][0].state, "failed_unknown");
      }
    });
    await check("SSE EOF/missing usage/conflicting type/oversize body are never zero-cost failures", async () => {
      const variants = [ sse().replace(/event: message_stop[\s\S]*$/u, ""),
        sse().replace('"usage":{"output_tokens":14}', '"usage":{}'),
        sse().replace("event: message_stop", "event: error"), "x".repeat(2 * 1024 * 1024 + 1) ];
      for (const body of variants) {
        const f = fixture(); f.setResponse(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
        await rejects(() => f.gateway.call({ context, request: { ...request, stream: true } }));
        assert.equal(f.effects.release, 0); assert.equal(f.effects.freeze, 1); assert.equal(f.effects.settle, 0);
      }
    });
    await check("cancel before provider releases confirmed hold, cancel after provider keeps unknown hold", async () => {
      const early = fixture(); const c1 = new AbortController(); const originalReserve = early.ports.accounting.reserve;
      early.ports.accounting.reserve = async input => { const held = await originalReserve(input); c1.abort(); return held; };
      await rejects(() => early.gateway.call({ context, request, signal: c1.signal }), "NATIVE_AGENT_CALL_CANCELLED");
      assert.equal(early.effects.send, 0); assert.equal(early.effects.release, 1); assert.equal([...early.records.values()][0].state, "failed");
      const late = fixture(); const c2 = new AbortController(); const originalSend = late.ports.transport.send;
      late.ports.transport.send = async input => { const result = await originalSend(input); c2.abort(); return result; };
      await rejects(() => late.gateway.call({ context, request, signal: c2.signal }), "NATIVE_AGENT_CALL_CANCELLED_UNKNOWN");
      assert.equal(late.effects.release, 0); assert.equal(late.effects.freeze, 1); assert.equal(late.effects.settle, 0);
    });
    await check("uncertain reserve/mark/finalize commits never authorize another outbound call", async () => {
      for (const stage of ["reserve", "mark", "finalize"] as const) {
        const f = fixture();
        if (stage === "reserve") f.ports.accounting.reserve = async () => { f.effects.reserve++; throw new Error("commit outcome unknown"); };
        if (stage === "mark") f.ports.attempts.markProviderCallStarted = async () => { f.effects.mark++; throw new Error("commit outcome unknown"); };
        if (stage === "finalize") f.ports.attempts.finalize = async () => { f.effects.finalize++; throw new Error("commit outcome unknown"); };
        await rejects(() => f.gateway.call({ context, request }));
        assert.equal(f.effects.freeze, 1); assert.equal(f.effects.release, 0);
        await rejects(() => f.gateway.call({ context: { ...context, callId: "call-2" }, request }), "NATIVE_AGENT_TURN_FROZEN");
        assert.equal(f.effects.send, stage === "finalize" ? 1 : 0);
      }
    });
    await check("wrong reservation/mark ownership and reclaimed attempts cannot reach provider", async () => {
      const wrongReserve = fixture(); const reserve = wrongReserve.ports.accounting.reserve;
      wrongReserve.ports.accounting.reserve = async input => ({ ...await reserve(input), recordId: "foreign-record" });
      await rejects(() => wrongReserve.gateway.call({ context, request }), "NATIVE_AGENT_RESERVATION_INVALID");
      assert.equal(wrongReserve.effects.send, 0); assert.equal(wrongReserve.effects.release, 0); assert.equal(wrongReserve.effects.freeze, 1);
      const wrongMark = fixture(); const mark = wrongMark.ports.attempts.markProviderCallStarted;
      wrongMark.ports.attempts.markProviderCallStarted = async input => { const marked = await mark(input); return { ...marked, record: { ...marked.record, userId: "owner-b" } }; };
      await rejects(() => wrongMark.gateway.call({ context, request }), "NATIVE_AGENT_ATTEMPT_CONFLICT");
      assert.equal(wrongMark.effects.send, 0); assert.equal(wrongMark.effects.release, 0);
      assert.equal([...wrongMark.records.values()][0].userId, context.ownerId);
      const reclaimed = fixture(); const claim = reclaimed.ports.attempts.claim;
      reclaimed.ports.attempts.claim = async input => { const result = await claim(input); if (result.action === "execute") result.execution.record.attemptNo = 2; return result; };
      await rejects(() => reclaimed.gateway.call({ context, request }), "NATIVE_AGENT_CALL_UNRESOLVED");
      assert.equal(reclaimed.effects.reserve, 0); assert.equal(reclaimed.effects.send, 0); assert.equal(reclaimed.effects.freeze, 1);
      assert.equal([...reclaimed.records.values()][0].state, "failed_unknown");
    });
    await check("pre-existing unknown call cannot replay through a new gateway instance", async () => {
      const f = fixture(); f.ports.transport.send = async () => { f.effects.send++; throw new Error("transport aborted unknown"); };
      await rejects(() => f.gateway.call({ context, request })); f.persistedFrozen.clear();
      await rejects(() => createNativeAgentModelGateway(f.ports).call({ context, request }), "NATIVE_AGENT_CALL_UNRESOLVED");
      assert.equal(f.effects.send, 1);
    });
    assert.equal(forbiddenNetwork, 0);
    console.log(JSON.stringify({ status: "passed", groups: checks.length, checks,
      effects: { realNetworkCalls: forbiddenNetwork, databaseCalls: 0, credentialReads: 0, providerCalls: 0 },
      supportedModes: ["json", "buffered_original_sse"], limitation: "Production reservation-recovery policy readback, task freeze/authorization and registered Anthropic transport must be connected before a live SDK run" }, null, 2));
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
