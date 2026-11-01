/**
 * 🔒 核心底层代码 — 锁定保护
 * 
 * 本文件是计费引擎核心，负责积分扣费、收益记录、Token取整。
 * 修改此文件需要用户明确同意，详见 AGENTS.md "核心底层代码保护规则" 章节。
 * 
 * 锁定范围：整个文件
 * 锁定原因：计费安全 + 收益准确性 + 所有账号统一计费逻辑
 */

/**
 * 计费引擎 v4 — 进货价驱动 + Token取整（开关+上下限）
 *
 * 管理员只需配置：
 *   - 进货价（元/百万token）：input_cost_per_million / output_cost_per_million / cached_cost_per_million
 *   - 利润率（%）：profit_margin（如 50 表示 50% 利润）
 *   - 积分汇率：credits_per_yuan（1 元 = 多少积分，默认 50）
 *   - Token取整开关：token_rounding_enabled（true/false）
 *   - Token取整单位：token_rounding_unit（如 100 表示向上取整到百位）
 *   - 取整下限：token_rounding_min（取整单位不得低于此值，默认100）
 *   - 取整上限：token_rounding_max（取整单位不得超过此值，默认10000）
 *
 * 系统自动计算：
 *   售价 = 进货价 ÷ (1 - 利润率)
 *   每千 token 售价 = 售价(元/百万) ÷ 1000
 *   扣积分 = 千token售价 × 积分汇率
 *
 * Token取整规则（60%阈值，保障不亏损）：
 *   当 token_rounding_enabled=true 且 token_rounding_unit > 0 时：
 *   - 取整单位会被限制在 [token_rounding_min, token_rounding_max] 范围内
 *   - 余数占取整单位 60% 以上 → 向上取整，否则向下取整
 *   - 例如取整单位=100：用了60 tokens → 按100计费（60%≥60%），用了150 tokens → 按100计费（50%<60%）
 *   - 例如取整单位=1000：用了700 tokens → 按1000计费（70%≥60%），用了1800 tokens → 按2000计费（80%≥60%）
 *   - 0 tokens 不参与取整（避免空对话扣费）
 *   当 token_rounding_enabled=false 时：精确计费，不取整
 *
 * 重要：promptTokens 包含 cachedTokens，计算时需要拆分：
 *   非缓存输入 = promptTokens - cachedTokens → 按输入价计费
 *   缓存命中 = cachedTokens → 按缓存价计费
 *   输出 = completionTokens → 按输出价计费
 *
 * 示例（进货价: 输入25/输出125/缓存2.5，利润率50%，1元=50积分，取整开启，单位1000）：
 *   输入售价 = 25 ÷ 0.5 = 50元/百万 → 1K token 扣 2.5 积分
 *   输出售价 = 125 ÷ 0.5 = 250元/百万 → 1K token 扣 12.5 积分
 *   缓存售价 = 2.5 ÷ 0.5 = 5元/百万 → 1K token 扣 0.25 积分
 *   实际使用1500输出tokens → 取整为2000（余500/1000=50%<60%→1000，但这里是1500，余500，50%<60%→1000）→ 扣 12.5 积分
 */

import { getDb } from "./db";
import { getSupabaseAdminClient } from "@/storage/database/supabase-client";

// ─── 类型 ───────────────────────────────────────────

export interface BillingConfig {
  /** 进货价：输入（元/百万 token） */
  inputCostPerMillion: number;
  /** 进货价：输出（元/百万 token） */
  outputCostPerMillion: number;
  /** 进货价：缓存（元/百万 token） */
  cachedCostPerMillion: number;
  /** 利润率 %（如 50 = 50% 利润） */
  profitMargin: number;
  /** 1 元 = 多少积分（默认 50，即 100元=5000积分） */
  creditsPerYuan: number;
  /** Token 取整开关（true=开启取整，false=精确计费） */
  tokenRoundingEnabled: boolean;
  /** Token 取整单位（如 1000 表示向上取整到千位，0=不取整） */
  tokenRoundingUnit: number;
  /** Token 取整单位下限（管理员设定的最小取整单位） */
  tokenRoundingMin: number;
  /** Token 取整单位上限（管理员设定的最大取整单位） */
  tokenRoundingMax: number;
}

export interface BillingResult {
  /** 进货成本（元） */
  actualCostRmb: number;
  /** 用户售价（元） */
  sellPriceRmb: number;
  /** 利润（元） */
  profitRmb: number;
  /** 扣除积分 */
  creditsCharged: number;
  /** 基础费用积分（如生图固定10积分） */
  baseFeeCredits: number;
  /** token消耗积分 */
  tokenCredits: number;
  /** 明细 */
  breakdown: {
    inputCostRmb: number;
    outputCostRmb: number;
    cachedCostRmb: number;
    inputSellRmb: number;
    outputSellRmb: number;
    cachedSellRmb: number;
    inputCredits: number;
    outputCredits: number;
    cachedCredits: number;
  };
  /** Token 取整信息（仅当 tokenRoundingUnit > 0 时有值） */
  rounding?: {
    /** 取整单位 */
    unit: number;
    /** 原始 tokens（取整前） */
    rawInputTokens: number;
    rawOutputTokens: number;
    rawCachedTokens: number;
    /** 取整后 tokens */
    roundedInputTokens: number;
    roundedOutputTokens: number;
    roundedCachedTokens: number;
    /** 因取整多扣的积分 */
    extraCredits: number;
  };
}

// ─── 读取配置（带60秒内存缓存） ───────────────────────────────────────
let billingConfigCache: { data: BillingConfig; ts: number } | null = null;
let billingConfigEpoch = 0;
const BILLING_CONFIG_TTL = 60_000; // 60秒缓存

// ─── 智能体计费配置缓存（60秒TTL，避免扣费时重复查 agents + llm_models） ──
const agentBillingCache = new Map<string, { data: BillingConfig | null; ts: number }>();
const AGENT_BILLING_CACHE_TTL = 60_000; // 60秒缓存

export function billingConfigFromSettingsRows(data: Array<{ setting_key: string; setting_value: string }>): BillingConfig {
  const get = (key: string, fallback: number): number => {
    const row = data?.find((r: { setting_key: string; setting_value: string }) => r.setting_key === key);
    return row ? Number(row.setting_value) || fallback : fallback;
  };

  const getBool = (key: string, fallback: boolean): boolean => {
    const row = data?.find((r: { setting_key: string; setting_value: string }) => r.setting_key === key);
    if (!row) return fallback;
    const val = row.setting_value?.toLowerCase?.();
    return val === "true" || val === "1";
  };

  const config: BillingConfig = {
    inputCostPerMillion: get("input_cost_per_million", 25),
    outputCostPerMillion: get("output_cost_per_million", 125),
    cachedCostPerMillion: get("cached_cost_per_million", 2.5),
    profitMargin: get("profit_margin", 50),
    creditsPerYuan: get("credits_per_yuan", 50),
    tokenRoundingEnabled: getBool("token_rounding_enabled", false),
    tokenRoundingUnit: get("token_rounding_unit", 0),
    tokenRoundingMin: get("token_rounding_min", 100),
    tokenRoundingMax: get("token_rounding_max", 10000),
  };
  return config;
}

export async function getBillingConfig(): Promise<BillingConfig> {
  if (billingConfigCache && Date.now() - billingConfigCache.ts < BILLING_CONFIG_TTL) {
    return billingConfigCache.data;
  }
  const readEpoch = billingConfigEpoch;
  const db = await getDb();
  const { data } = await db.from("platform_settings").select("setting_key, setting_value");

  const config = billingConfigFromSettingsRows(data || []);
  if (readEpoch === billingConfigEpoch) billingConfigCache = { data: config, ts: Date.now() };
  return config;
}

/** 强制清除缓存（管理后台修改设置时调用） */
export function invalidateBillingConfigCache() { billingConfigEpoch++; billingConfigCache = null; agentBillingCache.clear(); }

// ─── 核心计算 ───────────────────────────────────────

/** Token 取整（60%阈值规则）：若 unit > 0，对 token 数按单位取整；0 tokens 不参与取整
 *
 * 取整规则：余数占单位 60% 以上 → 向上取整，否则向下取整
 * 例1：unit=100，用了 60 tokens → 60/100=60% ≥ 60% → 取整为 100
 * 例2：unit=100，用了 150 tokens → 余50/100=50% < 60% → 取整为 100
 * 例3：unit=1000，用了 700 tokens → 700/1000=70% ≥ 60% → 取整为 1000
 * 例4：unit=1000，用了 1800 tokens → 余800/1000=80% ≥ 60% → 取整为 2000
 * 例5：unit=1000，用了 1500 tokens → 余500/1000=50% < 60% → 取整为 1000
 */
function roundTokens(tokens: number, unit: number): number {
  if (unit <= 0 || tokens <= 0) return tokens;
  const quotient = Math.floor(tokens / unit);
  const remainder = tokens % unit;
  // 余数占单位的 60% 以上则向上取整，否则向下取整
  if (remainder > 0 && (remainder / unit) >= 0.6) {
    return (quotient + 1) * unit;
  }
  return quotient * unit || unit; // 至少算 1 个单位（避免0tokens以上取整为0）
}

/** 售价 = 进货价 ÷ (1 - 利润率) */
function sellPrice(costPerMillion: number, profitMargin: number): number {
  const divisor = 1 - profitMargin / 100;
  if (divisor <= 0) return costPerMillion * 2; // 利润率≥100% 时兜底
  return costPerMillion / divisor;
}

/** 每千 token 的售价（元） */
function sellPricePer1k(costPerMillion: number, profitMargin: number): number {
  return sellPrice(costPerMillion, profitMargin) / 1000;
}

/** 每千 token 扣积分 */
function creditsPer1k(costPerMillion: number, profitMargin: number, creditsPerYuan: number): number {
  return sellPricePer1k(costPerMillion, profitMargin) * creditsPerYuan;
}

/**
 * 计算一次对话的完整费用
 * @param config   计费配置
 * @param promptTokens    输入 token 数
 * @param completionTokens 输出 token 数
 * @param cachedTokens    缓存命中 token 数
 * @param baseFeeCredits  基础费用积分（如生图固定10积分），默认0
 */
export function calculateCredits(
  config: BillingConfig,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  baseFeeCredits: number = 0,
): BillingResult {
  // ── 关键：promptTokens 包含 cachedTokens，需拆分避免重复计费 ──
  // API 返回的 prompt_tokens 是总输入 token 数（含缓存命中的部分）
  // cached_tokens 是其中缓存命中的部分，价格更低
  const nonCachedInputTokens = Math.max(0, promptTokens - cachedTokens);

  // ── Token 取整（保障不亏损） ──
  // 若 tokenRoundingEnabled 开启且 tokenRoundingUnit > 0，对各类 token 向上取整到该单位的整数倍
  // 取整单位会被限制在 [tokenRoundingMin, tokenRoundingMax] 范围内
  // 例如 unit=100：用了80 tokens → 按100计费，用了1500 tokens → 按2000计费
  const effectiveRoundingUnit = config.tokenRoundingEnabled
    ? Math.max(config.tokenRoundingMin, Math.min(config.tokenRoundingMax, config.tokenRoundingUnit))
    : 0;
  const roundedNonCachedInput = roundTokens(nonCachedInputTokens, effectiveRoundingUnit);
  const roundedCompletion = roundTokens(completionTokens, effectiveRoundingUnit);
  const roundedCached = roundTokens(cachedTokens, effectiveRoundingUnit);

  // 进货成本（元）：非缓存输入 + 输出 + 缓存输入（用原始值计算成本）
  const inputCostRmb = (nonCachedInputTokens / 1_000_000) * config.inputCostPerMillion;
  const outputCostRmb = (completionTokens / 1_000_000) * config.outputCostPerMillion;
  const cachedCostRmb = (cachedTokens / 1_000_000) * config.cachedCostPerMillion;
  const actualCostRmb = inputCostRmb + outputCostRmb + cachedCostRmb;

  // 用户售价（元）：用取整后的 token 数计算（用户按取整后数量付费）
  const inputSellRmb = (roundedNonCachedInput / 1_000_000) * sellPrice(config.inputCostPerMillion, config.profitMargin);
  const outputSellRmb = (roundedCompletion / 1_000_000) * sellPrice(config.outputCostPerMillion, config.profitMargin);
  const cachedSellRmb = (roundedCached / 1_000_000) * sellPrice(config.cachedCostPerMillion, config.profitMargin);
  const sellPriceRmb = inputSellRmb + outputSellRmb + cachedSellRmb;

  // 积分：用取整后的 token 数计算
  const inputCredits = creditsPer1k(config.inputCostPerMillion, config.profitMargin, config.creditsPerYuan) * (roundedNonCachedInput / 1000);
  const outputCredits = creditsPer1k(config.outputCostPerMillion, config.profitMargin, config.creditsPerYuan) * (roundedCompletion / 1000);
  const cachedCredits = creditsPer1k(config.cachedCostPerMillion, config.profitMargin, config.creditsPerYuan) * (roundedCached / 1000);
  const rawCredits = inputCredits + outputCredits + cachedCredits;

  // 同时计算不取整时的积分（用于对比取整带来的额外费用）
  const inputCreditsRaw = creditsPer1k(config.inputCostPerMillion, config.profitMargin, config.creditsPerYuan) * (nonCachedInputTokens / 1000);
  const outputCreditsRaw = creditsPer1k(config.outputCostPerMillion, config.profitMargin, config.creditsPerYuan) * (completionTokens / 1000);
  const cachedCreditsRaw = creditsPer1k(config.cachedCostPerMillion, config.profitMargin, config.creditsPerYuan) * (cachedTokens / 1000);
  const rawCreditsNoRounding = inputCreditsRaw + outputCreditsRaw + cachedCreditsRaw;

  // 精度处理（保留2位小数，向上取整到0.01积分，用多少扣多少）
  const tokenCreditsVal = Math.ceil(rawCredits * 100) / 100;
  const creditsCharged = tokenCreditsVal + baseFeeCredits;

  const profitRmb = sellPriceRmb - actualCostRmb;

  // 取整信息
  const hasRounding = effectiveRoundingUnit > 0 && (
    roundedNonCachedInput !== nonCachedInputTokens ||
    roundedCompletion !== completionTokens ||
    roundedCached !== cachedTokens
  );

  return {
    actualCostRmb: Math.round(actualCostRmb * 1_000_000) / 1_000_000,
    sellPriceRmb: Math.round(sellPriceRmb * 1_000_000) / 1_000_000,
    profitRmb: Math.round(profitRmb * 1_000_000) / 1_000_000,
    creditsCharged,
    baseFeeCredits,
    tokenCredits: tokenCreditsVal,
    breakdown: {
      inputCostRmb: Math.round(inputCostRmb * 1_000_000) / 1_000_000,
      outputCostRmb: Math.round(outputCostRmb * 1_000_000) / 1_000_000,
      cachedCostRmb: Math.round(cachedCostRmb * 1_000_000) / 1_000_000,
      inputSellRmb: Math.round(inputSellRmb * 1_000_000) / 1_000_000,
      outputSellRmb: Math.round(outputSellRmb * 1_000_000) / 1_000_000,
      cachedSellRmb: Math.round(cachedSellRmb * 1_000_000) / 1_000_000,
      inputCredits: Math.round(inputCredits * 100) / 100,
      outputCredits: Math.round(outputCredits * 100) / 100,
      cachedCredits: Math.round(cachedCredits * 100) / 100,
    },
    rounding: hasRounding ? {
      unit: effectiveRoundingUnit,
      rawInputTokens: nonCachedInputTokens,
      rawOutputTokens: completionTokens,
      rawCachedTokens: cachedTokens,
      roundedInputTokens: roundedNonCachedInput,
      roundedOutputTokens: roundedCompletion,
      roundedCachedTokens: roundedCached,
      extraCredits: Math.max(0, Math.round((rawCredits - rawCreditsNoRounding) * 100) / 100),
    } : effectiveRoundingUnit > 0 ? {
      unit: effectiveRoundingUnit,
      rawInputTokens: nonCachedInputTokens,
      rawOutputTokens: completionTokens,
      rawCachedTokens: cachedTokens,
      roundedInputTokens: roundedNonCachedInput,
      roundedOutputTokens: roundedCompletion,
      roundedCachedTokens: roundedCached,
      extraCredits: 0,
    } : undefined,
  };
}

// ─── 智能体级独立计费 ─────────────────────────────────

/** 智能体级计费参数（从 agents 表读取） */
export interface AgentBillingParams {
  token_billing_enabled: boolean;
  input_cost_per_million: number | null;
  output_cost_per_million: number | null;
  cached_cost_per_million: number | null;
  profit_margin: number | null;
  token_rounding_unit: number;
}

/**
 * 获取智能体级计费配置
 * 如果智能体启用了独立计费，返回智能体自己的 BillingConfig；否则返回 null（使用全局）
 */
export async function getAgentBillingConfig(agentId: string): Promise<BillingConfig | null> {
  // v4 优化：内存缓存，60秒TTL，避免每次对话扣费重复查 agents + llm_models
  const cached = agentBillingCache.get(agentId);
  if (cached && Date.now() - cached.ts < AGENT_BILLING_CACHE_TTL) {
    return cached.data;
  }

  const readEpoch = billingConfigEpoch;
  const db = await getDb();
  const { data: agent } = await db
    .from("agents")
    .select("token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit, model_id")
    .eq("id", agentId)
    .single();

  if (!agent) {
    if (readEpoch === billingConfigEpoch) agentBillingCache.set(agentId, { data: null, ts: Date.now() });
    return null;
  }

  // 优先使用 llm_models 预设中的计费配置
  if (agent.model_id) {
    const { data: modelRow } = await db
      .from("llm_models")
      .select("token_billing_enabled, input_cost_per_million, output_cost_per_million, cached_cost_per_million, profit_margin, token_rounding_unit")
      .eq("id", agent.model_id)
      .single();
    if (modelRow && modelRow.token_billing_enabled) {
      const globalConfig = await getBillingConfig();
      const result: BillingConfig = {
        inputCostPerMillion: modelRow.input_cost_per_million != null ? Number(modelRow.input_cost_per_million) : globalConfig.inputCostPerMillion,
        outputCostPerMillion: modelRow.output_cost_per_million != null ? Number(modelRow.output_cost_per_million) : globalConfig.outputCostPerMillion,
        cachedCostPerMillion: modelRow.cached_cost_per_million != null ? Number(modelRow.cached_cost_per_million) : globalConfig.cachedCostPerMillion,
        profitMargin: modelRow.profit_margin != null ? Number(modelRow.profit_margin) : globalConfig.profitMargin,
        creditsPerYuan: globalConfig.creditsPerYuan,
        tokenRoundingEnabled: (modelRow.token_rounding_unit ?? 0) > 0,
        tokenRoundingUnit: modelRow.token_rounding_unit ?? 0,
        tokenRoundingMin: globalConfig.tokenRoundingMin,
        tokenRoundingMax: globalConfig.tokenRoundingMax,
      };
      if (readEpoch === billingConfigEpoch) agentBillingCache.set(agentId, { data: result, ts: Date.now() });
      return result;
    }
  }

  if (!agent.token_billing_enabled) {
    if (readEpoch === billingConfigEpoch) agentBillingCache.set(agentId, { data: null, ts: Date.now() });
    return null;
  }

  // 智能体级独立计费：用智能体自己的成本+利润率，其余走全局默认
  const globalConfig = await getBillingConfig();
  const result: BillingConfig = {
    inputCostPerMillion: agent.input_cost_per_million != null ? Number(agent.input_cost_per_million) : globalConfig.inputCostPerMillion,
    outputCostPerMillion: agent.output_cost_per_million != null ? Number(agent.output_cost_per_million) : globalConfig.outputCostPerMillion,
    cachedCostPerMillion: agent.cached_cost_per_million != null ? Number(agent.cached_cost_per_million) : globalConfig.cachedCostPerMillion,
    profitMargin: agent.profit_margin != null ? Number(agent.profit_margin) : globalConfig.profitMargin,
    creditsPerYuan: globalConfig.creditsPerYuan, // 汇率始终全局统一：100元=5000积分
    tokenRoundingEnabled: (agent.token_rounding_unit ?? 0) > 0,
    tokenRoundingUnit: agent.token_rounding_unit ?? 0,
    tokenRoundingMin: globalConfig.tokenRoundingMin,
    tokenRoundingMax: globalConfig.tokenRoundingMax,
  };
  if (readEpoch === billingConfigEpoch) agentBillingCache.set(agentId, { data: result, ts: Date.now() });
  return result;
}

/**
 * 带智能体级独立计费的扣费
 * 优先使用智能体级配置，若无则回退到全局配置
 */
export async function deductCreditsWithAgentBilling(
  userId: string,
  agentName: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  operation: BillingOperationContext,
  agentId?: string,
  baseFeeCredits: number = 0,
  billingConfigOverride?: BillingConfig,
): Promise<CreditDeductionResult> {
  const operationError = validateBillingOperationContext(operation);
  if (operationError) {
    return { success: false, error: operationError };
  }
  // 用户明确选择公共模型时，调用方会传入该模型的计费配置。
  // 该配置必须优先于智能体绑定模型及平台全局默认值，否则虚拟智能体
  // （数据库中没有 agents 行）会按错误的全局费率扣费。
  let config: BillingConfig;
  let isAgentBilling = false;
  const isSelectedModelBilling = Boolean(billingConfigOverride);
  if (billingConfigOverride) {
    config = billingConfigOverride;
    isAgentBilling = true;
  } else if (agentId) {
    const agentConfig = await getAgentBillingConfig(agentId);
    if (agentConfig) {
      config = agentConfig;
      isAgentBilling = true;
    } else {
      config = await getBillingConfig();
    }
  } else {
    config = await getBillingConfig();
  }

  const billing = calculateCredits(config, promptTokens, completionTokens, cachedTokens, baseFeeCredits);
  if (billing.creditsCharged === 0) {
    return { success: true, billing, operationId: operation.idempotencyKey };
  }

  const result = await applyAtomicWalletOperation({
    userId,
    operationKind: 'credit_charge',
    idempotencyKey: operation.idempotencyKey,
    amount: billing.creditsCharged,
    description: `${agentName} 对话（${model}）${isAgentBilling ? '[独立计费]' : ''}`,
    metadata: buildCreditBillingMetadata({
      operation,
      agentName,
      model,
      promptTokens,
      completionTokens,
      cachedTokens,
      billing,
      config,
      billingSource: isSelectedModelBilling
        ? 'selected_public_model'
        : isAgentBilling
          ? 'agent_or_bound_model'
          : 'global',
    }),
  });

  return {
    success: result.success,
    billing,
    balanceAfter: result.success ? result.balanceAfter : undefined,
    alreadyFulfilled: result.alreadyFulfilled,
    operationId: result.operationId,
    error: result.error,
  };
}

// ─── 扣费 ───────────────────────────────────────────

/**
 * 原子扣费 — 使用 Supabase RPC 函数避免并发竞态
 *
 * 关键设计：
 * 1. 使用 UPDATE ... WHERE credits >= creditsCharged 实现行级锁原子扣费
 * 2. 余额不足时拒绝扣费（不允许部分扣费后免费使用）
 * 3. 扣费和记录流水在同一事务中完成（RPC 函数内）
 *
 * 如果 RPC 不可用，回退到应用层两步扣费（增加并发保护）
 */
export async function deductCredits(
  userId: string,
  agentName: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number,
  operation: BillingOperationContext,
  baseFeeCredits: number = 0,
): Promise<CreditDeductionResult> {
  const operationError = validateBillingOperationContext(operation);
  if (operationError) {
    return { success: false, error: operationError };
  }
  const config = await getBillingConfig();
  const billing = calculateCredits(config, promptTokens, completionTokens, cachedTokens, baseFeeCredits);
  if (billing.creditsCharged === 0) {
    return { success: true, billing, operationId: operation.idempotencyKey };
  }

  const result = await applyAtomicWalletOperation({
    userId,
    operationKind: 'credit_charge',
    idempotencyKey: operation.idempotencyKey,
    amount: billing.creditsCharged,
    description: `${agentName} 对话（${model}）`,
    metadata: buildCreditBillingMetadata({
      operation,
      agentName,
      model,
      promptTokens,
      completionTokens,
      cachedTokens,
      billing,
      config,
      billingSource: 'global',
    }),
  });

  return {
    success: result.success,
    billing,
    balanceAfter: result.success ? result.balanceAfter : undefined,
    alreadyFulfilled: result.alreadyFulfilled,
    operationId: result.operationId,
    error: result.error,
  };
}

// ─── 统一钱包计费（积分与现金共享同一原子操作协议和幂等规则） ────────

export type AtomicWalletOperationKind =
  | 'credit_topup'
  | 'credit_refund'
  | 'credit_charge'
  | 'cash_topup'
  | 'cash_refund'
  | 'cash_charge';

type AtomicWalletRpcResult = {
  success?: boolean;
  already_fulfilled?: boolean;
  operation_id?: number | string;
  wallet?: 'credits' | 'cash';
  operation_kind?: AtomicWalletOperationKind;
  amount?: number | string;
  delta?: number | string;
  balance_before?: number | string;
  balance_after?: number | string;
};

export interface AtomicWalletOperationResult {
  success: boolean;
  alreadyFulfilled: boolean;
  operationId?: string;
  wallet?: 'credits' | 'cash';
  operationKind?: AtomicWalletOperationKind;
  amount?: number;
  delta?: number;
  balanceBefore?: number;
  balanceAfter: number;
  error?: string;
}

export async function applyAtomicWalletOperation(input: {
  userId: string;
  operationKind: AtomicWalletOperationKind;
  idempotencyKey: string;
  amount: number;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<AtomicWalletOperationResult> {
  const userId = input.userId?.trim() || '';
  const amount = Number(input.amount);
  const idempotencyKey = input.idempotencyKey.trim();
  const description = input.description?.trim() || '';
  if (!userId) {
    return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '缺少有效的用户标识' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '金额必须为有效正数' };
  }
  if (!idempotencyKey || idempotencyKey.length > 240) {
    return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '缺少有效的幂等业务标识' };
  }
  if (!description || description.length > 1000) {
    return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '缺少有效的计费说明' };
  }

  try {
    const db = getSupabaseAdminClient();
    const { data, error } = await db.rpc('apply_wallet_operation_atomic', {
      p_user_id: userId,
      p_operation_kind: input.operationKind,
      p_idempotency_key: idempotencyKey,
      p_amount: amount,
      p_description: description,
      p_metadata: input.metadata || {},
    });
    if (error) {
      const migrationMissing = /apply_wallet_operation_atomic|schema cache|function/i.test(error.message || '');
      return {
        success: false,
        alreadyFulfilled: false,
        balanceAfter: 0,
        error: migrationMissing
          ? '原子钱包迁移尚未部署，已拒绝非原子余额操作'
          : String(error.message || '').includes('VIDEO_BUDGET_CASH_RESERVED')
            ? '部分现金余额已被在途视频任务预留，请等待原任务结算或补充可用余额'
          : '原子钱包操作失败',
      };
    }

    const result = data as AtomicWalletRpcResult | null;
    const operationId = result?.operation_id == null ? '' : String(result.operation_id);
    const resultAmount = Number(result?.amount);
    const delta = Number(result?.delta);
    const balanceBefore = Number(result?.balance_before);
    const balanceAfter = Number(result?.balance_after);
    if (
      !result?.success
      || !operationId
      || !result.wallet
      || !result.operation_kind
      || !Number.isFinite(resultAmount)
      || !Number.isFinite(delta)
      || !Number.isFinite(balanceBefore)
      || !Number.isFinite(balanceAfter)
    ) {
      return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '原子钱包返回结果无效' };
    }
    return {
      success: true,
      alreadyFulfilled: result.already_fulfilled === true,
      operationId,
      wallet: result.wallet,
      operationKind: result.operation_kind,
      amount: resultAmount,
      delta,
      balanceBefore,
      balanceAfter,
    };
  } catch (error) {
    console.error('[Billing] apply_wallet_operation_atomic failed:', error instanceof Error ? error.message : 'unknown');
    return { success: false, alreadyFulfilled: false, balanceAfter: 0, error: '原子钱包服务不可用' };
  }
}

/**
 * Stable business identity for one wallet mutation.
 *
 * The idempotency key must be derived from a persisted request/task/job id,
 * never from Date.now() or a random value generated at deduction time.  A
 * multi-phase request must use deterministic suffixes such as
 * `llm:<clientRequestId>:thinking` and `llm:<clientRequestId>:answer`.
 */
export interface BillingOperationContext {
  idempotencyKey: string;
  phase?: string;
  publicModelId?: string;
  priceSnapshot?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CreditDeductionResult {
  success: boolean;
  billing?: BillingResult;
  balanceAfter?: number;
  alreadyFulfilled?: boolean;
  operationId?: string;
  error?: string;
}

function validateBillingOperationContext(operation: BillingOperationContext | null | undefined): string | undefined {
  const key = operation?.idempotencyKey?.trim() || '';
  if (!key || key.length > 240) {
    return '缺少有效的幂等业务标识';
  }
  return undefined;
}

function buildCreditBillingMetadata(input: {
  operation: BillingOperationContext;
  agentName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  billing: BillingResult;
  config: BillingConfig;
  billingSource: string;
}): Record<string, unknown> {
  return {
    ...(input.operation.metadata || {}),
    phase: input.operation.phase || null,
    public_model_id: input.operation.publicModelId || null,
    price_snapshot: input.operation.priceSnapshot || null,
    agent_name: input.agentName,
    model: input.model,
    prompt_tokens: input.promptTokens,
    completion_tokens: input.completionTokens,
    cached_tokens: input.cachedTokens,
    actual_cost_rmb: input.billing.actualCostRmb,
    sell_price_rmb: input.billing.sellPriceRmb,
    profit_rmb: input.billing.profitRmb,
    credits_charged: input.billing.creditsCharged,
    credits_expected: input.billing.creditsCharged,
    profit_margin: input.config.profitMargin,
    credits_per_yuan: input.config.creditsPerYuan,
    billing_source: input.billingSource,
  };
}

/**
 * 充值积分（支付成功后调用）
 * @param userId 用户ID
 * @param amount 充值积分数量
 */
export async function addCredits(
  userId: string,
  amount: number,
  description: string,
  referenceId: string,
  operationKind: 'credit_topup' | 'credit_refund' = 'credit_topup',
): Promise<{ success: boolean; balanceAfter?: number; alreadyFulfilled?: boolean; error?: string }> {
  const result = await applyAtomicWalletOperation({
    userId,
    operationKind,
    idempotencyKey: referenceId,
    amount,
    description,
    metadata: { source: 'billing.addCredits' },
  });
  return {
    success: result.success,
    balanceAfter: result.balanceAfter,
    alreadyFulfilled: result.alreadyFulfilled,
    error: result.error,
  };
}


/**
 * 预检现金余额
 * @param userId 用户ID
 * @param pricePerUse 单价（元）
 * @returns 余额是否充足 + 当前余额
 */
export async function checkCashBalance(
  userId: string,
  pricePerUse: number
): Promise<{ sufficient: boolean; currentBalance: number; required: number }> {
  const db = getSupabaseAdminClient();
  const { data, error } = await db
    .from('users')
    .select('cash_balance')
    .eq('id', userId)
    .single();

  if (error || !data) {
    return { sufficient: false, currentBalance: 0, required: pricePerUse };
  }

  const currentBalance = Number(data.cash_balance) || 0;
  return {
    sufficient: currentBalance >= pricePerUse,
    currentBalance,
    required: pricePerUse,
  };
}

/**
 * 现金扣费（视频/封面生成成功后调用）
 * 原子性保证：使用乐观锁防止并发超扣
 * 只有生成成功才扣费，失败/超时不扣
 * @param userId 用户ID
 * @param amount 扣费金额（元）
 * @param description 描述（如"视频生成-可灵V2大师版"）
 * @param referenceId 关联ID（如task_id）
 * @returns 是否扣费成功
 */
export async function deductCash(
  userId: string,
  amount: number,
  description: string,
  referenceId: string
): Promise<{ success: boolean; deductedAmount: number; balanceAfter: number; alreadyFulfilled?: boolean; operationId?: string; error?: string }> {
  const numericAmount = Number(amount);
  if (numericAmount === 0) {
    const key = referenceId?.trim() || '';
    if (!key || key.length > 240) {
      return { success: false, deductedAmount: 0, balanceAfter: 0, error: '缺少有效的幂等业务标识' };
    }
    return { success: true, deductedAmount: 0, balanceAfter: 0, operationId: key };
  }
  const result = await applyAtomicWalletOperation({
    userId,
    operationKind: 'cash_charge',
    idempotencyKey: referenceId,
    amount: numericAmount,
    description,
    metadata: { source: 'billing.deductCash' },
  });
  return {
    success: result.success,
    deductedAmount: result.success && !result.alreadyFulfilled ? numericAmount : 0,
    balanceAfter: result.balanceAfter,
    alreadyFulfilled: result.alreadyFulfilled,
    operationId: result.operationId,
    error: result.error,
  };
}

/**
 * 现金充值（内部/在线支付回调用）
 * 仅使用原子RPC（防并发 + 自动记录流水）；迁移缺失时拒绝操作
 */
export async function topupCash(
  userId: string,
  amount: number,
  description: string,
  referenceId: string,
): Promise<{ success: boolean; balanceAfter: number; alreadyFulfilled?: boolean; error?: string }> {
  const result = await applyAtomicWalletOperation({
    userId,
    operationKind: 'cash_topup',
    idempotencyKey: referenceId,
    amount,
    description,
    metadata: { source: 'billing.topupCash' },
  });
  return {
    success: result.success,
    balanceAfter: result.balanceAfter,
    alreadyFulfilled: result.alreadyFulfilled,
    error: result.error,
  };
}

/**
 * 现金退回（视频生成失败/取消时退回预扣金额）
 * 仅使用原子RPC；幂等键必须源自原始扣费操作或退款单
 */
export async function refundCash(
  userId: string,
  amount: number,
  description: string,
  referenceId: string
): Promise<{ success: boolean; balanceAfter: number; alreadyFulfilled?: boolean; error?: string }> {
  const result = await applyAtomicWalletOperation({
    userId,
    operationKind: 'cash_refund',
    idempotencyKey: referenceId,
    amount,
    description,
    metadata: { source: 'billing.refundCash' },
  });
  return {
    success: result.success,
    balanceAfter: result.balanceAfter,
    alreadyFulfilled: result.alreadyFulfilled,
    error: result.error,
  };
}

/**
 * 检查并追缴欠费（视频扣费失败时记录欠费，下次消费前自动补扣）
 * 设计原则：不阻断用户操作，但优先补扣历史欠费
 * @returns 真实可用余额（已扣除欠费后的余额）
 */
export async function checkAndCollectDebt(userId: string): Promise<{
  hasDebt: boolean;
  debtAmount: number;
  collected: number;
  remainingDebt: number;
  canProceed: boolean;
  availableBalance: number;
  failureCode?: 'DEBT_LEDGER_UNAVAILABLE';
}> {
  const db = getSupabaseAdminClient();
  let debtCollected = 0;

  try {
    // 查询未缴欠费记录
    const { data: debts, error: debtQueryError } = await db
      .from('cash_debt_records')
      .select('id, amount, description')
      .eq('user_id', userId)
      .eq('status', 'unpaid')
      .order('created_at', { ascending: true });
    if (debtQueryError) {
      throw new Error(`DEBT_LEDGER_QUERY_FAILED:${debtQueryError.code || 'UNKNOWN'}`);
    }

    const totalDebt = (debts || []).reduce((sum: number, d: { amount: number }) => sum + Number(d.amount), 0);

    if (!debts || debts.length === 0) {
      const { data: user } = await db.from('users').select('cash_balance').eq('id', userId).single();
      const bal = Number(user?.cash_balance) || 0;
      return { hasDebt: false, debtAmount: 0, collected: 0, remainingDebt: 0, canProceed: true, availableBalance: bal };
    }

    // 尝试补扣每笔欠费
    for (const debt of debts) {
      const result = await deductCash(userId, debt.amount, `补扣欠费: ${debt.description}`, debt.id);
      if (result.success) {
        debtCollected += Number(debt.amount);
        const { error: debtUpdateError } = await db
          .from('cash_debt_records')
          .update({ status: 'paid', paid_at: new Date().toISOString() })
          .eq('id', debt.id);
        if (debtUpdateError) {
          throw new Error(`DEBT_LEDGER_UPDATE_FAILED:${debtUpdateError.code || 'UNKNOWN'}`);
        }
      } else {
        break;
      }
    }

    const { data: user } = await db.from('users').select('cash_balance').eq('id', userId).single();
    const bal = Number(user?.cash_balance) || 0;
    const remainingDebt = totalDebt - debtCollected;
    return {
      hasDebt: remainingDebt > 0,
      debtAmount: totalDebt,
      collected: debtCollected,
      remainingDebt,
      canProceed: remainingDebt <= 0,  // 有未缴欠费时不允许新消费
      availableBalance: bal,
    };
  } catch (err) {
    console.error('[checkAndCollectDebt] exception:', err);
    const { data: user } = await db.from('users').select('cash_balance').eq('id', userId).single();
    const bal = Number(user?.cash_balance) || 0;
    return {
      hasDebt: false,
      debtAmount: 0,
      collected: 0,
      remainingDebt: 0,
      canProceed: false,
      availableBalance: bal,
      failureCode: 'DEBT_LEDGER_UNAVAILABLE',
    };
  }
}

/**
 * 记录欠费（视频扣费失败时调用）
 * 欠费记录不阻断用户，但下次消费前会优先补扣
 */
export async function recordDebt(
  userId: string,
  amount: number,
  description: string,
  referenceId?: string
): Promise<void> {
  const db = getSupabaseAdminClient();
  try {
    await db.from('cash_debt_records').insert({
      user_id: userId,
      amount,
      description,
      reference_id: referenceId || null,
      status: 'unpaid',
    });
    console.warn(`[recordDebt] 欠费记录: userId=${userId}, amount=${amount}, desc=${description}`);
  } catch (err) {
    console.error('[recordDebt] 记录欠费失败:', err);
  }
}

/**
 * 现金充值（管理员给用户充值）
 * 统一委托到 topupCash（BUG-9 修复：消除重复函数）
 */
export async function topUpCash(
  userId: string,
  amount: number,
  description: string,
  referenceId: string,
): Promise<{ success: boolean; balanceAfter: number; alreadyFulfilled?: boolean; error?: string }> {
  return topupCash(userId, amount, description, referenceId);
}

// ─── 辅助：前端展示用 ──────────────────────────────

/** 获取完整计费摘要（管理后台展示） */
export async function getBillingSummary() {
  const config = await getBillingConfig();

  const calc = (cost: number) => ({
    costPerMillion: cost,
    sellPerMillion: Math.round(sellPrice(cost, config.profitMargin) * 100) / 100,
    costPer1k: cost / 1000,
    sellPer1k: Math.round(sellPricePer1k(cost, config.profitMargin) * 100000) / 100000,
    creditsPer1k: Math.round(creditsPer1k(cost, config.profitMargin, config.creditsPerYuan) * 100) / 100,
    tokensPerYuan: Math.round(1 / sellPricePer1k(cost, config.profitMargin)),
    tokensPer100Credits: Math.round(100 / (creditsPer1k(cost, config.profitMargin, config.creditsPerYuan)) * 1000),
  });

  return {
    config,
    input: calc(config.inputCostPerMillion),
    output: calc(config.outputCostPerMillion),
    cached: calc(config.cachedCostPerMillion),
  };
}

/**
 * 获取面向用户的积分规则说明（前端展示用）
 * 返回可读的规则文本 + 关键数值，供积分规则说明弹窗使用
 */
export async function getBillingRules() {
  const config = await getBillingConfig();

  // 每千token扣积分
  const inputCreditsPer1k = creditsPer1k(config.inputCostPerMillion, config.profitMargin, config.creditsPerYuan);
  const outputCreditsPer1k = creditsPer1k(config.outputCostPerMillion, config.profitMargin, config.creditsPerYuan);
  const cachedCreditsPer1k = creditsPer1k(config.cachedCostPerMillion, config.profitMargin, config.creditsPerYuan);

  // 1积分能消耗多少tokens（按输出计价，最常见的消费场景）
  const tokensPerCreditInput = inputCreditsPer1k > 0 ? Math.floor(1000 / inputCreditsPer1k) : 0;
  const tokensPerCreditOutput = outputCreditsPer1k > 0 ? Math.floor(1000 / outputCreditsPer1k) : 0;
  const tokensPerCreditCached = cachedCreditsPer1k > 0 ? Math.floor(1000 / cachedCreditsPer1k) : 0;

  // 100积分能消耗多少tokens
  const tokensPer100Input = tokensPerCreditInput * 100;
  const tokensPer100Output = tokensPerCreditOutput * 100;

  return {
    // 核心规则
    creditsPerYuan: config.creditsPerYuan,           // 1元=多少积分
    tokenRoundingUnit: config.tokenRoundingUnit,     // Token取整单位
    profitMargin: config.profitMargin,               // 利润率
    // 每千token扣积分
    inputCreditsPer1k: Math.round(inputCreditsPer1k * 100) / 100,
    outputCreditsPer1k: Math.round(outputCreditsPer1k * 100) / 100,
    cachedCreditsPer1k: Math.round(cachedCreditsPer1k * 100) / 100,
    // 1积分=多少tokens
    tokensPerCreditInput,
    tokensPerCreditOutput,
    tokensPerCreditCached,
    // 100积分=多少tokens
    tokensPer100Input,
    tokensPer100Output,
    // 取整规则说明
    roundingDescription: config.tokenRoundingUnit > 0
      ? `Token用量向上取整到${config.tokenRoundingUnit.toLocaleString()}的整数倍（如用了1,500 tokens按2,000计费）`
      : "按实际Token用量精确计费",
    // 充值示例
    rechargeExamples: [
      { yuan: 100, credits: 100 * config.creditsPerYuan, approxInputTokens: 100 * config.creditsPerYuan * tokensPerCreditInput, approxOutputTokens: 100 * config.creditsPerYuan * tokensPerCreditOutput },
      { yuan: 200, credits: 200 * config.creditsPerYuan, approxInputTokens: 200 * config.creditsPerYuan * tokensPerCreditInput, approxOutputTokens: 200 * config.creditsPerYuan * tokensPerCreditOutput },
      { yuan: 500, credits: 500 * config.creditsPerYuan, approxInputTokens: 500 * config.creditsPerYuan * tokensPerCreditInput, approxOutputTokens: 500 * config.creditsPerYuan * tokensPerCreditOutput },
    ],
  };
}
