/** A configured zero is free. Missing or invalid values use the explicit default. */
export function normalizePluginPrice(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback;
  if (typeof value === "string" && !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Runtime extraction channels must distinguish an explicitly configured zero
 * from a missing or malformed amount. `null` means the channel must remain
 * closed before any provider request starts.
 */
export function configuredExtractionMoney(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export class ExtractionPricingConfigError extends Error {
  readonly code = "EXTRACTION_PRICING_NOT_CONFIGURED";

  constructor(message: string) {
    super(message);
    this.name = "ExtractionPricingConfigError";
  }
}

export function requireConfiguredExtractionMoney(value: unknown, label: string): number {
  const parsed = configuredExtractionMoney(value);
  if (parsed === null) {
    throw new ExtractionPricingConfigError(`${label}缺失或无效，请先在管理后台明确配置；本次未调用上游服务`);
  }
  return parsed;
}

/** Match the atomic wallet's cent precision for both quotes and settlement. */
export function extractionTotalPrice(unitPrice: number, successCount: number): number {
  return Math.round((unitPrice * successCount + Number.EPSILON) * 100) / 100;
}

export function normalizeExtractionCount(value: unknown, fallback: number, maximum = 30): number {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : Math.min(fallback, maximum);
}
