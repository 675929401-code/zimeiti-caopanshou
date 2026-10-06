import assert from "node:assert/strict";
import {
  PERMANENTLY_RETIRED_MODEL_IDS,
  isPermanentlyRetiredModel,
} from "../src/lib/model-retirement";
import {
  AUTODL_HOSTED_H3_WORKFLOWS,
  RETIRED_AUTODL_HOSTED_H3_WORKFLOWS,
} from "../src/lib/autodl-hosted-h3-workflow-catalog";

assert.equal(PERMANENTLY_RETIRED_MODEL_IDS.size, 11);
assert.deepEqual(AUTODL_HOSTED_H3_WORKFLOWS.map((item) => item.modelId), [
  "minimax-h3-autodl-hosted-lightx2v-v5",
  "minimax-h3-autodl-hosted-text",
  "minimax-h3-autodl-hosted-image-audio-v2",
]);
assert.deepEqual(RETIRED_AUTODL_HOSTED_H3_WORKFLOWS.map((item) => item.modelId), [
  "minimax-h3-autodl-hosted-first-last",
  "minimax-h3-autodl-hosted-lightx2v-v5-15s",
  "minimax-h3-autodl-hosted-image-audio",
  "minimax-h3-autodl-hosted-image-audio-v2-15s",
]);
assert.equal(isPermanentlyRetiredModel({ id: "minimax-h3-autodl-hosted-first-last" }), true);
assert.equal(isPermanentlyRetiredModel({ provider: "yunwu_video" }), false);
assert.equal(isPermanentlyRetiredModel({ api_endpoint: "https://yunwu.ai/v1" }), true);
assert.equal(isPermanentlyRetiredModel({ provider: "yunwu", api_endpoint: "http://113.31.180.249:3000" }), false);
assert.equal(isPermanentlyRetiredModel({ id: "minimax-h3-autodl-hosted", provider: "autodl_comfyui_h3" }), true);
assert.equal(isPermanentlyRetiredModel({ id: "minimax-h3-turbo-selfhost-pro6000", provider: "autodl_h3_selfhost" }), true);
assert.equal(isPermanentlyRetiredModel({ id: "qwen-image-2512-hq-selfhost-pro6000", provider: "autodl_h3_selfhost" }), true);

console.log("permanent model retirement contract passed");
