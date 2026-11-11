import assert from "node:assert/strict";
import {
  normalizeVideoModelOrderSurface,
  parseVideoModelSurfaceOrders,
  serializeVideoModelSurfaceOrders,
  videoModelSurfaceSortOrder,
} from "../src/lib/video-model-surface-order";
import {
  videoPriceConfigurationError,
} from "../src/lib/model-price-rounding";
import {
  getVideoResolutionCapabilities,
  resolveVideoResolution,
} from "../src/lib/video-model-capabilities";

assert.equal(normalizeVideoModelOrderSurface("video-page"), "ai-video");
assert.equal(normalizeVideoModelOrderSurface("storyboard-workbench"), "storyboard");
assert.equal(normalizeVideoModelOrderSurface("commerce-agent"), "commerce-agent");
assert.equal(normalizeVideoModelOrderSurface("digital-human"), null);

const encoded = serializeVideoModelSurfaceOrders({
  "ai-video": { omni: 10, h3: 20 },
  storyboard: { h3: 10, omni: 20 },
  "free-canvas": {},
  "film-studio": {},
  "commerce-agent": {},
  "publish-center-video": {},
});
const orders = parseVideoModelSurfaceOrders(encoded);
assert.equal(videoModelSurfaceSortOrder(orders, "ai-video", "omni"), 10);
assert.equal(videoModelSurfaceSortOrder(orders, "storyboard", "omni"), 20);
assert.equal(videoModelSurfaceSortOrder(orders, "ai-video", "missing"), null);

assert.equal(videoPriceConfigurationError({ costPrice: 1.224, sellingPrice: 1.2 }), null);
assert.equal(videoPriceConfigurationError({ costPrice: 0.504, sellingPrice: 0.5 }), null);
assert.equal(videoPriceConfigurationError({ costPrice: 0.81, sellingPrice: 0.8 }), null);
assert.equal(videoPriceConfigurationError({ costPrice: 0.48, sellingPrice: -0.1 }), "基础售价必须是大于或等于 0 的明确金额");
assert.equal(videoPriceConfigurationError({
  costPrice: 0.3,
  sellingPrice: 0.4,
  protocolConfig: {
    resolution_cost_prices: { lite: 0.3, "720p": 0.55, "1080p": 0.65 },
    resolution_prices: { lite: 0.4, "720p": 0.7, "1080p": 0.8 },
  },
}), null);

const capabilities = getVideoResolutionCapabilities({
  price_per_use: 0.4,
  cost_price: 0.3,
  api_protocol_config: {
    resolution_options: ["lite", "720p", "1080p"],
    default_resolution: "720p",
    resolution_cost_prices: { lite: 0.3, "720p": 0.55, "1080p": 0.65 },
    resolution_prices: { lite: 0.4, "720p": 0.7, "1080p": 0.8 },
  },
});
assert.deepEqual(capabilities.options, ["lite", "720p", "1080p"]);
assert.equal(resolveVideoResolution({ api_protocol_config: {
  resolution_options: ["lite", "720p", "1080p"],
  resolution_cost_prices: { lite: 0.3 },
  resolution_prices: { lite: 0.4 },
} }, "lite").resolution, "lite");

console.log("video surface ordering, explicit per-model pricing, and provider lite tier contract: PASS");
