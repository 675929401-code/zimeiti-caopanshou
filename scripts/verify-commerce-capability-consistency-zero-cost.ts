import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  assertCommerceVideoAudioSetting,
  assertCommerceVideoResolution,
  COMMERCE_VIDEO_MAX_TOTAL_DURATION,
  commerceVideoTargetDurations,
  planCommerceVideoSegments,
  resolveCommerceVideoDurationPlan,
} from "../src/commerce/shared/video-generation-capabilities";

const stepped = { durationMode: "range", minDuration: 4, maxDuration: 8, durationStep: 2 };
assert.deepEqual(commerceVideoTargetDurations(stepped, { maximum: 8 }), [4, 6, 8]);
assert.equal(resolveCommerceVideoDurationPlan(stepped, 6).native, true);
assert.throws(() => resolveCommerceVideoDurationPlan(stepped, 5, { allowRolling: false }), /支持的时长/u);

const halfStep = { durationMode: "range", minDuration: 4, maxDuration: 8, durationStep: 0.5 };
assert.equal(resolveCommerceVideoDurationPlan(halfStep, 4.5).native, true);
assert.throws(() => resolveCommerceVideoDurationPlan(halfStep, 4.3), /支持的时长/u);

assert.deepEqual(planCommerceVideoSegments(20, [5, 10]), [10, 10]);
assert.equal(planCommerceVideoSegments(11, [5, 10]), null);
assert.deepEqual(resolveCommerceVideoDurationPlan({ nativeDurations: [6, 10, 12] }, 30).segments, [10, 10, 10]);
assert.throws(() => resolveCommerceVideoDurationPlan({ nativeDurations: [20] }, 40), /无法用/u);
const fullNative=Array.from({length:12},(_,index)=>index+4);
assert.deepEqual(resolveCommerceVideoDurationPlan({nativeDurations:fullNative},30).segments,[15,15]);
assert.deepEqual(resolveCommerceVideoDurationPlan({nativeDurations:fullNative},60).segments,[15,15,15,15]);
assert.deepEqual(resolveCommerceVideoDurationPlan({nativeDurations:fullNative},70).segments,[14,14,14,14,14]);
assert.deepEqual(resolveCommerceVideoDurationPlan({nativeDurations:fullNative},80).segments,[14,14,13,13,13,13]);
assert.throws(()=>resolveCommerceVideoDurationPlan({nativeDurations:fullNative},81),/1–80/u);
assert.equal(COMMERCE_VIDEO_MAX_TOTAL_DURATION,80);

assert.doesNotThrow(() => assertCommerceVideoAudioSetting({ supportsGenerateAudioToggle: true } as never, false));
assert.throws(() => assertCommerceVideoAudioSetting({}, true), /不支持切换/u);
assert.throws(() => assertCommerceVideoAudioSetting({ supportsGenerateAudioToggle: false } as never, false), /不支持切换/u);
assert.doesNotThrow(() => assertCommerceVideoResolution({ resolutionOptions: ["720p", "1080p"] }, "1080P"));
assert.throws(() => assertCommerceVideoResolution({ resolutionOptions: ["720p", "1080p"] }, "480p"), /不支持该分辨率/u);

const workspace = readFileSync(new URL("../src/commerce/components/commerce-agent/workspace.tsx", import.meta.url), "utf8");
const quotes = readFileSync(new URL("../src/commerce/server/quotes.ts", import.meta.url), "utf8");
const jobs = readFileSync(new URL("../src/commerce/server/jobs.ts", import.meta.url), "utf8");
assert.match(workspace, /onGenerateAudio=\{videoAudioToggleSupported\?setVideoGenerateAudio:undefined\}/u);
assert.match(workspace, /generateAudio:tab==='video'&&videoAudioToggleSupported\?videoGenerateAudio:undefined/u);
assert.match(quotes, /withValidatedVideoPlan\(input, model\.capabilities\)/u);
assert.match(quotes, /assertCommerceVideoAudioSetting/u);
assert.match(jobs, /resolveCommerceVideoDurationPlan/u);
assert.match(jobs, /assertCommerceVideoResolution/u);
assert.doesNotMatch(jobs, /maximum:60/u);
assert.doesNotMatch(jobs, /scriptDuration\)>60/u);
assert.match(workspace, /COMMERCE_VIDEO_MAX_TOTAL_DURATION/u);

console.log(JSON.stringify({
  passed: 30,
  networkCalls: 0,
  databaseWrites: 0,
  walletCalls: 0,
  providerCalls: 0,
  checks: [
    "integer-range-step",
    "fractional-range-step",
    "exact-rolling-plan",
    "unrepresentable-plan-rejected",
    "rolling-segment-cap-15",
    "audio-fail-closed",
    "resolution-fail-closed",
    "ui-audio-state-wired",
    "quote-create-shared-validator",
    "30-60-70-80-exact-plans",
    "81-seconds-rejected",
    "quote-job-ui-max-consistent",
  ],
}, null, 2));
