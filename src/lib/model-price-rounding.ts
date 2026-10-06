function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function videoPriceConfigurationError(input: {
  costPrice?: unknown;
  sellingPrice?: unknown;
  protocolConfig?: unknown;
}): string | null {
  const cost = Number(input.costPrice);
  const price = Number(input.sellingPrice);
  if (!Number.isFinite(cost) || cost < 0) return "基础成本必须是大于或等于 0 的明确金额";
  if (!Number.isFinite(price) || price < 0) return "基础售价必须是大于或等于 0 的明确金额";

  const config = asRecord(input.protocolConfig);
  const costs = asRecord(config.resolution_cost_prices);
  const prices = asRecord(config.resolution_prices);
  for (const [variant, rawCost] of Object.entries(costs)) {
    const variantCost = Number(rawCost);
    if (!Number.isFinite(variantCost) || variantCost < 0) return `${variant} 成本必须是大于或等于 0 的明确金额`;
    const variantPrice = Number(prices[variant]);
    if (!Number.isFinite(variantPrice) || variantPrice < 0) return `${variant} 售价必须按价格表明确填写`;
  }
  return null;
}
