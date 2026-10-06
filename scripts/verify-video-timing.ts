import assert from "node:assert/strict";
import {
  getVideoDurationCapabilities,
  getVideoTargetDurationOptions,
  resolveVideoDuration,
} from "../src/lib/video-model-capabilities";
import {
  buildCanonicalShotTimeline,
  extractPromptDurationSeconds,
  extractVideoPromptTimeRanges,
  normalizeVideoPromptTiming,
} from "../src/lib/video-prompt-timing";

const fixedVeo = {
  id: "veo-3-1-fast-chC",
  modelName: "veo3.1-fast",
  durationSeconds: 8,
  maxDuration: 8,
};
const fixedOmni = {
  id: "omni-flash-10s-1080p-ch3",
  modelName: "omni_flash_10s",
  durationSeconds: 10,
  maxDuration: 10,
};
const variableGrok = {
  id: "grok-imagine-1.5-15s-ch3",
  modelName: "grok-imagine-video-1.5-preview",
  durationSeconds: 15,
  maxDuration: 15,
};

assert.equal(getVideoDurationCapabilities(fixedVeo).mode, "fixed");
assert.deepEqual(resolveVideoDuration(fixedVeo, 3.5), {
  mode: "fixed",
  minDuration: 8,
  maxDuration: 8,
  defaultDuration: 8,
  nativeDurations: [8],
  target: 3.5,
  submit: 8,
  needsTrim: true,
  supported: true,
});
assert.equal(resolveVideoDuration(fixedOmni, 4).submit, 10);
assert.equal(resolveVideoDuration(variableGrok, 3.5).submit, 4);
assert.equal(resolveVideoDuration(variableGrok, 3.5).target, 3.5);
assert.equal(resolveVideoDuration(variableGrok, 3.5).needsTrim, true);
assert.deepEqual(getVideoTargetDurationOptions(fixedVeo), [8]);

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
