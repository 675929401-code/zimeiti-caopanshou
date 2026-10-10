import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const appContext = read("src/contexts/app-context.tsx");
const messageContent = read("src/components/chat/message-content.tsx");
const globals = read("src/app/globals.css");
const markdown = read("src/app/markdown-body.css");

const numericConstant = (source, name) => {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`, "u"));
  assert.ok(match, `${name}_MISSING`);
  return Number(match[1]);
};

const minStep = numericConstant(appContext, "TYPEWRITER_MIN_STEP");
const maxStep = numericConstant(appContext, "TYPEWRITER_MAX_STEP");
const catchupFrames = numericConstant(appContext, "TYPEWRITER_TARGET_CATCHUP_FRAMES");
const settleFrameBudgetMs = numericConstant(appContext, "TYPEWRITER_SETTLE_FRAME_BUDGET_MS");
const settleSafetyFrames = numericConstant(appContext, "TYPEWRITER_SETTLE_SAFETY_FRAMES");
const settleMinWaitMs = numericConstant(appContext, "TYPEWRITER_SETTLE_MIN_WAIT_MS");
const settleMaxWaitMs = numericConstant(appContext, "TYPEWRITER_SETTLE_MAX_WAIT_MS");
const morphInterval = numericConstant(messageContent, "STREAM_MORPH_INTERVAL_MS");

assert.ok(minStep >= 1 && minStep <= 3, `TYPEWRITER_MIN_STEP_NOT_VISIBLE:${minStep}`);
assert.ok(maxStep >= 32 && maxStep <= 64, `TYPEWRITER_MAX_STEP_MUST_STAY_PROGRESSIVE:${maxStep}`);
assert.ok(catchupFrames >= 5 && catchupFrames <= 8, `TYPEWRITER_CATCHUP_FRAMES_OUT_OF_RANGE:${catchupFrames}`);
assert.ok(settleFrameBudgetMs >= 32 && settleFrameBudgetMs <= 50, `TYPEWRITER_SETTLE_FRAME_BUDGET_UNSAFE:${settleFrameBudgetMs}`);
assert.ok(settleSafetyFrames >= 4 && settleSafetyFrames <= 10, `TYPEWRITER_SETTLE_SAFETY_MARGIN_UNSAFE:${settleSafetyFrames}`);
assert.ok(settleMinWaitMs >= 500 && settleMinWaitMs <= 1_500, `TYPEWRITER_SETTLE_MIN_WAIT_UNSAFE:${settleMinWaitMs}`);
assert.ok(settleMaxWaitMs >= 10_000 && settleMaxWaitMs <= 20_000, `TYPEWRITER_SETTLE_MAX_WAIT_UNSAFE:${settleMaxWaitMs}`);
assert.ok(morphInterval <= 16, `STREAM_MORPH_INTERVAL_TOO_SLOW:${morphInterval}`);

assert.match(appContext, /requestAnimationFrame\(flushStreamingUpdate\)/u, "TYPEWRITER_MUST_USE_RAF");
assert.doesNotMatch(appContext, /setInterval\([^)]*typewriter/iu, "TYPEWRITER_MUST_NOT_USE_INTERVAL");
assert.match(appContext, /safeTypewriterBoundary/u, "UNICODE_GLYPH_BOUNDARY_GUARD_MISSING");
assert.match(appContext, /first === "\\u200d"/u, "ZWJ_SEQUENCE_GUARD_MISSING");
assert.match(appContext, /Math\.ceil\(undisplayedChars \/ TYPEWRITER_MAX_STEP\)/u, "SETTLE_WAIT_MUST_SCALE_WITH_UNDISPLAYED_CHARS");
assert.match(appContext, /setTimeout\(\(\) => \{[\s\S]{0,220}?finish\("settle-timeout"\);[\s\S]{0,80}?\}, settleWaitMs\);/u, "SETTLE_TIMEOUT_MUST_USE_DYNAMIC_BUDGET");
assert.doesNotMatch(appContext, /maxWaitMs = 2_000/u, "FIXED_TWO_SECOND_SETTLE_TIMEOUT_MUST_BE_REMOVED");
assert.match(messageContent, /useLayoutEffect[\s\S]*?morphdom\(/u, "PRE_PAINT_MORPHDOM_GUARD_MISSING");
assert.match(messageContent, /appendStreamingCaret/u, "STREAMING_CARET_INJECTION_MISSING");
assert.match(messageContent, /id="\$\{caretId\}" class="streaming-typewriter-caret" aria-hidden="true"/u, "KEYED_ACCESSIBLE_CARET_MISSING");
assert.match(globals, /\.render-layer-streaming-typewriter \.streaming-typewriter-caret/u, "CARET_STYLE_MISSING");
assert.match(globals, /\.render-layer-streaming-typewriter \.streaming-typewriter-caret[\s\S]{0,700}?opacity: \.88;[\s\S]{0,120}?animation: none;/u, "CARET_MUST_STAY_STEADY");
assert.doesNotMatch(globals, /@keyframes assistant-typewriter-caret/u, "CARET_MUST_NOT_BLINK");
assert.doesNotMatch(globals, /@keyframes assistant-stream-rail/u, "STREAM_RAIL_MUST_NOT_MOVE");
assert.match(globals, /\.render-layer-final\s*\{[\s\S]{0,160}?animation: none;[\s\S]{0,160}?opacity: 1;/u, "FINAL_LAYER_MUST_NOT_FADE");
assert.doesNotMatch(globals, /@keyframes render-fade-in/u, "FINAL_LAYER_FADE_MUST_BE_REMOVED");
assert.match(markdown, /\.markdown-body-generate > \.render-layer-streaming > \*\s*\{[\s\S]{0,260}?opacity: 1 !important;[\s\S]{0,120}?filter: none !important;/u, "STREAMED_GLYPHS_MUST_STAY_OPAQUE");
assert.match(markdown, /> :last-child::after\s*\{\s*content: none !important;/u, "PSEUDO_CARET_MUST_BE_DISABLED");
assert.doesNotMatch(markdown, /streaming-text-fade-in-fast|streaming-cursor-blink/u, "LEGACY_STREAM_FLASH_MUST_BE_REMOVED");
assert.match(globals, /prefers-reduced-motion:[\s\S]*?streaming-typewriter-caret[\s\S]*?animation: none/u, "CARET_REDUCED_MOTION_GUARD_MISSING");
const thinkingIndicator = messageContent.slice(
  messageContent.indexOf("function ThinkingIndicator"),
  messageContent.indexOf("/** Streaming content wrapper"),
);
assert.match(thinkingIndicator, /data-testid="chat-first-token-indicator"/u, "FIRST_TOKEN_INDICATOR_MISSING");
assert.doesNotMatch(thinkingIndicator, /Avatar|agentName|agentIconUrl/u, "FIRST_TOKEN_INDICATOR_MUST_NOT_DUPLICATE_IDENTITY");

const simulatedFrames = (length) => {
  let painted = 0;
  let frames = 0;
  let framesRemaining = catchupFrames;
  while (painted < length && frames < 5_000) {
    const remaining = length - painted;
    const step = Math.min(maxStep, Math.max(minStep, Math.ceil(remaining / Math.max(1, framesRemaining))));
    painted += Math.min(step, remaining);
    framesRemaining = Math.max(1, framesRemaining - 1);
    frames += 1;
  }
  return frames;
};

const shortFrames = simulatedFrames(12);
const mediumFrames = simulatedFrames(960);
const largeFrames = simulatedFrames(12_000);
assert.ok(shortFrames >= 3, `SHORT_OUTPUT_NOT_VISIBLY_PROGRESSIVE:${shortFrames}`);
assert.ok(mediumFrames >= 12 && mediumFrames <= 30, `MEDIUM_OUTPUT_NOT_SMOOTH:${mediumFrames}`);
assert.ok(largeFrames >= 180 && largeFrames <= 240, `LARGE_OUTPUT_NOT_SMOOTH:${largeFrames}`);

const estimatedDrainWaitMs = (undisplayedChars) => {
  const estimatedFrames = Math.max(catchupFrames, Math.ceil(undisplayedChars / maxStep));
  return Math.min(
    settleMaxWaitMs,
    Math.max(settleMinWaitMs, (estimatedFrames + settleSafetyFrames) * settleFrameBudgetMs),
  );
};

const shortSettleWaitMs = estimatedDrainWaitMs(12);
const overEightKSettleWaitMs = estimatedDrainWaitMs(8_001);
const twelveKSettleWaitMs = estimatedDrainWaitMs(12_000);
const cappedSettleWaitMs = estimatedDrainWaitMs(1_000_000);
assert.equal(shortSettleWaitMs, settleMinWaitMs, `SHORT_OUTPUT_SETTLE_BUDGET_SHOULD_STAY_MINIMAL:${shortSettleWaitMs}`);
assert.ok(overEightKSettleWaitMs > 2_000, `LONG_OUTPUT_STILL_HITS_TWO_SECOND_JUMP:${overEightKSettleWaitMs}`);
assert.ok(twelveKSettleWaitMs > 5_000 && twelveKSettleWaitMs < settleMaxWaitMs, `TWELVE_K_SETTLE_BUDGET_UNSAFE:${twelveKSettleWaitMs}`);
assert.equal(cappedSettleWaitMs, settleMaxWaitMs, `SETTLE_WAIT_MUST_HAVE_EXPLICIT_CAP:${cappedSettleWaitMs}`);

console.log(JSON.stringify({
  status: "PASS",
  contract: "chat-typewriter-premium-lock",
  cadence: { minStep, maxStep, catchupFrames, morphInterval },
  settleBudget: {
    frameBudgetMs: settleFrameBudgetMs,
    safetyFrames: settleSafetyFrames,
    minWaitMs: settleMinWaitMs,
    maxWaitMs: settleMaxWaitMs,
    samples: { short: shortSettleWaitMs, overEightK: overEightKSettleWaitMs, twelveK: twelveKSettleWaitMs, capped: cappedSettleWaitMs },
  },
  simulatedFrames: { short: shortFrames, medium: mediumFrames, large: largeFrames },
  guards: ["raf-only", "bounded-progressive-step", "single-assistant-identity", "pre-paint-morph", "unicode-safe", "stable-keyed-caret", "no-pseudo-caret", "opaque-stream", "static-rail", "reduced-motion"],
  paidCalls: 0,
  productionWrites: 0,
}, null, 2));
