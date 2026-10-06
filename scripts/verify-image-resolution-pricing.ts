import assert from "node:assert/strict";
import {
  parsePublicImageResolutionPrices,
  publicImageResolutionPrices,
  resolveImageResolutionPrice,
} from "../src/lib/image-resolution-pricing";

const model = {
  cost_price: 0.18,
  selling_price: 0.198,
  api_protocol_config: {
    resolution_cost_prices: { "1K": 0.15, "2K": 0.18, "4K": 0.2 },
    resolution_prices: { "1K": 0.165, "2K": 0.198, "4K": 0.22 },
  },
};

assert.equal(resolveImageResolutionPrice(model, "1k", "cost"), 0.15);
assert.equal(resolveImageResolutionPrice(model, "2K", "selling"), 0.198);
assert.equal(resolveImageResolutionPrice(model, "4k", "cost"), 0.2);
assert.equal(resolveImageResolutionPrice({ cost_price: 0.07 }, "2K", "cost"), 0.07);
assert.ok(Number.isNaN(resolveImageResolutionPrice({}, "2K", "selling")));

const publicEntries = publicImageResolutionPrices(model);
assert.deepEqual(parsePublicImageResolutionPrices(publicEntries), {
  "1K": 0.165,
  "2K": 0.198,
  "4K": 0.22,
});

console.log("image resolution pricing: 6 checks passed");
