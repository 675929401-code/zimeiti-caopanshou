import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const appContext = read("src/contexts/app-context.tsx");
const messageContent = read("src/components/chat/message-content.tsx");
const globals = read("src/app/globals.css");

const numericConstant = (source, name) => {
  const match = source.match(new RegExp(`const ${name} = (\\d+);`, "u"));
  assert.ok(match, `${name}_MISSING`);
  return Number(match[1]);
};

const minStep = numericConstant(appContext, "TYPEWRITER_MIN_STEP");
const maxStep = numericConstant(appContext, "TYPEWRITER_MAX_STEP");
const catchupFrames = numericConstant(appContext, "TYPEWRITER_TARGET_CATCHUP_FRAMES");
const morphInterval = numericConstant(messageContent, "STREAM_MORPH_INTERVAL_MS");

assert.ok(minStep >= 1 && minStep <= 3, `TYPEWRITER_MIN_STEP_NOT_VISIBLE:${minStep}`);
assert.ok(maxStep >= 32 && maxStep <= 64, `TYPEWRITER_MAX_STEP_MUST_STAY_PROGRESSIVE:${maxStep}`);
assert.ok(catchupFrames >= 5 && catchupFrames <= 8, `TYPEWRITER_CATCHUP_FRAMES_OUT_OF_RANGE:${catchupFrames}`);
assert.ok(morphInterval <= 16, `STREAM_MORPH_INTERVAL_TOO_SLOW:${morphInterval}`);

assert.match(appContext, /requestAnimationFrame\(flushStreamingUpdate\)/u, "TYPEWRITER_MUST_USE_RAF");
assert.doesNotMatch(appContext, /setInterval\([^)]*typewriter/iu, "TYPEWRITER_MUST_NOT_USE_INTERVAL");
assert.match(appContext, /safeTypewriterBoundary/u, "UNICODE_GLYPH_BOUNDARY_GUARD_MISSING");
assert.match(appContext, /first === "\\u200d"/u, "ZWJ_SEQUENCE_GUARD_MISSING");
assert.match(messageContent, /useLayoutEffect[\s\S]*?morphdom\(/u, "PRE_PAINT_MORPHDOM_GUARD_MISSING");
assert.match(messageContent, /appendStreamingCaret/u, "STREAMING_CARET_INJECTION_MISSING");
assert.match(messageContent, /id="\$\{caretId\}" class="streaming-typewriter-caret" aria-hidden="true"/u, "KEYED_ACCESSIBLE_CARET_MISSING");
assert.match(globals, /\.render-layer-streaming-typewriter \.streaming-typewriter-caret/u, "CARET_STYLE_MISSING");
assert.match(globals, /@keyframes assistant-typewriter-caret/u, "CARET_MOTION_MISSING");
const streamRailKeyframes = globals.match(/@keyframes assistant-stream-rail\s*\{\s*[^{}]+\{[^{}]*\}\s*[^{}]+\{[^{}]*\}\s*\}/u)?.[0] || "";
assert.match(streamRailKeyframes, /background-position[\s\S]*?background-position/u, "STREAM_RAIL_MOTION_MISSING");
assert.doesNotMatch(streamRailKeyframes, /opacity:/u, "STREAM_RAIL_MUST_NOT_FLASH");
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

console.log(JSON.stringify({
  status: "PASS",
  contract: "chat-typewriter-premium-lock",
  cadence: { minStep, maxStep, catchupFrames, morphInterval },
  simulatedFrames: { short: shortFrames, medium: mediumFrames, large: largeFrames },
  guards: ["raf-only", "bounded-progressive-step", "single-assistant-identity", "pre-paint-morph", "unicode-safe", "stable-keyed-caret", "non-flashing-rail", "reduced-motion"],
  paidCalls: 0,
  productionWrites: 0,
}, null, 2));
