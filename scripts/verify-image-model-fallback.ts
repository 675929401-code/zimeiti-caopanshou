import assert from "node:assert/strict";
import {
  isRetryableImageUpstreamStatus,
  orderEquivalentImageModelCandidates,
} from "../src/lib/image-model-fallback";
import { publicModelDisplayName } from "../src/lib/public-model-dto";

const primary = {
  id: "gpt-channel-f",
  name: "GPT-Image-2 · 渠道A (密钥F)",
  model_name: "gpt-image-2",
  provider: "secure_skill",
  api_endpoint: "https://example.test/v1",
  api_key: "key-f",
  supports_image_input: false,
};

const fallback = {
  ...primary,
  id: "gpt-channel-e",
  name: "GPT-Image-2 · 渠道A (密钥E)",
  api_key: "key-e",
};

const candidates = orderEquivalentImageModelCandidates(primary, [
  { ...primary, id: "gemini", model_name: "gemini-image", api_key: "gemini-key" },
  { ...fallback, id: "wrong-provider", provider: "other" },
  fallback,
  primary,
]);

assert.deepEqual(candidates.map((candidate) => candidate.id), ["gpt-channel-f", "gpt-channel-e"]);
assert.equal(isRetryableImageUpstreamStatus(502), false);
assert.equal(isRetryableImageUpstreamStatus(503), false);
assert.equal(isRetryableImageUpstreamStatus(504), false);
assert.equal(isRetryableImageUpstreamStatus(400), false);
assert.equal(isRetryableImageUpstreamStatus(401), false);
assert.equal(publicModelDisplayName(primary), "GPT-Image-2");

console.log("image model fallback verification passed");
