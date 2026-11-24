import {resolveImageResolutionPrice} from "../../lib/image-resolution-pricing";
import {getVideoResolutionCapabilities} from "../../lib/video-model-capabilities";

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
): { costPrice: number | null; publicPrice: number | null; billingUnit: 'per_use' | 'output_second' | 'token' } {
  const protocol = config.api_protocol_config && typeof config.api_protocol_config === 'object'
    ? config.api_protocol_config as Row
    : {};
  const catalogBillingUnit = String((entry.capabilities as Row | undefined)?.billingUnit || protocol.billing_unit || 'per_use');
  if (kind === 'video' && catalogBillingUnit === 'token') return { costPrice: null, publicPrice: null, billingUnit: 'token' };
  const costPrice = finiteNonNegative(config.cost_price ?? config.cost_price_yuan ?? protocol.cost_price);
  const publicPrice = finiteNonNegative(kind === 'agent' ? config.cost_per_use : entry.publicPrice);
  return {
    costPrice,
    publicPrice,
    billingUnit: kind === 'video' && catalogBillingUnit === 'output_second' ? 'output_second' : 'per_use',
  };
}

export type CommerceVideoSecondRates = {
  defaultResolution: string;
  sale: Record<string, number>;
  cost: Record<string, number>;
};

/** Read the same model-pool rates as the main video workbench. */
export function commerceVideoSecondRates(config: Row): CommerceVideoSecondRates | undefined {
  const protocol = config.api_protocol_config as Row | undefined;
  if (protocol?.billing_unit !== 'output_second') return undefined;
  if (config.protocol_type !== 'toapis_video') {
    if (!protocol.resolution_prices && !protocol.resolution_cost_prices) return undefined;
    const tiers = getVideoResolutionCapabilities(config);
    if (!tiers.options.length) return undefined;
    const rates: CommerceVideoSecondRates = {defaultResolution: tiers.defaultResolution.toLowerCase(), sale: {}, cost: {}};
    for (const option of tiers.options) {
      const key = option.toLowerCase();
      rates.sale[key] = tiers.publicPrices[option];
      rates.cost[key] = tiers.costPrices[option];
    }
    return rates;
  }
  const resolutions = protocol.resolution_options;
  const sale = protocol.resolution_prices as Row | undefined;
  const cost = protocol.resolution_cost_prices as Row | undefined;
  const rates: CommerceVideoSecondRates = { defaultResolution: String(protocol.default_resolution || '720p'), sale: {}, cost: {} };
  if (!Array.isArray(resolutions)) throw Error('视频渠道分辨率价目缺失');
  for (const key of resolutions) {
    const saleRate = sale?.[key], costRate = cost?.[key];
    if (typeof saleRate !== 'number' || typeof costRate !== 'number' || !Number.isFinite(saleRate) || !Number.isFinite(costRate) || costRate <= 0 || saleRate < costRate) throw Error('视频渠道缺少有效分档价格');
    rates.sale[key] = saleRate;
    rates.cost[key] = costRate;
  }
  if (!Object.hasOwn(rates.sale, rates.defaultResolution)) throw Error('视频渠道缺少默认分辨率价格');
  return rates;
}

export type CommerceImageRates = {
  resolution_prices?: Record<string, number>;
  resolution_cost_prices?: Record<string, number>;
  reference_image_unit_cost?: number;
  reference_image_unit_price?: number;
  default_resolution?: string;
};

export function commerceImageRates(config: Row): CommerceImageRates | undefined {
  const p = config.api_protocol_config as CommerceImageRates | undefined;
  if (!p || !(p.resolution_prices || p.resolution_cost_prices || p.reference_image_unit_price || p.reference_image_unit_cost)) return undefined;
  return {resolution_prices:p.resolution_prices,resolution_cost_prices:p.resolution_cost_prices,
    reference_image_unit_price:p.reference_image_unit_price,reference_image_unit_cost:p.reference_image_unit_cost,default_resolution:p.default_resolution};
}

type UnitRateModel = { publicPrice?: number; costPrice?: number | null; secondRates?: CommerceVideoSecondRates; imageRates?: CommerceImageRates };
export function commerceUnitRate(input: { kind: string; resolution?: string; references?: readonly unknown[] }, model: UnitRateModel, side: 'sale' | 'cost'): number {
  if (input.kind === 'image' && model.imageRates) {
    return resolveImageResolutionPrice({cost_price:model.costPrice,selling_price:model.publicPrice,api_protocol_config:model.imageRates},
      input.resolution || model.imageRates.default_resolution || '1K',side === 'cost' ? 'cost' : 'selling',input.references?.length || 0);
  }
  if (input.kind === 'video' && model.secondRates) {
    const key = String(input.resolution || model.secondRates.defaultResolution).toLowerCase();
    const rates = model.secondRates[side];
    if (!Object.hasOwn(rates, key)) throw Error('视频渠道尚未配置所选分辨率的价格');
    return rates[key];
  }
  return side === 'sale' ? Number(model.publicPrice) : model.costPrice == null ? NaN : Number(model.costPrice);
}
