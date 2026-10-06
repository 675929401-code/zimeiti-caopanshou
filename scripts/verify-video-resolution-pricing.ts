import assert from "node:assert/strict";
import {
  coerceVideoTargetDuration,
  getVideoDurationCapabilities,
  getVideoResolutionCapabilities,
  resolveVideoResolution,
} from "../src/lib/video-model-capabilities";

const miniMaxH3 = {
  id: "minimax-h3-chA",
  model_name: "minimax-h3",
  duration_seconds: 15,
  max_duration: 15,
  price_per_use: 1.5,
  cost_price: 1.5,
  api_protocol_config: {
    supports_duration: false,
    duration_options: [15],
    resolution_options: ["720p", "1080p", "4K"],
    default_resolution: "1080p",
    resolution_prices: { "720p": 1.2, "1080p": 1.5, "4K": 3 },
    resolution_cost_prices: { "720p": 1.2, "1080p": 1.5, "4K": 3 },
  },
};

const omni = {
  id: "omni-flash-10s-720p-ch3",
  model_name: "omni_flash_10s",
  duration_seconds: 10,
  max_duration: 10,
  price_per_use: 0.55,
  cost_price: 0.55,
  api_protocol_config: {
    supports_duration: false,
    duration_options: [10],
    resolution_options: ["720p", "1080p"],
    default_resolution: "1080p",
    resolution_prices: { "720p": 0.5, "1080p": 0.55 },
    resolution_cost_prices: { "720p": 0.5, "1080p": 0.55 },
  },
};

assert.deepEqual(getVideoDurationCapabilities(miniMaxH3).nativeDurations, [15]);
assert.equal(getVideoDurationCapabilities(miniMaxH3).mode, "fixed");
assert.equal(coerceVideoTargetDuration(miniMaxH3, 8), 15);
assert.equal(coerceVideoTargetDuration(omni, 15), 10);

assert.deepEqual(getVideoResolutionCapabilities(miniMaxH3).options, ["720p", "1080p", "4K"]);
assert.equal(getVideoResolutionCapabilities(miniMaxH3).defaultResolution, "1080p");
assert.equal(resolveVideoResolution(miniMaxH3, "720P").publicPrice, 1.2);
assert.equal(resolveVideoResolution(miniMaxH3, "4k").costPrice, 3);
assert.equal(resolveVideoResolution(miniMaxH3, "2K").supported, false);

assert.deepEqual(getVideoResolutionCapabilities(omni).options, ["720p", "1080p"]);
assert.equal(resolveVideoResolution(omni).resolution, "1080p");
assert.equal(resolveVideoResolution(omni, "720p").publicPrice, 0.5);

const publicDtoModel = {
  durationMode: "fixed",
  durationSeconds: 10,
  nativeDurations: [10],
  publicPrice: 0.55,
  capabilities: {
    resolutionOptions: ["720p", "1080p"],
    defaultResolution: "1080p",
    resolutionPrices: ["720p=0.5", "1080p=0.55"],
  },
};
assert.equal(resolveVideoResolution(publicDtoModel, "720p").publicPrice, 0.5);
assert.equal(coerceVideoTargetDuration(publicDtoModel, 8), 10);

const normalizedFrontendModel = {
  resolutionOptions: ["720p", "1080p"],
  defaultResolution: "1080p",
  resolutionPrices: { "720p": 0.5, "1080p": 0.55 },
  publicPrice: 0.55,
};
assert.equal(resolveVideoResolution(normalizedFrontendModel, "720p").publicPrice, 0.5);
assert.equal(resolveVideoResolution(normalizedFrontendModel, "1080p").publicPrice, 0.55);

const explicitLegacyName = {
  name: "Veo 3.1 Fast · 8秒 · 图生视频 · 720P/1080P · 渠道C",
  model_name: "veo3.1-fast",
  price_per_use: 0.4,
  cost_price: 0.3,
};
assert.deepEqual(getVideoResolutionCapabilities(explicitLegacyName).options, ["720p", "1080p"]);
assert.equal(resolveVideoResolution(explicitLegacyName, "1080p").publicPrice, 0.4);
assert.deepEqual(getVideoResolutionCapabilities({ name: "服务商自动清晰度模型", model_name: "provider-auto" }).options, []);

console.log("Video resolution pricing verification passed.");
