import assert from "node:assert/strict";
import {
  getVideoDurationCapabilities,
  getVideoTargetDurationOptions,
  coerceVideoTargetDuration,
  resolveVideoDuration,
} from "../src/lib/video-model-capabilities";
import {
  buildCanonicalShotTimeline,
  extractPromptDurationSeconds,
  extractVideoPromptTimeRanges,
  normalizeVideoPromptTiming,
} from "../src/lib/video-prompt-timing";

// Native request validation must never silently change duration or trim output.
for (const duration of [8, 10, 15]) {
  const model = { id: 'fixed-' + duration, durationSeconds: duration, maxDuration: duration };
  assert.equal(getVideoDurationCapabilities(model).mode, 'fixed');
  assert.deepEqual(getVideoTargetDurationOptions(model), [duration]);
  for (const target of [duration, 3.5, duration - 1, duration + 1, Number.NaN, 0]) {
    const result = resolveVideoDuration(model, target);
    assert.equal(result.supported, target === duration);
    assert.equal(result.submit, result.target);
    if (Number.isFinite(target) && target > 0) assert.equal(result.target, target);
  }
}
const namedGrok = { id: 'grok-imagine-1.5-15s-ch3', modelName: 'grok-imagine-video-1.5-preview', durationSeconds: 15, maxDuration: 30 };
assert.equal(getVideoDurationCapabilities(namedGrok).mode, 'fixed', 'Name/max alone cannot invent variable capability');
assert.equal(resolveVideoDuration(namedGrok, 6).supported, false);
const discrete = { billingUnit: 'output_second', duration_seconds: 10, api_protocol_config: { duration_options: [6, 10, 12, 16] } };
assert.deepEqual(getVideoTargetDurationOptions(discrete), [6, 10, 12, 16]);
for (const target of [6, 10, 12, 16, 7, 10.5, 17]) {
  const result = resolveVideoDuration(discrete, target);
  assert.equal(result.supported, [6, 10, 12, 16].includes(target));
  assert.equal(result.submit, target, 'Discrete request must not advance to the next native slot');
}
const range = { billingUnit: 'output_second', duration_seconds: 4, api_protocol_config: { supports_duration: true, min_duration: 1, max_duration: 8, duration_step: 0.5 } };
assert.equal(getVideoDurationCapabilities(range).mode, 'range');
for (const target of [1, 3.5, 4, 8, 0.5, 3.55, 8.5]) {
  const result = resolveVideoDuration(range, target);
  assert.equal(result.supported, [1, 3.5, 4, 8].includes(target));
  assert.equal(result.submit, target, 'Fractional native duration must remain exact');
  assert.equal(result.target, target);
}
const minimum = { ...range, api_protocol_config: { ...range.api_protocol_config, min_submit_duration: 5 } };
assert.equal(resolveVideoDuration(minimum, 4.5).supported, false);
assert.equal(resolveVideoDuration(minimum, 4.5).submit, 4.5, 'Minimum cannot silently increase a request');
assert.equal(resolveVideoDuration(minimum, 5).supported, true);
const undeclaredStep = { billingUnit: 'output_second', durationMode: 'range', durationSeconds: 4, minDuration: 1, maxDuration: 8 };
assert.equal(resolveVideoDuration(undeclaredStep, 3.55).supported, true, 'Explicit range without a step preserves any in-range native value');
assert.equal(resolveVideoDuration(undeclaredStep, 3.55).submit, 3.55);
assert.equal(resolveVideoDuration({ ...undeclaredStep, durationStep: 0 }, 3.5).supported, false, 'An explicitly invalid step cannot pass');
const namedMinimum = { ...range, modelName: 'minimax-h3' };
assert.equal(resolveVideoDuration(namedMinimum, 3.5).submit, 3.5, 'Name cannot invent minimum submit');
assert.equal(resolveVideoDuration(namedMinimum, 3.5).supported, true);

// Registered per-use products retain their administrator-set duration even
// when a technical provider protocol exposes a wider duration catalogue.
for (const [id, seconds] of [['grok-product',15],['omni-product',10],['veo-product',8],['minimax-lc-product',5],['omni-4-to-10-product',4]] as const) {
  const product = { id, duration_seconds: seconds, api_protocol_config: { duration_options: [6,10,12,16], supports_duration: true, min_duration: 1, max_duration: 30 } };
  assert.deepEqual(getVideoTargetDurationOptions(product), [seconds]);
  assert.equal(resolveVideoDuration(product, seconds).supported, true);
  assert.equal(resolveVideoDuration(product, 6).supported, false);
}
const nestedPublic = { durationSeconds: 15, capabilities: { billingUnit: 'per_use', defaultDuration: 6 }, durationMode: 'discrete', nativeDurations: [6,10,12,16], minDuration: 6, maxDuration: 16 };
assert.deepEqual(getVideoTargetDurationOptions(nestedPublic), [15]);
const exceptionBase = { duration_seconds: 5, api_protocol_config: { billing_unit: 'per_use', supports_duration: true, min_duration: 1, max_duration: 20, duration_step: 0.5 } };
const tokenProduct = { ...exceptionBase, api_protocol_config: { ...exceptionBase.api_protocol_config, provider_billing_unit: 'token' } };
assert.equal(getVideoDurationCapabilities(tokenProduct).mode, 'range');
assert.equal(resolveVideoDuration(tokenProduct, 7.5).supported, true);
for (const digital of [
  { ...exceptionBase, protocol_type: 'dashscope_wan_s2v' },
  { ...exceptionBase, api_protocol_config: { ...exceptionBase.api_protocol_config, workspace_surfaces: ['digital-human'] } },
  { ...exceptionBase, protocolType: 'dashscope_video_retalk' },
]) {
  assert.equal(getVideoDurationCapabilities(digital).mode, 'range');
  assert.equal(resolveVideoDuration(digital, 7.5).supported, true);
}
for (const source of [
  { ...exceptionBase, requires_source_video: true },
  { ...exceptionBase, capabilities: { requiresSourceVideo: true } },
  { ...exceptionBase, api_protocol_config: { ...exceptionBase.api_protocol_config, requires_source_video: true } },
]) assert.equal(getVideoDurationCapabilities(source).mode, 'range');
assert.equal(getVideoDurationCapabilities({ ...exceptionBase, capabilities: { supportsSourceVideoInput: true } }).mode, 'fixed', 'Optional source support alone must not exempt a fixed product');

// Actual Omni Video Edit metadata has a singleton ceiling option even though
// the adapter submits source video only. Eight-second input must stay eight.
const sourceEdit = { protocol_type: 'secure_skill_flow_jobs', model_name: 'omni_video_edit',
  duration_seconds: 30, max_duration: 30, api_protocol_config: {
    requires_source_video: true, supports_duration: false, min_duration: 1, max_duration: 30,
    duration_options: [30], billing_unit: 'per_use',
  } };
assert.equal(getVideoDurationCapabilities(sourceEdit).mode, 'range');
for (const seconds of [1, 8, 8.25, 30]) {
  assert.equal(resolveVideoDuration(sourceEdit, seconds).supported, true);
  assert.equal(resolveVideoDuration(sourceEdit, seconds).submit, seconds);
}
assert.equal(resolveVideoDuration(sourceEdit, 31).supported, false);
const publicSourceEdit = { durationSeconds: 30, requiresSourceVideo: true,
  durationMode: 'range', minDuration: 1, maxDuration: 30, nativeDurations: [], billingUnit: 'per_use', durationStep: 0.5 };
assert.equal(resolveVideoDuration(publicSourceEdit, 8.25).supported, true);
assert.equal(coerceVideoTargetDuration(publicSourceEdit, 8.25), 8.25);
assert.equal(resolveVideoDuration(publicSourceEdit, 31).supported, false);
assert.equal(coerceVideoTargetDuration(publicSourceEdit, 31), 31, 'Out-of-range source metadata is rejected, never shortened');

const canonical = buildCanonicalShotTimeline(3.5, {
  opening: "稳定起势",
  action: "完成核心动作",
  ending: "稳定落幅",
});
assert.equal(extractPromptDurationSeconds(`目标总时长：3.5秒。【时间轴】${canonical}`), 3.5);
const ranges = extractVideoPromptTimeRanges(canonical);
assert.equal(ranges[0].start, 0);
assert.equal(ranges.at(-1)?.end, 3.5);
assert.ok(ranges.every((range, index) => index === 0 || ranges[index - 1].end === range.start));

const normalized = normalizeVideoPromptTiming(
  "目标总时长：4秒。0-1秒：起势；1-3秒：动作；3-4秒：落幅。",
  3.5,
);
assert.equal(normalized.timelineNormalized, true);
assert.equal(extractPromptDurationSeconds(normalized.prompt), 3.5);
assert.equal(extractVideoPromptTimeRanges(normalized.prompt).at(-1)?.end, 3.5);

console.log("Video timing verification passed.");
