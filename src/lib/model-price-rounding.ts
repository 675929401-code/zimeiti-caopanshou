function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function explicitNonNegativePrice(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function invalidExplicitPriceField(fields: Record<string, unknown>, keys: readonly string[]): string | null {
  return keys.find(key => Object.hasOwn(fields, key) && explicitNonNegativePrice(fields[key]) === null) || null;
}

export function videoPriceConfigurationError(input: {
  costPrice?: unknown;
  sellingPrice?: unknown;
  protocolConfig?: unknown;
}): string | null {
  const cost = explicitNonNegativePrice(input.costPrice);
  const price = explicitNonNegativePrice(input.sellingPrice);
  if (cost === null) return "基础成本必须是大于或等于 0 的明确金额";
  if (price === null) return "基础售价必须是大于或等于 0 的明确金额";

  const config = asRecord(input.protocolConfig);
  const costs = asRecord(config.resolution_cost_prices);
  const prices = asRecord(config.resolution_prices);
  for (const [variant, rawPrice] of Object.entries(prices)) {
    if (explicitNonNegativePrice(rawPrice) === null) return `${variant} 售价必须按价格表明确填写`;
  }
  for (const [variant, rawCost] of Object.entries(costs)) {
    const variantCost = explicitNonNegativePrice(rawCost);
    if (variantCost === null) return `${variant} 成本必须是大于或等于 0 的明确金额`;
    const variantPrice = explicitNonNegativePrice(prices[variant]);
    if (variantPrice === null) return `${variant} 售价必须按价格表明确填写`;
  }
  return null;
}
