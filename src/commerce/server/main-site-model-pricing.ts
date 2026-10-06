export type CommerceModelKind = 'agent' | 'image' | 'video';

type Row = Record<string, unknown>;

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Translate the main-site model price into the immutable Commerce quote unit.
 * Text models remain token-priced on the main site. Commerce Agent jobs use the
 * model's administrator-managed cost_per_use as their fixed customer price, so
 * the public text catalog never has to expose private token-price fields.
 */
export function commerceModelPricing(
  kind: CommerceModelKind,
  config: Row,
  entry: Row,
): { costPrice: number | null; publicPrice: number | null; billingUnit: 'per_use' | 'output_second' } {
  const protocol = config.api_protocol_config && typeof config.api_protocol_config === 'object'
    ? config.api_protocol_config as Row
    : {};
  const catalogBillingUnit = String((entry.capabilities as Row | undefined)?.billingUnit || protocol.billing_unit || 'per_use');
  const costPrice = finiteNonNegative(config.cost_price ?? config.cost_price_yuan ?? protocol.cost_price);
  const publicPrice = finiteNonNegative(kind === 'agent' ? config.cost_per_use : entry.publicPrice);
  return {
    costPrice,
    publicPrice,
    billingUnit: kind === 'video' && catalogBillingUnit === 'output_second' ? 'output_second' : 'per_use',
  };
}
