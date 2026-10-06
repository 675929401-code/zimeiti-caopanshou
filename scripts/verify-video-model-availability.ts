import assert from "node:assert/strict";
import { videoModelAvailabilityMessage } from "../src/lib/video-model-availability";

const base = {
  available: false,
  active: true,
  activationReady: true,
  priceReady: true,
  healthReadable: true,
  healthRecorded: true,
  circuitState: "open",
  lastError: "provider unavailable",
};

assert.equal(videoModelAvailabilityMessage({ ...base, available: true, circuitState: "funding_required", lastError: "Arrearage" }), "");
assert.equal(videoModelAvailabilityMessage({ ...base, lastError: "invalid api key" }), "渠道维护中");
assert.equal(videoModelAvailabilityMessage({ ...base, lastError: "model not found" }), "渠道维护中");
assert.equal(videoModelAvailabilityMessage({ ...base, active: false }), "当前未开放");
assert.equal(videoModelAvailabilityMessage({ ...base, activationReady: false }), "渠道恢复中");
assert.equal(videoModelAvailabilityMessage({ ...base, priceReady: false }), "当前未开放");
assert.equal(videoModelAvailabilityMessage({ ...base, healthReadable: false }), "渠道检查中");

for (const message of [
  videoModelAvailabilityMessage({ ...base, lastError: "invalid api key" }),
  videoModelAvailabilityMessage({ ...base, lastError: "model not found" }),
  videoModelAvailabilityMessage({ ...base, active: false }),
]) {
  assert.doesNotMatch(message, /稍后再试|稍后重试/u);
  assert.doesNotMatch(message, /暂不可用|暂不能提交|canary|验收|持久化/u);
}

console.log(JSON.stringify({
  ok: true,
  network_requests: 0,
  paid_requests: 0,
  cases: ["funding-selectable", "authentication", "model-removed", "paused", "activation-diagnostic-only", "price", "health-read"],
}, null, 2));
