import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { BillingConfig } from "../billing";
import type { SelectedModelBillingSnapshot } from "../llm-billing";
import type { LlmStreamReservation } from "../llm-credit-reservation";
import type { LlmRequestAttemptExecution, LlmRequestAttemptRecord, LlmRequestAttemptStore } from "../llm-request-idempotency";
import {
  nativeAgentBoundedJson, nativeAgentCanonicalJson, nativeAgentObject, NativeAgentModelProtocolError,
  parseNativeAgentAnthropicRequest, readNativeAgentAnthropicResponse,
  type NativeAgentAnthropicMessage, type NativeAgentAnthropicRequest, type NativeAgentBufferedDelivery,
} from "../native-agent-model-protocol";

export interface NativeAgentModelCallContext {
  ownerId: string; taskId: string; turnId: string; callId: string; configHash: string; modelId: string;
}
/** Server loaded and frozen per call. No request URL or credentials belong in this DTO. */
export interface NativeAgentModelBinding {
  ownerId: string; taskId: string; turnId: string; configHash: string;
  protocol: "anthropic_messages";
  protocolValidated: true;
  publicModelId: string;
  providerModelId: string;
  pricing: SelectedModelBillingSnapshot;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCredits: number;
}
export interface NativeAgentModelBudget { inputTokens: number; outputTokens: number; amount: number }
export interface NativeAgentModelAccounting {
  quote(input: { binding: NativeAgentModelBinding; inputTokens: number; outputTokens: number }): Promise<number>;
  reserve(input: {
    execution: LlmRequestAttemptExecution; context: NativeAgentModelCallContext; requestHash: string;
    clientRequestId: string; binding: NativeAgentModelBinding; budget: NativeAgentModelBudget;
  }): Promise<LlmStreamReservation>;
  settle(input: {
    context: NativeAgentModelCallContext; clientRequestId: string; requestHash: string;
    binding: NativeAgentModelBinding; reservation: LlmStreamReservation; message: NativeAgentAnthropicMessage;
  }): Promise<{ operationId: string; creditsCharged: number }>;
  /** Only called when the gateway knows transport.send was never entered. */
  release(reservation: LlmStreamReservation, reason: string): Promise<void>;
}
export interface NativeAgentModelGatewayPorts {
  /**
   * Must load the owned task and frozen config, and reject a turn with any earlier
   * unresolved model/tool operation. This check must survive process restart.
   * An HTTP bridge must additionally authenticate its server-issued call scope.
   */
  authorize(context: NativeAgentModelCallContext): Promise<NativeAgentModelBinding>;
  attempts: LlmRequestAttemptStore;
  accounting: NativeAgentModelAccounting;
  /** Trusted server closure selects the registered endpoint and resolves credentials. Never /api/llm. */
  transport: { send(input: { context: NativeAgentModelCallContext; binding: NativeAgentModelBinding; request: NativeAgentAnthropicRequest; signal?: AbortSignal }): Promise<Response> };
  /** Persist a turn freeze before allowing the runtime to request another call. */
  freezeTurn(input: { context: NativeAgentModelCallContext; requestHash: string; code: string }): Promise<void>;
}
export interface NativeAgentModelCallReceipt extends NativeAgentModelCallContext {
  version: "native-agent-model-call.v1";
  protocol: "anthropic_messages";
  requestHash: string;
  clientRequestId: string;
  priceSnapshotHash: string;
  budget: NativeAgentModelBudget;
  usage: NativeAgentAnthropicMessage["usage"];
  operationId: string;
  creditsCharged: number;
}
export interface NativeAgentModelCallResult {
  message: NativeAgentAnthropicMessage;
  delivery: NativeAgentBufferedDelivery;
  receipt: NativeAgentModelCallReceipt;
  replayed: boolean;
}
export class NativeAgentModelGatewayError extends Error {
  readonly retrySafe = false;
  constructor(readonly code: string, message: string, readonly status = 503) {
    super(message); this.name = "NativeAgentModelGatewayError";
  }
}
function fail(code: string, message: string, status = 503): never { throw new NativeAgentModelGatewayError(code, message, status); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
const contextKeys = ["ownerId", "taskId", "turnId", "callId", "configHash", "modelId"] as const;
function validateContext(raw: NativeAgentModelCallContext): NativeAgentModelCallContext {
  const value = nativeAgentObject(nativeAgentBoundedJson(raw, 4096));
  if (Object.keys(value).some(key => !(contextKeys as readonly string[]).includes(key))) fail("NATIVE_AGENT_CONTEXT_INVALID", "模型调用上下文包含未知字段", 400);
  for (const key of contextKeys) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(String(value[key]))) fail("NATIVE_AGENT_CONTEXT_INVALID", "模型调用上下文缺少稳定标识", 400);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(value.configHash))) fail("NATIVE_AGENT_CONTEXT_INVALID", "应用配置摘要无效", 400);
  return value as unknown as NativeAgentModelCallContext;
}
function validateBillingConfig(config: BillingConfig) {
  if (!config || typeof config.tokenRoundingEnabled !== "boolean") fail("NATIVE_AGENT_PRICE_INVALID", "模型价格快照无效");
  for (const key of ["inputCostPerMillion", "outputCostPerMillion", "cachedCostPerMillion", "profitMargin", "creditsPerYuan", "tokenRoundingUnit", "tokenRoundingMin", "tokenRoundingMax"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) fail("NATIVE_AGENT_PRICE_INVALID", "模型价格快照无效");
  }
  if (config.profitMargin >= 100 || config.creditsPerYuan <= 0 || config.cachedCostPerMillion > config.inputCostPerMillion
    || !Number.isSafeInteger(config.tokenRoundingUnit) || !Number.isSafeInteger(config.tokenRoundingMin) || !Number.isSafeInteger(config.tokenRoundingMax)
    || config.tokenRoundingMin < 1 || config.tokenRoundingMax < config.tokenRoundingMin || config.tokenRoundingMax > 100_000) fail("NATIVE_AGENT_PRICE_INVALID", "模型价格或取整边界无效");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function validateBinding(raw: NativeAgentModelBinding, context: NativeAgentModelCallContext): NativeAgentModelBinding {
  const binding = nativeAgentObject(nativeAgentBoundedJson(raw, 64 * 1024)) as unknown as NativeAgentModelBinding;
  if (Object.keys(binding).some(key => !["ownerId", "taskId", "turnId", "configHash", "protocol", "protocolValidated", "publicModelId", "providerModelId", "pricing", "maxInputTokens", "maxOutputTokens", "maxCredits"].includes(key))) fail("NATIVE_AGENT_BINDING_INVALID", "冻结模型配置含有未支持字段");
  if (["ownerId", "taskId", "turnId", "configHash"].some(key => binding[key as "ownerId"] !== context[key as "ownerId"])) fail("NATIVE_AGENT_OWNER_CONFLICT", "模型配置不属于当前会员或任务", 403);
  if (binding.protocol !== "anthropic_messages" || binding.protocolValidated !== true) fail("NATIVE_AGENT_MODEL_PROTOCOL_UNCONFIRMED", "此模型尚未确认支持 Agent 原生工具协议", 409);
  if (binding.publicModelId !== context.modelId || !binding.providerModelId || binding.providerModelId.length > 200
    || binding.pricing?.publicModelId !== context.modelId || !binding.pricing.internalModelId || !binding.pricing.modelName) fail("NATIVE_AGENT_MODEL_BINDING_CONFLICT", "冻结模型与调用或价格快照不一致", 409);
  validateBillingConfig(binding.pricing.config);
  if (!Object.keys(nativeAgentObject(binding.pricing.priceSnapshot)).length) fail("NATIVE_AGENT_PRICE_INVALID", "模型缺少价格来源快照");
  if (!Number.isSafeInteger(binding.maxInputTokens) || binding.maxInputTokens < 1 || binding.maxInputTokens > 2_000_000
    || !Number.isSafeInteger(binding.maxOutputTokens) || binding.maxOutputTokens < 1 || binding.maxOutputTokens > 262_144
    || !Number.isFinite(binding.maxCredits) || binding.maxCredits < 0) fail("NATIVE_AGENT_BUDGET_INVALID", "调用预算边界无效");
  return freeze(binding);
}
export function nativeAgentModelClientRequestId(context: NativeAgentModelCallContext): string {
  // The call's route/config/request belong in the payload hash, so changing them
  // under the same owner/task/turn/call ID conflicts instead of authorizing a retry.
  return `native-agent:${hash(nativeAgentCanonicalJson({ ownerId: context.ownerId, taskId: context.taskId, turnId: context.turnId, callId: context.callId }))}`;
}
function assertAttempt(record: LlmRequestAttemptRecord, context: NativeAgentModelCallContext, clientRequestId: string, requestHash: string) {
  if (record.recordId !== hash(`${context.ownerId}\u0000${clientRequestId}`) || record.userId !== context.ownerId
    || record.clientRequestId !== clientRequestId || record.payloadFingerprint !== requestHash) fail("NATIVE_AGENT_ATTEMPT_CONFLICT", "模型调用占位回执归属或内容不一致", 409);
}
function assertExecution(execution: LlmRequestAttemptExecution) {
  if (execution.record.state !== "running" || execution.record.leaseOwner !== execution.leaseOwner || execution.record.leaseToken !== execution.leaseToken
    || !execution.leaseOwner || !Number.isSafeInteger(execution.leaseToken) || execution.leaseToken < 1) fail("NATIVE_AGENT_ATTEMPT_INVALID", "模型调用执行租约无效");
}

/** One native Messages call; tools are executed by the SDK only after this result is delivered. */
export function createNativeAgentModelGateway(ports: NativeAgentModelGatewayPorts) {
  const blockedTurns = new Set<string>();
  const activeTurns = new Set<string>();
  const call = async (input: { context: NativeAgentModelCallContext; request: unknown; signal?: AbortSignal }): Promise<NativeAgentModelCallResult> => {
    const context = freeze(validateContext(input.context));
    const turnKey = hash(nativeAgentCanonicalJson({ ownerId: context.ownerId, taskId: context.taskId, turnId: context.turnId }));
    if (blockedTurns.has(turnKey)) fail("NATIVE_AGENT_TURN_FROZEN", "本轮已有未确认调用，需按原编号核对后继续", 409);
    if (activeTurns.has(turnKey)) fail("NATIVE_AGENT_TURN_BUSY", "本轮已有模型调用正在处理", 409);
    activeTurns.add(turnKey);
    let execution: LlmRequestAttemptExecution | undefined;
    let reservation: LlmStreamReservation | undefined;
    let reservationStarted = false;
    let providerMarked = false;
    let settlementStarted = false;
    let requestHash = "";
    const clientRequestId = nativeAgentModelClientRequestId(context);
    try {
      const requested = parseNativeAgentAnthropicRequest(input.request);
      const binding = validateBinding(await ports.authorize(context), context);
      if (requested.model !== binding.publicModelId && requested.model !== binding.providerModelId) fail("NATIVE_AGENT_REQUEST_MODEL_CONFLICT", "SDK 请求模型不属于冻结配置", 409);
      const request = freeze({ ...requested, model: binding.providerModelId });
      if (request.max_tokens > binding.maxOutputTokens) fail("NATIVE_AGENT_OUTPUT_BUDGET_EXCEEDED", "请求输出预算超过应用配置", 409);
      // UTF-8 bytes include system, tool descriptions/schemas and every structured
      // tool result. Per-item and provider allowances cover hidden envelope tokens.
      const inputTokens = Buffer.byteLength(nativeAgentCanonicalJson(request), "utf8") + request.messages.length * 64 + (request.tools?.length || 0) * 256 + 8192;
      if (inputTokens > binding.maxInputTokens) fail("NATIVE_AGENT_INPUT_BUDGET_EXCEEDED", "完整工具上下文超过输入预算", 409);
      requestHash = hash(nativeAgentCanonicalJson({ version: "native-agent-model-call.v1", context, requested, request, binding }));
      const quote = await ports.accounting.quote({ binding, inputTokens, outputTokens: request.max_tokens });
      if (!Number.isFinite(quote) || quote < 0 || quote > binding.maxCredits) fail("NATIVE_AGENT_CREDIT_BUDGET_EXCEEDED", "本次模型调用超过积分预算", 409);
      const budget: NativeAgentModelBudget = freeze({ inputTokens, outputTokens: request.max_tokens, amount: quote });
      if (input.signal?.aborted) fail("NATIVE_AGENT_CALL_CANCELLED", "调用在出站前取消", 409);
      const claim = await ports.attempts.claim({ userId: context.ownerId, clientRequestId, payloadFingerprint: requestHash, leaseOwner: randomUUID() });
      const record = claim.action === "execute" ? claim.execution.record : claim.record;
      assertAttempt(record, context, clientRequestId, requestHash);
      if (claim.action !== "execute") {
        if (claim.action !== "replay") fail("NATIVE_AGENT_CALL_UNRESOLVED", "原调用正在执行或需核对，本次不重放上游", 409);
        if (record.state !== "succeeded" || !record.responseBody || record.responseFingerprint !== hash(record.responseBody)) fail("NATIVE_AGENT_REPLAY_INVALID", "原调用缺少完整结算结果");
        let saved: NativeAgentModelCallResult;
        try { saved = JSON.parse(record.responseBody) as NativeAgentModelCallResult; } catch { fail("NATIVE_AGENT_REPLAY_INVALID", "原调用结果格式无效"); }
        if (saved.receipt?.requestHash !== requestHash || saved.receipt.clientRequestId !== clientRequestId
          || contextKeys.some(key => saved.receipt[key] !== context[key]) || !saved.receipt.operationId
          || saved.receipt.priceSnapshotHash !== hash(nativeAgentCanonicalJson(binding.pricing))) fail("NATIVE_AGENT_REPLAY_INVALID", "原调用结算身份不匹配");
        const replayResponse = new Response(saved.delivery.body, { headers: { "content-type": saved.delivery.contentType } });
        const verified = await readNativeAgentAnthropicResponse(replayResponse, request);
        if (nativeAgentCanonicalJson(verified.message) !== nativeAgentCanonicalJson(saved.message) || verified.delivery.mode !== saved.delivery.mode) fail("NATIVE_AGENT_REPLAY_INVALID", "原调用协议与持久结果不符");
        return { ...saved, replayed: true };
      }
      execution = claim.execution; assertExecution(execution);
      // A reclaimed generic LLM attempt is never authority to resubmit an Agent call.
      if (execution.record.attemptNo !== 1 || execution.record.providerCallStartedAt) {
        providerMarked = true;
        fail("NATIVE_AGENT_CALL_UNRESOLVED", "原调用已有执行记录，禁止自动重放", 409);
      }
      reservationStarted = true;
      const held = await ports.accounting.reserve({ execution, context, requestHash, clientRequestId, binding, budget });
      if (held.recordId !== execution.record.recordId || held.leaseOwner !== execution.leaseOwner || held.leaseToken !== execution.leaseToken || held.amount !== budget.amount) fail("NATIVE_AGENT_RESERVATION_INVALID", "预留回执与本次模型调用不一致");
      reservation = held;
      if (input.signal?.aborted) fail("NATIVE_AGENT_CALL_CANCELLED", "调用在出站前取消", 409);
      // Marking can itself have an unknown commit outcome: retain the hold if it fails.
      providerMarked = true;
      const marked = await ports.attempts.markProviderCallStarted(execution);
      assertAttempt(marked.record, context, clientRequestId, requestHash); assertExecution(marked);
      if (marked.record.recordId !== execution.record.recordId || marked.leaseOwner !== execution.leaseOwner || marked.leaseToken !== execution.leaseToken
        || !marked.record.providerCallStartedAt) fail("NATIVE_AGENT_ATTEMPT_INVALID", "出站标记未确认");
      execution = marked;
      if (input.signal?.aborted) fail("NATIVE_AGENT_CALL_CANCELLED_UNKNOWN", "出站标记后调用被取消，需核对原调用", 409);
      const upstream = await ports.transport.send({ context, binding, request, signal: input.signal });
      const { message, delivery } = await readNativeAgentAnthropicResponse(upstream, request, input.signal);
      const totalInput = message.usage.input_tokens + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0);
      if (!Number.isSafeInteger(totalInput) || totalInput > budget.inputTokens || message.usage.output_tokens > budget.outputTokens) fail("NATIVE_AGENT_REPORTED_USAGE_EXCEEDED", "上游实际用量超过预留范围，需核对原调用", 409);
      settlementStarted = true;
      const settled = await ports.accounting.settle({ context, clientRequestId, requestHash, binding, reservation, message });
      if (!settled.operationId || !Number.isFinite(settled.creditsCharged) || settled.creditsCharged < 0 || settled.creditsCharged > budget.amount) fail("NATIVE_AGENT_SETTLEMENT_INVALID", "共享钱包结算回执无效");
      const receipt: NativeAgentModelCallReceipt = { ...context, version: "native-agent-model-call.v1", protocol: binding.protocol,
        requestHash, clientRequestId, priceSnapshotHash: hash(nativeAgentCanonicalJson(binding.pricing)), budget,
        usage: message.usage, operationId: settled.operationId, creditsCharged: settled.creditsCharged };
      const result: NativeAgentModelCallResult = { message, delivery, receipt, replayed: false };
      const responseBody = JSON.stringify(result);
      const saved = await ports.attempts.finalize({ execution, state: "succeeded", httpStatus: 200,
        responseHeaders: { "content-type": "application/json" }, responseBody, responseFingerprint: hash(responseBody),
        resultReference: `native-agent-result:${execution.record.recordId}:${hash(responseBody)}` });
      assertAttempt(saved, context, clientRequestId, requestHash);
      if (saved.state !== "succeeded" || saved.responseFingerprint !== hash(responseBody) || saved.responseBody !== responseBody) fail("NATIVE_AGENT_FINALIZATION_INVALID", "模型结果持久化终态未确认");
      return result;
    } catch (error) {
      const code = error instanceof NativeAgentModelGatewayError || error instanceof NativeAgentModelProtocolError ? error.code
        : settlementStarted ? "NATIVE_AGENT_SETTLEMENT_UNKNOWN" : providerMarked ? "NATIVE_AGENT_UPSTREAM_RESULT_UNKNOWN" : "NATIVE_AGENT_PRE_PROVIDER_FAILURE";
      // A reserve timeout may mean the hold committed; never declare it released.
      let unsafe = providerMarked || (reservationStarted && !reservation);
      if (reservation && !providerMarked) {
        try { await ports.accounting.release(reservation, code); } catch { unsafe = true; }
      }
      if (execution) {
        try {
          await ports.attempts.finalize({ execution,
            state: settlementStarted ? "reconciliation_required" : unsafe ? "failed_unknown" : "failed",
            errorCode: code, errorMessage: "Native Agent call withheld; reconcile by owned call receipt" });
        } catch { unsafe = true; }
      }
      if (unsafe || code === "NATIVE_AGENT_CALL_UNRESOLVED") {
        blockedTurns.add(turnKey);
        try { await ports.freezeTurn({ context, requestHash, code }); }
        catch { fail("NATIVE_AGENT_TURN_FREEZE_UNKNOWN", "模型调用与任务冻结状态需核对，禁止继续工具或模型调用"); }
      }
      if (error instanceof NativeAgentModelGatewayError || error instanceof NativeAgentModelProtocolError) throw error;
      fail(code, "本次原生模型调用未交付，请按原任务和调用编号核对");
    } finally { activeTurns.delete(turnKey); }
  };
  return { call, supportedModes: ["json", "buffered_original_sse"] as const };
}

export interface NativeAgentLlmAccountingPrimitives {
  calculateCredits: typeof import("../billing")["calculateCredits"];
  validateLlmStreamReservationSettlement: typeof import("../llm-credit-reservation")["validateLlmStreamReservationSettlement"];
  reserveLlmStreamCredits: typeof import("../llm-credit-reservation")["reserveLlmStreamCredits"];
  releaseLlmStreamCredits: typeof import("../llm-credit-reservation")["releaseLlmStreamCredits"];
  settleLlmUsage: typeof import("../llm-billing")["settleLlmUsage"];
}
export interface NativeAgentLlmAccountingAdapterOptions {
  /**
   * Read the live database recovery policy, not a config flag. The legacy
   * recover_llm_credit_reservations_atomic releases unknown/expired holds, so
   * it cannot safely back this gateway until a forward policy is verified.
   */
  verifyReservationSafety(input: { context: NativeAgentModelCallContext; clientRequestId: string; requestHash: string }): Promise<{
    policy: "native-agent-unknown-hold.v1";
    databaseVerified: true;
    preservesUnknownHolds: true;
    preservesExpiredProviderHolds: true;
    policyFingerprint: string;
  }>;
  primitives?: NativeAgentLlmAccountingPrimitives;
}
/** Production adapter: uses the existing wallet/attempt primitives, with no schema or price bypass. */
export async function createNativeAgentLlmAccountingAdapter(options: NativeAgentLlmAccountingAdapterOptions): Promise<NativeAgentModelAccounting> {
  if (typeof options?.verifyReservationSafety !== "function") fail("NATIVE_AGENT_RESERVATION_POLICY_UNCONFIRMED", "尚未核定 Agent 未知成本预留恢复策略，本次禁止出站");
  let primitives = options.primitives;
  if (!primitives) {
    const [billing, wallet, llmBilling] = await Promise.all([
      import("../billing"), import("../llm-credit-reservation"), import("../llm-billing"),
    ]);
    primitives = { calculateCredits: billing.calculateCredits, validateLlmStreamReservationSettlement: wallet.validateLlmStreamReservationSettlement,
      reserveLlmStreamCredits: wallet.reserveLlmStreamCredits, releaseLlmStreamCredits: wallet.releaseLlmStreamCredits,
      settleLlmUsage: llmBilling.settleLlmUsage };
  }
  const { calculateCredits, settleLlmUsage, ...wallet } = primitives;
  return {
    async quote({ binding, inputTokens, outputTokens }) {
      const config = binding.pricing.config;
      const rounding = config.tokenRoundingEnabled ? Math.max(config.tokenRoundingMin, Math.min(config.tokenRoundingMax, config.tokenRoundingUnit)) : 0;
      const quote = calculateCredits({ ...config, inputCostPerMillion: Math.max(config.inputCostPerMillion, config.cachedCostPerMillion) }, inputTokens + rounding * 2, outputTokens + rounding, 0);
      wallet.validateLlmStreamReservationSettlement({ amount: quote.creditsCharged }, quote);
      return quote.creditsCharged;
    },
    async reserve({ execution, context, requestHash, clientRequestId, binding, budget }) {
      const safety = await options.verifyReservationSafety({ context, requestHash, clientRequestId });
      if (safety?.policy !== "native-agent-unknown-hold.v1" || safety.databaseVerified !== true || safety.preservesUnknownHolds !== true
        || safety.preservesExpiredProviderHolds !== true || !/^[a-f0-9]{64}$/u.test(safety.policyFingerprint)) {
        fail("NATIVE_AGENT_RESERVATION_POLICY_UNCONFIRMED", "Agent 未知成本预留恢复策略尚未通过数据库回读，本次禁止出站");
      }
      return wallet.reserveLlmStreamCredits(execution, budget.amount, {
        ...binding.pricing.priceSnapshot, native_agent: { ...context, requestHash, clientRequestId, protocol: binding.protocol,
          providerModelId: binding.providerModelId, budget, billingConfig: binding.pricing.config, reservationPolicyFingerprint: safety.policyFingerprint },
      });
    },
    async settle({ context, clientRequestId, binding, reservation, message }) {
      // Anthropic reports cache hits separately from uncached input; the shared
      // wallet expects promptTokens to include the cached portion.
      const cached = message.usage.cache_read_input_tokens || 0;
      const result = await settleLlmUsage(context.ownerId, "原生创作 Agent", binding.providerModelId,
        message.usage.input_tokens + cached, message.usage.output_tokens, cached, undefined,
        { isAdmin: false, clientRequestId, phase: "response", billingSnapshot: binding.pricing, reservation });
      if (!result.success || !result.operationId || !result.billing) fail("NATIVE_AGENT_SETTLEMENT_INVALID", "共享钱包未确认完整结算");
      return { operationId: result.operationId, creditsCharged: result.billing.creditsCharged };
    },
    release: wallet.releaseLlmStreamCredits,
  };
}

export async function createNativeAgentDatabaseAttemptStore(): Promise<LlmRequestAttemptStore> {
  const { DatabaseLlmRequestAttemptStore } = await import("../llm-request-idempotency");
  return new DatabaseLlmRequestAttemptStore();
}
