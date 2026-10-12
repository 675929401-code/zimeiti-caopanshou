// LLM 计费模块 — 从 route.ts 拆分
// 负责：积分预检、流后扣费、收益记录
// 修改计费规则只改这个文件，不动 route.ts

import {
  deductCreditsWithAgentBilling,
  getBillingConfig,
  getAgentBillingConfig,
  calculateCredits,
  type BillingConfig,
} from "@/lib/billing";
import { recordRevenue } from "@/lib/revenue";
import { settleLlmStreamCredits, type LlmStreamReservation } from "@/lib/llm-credit-reservation";
import {
  buildLlmBillingIdempotencyKey,
  type LlmBillingPhase,
} from "@/lib/llm-request-idempotency";
import { toSelectedModelBillingConfig } from "@/lib/text-model-pricing";

/** 计费结果 */
export interface BillingResult {
  success: boolean;
  billing?: {
    actualCostRmb: number;
    sellPriceRmb: number;
    creditsCharged: number;
  };
  balanceAfter?: number;
  alreadyFulfilled?: boolean;
  operationId?: string;
  error?: string;
}

export interface SelectedModelBillingSnapshot {
  publicModelId: string;
  internalModelId: string;
  modelName: string;
  config: BillingConfig;
  priceSnapshot: Record<string, unknown>;
}

export class LlmBillingSettlementError extends Error {
  readonly code = "LLM_BILLING_FAILED";

  constructor(message: string, readonly operationId: string) {
    super(message);
    this.name = "LlmBillingSettlementError";
  }
}

// ── 预检最低估算参数 ──
// 一次最短对话的假定 token 数（保守估算，确保用户余额至少够一次基础对话）
const MIN_ESTIMATED_OUTPUT_TOKENS = 100;   // 最少输出100 tokens
const MIN_ESTIMATED_INPUT_TOKENS = 200;    // 最少输入200 tokens（含上下文）
const MIN_ESTIMATED_CACHED_TOKENS = 0;     // 预检时保守不计缓存

/**
 * 把用户实际选中的公共模型行转换为计费配置。
 *
 * 这是纯函数，便于零网络验证。只要请求已经绑定到一条已发布模型行，
 * 就必须从该模型自己的显式 Token 成本与利润字段形成完整、不可变的
 * 价格快照。任何必填字段缺失或无效都返回 undefined，让路由在调用
 * 供应商之前失败关闭；全局配置只提供积分汇率与统一取整边界。
 */
export function resolveSelectedModelBillingConfig(
  modelRow: Record<string, unknown> | null | undefined,
  globalConfig: BillingConfig,
): BillingConfig | undefined {
  return toSelectedModelBillingConfig(modelRow, globalConfig);
}

export async function getSelectedModelBillingConfig(
  modelRow: Record<string, unknown> | null | undefined,
): Promise<BillingConfig | undefined> {
  if (!modelRow) return undefined;
  return resolveSelectedModelBillingConfig(modelRow, await getBillingConfig());
}

export function buildSelectedModelBillingSnapshot(
  publicModelId: string, modelRow: Record<string, unknown> | null | undefined, globalConfig: BillingConfig,
): SelectedModelBillingSnapshot | undefined {
  const normalizedPublicModelId = publicModelId.trim();
  if (!normalizedPublicModelId || !modelRow) return undefined;
  const config = resolveSelectedModelBillingConfig(modelRow, globalConfig);
  if (!config) return undefined;

  const internalModelId = String(modelRow.id || "").trim();
  const modelName = String(modelRow.model_name || modelRow.name || "").trim();
  if (!internalModelId || !modelName) return undefined;

  return {
    publicModelId: normalizedPublicModelId,
    internalModelId,
    modelName,
    config,
    priceSnapshot: {
      schemaVersion: "llm_public_model_price.v1",
      publicModelId: normalizedPublicModelId,
      internalModelId,
      modelName,
      inputCostPerMillion: config.inputCostPerMillion,
      outputCostPerMillion: config.outputCostPerMillion,
      cachedCostPerMillion: config.cachedCostPerMillion,
      profitMargin: config.profitMargin,
      creditsPerYuan: config.creditsPerYuan,
      tokenRoundingEnabled: config.tokenRoundingEnabled,
      tokenRoundingUnit: config.tokenRoundingUnit,
      tokenRoundingMin: config.tokenRoundingMin,
      tokenRoundingMax: config.tokenRoundingMax,
    },
  };
}

export async function getSelectedModelBillingSnapshot(
  publicModelId: string,
  modelRow: Record<string, unknown> | null | undefined,
): Promise<SelectedModelBillingSnapshot | undefined> {
  if (!publicModelId.trim() || !modelRow) return undefined;
  return buildSelectedModelBillingSnapshot(publicModelId, modelRow, await getBillingConfig());
}

/**
 * 积分预检：检查用户是否有足够积分
 * v2: 基于模型单价估算最低消耗，而非简单的 credits <= 0
 * 返回 null 表示通过，返回 Response 表示拦截
 */
export async function checkCreditsBalance(
  credits: number | undefined,
  isAdmin: boolean,
  agentId?: string,
  selectedModelBillingConfig?: BillingConfig,
): Promise<Response | null> {
  // Role controls administration, never price. Keep the parameter for caller
  // compatibility while applying the same wallet policy to every account.
  void isAdmin;
  // ⚠️ 安全修复：积分查询失败时拦截（fail-closed），不再放行
  // 此前: credits === undefined 时 return null（放行），攻击者可绕过积分检查
  if (credits === undefined || credits === null) {
    return new Response(
      JSON.stringify({ error: "无法查询积分余额，请重新登录", code: "CREDITS_QUERY_FAILED" }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // 估算一次最短对话的最低积分消耗
  let minRequiredCredits = 1; // 默认最低1积分

  try {
    const config = selectedModelBillingConfig || (agentId
      ? (await getAgentBillingConfig(agentId)) || (await getBillingConfig())
      : await getBillingConfig());

    const estimate = calculateCredits(
      config,
      MIN_ESTIMATED_INPUT_TOKENS,
      MIN_ESTIMATED_OUTPUT_TOKENS,
      MIN_ESTIMATED_CACHED_TOKENS
    );
    minRequiredCredits = Math.max(0, Math.ceil(estimate.creditsCharged));
  } catch {
    // 配置读取失败时保守使用默认值1
  }

  if (credits < minRequiredCredits) {
    return new Response(
      JSON.stringify({
        error: `积分不足，至少需要 ${minRequiredCredits} 积分才能发起对话，当前余额 ${Math.floor(credits)} 积分`,
        code: "INSUFFICIENT_CREDITS",
        min_required: minRequiredCredits,
        current_credits: Math.floor(credits),
      }),
      { status: 402, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

/**
 * Settle one completed LLM phase against the shared atomic wallet.
 *
 * A completed response must not be exposed until this promise resolves.  The
 * stable request/phase key is also the database wallet idempotency key, so a
 * transport retry cannot create a second charge.
 */
export async function settleLlmUsage(
  userId: string,
  agentName: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  agentId: string | undefined,
  options: {
    isAdmin: boolean;
    clientRequestId: string;
    phase: LlmBillingPhase;
    billingSnapshot: SelectedModelBillingSnapshot;
    isDeepThinking?: boolean;
    baseFeeCredits?: number;
    reservation?: LlmStreamReservation;
  }
): Promise<BillingResult> {
  const operationId = buildLlmBillingIdempotencyKey(options.clientRequestId, options.phase);
  try {
    const result = options.reservation
      ? await settleLlmStreamCredits(
          options.reservation,
          calculateCredits(options.billingSnapshot.config, promptTokens, completionTokens, cachedTokens, options.baseFeeCredits || 0),
          `${agentName} 对话（${model}）`,
          { phase: options.phase, public_model_id: options.billingSnapshot.publicModelId,
            internalModelId: options.billingSnapshot.internalModelId, model, agent_name: agentName,
            prompt_tokens: promptTokens, completion_tokens: completionTokens, cached_tokens: cachedTokens,
            billing_source: "selected_public_model", credits_per_yuan: options.billingSnapshot.config.creditsPerYuan,
            profit_margin: options.billingSnapshot.config.profitMargin },
        )
      : await deductCreditsWithAgentBilling(
      userId, agentName, model,
      promptTokens, completionTokens, cachedTokens,
      {
        idempotencyKey: operationId,
        phase: options.phase,
        publicModelId: options.billingSnapshot.publicModelId,
        priceSnapshot: options.billingSnapshot.priceSnapshot,
        metadata: {
          internalModelId: options.billingSnapshot.internalModelId,
          modelName: options.billingSnapshot.modelName,
        },
      },
      agentId,
      options.baseFeeCredits || 0,
      options.billingSnapshot.config,
    );

    if (!result.success || !result.billing || !result.operationId) {
      throw new LlmBillingSettlementError(
        result.error || "模型调用已完成，但共享钱包结算失败",
        operationId,
      );
    }

    try {
      await recordRevenue({
        userId,
        userRole: options.isAdmin ? "admin" : "student",
        modelId: `llm:${options.billingSnapshot.publicModelId}${options.isDeepThinking ? ":think" : ""}`,
        taskId: operationId,
        costPrice: result.billing.actualCostRmb,
        sellingPrice: result.billing.sellPriceRmb,
        recordType: options.isDeepThinking ? "deep_thinking" : "chat",
        creditsCharged: result.billing.creditsCharged,
      });
    } catch {
      throw new LlmBillingSettlementError("模型已完成扣款，但收益流水尚未确认，请按原请求编号对账", operationId);
    }

    return {
      success: true,
      billing: result.billing,
      balanceAfter: result.balanceAfter,
      alreadyFulfilled: result.alreadyFulfilled,
      operationId: result.operationId,
    };
  } catch (err) {
    if (err instanceof LlmBillingSettlementError) throw err;
    console.error("[Billing] 原子结算异常:", err);
    throw new LlmBillingSettlementError("共享钱包结算服务不可用", operationId);
  }
}
