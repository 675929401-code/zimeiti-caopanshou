export type ImageResolutionPricingModel = {
  cost_price?: unknown;
  selling_price?: unknown;
  api_protocol_config?: unknown;
};

export type ImagePriceKind = "cost" | "selling";

function configuredMoney(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return Number.NaN;
  if (typeof value === "string" && !value.trim()) return Number.NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN;
}

function protocolConfig(model?: ImageResolutionPricingModel | null): Record<string, unknown> {
  const value = model?.api_protocol_config;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function configuredPriceMap(model: ImageResolutionPricingModel | null | undefined, kind: ImagePriceKind) {
  const config = protocolConfig(model);
  const value = config[kind === "cost" ? "resolution_cost_prices" : "resolution_prices"];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function resolveImageResolutionPrice(
  model: ImageResolutionPricingModel | null | undefined,
  resolution: string,
  kind: ImagePriceKind,
): number {
  const normalized = resolution.trim().toUpperCase();
  const entries = Object.entries(configuredPriceMap(model, kind));
  const configured = entries.find(([key]) => key.trim().toUpperCase() === normalized)?.[1];
  const resolved = configuredMoney(configured);
  if (Number.isFinite(resolved)) return resolved;
  return configuredMoney(kind === "cost" ? model?.cost_price : model?.selling_price);
}

export function publicImageResolutionPrices(model: ImageResolutionPricingModel | null | undefined): string[] {
  return Object.entries(configuredPriceMap(model, "selling"))
    .map(([resolution, rawPrice]) => [resolution.trim().toUpperCase(), configuredMoney(rawPrice)] as const)
    .filter((entry): entry is readonly [string, number] => Boolean(entry[0]) && Number.isFinite(entry[1]))
    .map(([resolution, price]) => `${resolution}=${price}`);
}

export function parsePublicImageResolutionPrices(value: unknown): Record<string, number> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const entry of value) {
    const [rawResolution, rawPrice] = String(entry).split("=", 2);
    const resolution = rawResolution?.trim().toUpperCase();
    const price = configuredMoney(rawPrice);
    if (resolution && Number.isFinite(price)) result[resolution] = price;
  }
  return result;
}
