import assert from "node:assert/strict";
import {
  calculateVideoTokenCharge, createVideoTokenQuote, getVideoTokenPublicPricing, parseVideoTokenUsage,
} from "../src/lib/video-token-billing";

function model(sale: number, referenceSale: number, cost: number, referenceCost: number) {
  return { api_protocol_config: {
    token_sale_prices_per_million: { "720p:no_reference_video": sale, "720p:reference_video": referenceSale },
    token_cost_prices_per_million: { "720p:no_reference_video": cost, "720p:reference_video": referenceCost },
  } };
}
const cases = [
  ["2.0", 34.914, 21.252, 31.74, 19.32],
  ["2.0-fast", 28.083, 16.698, 25.53, 15.18],
  ["2.5", 54.67, 32.802, 49.7, 29.82],
] as const;
const usage = { totalTokens: 1_000_000, completionTokens: 1_000_000 };
for (const [, sale, referenceSale, cost, referenceCost] of cases) {
  const configured = model(sale, referenceSale, cost, referenceCost);
  const pricing = getVideoTokenPublicPricing(configured)!;
  for (const hasReferenceVideo of [false, true]) {
    const quote = createVideoTokenQuote(configured, {
      resolution: "720p", hasReferenceVideo, maxChargeYuan: 0.01, priceVersion: pricing.priceVersion,
    });
    const charged = calculateVideoTokenCharge(quote, usage);
    const expected = hasReferenceVideo ? referenceSale : sale;
    assert.equal(charged.saleAmountYuan, Math.round(expected * 100) / 100);
    assert.equal(charged.costAmountYuan, hasReferenceVideo ? referenceCost : cost);
    // A limit never changes the actual usage bill; the finalizer enforces consent.
    assert.ok(charged.saleAmountYuan > quote.maxChargeYuan);
  }
}
assert.deepEqual(parseVideoTokenUsage({ usage: { total_tokens: 1, completion_tokens: 1 } }), {
  totalTokens: 1, completionTokens: 1,
});
for (const payload of [null, [], {}, { usage: null }, { usage: { total_tokens: 1 } },
  { usage: { total_tokens: 1234, completion_tokens: 1200 } },
  ...[0, -1, 1.1, Infinity, NaN, "1", Number.MAX_SAFE_INTEGER + 1].map(n => ({ usage: { total_tokens: n, completion_tokens: n } })),
]) assert.equal(parseVideoTokenUsage(payload), undefined);
const configured = model(1.005, 2, 1.00005, 2);
const pricing = getVideoTokenPublicPricing(configured)!;
const quote = createVideoTokenQuote(configured, {
  resolution: "720p", hasReferenceVideo: false, maxChargeYuan: 1.01, priceVersion: pricing.priceVersion,
});
assert.deepEqual(calculateVideoTokenCharge(quote, usage), { saleAmountYuan: 1.01, costAmountYuan: 1.0001 });
configured.api_protocol_config.token_cost_prices_per_million["720p:no_reference_video"] = 99;
assert.equal(getVideoTokenPublicPricing(configured)!.priceVersion, pricing.priceVersion, "costs never affect public version");
configured.api_protocol_config.token_sale_prices_per_million["720p:no_reference_video"] = 10;
assert.deepEqual(calculateVideoTokenCharge(quote, usage), { saleAmountYuan: 1.01, costAmountYuan: 1.0001 }, "frozen prices survive later changes");
assert.throws(() => createVideoTokenQuote(configured, { resolution: "720p", hasReferenceVideo: false,
  maxChargeYuan: 2, priceVersion: pricing.priceVersion }), /PRICE_VERSION_CHANGED/);
for (const maxChargeYuan of [0, -1, NaN, Infinity, 0.001, Number.MAX_SAFE_INTEGER, undefined, "1.00"]) {
  assert.throws(() => createVideoTokenQuote(model(1, 2, 1, 2), { resolution: "720p", hasReferenceVideo: false,
    maxChargeYuan: maxChargeYuan as number, priceVersion: getVideoTokenPublicPricing(model(1, 2, 1, 2))!.priceVersion }), /MAX_CHARGE/);
}
assert.equal(getVideoTokenPublicPricing({ api_protocol_config: {} }), null);
const legacySinglePrice = { price_per_use: 99, api_protocol_config: {} };
assert.equal(getVideoTokenPublicPricing(legacySinglePrice), null, "per-use pricing cannot substitute token rates");
assert.equal(getVideoTokenPublicPricing({ api_protocol_config: { token_sale_prices_per_million: { "720p:no_reference_video": 1 } } }), null);
assert.throws(() => calculateVideoTokenCharge(quote, { totalTokens: 1, completionTokens: 2 }), /USAGE_INVALID/);
assert.throws(() => calculateVideoTokenCharge({ ...quote, saleYuanPerMillionTokens: 999 }, usage), /QUOTE_INVALID/);
assert.throws(() => createVideoTokenQuote(model(1, 2, 1, 2), { resolution: "1080p", hasReferenceVideo: false,
  maxChargeYuan: 1, priceVersion: getVideoTokenPublicPricing(model(1, 2, 1, 2))!.priceVersion }), /UNSUPPORTED/);
const unitModel = model(1, 1, 1, 1);
const unitQuote = createVideoTokenQuote(unitModel, { resolution: "720p", hasReferenceVideo: false,
  maxChargeYuan: 1_000_000, priceVersion: getVideoTokenPublicPricing(unitModel)!.priceVersion });
assert.deepEqual(calculateVideoTokenCharge(unitQuote, { totalTokens: 5000, completionTokens: 5000 }), {
  saleAmountYuan: 0.01, costAmountYuan: 0.005,
});
assert.deepEqual(calculateVideoTokenCharge(unitQuote, { totalTokens: 50, completionTokens: 50 }), {
  saleAmountYuan: 0, costAmountYuan: 0.0001,
});
assert.deepEqual(calculateVideoTokenCharge(unitQuote, { totalTokens: 49, completionTokens: 49 }), {
  saleAmountYuan: 0, costAmountYuan: 0,
});
const hugeModel = model(Number.MAX_SAFE_INTEGER, 1, 1, 1);
const hugeQuote = createVideoTokenQuote(hugeModel, { resolution: "720p", hasReferenceVideo: false,
  maxChargeYuan: 1, priceVersion: getVideoTokenPublicPricing(hugeModel)!.priceVersion });
assert.throws(() => calculateVideoTokenCharge(hugeQuote, {
  totalTokens: Number.MAX_SAFE_INTEGER, completionTokens: Number.MAX_SAFE_INTEGER,
}), /CHARGE_UNSAFE/);
console.log("Video token billing verified: three models, both rates, strict usage, decimal half-up, frozen pricing and explicit charge consent.");
