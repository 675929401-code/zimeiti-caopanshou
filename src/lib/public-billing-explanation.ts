import type { BillingConfig } from "@/lib/billing";
import { toSelectedModelBillingConfig } from "@/lib/text-model-pricing";

type Row = Record<string, unknown>;

export interface PublicTokenPrice {
  schemaVersion: "public_token_price.v1";
  creditsPerYuan: number;
  inputCreditsPerMillion: number;
  outputCreditsPerMillion: number;
  cachedCreditsPerMillion: number;
  tokenRoundingUnit: number;
  roundingDescription: string;
}

export interface PublicTransactionBillingExplanation {
  schemaVersion: "public_transaction_billing.v1";
  status: "snapshot" | "missing_snapshot" | "invalid_snapshot" | "recorded_amount";
  message: string;
  price?: PublicTokenPrice;
  baseFeeCredits?: number;
  walletLink: {
    status: "linked" | "unlinked";
    message: string;
  };
}

export const PUBLIC_TOKEN_BILLING_DESCRIPTION = "输入 Token 包含缓存命中部分；非缓存输入、输出和缓存输入分别计价，缓存部分不重复计入普通输入。各项积分相加后向上保留到 0.01 积分，再加当次基础费用（如有）。最终扣分以该笔账本记录为准。";

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function number(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Mirrors calculateCredits' effective unit and 60% rule; never substitutes a global model price. */
export function toPublicTokenPrice(config: BillingConfig): PublicTokenPrice | undefined {
  const values = [config.inputCostPerMillion, config.outputCostPerMillion, config.cachedCostPerMillion,
    config.profitMargin, config.creditsPerYuan, config.tokenRoundingUnit, config.tokenRoundingMin, config.tokenRoundingMax];
  if (values.some(value => number(value) === null) || config.profitMargin >= 100 || config.creditsPerYuan <= 0
      || config.tokenRoundingMax < config.tokenRoundingMin || typeof config.tokenRoundingEnabled !== "boolean") return undefined;
  const divisor = 1 - config.profitMargin / 100;
  const rate = (cost: number) => cost / divisor * config.creditsPerYuan;
  const unit = config.tokenRoundingEnabled
    ? Math.max(config.tokenRoundingMin, Math.min(config.tokenRoundingMax, config.tokenRoundingUnit))
    : 0;
  const rates = [rate(config.inputCostPerMillion), rate(config.outputCostPerMillion), rate(config.cachedCostPerMillion)];
  if (rates.some(value => !Number.isFinite(value))) return undefined;
  return {
    schemaVersion: "public_token_price.v1",
    creditsPerYuan: config.creditsPerYuan,
    inputCreditsPerMillion: rates[0],
    outputCreditsPerMillion: rates[1],
    cachedCreditsPerMillion: rates[2],
    tokenRoundingUnit: unit,
    roundingDescription: unit > 0
      ? `各类 Token 分别按 ${unit.toLocaleString("zh-CN")} 为单位取整：余数达到单位的 60% 向上，否则向下；非零用量至少计一个单位。`
      : "Token 不取整，按实际用量计价；积分合计向上保留到 0.01 积分。",
  };
}

export function buildPublicBillingRules(globalConfig: BillingConfig, modelRow?: Row | null) {
  const config = modelRow ? toSelectedModelBillingConfig(modelRow, globalConfig) : undefined;
  const price = config ? toPublicTokenPrice(config) : undefined;
  return {
    schemaVersion: "public_billing_rules.v1" as const,
    // RechargeDialog depends on this field. Do not turn platform defaults into model token prices.
    creditsPerYuan: globalConfig.creditsPerYuan,
    pricingScope: modelRow ? "selected_public_model" as const : "model_specific" as const,
    priceReady: modelRow ? Boolean(price) : null,
    description: PUBLIC_TOKEN_BILLING_DESCRIPTION,
    historyDescription: "历史消费优先展示该笔保存的价格快照；缺少快照时无法还原当时单价，不使用当前价格倒算旧交易。",
    roundingDescription: price?.roundingDescription || "是否取整及取整单位由所选模型决定；模型明确不取整时，不使用平台默认取整单位。",
    ...(price ? { price } : {}),
  };
}

/** The stored snapshot is server-private: only derived sale rates cross the user API. */
function publicSnapshotPrice(value: unknown): PublicTokenPrice | undefined {
  const snapshot = object(value);
  if (snapshot.schemaVersion !== "llm_public_model_price.v1") return undefined;
  const fields = ["inputCostPerMillion", "outputCostPerMillion", "cachedCostPerMillion", "profitMargin",
    "creditsPerYuan", "tokenRoundingUnit", "tokenRoundingMin", "tokenRoundingMax"] as const;
  if (fields.some(field => number(snapshot[field]) === null) || typeof snapshot.tokenRoundingEnabled !== "boolean") return undefined;
  return toPublicTokenPrice(Object.fromEntries([
    ...fields.map(field => [field, number(snapshot[field])]),
    ["tokenRoundingEnabled", snapshot.tokenRoundingEnabled],
  ]) as unknown as BillingConfig);
}

/** Explicit projection: never pass arbitrary billing metadata, credentials, provider IDs or raw snapshots to a user. */
export function toPublicTransactionMetadata(value: unknown): Row | null {
  const metadata = object(value);
  const result: Row = {};
  for (const key of ["agent_name"] as const) {
    if (typeof metadata[key] === "string" && metadata[key].trim()) result[key] = metadata[key].slice(0, 200);
  }
  for (const key of ["prompt_tokens", "completion_tokens", "cached_tokens", "total_tokens",
    "credits_charged", "sell_price_rmb", "selling_price"] as const) {
    const parsed = number(metadata[key]);
    if (parsed !== null) result[key] = parsed;
  }
  const publicModelId = metadata.public_model_id;
  if (typeof publicModelId === "string" && /^pm_[A-Za-z0-9_-]{24}$/u.test(publicModelId)) result.public_model_id = publicModelId;
  return Object.keys(result).length ? result : null;
}

export function buildPublicTransactionBillingExplanation(
  metadataValue: unknown,
  category: "credits" | "cash",
): PublicTransactionBillingExplanation {
  const metadata = object(metadataValue);
  // Both legacy transaction tables store this reference inside metadata, not a physical column.
  const walletOperationId = metadata.wallet_operation_id;
  const linked = (typeof walletOperationId === "string" && /^[1-9][0-9]*$/u.test(walletOperationId))
    || (typeof walletOperationId === "number" && Number.isSafeInteger(walletOperationId) && walletOperationId > 0);
  const walletLink = {
    status: linked ? "linked" as const : "unlinked" as const,
    message: linked
      ? "已记录钱包操作关联；此处只展示关联信息，不代表已完成账务对账。"
      : "未记录钱包操作关联，无法据此核对该笔钱包操作。",
  };
  const base = { schemaVersion: "public_transaction_billing.v1" as const, walletLink };
  if (category === "cash") return { ...base, status: "recorded_amount", message: "展示该笔账本保存的消费金额。" };
  const snapshot = metadata.price_snapshot;
  if (snapshot === null || snapshot === undefined) return {
    ...base, status: "missing_snapshot", message: "该笔消费未保存可用的价格快照，无法还原当时单价与取整方式；扣分以账本金额为准。",
  };
  const price = publicSnapshotPrice(snapshot);
  if (!price) return {
    ...base, status: "invalid_snapshot", message: "该笔价格快照不完整或版本不支持，无法还原当时单价与取整方式；扣分以账本金额为准。",
  };
  const baseFeeCredits = number(object(snapshot).baseFeeCredits);
  return {
    ...base, status: "snapshot", price,
    ...(baseFeeCredits === null ? {} : { baseFeeCredits }),
    message: "以下单价与取整方式来自该笔消费保存的价格快照。实际扣分以账本金额为准。",
  };
}
