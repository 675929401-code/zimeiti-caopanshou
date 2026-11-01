/** Shared browser/server token pricing contract. No provider costs enter public pricing. */
export type VideoTokenUsage = { totalTokens: number; completionTokens: number };
export type VideoTokenPricingClass = "no_reference_video" | "reference_video";
export type VideoTokenQuoteSnapshot = {
  schema: "video_token_quote.v1";
  resolution: string;
  pricingClass: VideoTokenPricingClass;
  saleYuanPerMillionTokens: number;
  costYuanPerMillionTokens: number;
  priceVersion: string;
  maxChargeYuan: number;
};
type PricingModel = { api_protocol_config?: unknown };
const KEYS = ["720p:no_reference_video", "720p:reference_video"] as const;
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function rate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}
/** Supplier usage is authoritative only when both counters agree. */
export function parseVideoTokenUsage(payload: unknown): VideoTokenUsage | undefined {
  const usage = record(record(payload)?.usage);
  if (!usage || !positiveInteger(usage.total_tokens) || !positiveInteger(usage.completion_tokens)
    || usage.total_tokens !== usage.completion_tokens) return undefined;
  return { totalTokens: usage.total_tokens, completionTokens: usage.completion_tokens };
}
function prices(value: unknown): Record<string, number> | null {
  const input = record(value);
  if (!input || !KEYS.every(key => rate(input[key]))) return null;
  return Object.fromEntries(KEYS.map(key => [key, input[key] as number]));
}
export function getVideoTokenPublicPricing(model: PricingModel): {
  salePricesPerMillion: Record<string, number>; priceVersion: string;
} | null {
  const salePricesPerMillion = prices(record(model.api_protocol_config)?.token_sale_prices_per_million);
  if (!salePricesPerMillion) return null;
  // Exact canonical rates avoid hash collisions and work identically in browsers.
  const priceVersion = `video_token_sale.v1:${JSON.stringify(salePricesPerMillion)}`;
  return { salePricesPerMillion, priceVersion };
}
function decimal(value: number): { integer: bigint; scale: number } {
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const scale = fraction.length - Number(exponent);
  const integer = BigInt(whole + fraction);
  return scale < 0 ? { integer: integer * BigInt(10) ** BigInt(-scale), scale: 0 } : { integer, scale };
}
function validLimit(value: unknown): value is number {
  if (!rate(value)) return false;
  const amount = decimal(value);
  return amount.scale <= 2 && amount.integer * BigInt(10) ** BigInt(2 - amount.scale) <= BigInt(Number.MAX_SAFE_INTEGER);
}
export function createVideoTokenQuote(model: PricingModel, input: {
  resolution: string; hasReferenceVideo: boolean; maxChargeYuan: number; priceVersion: string;
}): VideoTokenQuoteSnapshot {
  const publicPricing = getVideoTokenPublicPricing(model);
  const costs = prices(record(model.api_protocol_config)?.token_cost_prices_per_million);
  if (!publicPricing || !costs) throw new Error("VIDEO_TOKEN_PRICING_UNAVAILABLE");
  if (input.priceVersion !== publicPricing.priceVersion) throw new Error("VIDEO_TOKEN_PRICE_VERSION_CHANGED");
  if (!validLimit(input.maxChargeYuan)) throw new Error("VIDEO_TOKEN_MAX_CHARGE_REQUIRED");
  if (typeof input.hasReferenceVideo !== "boolean" || input.resolution !== "720p") {
    throw new Error("VIDEO_TOKEN_PRICING_CLASS_UNSUPPORTED");
  }
  const pricingClass = input.hasReferenceVideo ? "reference_video" : "no_reference_video";
  const key = `${input.resolution}:${pricingClass}`;
  return {
    schema: "video_token_quote.v1", resolution: input.resolution, pricingClass,
    saleYuanPerMillionTokens: publicPricing.salePricesPerMillion[key],
    costYuanPerMillionTokens: costs[key], priceVersion: publicPricing.priceVersion,
    maxChargeYuan: input.maxChargeYuan,
  };
}
function roundedCharge(tokens: number, price: number, places: number): number {
  const parsed = decimal(price);
  const numerator = BigInt(tokens) * parsed.integer * BigInt(10) ** BigInt(places);
  const denominator = BigInt(1_000_000) * BigInt(10) ** BigInt(parsed.scale);
  const rounded = (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("VIDEO_TOKEN_CHARGE_UNSAFE");
  return Number(rounded) / 10 ** places;
}
function matchesFrozenVersion(snapshot: VideoTokenQuoteSnapshot): boolean {
  try {
    const prefix = "video_token_sale.v1:";
    const salePrices = prices(JSON.parse(snapshot.priceVersion.slice(prefix.length)));
    return salePrices !== null && snapshot.priceVersion === prefix + JSON.stringify(salePrices)
      && salePrices[`${snapshot.resolution}:${snapshot.pricingClass}`] === snapshot.saleYuanPerMillionTokens;
  } catch { return false; }
}
export function calculateVideoTokenCharge(snapshot: VideoTokenQuoteSnapshot, usage: VideoTokenUsage): {
  saleAmountYuan: number; costAmountYuan: number;
} {
  if (!snapshot || snapshot.schema !== "video_token_quote.v1" || snapshot.resolution !== "720p"
    || !["no_reference_video", "reference_video"].includes(snapshot.pricingClass)
    || !rate(snapshot.saleYuanPerMillionTokens) || !rate(snapshot.costYuanPerMillionTokens)
    || typeof snapshot.priceVersion !== "string" || !snapshot.priceVersion.startsWith("video_token_sale.v1:")
    || !validLimit(snapshot.maxChargeYuan) || !matchesFrozenVersion(snapshot)) throw new Error("VIDEO_TOKEN_QUOTE_INVALID");
  if (!usage || !positiveInteger(usage.totalTokens) || usage.totalTokens !== usage.completionTokens) {
    throw new Error("VIDEO_TOKEN_USAGE_INVALID");
  }
  return {
    saleAmountYuan: roundedCharge(usage.totalTokens, snapshot.saleYuanPerMillionTokens, 2),
    costAmountYuan: roundedCharge(usage.totalTokens, snapshot.costYuanPerMillionTokens, 4),
  };
}
