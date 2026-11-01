import assert from "node:assert/strict";
import { explicitNonNegativePrice, invalidExplicitPriceField, videoPriceConfigurationError } from "../src/lib/model-price-rounding";

const invalid: unknown[] = [null, undefined, "", " ", false, true, [], {}, -1, Infinity, NaN, "unknown"];
for (const value of invalid) {
  assert.equal(explicitNonNegativePrice(value), null);
  assert.notEqual(videoPriceConfigurationError({ costPrice: value, sellingPrice: 1 }), null);
  assert.notEqual(videoPriceConfigurationError({ costPrice: 1, sellingPrice: value }), null);
  assert.notEqual(videoPriceConfigurationError({ costPrice: 0, sellingPrice: 0,
    protocolConfig: { resolution_cost_prices: { "720p": value }, resolution_prices: { "720p": 1 } } }), null);
}
for (const value of [0, "0", "0.00", 0.01, "1.25"]) {
  assert.equal(explicitNonNegativePrice(value), Number(value));
  assert.equal(videoPriceConfigurationError({ costPrice: value, sellingPrice: value }), null);
}
assert.equal(invalidExplicitPriceField({}, ["cost_price"]), null);
assert.equal(invalidExplicitPriceField({ cost_price: null }, ["cost_price"]), "cost_price");
assert.equal(invalidExplicitPriceField({ cost_price: 0 }, ["cost_price"]), null);
console.log(JSON.stringify({ passed: true, invalidInputs: invalid.length, explicitAmounts: 5,
  omittedPatchValuePreserved: true, unknownNeverBecomesZero: true, networkCalls: 0, providerCalls: 0 }));
