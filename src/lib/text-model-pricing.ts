import type { BillingConfig } from "@/lib/billing";
import type { PublicModelCapability } from "@/lib/public-model-dto";

export interface TextModelTokenPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedCostPerMillion: number;
  profitMargin: number;
  tokenRoundingUnit: number;
}

export type TextModelPricingReadiness =
  | {
      priceReady: true;
      code: "TEXT_MODEL_PRICE_READY";
      message: string;
      pricing: TextModelTokenPricing;
    }
  | {
      priceReady: false;
      code: "TEXT_MODEL_TOKEN_BILLING_DISABLED" | "TEXT_MODEL_PRICE_INCOMPLETE" | "TEXT_MODEL_PRICE_INVALID";
      message: string;
    };

const REQUIRED_TOKEN_PRICE_FIELDS = [
  "input_cost_per_million",
  "output_cost_per_million",
  "cached_cost_per_million",
  "profit_margin",
] as const;

function isExplicit(value: unknown): boolean {
  return value !== null
    && value !== undefined
    && (typeof value !== "string" || value.trim().length > 0);
}

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Validate the model-owned token price without consulting global defaults.
 * Explicit zero is valid; a missing/invalid field is unknown and must block a
 * provider request rather than silently borrowing another price.
 */
export function inspectTextModelPricing(
  modelRow: Record<string, unknown> | null | undefined,
): TextModelPricingReadiness {
  if (!modelRow || modelRow.token_billing_enabled !== true) {
    return {
      priceReady: false,
      code: "TEXT_MODEL_TOKEN_BILLING_DISABLED",
      message: "当前模型尚未启用按 Token 计费，已暂停提交",
    };
  }

  if (REQUIRED_TOKEN_PRICE_FIELDS.some((field) => !isExplicit(modelRow[field]))) {
    return {
      priceReady: false,
      code: "TEXT_MODEL_PRICE_INCOMPLETE",
      message: "当前模型计费配置不完整，等待管理员补齐后恢复",
    };
  }

  const inputCostPerMillion = finiteNonNegative(modelRow.input_cost_per_million);
  const outputCostPerMillion = finiteNonNegative(modelRow.output_cost_per_million);
  const cachedCostPerMillion = finiteNonNegative(modelRow.cached_cost_per_million);
  const profitMargin = finiteNonNegative(modelRow.profit_margin);
  const tokenRoundingUnit = isExplicit(modelRow.token_rounding_unit)
    ? finiteNonNegative(modelRow.token_rounding_unit)
    : 0;

  if (
    inputCostPerMillion === null
    || outputCostPerMillion === null
    || cachedCostPerMillion === null
    || profitMargin === null
    || profitMargin >= 100
    || tokenRoundingUnit === null
  ) {
    return {
      priceReady: false,
      code: "TEXT_MODEL_PRICE_INVALID",
      message: "当前模型计费配置无效，等待管理员修正后恢复",
    };
  }

  return {
    priceReady: true,
    code: "TEXT_MODEL_PRICE_READY",
    message: "按实际 Token 用量结算",
    pricing: {
      inputCostPerMillion,
      outputCostPerMillion,
      cachedCostPerMillion,
      profitMargin,
      tokenRoundingUnit,
    },
  };
}

export function isTextModelPriceReady(modelRow: Record<string, unknown> | null | undefined): boolean {
  return inspectTextModelPricing(modelRow).priceReady;
}

export function publicTextModelBillingCapabilities(
  modelRow: Record<string, unknown> | null | undefined,
): Record<string, PublicModelCapability> {
  const readiness = inspectTextModelPricing(modelRow);
  const explicitlyFree = readiness.priceReady
    && readiness.pricing.inputCostPerMillion === 0
    && readiness.pricing.outputCostPerMillion === 0
    && readiness.pricing.cachedCostPerMillion === 0;
  return {
    billingUnit: "token",
    pricingMode: "token_usage",
    explicitlyFree,
    priceReady: readiness.priceReady,
    available: readiness.priceReady,
    availabilityMessage: readiness.message,
  };
}

export function toSelectedModelBillingConfig(
  modelRow: Record<string, unknown> | null | undefined,
  globalConfig: BillingConfig,
): BillingConfig | undefined {
  const readiness = inspectTextModelPricing(modelRow);
  if (!readiness.priceReady) return undefined;
  return {
    inputCostPerMillion: readiness.pricing.inputCostPerMillion,
    outputCostPerMillion: readiness.pricing.outputCostPerMillion,
    cachedCostPerMillion: readiness.pricing.cachedCostPerMillion,
    profitMargin: readiness.pricing.profitMargin,
    creditsPerYuan: globalConfig.creditsPerYuan,
    tokenRoundingEnabled: readiness.pricing.tokenRoundingUnit > 0,
    tokenRoundingUnit: readiness.pricing.tokenRoundingUnit,
    tokenRoundingMin: globalConfig.tokenRoundingMin,
    tokenRoundingMax: globalConfig.tokenRoundingMax,
  };
}
